import { defaultStateDir } from "./paths.js";
import type { LlmTokenFs } from "./llm-token-store.js";

export type ZedAccountSource = "manual" | "login";

export interface ZedAccountCredentials {
  userId: string;
  plaintext: string;
  source: ZedAccountSource;
  savedAt: number;
}

export interface AccountStoreDeps {
  path: string;
  fs: LlmTokenFs;
  now?: () => number;
}

export class AccountValidationError extends Error {}

export class AccountStore {
  constructor(private deps: AccountStoreDeps) {}

  get path(): string {
    return this.deps.path;
  }

  async read(): Promise<ZedAccountCredentials | null> {
    const raw = await this.deps.fs.readFile(this.deps.path);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const userId = obj.userId;
    const plaintext = obj.plaintext;
    const source = obj.source;
    const savedAt = obj.savedAt;
    if (typeof userId !== "string" || userId.length === 0) return null;
    if (typeof plaintext !== "string" || plaintext.length === 0) return null;
    if (source !== "manual" && source !== "login") return null;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
    return { userId, plaintext, source, savedAt };
  }

  async write(
    credentials: Omit<ZedAccountCredentials, "savedAt">
  ): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const dir = parentDir(this.deps.path);
    if (dir.length > 0) {
      await this.deps.fs.mkdir(dir, { recursive: true });
    }
    const payload: ZedAccountCredentials = {
      userId: credentials.userId,
      plaintext: credentials.plaintext,
      source: credentials.source,
      savedAt: now
    };
    try {
      await this.deps.fs.writeFile(
        this.deps.path,
        JSON.stringify(payload),
        0o600
      );
    } catch (err) {
      throw new Error(
        `Failed to write account credentials: ${describeFsError(err)}`
      );
    }
  }

  async clear(): Promise<void> {
    try {
      await this.deps.fs.unlink(this.deps.path);
    } catch {
      return;
    }
  }
}

function describeFsError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code) return code;
    return err.name || "Error";
  }
  return "unknown";
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}

export function defaultAccountPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const dir = defaultStateDir(env);
  return joinPath(dir, "account.json");
}

function joinPath(a: string, b: string): string {
  if (a.length === 0) return b;
  if (a.endsWith("/")) return `${a}${b}`;
  return `${a}/${b}`;
}

export interface AccountInput {
  userId: string;
  plaintext: string;
}

export function validateAccountInput(input: AccountInput): AccountInput {
  const userId = (input.userId ?? "").trim();
  const plaintext = (input.plaintext ?? "").trim();
  if (userId.length === 0) {
    throw new AccountValidationError(
      "userId is required (the numeric Zed user id, e.g. 42)"
    );
  }
  if (plaintext.length === 0) {
    throw new AccountValidationError("plaintext envelope is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new AccountValidationError(
      'plaintext must be a JSON envelope like {"version":2,"id":"client_token_...","token":"..."}. ' +
        "If you only have the inner token, you need to capture the FULL decrypted plaintext from native_app_signin (or use `zed-bridge login`)."
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AccountValidationError(
      "plaintext must parse as a JSON object"
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.token !== "string" || (obj.token as string).length === 0) {
    throw new AccountValidationError(
      'plaintext JSON must contain a string "token" field'
    );
  }
  return { userId, plaintext };
}

export function redactPlaintextShape(value: string): string {
  if (value.length === 0) return "<empty>";
  if (value.length <= 8) return "x".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function formatAccountSummary(
  cred: ZedAccountCredentials | null,
  path: string
): string[] {
  const lines: string[] = [];
  lines.push(`path: ${path}`);
  if (!cred) {
    lines.push("present: false");
    return lines;
  }
  lines.push("present: true");
  lines.push(`userId: ${cred.userId}`);
  lines.push(`source: ${cred.source}`);
  lines.push(`savedAt: ${new Date(cred.savedAt).toISOString()}`);
  lines.push(
    `shape: ${redactPlaintextShape(cred.plaintext)} (length=${cred.plaintext.length})`
  );
  return lines;
}
