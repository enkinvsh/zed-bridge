import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ServerHandler } from "./server.js";

export function nodeRequestToWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (typeof v === "string") {
      headers.set(k, v);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
    init.body = body;
  }
  return new Request(url.toString(), init);
}

export async function writeWebResponseToNode(
  webRes: Response,
  nodeRes: ServerResponse
): Promise<void> {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    nodeRes.setHeader(key, value);
  });
  if (!webRes.body) {
    nodeRes.end();
    return;
  }
  const reader = webRes.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        if (!nodeRes.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => nodeRes.once("drain", () => resolve()));
        }
      }
    }
    nodeRes.end();
  } catch (err) {
    try {
      nodeRes.destroy(err as Error);
    } catch {
      nodeRes.end();
    }
  }
}

export function makeNodeListener(handler: ServerHandler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const webReq = nodeRequestToWebRequest(req);
      const webRes = await handler(webReq);
      await writeWebResponseToNode(webRes, res);
    } catch (err) {
      try {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: { message: `internal: ${(err as Error).message}` }
          })
        );
      } catch {
        try {
          res.end();
        } catch {}
      }
    }
  };
}
