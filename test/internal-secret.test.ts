import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadOrCreateInternalSecret,
  defaultInternalSecretPath,
  isValidSecret,
  type InternalSecretFs
} from "../src/internal-secret.ts";

interface MemFile {
  content: string;
  mode: number;
}

interface MemFs extends InternalSecretFs {
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
    async mkdir(p) {
      dirs.add(p);
    }
  };
}

const PATH = "/tmp/zed-bridge-state/internal-secret";

test("isValidSecret accepts 64-char lowercase hex", () => {
  assert.equal(isValidSecret("a".repeat(64)), true);
  assert.equal(
    isValidSecret(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ),
    true
  );
});

test("isValidSecret rejects too short, wrong charset, or empty", () => {
  assert.equal(isValidSecret(""), false);
  assert.equal(isValidSecret("abc"), false);
  assert.equal(isValidSecret("Z".repeat(64)), false);
  assert.equal(isValidSecret("g".repeat(64)), false);
});

test("loadOrCreateInternalSecret generates on first call and writes mode 0600", async () => {
  const fs = makeMemFs();
  const generated = "f".repeat(64);
  const secret = await loadOrCreateInternalSecret({
    path: PATH,
    fs,
    randomHex: () => generated
  });
  assert.equal(secret, generated);
  const f = fs.files.get(PATH)!;
  assert.equal(f.mode, 0o600);
  assert.equal(f.content, generated);
  assert.equal(fs.dirs.has("/tmp/zed-bridge-state"), true);
});

test("loadOrCreateInternalSecret returns existing secret on second call", async () => {
  const existing = "1".repeat(64);
  const fs = makeMemFs({ [PATH]: existing });
  const secret = await loadOrCreateInternalSecret({
    path: PATH,
    fs,
    randomHex: () => "0".repeat(64)
  });
  assert.equal(secret, existing);
});

test("loadOrCreateInternalSecret trims whitespace from existing file", async () => {
  const existing = "2".repeat(64);
  const fs = makeMemFs({ [PATH]: `${existing}\n` });
  const secret = await loadOrCreateInternalSecret({
    path: PATH,
    fs,
    randomHex: () => "0".repeat(64)
  });
  assert.equal(secret, existing);
});

test("loadOrCreateInternalSecret regenerates when stored value is invalid", async () => {
  const fs = makeMemFs({ [PATH]: "not-hex-and-too-short" });
  const generated = "9".repeat(64);
  const secret = await loadOrCreateInternalSecret({
    path: PATH,
    fs,
    randomHex: () => generated
  });
  assert.equal(secret, generated);
  assert.equal(fs.files.get(PATH)!.content, generated);
  assert.equal(fs.files.get(PATH)!.mode, 0o600);
});

test("defaultInternalSecretPath honors ZED_BRIDGE_STATE_DIR", () => {
  const p = defaultInternalSecretPath({
    ZED_BRIDGE_STATE_DIR: "/var/lib/zed-bridge"
  } as NodeJS.ProcessEnv);
  assert.equal(p, "/var/lib/zed-bridge/internal-secret");
});

test("defaultInternalSecretPath falls back to HOME-relative path", () => {
  const p = defaultInternalSecretPath({
    HOME: "/Users/test"
  } as NodeJS.ProcessEnv);
  assert.equal(p, "/Users/test/.config/zed-bridge/state/internal-secret");
});
