import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  publicEncrypt,
  constants as cryptoConstants
} from "node:crypto";
import {
  buildSignInUrl,
  decodePublicKeyBase64Url,
  decryptAccessToken,
  parseCallbackQuery,
  runLoginFlow,
  type LoginFlowDeps
} from "../src/zed-login.ts";

const PLAINTEXT =
  '{"version":2,"id":"client_token_abc","token":"_Apinner_token_value"}';

function makeRsaKeypair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

test("buildSignInUrl produces native_app_signin URL with port + key", () => {
  const url = buildSignInUrl({
    port: 12345,
    publicKeyBase64Url: "AAAA-key-base64url"
  });
  assert.ok(url.startsWith("https://zed.dev/native_app_signin?"));
  assert.ok(url.includes("native_app_port=12345"));
  assert.ok(url.includes("native_app_public_key=AAAA-key-base64url"));
});

test("decodePublicKeyBase64Url strips padding and is URL-safe", () => {
  const sample = Buffer.from([0xfa, 0xfb, 0xff, 0x00, 0x11, 0x22]);
  const enc = decodePublicKeyBase64Url(sample);
  assert.equal(enc.includes("="), false);
  assert.equal(enc.includes("+"), false);
  assert.equal(enc.includes("/"), false);
});

test("parseCallbackQuery extracts user_id and access_token", () => {
  const out = parseCallbackQuery("/?user_id=42&access_token=abcd1234");
  assert.deepEqual(out, { userId: "42", accessToken: "abcd1234" });
});

test("parseCallbackQuery rejects missing fields", () => {
  assert.equal(parseCallbackQuery("/?user_id=42"), null);
  assert.equal(parseCallbackQuery("/?access_token=x"), null);
  assert.equal(parseCallbackQuery("/somewhere/else"), null);
});

test("decryptAccessToken handles RSA-OAEP-SHA256 envelope", () => {
  const { publicKey, privateKey } = makeRsaKeypair();
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(PLAINTEXT, "utf8")
  );
  const b64url = encrypted
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const out = decryptAccessToken(b64url, privateKey);
  assert.equal(out, PLAINTEXT);
});

test("decryptAccessToken falls back to PKCS1v15", () => {
  const { publicKey, privateKey } = makeRsaKeypair();
  const encrypted = publicEncrypt(
    { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(PLAINTEXT, "utf8")
  );
  const b64url = encrypted
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const out = decryptAccessToken(b64url, privateKey);
  assert.equal(out, PLAINTEXT);
});

test("runLoginFlow encrypts JSON envelope plaintext and saves it AS-IS (regression for v0.1.0 inner-token bug)", async () => {
  const { publicKey, privateKey } = makeRsaKeypair();
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(PLAINTEXT, "utf8")
  );
  const accessTokenB64Url = encrypted
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const saved: Array<{
    userId: string;
    plaintext: string;
    source: string;
  }> = [];

  const deps: LoginFlowDeps = {
    generateKeypair: () => ({ publicKey, privateKey }),
    startCallbackServer: async ({ onCallback }) => {
      setTimeout(() => {
        void onCallback({ userId: "42", accessToken: accessTokenB64Url });
      }, 0);
      return { port: 65000, close: async () => {} };
    },
    openBrowser: async () => {},
    saveAccount: async (cred) => {
      saved.push(cred);
    },
    timeoutMs: 5_000
  };

  const result = await runLoginFlow(deps);
  assert.equal(result.userId, "42");
  assert.equal(result.plaintext, PLAINTEXT);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.userId, "42");
  assert.equal(saved[0]!.plaintext, PLAINTEXT);
  assert.equal(saved[0]!.source, "login");
});

test("runLoginFlow rejects on timeout", async () => {
  const { publicKey, privateKey } = makeRsaKeypair();
  const deps: LoginFlowDeps = {
    generateKeypair: () => ({ publicKey, privateKey }),
    startCallbackServer: async () => ({ port: 1, close: async () => {} }),
    openBrowser: async () => {},
    saveAccount: async () => {},
    timeoutMs: 50
  };
  await assert.rejects(runLoginFlow(deps), /timeout|timed out/i);
});

test("runLoginFlow does not echo plaintext on save error", async () => {
  const { publicKey, privateKey } = makeRsaKeypair();
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(PLAINTEXT, "utf8")
  );
  const accessTokenB64Url = encrypted
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const deps: LoginFlowDeps = {
    generateKeypair: () => ({ publicKey, privateKey }),
    startCallbackServer: async ({ onCallback }) => {
      setTimeout(
        () => void onCallback({ userId: "u", accessToken: accessTokenB64Url }),
        0
      );
      return { port: 1, close: async () => {} };
    },
    openBrowser: async () => {},
    saveAccount: async () => {
      throw new Error("disk full");
    },
    timeoutMs: 5_000
  };
  try {
    await runLoginFlow(deps);
    assert.fail("should throw");
  } catch (err) {
    assert.ok(!(err as Error).message.includes("_Apinner_token_value"));
    assert.ok(!(err as Error).message.includes(PLAINTEXT));
  }
});
