import { ZedClient } from "../src/zed-client.js";
import { ZedTokenManager } from "../src/zed-token.js";
import { createProxyFetch, pickProxyUrlFromEnv } from "../src/proxy-fetch.js";

async function main(): Promise<number> {
  const token = process.env.ZED_LLM_TOKEN;
  if (!token || token.length === 0) {
    process.stderr.write(
      "set ZED_LLM_TOKEN to a fresh Zed Bearer JWT before running smoke\n"
    );
    return 2;
  }
  const proxyUrl = pickProxyUrlFromEnv({
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy
  });
  const fetchImpl = createProxyFetch({
    baseFetch: globalThis.fetch,
    proxyUrl
  });
  const tm = new ZedTokenManager({
    getCachedToken: async () => token
  });
  const client = new ZedClient({
    fetch: fetchImpl,
    tokenManager: tm,
    userAgent: "Zed/0.228.0",
    zedVersion: "0.228.0"
  });
  const res = await client.completeChat({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "Reply with the single word: pong" }
    ]
  });
  process.stdout.write(`response: ${res.choices[0]?.message.content}\n`);
  if ((res.choices[0]?.message.content ?? "").toLowerCase().includes("pong")) {
    process.stdout.write("smoke: ok\n");
    return 0;
  }
  process.stderr.write("smoke: unexpected content\n");
  return 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    process.stderr.write(`smoke failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
