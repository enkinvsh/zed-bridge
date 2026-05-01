import { spawn } from "node:child_process";

export function notify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const safeTitle = title.replace(/"/g, "'");
  const safeMessage = message.replace(/"/g, "'");
  const script = `display notification "${safeMessage}" with title "${safeTitle}"`;
  try {
    const proc = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true
    });
    proc.unref();
  } catch {
    return;
  }
}
