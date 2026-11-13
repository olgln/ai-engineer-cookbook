# 3.2 · Проект 1: функции только для чтения  (AIL-14)

> **Неделя 3** · Основы LLM · ⏱ ~5 ч · Проект

## Зачем это AI-инженеру

Инструменты — это интерфейс между моделью и твоей системой, и от их качества зависит больше, чем от промпта. Модель видит только имя, описание и JSON-схему параметров; если функция называется туманно или возвращает 1000 строк, модель будет ошибаться и тратить деньги. На собеседованиях про агентов вопрос «как ты проектируешь tools» звучит постоянно, и правильный ответ — «как публичный API для не очень внимательного, но очень старательного клиента».

⚠️ **Только чтение.** Никаких функций, которые ставят или отменяют ордера, и никаких запросов к биржам с ключами — только копия базы.

## Теория

Цикл tool calling ты уже разобрал в AIL-10, Pydantic-модели — в AIL-8. Здесь — как проектировать **сами функции** для реального проекта.

### 1. Четыре функции

| Функция | Вопросы, на которые отвечает | Что возвращает |
|---|---|---|
| `get_open_positions()` | «какие пары открыты?», «сколько позиций по BTC?» | список пар с числом позиций, объёмом, средним входом |
| `get_pnl(period)` | «какой PnL за неделю?» | сумма, число сделок, лучшая/худшая пара |
| `get_spread_history(pair, period)` | «где был максимальный спред по ETH?» | min/max/avg/последний спред, время максимума |
| `get_closed_positions(period, limit)` | «покажи последние сделки» | до `limit` сделок, уже сложенных из двух ног |

Обрати внимание: **ни одна функция не возвращает «строки таблицы»**. Каждая возвращает ответ на класс вопросов: агрегат или короткий список. Это главное правило проектирования tools.

### 2. Принципы хорошего инструмента

**Одна функция — одна понятная задача.** Модель хорошо выбирает между 4–10 непохожими инструментами и плохо — между 30 похожими. Если два инструмента различаются одним флагом, это один инструмент с параметром.

**Имя и описание пишутся для модели.** Описание — это промпт. В нём: что делает, когда использовать, когда *не* использовать, единицы измерения, ограничения данных.

```text
get_pnl: Realized PnL of closed arbitrage positions for a period, in USDT.
Computed from entry/close prices and trading fees. Does NOT include funding
payments. Use for questions about profit, loss, earnings. For a list of
individual trades use get_closed_positions instead.
```

**Параметры — узкие типы.** `period: Literal["day", "week", "month"]` лучше, чем `period: str`: модель не придумает `"last fortnight"`, а схема сама подскажет варианты. Каждый параметр — с `description`.

**Компактный выход.** Не отдавай модели 1000 строк — агрегируй и ограничивай выдачу, иначе дорого и модель теряется. Каждый токен результата ты оплачиваешь как input, причём на каждом следующем шаге цикла снова. Практические правила:
- агрегаты вместо строк;
- жёсткий потолок `limit` (например, `≤ 20`), даже если модель попросила 500;
- округление: PnL до 2 знаков, цены до значимых цифр, спред до 3 знаков;
- даты в ISO 8601 и с указанием часового пояса;
- поле `truncated: true` / `total_count`, если показал не всё — модель скажет «показал 20 из 143».

**Ошибки — данными, а не исключениями наружу.** Пустой результат — не ошибка: `{"positions": [], "note": "no open positions"}`. Неизвестная пара — понятное сообщение со списком похожих: модель сама переспросит или исправится.

**Честность о границах данных.** Если история спреда хранится 7 дней, функция должна это сказать в описании и в ответе (`"data_available_from": "..."`). Иначе модель на вопрос про октябрь ответит «спреда не было».

### 3. Pydantic: схема входа и формат выхода

Один источник правды: Pydantic-модель параметров даёт и JSON-схему для API, и валидацию того, что модель прислала.

```python
from typing import Literal
from pydantic import BaseModel, Field

Period = Literal["day", "week", "month"]

class GetPnlArgs(BaseModel):
    period: Period = Field(
        description="Rolling window ending now: day=24h, week=7d, month=30d"
    )

class PairPnl(BaseModel):
    pair: str = Field(description="SHORT leg / LONG leg, e.g. 'BTC bybit / BTC okx'")
    pnl_usdt: float
    trades: int

class PnlResult(BaseModel):
    period: Period
    date_from: str          # ISO 8601 with timezone
    date_to: str
    total_pnl_usdt: float
    trades: int
    best: PairPnl | None
    worst: PairPnl | None
    note: str = "Funding payments are not included"

# the tool definition for the API (illustrative, Anthropic format)
GET_PNL_TOOL = {
    "name": "get_pnl",
    "description": "...see above...",
    "input_schema": GetPnlArgs.model_json_schema(),
}
```

На стороне вызова: `args = GetPnlArgs.model_validate(tool_input)` → `ValidationError` превращаешь в `tool_result` с `is_error: true` и текстом ошибки. Результат отдаёшь как `result.model_dump_json()`.

Аналогия с TS: это как `zod`-схема, из которой ты получаешь и тип, и рантайм-проверку, и JSON Schema.

### 4. Тестируемость: зависимость от соединения и «сейчас»

Функция, которая внутри себя открывает файл и вызывает `datetime.now()`, тестируется плохо. Передавай зависимости явно:

```python
from datetime import datetime, timedelta, timezone
import sqlite3

def get_pnl(conn: sqlite3.Connection, period: Period,
            now: datetime | None = None) -> PnlResult:
    now = now or datetime.now(timezone.utc)
    start = now - PERIOD_DELTA[period]
    rows = conn.execute(
        """
        SELECT p.formId, p.positionNumber, p.exchange, p.symbol, p.direction,
               p.volume, p.contractSize, p.entryPrice, p.closePrice,
               p.entryFee, p.closeFee, p.dateClosed
        FROM Positions p
        WHERE p.isClosed = 1
          AND p.dateClosed >= ? AND p.dateClosed < ?
        """,
        (to_sqlite_utc(start), to_sqlite_utc(now)),
    ).fetchall()
    ...  # group legs by (formId, positionNumber), sum leg PnL
```

В тесте подставляешь фейковую базу и фиксированное `now` — результат детерминирован. Обёртка для модели (`run_tool(name, input)`) подставит настоящее соединение и `now=None`.

Обрати внимание на `to_sqlite_utc()`: в базе даты — текст `YYYY-MM-DD HH:MM:SS` в UTC (из `current_timestamp`). Сравнение строк работает корректно, только если формат совпадает символ в символ: никаких `T`, `+00:00` и микросекунд.

### 5. Доменная логика: одна функция на одну формулу

PnL ноги — это то место, где модель гарантированно ошиблась бы, если бы считала сама. Поэтому формула живёт в коде:

```python
SIZED_IN_CONTRACTS = {"okx", "gate", "mexc"}

def leg_coins(exchange: str, volume: float, contract_size: float) -> float:
    # mirrors dbPositionCoins() in the arbitrage app
    return volume if exchange in SIZED_IN_CONTRACTS else contract_size * volume

def leg_pnl(direction: str, coins: float, entry: float, close: float,
            entry_fee: float | None, close_fee: float | None) -> float:
    gross = (entry - close) * coins if direction == "SHORT" else (close - entry) * coins
    return gross - (entry_fee or 0) - (close_fee or 0)
```

Проверь знак комиссий в своих данных (AIL-13, разведка): если биржа пишет комиссию отрицательной, формулу надо поправить, и тест это зафиксирует. Ноги без `closePrice` (например, закрытые ликвидацией) не выбрасывай молча: посчитай их отдельно и верни `skipped_legs: N` с пояснением.

### 6. Спред: только из снимка charts.db, только агрегатом

`SpreadBuckets` — 20-секундные корзины: за сутки это ~4300 строк на пару. Модели нужны 5 чисел:

```python
class SpreadStats(BaseModel):
    pair: str
    period: Period
    buckets: int
    open_spread_max: float | None   # max of openHigh, %
    open_spread_max_at: str | None  # ISO time of the max
    open_spread_min: float | None
    open_spread_avg: float | None
    open_spread_last: float | None
    data_available_from: str        # charts keep ~7 days
```

Параметр `pair` модель пришлёт как «BTC» или «ETH bybit okx». Сделай простой резолвер: ищи по базовой монете в `Forms` (не удалённых), и если подходит несколько форм — верни ошибку-подсказку со списком кандидатов («уточни: BTC bybit/okx или BTC gate/binance»). Не выбирай за пользователя молча.

Единицы `time` (секунды или миллисекунды) ты выяснил в AIL-13 — закрепи их константой и тестом.

### 7. Фейковая база

Для тестов и публичного демо нужна база с той же схемой, но выдуманными данными. Требования:

- **Генерируется с нуля, без чтения реальной базы.** Никаких «реальные сделки + шум» — это всё ещё твои реальные данные.
- **Детерминированная:** `random.Random(seed)`, чтобы скриншоты и тесты воспроизводились.
- **Правдоподобная:** 6–8 пар на разных биржах, 60–120 закрытых позиций за 30 дней, 3–5 открытых, PnL то плюс, то минус, пара с ликвидацией, корзины спреда за 7 дней.
- **Минимальная схема:** только таблицы и колонки, которые читают функции. Схему опиши в `scripts/fake_schema.sql` своими руками, по образцу реальной.

Для тестов pytest удобнее не генератор, а маленькая **ручная** фикстура: 3–4 позиции с числами, которые ты посчитаешь на бумаге. Генератор — для демо, фикстура — для проверки формул.

Демо-база здесь — не только для портфолио. Это **единственная база, которую увидят облачные модели** (DeepSeek, а для сравнения Claude/OpenAI): все сравнения моделей в главе 3.3 делаются на ней. Поэтому она должна быть достаточно похожей на реальную по структуре и трудности вопросов (несколько форм с одной монетой, ликвидация, позиция на границе недели), иначе модель, хорошо отвечающая на демо, провалится на реальной копии.

## DeepSeek и Ollama: как это сделать у нас

Сами функции от провайдера не зависят: SQL, Pydantic, PnL и тесты одинаковы. Меняются две вещи — **формат описания инструментов** и **насколько «удобными» они должны быть для слабой модели**.

### Один реестр — два формата

Anthropic принимает инструмент как `{name, description, input_schema}`, а OpenAI, DeepSeek и Ollama — как `{"type": "function", "function": {name, description, parameters}}`. Схема внутри — тот же JSON Schema из Pydantic. Поэтому реестр `TOOLS` остаётся один, а формат выбирается на выходе:

```python
# bot/tools.py (illustrative)
from typing import Literal

def tool_definitions(fmt: Literal["openai", "anthropic"] = "openai") -> list[dict]:
    defs = []
    for name, (args_model, _fn, description) in TOOLS.items():
        schema = args_model.model_json_schema()
        if fmt == "anthropic":
            defs.append({"name": name, "description": description,
                         "input_schema": schema})
        else:  # OpenAI Chat Completions format: DeepSeek, Ollama /v1, OpenAI
            defs.append({"type": "function",
                         "function": {"name": name, "description": description,
                                      "parameters": schema}})
    return defs
```

Python-библиотека `ollama` умеет и сама превращать обычные функции с docstring в схему инструмента (`tools=[get_pnl]`) — удобно для экспериментов, но в проекте источник правды один: Pydantic-модели. Иначе описание в docstring и валидация разъедутся.

### Сравнение: что важно для инструментов

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Поле схемы | `input_schema` | `function.parameters` | `function.parameters` | `function.parameters` |
| Строгое соблюдение схемы | см. главу 2.6 · Tool calling | `strict: true` | `strict: true`, только на бета-адресе `https://api.deepseek.com/beta` | нет: валидация только твоим Pydantic |
| Ограничения strict-схемы | — | все поля в `required`, `additionalProperties: false` | то же; не поддерживаются `minLength`/`maxLength` и `minItems`/`maxItems`; `minimum`/`maximum`, `enum`, `anyOf`, `$ref` — поддерживаются | — |
| Насколько модель прощает туманные описания | сильная модель | сильная модель | сильная модель | маленькая локальная модель — прощает плохо |
| Сколько контекста займут схемы + результаты | не критично | не критично | контекст 1M | **по умолчанию 4k токенов**, если у машины меньше 24 ГБ VRAM ([Context length](https://docs.ollama.com/context-length)) |

Последняя строка — самое неочевидное. На твоём Mac Ollama по умолчанию даёт модели окно в 4096 токенов. Системный промпт + 4 схемы + история + пара результатов легко его переполнят, и модель молча «забудет» начало — например, правило про фандинг. Окно можно расширить (глава 3.3), но память на 8 ГБ не бесконечна. Отсюда практические правила для этой главы:

- **Результаты инструментов ещё компактнее.** Тест `test_result_size` с порогом 2000 символов — не перестраховка: 2000 символов ≈ 500–700 токенов, а результатов в одном ответе бывает два-три.
- **Схемы короткие.** Описание инструмента — 2–4 предложения по-английски (английский токенизируется плотнее и маленькие модели его лучше понимают), описание параметра — одна строка. Посчитай размер: `len(json.dumps(tool_definitions()))` держи в пределах ~3000 символов на все четыре.
- **Меньше свободы — меньше ошибок.** `Literal`/`enum` вместо строк, значения по умолчанию, ни одного необязательного параметра «на будущее». Маленькая модель чаще всего ошибается именно в аргументах: `period="7 days"`, `limit="ten"`. Валидация Pydantic + понятная ошибка в ответ — её страховка.
- **Плоские схемы.** Pydantic кладёт вложенные модели в `$defs` со ссылками `$ref`. DeepSeek strict это поддерживает, а маленькой модели проще с плоским списком примитивных параметров — у нас вложенности во входах и нет, так и держи.

### Если хочешь попробовать strict на DeepSeek (по желанию, только на демо-базе)

Для strict нужно `"strict": true` в каждой функции, `base_url="https://api.deepseek.com/beta"`, все поля в `required` и `"additionalProperties": false`. В Pydantic это `model_config = ConfigDict(extra="forbid")` (даёт `additionalProperties: false`) и поля без значений по умолчанию. Заметь конфликт: у `limit` есть дефолт `10`, и в strict-схеме его придётся сделать обязательным. Для этого проекта strict не нужен — валидацию всё равно делает Pydantic, — но это хорошее упражнение на разницу провайдеров.

### Что использовать в этой главе

- Тесты и функции — без модели вообще: pytest на фикстуре.
- Проверить, что схемы понятны модели, — один-два вызова на **демо-базе**: DeepSeek (`deepseek-flash`) как «эталон сильной модели» и локальная Qwen из главы 3.1 как «та, что будет работать с реальными данными». Если Qwen путает аргументы там, где DeepSeek не путает, — правь описания и типы, а не промпт.

## Маршрут изучения

1. Открой [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → прочитай целиком (≈40 мин). Обрати внимание на разделы про выбор инструментов, именование, возврат осмысленного контекста и экономию токенов, описание как промпт. Выпиши 5 правил, которые применишь к своим 4 функциям.
2. Открой [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) → раздел про определение инструментов и best practices для описаний (≈20 мин). Возьми: формат `input_schema`, советы про подробные описания.
3. Открой [Pydantic docs](https://docs.pydantic.dev/latest/) → Concepts: Models, Fields (`Field(description=...)`), JSON Schema (`model_json_schema`), Serialization (`model_dump`, `model_dump_json`) (≈40 мин).
4. Открой [pytest: Get started](https://docs.pytest.org/en/stable/getting-started.html) → затем How-to «fixtures» и встроенную фикстуру `tmp_path`, `pytest.raises`, `pytest.mark.parametrize` (≈40 мин). Аналогия: фикстура ≈ `beforeEach`, но подключается по имени аргумента.
5. Перечитай в [sqlite3 в Python](https://docs.python.org/3/library/sqlite3.html) раздел про плейсхолдеры и про адаптеры дат (≈10 мин). Возьми: даты передавай строками нужного формата, не объектами `datetime` — встроенные адаптеры дат в Python 3.12 объявлены устаревшими.
6. (По желанию) [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling) → раздел best practices (≈15 мин) — те же принципы с другой стороны. Формат `{"type": "function", "function": {...}}` отсюда же используют DeepSeek и Ollama.
7. Открой [DeepSeek: Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) → формат инструментов и раздел strict mode (Beta): бета-адрес, требования к схеме, какие ключевые слова JSON Schema не поддерживаются (≈15 мин).
8. Открой [Ollama: Tool calling](https://docs.ollama.com/capabilities/tool-calling) → формат `tools`, как Python-библиотека строит схему из функции, сообщение `role: "tool"` (≈15 мин).
9. Открой [Ollama: Context length](https://docs.ollama.com/context-length) → дефолтное окно по объёму видеопамяти и как его посмотреть в `ollama ps` (≈5 мин). Возьми: почему компактные результаты на локальной модели критичны.

## На что обратить внимание

- **Модель не умеет пролистывать.** Если функция вернула 1000 строк, модель либо упрётся в контекст, либо «прочитает» их поверхностно и ошибётся в сумме. Сумму считает код, модель пересказывает.
- **SQL только с плейсхолдерами.** Параметры приходят от модели — это недоверенный ввод. `f"... WHERE symbol = '{pair}'"` — SQL-инъекция даже на read-only базе (чтение лишнего, тяжёлые запросы).
- **Двойная валидация `limit`.** Pydantic: `Field(ge=1, le=20)`; в функции — `min(limit, 20)`. Схему модель иногда нарушает.
- **Границы периода.** «Неделя» — скользящие 7 дней или календарная? Реши, напиши в описании, покрой тестом. Позиция, закрытая ровно на границе, должна попадать ровно в один период (`>=` слева, `<` справа).
- **Строки дат в SQLite** сравниваются лексикографически: `'2026-12-01 09:00:00'` и `'2026-12-01T09:00:00+00:00'` в одном запросе — тихо неверный результат.
- **Float и деньги.** Для отображения хватит `round(x, 2)`, но не сравнивай float на равенство в тестах — `pytest.approx`.
- **Не смешивай ноги.** Позиция, у которой закрыта одна нога, а другая нет — особый случай (naked). Решить, что с ней делать, — твоя задача, а не модели.
- **Удалённые формы** (`isDeleted = 1`) — их позиции остаются в истории. Для PnL их учитывать, для «какие пары сейчас настроены» — нет.
- **Нет функций записи — даже «безобидных».** `save_note`, `mark_as_reviewed`, «переключить автозакрытие» — в этот проект не добавляй ни одной.

## Практика

- [ ] **`bot/models.py`.** Pydantic-модели аргументов (`GetOpenPositionsArgs` пустая, `GetPnlArgs`, `GetSpreadHistoryArgs`, `GetClosedPositionsArgs` с `limit: int = Field(10, ge=1, le=20)`) и результатов (`OpenPositionsResult`, `PnlResult`, `SpreadStats`, `ClosedPositionsResult`). У каждого поля — `description`.
- [ ] **`bot/domain.py`.** `leg_coins`, `leg_pnl`, `to_sqlite_utc(dt)`, `PERIOD_DELTA`. Чистые функции без базы.
- [ ] **`bot/tools.py`.** Четыре функции с сигнатурой `(conn, ..., now=None)`. Скелет:
  ```python
  def get_closed_positions(conn, period: Period, limit: int = 10,
                           now: datetime | None = None) -> ClosedPositionsResult:
      limit = min(limit, 20)
      # 1. select closed legs in [start, now)
      # 2. group by (formId, positionNumber) -> one trade = two legs
      # 3. sort by close time desc, keep `limit`, set total_count/truncated
      ...
  ```
  Плюс реестр для LLM-обёртки:
  ```python
  TOOLS = {
      "get_pnl": (GetPnlArgs, get_pnl, "description for the model..."),
      ...
  }
  def tool_definitions(fmt="openai") -> list[dict]: ...   # OpenAI format by default, "anthropic" for comparison
  ```
- [ ] **Описания инструментов.** Для каждой функции 3–5 предложений: что делает, когда использовать, когда нет, единицы, ограничения (фандинг не учтён; спред только за ~7 дней).
- [ ] **`tests/conftest.py`.** Фикстура `fake_conn(tmp_path)`: создаёт базу по `scripts/fake_schema.sql`, вставляет 3–4 ручные позиции (одна на okx, чтобы проверить contractSize; одна с убытком; одна открытая; одна закрытая ровно на границе недели), возвращает соединение через `open_readonly`.
- [ ] **Тесты (минимум по 2 на функцию):**
  - `test_leg_coins_okx_vs_bybit` — правило contractSize;
  - `test_pnl_week_matches_hand_calc` — с фиксированным `now`, `pytest.approx`;
  - `test_pnl_boundary` — позиция на границе попадает в один период;
  - `test_closed_positions_limit_capped` — `limit=500` → не больше 20, `truncated=True`;
  - `test_spread_unknown_pair` — понятная ошибка со списком кандидатов;
  - `test_empty_period` — пустой результат, не исключение;
  - `test_connection_is_readonly` — `INSERT` падает с `sqlite3.OperationalError`;
  - `test_result_size` — `len(result.model_dump_json()) < 2000` символов для каждой функции на сгенерированной базе;
  - `test_tool_definitions_formats` — в формате `openai` у каждого элемента есть `type == "function"` и `function.parameters`, в формате `anthropic` — `input_schema`; общий размер `json.dumps(tool_definitions())` < 3000 символов.
- [ ] **Проверка схем моделью (только демо-база).** Скрипт `scripts/schema_smoke.py`: отправляет `tool_definitions()` и 4 вопроса (по одному на функцию) в DeepSeek и в локальную Ollama-модель, **без выполнения функций** — только печатает, какой инструмент и с какими аргументами модель выбрала. В вопросах нет твоих данных, но `assert_data_policy` всё равно вызови. Где локальная модель ошиблась в аргументах — правь описание или тип.
- [ ] **`scripts/make_fake_db.py`.** Генератор демо-базы: `--seed`, `--out data/demo_trades.db` и `data/demo_charts.db`, выдуманные пары и цены, без единого чтения реальной базы. В конце печатает итог: позиций, открытых, суммарный PnL.
- [ ] **Прогон глазами.** В `python -i` вызови каждую функцию на демо-базе и на своей копии, посмотри JSON. Спроси себя: «если бы я был моделью и видел только это — смог бы ответить на вопросы из `questions.md`?».

## Готово, когда

- Четыре функции работают на копии и на демо-базе, все покрыты тестами pytest, `pytest` зелёный.
- Каждый результат — Pydantic-модель, компактный (агрегаты, `limit ≤ 20`, округление), с явными ограничениями данных.
- `tool_definitions()` отдаёт корректные схемы с описаниями параметров в формате OpenAI (для DeepSeek и Ollama) и Anthropic (для сравнения), общий размер схем укладывается в бюджет.
- Локальная модель на демо-базе выбирает правильный инструмент и аргументы на 4 контрольных вопросах.
- `make_fake_db.py` генерирует демо-базу с нуля по seed, реальная база в нём не читается.

## Тест для самопроверки

1. Почему функция `get_closed_positions` должна возвращать сделки, уже сложенные из двух ног, а не строки `Positions`?
2. Что лучше для параметра периода и почему?
   a) `period: str`; b) `period: Literal["day","week","month"]`; c) `days: int` без ограничений; d) `period: dict`.
3. Что не так в этом коде?
   ```python
   def get_spread_history(conn, pair, period):
       rows = conn.execute(
           f"SELECT * FROM SpreadBuckets WHERE shortSymbol = '{pair}'"
       ).fetchall()
       return [dict(r) for r in rows]
   ```
4. Зачем передавать в функцию `now` параметром?
5. Модель вызвала `get_closed_positions(period="week", limit=500)`. Что должно произойти?
6. Как сгенерировать фейковую базу «правильно»?
   a) скопировать реальную и умножить цены на 1.1; b) взять реальные сделки и поменять символы; c) сгенерировать с нуля по seed, не читая реальную базу; d) использовать реальную, но не показывать PnL.
7. Позиция закрыта в `2026-12-01 00:00:00` UTC. Период «неделя» = `[now−7d, now)`, `now = 2026-12-08 00:00:00`. Попадает ли она? А при `now = 2026-11-24 00:00:00 + 7d`?
8. Почему описание инструмента — это промпт? Что в нём обязательно должно быть для `get_pnl`?
9. Модель спрашивает спред по «BTC», а в `Forms` три формы с BTC. Что должна вернуть функция?
10. Почему `test_result_size` — полезный тест, а не формальность?
11. Чем описание инструмента для Anthropic отличается от описания для DeepSeek/Ollama? Нужно ли из-за этого два реестра?
12. Почему компактность результатов на локальной Ollama ещё важнее, чем на облачных моделях?
    a) Ollama берёт деньги за токены; b) по умолчанию окно контекста 4k токенов на машинах с < 24 ГБ видеопамяти; c) Ollama не поддерживает JSON; d) локальные модели не умеют суммировать.
13. Ты включил strict mode у DeepSeek, а сервер отклонил схему `GetClosedPositionsArgs`. Назови две вероятные причины.

## Ответы

1. Модель не должна сама группировать ноги и считать PnL позиции — это доменная логика, в которой она ошибётся. Плюс вдвое меньше строк в контексте.
2. **b.** Узкий тип: модель видит допустимые значения в схеме, Pydantic отклонит выдумку, функция знает точные границы.
3. SQL-инъекция через f-строку (нужен плейсхолдер `?`); `SELECT *` без агрегации и лимита — тысячи сырых строк в контекст модели; нет периода; нет учёта бирж обеих ног.
4. Для детерминированных тестов: с фиксированным `now` границы периодов и результат известны заранее.
5. Pydantic с `le=20` отклонит или функция обрежет до 20 (`min(limit, 20)`); результат с `truncated: true` и `total_count`, чтобы модель сообщила, что показано не всё.
6. **c.** Остальные варианты — это всё ещё реальные данные, слегка замаскированные.
7. При `now = 2026-12-08 00:00:00` начало периода `2026-12-01 00:00:00`, `>=` → попадает. Во втором случае `now` тоже `2026-12-01 00:00:00`, а правая граница `<` → не попадает. Ровно в одном периоде, как и нужно.
8. Модель решает, вызывать ли функцию и с какими аргументами, только по имени, описанию и схеме. Для `get_pnl`: что считает (реализованный PnL закрытых позиций), единицы (USDT), что не учтено (фандинг), когда использовать другой инструмент.
9. Ошибку-подсказку со списком кандидатов (биржи ног каждой формы), чтобы модель уточнила у пользователя, а не выбрала молча.
10. Он ловит регрессию «функция вдруг стала возвращать сырые строки» — это напрямую стоимость и качество ответов, а сама по себе такая ошибка ничего не ломает и незаметна.
11. У Anthropic: `{name, description, input_schema}`; у OpenAI-совместимых: `{"type": "function", "function": {name, description, parameters}}`. Схема внутри одна (из Pydantic), поэтому реестр один, а формат выбирается в `tool_definitions(fmt)`.
12. **b.** Системный промпт, схемы, история и результаты легко переполняют 4k, и модель теряет начало контекста. Окно можно расширить, но это память, которой на 8 ГБ мало.
13. Не все поля в `required` (у `limit` есть значение по умолчанию) и/или нет `"additionalProperties": false`; ещё вариант — неподдерживаемые ключевые слова (`minLength`, `maxItems`) или запрос не на бета-адрес `/beta`.

## Что дальше

В AIL-15 «Проект 1: tool calling + Telegram» ты подключишь эти функции к модели через `call_llm()` и к aiogram-боту, доступному только тебе.
