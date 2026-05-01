import { spawn } from "node:child_process";
import { bridgePaths } from "../paths.js";

export async function runLogs(argv: string[]): Promise<number> {
  void argv;
  const paths = bridgePaths();
  const proc = spawn("tail", ["-f", paths.daemonLog], {
    stdio: "inherit"
  });
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", (err) => {
      process.stderr.write(`tail failed: ${err.message}\n`);
      resolve(1);
    });
  });
}
