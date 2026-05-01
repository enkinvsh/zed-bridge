import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "../paths.js";
import { describeExpiry, shapeOf } from "../jwt.js";
import { readZedProvider, type OpencodeFs } from "../opencode-config.js";
import { redactPlaintextShape } from "../account-store.js";

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

  let accountPresent = false;
  try {
    const raw = await readFile(paths.accountJson, "utf8");
    const parsed = JSON.parse(raw) as {
      userId?: string;
      plaintext?: string;
      source?: string;
      savedAt?: number;
    };
    if (
      typeof parsed.userId === "string" &&
      parsed.userId.length > 0 &&
      typeof parsed.plaintext === "string" &&
      parsed.plaintext.length > 0
    ) {
      accountPresent = true;
      const savedAtIso = parsed.savedAt
        ? new Date(parsed.savedAt).toISOString()
        : "<unknown>";
      lines.push(
        `account: present, user=${parsed.userId}, source=${parsed.source ?? "?"}, savedAt=${savedAtIso}, shape=${redactPlaintextShape(
          parsed.plaintext
        )}`
      );
    } else {
      lines.push("account: absent (run `zed-bridge login` or `zed-bridge token`)");
    }
  } catch {
    lines.push("account: absent (run `zed-bridge login` or `zed-bridge token`)");
  }
  if (!accountPresent) healthy = false;

  try {
    const raw = await readFile(paths.llmTokenJson, "utf8");
    const parsed = JSON.parse(raw) as {
      token?: string;
      source?: string;
      savedAt?: number;
      expiresAt?: number;
    };
    if (parsed.token && parsed.token.length > 0) {
      const savedAtIso = parsed.savedAt
        ? new Date(parsed.savedAt).toISOString()
        : "<unknown>";
      let expLine = "exp: <unknown>";
      if (typeof parsed.expiresAt === "number" && parsed.expiresAt > 0) {
        const info = describeExpiry(parsed.expiresAt);
        expLine = info.expired
          ? `exp: EXPIRED (${-info.hours}h ${-info.minutes}m ago)`
          : `exp: ${info.hours}h ${info.minutes}m remaining`;
      }
      lines.push(
        `llm-jwt: cached, source=${parsed.source ?? "?"}, savedAt=${savedAtIso}, shape=${shapeOf(
          parsed.token
        )}, ${expLine}`
      );
    } else {
      lines.push(
        "llm-jwt: not cached (will be minted on first request)"
      );
    }
  } catch {
    lines.push("llm-jwt: not cached (will be minted on first request)");
  }

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
  lines.push(
    `mitm: ${mitmFound ? `${mitmFound} (fallback only; primary flow uses login + auto-mint)` : "not found (optional, fallback only)"}`
  );

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
