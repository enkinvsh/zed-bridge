import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ReasoningEffort
} from "./openai-types.js";
import { redactBodyForError } from "./zed-token.js";

export const ZED_COMPLETIONS_ENDPOINT = "https://cloud.zed.dev/completions";

export interface ZedTokenManagerLike {
  getToken(): Promise<string>;
  forceRefresh(): Promise<string>;
}

export interface ZedClientDeps {
  fetch: typeof fetch;
  tokenManager: ZedTokenManagerLike;
  userAgent: string;
  zedVersion: string;
  reasoningEffort?: ReasoningEffort;
  now?: () => number;
  randomUUID?: () => string;
}

export type ZedProvider = "open_ai";

export interface ResolvedModel {
  provider: ZedProvider;
  model: string;
  defaultEffort: ReasoningEffort | null;
}

export interface MapToZedRequestOpts {
  threadId: string;
  promptId: string;
  resolved: ResolvedModel;
  reasoningEffort?: ReasoningEffort;
}

interface CatalogEntry {
  provider: ZedProvider;
  model: string;
  defaultEffort: ReasoningEffort | null;
}

const MODEL_CATALOG: Record<string, CatalogEntry> = {
  "gpt-5.5": { provider: "open_ai", model: "gpt-5.5", defaultEffort: null },
  "gpt-5.5-low": { provider: "open_ai", model: "gpt-5.5", defaultEffort: "low" },
  "gpt-5.5-medium": {
    provider: "open_ai",
    model: "gpt-5.5",
    defaultEffort: "medium"
  },
  "gpt-5.5-high": {
    provider: "open_ai",
    model: "gpt-5.5",
    defaultEffort: "high"
  },
  "gpt-5.5-xhigh": {
    provider: "open_ai",
    model: "gpt-5.5",
    defaultEffort: "xhigh"
  }
};

export const SUPPORTED_MODEL_IDS: readonly string[] = Object.keys(MODEL_CATALOG);

export function normalizeModelId(id: string): string {
  if (id.startsWith("zed/")) return id.slice("zed/".length);
  return id;
}

export function resolveModel(modelId: string): ResolvedModel | null {
  const hit = MODEL_CATALOG[normalizeModelId(modelId)];
  return hit
    ? {
        provider: hit.provider,
        model: hit.model,
        defaultEffort: hit.defaultEffort
      }
    : null;
}

export interface ParsedZedStream {
  id: string | null;
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
}

export class ZedClient {
  constructor(private deps: ZedClientDeps) {}

  async completeChat(
    req: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const res = await this.dispatch(req);
    const text = await safeReadText(res);
    const parsed = parseZedSseStream(text);
    return buildOpenAIResponse(parsed, req, this.now());
  }

  async streamCompleteChat(req: ChatCompletionRequest): Promise<Response> {
    const res = await this.dispatch(req);
    const upstreamBody = res.body;
    const nowMs = this.now();
    const stream = createOpenAIChatStream({
      upstream: upstreamBody,
      model: req.model,
      nowMs
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    });
  }

  private async dispatch(req: ChatCompletionRequest): Promise<Response> {
    const resolved = resolveModel(req.model);
    if (!resolved) {
      throw new Error(`Unknown or unsupported model: ${req.model}`);
    }
    const threadId = this.uuid();
    const promptId = this.uuid();
    const reasoningEffort: ReasoningEffort =
      req.reasoning_effort ??
      resolved.defaultEffort ??
      this.deps.reasoningEffort ??
      "medium";
    const upstream = mapToZedRequest(req, {
      threadId,
      promptId,
      resolved,
      reasoningEffort
    });
    const body = JSON.stringify(upstream);

    let token = await this.deps.tokenManager.getToken();
    let res = await this.send(token, body);

    if (res.status === 401) {
      try {
        token = await this.deps.tokenManager.forceRefresh();
      } catch (err) {
        throw new Error(
          `Zed completions: 401 unauthorized; ${(err as Error).message}`
        );
      }
      res = await this.send(token, body);
    }

    if (!res.ok) {
      const raw = await safeReadText(res);
      const redacted = redactBodyForError(raw);
      throw new Error(
        `Zed completions failed: HTTP ${res.status} ${res.statusText || ""}`.trim() +
          ` body=${redacted}`
      );
    }
    return res;
  }

  private async send(token: string, body: string): Promise<Response> {
    return this.deps.fetch(ZED_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `${this.deps.userAgent} (macos; aarch64)`,
        "x-zed-version": this.deps.zedVersion,
        "x-zed-client-supports-status-messages": "true",
        "x-zed-client-supports-stream-ended-request-completion-status": "true",
        Accept: "*/*"
      },
      body
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private uuid(): string {
    if (this.deps.randomUUID) return this.deps.randomUUID();
    return crypto.randomUUID();
  }
}

export function mapToZedRequest(
  req: ChatCompletionRequest,
  opts: MapToZedRequestOpts
): Record<string, unknown> {
  const upstreamModel = opts.resolved.model;
  const input = req.messages.map((m) => ({
    type: "message",
    role: m.role,
    content: [
      {
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: m.content
      }
    ]
  }));
  const effort: ReasoningEffort = opts.reasoningEffort ?? "medium";
  return {
    thread_id: opts.threadId,
    prompt_id: opts.promptId,
    provider: opts.resolved.provider,
    model: upstreamModel,
    provider_request: {
      model: upstreamModel,
      input,
      stream: true,
      parallel_tool_calls: false,
      tools: [],
      prompt_cache_key: opts.threadId,
      reasoning: { effort, summary: "auto" }
    }
  };
}

export function parseZedSseStream(text: string): ParsedZedStream {
  let id: string | null = null;
  let accumulated = "";
  let doneText: string | null = null;
  let usage: ParsedZedStream["usage"] = null;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const env = parsed as Record<string, unknown>;
    const event = env["event"];
    if (!event || typeof event !== "object") continue;
    const ev = event as Record<string, unknown>;
    const type = ev["type"];
    if (typeof type !== "string") continue;

    switch (type) {
      case "response.created": {
        const resp = ev["response"];
        if (resp && typeof resp === "object") {
          const r = resp as Record<string, unknown>;
          if (typeof r["id"] === "string") id = r["id"] as string;
        }
        break;
      }
      case "response.output_text.delta": {
        const d = ev["delta"];
        if (typeof d === "string") accumulated += d;
        break;
      }
      case "response.output_text.done": {
        const t = ev["text"];
        if (typeof t === "string" && t.length > 0) doneText = t;
        break;
      }
      case "response.completed": {
        const resp = ev["response"];
        if (resp && typeof resp === "object") {
          const r = resp as Record<string, unknown>;
          const u = r["usage"];
          if (u && typeof u === "object") {
            const uo = u as Record<string, unknown>;
            const it = numberOr(uo["input_tokens"], 0);
            const ot = numberOr(uo["output_tokens"], 0);
            const tt = numberOr(uo["total_tokens"], it + ot);
            usage = {
              input_tokens: it,
              output_tokens: ot,
              total_tokens: tt
            };
          }
          if (id === null && typeof r["id"] === "string") {
            id = r["id"] as string;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const content = doneText !== null ? doneText : accumulated;
  return { id, content, usage };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function buildOpenAIResponse(
  parsed: ParsedZedStream,
  req: ChatCompletionRequest,
  nowMs: number
): ChatCompletionResponse {
  const id = parsed.id ?? `chatcmpl-zed-${nowMs}`;
  const createdSec = Math.floor(nowMs / 1000);
  const out: ChatCompletionResponse = {
    id,
    object: "chat.completion",
    created: createdSec,
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: parsed.content },
        finish_reason: "stop"
      }
    ]
  };
  if (parsed.usage) {
    out.usage = {
      prompt_tokens: parsed.usage.input_tokens,
      completion_tokens: parsed.usage.output_tokens,
      total_tokens: parsed.usage.total_tokens
    };
  }
  return out;
}

interface OpenAIStreamOpts {
  upstream: ReadableStream<Uint8Array> | null;
  model: string;
  nowMs: number;
}

function createOpenAIChatStream(opts: OpenAIStreamOpts): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const fallbackId = `chatcmpl-zed-${opts.nowMs}`;
  const createdSec = Math.floor(opts.nowMs / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let id: string | null = null;
      let roleEmitted = false;
      let finished = false;
      let buffer = "";

      const emit = (chunk: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      const buildChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null
      ): Record<string, unknown> => ({
        id: id ?? fallbackId,
        object: "chat.completion.chunk",
        created: createdSec,
        model: opts.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      });

      const ensureRole = (): void => {
        if (roleEmitted) return;
        roleEmitted = true;
        emit(buildChunk({ role: "assistant" }, null));
      };

      const finish = (): void => {
        if (finished) return;
        finished = true;
        ensureRole();
        emit(buildChunk({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };

      const handleLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const env = parsed as Record<string, unknown>;
        if (env["status"] === "stream_ended") {
          finish();
          return;
        }
        const event = env["event"];
        if (!event || typeof event !== "object") return;
        const ev = event as Record<string, unknown>;
        const type = ev["type"];
        if (typeof type !== "string") return;

        switch (type) {
          case "response.created": {
            const resp = ev["response"];
            if (resp && typeof resp === "object") {
              const r = resp as Record<string, unknown>;
              if (typeof r["id"] === "string") id = r["id"] as string;
            }
            ensureRole();
            return;
          }
          case "response.output_text.delta": {
            const d = ev["delta"];
            if (typeof d !== "string" || d.length === 0) return;
            ensureRole();
            emit(buildChunk({ content: d }, null));
            return;
          }
          case "response.completed": {
            const resp = ev["response"];
            if (resp && typeof resp === "object") {
              const r = resp as Record<string, unknown>;
              if (id === null && typeof r["id"] === "string") {
                id = r["id"] as string;
              }
            }
            finish();
            return;
          }
          default:
            return;
        }
      };

      try {
        if (opts.upstream) {
          const reader = opts.upstream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              handleLine(line);
            }
          }
          buffer += decoder.decode();
          if (buffer.length > 0) handleLine(buffer);
        }
        finish();
      } catch (err) {
        try {
          finish();
        } catch {}
        controller.error(err);
        return;
      }
      controller.close();
    }
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
