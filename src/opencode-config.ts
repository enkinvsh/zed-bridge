export interface OpencodeFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

export interface OpencodeConfigDeps {
  path: string;
  fs: OpencodeFs;
  now?: () => number;
}

export interface OpencodeProviderBlock {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey: string };
  models: Record<string, { name: string }>;
}

export const ZED_PROVIDER_KEY = "zed";

export function buildZedProvider(opts: {
  baseURL: string;
  apiKey: string;
}): OpencodeProviderBlock {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Zed",
    options: {
      baseURL: opts.baseURL,
      apiKey: opts.apiKey
    },
    models: {
      "gpt-5.5": { name: "GPT-5.5 (Zed)" }
    }
  };
}

interface PatchResult {
  patched: string;
  backup: { path: string; content: string } | null;
  changed: boolean;
}

export async function patchOpencodeConfig(
  deps: OpencodeConfigDeps,
  provider: OpencodeProviderBlock
): Promise<PatchResult> {
  const now = (deps.now ?? Date.now)();
  const dir = parentDir(deps.path);
  if (dir.length > 0) {
    await deps.fs.mkdir(dir, { recursive: true });
  }
  const existingRaw = await deps.fs.readFile(deps.path);
  let parsed: Record<string, unknown> = {};
  if (existingRaw !== null) {
    try {
      const o = JSON.parse(existingRaw);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        parsed = o as Record<string, unknown>;
      } else {
        throw new Error(
          `opencode.json at ${deps.path} is not a JSON object; refusing to patch`
        );
      }
    } catch (err) {
      throw new Error(
        `opencode.json at ${deps.path} is not valid JSON: ${(err as Error).message}`
      );
    }
  }

  const providerSection = (parsed["provider"] ?? {}) as Record<string, unknown>;
  if (typeof providerSection !== "object" || Array.isArray(providerSection)) {
    throw new Error("opencode.json 'provider' must be an object");
  }
  const before = JSON.stringify(providerSection[ZED_PROVIDER_KEY] ?? null);
  const after = JSON.stringify(provider);
  const changed = before !== after;

  let backup: { path: string; content: string } | null = null;
  if (existingRaw !== null) {
    const backupPath = `${deps.path}.bak.zed-bridge.${now}`;
    await deps.fs.writeFile(backupPath, existingRaw);
    backup = { path: backupPath, content: existingRaw };
  }

  providerSection[ZED_PROVIDER_KEY] = provider;
  parsed["provider"] = providerSection;

  const patched = JSON.stringify(parsed, null, 2) + "\n";
  await deps.fs.writeFile(deps.path, patched);
  return { patched, backup, changed };
}

export async function removeZedProvider(
  deps: OpencodeConfigDeps
): Promise<{ removed: boolean; content: string | null }> {
  const existingRaw = await deps.fs.readFile(deps.path);
  if (existingRaw === null) {
    return { removed: false, content: null };
  }
  let parsed: Record<string, unknown>;
  try {
    const o = JSON.parse(existingRaw);
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      return { removed: false, content: existingRaw };
    }
    parsed = o as Record<string, unknown>;
  } catch {
    return { removed: false, content: existingRaw };
  }
  const providerSection = parsed["provider"];
  if (
    !providerSection ||
    typeof providerSection !== "object" ||
    Array.isArray(providerSection)
  ) {
    return { removed: false, content: existingRaw };
  }
  const ps = providerSection as Record<string, unknown>;
  if (!(ZED_PROVIDER_KEY in ps)) {
    return { removed: false, content: existingRaw };
  }
  delete ps[ZED_PROVIDER_KEY];
  if (Object.keys(ps).length === 0) {
    delete parsed["provider"];
  } else {
    parsed["provider"] = ps;
  }
  const next = JSON.stringify(parsed, null, 2) + "\n";
  await deps.fs.writeFile(deps.path, next);
  return { removed: true, content: next };
}

export async function readZedProvider(
  deps: OpencodeConfigDeps
): Promise<OpencodeProviderBlock | null> {
  const existingRaw = await deps.fs.readFile(deps.path);
  if (existingRaw === null) return null;
  let parsed: Record<string, unknown>;
  try {
    const o = JSON.parse(existingRaw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    parsed = o as Record<string, unknown>;
  } catch {
    return null;
  }
  const providerSection = parsed["provider"];
  if (
    !providerSection ||
    typeof providerSection !== "object" ||
    Array.isArray(providerSection)
  ) {
    return null;
  }
  const block = (providerSection as Record<string, unknown>)[ZED_PROVIDER_KEY];
  if (!block || typeof block !== "object") return null;
  return block as OpencodeProviderBlock;
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}
