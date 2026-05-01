import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dispatcher } from "undici";
import { createProxyFetch, pickProxyUrlFromEnv } from "../src/proxy-fetch.ts";

interface CapturedCall {
  url: string;
  init: (RequestInit & { dispatcher?: Dispatcher }) | undefined;
}

function captureBaseFetch(
  response: Response = new Response("ok", { status: 200 })
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const f: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init as CapturedCall["init"] });
    return response;
  }) as typeof fetch;
  return { fetch: f, calls };
}

const fakeAgent: Dispatcher = { dispatch() { return false; } } as unknown as Dispatcher;

test("createProxyFetch sets dispatcher when proxyUrl provided", async () => {
  const { fetch: base, calls } = captureBaseFetch();
  const proxied = createProxyFetch({
    baseFetch: base,
    proxyUrl: "http://127.0.0.1:7890",
    agentFactory: () => fakeAgent
  });
  await proxied("https://cloud.zed.dev/completions", {
    method: "POST",
    body: "x"
  });
  assert.equal(calls.length, 1);
  const init = calls[0]!.init!;
  assert.equal(init.dispatcher, fakeAgent);
  assert.equal(init.method, "POST");
  assert.equal(init.body, "x");
});

test("createProxyFetch does not set dispatcher when proxyUrl empty", async () => {
  const { fetch: base, calls } = captureBaseFetch();
  const proxied = createProxyFetch({ baseFetch: base, proxyUrl: "" });
  await proxied("https://cloud.zed.dev/completions");
  const init = (calls[0]!.init ?? {}) as { dispatcher?: unknown };
  assert.equal(init.dispatcher, undefined);
});

test("createProxyFetch does not set dispatcher when proxyUrl undefined", async () => {
  const { fetch: base, calls } = captureBaseFetch();
  const proxied = createProxyFetch({ baseFetch: base });
  await proxied("https://cloud.zed.dev/completions");
  const init = (calls[0]!.init ?? {}) as { dispatcher?: unknown };
  assert.equal(init.dispatcher, undefined);
});

test("createProxyFetch preserves caller fields", async () => {
  const { fetch: base, calls } = captureBaseFetch();
  const proxied = createProxyFetch({
    baseFetch: base,
    proxyUrl: "http://127.0.0.1:7890",
    agentFactory: () => fakeAgent
  });
  await proxied("https://cloud.zed.dev/completions", {
    method: "POST",
    headers: { Authorization: "Bearer t" },
    body: "hello"
  });
  const init = calls[0]!.init!;
  assert.equal(init.method, "POST");
  assert.equal(init.body, "hello");
  assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer t");
  assert.equal(init.dispatcher, fakeAgent);
});

test("pickProxyUrlFromEnv prefers HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy", () => {
  assert.equal(
    pickProxyUrlFromEnv({
      HTTPS_PROXY: "http://https-proxy:1",
      HTTP_PROXY: "http://http-proxy:2"
    }),
    "http://https-proxy:1"
  );
  assert.equal(pickProxyUrlFromEnv({ https_proxy: "http://lc:3" }), "http://lc:3");
  assert.equal(pickProxyUrlFromEnv({ HTTP_PROXY: "http://h:4" }), "http://h:4");
  assert.equal(pickProxyUrlFromEnv({ http_proxy: "http://h2:5" }), "http://h2:5");
});

test("pickProxyUrlFromEnv returns null on empty/missing", () => {
  assert.equal(pickProxyUrlFromEnv({}), null);
  assert.equal(pickProxyUrlFromEnv({ HTTPS_PROXY: "", HTTP_PROXY: "" }), null);
});
