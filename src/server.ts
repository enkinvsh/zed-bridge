import { constantTimeEqual } from "./internal-secret.js";
import {
  TokenValidationError,
  validateAndStripToken,
  type LlmTokenSource
} from "./llm-token-store.js";
import { normalizeModelId } from "./zed-client.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ModelInfo,
  ModelListResponse,
  OpenAIErrorBody
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
}

export type ServerHandler = (req: Request) => Promise<Response>;

export const DEFAULT_MODELS: ModelInfo[] = [
  { id: "gpt-5.5", object: "model", created: 0, owned_by: "zed" }
];

const SUPPORTED_NORMALIZED = new Set(["gpt-5.5"]);

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
      return errorResponse(502, `Upstream error: ${describeError(err)}`);
    }
  }

  try {
    const result = await deps.completeChat(request);
    return jsonResponse(result, 200);
  } catch (err) {
    return errorResponse(502, `Upstream error: ${describeError(err)}`);
  }
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
    let normalizedContent: string;
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
    } else {
      return {
        ok: false,
        message: `messages[${i}].content must be a string or an array of content parts`
      };
    }
    const msg: ChatMessage = { role, content: normalizedContent };
    if (typeof mo["name"] === "string") msg.name = mo["name"];
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
