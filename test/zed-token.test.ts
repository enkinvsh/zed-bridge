import { test } from "node:test";
import assert from "node:assert/strict";
import { ZedTokenManager, redactBodyForError } from "../src/zed-token.ts";

test("getToken returns cached token when present", async () => {
  const mgr = new ZedTokenManager({
    getCachedToken: async () => "cached.tok.aaa"
  });
  assert.equal(await mgr.getToken(), "cached.tok.aaa");
});

test("getToken throws when cache is empty", async () => {
  const mgr = new ZedTokenManager({
    getCachedToken: async () => null
  });
  await assert.rejects(mgr.getToken(), /zed-bridge token/);
});

test("forceRefresh clears cache and throws", async () => {
  let invalidated = 0;
  const mgr = new ZedTokenManager({
    getCachedToken: async () => "stale.tok.zzz",
    onTokenInvalid: async () => {
      invalidated++;
    }
  });
  await assert.rejects(mgr.forceRefresh(), /zed-bridge token/);
  assert.equal(invalidated, 1);
});

test("redactBodyForError redacts token-like fields", () => {
  const body = JSON.stringify({
    token: "secret-token-1234",
    llm_token: "secret-llm-5678",
    access_token: "secret-access-9999",
    refresh_token: "secret-refresh",
    secret: "supersecret",
    password: "hunter2",
    authorization: "Bearer abc",
    message: "ok",
    code: 42
  });
  const out = redactBodyForError(body);
  assert.ok(!out.includes("secret-token-1234"));
  assert.ok(!out.includes("secret-llm-5678"));
  assert.ok(!out.includes("secret-access-9999"));
  assert.ok(!out.includes("secret-refresh"));
  assert.ok(!out.includes("supersecret"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("Bearer abc"));
  assert.ok(out.includes("ok"));
  assert.ok(out.includes("42"));
});

test("redactBodyForError handles nested and case-insensitive fields", () => {
  const body = JSON.stringify({
    data: { Token: "leaked-1", Access_Token: "leaked-2" },
    list: [{ llm_token: "leaked-3" }]
  });
  const out = redactBodyForError(body);
  assert.ok(!out.includes("leaked-1"));
  assert.ok(!out.includes("leaked-2"));
  assert.ok(!out.includes("leaked-3"));
});

test("redactBodyForError truncates long non-JSON bodies", () => {
  const out = redactBodyForError("x".repeat(5000));
  assert.ok(out.length <= 300);
});

test("redactBodyForError handles empty body", () => {
  assert.equal(redactBodyForError(""), "<empty>");
});
