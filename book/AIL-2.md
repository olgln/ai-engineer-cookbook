# 1.3 · Python: uv, async, Pydantic  (AIL-2)

> **Неделя 1** · Подготовка · ⏱ ~4 ч · Практика

<!-- description: Инструменты Python-проекта для работы с LLM: uv и Ruff, asyncio и httpx для параллельных запросов, Pydantic для валидации, pytest и отладка в VS Code. -->

## Зачем это AI-инженеру

Любой LLM-проект — это окружение с зависимостями (uv), много сетевых вызовов, которые надо делать параллельно и с ограничением частоты (asyncio + httpx), и данные, которые нельзя принимать на веру (Pydantic). Ограничение частоты нужно потому, что у каждого провайдера есть rate limit — предел числа запросов в единицу времени или одновременных запросов. Pydantic особенно важен: из его моделей строится JSON Schema (стандартное описание формы JSON-документа) для structured output — ответа модели строго по заданной схеме — и для tool calling, где модель просит вызвать нашу функцию с аргументами по схеме (обе темы — неделя 2); им же валидируется ответ модели.

В главе 1.1 мы писали скрипты на системном `python3`; теперь заводим настоящий проект и проходим по порядку: окружение и зависимости, линтер, асинхронные запросы, валидация данных, тесты и отладка. Тесты (pytest) и линтер (Ruff) — то, по чему на ревью отличают инженера от «скрипта из чата».

## Теория

### 1. uv — менеджер проекта и версий Python в одном

В Python пакеты ставятся не в папку проекта, а в **виртуальное окружение** — изолированную копию интерпретатора с собственной `site-packages`. Без него все проекты делили бы одни версии библиотек. uv создаёт и обслуживает это окружение сам.

Для ориентира — соответствия с npm (в Maven, Cargo или Go modules роли те же):

| npm | uv | Что делает |
|---|---|---|
| `npm init` | `uv init name` | создаёт `pyproject.toml`, `.python-version`, `main.py`, git |
| `package.json` | `pyproject.toml` | метаданные и зависимости |
| `package-lock.json` | `uv.lock` | точные версии, коммитится |
| `node_modules/` | `.venv/` | установленные пакеты, в `.gitignore` |
| `npm install x` | `uv add x` | добавить зависимость |
| `npm install -D x` | `uv add --dev x` | dev-зависимость (pytest, ruff) |
| `npm ci` | `uv sync` | привести `.venv` в соответствие с lock |
| `npx x` / `npm run` | `uv run x` | запустить внутри окружения |
| nvm | `uv python install 3.12` | установить нужную версию Python |

Сам uv ставится одной командой по [официальной инструкции](https://docs.astral.sh/uv/getting-started/installation/) для своей ОС; проверка — `uv --version`.

`uv run` перед запуском сам проверяет, что окружение синхронизировано с lock-файлом, — поэтому «активировать» `.venv` вручную не нужно. Глобальный `pip install` не используем: он ставит пакет в системный Python, и через месяц непонятно, что откуда.

```toml
# pyproject.toml after `uv add httpx pydantic` and `uv add --dev pytest ruff`
[project]
name = "learn-python"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["httpx>=0.28", "pydantic>=2.10"]   # versions illustrative

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.8"]
```

Точный вид секций и версий у нас получится свой — смотрим, что сгенерировал uv.

### 2. Ruff — линтер и форматтер

Первые dev-зависимости проекта — инструменты контроля качества. Ruff заменяет сразу линтер и форматтер (в мире JavaScript — ESLint и Prettier). `uv run ruff check .` — линтер (неиспользуемые импорты, подозрительные конструкции), `uv run ruff check --fix .` — автоисправление, `uv run ruff format .` — форматтер. Настройки — в `pyproject.toml` в секции `[tool.ruff]`. По умолчанию включён умеренный набор правил; полезно добавить импорт-сортировку и «bugbear»:

```toml
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]   # pycodestyle, pyflakes, isort, bugbear, pyupgrade
```

Правило `B006` из bugbear ловит изменяемый default из AIL-1 — хороший пример, зачем нужен линтер для кода от модели.

### 3. asyncio — event loop, который надо включить самому

LLM-приложение большую часть времени ждёт сеть: один ответ модели — это секунды. Если отправлять 100 запросов по очереди, ожидания складываются; асинхронный код позволяет ждать их одновременно. В некоторых средах (JavaScript в браузере и Node) event loop есть всегда. В Python код синхронный, пока мы явно не запустим цикл:

```python
import asyncio

async def fetch_one(i: int) -> int:     # coroutine function
    await asyncio.sleep(1)              # non-blocking wait
    return i

async def main() -> None:
    results = await asyncio.gather(*(fetch_one(i) for i in range(5)))
    print(results)                      # [0, 1, 2, 3, 4] after ~1 s, not 5

asyncio.run(main())                     # start the loop, run main, close the loop
```

Соответствия с JavaScript, где async/await знаком большинству:

| JavaScript | Python |
|---|---|
| `async function` | `async def` |
| `Promise` | coroutine / `Task` |
| `await p` | `await coro` |
| `Promise.all([...])` | `asyncio.gather(*coros)` |
| `Promise.allSettled` | `asyncio.gather(*coros, return_exceptions=True)` |
| `setTimeout` (ожидание) | `await asyncio.sleep(s)` |
| `AbortSignal.timeout` | `async with asyncio.timeout(s):` (3.11+) |
| p-limit | `asyncio.Semaphore(n)` |

Ключевое отличие: **вызов `fetch_one(1)` ничего не запускает** — он возвращает объект-корутину. Промис в JS начинает выполняться сразу, корутина — только когда её `await`-ят или оборачивают в задачу (`asyncio.create_task`, `gather`). Забытый `await` даёт предупреждение `coroutine ... was never awaited` и тихо пропущенную работу.

**Блокирующие вызовы убивают параллельность.** Внутри `async def` нельзя `time.sleep()`, `requests.get()`, тяжёлый синхронный расчёт: они останавливают весь цикл, как бесконечный `while` в однопоточном event loop. Для блокирующего кода — `await asyncio.to_thread(func, *args)`.

**Семафор** ограничивает число одновременных запросов — без него `gather` на 1000 вызовов LLM мгновенно упрётся в rate limit провайдера. В примере `client` — HTTP-клиент из следующего раздела, а `async with` — асинхронный вариант `with` из AIL-1: вход в блок может ждать, пока освободится место:

```python
sem = asyncio.Semaphore(5)

async def limited(client, url):
    async with sem:                     # at most 5 inside at once
        r = await client.get(url)
        return r.status_code
```

`asyncio.TaskGroup` (3.11+) — более строгая альтернатива `gather`: если одна задача падает, остальные отменяются. В новом коде и в официальных примерах встречаются оба варианта.

### 4. httpx — HTTP-клиент с async

Asyncio сам по себе в сеть не ходит: нужен HTTP-клиент, который умеет `await`. Популярная библиотека `requests` синхронная, поэтому в async-коде берём httpx:

```python
import httpx

async def main() -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:   # reuse one client: connection pool
        r = await client.get("https://httpbin.org/get", params={"q": "mug"})
        r.raise_for_status()            # 4xx/5xx do NOT raise by default, only after this call
        data = r.json()
```

`httpx.Client` — синхронная версия с тем же API. Официальные SDK Anthropic и OpenAI построены на httpx, поэтому таймауты, ретраи и ошибки там выглядят похоже. `async with` — асинхронный контекстный менеджер: клиент гарантированно закроет соединения.

### 5. Pydantic — валидация данных в рантайме

Запрос отправлен, JSON получен — теперь его надо проверить, прежде чем доверять. Pydantic v2 описывает данные классом с type hints и **проверяет их в рантайме** — то, чего обычные аннотации не делают (AIL-1). Ближайшие аналоги в других экосистемах — zod, Jackson с Bean Validation, struct tags с валидатором в Go.

```python
from datetime import datetime
from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, Field, ValidationError, field_validator

class OrderItem(BaseModel):
    sku: str = Field(min_length=3, description="Product SKU, e.g. MUG-NORTH")
    unit: Literal["pcs", "g"]
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal = Field(gt=0)
    created_at: datetime

    @field_validator("sku")
    @classmethod
    def upper_sku(cls, v: str) -> str:
        return v.upper()

raw = '{"sku": "mug-north", "unit": "pcs", "quantity": "2", "unit_price": "8.90", "created_at": "2026-11-16T10:00:00Z"}'
item = OrderItem.model_validate_json(raw)   # parse + validate JSON string
print(item.sku, item.quantity)              # MUG-NORTH 2

try:
    OrderItem.model_validate({"sku": "x", "unit": "box", "quantity": -1, "unit_price": 1, "created_at": "nope"})
except ValidationError as e:
    print(e.error_count(), e.errors()[0]["loc"])   # all errors at once, with field paths
```

Как читать пример. Класс наследует `BaseModel`, поля описаны аннотациями, `Field(...)` добавляет ограничения (`gt=0` — строго больше нуля) и описание. `@field_validator("sku")` подключает к полю свою функцию: Pydantic вызывает её после проверки типа и подставляет вернувшееся значение (здесь — SKU в верхнем регистре); `@classmethod` под ним — форма из документации Pydantic: валидатор вызывается у класса, а не у готового объекта. `model_validate_json` принимает строку JSON, `model_validate` — уже разобранный словарь.

Что важно:
- **Приведение типов.** По умолчанию Pydantic работает в режиме «lax»: строку `"2"` превратит в `Decimal`, ISO-строку — в `datetime`. Это удобно для JSON. Если нужна строгость — `model_config = ConfigDict(strict=True)` или `Field(strict=True)`.
- **Все ошибки сразу**, с путём до поля (`loc`) — это то, что потом можно отправить модели обратно: «исправь поле `unit`».
- **Сериализация:** `item.model_dump()` → dict, `item.model_dump_json()` → строка JSON.
- **Схема:** `OrderItem.model_json_schema()` → dict в формате JSON Schema.

```json
{
  "properties": {
    "sku": {"description": "Product SKU, e.g. MUG-NORTH", "minLength": 3, "title": "Sku", "type": "string"},
    "unit": {"enum": ["pcs", "g"], "title": "Unit", "type": "string"},
    "quantity": {"anyOf": [{"exclusiveMinimum": 0, "type": "number"}, {"type": "string"}], "title": "Quantity"},
    ...
  },
  "required": ["sku", "unit", "quantity", "unit_price", "created_at"],
  "title": "OrderItem",
  "type": "object"
}
```

(Фрагмент примерный — точный вывод зависит от версии; стоит обратить внимание, как `Decimal` превращается в «число или строка».) Именно такую схему мы будем передавать LLM в structured output и как `input_schema` инструмента. `description` у полей попадает в схему — это фактически часть промпта.

`@dataclass` против `BaseModel`: dataclass — для внутренних структур, которым мы доверяем; Pydantic — на границе системы, где данные приходят извне (файл, API, ответ LLM).

### 6. pytest — тесты без церемоний

Модель описана — закрепляем её поведение тестами, чтобы правка валидатора не сломала то, что уже работало. Тесты лежат в `tests/` рядом с кодом:

```python
# tests/test_order_item.py
import pytest
from pydantic import ValidationError
from models import OrderItem   # models.py in the project root, see pythonpath below

def test_sku_is_uppercased():
    item = OrderItem.model_validate({"sku": "tea-sencha", "unit": "g", "quantity": "250", "unit_price": "4.20", "created_at": "2026-11-16T10:00:00Z"})
    assert item.sku == "TEA-SENCHA"

@pytest.mark.parametrize("bad_unit", ["kg", "", "PCS "])
def test_rejects_bad_unit(bad_unit):
    with pytest.raises(ValidationError):
        OrderItem.model_validate({"sku": "MUG-NORTH", "unit": bad_unit, "quantity": "1", "unit_price": "1", "created_at": "2026-11-16T10:00:00Z"})
```

Файлы `test_*.py`, функции `test_*`, обычный `assert` (pytest сам покажет, что с чем сравнивалось). `pytest.raises` — ожидание исключения, `parametrize` — табличные тесты, **fixtures** — переиспользуемая подготовка (аргумент функции с именем фикстуры). Запуск: `uv run pytest -q`. Тесты не должны ходить в сеть — это правило для любого проекта.

`uv init` создаёт плоский проект: `models.py` лежит в корне, а не в пакете. Чтобы тесты из `tests/` его импортировали, добавляем в `pyproject.toml`:

```toml
[tool.pytest.ini_options]
pythonpath = ["."]
```

### 7. Отладка в VS Code

Когда тест падает и причина не видна из сообщения, удобнее остановить код и посмотреть на переменные. Нужно расширение Python (оно ставит Python Debugger на базе debugpy). Command Palette → «Python: Select Interpreter» → `.venv` проекта. После этого F5 на открытом файле запускает отладчик; breakpoint — клик слева от номера строки; панель Variables, Watch, Debug Console (можно выполнять выражения в текущем кадре). Тесты отлаживаются из панели Testing (иконка колбы) — «Debug Test». В коде можно поставить `breakpoint()` — встроенная функция, аналог `debugger;` в JS.

## DeepSeek и Ollama: как это сделать у нас

Основные модели курса — DeepSeek (облако, дешёвый, OpenAI-совместимый API, серверы в Китае) и Ollama (локальные модели на своём компьютере); Claude и OpenAI — для сравнения. Ключ DeepSeek и установка Ollama — в главе 1.5 · Как устроены LLM: лекция Карпатого и ключи API (AIL-3); здесь — как инструменты этой главы ложатся на них. Факты сверены с документацией 13.11.2026.

**httpx и SDK.** Официальный пакет `openai` (тоже на httpx) работает и с DeepSeek, и с Ollama — меняется только `base_url`. У него есть асинхронный клиент `AsyncOpenAI`, у библиотеки `ollama` — `AsyncClient`. Правило «один клиент на всю работу» действует так же.

**Семафор: у облака и у локальной модели разные причины.**
- DeepSeek ограничивает **число одновременных запросов на аккаунт** (на ноябрь 2026 в документации: 2 500 для `deepseek-flash`, 500 для `deepseek-v4-pro`), сверх — HTTP 429. Пока запрос ждёт, сервер шлёт пустые строки (или `: keep-alive` в стриме — режиме, где ответ приходит по кусочкам, глава 2.7) — SDK их переваривает, самописный парсер должен уметь.
- Ollama ограничена **нашим железом**: модель считается на GPU (или CPU) нашего компьютера, и десять параллельных запросов не ускорят работу в десять раз — они встанут в очередь или будут делить память. Для локальной модели семафор 1–2 — нормальная отправная точка; подбираем замером.

```python
# illustrative: the same async pattern for both providers
import asyncio, os
from openai import AsyncOpenAI

deepseek = AsyncOpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")
local = AsyncOpenAI(api_key="ollama", base_url="http://localhost:11434/v1")   # key is ignored by Ollama

async def ask(client: AsyncOpenAI, model: str, sem: asyncio.Semaphore, q: str) -> str:
    async with sem:
        r = await client.chat.completions.create(model=model, messages=[{"role": "user", "content": q}])
        return r.choices[0].message.content or ""

async def main() -> None:
    sem = asyncio.Semaphore(2)          # local model: keep it small
    qs = [f"One word for the number {i}" for i in range(6)]
    answers = await asyncio.gather(*(ask(local, os.environ["OLLAMA_MODEL"], sem, q) for q in qs))
    print(answers)
```

**Pydantic как схема ответа.** Здесь провайдеры расходятся сильнее всего (подробно — глава 2.2 · Structured output: Pydantic + Instructor):
- **Ollama** принимает JSON Schema в параметре `format` и ограничивает вывод под неё: `chat(model=..., messages=..., format=OrderItem.model_json_schema())`, потом `OrderItem.model_validate_json(reply.message.content)`. Через OpenAI-совместимый эндпоинт — `response_format`. Документация советует `temperature=0` для предсказуемости.
- **DeepSeek** даёт JSON mode: `response_format={"type": "json_object"}` гарантирует валидный JSON, но **не нашу схему** (о схеме документация JSON mode не говорит). Требования: слово «json» в промпте и пример нужного формата; `content` может прийти из одних пробелов — такой ответ обрабатываем и повторяем запрос. Значит, валидация Pydantic после ответа обязательна.
- **Claude / OpenAI** умеют строгие структурированные ответы по схеме — сравним в неделе 2.

| Что нужно в этой главе | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Async-клиент | `AsyncAnthropic` | `AsyncOpenAI` | `AsyncOpenAI` + `base_url` | `AsyncOpenAI` + `base_url` или `ollama.AsyncClient` |
| Причина ставить семафор | rate limits | rate limits | лимит одновременных запросов на аккаунт, 429 | производительность компьютера |
| Ответ по Pydantic-схеме | structured outputs | structured outputs | только JSON mode без схемы → валидируем сами | `format=<JSON Schema>` |
| Данные клиентов, рабочий код | **нет** | **нет** | **нет** | да |

**Что использовать здесь:** все упражнения главы — без моделей. Необязательный бонус ниже — на локальной Ollama (если глава 1.5 уже пройдена): бесплатно и можно гонять сколько угодно.

## Маршрут изучения

1. [uv](https://docs.astral.sh/uv/) → Getting started, затем [Working on projects](https://docs.astral.sh/uv/guides/projects/) (≈25 мин). Обращаем внимание: структура проекта, `uv add`/`uv remove`, `uv run`, `uv sync`, что такое `uv.lock` и `.python-version`.
2. [Ruff](https://docs.astral.sh/ruff/) → разделы Linter и Formatter, Configuring Ruff (≈15 мин). Берём оттуда, как включить наборы правил через `select`.
3. [asyncio](https://docs.python.org/3/library/asyncio.html) → страница [Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html): Coroutines, Awaitables, Creating Tasks, Task Groups, Sleeping, Running Tasks Concurrently (`gather`), Timeouts (≈35 мин). Затем [Synchronization Primitives](https://docs.python.org/3/library/asyncio-sync.html) → Semaphore (≈5 мин).
4. [httpx](https://www.python-httpx.org) → QuickStart и раздел Async Support (≈20 мин). Обращаем внимание на Client/AsyncClient, таймауты, `raise_for_status`.
5. [Pydantic](https://docs.pydantic.dev) → Concepts: [Models](https://docs.pydantic.dev/latest/concepts/models/), Fields, Validators, JSON Schema (≈45 мин). Главное: `model_validate` против `model_validate_json`, lax/strict, `Field` с ограничениями, `field_validator`, `model_json_schema`.
6. [pytest](https://docs.pytest.org) → [Get Started](https://docs.pytest.org/en/stable/getting-started.html) и How-to про fixtures и parametrize (≈25 мин).
7. VS Code: [Python debugging](https://code.visualstudio.com/docs/python/debugging) → «Basic debugging» (≈10 мин).
8. (≈15 мин) Как это выглядит у провайдеров: [DeepSeek Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) — лимит одновременных запросов и 429; [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode) — что JSON mode гарантирует и чего нет; [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs) — пример с Pydantic и `format`. Выносим оттуда: семафор нужен и там и там, но по разным причинам; схему соблюдает Ollama, DeepSeek — только «валидный JSON».

## На что обратить внимание

- **Забытый `await`.** Сгенерированный код с `client.get(url)` без `await` внутри `async def` не упадёт сразу — вместо ответа вернётся корутина, а ошибка вылезет где-то дальше.
- **`requests` и `time.sleep` в async-коде.** Модель любит `requests` по привычке; внутри `async def` это сериализует все запросы. Ищем их при ревью.
- **`asyncio.run` внутри уже работающего цикла** (в Jupyter, в FastAPI) падает с `RuntimeError`. В ноутбуке пишем `await main()` прямо в ячейке (AIL-57).
- **Новый `AsyncClient` на каждый запрос** — теряем пул соединений, а на сотнях запросов упираемся в лимиты сокетов. Один клиент на всю работу.
- **Неограниченный `gather`** по сотням LLM-вызовов = мгновенный 429 от провайдера. Всегда семафор.
- **`gather` без `return_exceptions=True`** пробрасывает первую ошибку, но остальные задачи продолжают работать в фоне — их результаты потеряются.
- **Lax-режим Pydantic** может «спасти» то, что должно было упасть: `"1"` станет `1`, `1` в поле `str` в v2 уже не пройдёт. Важно знать, где нужна строгость.
- **float для цены в модели** — те же проблемы точности, что в AIL-1; для денег `Decimal`.
- **Pydantic v1 против v2.** Старый код и старые ответы моделей используют `.dict()`, `.json()`, `parse_obj`, `@validator`. В v2 это `model_dump`, `model_dump_json`, `model_validate`, `@field_validator`. Если встречается v1-стиль — проверяем, какая версия стоит.

## Практика

Проект — в `exercises/learn-python/` учебного репозитория (AIL-56). Команды ниже запускаются из корня репозитория; uv должен быть установлен (раздел 1). Внутри существующего git-репозитория `uv init` не создаёт вложенный.

- [ ] **Проект.**
  ```bash
  cd exercises && uv init learn-python && cd learn-python
  uv add httpx pydantic
  uv add --dev pytest ruff
  uv run python -c "import httpx, pydantic; print(pydantic.VERSION)"
  ```
  Смотрим `pyproject.toml` и `uv.lock`, убеждаемся, что `.venv/` в игноре (`git status`).
- [ ] **Async против последовательного.** `fetch_compare.py`: список из 5 публичных URL, каждый отвечает с задержкой 1 с (например `https://httpbin.org/delay/1` — публичный тестовый сервис). Две функции: `sequential()` с циклом `await client.get(...)` и `parallel()` с `asyncio.gather`. Замер — `time.perf_counter()`. Ожидаемо: ~5 с против ~1 с. Добавляем `Semaphore(2)` в параллельную версию и до запуска предсказываем время (≈3 с). Если хочется взять другие публичные API — только открытые эндпоинты, без ключей.
- [ ] **Модель «Позиция заказа».** `models.py` с `OrderItem` (sku, unit, quantity, unit_price, created_at) как в теории, плюс одно своё правило (например, для `unit="pcs"` количество должно быть целым — через `model_validator(mode="after")`).
- [ ] **10 JSON.** `order_items.jsonl` — 10 вымышленных строк, из них 4 невалидных разными способами (отрицательное количество, `unit: "kg"`, битая дата, нет поля). Скрипт `validate.py` читает построчно, печатает валидные и для невалидных — номер строки и `e.errors()` кратко (`loc` + `msg`). Ожидаемо: 6 OK, 4 с понятными причинами.
- [ ] **Схема.** `print(json.dumps(OrderItem.model_json_schema(), indent=2))`. Отвечаем в `notes/week-01.md`: где в схеме описания полей, как выглядят `Literal` и `Decimal`, что попало в `required`. Добавляем `description` к каждому полю и смотрим, как изменилась схема.
- [ ] **Тесты.** Добавляем `pythonpath = ["."]` в `pyproject.toml` (раздел 6). `tests/test_models.py`: минимум 3 теста — нормализация SKU, `parametrize` по невалидным значениям, своё правило из `model_validator`. `uv run pytest -q` — зелёные.
- [ ] **Ruff.** Включаем `select = ["E", "F", "I", "B", "UP"]`, прогоняем `uv run ruff check --fix .` и `uv run ruff format .`. Специально пишем функцию с `def f(x=[])` и убеждаемся, что Ruff её ловит.
- [ ] **Отладка.** Выбираем интерпретатор `.venv`, ставим breakpoint в `validate.py` внутри `except`, запускаем F5, смотрим `e.errors()` в Variables и выполняем `e.error_count()` в Debug Console. Потом отлаживаем один тест из панели Testing.
- [ ] *(Бонус, после главы 1.5, когда Ollama установлена)* **Схема на локальной модели.** `uv add "ollama==<version>"` (версию берём с PyPI на сегодня — фиксируем). Скрипт `extract.py`: даём локальной модели одно выдуманное предложение («Вчера в 14:00 заказали 250 г чая TEA-SENCHA по 420 за 100 г») и просим `OrderItem` через `format=OrderItem.model_json_schema()` и `temperature=0` (в библиотеке `ollama` — через `options={"temperature": 0}`); результат — через `OrderItem.model_validate_json`. Затем оборачиваем 5 таких вызовов в `gather` с `Semaphore(1)` и `Semaphore(3)` и сравниваем время: на локальной модели выигрыш от параллельности заметно меньше, чем с httpbin. Только выдуманные строки.
- [ ] *(Для сравнения, по желанию)* Тот же `extract.py` на DeepSeek с `response_format={"type": "json_object"}`: пишем в промпте слово «json» и пример объекта, проверяем, что Pydantic ловит ответ, если модель выдала не тот формат. Только выдуманные данные — данные клиентов и рабочий код в облачные модели не отправляем.

## Готово, когда

- Проект запускается через `uv run`, `uv.lock` закоммичен, `.venv` нет в git.
- Замер показывает выигрыш параллельной версии, и мы можем объяснить, откуда берутся цифры с семафором.
- `validate.py` находит все 4 невалидные строки, `uv run pytest` зелёный, `uv run ruff check .` без ошибок.
- Мы видели `model_json_schema()` своей модели и понимаем, как поля превращаются в схему.

## Тест для самопроверки

1. Что делает `uv run pytest`, если зависимости в `pyproject.toml` только что поменялись?
2. Что выведет этот код и почему?
   ```python
   async def get_price():
       return 100

   async def main():
       p = get_price()
       print(p + 1)
   asyncio.run(main())
   ```
3. Чем `asyncio.gather` отличается от `Promise.all` в JavaScript в момент вызова корутин-функций?
4. Что не так в этом коде?
   ```python
   async def fetch_all(urls):
       async with httpx.AsyncClient() as client:
           for url in urls:
               r = requests.get(url)
               time.sleep(0.5)
   ```
5. Зачем нужен `asyncio.Semaphore` при массовых вызовах LLM API?
6. Какой метод Pydantic v2 парсит JSON-строку и валидирует её за один шаг?
   a) `parse_raw` b) `model_validate_json` c) `model_dump_json` d) `json.loads`
7. Поле объявлено `quantity: Decimal = Field(gt=0)`. Пройдёт ли валидацию `{"quantity": "0.5"}` в режиме по умолчанию? А `{"quantity": "0"}`?
8. Для чего AI-инженеру `model_json_schema()`?
9. Когда выбрать `@dataclass`, а когда `BaseModel`?
10. Как в pytest проверить, что функция бросает исключение?
11. Почему `asyncio.run(main())` в ячейке Jupyter падает?
12. Что такое `uv.lock` и чем он отличается от зависимостей в `pyproject.toml`?
13. Зачем семафор при массовых запросах к DeepSeek и зачем — к локальной Ollama? Причина одна и та же?
14. DeepSeek вызван с `response_format={"type": "json_object"}`, и сразу следом написано `OrderItem(**json.loads(content))` без `try`. Что может пойти не так?
15. Какой провайдер из четырёх ограничит вывод модели JSON Schema от `OrderItem.model_json_schema()` через параметр `format`?
    a) DeepSeek b) Ollama c) никакой d) все одинаково

## Ответы

1. Перед запуском uv сверяет окружение с `pyproject.toml`/lock, при необходимости обновляет lock и `.venv`, затем запускает pytest внутри окружения. Активировать `.venv` вручную не нужно.
2. `TypeError`: `get_price()` без `await` возвращает объект-корутину, а не 100; к ней нельзя прибавить 1. Плюс предупреждение «coroutine was never awaited».
3. В JS промис выполняется сразу после вызова функции; в Python вызов возвращает «спящую» корутину, и выполнение начинается, только когда `gather` оборачивает её в задачу и цикл её запускает.
4. Внутри async-функции синхронные `requests.get` и `time.sleep` блокируют event loop, всё идёт последовательно, а созданный `AsyncClient` не используется. Нужно `await client.get(url)` и `await asyncio.sleep(0.5)`, а для параллельности — `gather`.
5. Чтобы ограничить число одновременных запросов и не получить 429/бан за превышение rate limit (и не сжечь бюджет всплеском).
6. **b.** `parse_raw` — API Pydantic v1; `model_dump_json` — сериализация в обратную сторону.
7. `"0.5"` пройдёт: lax-режим приведёт строку к `Decimal`. `"0"` не пройдёт: ограничение `gt=0` требует строго больше нуля.
8. Это JSON Schema, которую передают модели для structured output и как описание параметров инструмента в tool calling; модель видит типы, ограничения и `description` полей.
9. `dataclass` — для внутренних данных, которым доверяем (без рантайм-валидации). `BaseModel` — на границе, где данные приходят извне: файлы, HTTP, ответы LLM.
10. `with pytest.raises(ValidationError): ...` — тест упадёт, если исключение нужного типа не брошено.
11. В Jupyter event loop уже запущен, а `asyncio.run` пытается запустить новый — `RuntimeError`. В ноутбуке пишут `await main()` прямо в ячейке.
12. `pyproject.toml` задаёт диапазоны (`httpx>=0.28`), `uv.lock` фиксирует точные разрешённые версии всех пакетов, включая транзитивные, — это делает установку воспроизводимой. Коммитятся оба.
13. Нет. У DeepSeek — лимит одновременных запросов на аккаунт (сверх — 429) и бюджет. У Ollama лимит — железо компьютера: параллельные запросы делят GPU и память, и большой параллелизм лишь замедляет каждый ответ.
14. JSON mode гарантирует валидный JSON, но не нужную схему: поля могут называться иначе или отсутствовать, а `content` по документации может прийти из одних пробелов — тогда упадёт уже `json.loads`. Нужно `OrderItem.model_validate_json(content)` в `try` с обработкой `ValidationError` и повтором.
15. **b.** Ollama принимает JSON Schema в `format`. В документации DeepSeek описан только `json_object` без схемы; у Claude и OpenAI свои механизмы structured output, не параметр `format`.

## Что дальше

Глава 1.4 · Jupyter-ноутбуки в VS Code (AIL-57): подключим `.venv` этого проекта как ядро ноутбука и повторим упражнение интерактивно. Потом глава 1.5 · Как устроены LLM: лекция Карпатого и ключи API (AIL-3) — интуиция об LLM, ключ DeepSeek и установка Ollama, после чего первый настоящий вызов модели.
