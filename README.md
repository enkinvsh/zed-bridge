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

**На один запрос (через opencode variants):**

`init` прописывает в `opencode.json` четыре варианта `gpt-5.5` — `low`, `medium`, `high`, `xhigh`:

```sh
opencode run -m zed/gpt-5.5 --variant high  "..."   # высокий уровень
opencode run -m zed/gpt-5.5 --variant xhigh "..."   # максимальный
opencode run -m zed/gpt-5.5 --variant low   "..."   # быстрее/дешевле
opencode run -m zed/gpt-5.5 "..."                   # дефолт daemon'а
```

Точная форма флага у разных версий opencode чуть разная (`--variant`, либо хоткей `variant_cycle` в TUI). Если вызываешь bridge напрямую через HTTP — просто положи `"reasoning_effort": "high"` в тело `POST /v1/chat/completions`, daemon валидирует и пробрасывает.

Backward-compat: запрос без `reasoning_effort` ведёт себя ровно как раньше — берётся daemon-default (`medium`).

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
