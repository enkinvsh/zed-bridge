import { bridgePaths, PLIST_LABEL } from "../paths.js";
import {
  bootstrapAgent,
  kickstartAgent,
  plistExists
} from "../launchd.js";

export async function runStart(argv: string[]): Promise<number> {
  void argv;
  const paths = bridgePaths();
  if (!plistExists(paths.plistPath)) {
    process.stderr.write(
      `error: plist not found at ${paths.plistPath}. Run \`zed-bridge init\` first.\n`
    );
    return 2;
  }
  const uid = process.getuid?.() ?? 501;
  const bootstrap = await bootstrapAgent(uid, paths.plistPath);
  if (
    bootstrap.code !== 0 &&
    !/already loaded|service already loaded/i.test(bootstrap.stderr)
  ) {
    process.stderr.write(
      `launchctl bootstrap exit ${bootstrap.code}: ${bootstrap.stderr.trim()}\n`
    );
  }
  const kick = await kickstartAgent(uid, PLIST_LABEL);
  if (kick.code !== 0) {
    process.stderr.write(
      `launchctl kickstart exit ${kick.code}: ${kick.stderr.trim()}\n`
    );
    return 1;
  }
  process.stdout.write(`started ${PLIST_LABEL}\n`);
  return 0;
}
