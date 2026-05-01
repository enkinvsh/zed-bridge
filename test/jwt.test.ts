import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeExpiry,
  getJwtExp,
  parseJwt,
  shapeOf,
  JwtParseError
} from "../src/jwt.ts";

function b64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function jwt(payload: object, header: object = { alg: "HS256", typ: "JWT" }): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

test("parseJwt returns header and payload", () => {
  const tok = jwt({ exp: 1700000000, sub: "user" });
  const { header, payload } = parseJwt(tok);
  assert.equal(header.alg, "HS256");
  assert.equal(payload.exp, 1700000000);
  assert.equal(payload.sub, "user");
});

test("parseJwt throws on wrong segment count", () => {
  assert.throws(() => parseJwt("a.b"), JwtParseError);
  assert.throws(() => parseJwt("a.b.c.d"), JwtParseError);
});

test("parseJwt throws on bad base64 payload", () => {
  assert.throws(
    () => parseJwt(`${b64url(JSON.stringify({}))}.@@@.sig`),
    JwtParseError
  );
});

test("getJwtExp returns exp when present, null otherwise", () => {
  assert.equal(getJwtExp(jwt({ exp: 9999 })), 9999);
  assert.equal(getJwtExp(jwt({ sub: "x" })), null);
  assert.equal(getJwtExp("not.a.jwt-shape!@#"), null);
});

test("describeExpiry computes hours/minutes/expired flag", () => {
  const now = 1_000_000_000_000;
  const future = describeExpiry(Math.floor(now / 1000) + 3600 + 5 * 60, now);
  assert.equal(future.expired, false);
  assert.equal(future.hours, 1);
  assert.equal(future.minutes, 5);
  const past = describeExpiry(Math.floor(now / 1000) - 60, now);
  assert.equal(past.expired, true);
});

test("shapeOf redacts token revealing only head/tail", () => {
  assert.equal(shapeOf("abcdefghij"), "abcd...ghij");
  assert.equal(shapeOf(""), "<empty>");
  assert.equal(shapeOf("abcd"), "xxxx");
});
