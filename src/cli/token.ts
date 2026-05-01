import { readFile } from "node:fs/promises";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "../paths.js";
import {
  resolveTokenInput,
  TokenValidationError
} from "../llm-token-store.js";
import { describeExpiry, getJwtExp, shapeOf } from "../jwt.js";

export async function runToken(argv: string[]): Promise<number> {
  const paths = bridgePaths();

  let token: string;
  try {
    token = await resolveTokenInput({
      argv,
      env: process.env,
      readStdin: readStdinIfAvailable
    });
  } catch (err) {
    if (err instanceof TokenValidationError) {
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

  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/_internal/zed-token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret
      },
      body: JSON.stringify({ token, source: "manual" })
    });
  } catch {
    process.stderr.write(
      `error: daemon not reachable at ${url}. Run \`zed-bridge start\`.\n`
    );
    return 3;
  }

  if (res.status === 204) {
    const exp = getJwtExp(token);
    let expSummary = "";
    if (exp !== null) {
      const info = describeExpiry(exp);
      expSummary = `, expires in ${info.hours}h ${info.minutes}m`;
    }
    process.stdout.write(
      `ok. token shape ${shapeOf(token)}${expSummary}\n`
    );
    return 0;
  }

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {}
  process.stderr.write(
    `error: daemon rejected token (HTTP ${res.status}): ${bodyText.slice(0, 200)}\n`
  );
  return 1;
}

async function readStdinIfAvailable(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write(
      "Paste your Zed Bearer token (or run with --token <jwt>), then Enter:\n"
    );
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
