import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgePaths {
  stateDir: string;
  llmTokenJson: string;
  internalSecret: string;
  localApiKey: string;
  daemonLog: string;
  pidFile: string;
  plistPath: string;
  opencodeConfig: string;
}

export const PLIST_LABEL = "com.zed-bridge.daemon";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8788;

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZED_BRIDGE_STATE_DIR;
  if (override && override.length > 0) return override;
  const home = env.HOME ?? homedir();
  return join(home, ".config", "zed-bridge", "state");
}

export function defaultPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  return join(home, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

export function defaultOpencodeConfigPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const home = env.HOME ?? homedir();
  return join(home, ".config", "opencode", "opencode.json");
}

export function bridgePaths(env: NodeJS.ProcessEnv = process.env): BridgePaths {
  const stateDir = defaultStateDir(env);
  return {
    stateDir,
    llmTokenJson: join(stateDir, "llm-token.json"),
    internalSecret: join(stateDir, "internal-secret"),
    localApiKey: join(stateDir, "local-api-key"),
    daemonLog: join(stateDir, "daemon.log"),
    pidFile: join(stateDir, "pid"),
    plistPath: defaultPlistPath(env),
    opencodeConfig: defaultOpencodeConfigPath(env)
  };
}
