import { redactBodyForError } from "./zed-token.js";

export type UpstreamErrorKind =
  | "auth_refreshable"
  | "credits_exhausted"
  | "forbidden_terminal"
  | "bad_request_terminal"
  | "upstream_unavailable"
  | "unknown";

export type UpstreamErrorClass =
  | { kind: "auth_refreshable"; userMessage: string }
  | {
      kind: "credits_exhausted";
      userMessage: string;
      periodEnd?: string;
    }
  | { kind: "forbidden_terminal"; userMessage: string }
  | { kind: "bad_request_terminal"; userMessage: string }
  | { kind: "upstream_unavailable"; userMessage: string }
  | { kind: "unknown"; userMessage: string };

export interface ZedTerminalErrorInit {
  statusCode: number;
  code: string;
  kind: UpstreamErrorKind;
  userMessage: string;
  redactedBody: string;
}

export class ZedTerminalError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly kind: UpstreamErrorKind;
  public readonly userMessage: string;
  public readonly redactedBody: string;

  constructor(init: ZedTerminalErrorInit) {
    super(init.userMessage);
    this.name = "ZedTerminalError";
    this.statusCode = init.statusCode;
    this.code = init.code;
    this.kind = init.kind;
    this.userMessage = init.userMessage;
    this.redactedBody = init.redactedBody;
  }
}

const CREDITS_EXHAUSTED_MSG =
  "Zed credits exhausted on your current plan. Wait for the next billing period or upgrade your Zed account.";

const AUTH_REFRESH_MSG = "Zed JWT rejected - refreshing and retrying once.";

const UPSTREAM_UNAVAILABLE_MSG = "Zed cloud unavailable (HTTP 5xx). Retry later.";

interface ParsedUpstreamBody {
  code: string | null;
  message: string | null;
  periodEnd: string | null;
}

function parseUpstreamBody(bodyText: string): ParsedUpstreamBody {
  const empty: ParsedUpstreamBody = {
    code: null,
    message: null,
    periodEnd: null
  };
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return empty;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const obj = parsed as Record<string, unknown>;
  const code = typeof obj["code"] === "string" ? (obj["code"] as string) : null;
  const message =
    typeof obj["message"] === "string" ? (obj["message"] as string) : null;
  let periodEnd: string | null = null;
  const pe = obj["period_end"] ?? obj["periodEnd"];
  if (typeof pe === "string") periodEnd = pe;
  return { code, message, periodEnd };
}

export function interpretUpstreamError(
  status: number,
  bodyText: string
): UpstreamErrorClass {
  const redacted = redactBodyForError(bodyText);
  const parsed = parseUpstreamBody(bodyText);

  if (parsed.code === "token_spend_limit_reached") {
    const out: UpstreamErrorClass = {
      kind: "credits_exhausted",
      userMessage: CREDITS_EXHAUSTED_MSG
    };
    if (parsed.periodEnd) out.periodEnd = parsed.periodEnd;
    return out;
  }

  if (parsed.code === "expired_llm_token") {
    return { kind: "auth_refreshable", userMessage: AUTH_REFRESH_MSG };
  }

  if (status === 401) {
    return { kind: "auth_refreshable", userMessage: AUTH_REFRESH_MSG };
  }

  if (status === 403) {
    return {
      kind: "forbidden_terminal",
      userMessage: `Zed cloud refused this request (403). Body: ${redacted}.`
    };
  }

  if (status === 400) {
    return {
      kind: "bad_request_terminal",
      userMessage: `Zed cloud rejected the request shape (400). This is likely a zed-bridge bug; please open an issue. Body: ${redacted}.`
    };
  }

  if (status >= 500 && status < 600) {
    return { kind: "upstream_unavailable", userMessage: UPSTREAM_UNAVAILABLE_MSG };
  }

  return {
    kind: "unknown",
    userMessage: `Zed upstream error ${status}. Body: ${redacted}.`
  };
}

const STATUS_BY_KIND: Record<UpstreamErrorKind, number> = {
  credits_exhausted: 402,
  forbidden_terminal: 403,
  bad_request_terminal: 400,
  upstream_unavailable: 502,
  unknown: 502,
  auth_refreshable: 401
};

export function statusForTerminalKind(kind: UpstreamErrorKind): number {
  return STATUS_BY_KIND[kind];
}

const CODE_BY_KIND: Record<UpstreamErrorKind, string> = {
  credits_exhausted: "credits_exhausted",
  forbidden_terminal: "forbidden",
  bad_request_terminal: "bad_request",
  upstream_unavailable: "upstream_unavailable",
  unknown: "unknown",
  auth_refreshable: "auth_refreshable"
};

export function codeForKind(kind: UpstreamErrorKind): string {
  return CODE_BY_KIND[kind];
}
