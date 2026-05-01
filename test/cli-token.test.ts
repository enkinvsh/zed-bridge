import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const PLAINTEXT =
  '{"version":2,"id":"client_token_abc","token":"_Apinner_token_value"}';

function makeTempState(): { stateDir: string; secretPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "zb-cli-test-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const secretPath = join(stateDir, "internal-secret");
  writeFileSync(secretPath, "f".repeat(64), { mode: 0o600 });
  return { stateDir, secretPath };
}

function runCli(
  argv: string[],
  env: Record<string, string>,
  stdin?: string
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(REPO, "src/cli.ts"), ...argv],
    {
      env: { ...process.env, ...env },
      input: stdin,
      encoding: "utf8",
      timeout: 10_000
    }
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1
  };
}

test("CLI token: rejects bare inner token (no JSON envelope)", () => {
  const { stateDir } = makeTempState();
  const r = runCli(
    ["token", "--user-id", "42", "--plaintext", "_Ap_inner_only"],
    { ZED_BRIDGE_STATE_DIR: stateDir }
  );
  assert.notEqual(r.status, 0);
  assert.ok(/JSON envelope|JSON object/i.test(r.stderr), `stderr=${r.stderr}`);
});

test("CLI token: rejects when no userId provided", () => {
  const { stateDir } = makeTempState();
  const r = runCli(
    ["token", "--plaintext", PLAINTEXT],
    { ZED_BRIDGE_STATE_DIR: stateDir, ZED_USER_ID: "" }
  );
  assert.notEqual(r.status, 0);
  assert.ok(/userId/.test(r.stderr), `stderr=${r.stderr}`);
});

test("CLI token: rejects when daemon unreachable, never echoes plaintext", () => {
  const { stateDir } = makeTempState();
  const r = runCli(
    [
      "token",
      "--user-id",
      "42",
      "--plaintext",
      PLAINTEXT
    ],
    {
      ZED_BRIDGE_STATE_DIR: stateDir,
      ZED_BRIDGE_PORT: "1"
    }
  );
  assert.equal(r.status, 3);
  assert.ok(!r.stdout.includes("_Apinner_token_value"));
  assert.ok(!r.stderr.includes("_Apinner_token_value"));
});

test("CLI token: stdin input still validated", () => {
  const { stateDir } = makeTempState();
  const r = runCli(
    ["token", "--user-id", "42"],
    { ZED_BRIDGE_STATE_DIR: stateDir },
    "not-json"
  );
  assert.notEqual(r.status, 0);
  assert.ok(/JSON envelope|JSON object/i.test(r.stderr), `stderr=${r.stderr}`);
});

test("CLI: --version prints 0.2.1", () => {
  const r = runCli(["--version"], {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "0.2.1");
});

test("CLI: help mentions login + watch fallback", () => {
  const r = runCli(["--help"], {});
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("login"));
  assert.ok(r.stdout.includes("watch"));
  assert.ok(/Fallback/i.test(r.stdout));
});
