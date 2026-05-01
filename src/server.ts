import { constantTimeEqual } from "./internal-secret.js";
import {
  TokenValidationError,
  validateAndStripToken,
  type LlmTokenSource
} from "./llm-token-store.js";
import {
  AccountValidationError,
  validateAccountInput,
  type ZedAccountSource
} from "./account-store.js";
import {
  normalizeModelId,
  SUPPORTED_MODEL_IDS,
  ZedTerminalError
} from "./zed-client.js";
import {
  isReasoningEffort,
  REASONING_EFFORT_VALUES
} from "./openai-types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ModelInfo,
  ModelListResponse,
  OpenAIErrorBody,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDef
} from "./openai-types.js";

export interface ServerDeps {
  localApiKey: string;
  completeChat: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  streamCompleteChat: (req: ChatCompletionRequest) => Promise<Response>;
  models?: ModelInfo[];
  isModelSupported?: (model: string) => boolean;
  now?: () => number;
  internalSecret?: string;
  acceptInjectedToken?: (
    token: string,
    source: LlmTokenSource
  ) => Promise<void>;
  acceptInjectedAccount?: (account: {
    userId: string;
    plaintext: string;
    source: ZedAccountSource;
  }) => Promise<void>;
  onAccountReplaced?: () => Promise<void>;
}

export type ServerHandler = (req: Request) => Promise<Response>;

export const DEFAULT_MODELS: ModelInfo[] = [
  { id: "gpt-5.5", object: "model", created: 0, owned_by: "zed" },
  { id: "gpt-5.5-low", object: "model", created: 0, owned_by: "zed" },
  { id: "gpt-5.5-medium", object: "model", created: 0, owned_by: "zed" },
  { id: "gpt-5.5-high", object: "model", created: 0, owned_by: "zed" },
  { id: "gpt-5.5-xhigh", object: "model", created: 0, owned_by: "zed" }
];

const SUPPORTED_NORMALIZED = new Set<string>(SUPPORTED_MODEL_IDS);

export function createServerHandler(deps: ServerDeps): ServerHandler {
  const models = deps.models ?? DEFAULT_MODELS;
  const isModelSupported =
    deps.isModelSupported ??
    ((id: string) => SUPPORTED_NORMALIZED.has(normalizeModelId(id)));

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return jsonResponse({ ok: true }, 200);
    }

    if (path === "/_internal/zed-token") {
      return handleInternalZedToken(req, deps);
    }

    if (path === "/_internal/zed-account") {
      return handleInternalZedAccount(req, deps);
    }

    const authError = checkAuth(req, deps.localApiKey);
    if (authError) return authError;

    if (path === "/v1/models" && req.method === "GET") {
      const body: ModelListResponse = { object: "list", data: models };
      return jsonResponse(body, 200);
    }

    if (path === "/v1/chat/completions") {
      if (req.method !== "POST") {
        return errorResponse(405, "Method not allowed");
      }
      return handleChatCompletions(req, deps, isModelSupported);
    }

    return errorResponse(404, `Not found: ${req.method} ${path}`);
  };
}

async function handleInternalZedToken(
  req: Request,
  deps: ServerDeps
): Promise<Response> {
  if (!deps.internalSecret || !deps.acceptInjectedToken) {
    return errorResponse(404, "Not found: POST /_internal/zed-token");
  }
  if (req.method !== "POST") {
    return errorResponse(405, "Method not allowed");
  }
  const presented = req.headers.get("x-internal-secret") ?? "";
  if (!constantTimeEqual(presented, deps.internalSecret)) {
    return errorResponse(401, "Invalid or missing X-Internal-Secret");
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return errorResponse(400, "Failed to read request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    return errorResponse(400, "Body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const tokenInput = obj["token"];
  const sourceInput = obj["source"];
  if (typeof tokenInput !== "string" || tokenInput.length === 0) {
    return errorResponse(400, "Field 'token' is required and must be a string");
  }
  if (sourceInput !== "manual" && sourceInput !== "mitm") {
    return errorResponse(400, "Field 'source' must be 'manual' or 'mitm'");
  }
  let stripped: string;
  try {
    stripped = validateAndStripToken(tokenInput);
  } catch (err) {
    if (err instanceof TokenValidationError) {
      return errorResponse(400, err.message);
    }
    throw err;
  }
  try {
    await deps.acceptInjectedToken(stripped, sourceInput);
  } catch (err) {
    return errorResponse(502, `Failed to persist token: ${describeError(err)}`);
  }
  return new Response(null, { status: 204 });
}

async function handleInternalZedAccount(
  req: Request,
  deps: ServerDeps
): Promise<Response> {
  if (!deps.internalSecret || !deps.acceptInjectedAccount) {
    return errorResponse(404, "Not found: POST /_internal/zed-account");
  }
  if (req.method !== "POST") {
    return errorResponse(405, "Method not allowed");
  }
  const presented = req.headers.get("x-internal-secret") ?? "";
  if (!constantTimeEqual(presented, deps.internalSecret)) {
    return errorResponse(401, "Invalid or missing X-Internal-Secret");
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return errorResponse(400, "Failed to read request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    return errorResponse(400, "Body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const userIdInput = obj["userId"];
  const plaintextInput = obj["plaintext"];
  const sourceInput = obj["source"];
  if (typeof userIdInput !== "string") {
    return errorResponse(400, "Field 'userId' is required and must be a string");
  }
  if (typeof plaintextInput !== "string") {
    return errorResponse(
      400,
      "Field 'plaintext' is required and must be a string"
    );
  }
  if (sourceInput !== "manual" && sourceInput !== "login") {
    return errorResponse(400, "Field 'source' must be 'manual' or 'login'");
  }
  let validated: { userId: string; plaintext: string };
  try {
    validated = validateAccountInput({
      userId: userIdInput,
      plaintext: plaintextInput
    });
  } catch (err) {
    if (err instanceof AccountValidationError) {
      return errorResponse(400, err.message);
    }
    throw err;
  }
  try {
    await deps.acceptInjectedAccount({
      userId: validated.userId,
      plaintext: validated.plaintext,
      source: sourceInput
    });
  } catch (err) {
    return errorResponse(
      502,
      `Failed to persist account credentials: ${describeError(err)}`
    );
  }
  if (deps.onAccountReplaced) {
    try {
      await deps.onAccountReplaced();
    } catch {}
  }
  return new Response(null, { status: 204 });
}

function checkAuth(req: Request, expected: string): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || match[1] !== expected) {
    return errorResponse(401, "Missing or invalid Authorization bearer token");
  }
  return null;
}

async function handleChatCompletions(
  req: Request,
  deps: ServerDeps,
  isModelSupported: (model: string) => boolean
): Promise<Response> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return errorResponse(400, "Failed to read request body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const validation = validateChatRequest(parsed);
  if (!validation.ok) return errorResponse(400, validation.message);
  const request = validation.value;

  if (!isModelSupported(request.model)) {
    return errorResponse(
      400,
      `Unknown or unsupported model: ${request.model}. See GET /v1/models for the supported list.`
    );
  }

  if (request.stream === true) {
    try {
      return await deps.streamCompleteChat(request);
    } catch (err) {
      if (err instanceof ZedTerminalError) {
        return streamTerminalErrorResponse(err);
      }
      return errorResponse(502, `Upstream error: ${describeError(err)}`);
    }
  }

  try {
    const result = await deps.completeChat(request);
    return jsonResponse(result, 200);
  } catch (err) {
    if (err instanceof ZedTerminalError) {
      return terminalErrorResponse(err);
    }
    return errorResponse(502, `Upstream error: ${describeError(err)}`);
  }
}

function terminalErrorResponse(err: ZedTerminalError): Response {
  const body: OpenAIErrorBody = {
    error: {
      message: err.userMessage,
      type: err.kind,
      code: err.code
    }
  };
  return jsonResponse(body, err.statusCode);
}

function streamTerminalErrorResponse(err: ZedTerminalError): Response {
  const errorChunk = JSON.stringify({
    error: {
      message: err.userMessage,
      type: err.kind,
      code: err.code
    }
  });
  const payload = `data: ${errorChunk}\n\ndata: [DONE]\n\n`;
  return new Response(payload, {
    status: err.statusCode,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

type ValidationResult =
  | { ok: true; value: ChatCompletionRequest }
  | { ok: false; message: string };

function validateChatRequest(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Body must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;

  const model = obj["model"];
  if (typeof model !== "string" || model.length === 0) {
    return { ok: false, message: "Field 'model' is required and must be a string" };
  }

  const messages = obj["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      message: "Field 'messages' is required and must be a non-empty array"
    };
  }

  const normalized: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      return { ok: false, message: `messages[${i}] must be an object` };
    }
    const mo = m as Record<string, unknown>;
    const role = mo["role"];
    const content = mo["content"];
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      return { ok: false, message: `messages[${i}].role is invalid` };
    }

    let toolCalls: OpenAIToolCall[] | undefined;
    if (role === "assistant" && "tool_calls" in mo && mo["tool_calls"] !== undefined) {
      const parsed = parseToolCalls(mo["tool_calls"], i);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      toolCalls = parsed.value;
    }

    let toolCallId: string | undefined;
    if (role === "tool") {
      const tcid = mo["tool_call_id"];
      if (typeof tcid !== "string" || tcid.length === 0) {
        return {
          ok: false,
          message: `messages[${i}].tool_call_id is required and must be a non-empty string`
        };
      }
      toolCallId = tcid;
    }

    let normalizedContent: string | null;
    if (typeof content === "string") {
      normalizedContent = content;
    } else if (Array.isArray(content)) {
      const flattened = flattenContentParts(content);
      if (flattened === null) {
        return {
          ok: false,
          message: `messages[${i}].content array must contain at least one text part`
        };
      }
      normalizedContent = flattened;
    } else if (
      role === "assistant" &&
      toolCalls &&
      toolCalls.length > 0 &&
      (content === null || content === undefined)
    ) {
      normalizedContent = null;
    } else if (role === "tool" && content === undefined) {
      return {
        ok: false,
        message: `messages[${i}].content is required for tool role and must be a string`
      };
    } else {
      return {
        ok: false,
        message: `messages[${i}].content must be a string or an array of content parts`
      };
    }

    const msg: ChatMessage = { role, content: normalizedContent };
    if (typeof mo["name"] === "string") msg.name = mo["name"];
    if (toolCalls) msg.tool_calls = toolCalls;
    if (toolCallId !== undefined) msg.tool_call_id = toolCallId;
    normalized.push(msg);
  }

  const out: ChatCompletionRequest = { model, messages: normalized };
  if (typeof obj["temperature"] === "number") out.temperature = obj["temperature"];
  if (typeof obj["top_p"] === "number") out.top_p = obj["top_p"];
  if (typeof obj["max_tokens"] === "number") out.max_tokens = obj["max_tokens"];
  if (typeof obj["stream"] === "boolean") out.stream = obj["stream"];
  if (typeof obj["user"] === "string") out.user = obj["user"];
  const stop = obj["stop"];
  if (typeof stop === "string") out.stop = stop;
  else if (Array.isArray(stop) && stop.every((s) => typeof s === "string")) {
    out.stop = stop as string[];
  }

  if ("reasoning_effort" in obj && obj["reasoning_effort"] !== undefined) {
    const re = obj["reasoning_effort"];
    if (!isReasoningEffort(re)) {
      return {
        ok: false,
        message: `Field 'reasoning_effort' must be one of ${REASONING_EFFORT_VALUES.join(
          ", "
        )}`
      };
    }
    out.reasoning_effort = re;
  }

  if ("tools" in obj && obj["tools"] !== undefined) {
    const parsedTools = parseTools(obj["tools"]);
    if (!parsedTools.ok) return { ok: false, message: parsedTools.message };
    out.tools = parsedTools.value;
  }

  if ("tool_choice" in obj && obj["tool_choice"] !== undefined) {
    const parsedChoice = parseToolChoice(obj["tool_choice"]);
    if (!parsedChoice.ok) return { ok: false, message: parsedChoice.message };
    out.tool_choice = parsedChoice.value;
  }

  if ("parallel_tool_calls" in obj && obj["parallel_tool_calls"] !== undefined) {
    const ptc = obj["parallel_tool_calls"];
    if (typeof ptc !== "boolean") {
      return {
        ok: false,
        message: "Field 'parallel_tool_calls' must be a boolean"
      };
    }
    out.parallel_tool_calls = ptc;
  }

  return { ok: true, value: out };
}

function parseTools(
  value: unknown
): { ok: true; value: OpenAIToolDef[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Field 'tools' must be an array" };
  }
  const out: OpenAIToolDef[] = [];
  for (let i = 0; i < value.length; i++) {
    const t = value[i];
    if (!t || typeof t !== "object") {
      return { ok: false, message: `tools[${i}] must be an object` };
    }
    const to = t as Record<string, unknown>;
    if (to["type"] !== "function") {
      return {
        ok: false,
        message: `tools[${i}].type must be 'function'`
      };
    }
    const fn = to["function"];
    if (!fn || typeof fn !== "object") {
      return {
        ok: false,
        message: `tools[${i}].function must be an object`
      };
    }
    const fo = fn as Record<string, unknown>;
    const name = fo["name"];
    if (typeof name !== "string" || name.length === 0) {
      return {
        ok: false,
        message: `tools[${i}].function.name must be a non-empty string`
      };
    }
    const def: OpenAIToolDef = { type: "function", function: { name } };
    if (typeof fo["description"] === "string") {
      def.function.description = fo["description"];
    }
    if (
      fo["parameters"] !== undefined &&
      fo["parameters"] !== null &&
      typeof fo["parameters"] === "object"
    ) {
      def.function.parameters = fo["parameters"] as Record<string, unknown>;
    }
    out.push(def);
  }
  return { ok: true, value: out };
}

function parseToolChoice(
  value: unknown
): { ok: true; value: OpenAIToolChoice } | { ok: false; message: string } {
  if (value === "auto" || value === "required" || value === "none") {
    return { ok: true, value };
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v["type"] === "function") {
      const fn = v["function"];
      if (fn && typeof fn === "object") {
        const fo = fn as Record<string, unknown>;
        if (typeof fo["name"] === "string" && fo["name"].length > 0) {
          return {
            ok: true,
            value: { type: "function", function: { name: fo["name"] } }
          };
        }
      }
    }
  }
  return {
    ok: false,
    message:
      "Field 'tool_choice' must be 'auto', 'required', 'none', or { type:'function', function:{ name:string } }"
  };
}

function parseToolCalls(
  value: unknown,
  msgIndex: number
):
  | { ok: true; value: OpenAIToolCall[] }
  | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: `messages[${msgIndex}].tool_calls must be an array`
    };
  }
  const out: OpenAIToolCall[] = [];
  for (let j = 0; j < value.length; j++) {
    const tc = value[j];
    if (!tc || typeof tc !== "object") {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}] must be an object`
      };
    }
    const o = tc as Record<string, unknown>;
    const id = o["id"];
    if (typeof id !== "string" || id.length === 0) {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}].id must be a non-empty string`
      };
    }
    if (o["type"] !== "function") {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}].type must be 'function'`
      };
    }
    const fn = o["function"];
    if (!fn || typeof fn !== "object") {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}].function must be an object`
      };
    }
    const fo = fn as Record<string, unknown>;
    if (typeof fo["name"] !== "string" || fo["name"].length === 0) {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}].function.name must be a non-empty string`
      };
    }
    const args = fo["arguments"];
    if (typeof args !== "string") {
      return {
        ok: false,
        message: `messages[${msgIndex}].tool_calls[${j}].function.arguments must be a string`
      };
    }
    out.push({
      id,
      type: "function",
      function: { name: fo["name"], arguments: args }
    });
  }
  return { ok: true, value: out };
}

function flattenContentParts(parts: unknown[]): string | null {
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const t = p["type"];
    if (
      (t === "text" || t === "input_text" || t === "output_text") &&
      typeof p["text"] === "string"
    ) {
      texts.push(p["text"] as string);
    }
  }
  if (texts.length === 0) return null;
  return texts.join("");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function errorResponse(status: number, message: string): Response {
  const body: OpenAIErrorBody = { error: { message } };
  return jsonResponse(body, status);
}

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>");
}
