#!/usr/bin/env node
import { runInit } from "./cli/init.js";
import { runLogin } from "./cli/login.js";
import { runToken } from "./cli/token.js";
import { runStatus } from "./cli/status.js";
import { runLogs } from "./cli/logs.js";
import { runStart } from "./cli/start.js";
import { runStop } from "./cli/stop.js";
import { runRestart } from "./cli/restart.js";
import { runUninstall } from "./cli/uninstall.js";
import { runWatch } from "./cli/watch.js";

const HELP = `zed-bridge — use your Zed AI account from opencode (gpt-5.5).

USAGE:
  zed-bridge <command> [args]

COMMANDS:
  init                One-time install (state, opencode.json, launchd, daemon).
  login               Browser-based Zed sign-in. Captures account credentials.
  token               Manual fallback: paste the decrypted plaintext envelope + userId.
  status              Show daemon, account, JWT cache, and opencode integration status.
  logs                tail -f the daemon log.
  start               Start the launchd-managed daemon.
  stop                Stop the launchd-managed daemon.
  restart             Restart (kickstart -k).
  uninstall           Stop daemon, remove plist, remove provider.zed from opencode.json.
  watch               Fallback: foreground mitmdump that auto-pushes captured Zed JWTs.
  -h, --help          Show this message.
  -v, --version       Show version.

DOCS:
  https://github.com/zed-bridge/zed-bridge (README)
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write("0.2.1\n");
    return 0;
  }

  switch (cmd) {
    case "init":
      return runInit(rest);
    case "login":
      return runLogin(rest);
    case "token":
      return runToken(rest);
    case "status":
      return runStatus(rest);
    case "logs":
      return runLogs(rest);
    case "start":
      return runStart(rest);
    case "stop":
      return runStop(rest);
    case "restart":
      return runRestart(rest);
    case "uninstall":
      return runUninstall(rest);
    case "watch":
      return runWatch(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  });
