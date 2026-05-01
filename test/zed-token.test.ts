import { test } from "node:test";
import assert from "node:assert/strict";
import { ZedTokenManager, redactBodyForError } from "../src/zed-token.ts";
import type { ZedAccountCredentials } from "../src/account-store.ts";

function b64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function jwt(exp: number): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { exp, sub: "user" };
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

const PLAINTEXT =
  '{"version":2,"id":"client_token_xxx","token":"_Apinner_token_value"}';

const CREDS: ZedAccountCredentials = {
  userId: "42",
  plaintext: PLAINTEXT,
  source: "login",
  savedAt: 0
};

interface MintCall {
  url: string;
  init: RequestInit;
}

function makeFetchMock(
  responder: (
    call: MintCall
  ) => Response | Promise<Response>
): { fetch: typeof fetch; calls: MintCall[] } {
  const calls: MintCall[] = [];
  const f: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const call: MintCall = { url, init: init ?? {} };
    calls.push(call);
    return await responder(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

test("getToken returns cached JWT when not near expiry", async () => {
  const now = 1_000_000_000_000;
  const futureExp = Math.floor(now / 1000) + 600;
  let mintCalls = 0;
  const { fetch: f } = makeFetchMock(() => {
    mintCalls++;
    return new Response("{}", { status: 200 });
  });
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => ({ token: "cached.jwt.tok", expiresAt: futureExp }),
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {},
    now: () => now,
    refreshLeadMs: 60_000
  });
  const out = await mgr.getToken();
  assert.equal(out, "cached.jwt.tok");
  assert.equal(mintCalls, 0);
});

test("getToken mints when cache is empty", async () => {
  const now = 1_000_000_000_000;
  const newExp = Math.floor(now / 1000) + 3600;
  const newJwt = jwt(newExp);
  let saved: { token: string; expiresAt: number } | null = null;
  const { fetch: f, calls } = makeFetchMock(() => {
    return new Response(JSON.stringify({ token: newJwt }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => null,
    setCachedJwt: async (j) => {
      saved = j;
    },
    clearCachedJwt: async () => {},
    now: () => now
  });
  const out = await mgr.getToken();
  assert.equal(out, newJwt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://cloud.zed.dev/client/llm_tokens");
  const init = calls[0]!.init;
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], `${CREDS.userId} ${CREDS.plaintext}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Accept"], "application/json");
  assert.ok(headers["User-Agent"].length > 0);
  assert.equal(init.body, "{}");
  assert.deepEqual(saved, { token: newJwt, expiresAt: newExp });
});

test("getToken mints when cached JWT is past refresh lead", async () => {
  const now = 1_000_000_000_000;
  const expSoon = Math.floor(now / 1000) + 30;
  const newExp = Math.floor(now / 1000) + 3600;
  const newJwt = jwt(newExp);
  const { fetch: f, calls } = makeFetchMock(() => {
    return new Response(JSON.stringify({ token: newJwt }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => ({ token: "stale.tok", expiresAt: expSoon }),
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {},
    now: () => now,
    refreshLeadMs: 60_000
  });
  const out = await mgr.getToken();
  assert.equal(out, newJwt);
  assert.equal(calls.length, 1);
});

test("getToken throws when no account credentials", async () => {
  const mgr = new ZedTokenManager({
    fetch: (async () => new Response()) as typeof fetch,
    getAccountCredentials: async () => null,
    getCachedJwt: async () => null,
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {}
  });
  await assert.rejects(mgr.getToken(), /zed-bridge login|zed-bridge token/);
});

test("mint 401 calls onAccountInvalid, clears cache, and throws re-auth hint", async () => {
  let invalidated = 0;
  let cleared = 0;
  const { fetch: f } = makeFetchMock(
    () => new Response('{"error":"unauthorized"}', { status: 401 })
  );
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => null,
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {
      cleared++;
    },
    onAccountInvalid: async () => {
      invalidated++;
    }
  });
  await assert.rejects(mgr.getToken(), /re-auth|zed-bridge login/);
  assert.equal(invalidated, 1);
  assert.equal(cleared, 1);
});

test("mint 5xx does not clear caches, throws redacted", async () => {
  let cleared = 0;
  let invalidated = 0;
  const leakedToken = "leak-tok-1234";
  const { fetch: f } = makeFetchMock(
    () =>
      new Response(JSON.stringify({ message: "boom", token: leakedToken }), {
        status: 503
      })
  );
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => null,
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {
      cleared++;
    },
    onAccountInvalid: async () => {
      invalidated++;
    }
  });
  try {
    await mgr.getToken();
    assert.fail("should throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(msg.includes("503"), `msg=${msg}`);
    assert.ok(!msg.includes(leakedToken), `leaked: ${msg}`);
    assert.ok(!msg.includes(CREDS.plaintext), `plaintext leaked: ${msg}`);
  }
  assert.equal(cleared, 0);
  assert.equal(invalidated, 0);
});

test("forceRefresh clears cache then mints once", async () => {
  const now = 1_000_000_000_000;
  const newJwt = jwt(Math.floor(now / 1000) + 3600);
  let cleared = 0;
  const { fetch: f, calls } = makeFetchMock(
    () =>
      new Response(JSON.stringify({ token: newJwt }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  );
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => ({ token: "old", expiresAt: 9_999_999_999 }),
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {
      cleared++;
    },
    now: () => now
  });
  const out = await mgr.forceRefresh();
  assert.equal(out, newJwt);
  assert.equal(cleared, 1);
  assert.equal(calls.length, 1);
});

test("mint error message does not contain Authorization header value", async () => {
  const { fetch: f } = makeFetchMock(
    () => new Response("server crashed", { status: 500 })
  );
  const mgr = new ZedTokenManager({
    fetch: f,
    getAccountCredentials: async () => CREDS,
    getCachedJwt: async () => null,
    setCachedJwt: async () => {},
    clearCachedJwt: async () => {}
  });
  try {
    await mgr.getToken();
    assert.fail("should throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes(CREDS.userId + " " + CREDS.plaintext));
    assert.ok(!msg.includes(CREDS.plaintext));
  }
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

test("redactBodyForError strips Authorization header substrings", () => {
  const auth = `Authorization: 42 {"version":2,"token":"hidden_token_value"}`;
  const out = redactBodyForError(auth);
  assert.ok(!out.includes("hidden_token_value"));
});
