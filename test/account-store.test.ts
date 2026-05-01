import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountStore,
  defaultAccountPath,
  formatAccountSummary,
  validateAccountInput,
  AccountValidationError
} from "../src/account-store.ts";
import type { LlmTokenFs } from "../src/llm-token-store.ts";

interface MemFile {
  content: string;
  mode: number;
}

interface MemFs extends LlmTokenFs {
  files: Map<string, MemFile>;
  dirs: Set<string>;
}

function makeMemFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>();
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, { content: v, mode: 0o600 });
  }
  return {
    files,
    dirs,
    async readFile(p) {
      const f = files.get(p);
      return f ? f.content : null;
    },
    async writeFile(p, content, mode) {
      files.set(p, { content, mode });
    },
    async unlink(p) {
      files.delete(p);
    },
    async mkdir(p) {
      dirs.add(p);
    }
  };
}

const PATH = "/tmp/zed-bridge-state/account.json";
const PLAINTEXT =
  '{"version":2,"id":"client_token_abc","token":"_Ap1secret_inner_token_value"}';

test("AccountStore.read returns null when no file exists", async () => {
  const fs = makeMemFs();
  const s = new AccountStore({ path: PATH, fs });
  assert.equal(await s.read(), null);
});

test("AccountStore.write persists with mode 0600 and creates parent dir", async () => {
  const fs = makeMemFs();
  const s = new AccountStore({ path: PATH, fs, now: () => 1234567890 });
  await s.write({ userId: "42", plaintext: PLAINTEXT, source: "login" });
  const f = fs.files.get(PATH)!;
  assert.equal(f.mode, 0o600);
  const parsed = JSON.parse(f.content) as Record<string, unknown>;
  assert.equal(parsed.userId, "42");
  assert.equal(parsed.plaintext, PLAINTEXT);
  assert.equal(parsed.source, "login");
  assert.equal(parsed.savedAt, 1234567890);
  assert.equal(fs.dirs.has("/tmp/zed-bridge-state"), true);
});

test("AccountStore round-trips credentials", async () => {
  const fs = makeMemFs();
  const s = new AccountStore({ path: PATH, fs, now: () => 42 });
  await s.write({ userId: "u1", plaintext: PLAINTEXT, source: "manual" });
  const out = await s.read();
  assert.deepEqual(out, {
    userId: "u1",
    plaintext: PLAINTEXT,
    source: "manual",
    savedAt: 42
  });
});

test("AccountStore.clear removes file silently when missing", async () => {
  const fs = makeMemFs();
  const s = new AccountStore({ path: PATH, fs });
  await s.write({ userId: "u", plaintext: PLAINTEXT, source: "login" });
  await s.clear();
  assert.equal(fs.files.has(PATH), false);
  await s.clear();
  assert.equal(fs.files.has(PATH), false);
});

test("AccountStore.read returns null on malformed JSON or missing fields", async () => {
  const a = new AccountStore({
    path: PATH,
    fs: makeMemFs({ [PATH]: "not json" })
  });
  assert.equal(await a.read(), null);

  const b = new AccountStore({
    path: PATH,
    fs: makeMemFs({
      [PATH]: JSON.stringify({ userId: "u", plaintext: "" })
    })
  });
  assert.equal(await b.read(), null);

  const c = new AccountStore({
    path: PATH,
    fs: makeMemFs({
      [PATH]: JSON.stringify({
        userId: "",
        plaintext: PLAINTEXT,
        source: "login",
        savedAt: 1
      })
    })
  });
  assert.equal(await c.read(), null);

  const d = new AccountStore({
    path: PATH,
    fs: makeMemFs({
      [PATH]: JSON.stringify({
        userId: "u",
        plaintext: PLAINTEXT,
        source: "phishing",
        savedAt: 1
      })
    })
  });
  assert.equal(await d.read(), null);
});

test("validateAccountInput accepts JSON envelope plaintext with token field", () => {
  const out = validateAccountInput({ userId: "u1", plaintext: PLAINTEXT });
  assert.equal(out.userId, "u1");
  assert.equal(out.plaintext, PLAINTEXT);
});

test("validateAccountInput rejects empty userId", () => {
  assert.throws(
    () => validateAccountInput({ userId: "", plaintext: PLAINTEXT }),
    AccountValidationError
  );
});

test("validateAccountInput rejects non-JSON plaintext", () => {
  assert.throws(
    () => validateAccountInput({ userId: "u", plaintext: "not-json" }),
    AccountValidationError
  );
});

test("validateAccountInput rejects bare inner token (looks like base64)", () => {
  assert.throws(
    () =>
      validateAccountInput({
        userId: "u",
        plaintext: "fake-decrypted-bytes-for-test"
      }),
    AccountValidationError
  );
});

test("validateAccountInput rejects JSON without string token field", () => {
  assert.throws(
    () =>
      validateAccountInput({
        userId: "u",
        plaintext: JSON.stringify({ version: 2, id: "x" })
      }),
    AccountValidationError
  );
});

test("formatAccountSummary redacts plaintext shape", () => {
  const lines = formatAccountSummary(
    {
      userId: "42",
      plaintext: PLAINTEXT,
      source: "login",
      savedAt: 1700000000000
    },
    PATH
  );
  const text = lines.join("\n");
  assert.ok(text.includes("present: true"));
  assert.ok(text.includes("login"));
  assert.ok(text.includes("42"));
  assert.ok(text.includes(PATH));
  assert.ok(!text.includes("_Ap1secret_inner_token_value"));
});

test("formatAccountSummary handles absent credentials", () => {
  const lines = formatAccountSummary(null, PATH);
  const text = lines.join("\n");
  assert.ok(text.includes("present: false"));
  assert.ok(text.includes(PATH));
});

test("defaultAccountPath honors ZED_BRIDGE_STATE_DIR", () => {
  assert.equal(
    defaultAccountPath({ ZED_BRIDGE_STATE_DIR: "/var/lib/zb" } as NodeJS.ProcessEnv),
    "/var/lib/zb/account.json"
  );
});

test("AccountStore.write does not echo plaintext on errors", async () => {
  const fs = makeMemFs();
  fs.writeFile = async () => {
    throw new Error("disk full");
  };
  const s = new AccountStore({ path: PATH, fs });
  try {
    await s.write({ userId: "u", plaintext: PLAINTEXT, source: "login" });
    assert.fail("should throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes("_Ap1secret_inner_token_value"), `leak: ${msg}`);
    assert.ok(!msg.includes(PLAINTEXT), `leak: ${msg}`);
  }
});
