# zed-bridge v1 design

Date: 2026-05-01

## Goal

Public, npm-installable CLI that lets any opencode user run their own paid Zed AI account against `gpt-5.5` from inside opencode, without manually editing config or opening Proxyman every time.

Distribution target: `npm i -g zed-bridge`. macOS first.

## Non-goals (v1)

- No Anthropic / Claude provider. Only `gpt-5.5`.
- No `gpt-5.4`, no other open_ai variants. One model, one job.
- No `native_app_signin` flow (we proved it returns invalid tokens).
- No multi-user, no cloud, no telemetry.
- No Linux first-class support. Best-effort only, hidden behind a flag.
- No opencode plugin packaging. We register as a custom OpenAI-compatible provider in `opencode.json`.

## Core architecture

```
opencode  ──Bearer sk-zed-local──▶  zed-bridge daemon (127.0.0.1:8788)
                                          │
                                          ├─ LlmTokenStore   (~/.config/zed-bridge/state/llm-token.json, mode 0600)
                                          ├─ Internal API    (POST /_internal/zed-token, X-Internal-Secret)
                                          └─ ZedClient       ──HTTPS──▶ cloud.zed.dev/completions
                                                                          (Bearer JWT, x-zed-* headers,
                                                                           OpenAI Responses-API body shape,
                                                                           NDJSON SSE, gpt-5.5 only)

User (one of):
   paste:  zed-bridge token         → writes JWT to LlmTokenStore
   watch:  zed-bridge watch         → mitm addon pushes JWT via internal endpoint
```

The daemon exposes the same OpenAI Chat Completions surface that already exists in `zed-opencode-proxy`: `/v1/models`, `/v1/chat/completions` (stream and non-stream).

## CLI shape

```
zed-bridge init       # one-time:
                      #   * generate local API key
                      #   * write provider into ~/.config/opencode/opencode.json (with .bak)
                      #   * install launchd plist
                      #   * start daemon
                      # idempotent: re-running is safe

zed-bridge token      # interactive paste:
                      #   * prints "open Zed → Proxyman → cloud.zed.dev → Authorization: Bearer ..."
                      #   * reads from stdin / --token / ZED_LLM_TOKEN
                      #   * writes to LlmTokenStore via internal endpoint

zed-bridge status     # daemon up? token present? token age? expires_in (parsed from JWT exp)?
                      # last completion timestamp? last error?

zed-bridge logs       # tail -f daemon logs

zed-bridge stop       # stop launchd job
zed-bridge start      # start launchd job
zed-bridge restart

zed-bridge uninstall  # stop launchd, remove plist, restore opencode.json from .bak,
                      # OFFER (not auto) to delete state dir

# Power-user mode:
zed-bridge watch      # check mitmproxy installed → if not, error with brew hint
                      # detect upstream HTTPS proxy from system / clash / env
                      # run mitmdump in foreground with our addon
                      # captured token POSTed to daemon's internal endpoint
                      # macOS notification on success
```

## Auth strategy: paste-by-default

For a public tool the realistic UX is:

1. User runs `zed-bridge init` once. Done.
2. When token is absent or expired (daemon detects 401 from cloud.zed.dev):
   - return a clear OpenAI-compatible 401 to opencode with body
     `"Run zed-bridge token to refresh."`
   - emit macOS notification: *zed-bridge: paste a fresh Zed Bearer token*.
3. User: opens Proxyman/Charles/whatever, copies token, runs `zed-bridge token`, pastes, Enter.
4. Daemon resumes. opencode just retries.

`watch` mode exists as a documented power feature for users who already do MITM and want zero-touch refresh.

We do not ship an installer for mitmproxy CA trust. We document it.

## Config locations

- State dir: `${XDG_STATE_HOME:-~/.local/state}/zed-bridge/` on Linux, `~/.config/zed-bridge/state/` on macOS (consistent with opencode style).
  - `llm-token.json` (mode 0600) — same shape as today.
  - `internal-secret` (mode 0600) — 32-byte hex.
  - `daemon.log` — rotated by launchd.
  - `pid` — for status checks.
- launchd plist: `~/Library/LaunchAgents/com.zed-bridge.daemon.plist`.
- Local API key: stored in state dir, written into the opencode provider block by `init`.

## Data flow (chat completion)

1. opencode → `POST http://127.0.0.1:8788/v1/chat/completions` with `Authorization: Bearer <local-api-key>`, body OpenAI Chat Completions (string or array content).
2. Daemon validates local API key and request shape (validator already supports array content).
3. `ZedTokenManager.getToken()` returns cached JWT.
4. `ZedClient.streamCompleteChat`:
   - maps to Zed Responses-API body (input_text/output_text parts, reasoning effort medium, tools=[], parallel_tool_calls=false, prompt_cache_key=thread_id)
   - sends to `https://cloud.zed.dev/completions` with the verified header set
   - streams back upstream NDJSON
   - on 401 → token store cleared, opencode-facing error includes the `zed-bridge token` hint
5. Stream is transformed to OpenAI SSE chat.completion.chunk frames; non-stream branch aggregates the same way.

## Daemon process management

We use launchd KeepAlive. The daemon is a tiny Bun process (no Node deps), restarted on crash. Logs go through `StandardOutPath`/`StandardErrorPath`. `init` checks if Bun is installed and prints a clear error with `brew install oven-sh/bun/bun` if not.

`zed-bridge` CLI is not the daemon. CLI either (a) talks to the daemon over the local API key for status/health/internal endpoints, or (b) controls launchd via `launchctl`.

## opencode.json patching

`init` performs a minimal patch:

```jsonc
{
  "provider": {
    "zed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Zed",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "<random per-install local key>"
      },
      "models": {
        "gpt-5.5": { "name": "GPT-5.5 (Zed)" }
      }
    }
  }
}
```

Rules:
- always create `opencode.json.bak.zed-bridge.<ts>` first
- only insert/overwrite the `provider.zed` key
- never reorder/remove other keys
- on `uninstall`: remove `provider.zed` and offer to restore from latest `.bak`

We use `zed/gpt-5.5` model id externally (familiar from current proxy). Internally upstream model id is also `gpt-5.5`. Provider key is just `zed` (clean, since user only has one).

So opencode usage becomes:

```
opencode run -m zed/gpt-5.5 "..."
```

## Protection of the local endpoint

- bind to `127.0.0.1` only
- `Authorization: Bearer <local-api-key>` for the OpenAI surface
- `X-Internal-Secret` (constant-time compare) for `_internal/zed-token`
- secret + state files mode 0600
- never log Authorization or token values; redact in errors

## Telemetry / privacy

None. No phone-home. No analytics. README states explicitly. Logs are local, contain no token material.

## Failure modes & UX

| Symptom | What user sees |
|---|---|
| Daemon not running | CLI: clear "daemon down, run `zed-bridge start`". |
| Token missing | opencode: `401 zed-bridge: no token, run \`zed-bridge token\``. macOS notif. |
| Token expired (upstream 401) | Cleared from store. opencode 401 with hint. macOS notif. |
| Upstream 5xx | Bubble up as 502 to opencode with sanitized body. |
| cloud.zed.dev unreachable | Bubble up; suggest `HTTPS_PROXY` env var. |
| `init` cannot write opencode.json | Print exact path and permission diff; do not silently continue. |
| Already-installed re-`init` | Detect, do nothing destructive, print current status. |

## Testing

- TDD on every module, port over from `zed-opencode-proxy` test suite.
- Real-network smoke test: `bun run smoke` reads `ZED_LLM_TOKEN` from env, sends real `pong` request, expects 200 with content. Documented optional. Not in default `bun test`.
- Cross-distro: a single Bun build, no native deps. macOS x64+arm64. Linux only as best-effort, hidden in README.

## Distribution

- Repo: GitHub `enkinvsh/zed-bridge` (suggested), MIT.
- Package: `zed-bridge` on npm.
- `bin`: single CLI entry. Daemon shipped as same package, started via `bun run dist/daemon.js`.
- Releases automated through GitHub Actions on tag push.
- Versioning: SemVer. Pin protocol-bumps to minor when `cloud.zed.dev` request shape changes.

## Open questions for v0.2+

- Anthropic provider (`claude-sonnet-4-6`). Different body shape (`messages: [...]` not `input/output_text`), different SSE event names. Add when v1 is stable.
- Auto-mint via `/client/llm_tokens`: only revisit if Zed changes account-token semantics or our previous 401 was account-state-specific.
- Linux first-class: needs libsecret/Bitwarden alt for token storage and a systemd unit instead of launchd.
- TUI live status (`zed-bridge` no args → live dashboard).

## Risks documented in README

- Unofficial reverse-engineered integration with `cloud.zed.dev/completions`. Format may change without warning. Each release pins protocol version.
- Likely violates Zed ToS. User accepts responsibility.
- Tokens are stored in plaintext on local disk (mode 0600). Acceptable for single-user macOS workstation; not for shared machines.
