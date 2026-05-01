import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "../paths.js";
import { describeExpiry, getJwtExp, shapeOf } from "../jwt.js";
import { readZedProvider, type OpencodeFs } from "../opencode-config.js";

export async function runStatus(argv: string[]): Promise<number> {
  void argv;
  const paths = bridgePaths();
  const lines: string[] = [];
  let healthy = true;

  let daemonUp = false;
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`, {
      method: "GET"
    });
    daemonUp = res.ok;
  } catch {
    daemonUp = false;
  }
  lines.push(
    `daemon: ${daemonUp ? "up" : "down"} (http://${DEFAULT_HOST}:${DEFAULT_PORT})`
  );
  if (!daemonUp) healthy = false;

  let tokenPresent = false;
  try {
    const raw = await readFile(paths.llmTokenJson, "utf8");
    const parsed = JSON.parse(raw) as {
      token?: string;
      source?: string;
      savedAt?: number;
    };
    if (parsed.token && parsed.token.length > 0) {
      tokenPresent = true;
      const exp = getJwtExp(parsed.token);
      const savedAtIso = parsed.savedAt
        ? new Date(parsed.savedAt).toISOString()
        : "<unknown>";
      let expLine = "exp: <none in JWT>";
      if (exp !== null) {
        const info = describeExpiry(exp);
        expLine = info.expired
          ? `exp: EXPIRED (${-info.hours}h ${-info.minutes}m ago)`
          : `exp: ${info.hours}h ${info.minutes}m remaining`;
      }
      lines.push(
        `token: present, source=${parsed.source ?? "?"}, savedAt=${savedAtIso}, shape=${shapeOf(
          parsed.token
        )}, ${expLine}`
      );
    } else {
      lines.push("token: absent (run `zed-bridge token`)");
    }
  } catch {
    lines.push("token: absent (run `zed-bridge token`)");
  }
  if (!tokenPresent) healthy = false;

  let localApiKey = "";
  try {
    localApiKey = (await readFile(paths.localApiKey, "utf8")).trim();
  } catch {}

  const opencodeFs: OpencodeFs = {
    async readFile(p) {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile() {},
    async mkdir() {}
  };
  const block = await readZedProvider({
    path: paths.opencodeConfig,
    fs: opencodeFs
  });
  if (!block) {
    lines.push(
      `opencode: provider.zed missing in ${paths.opencodeConfig}. Run \`zed-bridge init\`.`
    );
    healthy = false;
  } else {
    const matches =
      typeof block.options?.apiKey === "string" &&
      localApiKey.length > 0 &&
      block.options.apiKey === localApiKey;
    lines.push(
      `opencode: provider.zed present, apiKey ${matches ? "matches" : "MISMATCH"}, baseURL=${block.options?.baseURL ?? "?"}`
    );
    if (!matches) healthy = false;
  }

  const mitm = process.env.ZED_BRIDGE_MITM_BIN ?? "mitmdump";
  const mitmFound = which(mitm);
  lines.push(`mitm: ${mitmFound ? mitmFound : "not found (brew install mitmproxy)"}`);

  lines.push(`state dir: ${paths.stateDir}`);
  lines.push(`log: ${paths.daemonLog}${existsSync(paths.daemonLog) ? "" : " (missing)"}`);

  process.stdout.write(lines.join("\n") + "\n");
  return healthy ? 0 : 1;
}

function which(bin: string): string | null {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = `${dir.replace(/\/$/, "")}/${bin}`;
    if (existsSync(full)) return full;
  }
  return null;
}
