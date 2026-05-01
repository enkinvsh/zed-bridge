import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerHandler, type ServerDeps } from "../src/server.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse
} from "../src/openai-types.ts";

const API_KEY = "sk-zed-local-test";

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    localApiKey: API_KEY,
    completeChat: async (
      req: ChatCompletionRequest
    ): Promise<ChatCompletionResponse> => ({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1700000000,
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    streamCompleteChat: async () => {
      throw new Error("streamCompleteChat not configured");
    },
    ...overrides
  };
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, ...extra };
}

test("GET /health returns ok without auth", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(new Request("http://localhost/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET /v1/models requires auth", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(new Request("http://localhost/v1/models"));
  assert.equal(res.status, 401);
});

test("GET /v1/models returns only gpt-5.5 (no zed/ prefix, no gpt-5.4)", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(
    new Request("http://localhost/v1/models", { headers: authed() })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    object: string;
    data: Array<{ id: string }>;
  };
  const ids = body.data.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.5"]);
});

test("unknown path returns 404 with auth", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(
    new Request("http://localhost/v1/nope", { headers: authed() })
  );
  assert.equal(res.status, 404);
});

test("/v1/chat/completions invalid JSON returns 400", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: "{not-json"
    })
  );
  assert.equal(res.status, 400);
});

test("/v1/chat/completions accepts both gpt-5.5 and zed/gpt-5.5", async () => {
  let calls = 0;
  const handler = createServerHandler(
    makeDeps({
      completeChat: async (req) => {
        calls++;
        return {
          id: "x",
          object: "chat.completion",
          created: 0,
          model: req.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop"
            }
          ]
        };
      }
    })
  );
  for (const model of ["gpt-5.5", "zed/gpt-5.5"]) {
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: authed({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }]
        })
      })
    );
    assert.equal(res.status, 200);
  }
  assert.equal(calls, 2);
});

test("/v1/chat/completions rejects gpt-5.4 and unknown models", async () => {
  const handler = createServerHandler(makeDeps());
  for (const model of ["zed/gpt-5.4", "gpt-5.4", "zed/claude-sonnet-4-6", "random"]) {
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: authed({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }]
        })
      })
    );
    assert.equal(res.status, 400, `model=${model}`);
  }
});

test("/v1/chat/completions stream returns SSE 200 with [DONE]", async () => {
  const handler = createServerHandler(
    makeDeps({
      streamCompleteChat: async () =>
        new Response("data: chunk\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
    })
  );
  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "zed/gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.ok(text.includes("data: [DONE]"));
});

test("/v1/chat/completions accepts array content (text parts)", async () => {
  let received: ChatCompletionRequest | null = null;
  const handler = createServerHandler(
    makeDeps({
      completeChat: async (req) => {
        received = req;
        return {
          id: "x",
          object: "chat.completion",
          created: 0,
          model: req.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop"
            }
          ]
        };
      }
    })
  );
  const res = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "zed/gpt-5.5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello " },
              { type: "input_text", text: "world" }
            ]
          }
        ]
      })
    })
  );
  assert.equal(res.status, 200);
  assert.equal(received!.messages[0]!.content, "hello world");
});

const VALID_TOKEN = "aaa.bbb.ccc";
const SECRET = "f".repeat(64);

test("/_internal/zed-token requires secret + correct shape", async () => {
  const captured: Array<{ token: string; source: string }> = [];
  const handler = createServerHandler(
    makeDeps({
      internalSecret: SECRET,
      acceptInjectedToken: async (token, source) => {
        captured.push({ token, source });
      }
    })
  );

  let res = await handler(
    new Request("http://localhost/_internal/zed-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN, source: "manual" })
    })
  );
  assert.equal(res.status, 401);

  res = await handler(
    new Request("http://localhost/_internal/zed-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": SECRET
      },
      body: JSON.stringify({ token: `Bearer ${VALID_TOKEN}`, source: "manual" })
    })
  );
  assert.equal(res.status, 204);
  assert.deepEqual(captured, [{ token: VALID_TOKEN, source: "manual" }]);
});

test("/_internal/zed-token returns 404 when not configured", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(
    new Request("http://localhost/_internal/zed-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN, source: "manual" })
    })
  );
  assert.equal(res.status, 404);
});

const PLAINTEXT =
  '{"version":2,"id":"client_token_xxx","token":"_Apinner_token_value"}';

test("/_internal/zed-account requires secret + valid envelope", async () => {
  const captured: Array<{
    userId: string;
    plaintext: string;
    source: string;
  }> = [];
  let cleared = 0;
  const handler = createServerHandler(
    makeDeps({
      internalSecret: SECRET,
      acceptInjectedAccount: async (account) => {
        captured.push(account);
      },
      onAccountReplaced: async () => {
        cleared++;
      }
    })
  );

  let res = await handler(
    new Request("http://localhost/_internal/zed-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "42",
        plaintext: PLAINTEXT,
        source: "manual"
      })
    })
  );
  assert.equal(res.status, 401);

  res = await handler(
    new Request("http://localhost/_internal/zed-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": SECRET
      },
      body: JSON.stringify({
        userId: "42",
        plaintext: PLAINTEXT,
        source: "manual"
      })
    })
  );
  assert.equal(res.status, 204);
  assert.deepEqual(captured, [
    { userId: "42", plaintext: PLAINTEXT, source: "manual" }
  ]);
  assert.equal(cleared, 1);
});

test("/_internal/zed-account rejects bare inner token (not a JSON envelope)", async () => {
  const handler = createServerHandler(
    makeDeps({
      internalSecret: SECRET,
      acceptInjectedAccount: async () => {}
    })
  );
  const res = await handler(
    new Request("http://localhost/_internal/zed-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": SECRET
      },
      body: JSON.stringify({
        userId: "42",
        plaintext: "_Ap_inner_token_only",
        source: "manual"
      })
    })
  );
  assert.equal(res.status, 400);
});

test("/_internal/zed-account rejects invalid source", async () => {
  const handler = createServerHandler(
    makeDeps({
      internalSecret: SECRET,
      acceptInjectedAccount: async () => {}
    })
  );
  const res = await handler(
    new Request("http://localhost/_internal/zed-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": SECRET
      },
      body: JSON.stringify({
        userId: "42",
        plaintext: PLAINTEXT,
        source: "phishing"
      })
    })
  );
  assert.equal(res.status, 400);
});

test("/_internal/zed-account returns 404 when not configured", async () => {
  const handler = createServerHandler(makeDeps());
  const res = await handler(
    new Request("http://localhost/_internal/zed-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "42",
        plaintext: PLAINTEXT,
        source: "manual"
      })
    })
  );
  assert.equal(res.status, 404);
});
