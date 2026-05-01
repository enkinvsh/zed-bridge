export interface JwtPayload {
  exp?: number;
  iat?: number;
  sub?: string;
  [key: string]: unknown;
}

export interface ParsedJwt {
  header: Record<string, unknown>;
  payload: JwtPayload;
}

export class JwtParseError extends Error {}

function base64UrlDecode(segment: string): string {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

export function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtParseError("JWT must have three dot-separated segments");
  }
  let header: Record<string, unknown>;
  let payload: JwtPayload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0] ?? "")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new JwtParseError("Failed to decode JWT header");
  }
  try {
    payload = JSON.parse(base64UrlDecode(parts[1] ?? "")) as JwtPayload;
  } catch {
    throw new JwtParseError("Failed to decode JWT payload");
  }
  return { header, payload };
}

export function getJwtExp(token: string): number | null {
  try {
    const { payload } = parseJwt(token);
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ExpiryInfo {
  expSeconds: number;
  remainingSeconds: number;
  hours: number;
  minutes: number;
  expired: boolean;
}

export function describeExpiry(
  expSeconds: number,
  nowMs: number = Date.now()
): ExpiryInfo {
  const remaining = expSeconds - Math.floor(nowMs / 1000);
  const positive = Math.max(0, remaining);
  return {
    expSeconds,
    remainingSeconds: remaining,
    hours: Math.floor(positive / 3600),
    minutes: Math.floor((positive % 3600) / 60),
    expired: remaining <= 0
  };
}

export function shapeOf(token: string): string {
  if (token.length === 0) return "<empty>";
  if (token.length <= 8) return "x".repeat(token.length);
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
