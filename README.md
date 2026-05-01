# zed-bridge

Use a paid Zed AI account from [opencode](https://github.com/sst/opencode) against `gpt-5.5`. v0.2.0 ships true auto-refreshing LLM JWTs: account credentials live for months, the daemon mints fresh short-lived JWTs from `cloud.zed.dev/client/llm_tokens` on demand and re-mints transparently on 401 or near expiry.

## Quickstart

```sh
git clone <this repo> && cd zed-bridge
npm install
npm run build
node dist/cli.js init      # one-time install (state, opencode.json, launchd, daemon)
node dist/cli.js login     # browser sign-in via native_app_signin
opencode run -m zed/gpt-5.5 'Reply with: pong'
```

## Commands

| Command | What it does |
|---|---|
| `init` | Provision state, write `~/.config/opencode/opencode.json` `provider.zed`, install launchd plist, start daemon. |
| `login` | Browser flow: launches `https://zed.dev/native_app_signin`, RSA-decrypts the callback, persists `userId + plaintext envelope` and pushes them to the daemon. |
| `token` | Manual fallback: `--user-id <id> --plaintext '<JSON envelope>'`. |
| `status` | Daemon health, account credentials, JWT cache (with TTL), opencode wiring. |
| `start` / `stop` / `restart` / `logs` / `uninstall` | launchd lifecycle + tail log. |
| `watch` | **Fallback only.** Foreground `mitmdump` that captures live LLM JWTs from a real Zed app. See below. |

## Auth flow

1. `zed-bridge login` opens `https://zed.dev/native_app_signin` with a one-shot RSA pubkey + local callback port.
2. Zed POSTs an RSA-OAEP-SHA256-encrypted payload back. We decrypt and store the JSON envelope **as-is** (`{"version":2,"id":"client_token_...","token":"..."}`) under `<state>/account.json`, mode 0600.
3. Daemon mints LLM JWTs by `POST https://cloud.zed.dev/client/llm_tokens` with `Authorization: <userId> <full plaintext envelope>` and `body: {}`. Response: `{"token":"eyJ...","expires_at":...}`.
4. JWTs are cached at `<state>/llm-token.json` with parsed `exp`. Re-minted when within `refreshLeadMs` (default 60 s) of expiry, or on any 401 from `/completions`.
5. On 401 from the mint endpoint itself, the cached account creds are wiped and a clear `re-auth` error is surfaced.

## Why `<userId> <plaintext>` and not just the inner token

`v0.1.0` extracted the inner `token` field from the envelope and stored it. That fails — the mint endpoint requires the **full plaintext envelope** verbatim as the bearer credential. v0.2.0 stores it untouched. Confirmed empirically against `cloud.zed.dev` and matches what [`lhpqaq/all2api`](https://github.com/lhpqaq/all2api) does (they store the same `<userId> <plaintext>` as a single space-separated string under `auth.token`; same data, structured form here).

## Files

| Path | Purpose |
|---|---|
| `<state>/account.json` | `{userId, plaintext, source, savedAt}`, mode 0600. Long-lived. |
| `<state>/llm-token.json` | `{token, expiresAt, savedAt, source}`, mode 0600. Short-lived; auto-minted. |
| `<state>/internal-secret` | Constant-time-checked secret guarding `_internal/*` endpoints, mode 0600. |
| `<state>/local-api-key` | Bearer required by opencode → daemon, mode 0600. |
| `<state>/daemon.log` | launchd-redirected stdout/stderr. |
| `~/Library/LaunchAgents/com.zed-bridge.daemon.plist` | launchd unit. |
| `~/.config/opencode/opencode.json` | `provider.zed` block; backed up before patching. |

`<state>` defaults to `~/.config/zed-bridge/state`, override with `ZED_BRIDGE_STATE_DIR`.

## Internal endpoints (loopback, secret-gated)

| Endpoint | Body | Use |
|---|---|---|
| `POST /_internal/zed-account` | `{userId, plaintext, source: "manual" \| "login"}` | Replace account creds, clear JWT cache. Used by `login` and `token`. |
| `POST /_internal/zed-token` | `{token, source: "manual" \| "mitm"}` | Inject a pre-minted LLM JWT. Used by `watch` (mitm) only. |

Both require `X-Internal-Secret` (constant-time compare) and 404 when not configured.

## Fallback: mitm capture (`watch`)

For environments where `native_app_signin` doesn't work (sandboxed, no browser, custom Zed builds), capture live LLM JWTs from the real Zed app:

```sh
brew install mitmproxy
node dist/cli.js watch --port 8082
# Configure Zed to use http://127.0.0.1:8082 as HTTPS proxy and trust mitm CA.
```

Captured JWTs are pushed to `_internal/zed-token`. They expire in ~1h and are NOT auto-renewed by this path — for auto-refresh, use `login`.

## Privacy & security

- Account plaintext and LLM JWTs never appear in logs, errors, or stdout — only `first4...last4` shape + length.
- All state files are created with mode 0600; state dir is 0700.
- HTTPS_PROXY env propagates to upstream `cloud.zed.dev` calls (mint + completions both go through the proxy when set).
- The `_internal/*` endpoints use constant-time secret comparison.

## Limits

- macOS only (launchd, `open` for sign-in).
- Single model: `gpt-5.5` (also accepts `zed/gpt-5.5` from opencode).
- One Zed account at a time. Multi-account is out of scope; use [`lhpqaq/all2api`](https://github.com/lhpqaq/all2api) if you need that.
