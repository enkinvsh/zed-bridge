import { readFile } from "node:fs/promises";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "../paths.js";
import {
  generateNodeKeypair,
  openWithMacOpen,
  runLoginFlow,
  startNodeCallbackServer
} from "../zed-login.js";
import { redactPlaintextShape } from "../account-store.js";

export async function runLogin(argv: string[]): Promise<number> {
  if (process.platform !== "darwin") {
    process.stderr.write("zed-bridge login is macOS only.\n");
    return 2;
  }
  const paths = bridgePaths();
  const timeoutMs = pickNumberFlag(argv, "--timeout-ms") ?? 300_000;

  let secret: string;
  try {
    secret = (await readFile(paths.internalSecret, "utf8")).trim();
  } catch {
    process.stderr.write(
      `error: missing internal secret at ${paths.internalSecret}. Run \`zed-bridge init\` first.\n`
    );
    return 3;
  }

  process.stdout.write(
    "Opening Zed sign-in in your browser. Approve the request to finish.\n"
  );
  let result;
  try {
    result = await runLoginFlow({
      generateKeypair: generateNodeKeypair,
      startCallbackServer: startNodeCallbackServer,
      openBrowser: openWithMacOpen,
      saveAccount: async (account) => {
        await pushAccountToDaemon({
          userId: account.userId,
          plaintext: account.plaintext,
          source: "login",
          secret
        });
      },
      timeoutMs
    });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(
    `ok. user=${result.userId}, plaintext shape ${redactPlaintextShape(result.plaintext)} (length=${result.plaintext.length})\n`
  );
  process.stdout.write(
    "next: opencode run -m zed/gpt-5.5 'Reply with the single word: pong'\n"
  );
  return 0;
}

async function pushAccountToDaemon(input: {
  userId: string;
  plaintext: string;
  source: "manual" | "login";
  secret: string;
}): Promise<void> {
  const host = process.env.ZED_BRIDGE_HOST ?? DEFAULT_HOST;
  const port = process.env.ZED_BRIDGE_PORT ?? String(DEFAULT_PORT);
  const url = `http://${host}:${port}/_internal/zed-account`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": input.secret
      },
      body: JSON.stringify({
        userId: input.userId,
        plaintext: input.plaintext,
        source: input.source
      })
    });
  } catch {
    throw new Error(
      `daemon not reachable at ${url}. Run \`zed-bridge start\`.`
    );
  }
  if (res.status === 204) return;
  let text = "";
  try {
    text = await res.text();
  } catch {}
  throw new Error(
    `daemon rejected account credentials (HTTP ${res.status}): ${text.slice(0, 200)}`
  );
}

function pickNumberFlag(argv: string[], flag: string): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === flag) {
      const v = argv[i + 1];
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }
    if (a.startsWith(`${flag}=`)) {
      const n = Number(a.slice(flag.length + 1));
      if (Number.isFinite(n)) return n;
      return null;
    }
  }
  return null;
}
