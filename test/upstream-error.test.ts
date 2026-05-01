import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretUpstreamError,
  statusForTerminalKind,
  codeForKind,
  ZedTerminalError
} from "../src/upstream-error.ts";

test("403 + token_spend_limit_reached -> credits_exhausted", () => {
  const cls = interpretUpstreamError(
    403,
    JSON.stringify({
      code: "token_spend_limit_reached",
      message: "Student plan credits consumed."
    })
  );
  assert.equal(cls.kind, "credits_exhausted");
  assert.match(cls.userMessage, /credits exhausted/i);
  assert.match(cls.userMessage, /next billing period/i);
});

test("403 + token_spend_limit_reached carries period_end when present", () => {
  const cls = interpretUpstreamError(
    403,
    JSON.stringify({
      code: "token_spend_limit_reached",
      message: "out",
      period_end: "2026-06-01T00:00:00Z"
    })
  );
  assert.equal(cls.kind, "credits_exhausted");
  if (cls.kind === "credits_exhausted") {
    assert.equal(cls.periodEnd, "2026-06-01T00:00:00Z");
  }
});

test("403 + expired_llm_token -> auth_refreshable", () => {
  const cls = interpretUpstreamError(
    403,
    JSON.stringify({ code: "expired_llm_token", message: "old token" })
  );
  assert.equal(cls.kind, "auth_refreshable");
});

test("401 with any body -> auth_refreshable", () => {
  const cls = interpretUpstreamError(401, "Unauthorized");
  assert.equal(cls.kind, "auth_refreshable");
});

test("401 with empty body -> auth_refreshable", () => {
  const cls = interpretUpstreamError(401, "");
  assert.equal(cls.kind, "auth_refreshable");
});

test("400 with JSON message -> bad_request_terminal", () => {
  const cls = interpretUpstreamError(
    400,
    JSON.stringify({
      message: "failed to parse OpenAI Responses API request: bad shape"
    })
  );
  assert.equal(cls.kind, "bad_request_terminal");
  assert.match(cls.userMessage, /400/);
  assert.match(cls.userMessage, /zed-bridge bug/i);
});

test("503 -> upstream_unavailable", () => {
  const cls = interpretUpstreamError(503, "Service unavailable");
  assert.equal(cls.kind, "upstream_unavailable");
  assert.match(cls.userMessage, /5xx/i);
});

test("500 -> upstream_unavailable", () => {
  const cls = interpretUpstreamError(500, "boom");
  assert.equal(cls.kind, "upstream_unavailable");
});

test("403 unknown code -> forbidden_terminal (catch-all)", () => {
  const cls = interpretUpstreamError(
    403,
    JSON.stringify({ code: "forbidden", message: "go away" })
  );
  assert.equal(cls.kind, "forbidden_terminal");
  assert.match(cls.userMessage, /403/);
});

test("418 -> unknown", () => {
  const cls = interpretUpstreamError(418, "I am a teapot");
  assert.equal(cls.kind, "unknown");
  assert.match(cls.userMessage, /418/);
});

test("body parse failure is graceful -> falls through to status mapping", () => {
  const cls = interpretUpstreamError(403, "<html>nope</html>");
  assert.equal(cls.kind, "forbidden_terminal");
});

test("body parse failure with status that has no explicit mapping -> unknown", () => {
  const cls = interpretUpstreamError(420, "garbage } not { json");
  assert.equal(cls.kind, "unknown");
});

test("user message strips Bearer ey... patterns", () => {
  const cls = interpretUpstreamError(
    403,
    "leaked auth Bearer eyJabc.def.ghi blah"
  );
  assert.equal(cls.kind, "forbidden_terminal");
  assert.equal(cls.userMessage.includes("eyJabc"), false);
  assert.match(cls.userMessage, /redacted/i);
});

test("user message redacts token-like JSON fields", () => {
  const cls = interpretUpstreamError(
    400,
    JSON.stringify({
      message: "bad",
      authorization: "Bearer eyJabc.def.ghi",
      token: "supersecret-xyz"
    })
  );
  assert.equal(cls.kind, "bad_request_terminal");
  assert.equal(cls.userMessage.includes("supersecret-xyz"), false);
  assert.equal(cls.userMessage.includes("eyJabc.def.ghi"), false);
});

test("ZedTerminalError preserves all fields", () => {
  const err = new ZedTerminalError({
    statusCode: 402,
    code: "credits_exhausted",
    kind: "credits_exhausted",
    userMessage: "no credits",
    redactedBody: "<redacted>"
  });
  assert.equal(err.statusCode, 402);
  assert.equal(err.code, "credits_exhausted");
  assert.equal(err.kind, "credits_exhausted");
  assert.equal(err.userMessage, "no credits");
  assert.equal(err.redactedBody, "<redacted>");
  assert.equal(err.message, "no credits");
  assert.ok(err instanceof Error);
});

test("statusForTerminalKind maps each kind", () => {
  assert.equal(statusForTerminalKind("credits_exhausted"), 402);
  assert.equal(statusForTerminalKind("forbidden_terminal"), 403);
  assert.equal(statusForTerminalKind("bad_request_terminal"), 400);
  assert.equal(statusForTerminalKind("upstream_unavailable"), 502);
  assert.equal(statusForTerminalKind("unknown"), 502);
});

test("codeForKind returns a stable string per kind", () => {
  assert.equal(codeForKind("credits_exhausted"), "credits_exhausted");
  assert.equal(codeForKind("forbidden_terminal"), "forbidden");
  assert.equal(codeForKind("bad_request_terminal"), "bad_request");
  assert.equal(codeForKind("upstream_unavailable"), "upstream_unavailable");
  assert.equal(codeForKind("unknown"), "unknown");
});
