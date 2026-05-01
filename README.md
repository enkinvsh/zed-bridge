# zed-bridge

Use your paid Zed AI account from [opencode](https://github.com/sst/opencode) by exposing a tiny local OpenAI-compatible proxy that talks to `cloud.zed.dev` on your behalf.

> **Honest caveats.** This is an unofficial, reverse-engineered integration. The `cloud.zed.dev/completions` protocol is **not** a public API and may change without warning. Only `gpt-5.5` is supported. macOS only. You are responsible for complying with Zed's Terms of Service.

## 30-second quickstart

```sh
npm i -g zed-bridge
zed-bridge init
zed-bridge token       # paste a Zed Bearer JWT (see "Getting a token")
opencode run -m zed/gpt-5.5 "say pong"
```

That's it. From now on, opencode talks to your local daemon, and the daemon forwards to Zed using your token.

## How it works

```
opencode  ──Bearer sk-zed-local──▶  zed-bridge daemon (127.0.0.1:8788)
                                          │
                                          ├─ token store (~/.config/zed-bridge/state, mode 0600)
                                          └─ ZedClient ──HTTPS──▶ cloud.zed.dev/completions
                                                                  (Bearer JWT, OpenAI Responses-API shape,
                                                                   gpt-5.5 only)
```

The daemon is a small Node ≥20 process managed by `launchd`. opencode sees a normal OpenAI Chat Completions endpoint at `http://127.0.0.1:8788/v1`.

## Auth modes

zed-bridge needs a fresh **Zed LLM Bearer JWT** to talk to `cloud.zed.dev`. There are two ways to give it one:

### Paste mode (default)

1. Open Zed, then any HTTPS interceptor you like (Proxyman, Charles, Wireshark with Zed's certificate, etc.) and capture a request from Zed to `cloud.zed.dev`.
2. Copy the value of the `Authorization: Bearer <jwt>` header.
3. Run `zed-bridge token`. Paste, hit Enter.

When the token expires (typically a few hours), opencode will get a 401 from the daemon. Just run `zed-bridge token` again.

### Watch mode (power user, optional)

If you already run [mitmproxy](https://mitmproxy.org/) for Zed, run:

```sh
brew install mitmproxy   # one-time
zed-bridge watch         # runs mitmdump in foreground; auto-pushes captured tokens
```

Configure Zed (or your system) to use `127.0.0.1:8082` as its HTTPS proxy. With mitmproxy's CA installed, every Zed-issued request will refresh the bridge automatically.

## Getting a token

The simplest path is Proxyman:

1. Install Proxyman, run it, install its certificate in macOS Keychain (System), and trust it.
2. In Proxyman, enable SSL Proxying for `cloud.zed.dev`.
3. Open Zed, send any AI message.
4. In Proxyman, find the request to `cloud.zed.dev/completions`. Copy the `Authorization: Bearer ...` value.
5. `zed-bridge token`, paste, Enter.

## Commands

| Command | What it does |
| --- | --- |
| `zed-bridge init` | One-time install. Generates a per-install local API key, patches `~/.config/opencode/opencode.json` with `provider.zed`, writes a launchd plist, starts the daemon. Idempotent; always backs up `opencode.json` first. |
| `zed-bridge token` | Reads a Zed Bearer JWT from `--token`, `ZED_LLM_TOKEN`, or stdin. Validates JWT shape, strips `Bearer ` prefix, persists to `state/llm-token.json` (mode 0600). Never echoes the token. |
| `zed-bridge status` | Daemon up? Token present and not expired? Is `provider.zed` correctly wired in opencode.json? Exit 0 if all good, 1 otherwise. |
| `zed-bridge logs` | `tail -f` the daemon log. |
| `zed-bridge start` / `stop` / `restart` | Control the launchd job. |
| `zed-bridge uninstall` | Stop + remove the launchd job, remove `provider.zed` from opencode.json. **Does not delete state**; prints how. |
| `zed-bridge watch` | Foreground `mitmdump` with the bundled token-capture addon. |

## Config & paths

| Path | Purpose |
| --- | --- |
| `~/.config/zed-bridge/state/llm-token.json` | Cached Zed Bearer JWT (mode 0600). |
| `~/.config/zed-bridge/state/internal-secret` | 32-byte hex shared secret protecting the `_internal/zed-token` endpoint (mode 0600). |
| `~/.config/zed-bridge/state/local-api-key` | Per-install random `sk-zed-...` key opencode uses to talk to the daemon (mode 0600). |
| `~/.config/zed-bridge/state/daemon.log` | launchd-captured stdout/stderr. |
| `~/Library/LaunchAgents/com.zed-bridge.daemon.plist` | The launchd plist. |
| `~/.config/opencode/opencode.json` | Patched with `provider.zed`. Backups: `opencode.json.bak.zed-bridge.<unix-ms>`. |

Environment overrides (read by the daemon, set in the plist by `init`):

| Var | Default |
| --- | --- |
| `ZED_BRIDGE_HOST` | `127.0.0.1` |
| `ZED_BRIDGE_PORT` | `8788` |
| `ZED_BRIDGE_STATE_DIR` | `~/.config/zed-bridge/state` |
| `HTTPS_PROXY` / `https_proxy` | unset; if set, the daemon dials `cloud.zed.dev` through it. |

If your network needs an HTTPS proxy to reach `cloud.zed.dev`, export `HTTPS_PROXY=http://127.0.0.1:7890` (or whatever) **before** running `zed-bridge init`. The plist will pick it up. To change it later: edit the plist, then `zed-bridge restart`.

## Privacy

No telemetry. No phone-home. No analytics. Logs are local and never contain raw token material (only `first4...last4` shape).

## Known limits

- macOS only. Linux best-effort, not packaged.
- Only `gpt-5.5`. No Anthropic / Claude. No `gpt-5.4`.
- Tokens expire (typically a few hours). You'll need to re-paste; we surface a clear error.
- No automatic OAuth. There is no clean public re-auth path; the closest thing is manual paste or system-wide MITM.
- Tokens are stored in plaintext on local disk (mode 0600). Acceptable for a single-user macOS workstation; not for shared machines.

## License

MIT.
