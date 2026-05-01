import { defaultStateDir } from "./paths.js";

export type LlmTokenSource = "manual" | "mitm" | "mint";

export interface CachedLlmToken {
  token: string;
  savedAt: number;
  expiresAt: number;
  source: LlmTokenSource;
}

export interface LlmTokenFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

export interface LlmTokenStoreDeps {
  path: string;
  fs: LlmTokenFs;
  now?: () => number;
}

export class TokenValidationError extends Error {}

export class LlmTokenStore {
  constructor(private deps: LlmTokenStoreDeps) {}

  get path(): string {
    return this.deps.path;
  }

  async read(): Promise<CachedLlmToken | null> {
    const raw = await this.deps.fs.readFile(this.deps.path);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const token = obj.token;
    const savedAt = obj.savedAt;
    const source = obj.source;
    const expiresAtRaw = obj.expiresAt;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
    if (source !== "manual" && source !== "mitm" && source !== "mint") return null;
    const expiresAt =
      typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)
        ? expiresAtRaw
        : 0;
    return { token, savedAt, source, expiresAt };
  }

  async write(input: {
    token: string;
    expiresAt: number;
    source: LlmTokenSource;
  }): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const dir = parentDir(this.deps.path);
    if (dir.length > 0) {
      await this.deps.fs.mkdir(dir, { recursive: true });
    }
    const payload: CachedLlmToken = {
      token: input.token,
      savedAt: now,
      expiresAt: input.expiresAt,
      source: input.source
    };
    await this.deps.fs.writeFile(
      this.deps.path,
      JSON.stringify(payload),
      0o600
    );
  }

  async clear(): Promise<void> {
    try {
      await this.deps.fs.unlink(this.deps.path);
    } catch {
      return;
    }
  }
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return joinPath(defaultStateDir(env), "llm-token.json");
}

function joinPath(a: string, b: string): string {
  if (a.length === 0) return b;
  if (a.endsWith("/")) return `${a}${b}`;
  return `${a}/${b}`;
}

const JWT_SHAPE = /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;

export function validateAndStripToken(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new TokenValidationError("Empty token input");
  }
  let candidate = trimmed;
  const lower = candidate.toLowerCase();
  if (lower.startsWith("bearer ")) {
    candidate = candidate.slice(7).trimStart();
  }
  if (!JWT_SHAPE.test(candidate)) {
    throw new TokenValidationError(
      "Token does not look like a JWT (expected three dot-separated base64url segments)"
    );
  }
  return candidate;
}

export interface ResolveTokenInputDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
}

export async function resolveTokenInput(
  deps: ResolveTokenInputDeps
): Promise<string> {
  const fromArg = pickArgToken(deps.argv);
  if (fromArg !== null) return validateAndStripToken(fromArg);
  const fromEnv = deps.env.ZED_LLM_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return validateAndStripToken(fromEnv);
  }
  const fromStdin = await deps.readStdin();
  if (fromStdin && fromStdin.trim().length > 0) {
    return validateAndStripToken(fromStdin);
  }
  throw new TokenValidationError(
    "No token provided. Use --token <jwt>, ZED_LLM_TOKEN env, or pipe via stdin."
  );
}

function pickArgToken(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--token=")) {
      return a.slice("--token=".length);
    }
    if (a === "--token") {
      const v = argv[i + 1];
      if (typeof v === "string") return v;
      return "";
    }
  }
  return null;
}

export function redactTokenShape(value: string): string {
  if (value.length === 0) return "<empty>";
  if (value.length <= 8) return "x".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function formatCachedTokenSummary(
  cached: CachedLlmToken | null,
  path: string
): string[] {
  const lines: string[] = [];
  lines.push(`path: ${path}`);
  if (!cached) {
    lines.push("present: false");
    return lines;
  }
  const isoSavedAt = new Date(cached.savedAt).toISOString();
  lines.push("present: true");
  lines.push(`source: ${cached.source}`);
  lines.push(`savedAt: ${isoSavedAt}`);
  lines.push(
    `shape: ${redactTokenShape(cached.token)} (length=${cached.token.length})`
  );
  if (cached.expiresAt > 0) {
    lines.push(`expiresAt: ${new Date(cached.expiresAt * 1000).toISOString()}`);
  }
  return lines;
}
