import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bridgePaths, PLIST_LABEL } from "../paths.js";
import { bootoutAgent } from "../launchd.js";
import { removeZedProvider, type OpencodeFs } from "../opencode-config.js";

export async function runUninstall(argv: string[]): Promise<number> {
  void argv;
  const paths = bridgePaths();
  const uid = process.getuid?.() ?? 501;
  if (existsSync(paths.plistPath)) {
    await bootoutAgent(uid, paths.plistPath);
    try {
      await unlink(paths.plistPath);
      process.stdout.write(`removed plist ${paths.plistPath}\n`);
    } catch (err) {
      process.stderr.write(
        `warn: could not remove plist: ${(err as Error).message}\n`
      );
    }
  }

  const opencodeFs: OpencodeFs = {
    async readFile(p) {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(p, content) {
      await writeFile(p, content);
    },
    async mkdir() {}
  };
  const result = await removeZedProvider({
    path: paths.opencodeConfig,
    fs: opencodeFs
  });
  if (result.removed) {
    process.stdout.write(
      `removed provider.zed from ${paths.opencodeConfig}\n`
    );
  } else {
    process.stdout.write(
      `provider.zed not found in ${paths.opencodeConfig} (nothing to remove)\n`
    );
  }

  process.stdout.write(
    `state/ kept at ${paths.stateDir}. delete with: rm -rf ${paths.stateDir}\n`
  );
  process.stdout.write(`uninstalled ${PLIST_LABEL}\n`);
  return 0;
}
