import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildZedProvider,
  patchOpencodeConfig,
  readZedProvider,
  removeZedProvider,
  ZED_PROVIDER_KEY,
  type OpencodeFs
} from "../src/opencode-config.ts";

interface MemFile {
  content: string;
}

interface MemFs extends OpencodeFs {
  files: Map<string, MemFile>;
  dirs: Set<string>;
}

function makeMemFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>();
  for (const [k, v] of Object.entries(initial)) files.set(k, { content: v });
  return {
    files,
    dirs,
    async readFile(p) {
      const f = files.get(p);
      return f ? f.content : null;
    },
    async writeFile(p, content) {
      files.set(p, { content });
    },
    async mkdir(p) {
      dirs.add(p);
    }
  };
}

const PATH = "/tmp/opencode/opencode.json";

test("buildZedProvider returns expected shape", () => {
  const block = buildZedProvider({
    baseURL: "http://127.0.0.1:8788/v1",
    apiKey: "sk-zed-x"
  });
  assert.equal(block.npm, "@ai-sdk/openai-compatible");
  assert.equal(block.name, "Zed");
  assert.equal(block.options.baseURL, "http://127.0.0.1:8788/v1");
  assert.equal(block.options.apiKey, "sk-zed-x");
  assert.equal(block.models["gpt-5.5"]?.name, "GPT-5.5 (Zed)");
});

test("patchOpencodeConfig creates file and skips backup when none existed", async () => {
  const fs = makeMemFs();
  const result = await patchOpencodeConfig(
    { path: PATH, fs, now: () => 1700000000_000 },
    buildZedProvider({ baseURL: "http://127.0.0.1:8788/v1", apiKey: "k1" })
  );
  assert.equal(result.backup, null);
  assert.equal(result.changed, true);
  const written = JSON.parse(fs.files.get(PATH)!.content);
  assert.equal(written.provider.zed.options.apiKey, "k1");
});

test("patchOpencodeConfig backs up existing file with timestamp suffix", async () => {
  const initial = JSON.stringify({
    other: { keep: true },
    provider: { another: { foo: "bar" } }
  });
  const fs = makeMemFs({ [PATH]: initial });
  const result = await patchOpencodeConfig(
    { path: PATH, fs, now: () => 1700000000_000 },
    buildZedProvider({ baseURL: "http://127.0.0.1:8788/v1", apiKey: "k2" })
  );
  assert.ok(result.backup);
  assert.equal(result.backup!.path, `${PATH}.bak.zed-bridge.1700000000000`);
  assert.equal(result.backup!.content, initial);
  const written = JSON.parse(fs.files.get(PATH)!.content);
  assert.equal(written.other.keep, true);
  assert.equal(written.provider.another.foo, "bar");
  assert.equal(written.provider.zed.options.apiKey, "k2");
});

test("patchOpencodeConfig is idempotent (backup still made but no logical change)", async () => {
  const fs = makeMemFs();
  const provider = buildZedProvider({
    baseURL: "http://127.0.0.1:8788/v1",
    apiKey: "k3"
  });
  await patchOpencodeConfig({ path: PATH, fs, now: () => 1 }, provider);
  const second = await patchOpencodeConfig(
    { path: PATH, fs, now: () => 2 },
    provider
  );
  assert.equal(second.changed, false);
});

test("patchOpencodeConfig refuses non-object JSON", async () => {
  const fs = makeMemFs({ [PATH]: JSON.stringify(["not", "object"]) });
  await assert.rejects(
    patchOpencodeConfig(
      { path: PATH, fs, now: () => 1 },
      buildZedProvider({ baseURL: "http://x/v1", apiKey: "k" })
    ),
    /not a JSON object/
  );
});

test("removeZedProvider removes only the zed key, preserving siblings", async () => {
  const initial = JSON.stringify({
    other: { keep: true },
    provider: {
      [ZED_PROVIDER_KEY]: { npm: "x" },
      another: { foo: "bar" }
    }
  });
  const fs = makeMemFs({ [PATH]: initial });
  const out = await removeZedProvider({ path: PATH, fs });
  assert.equal(out.removed, true);
  const next = JSON.parse(fs.files.get(PATH)!.content);
  assert.equal(next.provider.zed, undefined);
  assert.equal(next.provider.another.foo, "bar");
  assert.equal(next.other.keep, true);
});

test("removeZedProvider deletes empty provider object after key removal", async () => {
  const initial = JSON.stringify({
    provider: { [ZED_PROVIDER_KEY]: { npm: "x" } }
  });
  const fs = makeMemFs({ [PATH]: initial });
  await removeZedProvider({ path: PATH, fs });
  const next = JSON.parse(fs.files.get(PATH)!.content);
  assert.equal(next.provider, undefined);
});

test("removeZedProvider returns removed=false when key absent or file missing", async () => {
  const fs1 = makeMemFs({
    [PATH]: JSON.stringify({ provider: { other: { x: 1 } } })
  });
  assert.equal((await removeZedProvider({ path: PATH, fs: fs1 })).removed, false);
  const fs2 = makeMemFs();
  assert.equal((await removeZedProvider({ path: PATH, fs: fs2 })).removed, false);
});

test("readZedProvider returns null when missing or absent", async () => {
  const fs = makeMemFs();
  assert.equal(await readZedProvider({ path: PATH, fs }), null);
});

test("readZedProvider returns the provider block when present", async () => {
  const fs = makeMemFs({
    [PATH]: JSON.stringify({
      provider: {
        [ZED_PROVIDER_KEY]: buildZedProvider({
          baseURL: "http://127.0.0.1:8788/v1",
          apiKey: "kx"
        })
      }
    })
  });
  const block = await readZedProvider({ path: PATH, fs });
  assert.ok(block);
  assert.equal(block!.options.apiKey, "kx");
  assert.equal(block!.options.baseURL, "http://127.0.0.1:8788/v1");
});
