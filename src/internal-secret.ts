import { defaultStateDir } from "./paths.js";

export interface InternalSecretFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

export interface LoadOrCreateInternalSecretDeps {
  path: string;
  fs: InternalSecretFs;
  /** Returns 64-char lowercase hex string (32 random bytes hex-encoded). */
  randomHex: () => string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isValidSecret(value: string): boolean {
  return HEX64.test(value);
}

export async function loadOrCreateInternalSecret(
  deps: LoadOrCreateInternalSecretDeps
): Promise<string> {
  const raw = await deps.fs.readFile(deps.path);
  if (raw !== null) {
    const trimmed = raw.trim();
    if (isValidSecret(trimmed)) return trimmed;
  }
  const fresh = deps.randomHex();
  if (!isValidSecret(fresh)) {
    throw new Error(
      "internal-secret: randomHex must return 64-char lowercase hex"
    );
  }
  const dir = parentDir(deps.path);
  if (dir.length > 0) {
    await deps.fs.mkdir(dir, { recursive: true });
  }
  await deps.fs.writeFile(deps.path, fresh, 0o600);
  return fresh;
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}

export function defaultInternalSecretPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return joinPath(defaultStateDir(env), "internal-secret");
}

function joinPath(a: string, b: string): string {
  if (a.length === 0) return b;
  if (a.endsWith("/")) return `${a}${b}`;
  return `${a}/${b}`;
}

/** Constant-time string comparison. Returns false on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
