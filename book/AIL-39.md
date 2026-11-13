# 9.5 · MCP-сервер к базе магазина (только чтение)  (AIL-39)

> **Неделя 9** · Агенты · ⏱ ~4–5 ч · Проект

## Зачем это AI-инженеру

MCP (Model Context Protocol) — открытый стандарт подключения инструментов и данных к LLM-клиентам: Claude Desktop, Claude Code, Cursor, IDE и собственным агентам. Сервер пишется один раз, а данные становятся доступны из любого совместимого клиента. Свой MCP-сервер к базе магазина с продуманной моделью безопасности — сильный пункт в резюме и хорошая тема для рассказа на собеседовании.

> ⚠️ **Только чтение.** Никаких функций, которые меняют заказы, оформляют возвраты или выдают промокоды, и никаких запросов к платёжному провайдеру и службе доставки с ключами — только снимок базы, сделанный через `VACUUM INTO`. Сервер не импортирует код приложения магазина, не читает `.env` и не знает ни одного ключа.

## Теория

### Что такое MCP

MCP — это протокол поверх JSON-RPC 2.0 между **клиентом** (живёт внутри host-приложения — Claude Desktop, Claude Code, наш агент) и **сервером** (наша программа, которая предоставляет возможности).

```
┌──────────── Host (Claude Desktop / Claude Code / your agent) ───────────┐
│   LLM  ◄──►  MCP client ──── JSON-RPC over stdio or HTTP ────┐          │
└──────────────────────────────────────────────────────────────┼──────────┘
                                                               ▼
                                          MCP server (your Python process)
                                           ├─ tools:     list_orders, ...
                                           ├─ resources: schema://shop
                                           └─ prompts:   order_postmortem
                                                  │ read-only
                                                  ▼
                                          data/shop.db (snapshot, events inside)
```

Аналогия: MCP для LLM — как LSP для редакторов. Раньше каждый редактор писал поддержку каждого языка; с LSP язык пишет один сервер. Здесь — каждый инструмент пишется один раз и работает во всех клиентах.

### Три примитива сервера

| Примитив | Кто управляет | Что это | Пример у нас |
|---|---|---|---|
| **Tools** | Модель (решает вызвать) | Функции с JSON Schema параметров | `list_orders(status, since, until, limit)` |
| **Resources** | Приложение/пользователь (решает подгрузить) | Данные по URI, как файлы | `schema://shop` — описание таблиц |
| **Prompts** | Пользователь (выбирает шаблон) | Готовые шаблоны запросов с параметрами | `order_postmortem(order_id)` |

Клиенты поддерживают их по-разному: tools есть почти везде, resources и prompts — не везде. Основную функциональность делаем инструментами.

### Транспорты

- **stdio** — клиент запускает сервер как дочерний процесс и общается через stdin/stdout. Для локальных серверов это стандарт: нет порта, нет сети, нет авторизации. Наш случай.
- **Streamable HTTP** — сервер слушает HTTP, клиенты подключаются по сети (удалённые серверы, несколько пользователей). Тогда нужна авторизация (в спецификации описан OAuth). Для базы с заказами и данными покупателей **HTTP-порт наружу не открываем** — stdio закрывает целый класс проблем.

Важная ловушка stdio: **stdout принадлежит протоколу**. Любой `print()` в stdout ломает JSON-RPC. Логи — только в stderr или в файл.

### Минимальный сервер на Python SDK

```python
# server.py — illustrative, check the MCP Python SDK README for the current API
import sqlite3, sys
from mcp.server.fastmcp import FastMCP  # SDK v1 style; in v2: from mcp.server import MCPServer

DB_PATH = "data/shop.db"
mcp = FastMCP("shop-readonly")

def connect() -> sqlite3.Connection:
    # Read-only at the OS/SQLite level: any write fails even if code has a bug
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn

@mcp.tool()
def list_orders(status: str = "all", since: str | None = None,
                until: str | None = None, limit: int = 20) -> list[dict]:
    """List orders from a read-only snapshot of the shop DB.
    ... (full description: see section 'Tool descriptions' below)
    """
    ...

if __name__ == "__main__":
    print("shop MCP starting", file=sys.stderr)  # stderr only, never stdout
    mcp.run()  # stdio transport by default
```

FastMCP строит JSON Schema инструмента из type hints и берёт описание из docstring — так же, как Pydantic-модель в главе 3.2 давала схему для tool calling (а во многих языках похожее делают библиотеки вроде zod).

### Данные: что у нас есть

Работаем только с копиями в папке проекта `data/` (она в `.gitignore`). База та же, что в проекте 1 (AIL-13), но таблиц сервер читает больше:

- **`shop.db`** (живая — в `../shop-live/` рядом с репозиторием; `shop-analytics.db` не нужна). Серверу нужны `orders`, `order_items`, `products`, `payments`, `shipments`, `events`. Таблицу `customers` (имена, email, телефоны) сервер не читает вообще.
- **`events(id, order_id, time, type, message)`** — журнал событий заказа: оплаты, отказ промокода, обновления доставки, отмены. Хранит **30 дней**: по заказам старше честный ответ — «данных недостаточно».

Чтобы было что расследовать, расширяем генератор из главы 3.1: `make_shop_db.py --incidents 20` закладывает 20 проблемных заказов с известной причиной и пишет ответы в `../shop-live/incidents.json`. Причины — из каталога инцидентов проекта 4: `double_charge`, `stuck_in_delivery`, `promo_not_applied`, `refund_not_arrived`, `out_of_stock_cancel`, `payment_failed`, `unknown`. Следы каждой причины — в `payments`, `shipments`, `products.stock` и `events` (например, `promo_rejected` или `auto_cancel`).

`incidents.json` — ключ ответов для evals в главе 10.3. **Ни сервер, ни модель его не видят никогда**: ни в `data/`, ни в описаниях, ни в промптах — иначе eval перестанет что-либо измерять.

Копия базы — только через `VACUUM INTO` (база в режиме WAL, обычный `cp` может дать несогласованный файл):

```bash
# run from the repo root; reads the live DB, writes a consistent snapshot
rm -f projects/mcp-shop/data/shop.db
sqlite3 ../shop-live/shop.db "VACUUM INTO '/abs/path/ai-engineering-journey/projects/mcp-shop/data/shop.db'"
```

Если копия открывается с ошибкой в режиме `mode=ro` (копия может сохранить WAL-режим в заголовке), один раз выполняем на **копии** `sqlite3 data/shop.db "PRAGMA journal_mode=DELETE"`. Живую базу MCP-сервер не открывает никогда.

Помним о фактах базы из главы 3.1: **один заказ = несколько строк `order_items`**; для `unit = 'g'` (чай и кофе на вес) `quantity` — граммы, а `unit_price` и `unit_cost` — за 100 г; **сумма и прибыль заказа не хранятся**, их считают `item_amount`, `order_total`, `order_profit` из `bot/domain.py` проекта 1. Переносим эту логику в `domain.py` сервера вместе с тестами, иначе Claude будет уверенно отвечать неверными цифрами: 250 г «Сенчи» по 480 ₽ за 100 г превратятся в 120 000 ₽ вместо 1 200.

### Набор инструментов

Принцип из AIL-63: **узкие инструменты с заранее написанными параметризованными запросами** лучше, чем «выполни любой SQL».

| Инструмент | Что делает |
|---|---|
| `get_product(sku)` | Товар: название, категория, единица (`pcs`/`g`), цена, остаток на складе, в продаже ли |
| `list_orders(status, since, until, limit)` | Заказы с фильтрами, уже собранные из позиций, с рассчитанной суммой |
| `get_order(order_id)` | Один заказ целиком: позиции, платежи, доставка + рассчитанные сумма и прибыль |
| `search_events(query, order_id, date_from, date_to, limit)` | Поиск по журналу `events`: подстрока, заказ, интервал; строки с временем и типом, обрезанные |
| `summary_stats(since, until)` | Число заказов, выручка, распределение статусов, число сигналов проблем по типам |

`summary_stats` считает сигналы из данных (заказы с двумя успешными платежами, события `promo_rejected`, `auto_cancel` и т.п.), а не из `incidents.json`.

Если очень хочется дать свободный SQL — только как отдельный инструмент `run_readonly_sql` с тремя слоями: соединение `mode=ro`, `PRAGMA query_only=ON` и `conn.set_authorizer(...)`, разрешающий только `SQLITE_SELECT`, `SQLITE_READ` и `SQLITE_FUNCTION` (и запрещающий чтение `customers`); плюс `LIMIT` и таймаут через `conn.set_progress_handler`. Но начинаем без него.

### Описания инструментов (по «Writing effective tools for agents»)

Модель видит только имя, описание и схему. Хорошее описание отвечает на вопросы: что делает; когда использовать и когда **не** использовать; что значат параметры и в каком формате (даты — ISO, UTC!); что возвращает; какие ограничения.

```text
list_orders: List orders from a read-only snapshot of the shop DB, newest first.
One order has several items (order_items rows); this tool returns whole orders,
already assembled. Use get_order to see items, payments and shipment of one order.
Args:
  status: "new" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded" | "all"
          (default "all")
  since/until: ISO 8601 UTC datetimes like 2026-11-10T00:00:00Z, compared with created_at
  limit: 1..50, default 20
Returns: id, status, created_at, paid_at, shipped_at, closed_at (UTC), delivery_method,
promo_code, discount, items_count, total_rub (computed: items - discount + delivery_cost;
totals are not stored in the DB). Customer names, emails and phones are never returned.
The snapshot may lag behind the live shop; snapshot time is in the 'snapshot_at' field.
```

Ещё советы из статьи: возвращаем осмысленные поля, а не внутренние ID без контекста; ограничиваем объём ответа и сообщаем, что результат обрезан; ошибки делаем **полезными** («since must be ISO date like 2026-11-10T00:00:00Z»), чтобы модель могла исправиться; называем инструменты единообразно.

### Безопасность сервера

Применяем выводы из AIL-64:

1. **Нет инструментов записи.** Ни изменения заказов, ни возвратов, ни промокодов, ни сообщений покупателям, ни отправки в Telegram.
2. **Нет сети.** Сервер не импортирует SDK платёжного провайдера или службы доставки, не делает HTTP-запросов, не знает ключей. Нет ноги «канал наружу» в самом сервере.
3. **Read-only на уровне SQLite** (`mode=ro` + `query_only`), а не только «в коде нет INSERT».
4. **Только копии.** Путь к базе задаётся при запуске сервера (по умолчанию `data/shop.db`), а не параметром инструмента.
5. **Ограничение объёма** каждого ответа.
6. **Журнал событий — недоверенный ввод.** В `events.message` есть тексты, которые писали не мы: статусы от службы доставки, ошибки платёжного провайдера, комментарии покупателей. Помечаем результат `search_events` как данные.
7. **Аннотации.** В спецификации MCP есть подсказки инструментов (например, `readOnlyHint`); выставляем их, но помним, что это подсказка для клиента, а не защита.
8. **Разрешения клиента.** В Claude Code можно явно разрешить только инструменты нашего сервера; режимы, где агент выполняет всё без спроса, не включаем.
9. **Всё, что вернул инструмент, уходит провайдеру модели.** Не возвращаем ничего, что не готовы отправить в API: `customers` сервер не читает, а в `events.message` маскируем телефоны и email.

Установка: пакет `mcp` — официальный SDK из организации `modelcontextprotocol` на GitHub. Как с любым сторонним кодом: проверяем точное имя на PyPI, автора, версию; фиксируем версию.

**Версия SDK (проверено 13 ноября 2026):** текущая стабильная линия Python SDK — v2, и в её документации сервер создаётся как `from mcp.server import MCPServer; mcp = MCPServer("...")` с тем же декоратором `@mcp.tool()`, а клиент — `from mcp import Client`. Код выше написан в стиле v1 (`FastMCP` из `mcp.server.fastmcp`). Выбираем одно: фиксируем v1 и пользуемся документацией v1, или берём v2 и заменяем импорт по [Migration Guide](https://py.sdk.modelcontextprotocol.io/). Примеры из двух версий не смешиваем.

## DeepSeek и Ollama: как это сделать у нас

> ⚠️ **Этот сервер отдаёт данные снимка.** Заказы, платежи и журнал событий — данные покупателей, даже если имён и телефонов в ответах нет. Всё, что вернул инструмент, попадает в контекст модели — то есть уходит туда, где модель работает. Поэтому для снимка `data/shop.db` **основной путь — локальная модель в Ollama**. DeepSeek (серверы в Китае), а также Claude Code / Claude Desktop с облачным Claude — **только на демо-базе**. Пункт 9 из «Безопасности сервера» теперь жёстче: снимок не покидает нашу машину.

### Кто будет MCP-клиентом

Сам сервер от провайдера не зависит: он говорит MCP, а не с моделью. Меняется **host** — кто запускает сервер и передаёт его инструменты модели.

| Host | Модель | Снимок? | Комментарий |
|---|---|---|---|
| **Свой мост `bridge.py`** (MCP-клиент + цикл из главы 9.3) | Ollama (`qwen3:4b`) | **Да — основной путь** | ~80 строк, всё видно, данные не уходят с машины. Запускаем Ollama с `OLLAMA_NO_CLOUD=1` |
| Тот же мост | DeepSeek `deepseek-flash` | Только демо-база | Сравнение качества выбора инструментов |
| Claude Code / Claude Desktop | Claude | Только демо-база (для сравнения) | Лучший UX, но данные уходят в Anthropic |
| Claude Code с `ANTHROPIC_BASE_URL=http://localhost:11434` | Локальная модель Ollama | Технически да, но не основной путь | У Ollama есть [инструкция](https://docs.ollama.com/integrations/claude-code); Anthropic официально не поддерживает не-Claude модели через шлюзы; системный промпт и инструменты Claude Code большие — нужен контекст ≥ 64k (на машине с 8 ГБ это нереально) и модель с меткой `tools`; `tool_choice` и кэш Ollama не поддерживает |
| Claude Code с `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` | DeepSeek | Только демо-база | У DeepSeek есть [инструкция](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code); `mcp_servers` в API DeepSeek игнорирует, но Claude Code сам выступает MCP-клиентом |

У Ollama и DeepSeek нет «MCP в API» (как MCP connector у Anthropic или remote MCP tool у OpenAI): MCP-клиентом всегда выступает наш процесс.

### Мост: MCP-сервер → инструменты Ollama

```python
# bridge.py — illustrative, MCP Python SDK v2 client API; verify against the docs of your pinned version
import asyncio, json, os, sys
from mcp import Client, StdioServerParameters
from mcp.types import TextContent
from openai import OpenAI

llm = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # local only
MODEL = os.environ.get("LLM_MODEL", "qwen3:4b")
SERVER = StdioServerParameters(command="uv", args=["run", "server.py"])  # env is NOT inherited

def to_oai(tools) -> list[dict]:
    return [{"type": "function", "function": {"name": t.name, "description": t.description or "",
             "parameters": t.input_schema}} for t in tools]

async def ask(question: str, system: str) -> str:
    async with Client(SERVER) as mcp:
        tools = to_oai((await mcp.list_tools()).tools)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": question}]
        for _ in range(8):                                   # step limit
            msg = llm.chat.completions.create(model=MODEL, messages=messages,
                                              tools=tools).choices[0].message
            messages.append({"role": "assistant", "content": msg.content or "",
                             "tool_calls": [c.model_dump() for c in msg.tool_calls or []]})
            if not msg.tool_calls:
                return msg.content or ""
            for call in msg.tool_calls:
                try:
                    args = json.loads(call.function.arguments or "{}")
                    res = await mcp.call_tool(call.function.name, args)
                    text = "\n".join(b.text for b in res.content if isinstance(b, TextContent))
                    text = ("ERROR: " + text) if res.is_error else text
                except Exception as e:                       # bad JSON, unknown tool, ...
                    text = f"ERROR: {type(e).__name__}: {e}"
                print(f"tool {call.function.name}({call.function.arguments})", file=sys.stderr)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": text[:8000]})
        return "STOPPED: step limit"

if __name__ == "__main__":
    print(asyncio.run(ask(sys.argv[1], open("prompts/system.md").read())))
```

Дочерний процесс не наследует окружение моста: путь к демо-базе передаём явно (`env={"SHOP_DB_PATH": ...}` в `StdioServerParameters`). При подключении DeepSeek к мосту (только демо-база!) повторяем проверку `assert_data_policy` из главы 3.1 и добавляем сохранение `reasoning_content` в сообщении ассистента, как в главе 9.3, или выключаем thinking: иначе на втором шаге будет 400.

### Описания инструментов для маленькой модели

То, о чём Claude «догадается», `qwen3:4b` не догадается. Для локальной модели:

- **5–6 инструментов — верхняя граница.** Если модель путает `list_orders` и `get_order` (например, ищет один заказ через список), уточняем описания или переименовываем во что-то ещё более различимое (`find_orders` / `get_order_details`) — это проверяется за 5 минут.
- **`enum` везде, где можно** (`status`): FastMCP/MCPServer строит схему из type hints — используем `Literal["new", "paid", "shipped", "delivered", "cancelled", "refunded", "all"]`.
- **Даты — с примером формата прямо в описании параметра.** Маленькие модели чаще всего ошибаются именно в аргументах-датах.
- **Ошибки инструмента — инструкция к исправлению**, а не трейсбек.
- **Ответы компактные:** контекст локальной модели меньше, а длинный JSON она хуже читает. Агрегируем на сервере.

### Сравнение «у них / у нас»

| | Claude (Desktop/Code) | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Готовый MCP-host | Да (Desktop, Code) | Agents SDK, Responses API (remote MCP) | Нет своего; работает как бэкенд Claude Code и других агентов | Нет своего; через Claude Code (не поддерживается Anthropic) или свой мост |
| Где данные из инструментов | Anthropic | OpenAI | Китай | Наша машина |
| Снимок с данными покупателей | Нет (по правилу книги) | Нет | Нет | **Да** |
| Качество выбора инструментов | Высокое | Высокое | Хорошее (меряем) | Заметно ниже на 4B, нужны простые описания и мало инструментов |

## Маршрут изучения

1. [Model Context Protocol — документация](https://modelcontextprotocol.io) → раздел про архитектуру и концепции (host/client/server, tools, resources, prompts, transports) и quickstart для разработчика сервера на Python (≈60 мин). Обратим внимание на абзац о логировании в stdio-серверах.
2. [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) → README: Quickstart, Tools, Resources, Prompts, Running your server, Development mode (Inspector) (≈40 мин). Берём: как FastMCP строит схему из type hints и docstring, как запускать `mcp dev`.
3. [Примеры MCP-серверов](https://github.com/modelcontextprotocol/servers) → открываем reference-сервер для SQLite или файловой системы (если они в текущей версии репозитория или в архиве) (≈20 мин). Смотрим, как они описывают инструменты и ограничивают доступ.
4. [Anthropic: Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → читаем целиком (≈30 мин). Выписываем 5 правил для своих описаний.
5. Документация Claude Code / Claude Desktop по подключению MCP-серверов (раздел MCP в документации Claude Code; команда `claude mcp add`) (≈15 мин) — для сравнения на демо-базе.
6. [MCP Python SDK: Clients](https://py.sdk.modelcontextprotocol.io/client/) и [Client transports](https://py.sdk.modelcontextprotocol.io/client/transports/) (≈20 мин): `Client`, `StdioServerParameters`, `list_tools`, `call_tool`, `is_error`. Обратим внимание: дочерний процесс не наследует окружение родителя. Если зафиксирована v1 — читаем документацию v1.
7. Ollama: [Tool calling](https://docs.ollama.com/capabilities/tool-calling), [Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) про `OLLAMA_NO_CLOUD` (≈15 мин). По желанию — [Claude Code с Ollama](https://docs.ollama.com/integrations/claude-code) и [Claude Code с DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) (≈10 мин).
8. Практика (≈2.5 ч).

## На что обратить внимание

- **`print()` в stdout** ломает stdio-сервер; клиент покажет невнятную ошибку подключения.
- **Относительные пути.** Клиент запускает сервер из своей рабочей папки; `data/shop.db` не найдётся. Строим пути от `Path(__file__).parent`.
- **Время в UTC.** Даты в базе — UTC (`YYYY-MM-DD HH:MM:SS`, как `current_timestamp` в SQLite). Если владелец спрашивает «что было вчера вечером», а модель сравнивает с местным временем, ответ съедет на разницу часовых поясов. Пишем в описаниях, что время UTC, и возвращаем обе формы, если удобно.
- **Несколько строк на заказ.** Без явного объяснения модель посчитает каждую строку `order_items` отдельным заказом и раздует статистику.
- **Сумма заказа не хранится, граммы — не штуки.** Модель, сложившая `quantity × unit_price` сама, ошибётся в 100 раз на чае. Сумму и прибыль отдаёт инструмент, посчитанные кодом с тестами; прибыль — до расходов на доставку (их в базе нет).
- **Устаревший снимок.** Возвращаем `snapshot_at` — когда сделана копия.
- **Огромные ответы.** Все события за месяц — тысячи строк, они забьют контекст. Агрегируем и ограничиваем.
- **Соблазн «удобного» инструмента записи** — нет. Даже «просто отметить заказ как проверенный» или «выдать промокод за неудобство» — это действие в системе магазина.
- **Сервер не подключаем к живой базе даже на минуту** «для проверки».

## Практика

```
projects/mcp-shop/
  server.py
  db.py              # connect() read-only, query helpers
  domain.py          # item_amount, order_total, order_profit from project 1 + tests
  bridge.py          # MCP client + Ollama loop
  tests/test_tools.py
  data/              # gitignored: shop.db (snapshot), demo_shop.db
  scripts/snapshot.sh   # the VACUUM INTO commands above
  .gitignore
```

- [ ] **Инциденты в живой базе.** Расширяем `projects/01-shop-analyst-bot/scripts/make_shop_db.py` аргументом `--incidents N`: N проблемных заказов с причинами из каталога, следы в `payments`, `shipments`, `events`; 2 из них — заказы старше 30 дней, у которых журнал событий уже очищен (правильный ответ — `unknown`, «данных недостаточно»); ответы (`order_id`, `cause_category`) — в `incidents.json` рядом с базами. Старую `../shop-live/` удаляем (генератор не перезаписывает файлы) и запускаем из корня репозитория: `python3 projects/01-shop-analyst-bot/scripts/make_shop_db.py --seed 1 --out ../shop-live/ --incidents 20`. Затем — новые снимки.
- [ ] `scripts/snapshot.sh`: копия `shop.db` через `VACUUM INTO` в `data/`, затем `journal_mode=DELETE` на копии. Проверяем, что `data/` в `.gitignore` (`git check-ignore -v data/shop.db`).
- [ ] `db.py`: `connect()` с `mode=ro` и `query_only`. Тест: попытка `INSERT` падает с `attempt to write a readonly database`.
- [ ] `domain.py`: `item_amount`, `order_total`, `order_profit` из проекта 1 и их тесты (чай на вес, скидка, комиссия).
- [ ] Инструменты: `get_product`, `list_orders`, `get_order`, `search_events`, `summary_stats`. Все запросы параметризованы, у всех лимиты, ни один не читает `customers`.
- [ ] Описания инструментов по правилам из статьи: формат дат, граммы и цена за 100 г, один заказ = несколько позиций, суммы рассчитаны, значения статусов и типов событий, журнал за 30 дней, ограничения.
- [ ] Resource `schema://shop`: краткое описание таблиц и смысла полей (для клиентов, которые подгружают ресурсы).
- [ ] Prompt `order_postmortem(order_id)`: шаблон «разбери этот заказ: позиции, платежи, доставка, события за время жизни заказа, вероятная причина по каталогу инцидентов; если событий нет — так и скажи».
- [ ] Проверка через Inspector (`mcp dev server.py`): вызываем каждый инструмент руками, смотрим схемы.
- [ ] `bridge.py`: MCP-клиент + цикл на Ollama (см. раздел про DeepSeek и Ollama). Ollama запущена с `OLLAMA_NO_CLOUD=1` и контекстом 16k; модель `qwen3:4b` (по умолчанию на 8 ГБ памяти; на 16 ГБ можно `qwen3:8b`, если машина не занята тяжёлым). Это основной host для снимка.
- [ ] **Демо-база.** Расширяем `make_fake_db.py` из главы 3.2: таблицы `shipments` и `events` (без `customers`) и `--incidents N` — свой набор (20 случаев, как в живой базе — на нём идут публичные evals в 10.3) с ответами в `data/demo_incidents.json`; база — в `data/demo_shop.db` сервера. Путь сервер берёт из `SHOP_DB_PATH` (дефолт `data/shop.db`) и при старте пишет в stderr, какой файл открыл. На этой базе пойдут публичные evals проекта 4.
- [ ] (для сравнения, только на демо-базе) Подключаем сервер к Claude Code под именем `shop` (`claude mcp add --env SHOP_DB_PATH=/abs/path/ai-engineering-journey/projects/mcp-shop/data/demo_shop.db shop -- uv run --directory /abs/path/ai-engineering-journey/projects/mcp-shop server.py`) или к Claude Desktop (`claude_desktop_config.json`, секция `mcpServers`, с тем же `SHOP_DB_PATH` в `env`), и/или прогоняем `bridge.py` с DeepSeek. Сервер в этом режиме смотрит на демо-базу — проверяем это до первого вопроса.
- [ ] Задаём 5 вопросов через `bridge.py` на Ollama и сохраняем ответы в `notes/mcp-questions.md`, например:
  1. «Сколько заказов оформлено за последние 3 дня и как распределены статусы?»
  2. «Какая выручка за неделю и сколько заказов отменено или возвращено?»
  3. «Разбери заказ <id>: что с ним случилось?»
  4. «Были ли за неделю двойные списания или зависшие доставки? Какими службами?»
  5. «Почему заказ <id> отменили после оплаты и сколько этого товара сейчас на складе?»
  Сверяем ответы с базой руками — хотя бы два. Для вопроса 3 причину сверяем с `../shop-live/incidents.json` — сами, не через модель.
- [ ] Отмечаем, какой инструмент модель выбирала неправильно, и улучшаем его описание.
- [ ] Сравнение на демо-базе: те же 5 вопросов (переформулированные под демо-данные) на Ollama, DeepSeek и (по желанию) Claude. Записываем, где локальная модель выбрала не тот инструмент или ошиблась в аргументах.

## Готово, когда

- Локальная модель в Ollama через наш MCP-сервер и `bridge.py` отвечает на вопросы о заказах, и ответы сходятся с базой; снимок не уходил ни в одно облако.
- Генератор закладывает 20 инцидентов и пишет `incidents.json`, который сервер не читает.
- Есть демо-база с событиями и доставками и сравнение с DeepSeek/Claude на ней.
- Сервер физически не может писать (проверено тестом), не имеет сети и ключей, не читает `customers`, работает только с копией.
- Описания инструментов объясняют «один заказ — несколько позиций», граммы, рассчитанные суммы, UTC и 30 дней журнала.

## Тест для самопроверки

1. Назовите три примитива MCP-сервера и кто инициирует использование каждого.
2. Какой транспорт выбрать для локального сервера к базе магазина и почему?
3. Что сломается, если в stdio-сервере написать `print("debug")`?
4. Почему `PRAGMA query_only=ON` и `mode=ro` лучше, чем «в коде просто нет INSERT»?
5. Что не так с этим инструментом?
   ```python
   @mcp.tool()
   def query(sql: str, db_path: str = "../shop-live/shop.db") -> list:
       """Run SQL."""
       return sqlite3.connect(db_path).execute(sql).fetchall()
   ```
6. Почему копию базы делают через `VACUUM INTO`, а не `cp`?
7. Модель на вопрос «сколько заказов за неделю» ответила 126, а реально 42. Какая вероятная причина и как исправить на стороне сервера?
8. `readOnlyHint` в аннотации инструмента — это защита?
   a) да, клиент не даст вызвать запись; b) нет, это подсказка клиенту, защита — в коде сервера; c) да, сервер проверяет её сам; d) это поле для resources.
9. Что должно быть в хорошем описании инструмента? Назовите 4 пункта.
10. Почему результат `search_events` нужно считать недоверенным вводом?
11. Почему путь к базе не должен быть параметром инструмента?
12. MCP-сервер подключён к снимку `data/shop.db`, вопросы задаются через Claude Code, настроенный на DeepSeek (`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`). Сервер только читает, не имеет сети и не возвращает имена и телефоны. Что не так?
13. Почему у Ollama и DeepSeek MCP-клиентом всегда выступает наш процесс, а у Anthropic и OpenAI — не обязательно?
14. `qwen3:4b` через мост на вопрос «что с заказом 1042?» вызывает `list_orders` вместо `get_order` и пишет даты в формате «18.01». Что поменять на стороне сервера?
15. Почему `incidents.json` не кладут в `data/` сервера и не упоминают в описаниях инструментов?

## Ответы

1. Tools — вызывает модель; resources — подгружает приложение или пользователь; prompts — выбирает пользователь.
2. stdio: нет сетевого порта и авторизации, клиент сам запускает процесс локально; закрывает удалённый доступ к данным.
3. Мусор в stdout нарушит поток JSON-RPC, клиент не сможет разобрать сообщения и отключится или покажет ошибку.
4. Защита на уровне базы срабатывает даже при ошибке в коде или при свободном SQL; это защита в глубину.
5. Всё: свободный SQL без read-only (можно `DELETE`, `UPDATE orders SET status='refunded'`), чтение `customers` с email и телефонами, путь к базе как параметр (можно указать живую базу или любой файл), по умолчанию — живая база, а не снимок, нет лимитов и описания. Нарушает правило «только чтение копии».
6. База в режиме WAL: часть данных лежит в `-wal`-файле, и копия одного файла может быть несогласованной. `VACUUM INTO` делает целостный снимок.
7. Один заказ — несколько строк `order_items` (здесь в среднем три), модель посчитала строки. Объяснить это в описании, а лучше отдавать заказы уже собранными (`list_orders`) и дать `summary_stats`, который считает `COUNT(DISTINCT orders.id)`.
8. **b.** Аннотация — подсказка клиенту; защита — `mode=ro`, `query_only` и отсутствие инструментов записи в коде сервера.
9. Что делает; когда использовать и когда нет; параметры с форматами и единицами (UTC, ISO, граммы и цена за 100 г); что возвращает; ограничения (лимит, обрезка, 30 дней журнала, устаревание снимка); примеры.
10. В журнале есть текст, который писали не мы (статусы службы доставки, ошибки платёжного провайдера, комментарии покупателей), — через него возможна непрямая инъекция.
11. Иначе модель (или инъекция) может направить инструмент на живую базу или на любой другой файл; путь задаётся при запуске и указывает на копию.
12. Всё, что вернули инструменты, уходит в контекст модели, то есть на серверы DeepSeek в Китае; заказы, платежи и события — данные покупателей даже без имён. Read-only сервер не спасает от утечки через провайдера. Снимок — только с локальной моделью; DeepSeek — только на демо-базе.
13. У Ollama и DeepSeek нет MCP-клиента на стороне API: инструменты им передаются как обычные `tools`, а вызывает сервер наш код (мост, Claude Code, фреймворк). У Anthropic есть MCP connector, у OpenAI — remote MCP tool в Responses API: там клиентом может быть сам провайдер (для удалённых серверов).
14. Сделать описания и имена различимыми, `Literal`/`enum` для параметров, пример формата даты в описании параметра, понятную ошибку с правильным форматом; при необходимости — сократить число инструментов.
15. Это ключ ответов для evals проекта 4: увидев его, модель возьмёт причину из ответа, а не из данных, и eval ничего не измерит.

## Что дальше

Неделя 10 — Проект 4. Сначала глава 10.1 · Память и контекст агента (AIL-65), затем глава 10.2 · Проект 4: агент-разборщик заказов (AIL-41), где агент использует инструменты этого MCP-сервера — на локальной модели, а в главе 10.3 заложенные сегодня инциденты станут эталоном для evals.
