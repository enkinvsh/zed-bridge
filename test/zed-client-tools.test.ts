import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZedClient,
  mapToZedRequest,
  parseZedSseStream,
  type ZedClientDeps
} from "../src/zed-client.ts";
import type {
  ChatCompletionRequest,
  OpenAIToolDef
} from "../src/openai-types.ts";

const LLM_TOKEN = "llm-token-aaaaaaaa";

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
        for (const [k, v] of Object.entries(rawHeaders))
          headers[k.toLowerCase()] = String(v);
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

function sseRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "" } });
}

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

const RESOLVED = {
  provider: "open_ai" as const,
  model: "gpt-5.5",
  defaultEffort: null
};

const BASH_TOOL: OpenAIToolDef = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"]
    }
  }
};

test("mapToZedRequest translates tools to flat Zed shape (no nested function)", () => {
  const req: ChatCompletionRequest = {
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "list" }],
    tools: [BASH_TOOL]
  };
  const out = mapToZedRequest(req, {
    threadId: "tid",
    promptId: "pid",
    resolved: RESOLVED
  });
  const pr = out["provider_request"] as Record<string, unknown>;
  const tools = pr["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], {
    type: "function",
    name: "Bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"]
    }
  });
});

test("mapToZedRequest translates tool_choice {function:{name}} -> {name} at top level", () => {
  const req: ChatCompletionRequest = {
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "x" }],
    tools: [BASH_TOOL],
    tool_choice: { type: "function", function: { name: "Bash" } }
  };
  const out = mapToZedRequest(req, {
    threadId: "tid",
    promptId: "pid",
    resolved: RESOLVED
  });
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.deepEqual(pr["tool_choice"], { type: "function", name: "Bash" });
});

test("mapToZedRequest passes through string tool_choice values", () => {
  for (const choice of ["auto", "required", "none"] as const) {
    const out = mapToZedRequest(
      {
        model: "zed/gpt-5.5",
        messages: [{ role: "user", content: "x" }],
        tools: [BASH_TOOL],
        tool_choice: choice
      },
      { threadId: "tid", promptId: "pid", resolved: RESOLVED }
    );
    const pr = out["provider_request"] as Record<string, unknown>;
    assert.equal(pr["tool_choice"], choice);
  }
});

test("mapToZedRequest defaults parallel_tool_calls=true when tools non-empty", () => {
  const out = mapToZedRequest(
    {
      model: "zed/gpt-5.5",
      messages: [{ role: "user", content: "x" }],
      tools: [BASH_TOOL]
    },
    { threadId: "tid", promptId: "pid", resolved: RESOLVED }
  );
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.equal(pr["parallel_tool_calls"], true);
});

test("mapToZedRequest passes through explicit parallel_tool_calls=false", () => {
  const out = mapToZedRequest(
    {
      model: "zed/gpt-5.5",
      messages: [{ role: "user", content: "x" }],
      tools: [BASH_TOOL],
      parallel_tool_calls: false
    },
    { threadId: "tid", promptId: "pid", resolved: RESOLVED }
  );
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.equal(pr["parallel_tool_calls"], false);
});

test("mapToZedRequest does NOT include tools/tool_choice/parallel_tool_calls when no tools provided", () => {
  const out = mapToZedRequest(
    {
      model: "zed/gpt-5.5",
      messages: [{ role: "user", content: "x" }]
    },
    { threadId: "tid", promptId: "pid", resolved: RESOLVED }
  );
  const pr = out["provider_request"] as Record<string, unknown>;
  assert.equal("tools" in pr, false);
  assert.equal("tool_choice" in pr, false);
  assert.equal("parallel_tool_calls" in pr, false);
});

test("mapToZedRequest interleaves function_call/function_call_output items in original order", () => {
  const req: ChatCompletionRequest = {
    model: "zed/gpt-5.5",
    tools: [BASH_TOOL],
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "ls please" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "Bash", arguments: '{"cmd":"ls"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_abc", content: "file1\nfile2" },
      { role: "assistant", content: "Here are the files." }
    ]
  };
  const out = mapToZedRequest(req, {
    threadId: "tid",
    promptId: "pid",
    resolved: RESOLVED
  });
  const pr = out["provider_request"] as Record<string, unknown>;
  const input = pr["input"] as Array<Record<string, unknown>>;
  assert.equal(input.length, 5);
  assert.equal(input[0]!["type"], "message");
  assert.equal(input[0]!["role"], "system");
  assert.equal(input[1]!["type"], "message");
  assert.equal(input[1]!["role"], "user");
  assert.equal(input[2]!["type"], "function_call");
  assert.equal(input[2]!["call_id"], "call_abc");
  assert.equal(input[2]!["name"], "Bash");
  assert.equal(input[2]!["arguments"], '{"cmd":"ls"}');
  assert.equal(input[3]!["type"], "function_call_output");
  assert.equal(input[3]!["call_id"], "call_abc");
  assert.equal(input[3]!["output"], "file1\nfile2");
  assert.equal(input[4]!["type"], "message");
  assert.equal(input[4]!["role"], "assistant");
});

test("mapToZedRequest assistant with both content and tool_calls emits message then function_call", () => {
  const req: ChatCompletionRequest = {
    model: "zed/gpt-5.5",
    tools: [BASH_TOOL],
    messages: [
      { role: "user", content: "do thing" },
      {
        role: "assistant",
        content: "Working on it.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Bash", arguments: '{"cmd":"x"}' }
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "Bash", arguments: '{"cmd":"y"}' }
          }
        ]
      }
    ]
  };
  const out = mapToZedRequest(req, {
    threadId: "tid",
    promptId: "pid",
    resolved: RESOLVED
  });
  const pr = out["provider_request"] as Record<string, unknown>;
  const input = pr["input"] as Array<Record<string, unknown>>;
  assert.equal(input.length, 4);
  assert.equal(input[0]!["role"], "user");
  assert.equal(input[1]!["type"], "message");
  assert.equal(input[1]!["role"], "assistant");
  assert.equal(input[2]!["type"], "function_call");
  assert.equal(input[2]!["call_id"], "call_1");
  assert.equal(input[3]!["type"], "function_call");
  assert.equal(input[3]!["call_id"], "call_2");
});

test("parseZedSseStream aggregates a function_call across added/delta/done into one tool_call", () => {
  const body = [
    '{"event":{"type":"response.created","response":{"id":"resp_a"}}}',
    '{"event":{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_x","call_id":"call_abc","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_x","output_index":0,"delta":"{\\"cmd\\":"}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_x","output_index":0,"delta":"\\"ls\\"}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_x","output_index":0,"arguments":"{\\"cmd\\":\\"ls\\"}"}}',
    '{"event":{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_x","call_id":"call_abc","name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}}'
  ].join("\n");
  const out = parseZedSseStream(body);
  assert.equal(out.id, "resp_a");
  assert.equal(out.content, "");
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0], {
    id: "call_abc",
    type: "function",
    function: { name: "Bash", arguments: '{"cmd":"ls"}' }
  });
  assert.equal(out.usage?.total_tokens, 5);
});

test("ZedClient.completeChat returns tool_calls and finish_reason=tool_calls", async () => {
  const body = [
    '{"event":{"type":"response.created","response":{"id":"resp_a"}}}',
    '{"event":{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_x","call_id":"call_abc","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_x","output_index":0,"delta":"{\\"cmd\\":\\"ls\\"}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_x","output_index":0,"arguments":"{\\"cmd\\":\\"ls\\"}"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(body)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.completeChat({
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "ls" }],
    tools: [BASH_TOOL]
  });
  const choice = res.choices[0]!;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, "");
  assert.equal(choice.message.tool_calls?.length, 1);
  assert.equal(choice.message.tool_calls?.[0]!.id, "call_abc");
  assert.equal(
    choice.message.tool_calls?.[0]!.function.arguments,
    '{"cmd":"ls"}'
  );
});

function parseSseDataLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

test("streamCompleteChat emits tool_calls deltas: first chunk has id+type+name+empty args, then arg fragments only", async () => {
  const upstream = [
    '{"event":{"type":"response.created","response":{"id":"resp_stream_x"}}}',
    '{"event":{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_x","call_id":"call_abc","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_x","output_index":0,"delta":"{\\"cmd\\":"}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_x","output_index":0,"delta":"\\"ls\\"}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_x","output_index":0,"arguments":"{\\"cmd\\":\\"ls\\"}"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(upstream)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.streamCompleteChat({
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "ls" }],
    tools: [BASH_TOOL]
  });
  const text = await res.text();
  const chunks = parseSseDataLines(text);

  const roleChunk = chunks.find((c) => {
    const choices = c["choices"] as Array<Record<string, unknown>>;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown>;
    return delta?.["role"] === "assistant";
  });
  assert.ok(roleChunk, "expected role chunk");

  const toolChunks = chunks.filter((c) => {
    const choices = c["choices"] as Array<Record<string, unknown>>;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown>;
    return Array.isArray(delta?.["tool_calls"]);
  });
  assert.ok(toolChunks.length >= 3, "expected >=3 tool_calls chunks");

  const first = toolChunks[0]!;
  const firstDelta = (first["choices"] as Array<Record<string, unknown>>)[0]![
    "delta"
  ] as Record<string, unknown>;
  const firstTc = (firstDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(firstTc["index"], 0);
  assert.equal(firstTc["id"], "call_abc");
  assert.equal(firstTc["type"], "function");
  const firstFn = firstTc["function"] as Record<string, unknown>;
  assert.equal(firstFn["name"], "Bash");
  assert.equal(firstFn["arguments"], "");

  const second = toolChunks[1]!;
  const secondDelta = (second["choices"] as Array<Record<string, unknown>>)[0]![
    "delta"
  ] as Record<string, unknown>;
  const secondTc = (
    secondDelta["tool_calls"] as Array<Record<string, unknown>>
  )[0]!;
  assert.equal(secondTc["index"], 0);
  assert.equal("id" in secondTc, false);
  assert.equal("type" in secondTc, false);
  const secondFn = secondTc["function"] as Record<string, unknown>;
  assert.equal("name" in secondFn, false);
  assert.equal(secondFn["arguments"], '{"cmd":');

  const third = toolChunks[2]!;
  const thirdDelta = (third["choices"] as Array<Record<string, unknown>>)[0]![
    "delta"
  ] as Record<string, unknown>;
  const thirdTc = (thirdDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
  const thirdFn = thirdTc["function"] as Record<string, unknown>;
  assert.equal(thirdFn["arguments"], '"ls"}');

  const last = chunks[chunks.length - 1]!;
  const lastChoice = (last["choices"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(lastChoice["finish_reason"], "tool_calls");

  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("streamCompleteChat: parallel function_calls assigned monotonic opencode_index by arrival order", async () => {
  const upstream = [
    '{"event":{"type":"response.created","response":{"id":"resp_p"}}}',
    '{"event":{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_a","output_index":1,"delta":"{\\"a\\":1}"}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_b","output_index":2,"delta":"{\\"b\\":2}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_a","output_index":1,"arguments":"{\\"a\\":1}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_b","output_index":2,"arguments":"{\\"b\\":2}"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(upstream)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.streamCompleteChat({
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "p" }],
    tools: [BASH_TOOL]
  });
  const text = await res.text();
  const chunks = parseSseDataLines(text);
  const tcChunks = chunks.filter((c) => {
    const ch = (c["choices"] as Array<Record<string, unknown>>)[0]!;
    const delta = ch["delta"] as Record<string, unknown>;
    return Array.isArray(delta["tool_calls"]);
  });
  const idxA = (
    (tcChunks[0]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ] as Record<string, unknown>
  )["tool_calls"] as Array<Record<string, unknown>>;
  const idxB = (
    (tcChunks[1]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ] as Record<string, unknown>
  )["tool_calls"] as Array<Record<string, unknown>>;
  assert.equal(idxA[0]!["index"], 0);
  assert.equal(idxA[0]!["id"], "call_a");
  assert.equal(idxB[0]!["index"], 1);
  assert.equal(idxB[0]!["id"], "call_b");

  const deltaA = (
    (tcChunks[2]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ] as Record<string, unknown>
  )["tool_calls"] as Array<Record<string, unknown>>;
  const deltaB = (
    (tcChunks[3]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ] as Record<string, unknown>
  )["tool_calls"] as Array<Record<string, unknown>>;
  assert.equal(deltaA[0]!["index"], 0);
  assert.equal(
    (deltaA[0]!["function"] as Record<string, unknown>)["arguments"],
    '{"a":1}'
  );
  assert.equal(deltaB[0]!["index"], 1);
  assert.equal(
    (deltaB[0]!["function"] as Record<string, unknown>)["arguments"],
    '{"b":2}'
  );
});

test("streamCompleteChat: mixed text + tool_call: text via delta.content, tool via delta.tool_calls, finish_reason=tool_calls", async () => {
  const upstream = [
    '{"event":{"type":"response.created","response":{"id":"resp_m"}}}',
    '{"event":{"type":"response.output_text.delta","delta":"hi "}}',
    '{"event":{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_z","call_id":"call_z","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.delta","item_id":"fc_z","output_index":1,"delta":"{}"}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_z","output_index":1,"arguments":"{}"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(upstream)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.streamCompleteChat({
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "p" }],
    tools: [BASH_TOOL]
  });
  const text = await res.text();
  assert.ok(text.includes('"content":"hi "'));
  const chunks = parseSseDataLines(text);
  const last = chunks[chunks.length - 1]!;
  const lastChoice = (last["choices"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(lastChoice["finish_reason"], "tool_calls");
});

test("streamCompleteChat: function_call_arguments.done without prior delta emits one synthetic delta with full args", async () => {
  const upstream = [
    '{"event":{"type":"response.created","response":{"id":"resp_d"}}}',
    '{"event":{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_q","call_id":"call_q","name":"Bash","arguments":""}}}',
    '{"event":{"type":"response.function_call_arguments.done","item_id":"fc_q","output_index":0,"arguments":"{\\"k\\":1}"}}',
    '{"event":{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}'
  ].join("\n");
  const { fetch: f } = captureFetch([sseRes(upstream)]);
  const tm = {
    getToken: async () => LLM_TOKEN,
    forceRefresh: async () => LLM_TOKEN
  };
  const client = new ZedClient(makeDeps(f, tm));
  const res = await client.streamCompleteChat({
    model: "zed/gpt-5.5",
    messages: [{ role: "user", content: "x" }],
    tools: [BASH_TOOL]
  });
  const text = await res.text();
  const chunks = parseSseDataLines(text);
  const tcChunks = chunks.filter((c) => {
    const ch = (c["choices"] as Array<Record<string, unknown>>)[0]!;
    const delta = ch["delta"] as Record<string, unknown>;
    return Array.isArray(delta["tool_calls"]);
  });
  assert.equal(tcChunks.length, 2);
  const second = tcChunks[1]!;
  const secondDelta = (second["choices"] as Array<Record<string, unknown>>)[0]![
    "delta"
  ] as Record<string, unknown>;
  const tc = (secondDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
  const fn = tc["function"] as Record<string, unknown>;
  assert.equal(fn["arguments"], '{"k":1}');
});
