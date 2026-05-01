import { readFileSync } from "node:fs";
import { bridgePaths, DEFAULT_HOST, DEFAULT_PORT } from "./paths.js";
import {
  isReasoningEffort,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort
} from "./openai-types.js";

export interface BridgeConfig {
  host: string;
  port: number;
  localApiKey: string;
  zedUserAgent: string;
  zedVersion: string;
  reasoningEffort: ReasoningEffort;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const portRaw = env.ZED_BRIDGE_PORT;
  const port =
    portRaw && portRaw.length > 0 ? Number(portRaw) : DEFAULT_PORT;
  const host = env.ZED_BRIDGE_HOST ?? DEFAULT_HOST;
  const paths = bridgePaths(env);

  const apiKey =
    env.ZED_BRIDGE_API_KEY ??
    readLocalApiKey(paths.localApiKey) ??
    "sk-zed-local-dev";

  return {
    host,
    port,
    localApiKey: apiKey,
    zedUserAgent: env.ZED_USER_AGENT ?? "Zed/0.228.0",
    zedVersion: env.ZED_VERSION ?? "0.228.0",
    reasoningEffort: parseReasoningEffort(env.ZED_REASONING_EFFORT)
  };
}

function parseReasoningEffort(raw: string | undefined): ReasoningEffort {
  if (raw === undefined || raw.length === 0) return "medium";
  if (isReasoningEffort(raw)) return raw;
  process.stderr.write(
    `zed-bridge: invalid ZED_REASONING_EFFORT="${raw}", expected one of ${REASONING_EFFORT_VALUES.join(
      ", "
    )}; falling back to "medium"\n`
  );
  return "medium";
}

function readLocalApiKey(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
