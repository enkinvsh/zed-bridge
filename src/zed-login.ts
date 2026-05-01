import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { spawn } from "node:child_process";
import {
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
  type KeyObject
} from "node:crypto";

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface CallbackPayload {
  userId: string;
  accessToken: string;
}

export interface CallbackServer {
  port: number;
  close: () => Promise<void>;
}

export interface StartCallbackServerOpts {
  onCallback: (payload: CallbackPayload) => Promise<void>;
}

export interface SavedAccount {
  userId: string;
  plaintext: string;
  source: "login";
}

export interface LoginFlowDeps {
  generateKeypair: () => KeyPair;
  startCallbackServer: (opts: StartCallbackServerOpts) => Promise<CallbackServer>;
  openBrowser: (url: string) => Promise<void>;
  saveAccount: (account: SavedAccount) => Promise<void>;
  timeoutMs?: number;
}

export interface LoginResult {
  userId: string;
  plaintext: string;
}

export function buildSignInUrl(opts: {
  port: number;
  publicKeyBase64Url: string;
}): string {
  const params = new URLSearchParams({
    native_app_port: String(opts.port),
    native_app_public_key: opts.publicKeyBase64Url
  });
  return `https://zed.dev/native_app_signin?${params.toString()}`;
}

export function decodePublicKeyBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function exportPublicKeyForZed(key: KeyObject): string {
  const der = key.export({ type: "pkcs1", format: "der" });
  return decodePublicKeyBase64Url(der);
}

export function parseCallbackQuery(pathAndQuery: string): CallbackPayload | null {
  const idx = pathAndQuery.indexOf("?");
  if (idx === -1) return null;
  const params = new URLSearchParams(pathAndQuery.slice(idx + 1));
  const userId = params.get("user_id");
  const accessToken = params.get("access_token");
  if (!userId || !accessToken) return null;
  return { userId, accessToken };
}

function base64UrlToBuffer(s: string): Buffer {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function decryptAccessToken(
  accessTokenB64Url: string,
  privateKey: KeyObject
): string {
  const ciphertext = base64UrlToBuffer(accessTokenB64Url);
  try {
    const out = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      ciphertext
    );
    return out.toString("utf8");
  } catch {}
  const out = privateDecrypt(
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
    ciphertext
  );
  return out.toString("utf8");
}

export function generateNodeKeypair(): KeyPair {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

export async function startNodeCallbackServer(
  opts: StartCallbackServerOpts
): Promise<CallbackServer> {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = req.url ?? "/";
        const payload = parseCallbackQuery(url);
        if (!payload) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain");
          res.end("missing user_id or access_token");
          return;
        }
        try {
          await opts.onCallback(payload);
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            "<!doctype html><html><body><h1>zed-bridge: signed in</h1>" +
              "<p>You can close this tab.</p></body></html>"
          );
        } catch {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain");
          res.end("zed-bridge: failed to persist credentials");
        }
      })();
    }
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("could not determine callback server port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

export async function openWithMacOpen(url: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn("open", [url], { stdio: "ignore" });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

export async function runLoginFlow(deps: LoginFlowDeps): Promise<LoginResult> {
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const { publicKey, privateKey } = deps.generateKeypair();
  const pubB64Url = exportPublicKeyForZed(publicKey);

  let resolved = false;
  let resolver: ((value: LoginResult) => void) | null = null;
  let rejecter: ((reason: Error) => void) | null = null;
  const completion = new Promise<LoginResult>((res, rej) => {
    resolver = res;
    rejecter = rej;
  });

  const server = await deps.startCallbackServer({
    onCallback: async (payload) => {
      if (resolved) return;
      let plaintext: string;
      try {
        plaintext = decryptAccessToken(payload.accessToken, privateKey);
      } catch (err) {
        const e = new Error(
          `Failed to decrypt access_token: ${(err as Error).name || "Error"}`
        );
        resolved = true;
        rejecter!(e);
        return;
      }
      try {
        await deps.saveAccount({
          userId: payload.userId,
          plaintext,
          source: "login"
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        resolved = true;
        rejecter!(new Error(`Failed to save credentials: ${code}`));
        return;
      }
      resolved = true;
      resolver!({ userId: payload.userId, plaintext });
    }
  });

  const signInUrl = buildSignInUrl({
    port: server.port,
    publicKeyBase64Url: pubB64Url
  });
  try {
    await deps.openBrowser(signInUrl);
  } catch {}

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<LoginResult>((_, rej) => {
    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rej(new Error(`Sign-in timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([completion, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await server.close();
    } catch {}
  }
}


