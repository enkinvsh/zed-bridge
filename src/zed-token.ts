export interface ZedTokenManagerDeps {
  getCachedToken: () => Promise<string | null>;
  onTokenInvalid?: () => Promise<void>;
}

const NO_TOKEN_ERROR =
  "No Zed LLM token cached. Run `zed-bridge token` to paste a fresh Bearer token from Zed.";

export class ZedTokenManager {
  constructor(private deps: ZedTokenManagerDeps) {}

  async getToken(): Promise<string> {
    const cached = await this.deps.getCachedToken();
    if (cached && cached.length > 0) return cached;
    throw new Error(NO_TOKEN_ERROR);
  }

  async forceRefresh(): Promise<string> {
    if (this.deps.onTokenInvalid) {
      await this.deps.onTokenInvalid();
    }
    throw new Error(NO_TOKEN_ERROR);
  }
}

const REDACT_KEY_PATTERN =
  /^(.*token.*|.*secret.*|.*password.*|authorization|api[-_]?key|cookie|set[-_]?cookie)$/i;

export function redactBodyForError(body: string): string {
  if (body.length === 0) return "<empty>";
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const redacted = redactValue(parsed);
      const out = JSON.stringify(redacted);
      if (out.length > 512) return `${out.slice(0, 509)}...`;
      return out;
    } catch {
      return truncate(trimmed, 256);
    }
  }
  return truncate(trimmed, 256);
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
