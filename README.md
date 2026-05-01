# zed-bridge

Тащит твой платный аккаунт **Zed AI** в [opencode](https://github.com/sst/opencode). Залогинился один раз — дальше работает само, токены обновляются автоматически.

> **Без приукрашиваний.** Это reverse-engineered интеграция с приватным `cloud.zed.dev`. Может сломаться от любого апдейта Zed. Только `gpt-5.5`. Только macOS. Аккаунт твой — за соблюдение ToS отвечаешь сам.

## За 30 секунд

```sh
npm i -g zed-bridge
zed-bridge init                       # ставит daemon, патчит opencode.json
zed-bridge login                      # откроет браузер → залогинься в Zed
opencode run -m zed/gpt-5.5 "пинг"
```

Всё.

## Как это работает

```
opencode  ─►  daemon (127.0.0.1:8788)
                │
                ├─ хранит твои account creds в state/account.json (chmod 0600)
                ├─ при близком expiry или 401 минтит свежий JWT
                │  через cloud.zed.dev/client/llm_tokens
                └─ переводит Zed Responses-API в OpenAI Chat Completions
                   (стрим тоже)
```

Никакой телеметрии. Все запросы только в `cloud.zed.dev`.

## Команды

| | |
|---|---|
| `zed-bridge init` | Поставить daemon в launchd, прописать провайдера в `opencode.json` (с бэкапом) |
| `zed-bridge login` | Браузер → авторизация Zed → токен сохраняется локально |
| `zed-bridge token` | Ручной fallback: ввести `userId` и plaintext envelope руками |
| `zed-bridge status` | Что есть, JWT TTL, всё ли подключено |
| `zed-bridge logs` | `tail -f` daemon log |
| `zed-bridge start` / `stop` / `restart` | Обёртки над `launchctl` |
| `zed-bridge uninstall` | Снять daemon, откатить `opencode.json` из бэкапа |
| `zed-bridge watch` | Power-user: mitm-capture, см. ниже |

## Reasoning level

Zed `gpt-5.5` поддерживает четыре уровня reasoning: `low`, `medium`, `high`, `xhigh`. По дефолту в Zed-каталоге у этой модели `medium`; `xhigh` — самый дорогой.

По дефолту daemon шлёт `medium`. Переопределить можно двумя способами.

**На весь daemon (через env):**

```sh
ZED_REASONING_EFFORT=high zed-bridge restart
```

Если значение невалидное — daemon напечатает warning в stderr и откатится на `medium`. После `init` переменная попадает в plist только если она была выставлена в shell на момент `init`.

**На один запрос (через выбор модели):**

`init` прописывает в `opencode.json` пять отдельных моделей. Хочешь high — `opencode run -m zed/gpt-5.5-high "..."`. Доступны:

```sh
opencode run -m zed/gpt-5.5        "..."   # дефолт daemon'а (обычно medium)
opencode run -m zed/gpt-5.5-low    "..."   # быстрее/дешевле
opencode run -m zed/gpt-5.5-medium "..."
opencode run -m zed/gpt-5.5-high   "..."   # высокий уровень
opencode run -m zed/gpt-5.5-xhigh  "..."   # максимальный
```

Под капотом все пять идут в один и тот же upstream `gpt-5.5` — суффикс лишь подменяет `reasoning.effort`. Это сделано потому, что флаг `--model` у opencode для openai-compatible провайдеров не принимает синтаксис `model#variant` или `model/variant` — варианты остаются невидимыми. Простые отдельные id работают.

Если вызываешь bridge напрямую через HTTP — положи `"reasoning_effort": "high"` в тело `POST /v1/chat/completions`, daemon валидирует и пробрасывает (имеет приоритет над суффиксом модели и над daemon-default).

Backward-compat: запрос без `reasoning_effort` к плоской `gpt-5.5` ведёт себя ровно как раньше — берётся daemon-default (`medium`).

## Инструменты (tool calls)

С v0.2.3 daemon прозрачно пробрасывает `tools` / `tool_choice` / `parallel_tool_calls` из OpenAI Chat Completions в Zed Responses API и обратно. Стрим тоже: `tool_calls` дельты идут как настоящие `delta.tool_calls[…]` чанки, а не сырая `<tool_use …>` XML-эмуляция в тексте.

Это значит — opencode-агенты (Atlas, Sisyphus, любые с `bash`/`grep`/`glob`/`skill`/etc.) теперь работают как и должны, ничего настраивать не нужно. Запросы без `tools` ведут себя ровно как в v0.2.2.

## Если ты за VPN

`cloud.zed.dev` иногда требует прокси. Перед `init`:

```sh
HTTPS_PROXY=http://твой.прокси:порт zed-bridge init
```

Прокси сохранится в plist daemon'а. Поменять — отредактируй plist + `zed-bridge restart`.

## Где что лежит

| | |
|---|---|
| Daemon | launchd job `com.zed-bridge.daemon` |
| Account creds | `~/.config/zed-bridge/state/account.json` (0600) |
| JWT cache | `~/.config/zed-bridge/state/llm-token.json` (0600) |
| Local API key | `~/.config/zed-bridge/state/local-api-key` (0600) |
| Логи | `~/.config/zed-bridge/state/daemon.log` |
| Бэкапы opencode.json | `~/.config/opencode/opencode.json.bak.zed-bridge.<ts>` |

## Если что-то сломалось

| Симптом | Что делать |
|---|---|
| opencode выдаёт 401 | `zed-bridge login` — account creds истекли |
| `daemon down` в `status` | `zed-bridge start` |
| `connection refused` на `8788` | `launchctl list \| grep zed-bridge` — должен быть PID |
| Стрим висит | `zed-bridge logs` + проверь VPN до `cloud.zed.dev` |
| Хочется чистого старта | `zed-bridge uninstall` → `init` снова |

## Ошибки и что они значат

С v0.2.4 daemon классифицирует ошибки `cloud.zed.dev` и отдаёт opencode чистый OpenAI-совместимый ответ. Никаких `[retrying in 3s attempt #5]` спамов на терминальные ошибки.

| HTTP | `error.code` | Что это значит | Что делать |
|---|---|---|---|
| `402` | `credits_exhausted` | Кредиты Zed на твоём текущем плане кончились (`token_spend_limit_reached`). | Жди следующего расчётного периода или апгрейдни план Zed. Retry не поможет. |
| `401` | — | LLM JWT просрочен или невалиден. | Daemon обновляет сам за один retry. Если повторяется снова и снова — `zed-bridge login`. |
| `403` | `forbidden` | Cloud refused, причина непонятная. | Скорее всего твой аккаунт ограничен; проверь Zed dashboard. |
| `400` | `bad_request` | Cloud не понял форму запроса (`failed to parse OpenAI Responses API request: ...`). | Это баг zed-bridge — открой issue, приложи `zed-bridge logs`. |
| `502` | `upstream_unavailable` / `unknown` | `cloud.zed.dev` 5xx или сеть отвалилась (VPN?). | Подожди / проверь сеть. Это transient — opencode сам ретрайнет. |

Сообщения в `error.message` короткие, ASCII-friendly, безопасны для любого терминала. Ни Bearer-токены, ни Authorization-хедеры, ни JWT никогда не попадают в текст ошибки — всегда `<redacted>`.

> **Заметка про retry-policy.** Мы не переопределяем поведение AI-SDK (или любого другого клиента). По дефолту AI-SDK не ретрайнет 4xx (включая 402/403/400) и ретрайнет 5xx. Это ровно то, что нам нужно: терминальные ошибки видны сразу, transient retried прозрачно.

## Privacy

Ни телеметрии, ни phone-home, ни аналитики. Логи только локальные. Сами токены никогда в логи не печатаются — только `first4…last4`.

## Чего НЕ умеет

- Только `gpt-5.5`. Никаких Claude/Gemini/других.
- Только macOS. Linux — best-effort, не упаковано.
- Account creds лежат на диске в plaintext под `0600`. Для одного юзера на ноутбуке норма; для shared машины — не используй.
- Если Zed отзовёт твой access token (например ты разлогинился в Zed.app) — auto-refresh упадёт, нужен новый `zed-bridge login`.

## Power-user: mitm capture (запасной путь)

Если mint endpoint когда-то сломается, есть запасной вариант — выдёргивать свежий Bearer из реального трафика Zed.app:

```sh
brew install mitmproxy            # один раз
zed-bridge watch                  # запускает mitmdump на 127.0.0.1:8082
HTTPS_PROXY=http://127.0.0.1:8082 /Applications/Zed.app/Contents/MacOS/Zed
# в Zed → AI → любой prompt → daemon ловит токен из трафика
```

Не нужно для нормальной работы. Только если основной путь умрёт.

## Спасибо

- [`yukmakoto/zed2api`](https://github.com/yukmakoto/zed2api) — эталонная реализация native_app_signin OAuth flow.
- [`lhpqaq/all2api`](https://github.com/lhpqaq/all2api) — за подсказку что в Authorization идёт **весь plaintext envelope**, а не inner token. Это и был тот самый баг v0.1.0.

## Лицензия

MIT.
