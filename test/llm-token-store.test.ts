import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LlmTokenStore,
  defaultStatePath,
  formatCachedTokenSummary,
  TokenValidationError,
  validateAndStripToken,
  resolveTokenInput,
  type LlmTokenFs
} from "../src/llm-token-store.ts";

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

const PATH = "/tmp/zed-bridge-state/llm-token.json";

test("LlmTokenStore.read returns null when no file exists", async () => {
  const fs = makeMemFs();
  const s = new LlmTokenStore({ path: PATH, fs });
  assert.equal(await s.read(), null);
});

test("LlmTokenStore.write persists token with mode 0600", async () => {
  const fs = makeMemFs();
  const s = new LlmTokenStore({ path: PATH, fs, now: () => 1234567890 });
  await s.write("xxx.yyy.zzz", "manual");
  const f = fs.files.get(PATH)!;
  assert.equal(f.mode, 0o600);
  const parsed = JSON.parse(f.content) as Record<string, unknown>;
  assert.equal(parsed.token, "xxx.yyy.zzz");
  assert.equal(parsed.source, "manual");
  assert.equal(parsed.savedAt, 1234567890);
});

test("LlmTokenStore.write creates parent directory", async () => {
  const fs = makeMemFs();
  const s = new LlmTokenStore({ path: PATH, fs });
  await s.write("a.b.c", "mitm");
  assert.equal(fs.dirs.has("/tmp/zed-bridge-state"), true);
});

test("LlmTokenStore round-trips token", async () => {
  const fs = makeMemFs();
  const s = new LlmTokenStore({ path: PATH, fs, now: () => 42 });
  await s.write("aaa.bbb.ccc", "mitm");
  assert.deepEqual(await s.read(), {
    token: "aaa.bbb.ccc",
    savedAt: 42,
    source: "mitm"
  });
});

test("LlmTokenStore.clear removes file and is silent when missing", async () => {
  const fs = makeMemFs();
  const s = new LlmTokenStore({ path: PATH, fs });
  await s.write("a.b.c", "manual");
  await s.clear();
  assert.equal(fs.files.has(PATH), false);
  await s.clear();
  assert.equal(fs.files.has(PATH), false);
});

test("LlmTokenStore.read returns null on malformed JSON or invalid source", async () => {
  const a = new LlmTokenStore({
    path: PATH,
    fs: makeMemFs({ [PATH]: "not json" })
  });
  assert.equal(await a.read(), null);
  const b = new LlmTokenStore({
    path: PATH,
    fs: makeMemFs({
      [PATH]: JSON.stringify({ token: "a.b.c", savedAt: 1, source: "phishing" })
    })
  });
  assert.equal(await b.read(), null);
  const c = new LlmTokenStore({
    path: PATH,
    fs: makeMemFs({
      [PATH]: JSON.stringify({ savedAt: 1, source: "manual" })
    })
  });
  assert.equal(await c.read(), null);
});

test("defaultStatePath honors ZED_BRIDGE_STATE_DIR and HOME fallback", () => {
  assert.equal(
    defaultStatePath({
      ZED_BRIDGE_STATE_DIR: "/var/lib/zb"
    } as NodeJS.ProcessEnv),
    "/var/lib/zb/llm-token.json"
  );
  assert.equal(
    defaultStatePath({ HOME: "/Users/test" } as NodeJS.ProcessEnv),
    "/Users/test/.config/zed-bridge/state/llm-token.json"
  );
});

test("validateAndStripToken handles Bearer prefix and JWT shape", () => {
  assert.equal(validateAndStripToken("Bearer aaa.bbb.ccc"), "aaa.bbb.ccc");
  assert.equal(validateAndStripToken("bearer xxx.yyy.zzz"), "xxx.yyy.zzz");
  assert.equal(validateAndStripToken("BEARER  abc.def.ghi"), "abc.def.ghi");
  assert.equal(validateAndStripToken("h.p.s"), "h.p.s");
  assert.equal(validateAndStripToken("aA0_-.bB1_-.cC2_-"), "aA0_-.bB1_-.cC2_-");
});

test("validateAndStripToken rejects empty and malformed input", () => {
  assert.throws(() => validateAndStripToken(""), TokenValidationError);
  assert.throws(() => validateAndStripToken("   "), TokenValidationError);
  assert.throws(() => validateAndStripToken("not-a-jwt"), TokenValidationError);
  assert.throws(() => validateAndStripToken("only.two"), TokenValidationError);
  assert.throws(() => validateAndStripToken("a.b.c.d"), TokenValidationError);
});

test("formatCachedTokenSummary redacts and reports presence", () => {
  const lines = formatCachedTokenSummary(
    { token: "aaaaaa.bbbbbb.cccccc", savedAt: 0, source: "manual" },
    "/tmp/x/llm-token.json"
  );
  const text = lines.join("\n");
  assert.ok(text.includes("present"));
  assert.ok(text.includes("manual"));
  assert.ok(text.includes("/tmp/x/llm-token.json"));
  assert.ok(!text.includes("aaaaaa.bbbbbb.cccccc"));
});

test("resolveTokenInput priority arg > env > stdin", async () => {
  assert.equal(
    await resolveTokenInput({
      argv: ["--token", "Bearer h.p.s"],
      env: { ZED_LLM_TOKEN: "x.y.z" } as NodeJS.ProcessEnv,
      readStdin: async () => "stdin.tok.aaa"
    }),
    "h.p.s"
  );
  assert.equal(
    await resolveTokenInput({
      argv: ["--token=h.p.s"],
      env: {} as NodeJS.ProcessEnv,
      readStdin: async () => ""
    }),
    "h.p.s"
  );
  assert.equal(
    await resolveTokenInput({
      argv: [],
      env: { ZED_LLM_TOKEN: "Bearer a.b.c" } as NodeJS.ProcessEnv,
      readStdin: async () => ""
    }),
    "a.b.c"
  );
  assert.equal(
    await resolveTokenInput({
      argv: [],
      env: {} as NodeJS.ProcessEnv,
      readStdin: async () => "  d.e.f  \n"
    }),
    "d.e.f"
  );
});

test("resolveTokenInput throws on missing or malformed input", async () => {
  await assert.rejects(
    resolveTokenInput({
      argv: [],
      env: {} as NodeJS.ProcessEnv,
      readStdin: async () => ""
    }),
    TokenValidationError
  );
  await assert.rejects(
    resolveTokenInput({
      argv: ["--token", "garbage"],
      env: {} as NodeJS.ProcessEnv,
      readStdin: async () => ""
    }),
    TokenValidationError
  );
});
