#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  defaultInternalSecretPath,
  loadOrCreateInternalSecret,
  type InternalSecretFs
} from "./internal-secret.js";
import {
  LlmTokenStore,
  defaultStatePath,
  type LlmTokenFs
} from "./llm-token-store.js";
import { createProxyFetch, pickProxyUrlFromEnv } from "./proxy-fetch.js";
import { createServerHandler } from "./server.js";
import { ZedClient } from "./zed-client.js";
import { ZedTokenManager } from "./zed-token.js";
import { makeNodeListener } from "./http-adapter.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const nodeFs: LlmTokenFs = {
    async readFile(p) {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(p, content, mode) {
      await writeFile(p, content, { mode });
    },
    async unlink(p) {
      await unlink(p);
    },
    async mkdir(p, opts) {
      await mkdir(p, opts);
    }
  };

  const internalSecretFs: InternalSecretFs = {
    readFile: nodeFs.readFile,
    writeFile: nodeFs.writeFile,
    mkdir: nodeFs.mkdir
  };

  const llmTokenStore = new LlmTokenStore({
    path: defaultStatePath(),
    fs: nodeFs
  });

  const internalSecret =
    process.env.ZED_BRIDGE_INTERNAL_SECRET ??
    process.env.ZED_PROXY_INTERNAL_SECRET ??
    (await loadOrCreateInternalSecret({
      path: defaultInternalSecretPath(),
      fs: internalSecretFs,
      randomHex: () => randomBytes(32).toString("hex")
    }));

  const proxyUrl = pickProxyUrlFromEnv({
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    http_proxy: process.env["http_proxy"]
  });
  const upstreamFetch = createProxyFetch({
    baseFetch: globalThis.fetch,
    proxyUrl
  });

  const tokenManager = new ZedTokenManager({
    getCachedToken: async () => {
      const cached = await llmTokenStore.read();
      return cached?.token ?? null;
    },
    onTokenInvalid: async () => {
      await llmTokenStore.clear();
    }
  });

  const zedClient = new ZedClient({
    fetch: upstreamFetch,
    tokenManager,
    userAgent: config.zedUserAgent,
    zedVersion: config.zedVersion
  });

  const handler = createServerHandler({
    localApiKey: config.localApiKey,
    completeChat: (req) => zedClient.completeChat(req),
    streamCompleteChat: (req) => zedClient.streamCompleteChat(req),
    internalSecret,
    acceptInjectedToken: async (token, source) => {
      await llmTokenStore.write(token, source);
    }
  });

  const listener = makeNodeListener(handler);
  const server = createServer(listener);

  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `zed-bridge listening on http://${config.host}:${config.port}\n`
    );
    if (proxyUrl) {
      process.stdout.write(`upstream HTTPS proxy: ${proxyUrl}\n`);
    }
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`received ${signal}, shutting down\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
