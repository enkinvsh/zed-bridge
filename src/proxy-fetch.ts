import { ProxyAgent, type Dispatcher } from "undici";

export interface CreateProxyFetchOpts {
  baseFetch: typeof fetch;
  proxyUrl?: string | null | undefined;
  agentFactory?: (url: string) => Dispatcher;
}

interface UndiciFetchInit extends RequestInit {
  dispatcher?: Dispatcher;
}

export function createProxyFetch(opts: CreateProxyFetchOpts): typeof fetch {
  const { baseFetch, proxyUrl } = opts;
  let dispatcher: Dispatcher | null = null;
  if (proxyUrl) {
    const factory = opts.agentFactory ?? ((u: string) => new ProxyAgent(u));
    dispatcher = factory(proxyUrl);
  }
  const wrapped: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (!dispatcher) {
      return baseFetch(input, init);
    }
    const next: UndiciFetchInit = { ...(init ?? {}) };
    if (next.dispatcher === undefined) {
      next.dispatcher = dispatcher;
    }
    return baseFetch(input, next as RequestInit);
  }) as typeof fetch;
  return wrapped;
}

export interface ProxyEnv {
  HTTPS_PROXY?: string | undefined;
  https_proxy?: string | undefined;
  HTTP_PROXY?: string | undefined;
  http_proxy?: string | undefined;
}

export function pickProxyUrlFromEnv(env: ProxyEnv): string | null {
  const candidates: Array<string | undefined> = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
