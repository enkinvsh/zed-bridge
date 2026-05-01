import { bridgePaths, PLIST_LABEL } from "../paths.js";
import { bootoutAgent, plistExists } from "../launchd.js";

export async function runStop(argv: string[]): Promise<number> {
  void argv;
  const paths = bridgePaths();
  if (!plistExists(paths.plistPath)) {
    process.stderr.write(
      `error: plist not found at ${paths.plistPath}.\n`
    );
    return 2;
  }
  const uid = process.getuid?.() ?? 501;
  const out = await bootoutAgent(uid, paths.plistPath);
  if (
    out.code !== 0 &&
    !/could not find|no such process|nothing found/i.test(out.stderr)
  ) {
    process.stderr.write(
      `launchctl bootout exit ${out.code}: ${out.stderr.trim()}\n`
    );
    return 1;
  }
  process.stdout.write(`stopped ${PLIST_LABEL}\n`);
  return 0;
}
