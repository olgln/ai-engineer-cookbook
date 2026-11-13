# 9.5 · MCP-сервер к арбитражному приложению (только чтение)  (AIL-39)

> **Неделя 9** · Агенты · ⏱ ~4–5 ч · Проект

## Зачем это AI-инженеру

MCP (Model Context Protocol) — открытый стандарт подключения инструментов и данных к LLM-клиентам: Claude Desktop, Claude Code, Cursor, IDE и собственным агентам. Написав сервер один раз, ты получаешь доступ к своим данным из любого совместимого клиента. Свой MCP-сервер к реальной системе с продуманной моделью безопасности — сильный пункт в резюме и хорошая тема для рассказа на собеседовании.

> ⚠️ **Только чтение.** Никаких функций, которые ставят, изменяют или отменяют ордера, и никаких запросов к биржам с ключами — только копия базы, сделанная через `VACUUM INTO`. Сервер не импортирует код приложения, не читает `.env` и не знает ни одного ключа.

## Теория

### Что такое MCP

MCP — это протокол поверх JSON-RPC 2.0 между **клиентом** (живёт внутри host-приложения — Claude Desktop, Claude Code, твой агент) и **сервером** (твоя программа, которая предоставляет возможности).

```
┌──────────── Host (Claude Desktop / Claude Code / your agent) ───────────┐
│   LLM  ◄──►  MCP client ──── JSON-RPC over stdio or HTTP ────┐          │
└──────────────────────────────────────────────────────────────┼──────────┘
                                                               ▼
                                          MCP server (your Python process)
                                           ├─ tools:     get_positions, ...
                                           ├─ resources: schema://positions
                                           └─ prompts:   trade_postmortem
                                                  │ read-only
                                                  ▼
                                          data/arb-copy.db, data/logs/*.log
```

Аналогия: MCP для LLM — как LSP для редакторов. Раньше каждый редактор писал поддержку каждого языка; с LSP язык пишет один сервер. Здесь — каждый инструмент пишется один раз и работает во всех клиентах.

### Три примитива сервера

| Примитив | Кто управляет | Что это | Пример у тебя |
|---|---|---|---|
| **Tools** | Модель (решает вызвать) | Функции с JSON Schema параметров | `get_positions(status, exchange, since)` |
| **Resources** | Приложение/пользователь (решает подгрузить) | Данные по URI, как файлы | `schema://trading` — описание таблиц |
| **Prompts** | Пользователь (выбирает шаблон) | Готовые шаблоны запросов с параметрами | `trade_postmortem(form_id, position_number)` |

Клиенты поддерживают их по-разному: tools есть почти везде, resources и prompts — не везде. Основную функциональность делай инструментами.

### Транспорты

- **stdio** — клиент запускает сервер как дочерний процесс и общается через stdin/stdout. Для локальных серверов это стандарт: нет порта, нет сети, нет авторизации. Твой случай.
- **Streamable HTTP** — сервер слушает HTTP, клиенты подключаются по сети (удалённые серверы, несколько пользователей). Тогда нужна авторизация (в спецификации описан OAuth). Для данных о торговле **не открывай HTTP-порт наружу** — stdio закрывает целый класс проблем.

Важная ловушка stdio: **stdout принадлежит протоколу**. Любой `print()` в stdout ломает JSON-RPC. Логи — только в stderr или в файл.

### Минимальный сервер на Python SDK

```python
# server.py — illustrative, check the MCP Python SDK README for the current API
import sqlite3, sys
from mcp.server.fastmcp import FastMCP  # SDK v1 style; in v2: from mcp.server import MCPServer

DB_PATH = "data/arb-copy.db"
mcp = FastMCP("arbitrage-readonly")

def connect() -> sqlite3.Connection:
    # Read-only at the OS/SQLite level: any write fails even if code has a bug
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn

@mcp.tool()
def get_positions(status: str = "closed", exchange: str | None = None,
                  since: str | None = None, limit: int = 20) -> list[dict]:
    """List arbitrage position legs from a read-only copy of the trading DB.
    ... (full description: see section 'Tool descriptions' below)
    """
    ...

if __name__ == "__main__":
    print("arbitrage MCP starting", file=sys.stderr)  # stderr only, never stdout
    mcp.run()  # stdio transport by default
```

FastMCP строит JSON Schema инструмента из type hints и берёт описание из docstring — как Zod-схема, превращённая в JSON Schema, в мире TS.

### Данные: что у тебя есть

Работаешь только с копиями, лежащими в папке проекта `data/` (она в `.gitignore`):

- **Торговая база** (`arbitrage.db` на уровень выше репозитория). Таблицы: `Forms` (пара: `symbolShort/exchangeShort`, `symbolLong/exchangeLong`, `openSpread`, `closeSpread`, `volume`, флаги `autoBuy`/`autoClose`…), `Positions` (**одна строка на ногу**: `formId` + `positionNumber` + `direction` — короткая и длинная ноги одной позиции; `entryPrice`, `closePrice`, `entryFee`, `closeFee`, `closeSpread`, `openedBy` (`auto`/`manual`), `closedBy` (`auto`/`manual`/`naked`/`liquidation`/`adl`/`hedge`), `dateCreated`, `dateClosed`).
- **База графиков** (`arbitrage-charts.db`): `SpreadBuckets` — спреды пары в 20-секундных бакетах, `Quotes`, `Candles`. Хранится 7 дней — копируй вовремя, если нужна история.
- **Логи сервера**: `logs/prod/YYYY-MM-DD.log` (7 дней) и `logs/prod/shadow.log`.

Копия базы — только через `VACUUM INTO` (база в режиме WAL, обычный `cp` может дать несогласованный файл):

```bash
# run from the app repo; reads the live DB, writes a consistent snapshot
sqlite3 ../arbitrage.db "VACUUM INTO '/abs/path/mcp-arbitrage/data/arb-copy.db'"
sqlite3 ../arbitrage-charts.db "VACUUM INTO '/abs/path/mcp-arbitrage/data/charts-copy.db'"
cp logs/prod/*.log /abs/path/mcp-arbitrage/data/logs/
```

Если копия открывается с ошибкой в режиме `mode=ro` (копия может сохранить WAL-режим в заголовке), один раз выполни на **копии** `sqlite3 data/arb-copy.db "PRAGMA journal_mode=DELETE"`. Живую базу MCP-сервер не открывает никогда.

Помни о единицах: размер ноги в монетах для okx, gate и mexc считается иначе, чем для остальных бирж (в приложении это знает `app/utils/contracts.ts`). Если инструмент считает PnL или объём в монетах — перенеси эту логику и покрой её тестом, иначе Claude будет уверенно отвечать неверными цифрами.

### Набор инструментов

Принцип из AIL-63: **узкие инструменты с заранее написанными параметризованными запросами** лучше, чем «выполни любой SQL».

| Инструмент | Что делает |
|---|---|
| `list_forms(active_only)` | Пары: биржи, символы, пороги спреда |
| `get_positions(status, exchange, symbol, since, until, limit)` | Ноги позиций с фильтрами |
| `get_position(form_id, position_number)` | Обе ноги одной позиции + рассчитанные поля: длительность, PnL по ногам, комиссии, кто открыл/закрыл |
| `get_spread_history(form_id, start, end)` | Агрегаты `SpreadBuckets` по паре за интервал (с ограничением числа точек) |
| `search_logs(query, date_from, date_to, limit)` | Подстрочный поиск по копиям логов; возвращает строки с датой и номером, обрезанные |
| `summary_stats(since, until)` | Число сделок, сумма PnL, распределение `closedBy` |

Если очень хочется дать свободный SQL — только как отдельный инструмент `run_readonly_sql` с тремя слоями: соединение `mode=ro`, `PRAGMA query_only=ON` и `conn.set_authorizer(...)`, разрешающий только `SQLITE_SELECT`, `SQLITE_READ` и `SQLITE_FUNCTION`; плюс `LIMIT` и таймаут через `conn.set_progress_handler`. Но начни без него.

### Описания инструментов (по «Writing effective tools for agents»)

Модель видит только имя, описание и схему. Хорошее описание отвечает на вопросы: что делает; когда использовать и когда **не** использовать; что значат параметры и в каком формате (даты — ISO, UTC!); что возвращает; какие ограничения.

```text
get_positions: List legs of arbitrage positions from a read-only snapshot of the trading DB.
Each arbitrage position has two rows (legs): direction SHORT and LONG, sharing
form_id + position_number. Use get_position to see both legs of one position together.
Args:
  status: "open" | "closed" | "all" (default "closed")
  exchange: one of bybit, binance, okx, gate, bingx, hyperliquid, ... or null for all
  since/until: ISO 8601 UTC datetimes, compared with dateCreated
  limit: 1..100, default 20, newest first
Returns: list of legs with entry/close price, fees, openedBy, closedBy
(auto | manual | naked | liquidation | adl | hedge), dateCreated, dateClosed (UTC).
The snapshot may lag behind the live app; snapshot time is in the 'snapshot_at' field.
```

Ещё советы из статьи: возвращай осмысленные поля, а не внутренние ID без контекста; ограничивай объём ответа и сообщай, что результат обрезан; ошибки делай **полезными** («since must be ISO date like 2026-11-10T00:00:00Z»), чтобы модель могла исправиться; называй инструменты единообразно.

### Безопасность сервера

Применяешь выводы из AIL-64:

1. **Нет инструментов записи.** Ни ордеров, ни изменения форм, ни переключения auto-режимов, ни отправки в Telegram.
2. **Нет сети.** Сервер не импортирует ccxt, не делает HTTP-запросов, не знает ключей. Нет ноги «канал наружу» в самом сервере.
3. **Read-only на уровне SQLite** (`mode=ro` + `query_only`), а не только «в коде нет INSERT».
4. **Только копии.** Путь к базе — константа на `data/`, не параметр инструмента.
5. **Ограничение объёма** каждого ответа.
6. **Логи — недоверенный ввод.** В них есть тексты ответов бирж и названия монет; помечай результат `search_logs` как данные.
7. **Аннотации.** В спецификации MCP есть подсказки инструментов (например, `readOnlyHint`); выставь их, но помни, что это подсказка для клиента, а не защита.
8. **Разрешения клиента.** В Claude Code можно явно разрешить только инструменты твоего сервера; не включай режимы, где агент выполняет всё без спроса.
9. **Всё, что вернул инструмент, уходит провайдеру модели.** Не возвращай ничего, что не готов отправить в API (ключей в копии базы нет, но проверь логи на секреты и вычищай их).

Установка: пакет `mcp` — официальный SDK из организации `modelcontextprotocol` на GitHub. По твоему правилу про сторонний код: проверь точное имя на PyPI, автора, версию; зафиксируй версию.

**Версия SDK (проверено 13 ноября 2026):** текущая стабильная линия Python SDK — v2, и в её документации сервер создаётся как `from mcp.server import MCPServer; mcp = MCPServer("...")` с тем же декоратором `@mcp.tool()`, а клиент — `from mcp import Client`. Код выше написан в стиле v1 (`FastMCP` из `mcp.server.fastmcp`). Выбери одно: зафиксируй v1 и пользуйся документацией v1, или возьми v2 и замени импорт по [Migration Guide](https://py.sdk.modelcontextprotocol.io/). Не смешивай примеры из двух версий.

## DeepSeek и Ollama: как это сделать у нас

> ⚠️ **Этот сервер отдаёт реальные торговые данные.** Всё, что вернул инструмент, попадает в контекст модели — то есть уходит туда, где модель работает. Поэтому для реальной копии базы **основной путь — локальная модель в Ollama**. DeepSeek (сервера в Китае), а также Claude Code / Claude Desktop с облачным Claude — **только на фейковой базе**. Пункт 9 из «Безопасности сервера» выше теперь звучит жёстче: не «проверь логи на секреты», а «реальные данные не покидают Mac».

### Кто будет MCP-клиентом

Сам сервер от провайдера не зависит: он говорит MCP, а не с моделью. Меняется **host** — кто запускает сервер и передаёт его инструменты модели.

| Host | Модель | Реальная база? | Комментарий |
|---|---|---|---|
| **Свой мост `bridge.py`** (MCP-клиент + цикл из главы 9.3) | Ollama (`qwen3:4b`) | **Да — основной путь** | ~80 строк, всё видно, данные не уходят с Mac. Запускай Ollama с `OLLAMA_NO_CLOUD=1` |
| Тот же мост | DeepSeek `deepseek-flash` | Только фейковая | Сравнение качества выбора инструментов |
| Claude Code / Claude Desktop | Claude | Только фейковая (для сравнения) | Лучший UX, но данные уходят в Anthropic |
| Claude Code с `ANTHROPIC_BASE_URL=http://localhost:11434` | Локальная модель Ollama | Технически да, но не основной путь | У Ollama есть [инструкция](https://docs.ollama.com/integrations/claude-code); Anthropic официально не поддерживает не-Claude модели через шлюзы; системный промпт и инструменты Claude Code большие — нужен контекст ≥ 64k (на твоём M2 с 8 ГБ это нереально) и модель с меткой `tools`; `tool_choice` и кэш Ollama не поддерживает |
| Claude Code с `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` | DeepSeek | Только фейковая | У DeepSeek есть [инструкция](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code); `mcp_servers` в API DeepSeek игнорирует, но Claude Code сам выступает MCP-клиентом |

У Ollama и DeepSeek нет «MCP в API» (как MCP connector у Anthropic или remote MCP tool у OpenAI): MCP-клиентом всегда выступает твой процесс.

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

Если будешь подключать DeepSeek к мосту (только фейковая база!) — добавь сохранение `reasoning_content` в сообщении ассистента, как в главе 9.3, или выключи thinking: иначе на втором шаге будет 400.

### Описания инструментов для маленькой модели

То, что Claude «догадается», `qwen3:4b` — нет. Для локальной модели:

- **6 инструментов — верхняя граница.** Если модель путает `get_positions` и `get_position`, переименуй во что-то различимое (`list_position_legs` / `get_position_detail`) — это проверяется за 5 минут.
- **`enum` везде, где можно** (`status`, `exchange`): FastMCP/MCPServer строит схему из type hints — используй `Literal["open", "closed", "all"]`.
- **Даты — с примером формата прямо в описании параметра.** Маленькие модели чаще всего ошибаются именно в аргументах-датах.
- **Ошибки инструмента — инструкция к исправлению**, а не трейсбек.
- **Ответы компактные:** контекст локальной модели меньше, а длинный JSON она хуже читает. Агрегируй на сервере.

### Сравнение «у них / у нас»

| | Claude (Desktop/Code) | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Готовый MCP-host | Да (Desktop, Code) | Agents SDK, Responses API (remote MCP) | Нет своего; работает как бэкенд Claude Code и других агентов | Нет своего; через Claude Code (не поддерживается Anthropic) или свой мост |
| Где данные из инструментов | Anthropic | OpenAI | Китай | Твой Mac |
| Реальная копия базы | Нет (по правилу книги) | Нет | Нет | **Да** |
| Качество выбора инструментов | Высокое | Высокое | Хорошее (меряй) | Заметно ниже на 4B, нужны простые описания и мало инструментов |

## Маршрут изучения

1. [Model Context Protocol — документация](https://modelcontextprotocol.io) → раздел про архитектуру и концепции (host/client/server, tools, resources, prompts, transports) и quickstart для разработчика сервера на Python (≈60 мин). Обрати внимание на абзац о логировании в stdio-серверах.
2. [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) → README: Quickstart, Tools, Resources, Prompts, Running your server, Development mode (Inspector) (≈40 мин). Забери: как FastMCP строит схему из type hints и docstring, как запускать `mcp dev`.
3. [Примеры MCP-серверов](https://github.com/modelcontextprotocol/servers) → открой reference-сервер для SQLite или файловой системы (если они в текущей версии репозитория или в архиве) (≈20 мин). Посмотри, как они описывают инструменты и ограничивают доступ.
4. [Anthropic: Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → прочитай целиком (≈30 мин). Выпиши 5 правил для своих описаний.
5. Документация Claude Code / Claude Desktop по подключению MCP-серверов (раздел MCP в документации Claude Code; команда `claude mcp add`) (≈15 мин) — для сравнения на фейковой базе.
6. [MCP Python SDK: Clients](https://py.sdk.modelcontextprotocol.io/client/) и [Client transports](https://py.sdk.modelcontextprotocol.io/client/transports/) (≈20 мин): `Client`, `StdioServerParameters`, `list_tools`, `call_tool`, `is_error`. Обрати внимание: дочерний процесс не наследует твоё окружение. Если зафиксировал v1 — читай документацию v1.
7. Ollama: [Tool calling](https://docs.ollama.com/capabilities/tool-calling), [Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) про `OLLAMA_NO_CLOUD` (≈15 мин). По желанию — [Claude Code с Ollama](https://docs.ollama.com/integrations/claude-code) и [Claude Code с DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) (≈10 мин).
8. Практика (≈2.5 ч).

## На что обратить внимание

- **`print()` в stdout** ломает stdio-сервер; клиент покажет невнятную ошибку подключения.
- **Относительные пути.** Клиент запускает сервер из своей рабочей папки; `data/arb-copy.db` не найдётся. Строй пути от `Path(__file__).parent`.
- **Время в UTC.** `current_timestamp` в SQLite — UTC. Если ты спрашиваешь «что было вчера вечером», а модель сравнивает с локальным временем, ответ съедет на 3 часа. Пиши в описаниях, что время UTC, и возвращай обе формы, если удобно.
- **Две строки на позицию.** Без явного объяснения модель посчитает каждую ногу отдельной сделкой и удвоит статистику.
- **Устаревшая копия.** Возвращай `snapshot_at` — когда сделана копия.
- **Огромные ответы.** 5000 строк спреда забьют контекст. Агрегируй и ограничивай.
- **Соблазн «удобного» инструмента записи** — нет. Даже «просто выключить autoBuy» — это действие в торговой системе.
- **Не подключай сервер к живой базе даже на минуту** «для проверки».

## Практика

```
mcp-arbitrage/
  server.py
  db.py              # connect() read-only, query helpers
  pnl.py             # leg/position math ported from contracts.ts + tests
  tests/test_tools.py
  data/              # gitignored: arb-copy.db, charts-copy.db, logs/
  scripts/snapshot.sh   # the VACUUM INTO commands above
  .gitignore
```

- [ ] `scripts/snapshot.sh`: копии баз через `VACUUM INTO` и логов в `data/`. Проверь, что `data/` в `.gitignore`.
- [ ] `db.py`: `connect()` с `mode=ro` и `query_only`. Тест: попытка `INSERT` падает с `attempt to write a readonly database`.
- [ ] Инструменты: `list_forms`, `get_positions`, `get_position`, `get_spread_history`, `search_logs`, `summary_stats`. Все запросы параметризованы, у всех лимиты.
- [ ] Описания инструментов по правилам из статьи: формат дат, единицы, две ноги на позицию, значения `closedBy`, что возвращается, ограничения.
- [ ] Resource `schema://trading`: краткое описание таблиц и смысла полей (для клиентов, которые подгружают ресурсы).
- [ ] Prompt `trade_postmortem(form_id, position_number)`: шаблон «разбери эту позицию: обе ноги, спред вокруг открытия и закрытия, логи в этот интервал, вероятная причина».
- [ ] Проверка через Inspector (`mcp dev server.py`): вызови каждый инструмент руками, посмотри схемы.
- [ ] `bridge.py`: MCP-клиент + цикл на Ollama (см. раздел про DeepSeek и Ollama). Ollama запущена с `OLLAMA_NO_CLOUD=1` и контекстом 16k; модель `qwen3:4b` (на M2 с 8 ГБ — по умолчанию; `qwen3:8b` — только с закрытыми программами и невзведённой автоторговлей). Это основной host для реальной копии базы.
- [ ] `scripts/make_fake_db.py`: минимальная фейковая база той же схемы (5 форм, 10 позиций = 20 ног, разные `closedBy`, выдуманные символы и даты) — путь к базе сервер берёт из переменной окружения с дефолтом на `data/arb-copy.db`. В главе 10.4 ты её расширишь.
- [ ] (для сравнения, только на фейковой базе) Подключи сервер к Claude Code (`claude mcp add arbitrage -- uv run --directory /abs/path/mcp-arbitrage server.py`) или к Claude Desktop (`claude_desktop_config.json`, секция `mcpServers`), и/или прогони `bridge.py` с DeepSeek. Сервер в этом режиме смотрит на фейковую базу — проверь это до первого вопроса.
- [ ] Задай 5 вопросов через `bridge.py` на Ollama и сохрани ответы в `notes/mcp-questions.md`, например:
  1. «Сколько позиций закрыто за последние 3 дня и как распределены причины закрытия?»
  2. «Какая пара принесла больше всего PnL за неделю?»
  3. «Разбери позицию <form_id> #<n>: почему она закрылась?»
  4. «Были ли закрытия ликвидацией или ADL? На каких биржах?»
  5. «Как вёл себя спред пары X за час до закрытия позиции?»
  Сверь ответы с базой руками — хотя бы два.
- [ ] Отметь, какой инструмент модель выбирала неправильно, и улучши его описание.
- [ ] Сравнение на фейковой базе: те же 5 вопросов (переформулированные под фейковые данные) на Ollama, DeepSeek и (по желанию) Claude. Запиши, где локальная модель выбрала не тот инструмент или ошиблась в аргументах.

## Готово, когда

- Локальная модель в Ollama через твой MCP-сервер и `bridge.py` отвечает на вопросы о сделках, и ответы сходятся с базой; реальные данные не уходили ни в одно облако.
- Есть фейковая база и сравнение с DeepSeek/Claude на ней.
- Сервер физически не может писать (проверено тестом), не имеет сети и ключей, работает только с копией.
- Описания инструментов объясняют две ноги, UTC и значения `closedBy`.

## Тест для самопроверки

1. Назови три примитива MCP-сервера и кто инициирует использование каждого.
2. Какой транспорт выбрать для локального сервера к торговой базе и почему?
3. Что сломается, если в stdio-сервере написать `print("debug")`?
4. Почему `PRAGMA query_only=ON` и `mode=ro` лучше, чем «в коде просто нет INSERT»?
5. Что не так с этим инструментом?
   ```python
   @mcp.tool()
   def query(sql: str, db_path: str = "../arbitrage.db") -> list:
       """Run SQL."""
       return sqlite3.connect(db_path).execute(sql).fetchall()
   ```
6. Почему копию базы делают через `VACUUM INTO`, а не `cp`?
7. Модель на вопрос «сколько сделок за неделю» ответила 84, а реально 42. Какая вероятная причина и как исправить на стороне сервера?
8. `readOnlyHint` в аннотации инструмента — это защита?
   a) да, клиент не даст вызвать запись; b) нет, это подсказка клиенту, защита — в коде сервера; c) да, сервер проверяет её сам; d) это поле для resources.
9. Что должно быть в хорошем описании инструмента? Назови 4 пункта.
10. Почему результат `search_logs` нужно считать недоверенным вводом?
11. Почему путь к базе не должен быть параметром инструмента?
12. Ты подключил MCP-сервер к реальной копии базы и задаёшь вопросы через Claude Code, настроенный на DeepSeek (`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`). Сервер только читает и не имеет сети. Что не так?
13. Почему у Ollama и DeepSeek MCP-клиентом всегда выступает твой процесс, а у Anthropic и OpenAI — не обязательно?
14. `qwen3:4b` через мост путает `get_positions` и `get_position` и пишет даты в формате «18.01». Что поменять на стороне сервера?

## Ответы

1. Tools — вызывает модель; resources — подгружает приложение или пользователь; prompts — выбирает пользователь.
2. stdio: нет сетевого порта и авторизации, клиент сам запускает процесс локально; закрывает удалённый доступ к данным.
3. Мусор в stdout нарушит поток JSON-RPC, клиент не сможет разобрать сообщения и отключится или покажет ошибку.
4. Защита на уровне базы срабатывает даже при ошибке в коде или при свободном SQL; это защита в глубину.
5. Всё: свободный SQL без read-only (можно `DELETE`, `UPDATE Forms SET autoBuy=1`), путь к базе как параметр (можно указать живую базу или любой файл), по умолчанию — живая база, а не копия, нет лимитов и описания. Нарушает правило «только чтение копии».
6. База в режиме WAL: часть данных лежит в `-wal`-файле, и копия одного файла может быть несогласованной. `VACUUM INTO` делает целостный снимок.
7. Каждая позиция — две строки (ноги), модель посчитала строки. Объяснить это в описании, а лучше дать `summary_stats`, который считает позиции по `formId + positionNumber`.
8. b.
9. Что делает; когда использовать и когда нет; параметры с форматами и единицами (UTC, ISO); что возвращает; ограничения (лимит, обрезка, устаревание данных); примеры.
10. В логах есть текст, который писал не ты (ответы бирж, ошибки, названия монет), — через него возможна непрямая инъекция.
11. Иначе модель (или инъекция) может направить инструмент на живую базу или на любой другой файл; путь — константа на копию.
12. Всё, что вернули инструменты, уходит в контекст модели, то есть на сервера DeepSeek в Китае. Read-only сервер не спасает от утечки через сам LLM-провайдер. Реальная база — только с локальной моделью; DeepSeek — только на фейковой.
13. У Ollama и DeepSeek нет MCP-клиента на стороне API: инструменты им передаются как обычные `tools`, а вызывает сервер твой код (мост, Claude Code, фреймворк). У Anthropic есть MCP connector, у OpenAI — remote MCP tool в Responses API: там клиентом может быть сам провайдер (для удалённых серверов).
14. Сделать имена различимыми, `Literal`/`enum` для параметров, пример формата даты в описании параметра, понятную ошибку с правильным форматом; при необходимости — сократить число инструментов.

## Что дальше

Неделя 10 — Проект 4. Сначала глава 10.1 · Память и контекст агента (AIL-65), затем глава 10.2 · Проект 4: агент-разборщик сделок (AIL-41), где агент использует инструменты этого MCP-сервера — на локальной модели.
