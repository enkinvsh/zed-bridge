import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bridgePaths, DEFAULT_PORT } from "../paths.js";

export async function runWatch(argv: string[]): Promise<number> {
  const paths = bridgePaths();
  const upstream = pickArg(argv, "--upstream");
  const port = pickArg(argv, "--port") ?? "8082";

  const mitm = which(process.env.ZED_BRIDGE_MITM_BIN ?? "mitmdump");
  if (!mitm) {
    process.stderr.write(
      "error: mitmdump not found. Install with: brew install mitmproxy\n"
    );
    return 2;
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
  const addonPath = locateAddonScript();
  if (!existsSync(addonPath)) {
    process.stderr.write(
      `error: mitm addon not found at ${addonPath}. Reinstall the package.\n`
    );
    return 4;
  }

  const args = [
    "--listen-host",
    "127.0.0.1",
    "--listen-port",
    port,
    "-s",
    addonPath
  ];
  if (upstream && upstream.length > 0) {
    args.splice(0, 0, "--mode", `upstream:${upstream}`);
  }
  const env = {
    ...process.env,
    ZED_PROXY_INTERNAL_SECRET: secret,
    ZED_BRIDGE_INTERNAL_SECRET: secret,
    ZED_PROXY_PORT: String(DEFAULT_PORT),
    ZED_BRIDGE_STATE_DIR: paths.stateDir
  };
  process.stdout.write(
    `starting mitmdump on 127.0.0.1:${port} (upstream=${upstream ?? "<none>"}). Ctrl-C to stop.\n`
  );
  const proc = spawn(mitm, args, { stdio: "inherit", env });
  return new Promise((resolveCode) => {
    proc.on("close", (code) => resolveCode(code ?? 0));
    proc.on("error", (err) => {
      process.stderr.write(`mitmdump failed: ${err.message}\n`);
      resolveCode(1);
    });
  });
}

function pickArg(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === flag) return argv[i + 1] ?? "";
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return null;
}

function which(bin: string): string | null {
  if (bin.startsWith("/")) return existsSync(bin) ? bin : null;
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = `${dir.replace(/\/$/, "")}/${bin}`;
    if (existsSync(full)) return full;
  }
  return null;
}

function locateAddonScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "mitm", "zed_token_capture.py"),
    resolve(here, "..", "mitm", "zed_token_capture.py"),
    resolve(here, "mitm", "zed_token_capture.py")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? "";
}
