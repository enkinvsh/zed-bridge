import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PLIST_LABEL } from "./paths.js";

export interface PlistOpts {
  label: string;
  nodeBin: string;
  daemonScript: string;
  workingDir: string;
  logPath: string;
  port: number;
  host: string;
  stateDir: string;
  proxyUrl?: string | null;
  reasoningEffort?: string | null;
}

export function renderPlist(opts: PlistOpts): string {
  const envEntries: Array<[string, string]> = [
    ["ZED_BRIDGE_PORT", String(opts.port)],
    ["ZED_BRIDGE_HOST", opts.host],
    ["ZED_BRIDGE_STATE_DIR", opts.stateDir],
    ["PATH", `${dirname(opts.nodeBin)}:/usr/local/bin:/usr/bin:/bin`]
  ];
  if (opts.proxyUrl && opts.proxyUrl.length > 0) {
    envEntries.push(["HTTPS_PROXY", opts.proxyUrl]);
  }
  if (opts.reasoningEffort && opts.reasoningEffort.length > 0) {
    envEntries.push(["ZED_REASONING_EFFORT", opts.reasoningEffort]);
  }
  const envXml = envEntries
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodeBin)}</string>
    <string>${escapeXml(opts.daemonScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    const proc = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
    proc.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: stderr + err.message });
    });
  });
}

export async function writePlist(plistPath: string, content: string): Promise<void> {
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, content, { mode: 0o644 });
}

export function plistExists(plistPath: string): boolean {
  return existsSync(plistPath);
}

export function gpuiDomainTarget(uid: number, label: string = PLIST_LABEL): string {
  return `gui/${uid}/${label}`;
}

export function gpuiDomain(uid: number): string {
  return `gui/${uid}`;
}

export async function bootstrapAgent(
  uid: number,
  plistPath: string
): Promise<LaunchctlResult> {
  return runLaunchctl(["bootstrap", gpuiDomain(uid), plistPath]);
}

export async function bootoutAgent(
  uid: number,
  plistPath: string
): Promise<LaunchctlResult> {
  return runLaunchctl(["bootout", gpuiDomain(uid), plistPath]);
}

export async function kickstartAgent(
  uid: number,
  label: string = PLIST_LABEL
): Promise<LaunchctlResult> {
  return runLaunchctl(["kickstart", "-k", gpuiDomainTarget(uid, label)]);
}

export async function printAgent(
  uid: number,
  label: string = PLIST_LABEL
): Promise<LaunchctlResult> {
  return runLaunchctl(["print", gpuiDomainTarget(uid, label)]);
}
