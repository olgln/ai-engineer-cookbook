# 3.2 · Проект 1: функции только для чтения  (AIL-14)

> **Неделя 3** · Основы LLM · ⏱ ~5 ч · Проект

## Зачем это AI-инженеру

Инструменты — это интерфейс между моделью и нашей системой, и от их качества зависит больше, чем от промпта. Модель видит только имя, описание и JSON-схему параметров; если функция называется туманно или возвращает 1000 строк, модель будет ошибаться и тратить деньги. На собеседованиях про агентов вопрос «как вы проектируете tools» звучит постоянно, и правильный ответ — «как публичный API для не очень внимательного, но очень старательного клиента».

⚠️ **Только чтение.** Никаких функций, которые меняют заказы, оформляют возвраты или выдают промокоды, и никаких запросов к платёжным провайдерам и службам доставки с ключами — только копия базы.

## Теория

Цикл tool calling мы уже разобрали в AIL-10, Pydantic-модели — в AIL-8. Здесь — как проектировать **сами функции** для настоящего проекта: Telegram-бота «аналитик магазина» для владельца «Полки» (`projects/01-shop-analyst-bot/`).

### 1. Четыре функции

| Функция | Вопросы, на которые отвечает | Что возвращает |
|---|---|---|
| `get_open_orders()` | «какие заказы сейчас в работе?», «что зависло?» | число заказов по статусам, самые старые незавершённые |
| `get_sales(period)` | «какая выручка за неделю?» | выручка, прибыль, число заказов, средний чек, лучшая/худшая категория |
| `get_product_interest(product, period)` | «какой товар смотрят, но не покупают?» | просмотры, добавления в корзину, пиковый час, заказы — только агрегаты |
| `get_recent_orders(period, limit)` | «покажи последние заказы» | до `limit` заказов, уже собранных из их позиций |

Обратим внимание: **ни одна функция не возвращает «строки таблицы»**. Каждая возвращает ответ на класс вопросов: агрегат или короткий список. Это главное правило проектирования tools.

### 2. Принципы хорошего инструмента

**Одна функция — одна понятная задача.** Модель хорошо выбирает между 4–10 непохожими инструментами и плохо — между 30 похожими. Если два инструмента различаются одним флагом, это один инструмент с параметром.

**Имя и описание пишутся для модели.** Описание — это промпт. В нём: что делает, когда использовать, когда *не* использовать, единицы измерения, ограничения данных.

```text
get_sales: Revenue and profit of paid orders for a period, in RUB.
Refunded and cancelled orders are excluded. Profit = item amounts - item
costs - discounts - payment fees; it does NOT include actual delivery expenses.
Use for questions about revenue, profit, average check. For a list of
individual orders use get_recent_orders instead.
```

**Параметры — узкие типы.** `period: Literal["day", "week", "month"]` лучше, чем `period: str`: модель не придумает `"last fortnight"`, а схема сама подскажет варианты. Каждый параметр — с `description`.

**Компактный выход.** Не отдаём модели 1000 строк — агрегируем и ограничиваем выдачу, иначе дорого и модель теряется. Каждый токен результата мы оплачиваем как input, причём на каждом следующем шаге цикла снова. Практические правила:
- агрегаты вместо строк;
- жёсткий потолок `limit` (например, `≤ 20`), даже если модель попросила 500;
- округление: деньги до 2 знаков, проценты до 1 знака, граммы — целыми;
- даты в ISO 8601 и с указанием часового пояса;
- поле `truncated: true` / `total_count`, если показано не всё — модель скажет «показал 20 из 143».

**Ошибки — данными, а не исключениями наружу.** Пустой результат — не ошибка: `{"orders": [], "note": "no open orders"}`. Неизвестный товар — понятное сообщение со списком похожих: модель сама переспросит или исправится.

**Честность о границах данных.** Если `product_stats` хранит 30 дней, функция должна сказать это в описании и в ответе (`"data_available_from": "..."`). Иначе на вопрос про прошлый квартал модель ответит «товар никто не смотрел».

### 3. Pydantic: схема входа и формат выхода

Один источник правды: Pydantic-модель параметров даёт и JSON-схему для API, и валидацию того, что модель прислала.

```python
from typing import Literal
from pydantic import BaseModel, Field

Period = Literal["day", "week", "month"]

class GetSalesArgs(BaseModel):
    period: Period = Field(
        description="Rolling window ending now: day=24h, week=7d, month=30d"
    )

class CategorySales(BaseModel):
    category: str = Field(description="Product category, e.g. 'mug', 'tea'")
    revenue_rub: float
    orders: int

class SalesResult(BaseModel):
    period: Period
    date_from: str          # ISO 8601 with timezone
    date_to: str
    revenue_rub: float
    profit_rub: float
    orders: int
    avg_check_rub: float | None
    best: CategorySales | None
    worst: CategorySales | None
    note: str = "Profit is before delivery expenses (not in the database)"

# the tool definition for the API (illustrative, Anthropic format)
GET_SALES_TOOL = {
    "name": "get_sales",
    "description": "...see above...",
    "input_schema": GetSalesArgs.model_json_schema(),
}
```

На стороне вызова: `args = GetSalesArgs.model_validate(tool_input)` → `ValidationError` превращаем в `tool_result` с `is_error: true` и текстом ошибки. Результат отдаём как `result.model_dump_json()`.

Похожие библиотеки есть во многих языках (например, zod в JavaScript): одна схема даёт и тип, и рантайм-проверку, и JSON Schema.

### 4. Тестируемость: зависимость от соединения и «сейчас»

Функция, которая внутри себя открывает файл и вызывает `datetime.now()`, тестируется плохо. Зависимости передаём явно:

```python
from datetime import datetime, timedelta, timezone
import sqlite3

def get_sales(conn: sqlite3.Connection, period: Period,
              now: datetime | None = None) -> SalesResult:
    now = now or datetime.now(timezone.utc)
    start = now - PERIOD_DELTA[period]
    rows = conn.execute(
        """
        SELECT o.id, o.discount, o.delivery_cost, o.paid_at,
               (SELECT SUM(fee) FROM payments
                 WHERE order_id = o.id AND status = 'succeeded') AS fee,
               p.unit, p.category, i.quantity, i.unit_price, i.unit_cost
        FROM orders o
        JOIN order_items i ON i.order_id = o.id
        JOIN products p ON p.id = i.product_id
        WHERE o.status NOT IN ('cancelled', 'refunded')
          AND o.paid_at >= ? AND o.paid_at < ?
        """,
        (to_sqlite_utc(start), to_sqlite_utc(now)),
    ).fetchall()
    ...  # group rows by o.id (one order = several items), order_total / order_profit
```

В тесте подставляем фейковую базу и фиксированное `now` — результат детерминирован. Обёртка для модели (`run_tool(name, input)`) подставит настоящее соединение и `now=None`.

Обратим внимание на `to_sqlite_utc()`: в базе даты — текст `YYYY-MM-DD HH:MM:SS` в UTC (формат `current_timestamp`). Сравнение строк работает корректно, только если формат совпадает символ в символ: никаких `T`, `+00:00` и микросекунд.

### 5. Доменная логика: одна функция на одну формулу

Сумма позиции и прибыль заказа — то место, где модель гарантированно ошиблась бы, если бы считала сама. Поэтому формулы живут в коде:

```python
def item_amount(unit: str, quantity: float, unit_price: float) -> float:
    # 'pcs': quantity in pieces, price per piece
    # 'g': quantity in grams, price per 100 g (250 g at 640 -> 1600.0)
    return quantity * unit_price / 100 if unit == "g" else quantity * unit_price

def order_total(items: list[tuple[str, float, float, float]],
                discount: float | None, delivery_cost: float | None) -> float:
    # items: (unit, quantity, unit_price, unit_cost)
    goods = sum(item_amount(u, q, price) for u, q, price, _cost in items)
    return goods - (discount or 0) + (delivery_cost or 0)

def order_profit(items: list[tuple[str, float, float, float]],
                 discount: float | None, fee: float | None) -> float:
    # unit_cost uses the same unit rule as unit_price
    gross = sum(item_amount(u, q, price) - item_amount(u, q, cost)
                for u, q, price, cost in items)
    return gross - (discount or 0) - (fee or 0)
```

Проверим знак скидки и комиссии в своих данных (AIL-13, разведка): если скидка записана отрицательным числом, формулу надо поправить, и тест это зафиксирует. Позиции без себестоимости (`unit_cost IS NULL`, если такие встречаются) не выбрасываем молча: считаем их отдельно и возвращаем `skipped_items: N` с пояснением.

### 6. Интерес к товару: только из снимка analytics.db, только агрегатом

`product_stats` — часовые корзины: за месяц это 720 строк на товар. Модели нужны несколько чисел:

```python
class ProductInterest(BaseModel):
    product: str
    period: Period
    buckets: int
    views: int
    cart_adds: int
    cart_rate_pct: float | None     # cart_adds / views, %
    peak_hour: str | None           # ISO time of the hour with most views
    orders: int                     # paid orders with this product
    data_available_from: str        # product_stats keeps 30 days
```

Параметр `product` модель пришлёт как «кружка» или «Север». Делаем простой резолвер: ищем по названию и `sku` среди товаров в продаже (`is_active = 1`), и если подходит несколько — возвращаем ошибку-подсказку со списком кандидатов («уточните: Кружка „Север“ (MUG-SEVER) или Кружка „Юг“ (MUG-YUG)»). Не выбираем за пользователя молча. Сравнение — в Python через `casefold()`: встроенные `LOWER()` и `LIKE` в SQLite не меняют регистр кириллицы.

Единицы `time` (секунды или миллисекунды) мы выяснили в AIL-13 — закрепляем их константой и тестом.

### 7. Фейковая база

Для тестов и публичного демо нужна база с той же схемой, но выдуманными данными. Требования:

- **Генерируется с нуля, без чтения живой базы.** Никаких «заказы из живой базы + шум» — это всё ещё данные клиентов. Что у нас и живая база сгенерирована (AIL-13), не важно: обращаемся с ней как с настоящей — эта привычка понадобится на работе.
- **Детерминированная:** `random.Random(seed)`, чтобы скриншоты и тесты воспроизводились.
- **Правдоподобная:** 8–12 товаров в 4–5 категориях, 150–300 заказов за 30 дней, несколько незавершённых, возвраты и отмены, чай и кофе на вес, товары с похожими названиями, часовые корзины `product_stats` за 30 дней.
- **Минимальная схема:** только таблицы и колонки, которые читают функции, — `customers`, `shipments` и `events` в демо нет совсем. Схему описываем в `scripts/fake_schema.sql` своими руками, по образцу живой.

Для тестов pytest удобнее не генератор, а маленькая **ручная** фикстура: 3–4 заказа с числами, которые мы посчитаем на бумаге. Генератор — для демо, фикстура — для проверки формул.

Демо-база здесь — не только для портфолио. Это **единственная база, которую увидят облачные модели** (DeepSeek, а для сравнения Claude/OpenAI): все сравнения моделей в главе 3.3 делаются на ней. Поэтому она должна быть достаточно похожей на живую по структуре и трудности вопросов (несколько кружек с похожими названиями, товары на вес, возврат, заказ на границе недели), иначе модель, хорошо отвечающая на демо, провалится на снимке. У кого есть собственные данные магазина и право их использовать, может работать со снимком своей базы вместо сгенерированной — правило то же: облако видит только демо.

## DeepSeek и Ollama: как это сделать у нас

Сами функции от провайдера не зависят: SQL, Pydantic, формулы и тесты одинаковы. Меняются две вещи — **формат описания инструментов** и **насколько «удобными» они должны быть для слабой модели**.

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

Python-библиотека `ollama` умеет и сама превращать обычные функции с docstring в схему инструмента (`tools=[get_sales]`) — удобно для экспериментов, но в проекте источник правды один: Pydantic-модели. Иначе описание в docstring и валидация разъедутся.

### Сравнение: что важно для инструментов

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Поле схемы | `input_schema` | `function.parameters` | `function.parameters` | `function.parameters` |
| Строгое соблюдение схемы | см. главу 2.6 · Tool calling | `strict: true` | `strict: true`, только на бета-адресе `https://api.deepseek.com/beta` | нет: валидация только нашим Pydantic |
| Ограничения strict-схемы | — | все поля в `required`, `additionalProperties: false` | то же; не поддерживаются `minLength`/`maxLength` и `minItems`/`maxItems`; `minimum`/`maximum`, `enum`, `anyOf`, `$ref` — поддерживаются | — |
| Насколько модель прощает туманные описания | сильная модель | сильная модель | сильная модель | маленькая локальная модель — прощает плохо |
| Сколько контекста займут схемы + результаты | не критично | не критично | контекст 1M | **по умолчанию 4k токенов**, если у машины меньше 24 ГБ VRAM ([Context length](https://docs.ollama.com/context-length)) |

Последняя строка — самое неочевидное. На обычном ноутбуке без мощной видеокарты Ollama по умолчанию даёт модели окно в 4096 токенов. Системный промпт + 4 схемы + история + пара результатов легко его переполнят, и модель молча «забудет» начало — например, правило про расходы на доставку. Окно можно расширить (глава 3.3), но память машины не бесконечна, особенно на 8 ГБ RAM. Отсюда практические правила для этой главы:

- **Результаты инструментов ещё компактнее.** Тест `test_result_size` с порогом 2000 символов — не перестраховка: 2000 символов ≈ 500–700 токенов, а результатов в одном ответе бывает два-три.
- **Схемы короткие.** Описание инструмента — 2–4 предложения по-английски (английский токенизируется плотнее и маленькие модели его лучше понимают), описание параметра — одна строка. Считаем размер: `len(json.dumps(tool_definitions()))` держим в пределах ~3000 символов на все четыре.
- **Меньше свободы — меньше ошибок.** `Literal`/`enum` вместо строк, значения по умолчанию, ни одного необязательного параметра «на будущее». Маленькая модель чаще всего ошибается именно в аргументах: `period="7 days"`, `limit="ten"`. Валидация Pydantic + понятная ошибка в ответ — её страховка.
- **Плоские схемы.** Pydantic кладёт вложенные модели в `$defs` со ссылками `$ref`. DeepSeek strict это поддерживает, а маленькой модели проще с плоским списком примитивных параметров — у нас вложенности во входах и нет, так и держим.

### Если хочется попробовать strict на DeepSeek (по желанию, только на демо-базе)

Для strict нужно `"strict": true` в каждой функции, `base_url="https://api.deepseek.com/beta"`, все поля в `required` и `"additionalProperties": false`. В Pydantic это `model_config = ConfigDict(extra="forbid")` (даёт `additionalProperties: false`) и поля без значений по умолчанию. Заметим конфликт: у `limit` есть дефолт `10`, и в strict-схеме его придётся сделать обязательным. Для этого проекта strict не нужен — валидацию всё равно делает Pydantic, — но это хорошее упражнение на разницу провайдеров.

### Что использовать в этой главе

- Тесты и функции — без модели вообще: pytest на фикстуре.
- Проверить, что схемы понятны модели, — один-два вызова на **демо-базе**: DeepSeek (`deepseek-flash`) как «эталон сильной модели» и локальная Qwen из главы 3.1 как «та, что будет работать со снимком с данными клиентов». Если Qwen путает аргументы там, где DeepSeek не путает, — правим описания и типы, а не промпт.

## Маршрут изучения

1. Открываем [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → читаем целиком (≈40 мин). Обратим внимание на разделы про выбор инструментов, именование, возврат осмысленного контекста и экономию токенов, описание как промпт. Выписываем 5 правил, которые применим к своим 4 функциям.
2. Открываем [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) → раздел про определение инструментов и best practices для описаний (≈20 мин). Берём: формат `input_schema`, советы про подробные описания.
3. Открываем [Pydantic docs](https://docs.pydantic.dev/latest/) → Concepts: Models, Fields (`Field(description=...)`), JSON Schema (`model_json_schema`), Serialization (`model_dump`, `model_dump_json`) (≈40 мин).
4. Открываем [pytest: Get started](https://docs.pytest.org/en/stable/getting-started.html) → затем How-to «fixtures» и встроенную фикстуру `tmp_path`, `pytest.raises`, `pytest.mark.parametrize` (≈40 мин). Аналогия: фикстура похожа на setup-метод из xUnit-фреймворков, но подключается по имени аргумента.
5. Перечитываем в [sqlite3 в Python](https://docs.python.org/3/library/sqlite3.html) раздел про плейсхолдеры и про адаптеры дат (≈10 мин). Берём: даты передаём строками нужного формата, не объектами `datetime` — встроенные адаптеры дат в Python 3.12 объявлены устаревшими.
6. (По желанию) [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling) → раздел best practices (≈15 мин) — те же принципы с другой стороны. Формат `{"type": "function", "function": {...}}` отсюда же используют DeepSeek и Ollama.
7. Открываем [DeepSeek: Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) → формат инструментов и раздел strict mode (Beta): бета-адрес, требования к схеме, какие ключевые слова JSON Schema не поддерживаются (≈15 мин).
8. Открываем [Ollama: Tool calling](https://docs.ollama.com/capabilities/tool-calling) → формат `tools`, как Python-библиотека строит схему из функции, сообщение `role: "tool"` (≈15 мин).
9. Открываем [Ollama: Context length](https://docs.ollama.com/context-length) → дефолтное окно по объёму видеопамяти и как его посмотреть в `ollama ps` (≈5 мин). Берём: почему компактные результаты на локальной модели критичны.

## На что обратить внимание

- **Модель не умеет пролистывать.** Если функция вернула 1000 строк, модель либо упрётся в контекст, либо «прочитает» их поверхностно и ошибётся в сумме. Сумму считает код, модель пересказывает.
- **SQL только с плейсхолдерами.** Параметры приходят от модели — это недоверенный ввод. `f"... WHERE name = '{product}'"` — SQL-инъекция даже на read-only базе (чтение лишнего, тяжёлые запросы).
- **Двойная валидация `limit`.** Pydantic: `Field(ge=1, le=20)`; в функции — `min(limit, 20)`. Схему модель иногда нарушает.
- **Границы периода.** «Неделя» — скользящие 7 дней или календарная? Решаем, пишем в описании, покрываем тестом. Заказ, оплаченный ровно на границе, должен попадать ровно в один период (`>=` слева, `<` справа).
- **Строки дат в SQLite** сравниваются лексикографически: `'2026-12-01 09:00:00'` и `'2026-12-01T09:00:00+00:00'` в одном запросе — тихо неверный результат.
- **Float и деньги.** Для отображения хватит `round(x, 2)`, но float в тестах на равенство не сравниваем — `pytest.approx`.
- **Граммы и штуки.** Количество чая `250` — это граммы, а цена — за 100 г. Сумму позиции считает только `item_amount`; ни SQL, ни модель не умножают `quantity * unit_price` напрямую.
- **Заказ без платежа или с двумя платежами.** Заказ в статусе `paid`, у которого в `payments` нет успешного платежа (или их два), — особый случай. Решить, что с ним делать, — наша задача, а не модели.
- **Снятые с продажи товары** (`is_active = 0`) — их заказы остаются в истории. Для выручки их учитываем, для резолвера «какие товары сейчас продаются» — нет.
- **Нет функций записи — даже «безобидных».** `save_note`, `mark_as_reviewed`, «выдать промокод» — в этот проект не добавляем ни одной.

## Практика

- [ ] **`bot/models.py`.** Pydantic-модели аргументов (`GetOpenOrdersArgs` пустая, `GetSalesArgs`, `GetProductInterestArgs`, `GetRecentOrdersArgs` с `limit: int = Field(10, ge=1, le=20)`) и результатов (`OpenOrdersResult`, `SalesResult`, `ProductInterest`, `RecentOrdersResult`). У каждого поля — `description`.
- [ ] **`bot/domain.py`.** `item_amount`, `order_total`, `order_profit`, `to_sqlite_utc(dt)`, `PERIOD_DELTA`. Чистые функции без базы.
- [ ] **`bot/tools.py`.** Четыре функции с сигнатурой `(conn, ..., now=None)`. Скелет:
  ```python
  def get_recent_orders(conn, period: Period, limit: int = 10,
                        now: datetime | None = None) -> RecentOrdersResult:
      limit = min(limit, 20)
      # 1. select orders created in [start, now) with their items
      # 2. group by order id -> one order = several order_items rows
      # 3. sort by created_at desc, keep `limit`, set total_count/truncated
      ...
  ```
  Плюс реестр для LLM-обёртки:
  ```python
  TOOLS = {
      "get_sales": (GetSalesArgs, get_sales, "description for the model..."),
      ...
  }
  def tool_definitions(fmt="openai") -> list[dict]: ...   # OpenAI format by default, "anthropic" for comparison
  ```
- [ ] **Описания инструментов.** Для каждой функции 3–5 предложений: что делает, когда использовать, когда нет, единицы, ограничения (расходы на доставку не учтены; интерес к товарам только за 30 дней).
- [ ] **`tests/conftest.py`.** Фикстура `fake_conn(tmp_path)`: создаёт базу по `scripts/fake_schema.sql`, вставляет 3–4 ручных заказа (один с чаем на вес, чтобы проверить правило «цена за 100 г»; один возвращённый; один незавершённый; один оплаченный ровно на границе недели), возвращает соединение через `open_readonly`.
- [ ] **Тесты (минимум по 2 на функцию):**
  - `test_item_amount_grams_vs_pieces` — правило «цена за 100 г»;
  - `test_sales_week_matches_hand_calc` — с фиксированным `now`, `pytest.approx`;
  - `test_sales_boundary` — заказ на границе попадает в один период;
  - `test_recent_orders_limit_capped` — `limit=500` → не больше 20, `truncated=True`;
  - `test_interest_ambiguous_product` — понятная ошибка со списком кандидатов;
  - `test_empty_period` — пустой результат, не исключение;
  - `test_connection_is_readonly` — `INSERT` падает с `sqlite3.OperationalError`;
  - `test_result_size` — `len(result.model_dump_json()) < 2000` символов для каждой функции на сгенерированной базе;
  - `test_tool_definitions_formats` — в формате `openai` у каждого элемента есть `type == "function"` и `function.parameters`, в формате `anthropic` — `input_schema`; общий размер `json.dumps(tool_definitions())` < 3000 символов.
- [ ] **Проверка схем моделью (только демо-база).** Скрипт `scripts/schema_smoke.py`: отправляет `tool_definitions()` и 4 вопроса (по одному на функцию) в DeepSeek и в локальную Ollama-модель, **без выполнения функций** — только печатает, какой инструмент и с какими аргументами модель выбрала. В вопросах нет данных магазина, но `assert_data_policy` всё равно вызываем. Где локальная модель ошиблась в аргументах — правим описание или тип.
- [ ] **`scripts/make_fake_db.py`.** Генератор демо-базы: `--seed`, `--out data/demo_shop.db` и `data/demo_analytics.db`, выдуманные товары и цены, без единого чтения живой базы. В конце печатает итог: заказов, незавершённых, суммарные выручка и прибыль.
- [ ] **Прогон глазами.** В `python -i` вызываем каждую функцию на демо-базе и на снимке `data/shop.db`, смотрим JSON. Спрашиваем себя: «если бы мы были моделью и видели только это — смогли бы ответить на вопросы из `questions.md`?».

## Готово, когда

- Четыре функции работают на снимке и на демо-базе, все покрыты тестами pytest, `pytest` зелёный.
- Каждый результат — Pydantic-модель, компактный (агрегаты, `limit ≤ 20`, округление), с явными ограничениями данных.
- `tool_definitions()` отдаёт корректные схемы с описаниями параметров в формате OpenAI (для DeepSeek и Ollama) и Anthropic (для сравнения), общий размер схем укладывается в бюджет.
- Локальная модель на демо-базе выбирает правильный инструмент и аргументы на 4 контрольных вопросах.
- `make_fake_db.py` генерирует демо-базу с нуля по seed, живая база в нём не читается.

## Тест для самопроверки

1. Почему функция `get_recent_orders` должна возвращать заказы, уже собранные из позиций, а не строки `order_items`?
2. Что лучше для параметра периода и почему?
   a) `period: str`; b) `period: Literal["day","week","month"]`; c) `days: int` без ограничений; d) `period: dict`.
3. Что не так в этом коде?
   ```python
   def get_product_interest(conn, product, period):
       rows = conn.execute(
           f"SELECT * FROM product_stats WHERE product_id = '{product}'"
       ).fetchall()
       return [dict(r) for r in rows]
   ```
4. Зачем передавать в функцию `now` параметром?
5. Модель вызвала `get_recent_orders(period="week", limit=500)`. Что должно произойти?
6. Как сгенерировать фейковую базу «правильно»?
   a) скопировать живую и умножить цены на 1.1; b) взять настоящие заказы и поменять имена клиентов; c) сгенерировать с нуля по seed, не читая живую базу; d) использовать живую, но не показывать email и телефоны.
7. Заказ оплачен в `2026-12-01 00:00:00` UTC. Период «неделя» = `[now−7d, now)`, `now = 2026-12-08 00:00:00`. Попадает ли он? А при `now = 2026-11-24 00:00:00 + 7d`?
8. Почему описание инструмента — это промпт? Что в нём обязательно должно быть для `get_sales`?
9. Модель спрашивает интерес к товару «кружка», а в `products` три кружки. Что должна вернуть функция?
10. Почему `test_result_size` — полезный тест, а не формальность?
11. Чем описание инструмента для Anthropic отличается от описания для DeepSeek/Ollama? Нужно ли из-за этого два реестра?
12. Почему компактность результатов на локальной Ollama ещё важнее, чем на облачных моделях?
    a) Ollama берёт деньги за токены; b) по умолчанию окно контекста 4k токенов на машинах с < 24 ГБ видеопамяти; c) Ollama не поддерживает JSON; d) локальные модели не умеют суммировать.
13. В DeepSeek включён strict mode, а сервер отклонил схему `GetRecentOrdersArgs`. Назовите две вероятные причины.

## Ответы

1. Модель не должна сама группировать позиции и считать сумму заказа — это доменная логика (граммы и штуки, скидка, доставка), в которой она ошибётся. Плюс в несколько раз меньше строк в контексте.
2. **b.** Узкий тип: модель видит допустимые значения в схеме, Pydantic отклонит выдумку, функция знает точные границы.
3. SQL-инъекция через f-строку (нужен плейсхолдер `?`); `SELECT *` без агрегации и лимита — сотни сырых часовых строк в контекст модели; нет периода; название товара не превращается в `product_id` через резолвер, и неоднозначность («кружка») не проверяется.
4. Для детерминированных тестов: с фиксированным `now` границы периодов и результат известны заранее.
5. Pydantic с `le=20` отклонит или функция обрежет до 20 (`min(limit, 20)`); результат с `truncated: true` и `total_count`, чтобы модель сообщила, что показано не всё.
6. **c.** Остальные варианты — это всё ещё настоящие данные, слегка замаскированные.
7. При `now = 2026-12-08 00:00:00` начало периода `2026-12-01 00:00:00`, `>=` → попадает. Во втором случае `now` тоже `2026-12-01 00:00:00`, а правая граница `<` → не попадает. Ровно в одном периоде, как и нужно.
8. Модель решает, вызывать ли функцию и с какими аргументами, только по имени, описанию и схеме. Для `get_sales`: что считает (выручку и прибыль оплаченных заказов, без возвратов и отмен), единицы (рубли), что не учтено (фактические расходы на доставку), когда использовать другой инструмент.
9. Ошибку-подсказку со списком кандидатов (название и `sku` каждой кружки), чтобы модель уточнила у пользователя, а не выбрала молча.
10. Он ловит регрессию «функция вдруг стала возвращать сырые строки» — это напрямую стоимость и качество ответов, а сама по себе такая ошибка ничего не ломает и незаметна.
11. У Anthropic: `{name, description, input_schema}`; у OpenAI-совместимых: `{"type": "function", "function": {name, description, parameters}}`. Схема внутри одна (из Pydantic), поэтому реестр один, а формат выбирается в `tool_definitions(fmt)`.
12. **b.** Системный промпт, схемы, история и результаты легко переполняют 4k, и модель теряет начало контекста. Окно можно расширить, но это память, которой на машине с 8 ГБ мало.
13. Не все поля в `required` (у `limit` есть значение по умолчанию) и/или нет `"additionalProperties": false`; ещё вариант — неподдерживаемые ключевые слова (`minLength`, `maxItems`) или запрос не на бета-адрес `/beta`.

## Что дальше

В AIL-15 «Проект 1: tool calling + Telegram» подключим эти функции к модели через `call_llm()` и к aiogram-боту, доступному только владельцу магазина.
