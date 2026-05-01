# zed-bridge — archived

> **Use [`lhpqaq/all2api`](https://github.com/lhpqaq/all2api) instead.** It is MIT-licensed, actively maintained, supports the same use case (OpenAI/Anthropic-compatible gateway in front of `cloud.zed.dev`), implements the native sign-in OAuth flow, automatic token refresh, multi-account, multiple models (Claude, GPT-5.x, Gemini, Grok), and runs on macOS / Linux / Windows / Docker.
>
> See also: [`yukmakoto/zed2api`](https://github.com/yukmakoto/zed2api) (Zig single-binary, larger ecosystem) and [`KorigamiK/opencode-zed-auth`](https://github.com/KorigamiK/opencode-zed-auth) (native opencode plugin).

## What this was

A small local proxy that let [opencode](https://github.com/sst/opencode) use a paid Zed AI account against `gpt-5.5`. v0.1.0 had a working daemon, OpenAI-compatible streaming, manual paste auth, and an optional mitm-based auto-capture mode.

## Why it's archived

After shipping v0.1.0 we surveyed the ecosystem and found multiple mature projects already covering the same surface — including the auto-refresh path we hadn't built yet. Reinventing them would split community effort.

The full landscape and reasoning live in [`docs/plans/2026-05-01-zed-bridge-v1-design.md`](docs/plans/2026-05-01-zed-bridge-v1-design.md) and the git history.

## Salvage value

The reverse-engineered notes in the source might still be useful as a reference:

- `src/zed-client.ts` — the exact Zed cloud Responses-API request shape, headers, and SSE event taxonomy for `gpt-5.5`.
- `src/zed-token.ts`, `src/llm-token-store.ts` — token cache + invalidation.
- `mitm/zed_token_capture.py` — minimal mitmproxy addon that pushes captured Zed bearers to a local endpoint.
- `src/cli/init.ts` — atomic patching of `~/.config/opencode/opencode.json` with a backup.

MIT-licensed if anyone wants to pick pieces.
