import { getJwtExp } from "./jwt.js";
import type { ZedAccountCredentials } from "./account-store.js";

export const ZED_LLM_TOKENS_ENDPOINT = "https://cloud.zed.dev/client/llm_tokens";
export const DEFAULT_REFRESH_LEAD_MS = 60_000;
export const DEFAULT_USER_AGENT = "Zed/0.228.0 (macos; aarch64)";

export interface CachedJwt {
  token: string;
  expiresAt: number;
}

export interface ZedTokenManagerDeps {
  fetch: typeof fetch;
  getAccountCredentials: () => Promise<ZedAccountCredentials | null>;
  getCachedJwt: () => Promise<CachedJwt | null>;
  setCachedJwt: (jwt: CachedJwt) => Promise<void>;
  clearCachedJwt: () => Promise<void>;
  onAccountInvalid?: () => Promise<void>;
  now?: () => number;
  refreshLeadMs?: number;
  userAgent?: string;
}

const NO_ACCOUNT_ERROR =
  "No Zed account credentials cached. Run `zed-bridge login` (or `zed-bridge token` for manual paste) to authenticate.";

const ACCOUNT_REJECTED_ERROR =
  "Zed account credentials rejected by mint endpoint (HTTP 401). Run `zed-bridge login` to re-auth.";

export class ZedTokenManager {
  constructor(private deps: ZedTokenManagerDeps) {}

  async getToken(): Promise<string> {
    const lead = this.deps.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
    const cached = await this.deps.getCachedJwt();
    const nowMs = (this.deps.now ?? Date.now)();
    const nowSec = Math.floor(nowMs / 1000);
    const leadSec = Math.ceil(lead / 1000);
    if (
      cached &&
      cached.token.length > 0 &&
      cached.expiresAt > nowSec + leadSec
    ) {
      return cached.token;
    }
    return this.mint();
  }

  async forceRefresh(): Promise<string> {
    await this.deps.clearCachedJwt();
    return this.mint();
  }

  private async mint(): Promise<string> {
    const creds = await this.deps.getAccountCredentials();
    if (!creds) {
      throw new Error(NO_ACCOUNT_ERROR);
    }

    const ua = this.deps.userAgent ?? DEFAULT_USER_AGENT;
    let res: Response;
    try {
      res = await this.deps.fetch(ZED_LLM_TOKENS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `${creds.userId} ${creds.plaintext}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": ua
        },
        body: "{}"
      });
    } catch (err) {
      throw new Error(
        `Zed mint endpoint unreachable: ${describeNetworkError(err)}`
      );
    }

    if (res.status === 401) {
      if (this.deps.onAccountInvalid) {
        try {
          await this.deps.onAccountInvalid();
        } catch {}
      }
      try {
        await this.deps.clearCachedJwt();
      } catch {}
      throw new Error(ACCOUNT_REJECTED_ERROR);
    }

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(
        `Zed mint failed: HTTP ${res.status} ${res.statusText || ""}`.trim() +
          ` body=${redactBodyForError(body)}`
      );
    }

    const text = await safeReadText(res);
    const parsed = parseMintResponse(text);
    if (!parsed) {
      throw new Error(
        `Zed mint returned unparseable body: ${redactBodyForError(text)}`
      );
    }

    let expiresAt = parsed.expiresAt;
    if (expiresAt === null) {
      const exp = getJwtExp(parsed.token);
      if (exp !== null) expiresAt = exp;
    }
    const cacheEntry: CachedJwt = {
      token: parsed.token,
      expiresAt: expiresAt ?? 0
    };
    await this.deps.setCachedJwt(cacheEntry);
    return parsed.token;
  }
}

interface MintResponse {
  token: string;
  expiresAt: number | null;
}

function parseMintResponse(body: string): MintResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const tok = obj.token;
  if (typeof tok !== "string" || tok.length === 0) return null;
  const expRaw = obj.expires_at ?? obj.expiresAt;
  let expiresAt: number | null = null;
  if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
    expiresAt = expRaw;
  } else if (typeof expRaw === "string") {
    const parsedDate = Date.parse(expRaw);
    if (!Number.isNaN(parsedDate)) {
      expiresAt = Math.floor(parsedDate / 1000);
    }
  }
  return { token: tok, expiresAt };
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code) return code;
    return err.name || "Error";
  }
  return "unknown";
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

const REDACT_KEY_PATTERN =
  /^(.*token.*|.*secret.*|.*password.*|authorization|api[-_]?key|cookie|set[-_]?cookie|plaintext)$/i;

const AUTH_HEADER_LINE = /Authorization:\s*\S+\s+\{[^}]*\}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-]+/gi;

export function redactBodyForError(body: string): string {
  if (body.length === 0) return "<empty>";
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const redacted = redactValue(parsed);
      const out = JSON.stringify(redacted);
      if (out.length > 512) return `${out.slice(0, 509)}...`;
      return scrubAuthSubstrings(out);
    } catch {}
  }
  return scrubAuthSubstrings(truncate(trimmed, 256));
}

function scrubAuthSubstrings(s: string): string {
  return s
    .replace(AUTH_HEADER_LINE, "Authorization: <redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>");
}

function truncate(s: string, limit: number): string {
  if (s.length > limit) return `${s.slice(0, limit - 3)}...`;
  return s;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_PATTERN.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}
