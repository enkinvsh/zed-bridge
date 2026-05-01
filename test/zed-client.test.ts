import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZedClient,
  mapToZedRequest,
  parseZedSseStream,
  resolveModel,
  normalizeModelId,
  type ZedClientDeps
} from "../src/zed-client.ts";
import type { ChatCompletionRequest } from "../src/openai-types.ts";

const LLM_TOKEN = "llm-token-aaaaaaaa";
const REFRESHED_TOKEN = "llm-token-refreshed-bbbbbbbb";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(
  responses: Array<Response | (() => Response)>
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fakeFetch: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
      }
    }
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init, headers, body });
    const next = responses[i++];
    if (!next) throw new Error(`No mock response for call #${i}`);
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const SSE_PONG_BODY = [
  '{"event":{"type":"response.created","response":{"id":"resp_x"}}}',
  '{"event":{"type":"response.output_text.delta","delta":"po"}}',
  '{"event":{"type":"response.output_text.delta","delta":"ng"}}',
  '{"event":{"type":"response.output_text.done","item_id":"x","text":"pong"}}',
  '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}}',
  ""
].join("\n");

function sseRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "" } });
}

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const REQ: ChatCompletionRequest = {
  model: "zed/gpt-5.5",
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user", content: "Say pong only" }
  ],
  temperature: 0.2,
  max_tokens: 16
};

let UUID_COUNTER = 0;
function deterministicUUID(): string {
  UUID_COUNTER++;
  const n = UUID_COUNTER.toString().padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

function makeDeps(
  fetchImpl: typeof fetch,
  tokenManager: ZedClientDeps["tokenManager"],
  overrides: Partial<ZedClientDeps> = {}
): ZedClientDeps {
  UUID_COUNTER = 0;
  return {
    fetch: fetchImpl,
    tokenManager,
    userAgent: "Zed/0.228.0",
    zedVersion: "0.228.0",
    now: () => 1700000000_000,
    randomUUID: deterministicUUID,
    ...overrides
  };
}

test("normalizeModelId strips zed/ prefix", () => {
  assert.equal(normalizeModelId("zed/gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeModelId("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeModelId("zed/gpt-5.5-high"), "gpt-5.5-high");
});

test("resolveModel handles plain gpt-5.5 with null defaultEffort", () => {
  assert.deepEqual(resolveModel("zed/gpt-5.5"), {
    provider: "open_ai",
    model: "gpt-5.5",
    defaultEffort: null
  });
  assert.deepEqual(resolveModel("gpt-5.5"), {
    provider: "open_ai",
    model: "gpt-5.5",
    defaultEffort: null
  });
});

test("resolveModel maps suffixed variants to upstream gpt-5.5 with derived defaultEffort", () => {
  const cases: Array<[string, "low" | "medium" | "high" | "xhigh"]> = [
    ["gpt-5.5-low", "low"],
    ["gpt-5.5-medium", "medium"],
    ["gpt-5.5-high", "high"],
    ["gpt-5.5-xhigh", "xhigh"]
  ];
  for (const [id, effort] of cases) {
    assert.deepEqual(resolveModel(id), {
      provider: "open_ai",
      model: "gpt-5.5",
      defaultEffort: effort
    });
    assert.deepEqual(resolveModel(`zed/${id}`), {
      provider: "open_ai",
      model: "gpt-5.5",
      defaultEffort: effort
    });
  }
});

test("resolveModel rejects unknown and removed gpt-5.4", () => {
  assert.equal(resolveModel("zed/gpt-5.4"), null);
  assert.equal(resolveModel("zed/gpt-5.5-mini"), null);
  assert.equal(resolveModel("zed/gpt-5.5#high"), null);
  assert.equal(resolveModel("zed/gpt-5.5/high"), null);
  assert.equal(resolveModel("zed/claude-sonnet-4-6"), null);
  assert.equal(resolveModel("random"), null);
});

test("mapToZedRequest builds Responses-API body with reasoning and no tool fields when tools absent", () => {
  const out = mapToZedRequest(REQ, {
    threadId: "tid",
    promptId: "pid",
    resolved: { provider: "open_ai", model: "gpt-5.5", defaultEffort: null }
  });
  assert.equal(out["provider"], "open_ai");
  assert.equal(out["model"], "gpt-5.5");
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.equal(pr["model"], "gpt-5.5");
  assert.equal(pr["stream"], true);
  assert.equal("tools" in pr, false);
  assert.equal("tool_choice" in pr, false);
  assert.equal("parallel_tool_calls" in pr, false);
  assert.equal(pr["prompt_cache_key"], "tid");
  assert.deepEqual(pr["reasoning"], { effort: "medium", summary: "auto" });
});

test("mapToZedRequest emits each reasoning effort level when provided", () => {
  for (const effort of ["low", "medium", "high", "xhigh"] as const) {
    const out = mapToZedRequest(REQ, {
      threadId: "tid",
      promptId: "pid",
      resolved: { provider: "open_ai", model: "gpt-5.5", defaultEffort: null },
      reasoningEffort: effort
    });
    const pr = out["provider_request"] as Record<string, unknown>;
    assert.deepEqual(pr["reasoning"], { effort, summary: "auto" });
  }
});

test("mapToZedRequest defaults to medium when reasoningEffort omitted", () => {
  const out = mapToZedRequest(REQ, {
    threadId: "tid",
    promptId: "pid",
    resolved: { provider: "open_ai", model: "gpt-5.5", defaultEffort: null }
  });
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["reasoning"], { effort: "medium", summary: "auto" });
});

test("ZedClient: suffixed model id drives upstream gpt-5.5 + derived effort", async () => {
  const cases: Array<["low" | "medium" | "high" | "xhigh", string]> = [
    ["low", "zed/gpt-5.5-low"],
    ["medium", "zed/gpt-5.5-medium"],
    ["high", "zed/gpt-5.5-high"],
    ["xhigh", "zed/gpt-5.5-xhigh"]
  ];
  for (const [effort, modelId] of cases) {
    const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
    const tm = {
      getToken: async () => LLM_TOKEN,
      forceRefresh: async () => LLM_TOKEN
    };
    const client = new ZedClient(makeDeps(f, tm));
    await client.completeChat({ ...REQ, model: modelId });
    const sent = calls[0]!.body as Record<string, unknown>;
    assert.equal(sent["model"], "gpt-5.5", `upstream model for ${modelId}`);
    const pr = sent["provider_request"] as Record<string, unknown>;
    assert.equal(pr["model"], "gpt-5.5");
    assert.deepEqual(
      pr["reasoning"],
      { effort, summary: "auto" },
      `reasoning for ${modelId}`
    );
  }
});

test("ZedClient: per-request reasoning_effort beats model-suffix default", async () => {
  const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  await client.completeChat({
    ...REQ,
    model: "zed/gpt-5.5-low",
    reasoning_effort: "xhigh"
  });
  const sent = calls[0]!.body as Record<string, unknown>;
  const pr = sent["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["reasoning"], { effort: "xhigh", summary: "auto" });
});

test("ZedClient: per-request reasoning_effort overrides daemon default", async () => {
  const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm, { reasoningEffort: "low" }));
  await client.completeChat({ ...REQ, reasoning_effort: "high" });
  assert.equal(calls.length, 1);
  const sent = calls[0]!.body as Record<string, unknown>;
  const pr = sent["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["reasoning"], { effort: "high", summary: "auto" });
});

test("ZedClient: daemon reasoningEffort default applies when request omits it", async () => {
  const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm, { reasoningEffort: "xhigh" }));
  await client.completeChat(REQ);
  const sent = calls[0]!.body as Record<string, unknown>;
  const pr = sent["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["reasoning"], { effort: "xhigh", summary: "auto" });
});

test("ZedClient: omitted daemon default falls back to medium", async () => {
  const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  await client.completeChat(REQ);
  const sent = calls[0]!.body as Record<string, unknown>;
  const pr = sent["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["reasoning"], { effort: "medium", summary: "auto" });
});

test("mapToZedRequest converts roles to correct part types", () => {
  const out = mapToZedRequest(
    {
      model: "zed/gpt-5.5",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" }
      ]
    },
    { threadId: "tid", promptId: "pid", resolved: { provider: "open_ai", model: "gpt-5.5", defaultEffort: null } }
  );
  const pr = out["provider_request"] as Record<string, unknown>;
  const input = pr["input"] as Array<Record<string, unknown>>;
  assert.equal(input.length, 3);
  assert.equal(
    (input[2]!["content"] as Array<Record<string, unknown>>)[0]!["type"],
    "output_text"
  );
});

test("parseZedSseStream aggregates deltas and prefers done.text", () => {
  const out = parseZedSseStream(SSE_PONG_BODY);
  assert.equal(out.id, "resp_x");
  assert.equal(out.content, "pong");
  assert.deepEqual(out.usage, {
    input_tokens: 3,
    output_tokens: 1,
    total_tokens: 4
  });
});

test("parseZedSseStream tolerates blank/invalid lines", () => {
  const body = [
    "",
    "not-json",
    '{"event":{"type":"response.created","response":{"id":"rid"}}}',
    "",
    '{"event":{"type":"response.output_text.delta","delta":"ok"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}'
  ].join("\n");
  const out = parseZedSseStream(body);
  assert.equal(out.id, "rid");
  assert.equal(out.content, "ok");
  assert.equal(out.usage?.total_tokens, 2);
});

test("ZedClient: posts to cloud.zed.dev with correct headers", async () => {
  const { fetch: f, calls } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  await client.completeChat(REQ);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://cloud.zed.dev/completions");
  assert.equal(calls[0]!.init?.method, "POST");
  const h = calls[0]!.headers;
  assert.equal(h["authorization"], `Bearer ${LLM_TOKEN}`);
  assert.equal(h["user-agent"], "Zed/0.228.0 (macos; aarch64)");
  assert.equal(h["x-zed-version"], "0.228.0");
  assert.equal(h["x-zed-client-supports-status-messages"], "true");
  assert.equal(h["accept"], "*/*");
});

test("ZedClient: aggregates SSE pong into ChatCompletionResponse", async () => {
  const { fetch: f } = captureFetch([sseRes(SSE_PONG_BODY)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.completeChat(REQ);
  assert.equal(res.object, "chat.completion");
  assert.equal(res.id, "resp_x");
  assert.equal(res.choices[0]!.message.content, "pong");
  assert.deepEqual(res.usage, {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4
  });
});

test("ZedClient: 401 calls forceRefresh which throws (no cached token) -> error", async () => {
  const { fetch: f, calls } = captureFetch([
    jsonRes({ error: "unauthorized" }, 401)
  ]);
  let invalidations = 0;
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => {
      invalidations++;
      throw new Error("No Zed LLM token cached. Run `zed-bridge token`.");
    }
  };
  const client = new ZedClient(makeDeps(f, tm));
  await assert.rejects(client.completeChat(REQ), /401|zed-bridge token/);
  assert.equal(invalidations, 1);
  assert.equal(calls.length, 1);
});

test("ZedClient: error messages do not leak token", async () => {
  const SENSITIVE = "supersecret-llm-token-12345";
  const { fetch: f } = captureFetch([jsonRes({ error: "boom" }, 500)]);
  const tm = {
    getToken: async () => SENSITIVE,
    forceRefresh: async () => SENSITIVE
  };
  const client = new ZedClient(makeDeps(f, tm));
  let caught: unknown = null;
  try {
    await client.completeChat(REQ);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal((caught as Error).message.includes(SENSITIVE), false);
});

test("ZedClient: streamCompleteChat emits role chunk + deltas + finish + [DONE]", async () => {
  const upstreamBody = [
    '{"event":{"type":"response.created","response":{"id":"resp_stream_x"}}}',
    '{"event":{"type":"response.output_text.delta","delta":"hel"}}',
    '{"event":{"type":"response.output_text.delta","delta":"lo"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(upstreamBody)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.streamCompleteChat(REQ);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.ok(text.includes("data: [DONE]"));
  assert.ok(text.includes('"role":"assistant"'));
  assert.ok(text.includes('"content":"hel"'));
  assert.ok(text.includes('"content":"lo"'));
});

void REFRESHED_TOKEN;
