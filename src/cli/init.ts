import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  bridgePaths,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PLIST_LABEL
} from "../paths.js";
import {
  defaultInternalSecretPath,
  loadOrCreateInternalSecret,
  type InternalSecretFs
} from "../internal-secret.js";
import {
  buildZedProvider,
  patchOpencodeConfig,
  type OpencodeFs
} from "../opencode-config.js";
import {
  bootoutAgent,
  bootstrapAgent,
  kickstartAgent,
  plistExists,
  renderPlist,
  writePlist
} from "../launchd.js";
import { pickProxyUrlFromEnv } from "../proxy-fetch.js";

export async function runInit(argv: string[]): Promise<number> {
  void argv;
  if (process.platform !== "darwin") {
    process.stderr.write("zed-bridge v1 is macOS only.\n");
    return 2;
  }
  const paths = bridgePaths();
  await mkdir(paths.stateDir, { recursive: true });
  await chmod(paths.stateDir, 0o700).catch(() => {});

  const localKey = await ensureLocalApiKey(paths.localApiKey);
  await mkdir(dirname(paths.internalSecret), { recursive: true });
  const secretFs = makeFs() as InternalSecretFs;
  await loadOrCreateInternalSecret({
    path: defaultInternalSecretPath(),
    fs: secretFs,
    randomHex: () => randomBytes(32).toString("hex")
  });

  const opencodeFs = makeFs() as OpencodeFs;
  const provider = buildZedProvider({
    baseURL: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/v1`,
    apiKey: localKey
  });
  const patchResult = await patchOpencodeConfig(
    { path: paths.opencodeConfig, fs: opencodeFs },
    provider
  );
  if (patchResult.backup) {
    process.stdout.write(`opencode.json backed up to ${patchResult.backup.path}\n`);
  }
  process.stdout.write(
    `opencode.json patched (${patchResult.changed ? "updated" : "no change"}) at ${paths.opencodeConfig}\n`
  );

  const daemonScript = locateDaemonScript();
  const nodeBin = process.execPath;
  const proxyUrl = pickProxyUrlFromEnv({
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy
  });
  const reasoningEffortEnv = process.env.ZED_REASONING_EFFORT;
  const plist = renderPlist({
    label: PLIST_LABEL,
    nodeBin,
    daemonScript,
    workingDir: paths.stateDir,
    logPath: paths.daemonLog,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    stateDir: paths.stateDir,
    proxyUrl,
    reasoningEffort:
      reasoningEffortEnv && reasoningEffortEnv.length > 0
        ? reasoningEffortEnv
        : null
  });
  await writePlist(paths.plistPath, plist);
  process.stdout.write(`launchd plist written to ${paths.plistPath}\n`);

  const uid = process.getuid?.() ?? 501;
  if (plistExists(paths.plistPath)) {
    await bootoutAgent(uid, paths.plistPath);
  }
  const bootstrap = await bootstrapAgent(uid, paths.plistPath);
  if (bootstrap.code !== 0 && !/already loaded/i.test(bootstrap.stderr)) {
    process.stderr.write(
      `launchctl bootstrap returned ${bootstrap.code}: ${bootstrap.stderr.trim()}\n`
    );
  }
  await kickstartAgent(uid, PLIST_LABEL);

  const ok = await waitForHealth(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`, 10_000);
  if (!ok) {
    process.stderr.write(
      `daemon did not become healthy within 10s. Check ${paths.daemonLog}\n`
    );
    return 1;
  }
  process.stdout.write(
    `daemon is up on http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`
  );
  process.stdout.write(
    `next: run "zed-bridge token" to paste a Zed Bearer token, then "opencode run -m zed/gpt-5.5 hello"\n`
  );
  return 0;
}

async function ensureLocalApiKey(path: string): Promise<string> {
  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const key = `sk-zed-${randomBytes(16).toString("hex")}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, key, { mode: 0o600 });
  return key;
}

function makeFs() {
  return {
    async readFile(p: string): Promise<string | null> {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(p: string, content: string, mode?: number) {
      if (mode !== undefined) {
        await writeFile(p, content, { mode });
      } else {
        await writeFile(p, content);
      }
    },
    async mkdir(p: string, opts: { recursive: true }) {
      await mkdir(p, opts);
    }
  };
}

function locateDaemonScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "daemon.js");
  if (existsSync(candidate)) return candidate;
  const sibling = resolve(here, "daemon.js");
  if (existsSync(sibling)) return sibling;
  return join(here, "daemon.js");
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
