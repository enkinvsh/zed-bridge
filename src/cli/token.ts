import { readFile } from "node:fs/promises";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "../paths.js";
import {
  AccountValidationError,
  redactPlaintextShape,
  validateAccountInput
} from "../account-store.js";

export async function runToken(argv: string[]): Promise<number> {
  const paths = bridgePaths();

  let userId: string | undefined =
    pickStringFlag(argv, "--user-id") ?? process.env.ZED_USER_ID ?? undefined;
  let plaintextRaw: string | undefined =
    pickStringFlag(argv, "--plaintext") ??
    process.env.ZED_PLAINTEXT ??
    undefined;

  if (!plaintextRaw) {
    const stdin = await readStdinIfAvailable();
    if (stdin && stdin.trim().length > 0) {
      plaintextRaw = stdin.trim();
    }
  }

  if (!plaintextRaw) {
    process.stderr.write(
      "error: no plaintext envelope provided. Use --plaintext '<JSON>', ZED_PLAINTEXT env, or pipe via stdin.\n" +
        "       The envelope is the FULL decrypted JSON from native_app_signin, e.g. " +
        '\'{"version":2,"id":"client_token_...","token":"..."}\'.\n' +
        "       Prefer `zed-bridge login` for a guided browser flow.\n"
    );
    return 4;
  }
  if (!userId) {
    process.stderr.write(
      "error: no userId provided. Use --user-id <id> or ZED_USER_ID env.\n"
    );
    return 4;
  }

  let validated: { userId: string; plaintext: string };
  try {
    validated = validateAccountInput({
      userId,
      plaintext: plaintextRaw
    });
  } catch (err) {
    if (err instanceof AccountValidationError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 4;
    }
    throw err;
  }

  let secret: string;
  try {
    secret = (await readFile(paths.internalSecret, "utf8")).trim();
  } catch {
    process.stderr.write(
      `error: missing internal secret at ${paths.internalSecret}. Run \`zed-bridge init\` first.\n`
    );
    return 3;
  }

  const host = process.env.ZED_BRIDGE_HOST ?? DEFAULT_HOST;
  const port = process.env.ZED_BRIDGE_PORT ?? String(DEFAULT_PORT);
  const url = `http://${host}:${port}/_internal/zed-account`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret
      },
      body: JSON.stringify({
        userId: validated.userId,
        plaintext: validated.plaintext,
        source: "manual"
      })
    });
  } catch {
    process.stderr.write(
      `error: daemon not reachable at ${url}. Run \`zed-bridge start\`.\n`
    );
    return 3;
  }

  if (res.status === 204) {
    process.stdout.write(
      `ok. user=${validated.userId}, plaintext shape ${redactPlaintextShape(validated.plaintext)} (length=${validated.plaintext.length})\n`
    );
    return 0;
  }
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {}
  process.stderr.write(
    `error: daemon rejected account credentials (HTTP ${res.status}): ${bodyText.slice(0, 200)}\n`
  );
  return 1;
}

function pickStringFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
    if (a === flag) {
      const v = argv[i + 1];
      if (typeof v === "string") return v;
      return "";
    }
  }
  return null;
}

async function readStdinIfAvailable(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
