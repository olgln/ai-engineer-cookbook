# 2.2 · Structured output: Pydantic + Instructor  (AIL-8)

> **Неделя 2** · Основы LLM · ⏱ ~3 ч · Практика

## Зачем это AI-инженеру

В продукте модель почти никогда не пишет «текст для человека» — она возвращает данные, которые дальше обрабатывает код: извлечённые поля, метки, параметры для API. Если JSON невалиден один раз из ста, на тысяче запросов в день у тебя десять падений. Structured output — одна из самых частых тем в реальной работе и на собеседованиях («как гарантировать валидный JSON от LLM?»).

## Теория

### Три уровня надёжности

```
1. «Попроси JSON в промпте»   → обычно работает, иногда нет
2. JSON mode                  → гарантированно валидный JSON, но любой формы
3. Строгая схема (structured outputs / strict tools)
                              → JSON гарантированно соответствует твоей схеме
```

**Уровень 1 — промпт.** «Верни JSON с полями coin, exchange, date». Ломается так: модель пишет «Вот ваш JSON:» перед объектом, оборачивает в ```json, забывает поле, называет его `ticker` вместо `coin`, пишет `"date": "next Friday"`. Нужен парсер-«выковыриватель» и валидация. Годится для прототипа.

**Уровень 2 — JSON mode.** Провайдер ограничивает генерацию так, что результат — синтаксически валидный JSON. Но поля и типы не гарантированы. У OpenAI это `{"type": "json_object"}` в настройках формата; сейчас его считают устаревающим вариантом по сравнению со схемами.

**Уровень 3 — строгая схема.** Ты передаёшь JSON Schema, и провайдер использует **constrained decoding**: на каждом шаге генерации токены, которые нарушили бы схему, просто запрещены. Результат по построению парсится и проходит схему. Есть в двух формах:
- **формат ответа**: весь ответ модели — JSON по схеме (у Anthropic `output_config.format` / `client.messages.parse(...)`, у OpenAI Structured Outputs через `text.format` / `client.responses.parse(...)`);
- **строгий инструмент**: схема аргументов инструмента (`strict: true`) — когда JSON нужен как вызов функции (AIL-10). Исторически «JSON через tool use» был основным способом получить структуру от Claude.

Ключевое: **схема гарантирует форму, а не правду.** Модель вернёт идеально валидный `{"coin": "XYZ", "exchange": "Binance"}`, даже если в тексте был другой токен и другая биржа. Валидность ≠ корректность — корректность проверяют evals (AIL-9).

### Pydantic — TypeScript-разработчику

Pydantic — это примерно Zod для Python: класс описывает форму данных, из него генерируется JSON Schema, и он же валидирует входящие данные.

```python
from datetime import date
from typing import Literal
from pydantic import BaseModel, Field

class Listing(BaseModel):
    coin: str = Field(description="Ticker of the listed coin, uppercase, e.g. 'PEPE'")
    exchange: str = Field(description="Exchange name as written in the text, e.g. 'Binance'")
    listing_date: date | None = Field(
        description="Date trading starts, ISO 8601. null if the text gives no date")
    market_type: Literal["spot", "futures"] | None = Field(
        description="'futures' for perpetual/delivery contracts, 'spot' for spot pairs, null if unclear")
    confidence: float = Field(ge=0, le=1,
        description="How sure you are the text announces a listing (0..1)")

print(Listing.model_json_schema())   # this is what the model sees
```

Аналог в Zod: `z.object({ coin: z.string().describe(...), market_type: z.enum(["spot","futures"]).nullable() })`. `Listing.model_validate(dict)` ≈ `schema.parse(obj)`, `Listing.model_validate_json(text)` — сразу из строки.

**`Field(description=...)` — это промпт.** Описания попадают в JSON Schema, и модель читает их как инструкции. «Ticker, uppercase» в описании резко снижает число `"Pepe"` и `"pepe coin"`.

**`Literal` вместо `str`** для закрытых множеств: схема с `enum` не даст модели написать `"perpetual"` вместо `"futures"`.

### Отсутствующие данные: главный источник выдумок

Если поле обязательно, а в тексте его нет, модель **выдумает правдоподобное значение**: дату «сегодня», биржу «Binance». Схема заставляет её что-то вписать. Защита:

1. Делай поле допускающим `null` (`date | None`) — модели есть куда «отступить».
2. **Явно скажи, когда ставить null** — в описании поля и в промпте: «если даты нет в тексте, верни null; не выводи дату из контекста».
3. Добавь поле `confidence` или флаг `is_listing: bool` — для текстов, где вообще нет листинга.
4. Для «нет данных вообще» сделай верхний уровень вида `{"listings": [...]}` — пустой список честнее, чем выдуманный объект.

Тонкость про строгие схемы: в строгом режиме провайдеры обычно требуют, чтобы **все ключи были в `required`**, а «необязательность» выражается типом `X | null`. Pydantic-поле `x: str | None = None` в обычном JSON Schema — необязательный ключ; SDK-хелперы (`parse`) и Instructor приводят схему к нужному виду сами, но если пишешь схему руками — следи за этим. Также не все ключевые слова JSON Schema поддерживаются в строгом режиме (числовые диапазоны, `pattern`, форматы бывают ограничены): SDK может переносить неподдерживаемые ограничения в описание и проверять их уже на клиенте. Смотри раздел ограничений в документации провайдера.

### Валидаторы: бизнес-правила поверх схемы

Схема ловит типы, валидатор — смысл.

```python
from pydantic import field_validator

class Listing(BaseModel):
    ...
    @field_validator("coin")
    @classmethod
    def ticker_upper(cls, v: str) -> str:
        v = v.strip().upper()
        if not v.isalnum() or len(v) > 15:
            raise ValueError(f"'{v}' does not look like a ticker")
        return v
```

Правило «дата не в прошлом» — хороший пример ловушки: объявление трёхмесячной давности законно содержит прошлую дату, и валидатор «относительно сегодня» сломает обработку архива. Правильнее сравнивать с датой публикации объявления (передать её в контексте валидации) или проверять «дата не раньше публикации». Думай, *относительно чего* правило верно.

### Три способа в коде (иллюстративно)

**Anthropic, нативно** — Pydantic-модель на вход, объект на выход:

```python
import anthropic
client = anthropic.Anthropic()

resp = client.messages.parse(
    model="claude-haiku-5-5",           # check the current id
    max_tokens=1024,
    system="Extract listing info. Use null for anything not stated in the text.",
    messages=[{"role": "user", "content": f"<announcement>{text}</announcement>"}],
    output_format=Listing,
)
listing = resp.parsed_output            # a validated Listing instance
```

Под капотом это `output_config={"format": {"type": "json_schema", "schema": ...}}` в `messages.create`.

**OpenAI, нативно:**

```python
from openai import OpenAI
client = OpenAI()

resp = client.responses.parse(
    model="gpt-5-mini",                 # check current model names
    input=[
        {"role": "system", "content": "Extract listing info. Use null for anything not stated."},
        {"role": "user", "content": f"<announcement>{text}</announcement>"},
    ],
    text_format=Listing,
)
listing = resp.output_parsed
```

**Instructor** — библиотека поверх SDK разных провайдеров: принимает `response_model=Listing`, валидирует ответ Pydantic'ом и **при ошибке валидации отправляет модели текст ошибки и просит исправить** (`max_retries`). Её сила — именно этот цикл с твоими валидаторами и единый код для многих провайдеров:

```python
import instructor

client = instructor.from_provider("anthropic/claude-haiku-5-5")   # see Instructor docs for the current API
listing = client.chat.completions.create(
    response_model=Listing,
    max_retries=2,                       # re-ask with the validation error
    messages=[{"role": "user", "content": f"<announcement>{text}</announcement>"}],
    max_tokens=1024,
)
```

API Instructor менялся между версиями (`from_anthropic(...)`, `from_openai(...)`, `from_provider(...)`, режимы `Mode.*`) — сверяйся с документацией установленной версии.

Когда что выбирать:

| Ситуация | Выбор |
|---|---|
| Один провайдер, простая схема | Нативный structured output |
| Сложные бизнес-валидаторы, нужен авто-ремонт | Instructor (или свой цикл «ошибка → повтор») |
| Модель/провайдер без строгих схем (часть open-weight) | Instructor / промпт + валидация + ретраи |
| JSON — это аргументы действия | Strict tool use (AIL-10) |

### Цикл «валидация → повтор» своими руками

Полезно понимать, что делает Instructor:

```
ответ модели ──► model_validate_json ──ok──► объект
                       │ ValidationError
                       ▼
     messages += [assistant: <ответ>, user: "Ошибка: <текст ошибки>. Исправь."]
                       │
                       └──► повтор (не больше N раз) ──► иначе исключение
```

Ограничивай N (1–2): каждый повтор — полная цена запроса.

## DeepSeek и Ollama: как это сделать у нас

Здесь провайдеры различаются сильнее всего, и это хороший урок: «три уровня надёжности» из теории у каждого реализованы по-своему. Коротко: **у Ollama есть строгая схема прямо в формате ответа, у DeepSeek — только JSON mode и строгие инструменты.**

### Ollama: схема в `format` (уровень 3)

Нативный API Ollama принимает JSON Schema в параметре `format` и ограничивает генерацию под неё ([Structured outputs](https://docs.ollama.com/capabilities/structured-outputs), проверено 13.11.2026):

```python
import ollama

resp = ollama.chat(
    model="qwen3:4b",
    messages=[
        {"role": "system", "content": "Extract listing info. Use null for anything not stated in the text. "
                                      f"Return JSON matching this schema: {Listing.model_json_schema()}"},
        {"role": "user", "content": f"<announcement>{text}</announcement>"},
    ],
    format=Listing.model_json_schema(),    # constrained decoding on the schema
    options={"temperature": 0},            # docs recommend 0 for extraction
    think=False,
)
listing = Listing.model_validate_json(resp.message.content)
```

Документация советует дублировать схему текстом в промпте — модель лучше понимает смысл полей. Через OpenAI-совместимый эндпоинт structured outputs тоже работают (через `response_format`), но для них нативный API надёжнее и лучше описан. `format="json"` (без схемы) — это уровень 2, JSON любой формы.

### DeepSeek: JSON mode (уровень 2) и строгие инструменты (уровень 3)

**JSON Output** — `response_format={"type": "json_object"}`. Тип `json_schema` в `response_format` **не поддерживается** (по API Reference на 13.11.2026 допустимы только `text` и `json_object`). Требования ([гайд](https://api-docs.deepseek.com/guides/json_mode)): слово «json» должно быть в промпте, и лучше дать пример нужного JSON; `max_tokens` с запасом. Особенность: если модель не смогла выдать JSON, API вернёт `content` из одних пробелов при `finish_reason == "stop"` — проверяй пустоту и повторяй.

```python
r = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "Extract listing info and answer in json. Use null for anything "
                                      'not stated. Example: {"coin": "PEPE", "exchange": "Binance", '
                                      '"listing_date": "2026-11-20", "market_type": "spot", "confidence": 0.9}'},
        {"role": "user", "content": f"<announcement>{text}</announcement>"},
    ],
    response_format={"type": "json_object"},
    max_tokens=1024,
    extra_body={"thinking": {"type": "disabled"}},
)
raw = r.choices[0].message.content or ""
if not raw.strip():
    ...  # documented edge case: blank content, retry
listing = Listing.model_validate_json(raw)   # the shape is NOT guaranteed: validate
```

**Строгий инструмент** — единственный способ получить у DeepSeek гарантию схемы ([Tool Calls → strict mode](https://api-docs.deepseek.com/guides/tool_calls), бета): клиент с `base_url="https://api.deepseek.com/beta"`, у функции `"strict": true`, сервер проверяет схему и отвергает неподдерживаемую. Ограничения схемы: у объектов все свойства в `required` и `additionalProperties: false`; у строк есть `pattern` и `format` только из списка (email, hostname, ipv4, ipv6, uuid) — **`format: date` в этом списке нет**, а Pydantic генерирует его для поля типа `date`; `minLength`/`maxLength`, `minItems`/`maxItems` не поддерживаются; у чисел `minimum`/`maximum` — поддерживаются; `enum` и `anyOf` (значит, и `X | None`) — да. Поэтому схему из Pydantic придётся «причесать» руками или вспомогательной функцией: все поля обязательные (необязательность — через `None`), дата — строкой с `pattern`, а потом уже Pydantic на клиенте проверит настоящий тип.

Чтобы модель точно вызвала этот инструмент, его надо выбрать принудительно (`tool_choice` с именем функции) — а **в режиме размышления принудительный `tool_choice` у DeepSeek даёт 400**. Значит: размышление выключено, или `tool_choice="auto"` + инструкция в промпте. Узнаёшь ситуацию? Это та же развилка, что у новых Claude с принудительным `tool_choice` (см. «На что обратить внимание»).

### Instructor с DeepSeek и Ollama

```python
import instructor

# DeepSeek: default mode is TOOLS (forced tool call) -> 400 while thinking is on.
ds = instructor.from_provider("deepseek/deepseek-flash", base_url="https://api.deepseek.com",
                              mode=instructor.Mode.MD_JSON)   # the docs suggest MD_JSON for reasoning models
# Ollama: TOOLS for models with function calling, JSON otherwise; can be overridden with mode=...
local = instructor.from_provider("ollama/qwen3:4b")

listing = ds.create(response_model=Listing, max_retries=2,
                    messages=[{"role": "user", "content": f"<announcement>{text}</announcement>"}])
```

(По [интеграции DeepSeek](https://python.useinstructor.com/integrations/deepseek/) и [интеграции Ollama](https://python.useinstructor.com/integrations/ollama/) в документации Instructor; в их примере для DeepSeek ещё старое имя `deepseek-v4-flash`. API Instructor меняется — сверяй со своей версией.) Цикл «ошибка валидации → повтор» Instructor делает одинаково для всех провайдеров — именно поэтому он полезнее всего там, где нет строгой схемы, то есть на DeepSeek.

### Сравнение

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON mode (уровень 2) | нет как отдельного режима | `json_object` (устаревает) | `response_format: json_object` + слово «json» в промпте; возможен пустой ответ | `format="json"` |
| Схема в формате ответа (уровень 3) | `output_config.format` / `messages.parse` | Structured Outputs / `responses.parse` | **нет** (`json_schema` не принимается) | `format=<JSON Schema>` (нативно), `response_format` (совместимо) |
| Строгие инструменты | `strict: true` | `strict: true` | бета: `base_url=.../beta` + `strict: true`, урезанный JSON Schema | `strict` не документирован; есть схема в `format` |
| Принудительный вызов | на новейших моделях — 400 | `tool_choice` | в режиме размышления — 400, без него — работает | `tool_choice` не поддерживается в совместимом режиме |
| Что делать, если нет уровня 3 | — | — | JSON mode + Pydantic + повтор (Instructor `MD_JSON`/`JSON`) или strict tool без размышления | — |

### Что брать для практики

- **Основной `extract()`** — Ollama с `format=схема`: это настоящий уровень 3, бесплатно, а объявления бирж можно гонять сколько угодно.
- **DeepSeek** — для сравнения уровней 2 и 3 на одном провайдере: JSON mode против strict tool, и Instructor поверх JSON mode. Объявления бирж — публичные тексты, их отправлять можно.
- **Claude/OpenAI `parse`** — по желанию, для сравнения: увидишь, насколько удобнее, когда схема в формате ответа поддерживается нативно.

## Маршрут изучения

1. [OpenAI: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) (≈40 мин). Прочитай введение, сравнение Structured Outputs vs JSON mode, примеры с Pydantic, раздел о поддерживаемых схемах и ограничениях, а также про отказы (refusal). Возьми: почему все поля должны быть required и как выражать необязательность.
2. [Документация Anthropic](https://docs.anthropic.com) → страница Structured outputs в разделе Build with Claude ([docs.anthropic.com/en/docs/build-with-claude/structured-outputs](https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs)) (≈30 мин). Найди: `output_config.format`, хелпер `messages.parse`, strict tool use, ограничения JSON Schema, несовместимые функции. Сравни с OpenAI.
3. [Instructor](https://python.useinstructor.com) (≈40 мин): Getting started, страница про интеграцию с Anthropic, разделы про валидацию и ретраи (reasking), про `Optional`/missing data. Обрати внимание на режимы (Mode): часть из них основана на принудительном вызове инструмента.
4. [Pydantic docs](https://docs.pydantic.dev/latest/) → Models, Fields, Validators (≈30 мин). Возьми `Field(description=...)`, `Literal`, `field_validator`, `model_validator`, `model_json_schema()`.
5. В Anthropic Cookbook (ссылка в главе 1.6) найди ноутбук про извлечение JSON / structured output и пролистай (≈10 мин).
6. Ollama: [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈15 мин). Возьми: `format=Model.model_json_schema()`, `model_validate_json`, совет про temperature 0 и схему в промпте.
7. DeepSeek (≈25 мин): [JSON Output](https://api-docs.deepseek.com/guides/json_mode) — требования и случай пустого ответа; [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls), раздел strict mode — список поддерживаемых ключевых слов JSON Schema; в [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) — допустимые `response_format` и ограничения `tool_choice` в режиме размышления.
8. Instructor: страницы интеграций [DeepSeek](https://python.useinstructor.com/integrations/deepseek/) и [Ollama](https://python.useinstructor.com/integrations/ollama/) (≈15 мин). Возьми: строку `from_provider`, режим по умолчанию и когда его менять.

## На что обратить внимание

- **Валидный ≠ верный.** Структура гарантирована, факты — нет. Считай точность по полям (AIL-9).
- **Обязательное поле без данных = выдумка.** Если не дать модели `null` и правило его использования, она впишет «разумное» значение.
- **Имя поля `date` с типом `date`.** В Pydantic поле, названное так же, как тип в аннотации (`date: date | None = None`), может приводить к странным ошибкам, потому что имя затеняет тип в теле класса. Называй `listing_date`.
- **Обрезка по `max_tokens`.** Если ответ упёрся в лимит, JSON может оказаться оборванным даже со схемой. Проверяй `stop_reason`/`status` перед парсингом.
- **Отказ модели (`refusal`).** На запрос, который модель отказалась выполнять, ответ не будет объектом схемы — обрабатывай это ветвью кода, а не исключением парсера.
- **Instructor и новые модели Claude.** Режимы Instructor на основе инструментов используют принудительный вызов (`tool_choice` с конкретным инструментом). Самые новые модели Claude (например, Opus 5.5, Sonnet 5.5) принудительный `tool_choice` не принимают и возвращают 400. Если поймаешь такую ошибку — используй режим на базе structured outputs (если он есть в твоей версии Instructor), модель, которая поддерживает принудительный вызов, или нативный `messages.parse`.
- **DeepSeek: пустой `content` при `finish_reason == "stop"`** в JSON mode — документированное поведение, а не сбой сети. Проверяй `raw.strip()` до парсинга. И помни: у DeepSeek режим Instructor по умолчанию (TOOLS) — это принудительный вызов, который в режиме размышления даёт 400.
- **Ollama: контекст 4096 по умолчанию.** Длинное объявление + схема в промпте + схема в `format` могут не влезть — подними `num_ctx`.
- **Описания полей влияют на качество сильнее, чем кажется.** И на стоимость: схема — это input-токены каждого запроса.
- **Сложные схемы** (глубокая вложенность, десятки полей, большие `enum`) медленнее компилируются и чаще упираются в ограничения строгого режима. Начинай с плоской схемы.

## Практика

Тексты — публичные объявления бирж о листингах (раздел announcements на сайтах бирж; копируешь текст руками или из публичной страницы). Никаких приватных API и ключей бирж.

- [ ] **1. Пять текстов.** `week2/listings/` — 5 объявлений: спот-листинг, листинг perpetual-фьючерса, объявление без даты, объявление о делистинге, и один текст вообще не про листинг (например, про техработы).
- [ ] **2. Модель.** `week2/listing_model.py` — класс `Listing` из теории (с `listing_date`, `Literal`, описаниями, `confidence`).
- [ ] **3. Способ 1: промпт.** `extract_prompt(text) -> Listing | None`: проси JSON в промпте, парси `Listing.model_validate_json`, при неудаче — попробуй вырезать `{...}` регуляркой. Посчитай, сколько из 5 распарсилось с первого раза.
  Способ 1 делай на DeepSeek (без JSON mode) и на Ollama (без `format`).
- [ ] **4. Способ 2: нативно.** `extract_native(text) -> Listing` через Ollama с `format=Listing.model_json_schema()`. Сравни результаты со способом 1.
- [ ] **4б. DeepSeek: уровень 2 против уровня 3.** (а) `extract_ds_json(text)` с `response_format={"type": "json_object"}` + Pydantic-валидация + обработка пустого ответа; (б) `extract_ds_strict(text)` через strict-инструмент на бета-эндпоинте (размышление выключено, `tool_choice` на функцию). Сначала отправь схему прямо из `Listing.model_json_schema()` и посмотри, что ответит сервер на `format: date` и необязательные поля; потом исправь схему. Запиши в заметку, какие ограничения JSON Schema ты встретил. Потом включи размышление и оставь принудительный `tool_choice` — убедись, что получаешь 400.
- [ ] **4в. (Для сравнения)** То же через `client.messages.parse` у Claude или `responses.parse` у OpenAI, если есть ключ.
- [ ] **5. Способ 3: Instructor.** `extract_instructor(text) -> Listing` с `max_retries=2` — поверх DeepSeek (`Mode.MD_JSON` или `Mode.JSON`) и поверх Ollama. Перед установкой проверь пакет: точное имя `instructor` на PyPI, автор/организация (567-labs), свежесть релиза, нет ли подозрительных install-скриптов; зафиксируй версию.
- [ ] **6. Сломать.** На тексте про техработы: что вернул каждый способ? Модель выдумала монету и дату? Добавь в модель `is_listing: bool` (или верни `{"listings": []}`) и правило в промпте/описаниях; проверь, что выдумки исчезли.
- [ ] **7. Валидаторы.** Добавь валидатор тикера и валидатор даты «не раньше даты публикации» (передай дату публикации отдельным полем контекста или проверяй в функции после парсинга). Подсунь Instructor'у текст, где модель склонна ошибиться (например, тикер с пробелом или «$PEPE»), и посмотри в логе, как он «переспрашивает» (включи логирование запросов из AIL-4).
- [ ] **8. Итоговая функция.** `extract(text: str) -> Listing` (или `-> list[Listing]`) — твой выбор способа, с обработкой `max_tokens` и отказа. Прогони 5 текстов 3 раза: все 15 результатов должны быть валидными объектами.
- [ ] **9. Заметка.** В `notes/structured-output.md`: таблица «провайдер → способ → валидных из 5 → выдумок на пустом тексте → токенов → стоимость», и 3–4 строки вывода: где у каждого провайдера уровень 3 и чем ты за него платишь.

## Готово, когда

- `extract(text) -> Listing` стабильно возвращает валидный объект (15 из 15 на повторных прогонах), а на тексте без листинга не выдумывает данные.
- Сравнение способов записано в `notes/structured-output.md`, включая DeepSeek JSON mode vs strict tool и Ollama `format`.
- Ты можешь объяснить разницу «JSON в промпте / JSON mode / строгая схема» и почему валидный JSON ещё не значит верный.

## Тест для самопроверки

1. Чем JSON mode отличается от строгой схемы (structured outputs)?
2. Что гарантирует constrained decoding, а что нет?
   a) что JSON валиден и соответствует схеме; b) что значения полей правдивы; c) что модель не откажется; d) a и b
3. Почему обязательное поле `listing_date: date` без варианта `None` приводит к галлюцинациям?
4. Зачем `Field(description=...)`, если имя поля и так понятно?
5. Что не так в этом коде?
   ```python
   class Listing(BaseModel):
       coin: str
       date: date
       type: str
   data = Listing.model_validate_json(resp.content[0].text)
   ```
6. Как Instructor обрабатывает ответ, не прошедший валидацию Pydantic?
7. Почему валидатор «дата листинга не в прошлом (относительно сегодня)» — плохая идея для системы, которая обрабатывает и архив объявлений?
8. Модель вернула оборванный JSON, хотя ты используешь строгую схему. Какая самая вероятная причина?
   a) баг провайдера; b) `stop_reason == "max_tokens"`; c) неправильный `Literal`; d) высокий `confidence`
9. В строгом режиме как обычно выражают «необязательное» поле?
10. Когда выбрать strict tool use, а не формат ответа?
11. Ты используешь Instructor с самой новой моделью Claude и получаешь 400 про `tool_choice`. Почему?
12. Какой уровень надёжности даёт `response_format={"type": "json_object"}` у DeepSeek и как у DeepSeek получить гарантию схемы?
13. Что не так в этом коде для DeepSeek?
    ```python
    r = deepseek.chat.completions.create(
        model="deepseek-flash",
        messages=[{"role": "user", "content": f"Extract the listing: {text}"}],
        response_format={"type": "json_schema", "json_schema": {"schema": Listing.model_json_schema()}},
    )
    listing = Listing.model_validate_json(r.choices[0].message.content)
    ```
14. Как получить JSON строго по схеме от локальной модели в Ollama?
    a) это невозможно, только промпт; b) передать JSON Schema в параметр `format` нативного API; c) `tool_choice="required"`; d) `format="json"`

## Ответы

1. JSON mode гарантирует только синтаксически валидный JSON любой формы; строгая схема гарантирует, что JSON соответствует твоей JSON Schema (поля, типы, enum).
2. **a.** Форма гарантирована; правдивость значений и отсутствие отказа — нет.
3. Схема заставляет модель вписать дату, даже если её нет в тексте; модель выбирает правдоподобное значение. Нужен `None` и явное правило, когда его ставить.
4. Описание попадает в JSON Schema и работает как инструкция: формат значения, примеры, правило для отсутствующих данных. Это заметно повышает качество.
5. Поле `date` затеняет тип `date` (лучше `listing_date`); `type: str` вместо `Literal["spot","futures"]` пропустит любые значения; нет `None` для отсутствующих данных и нет описаний; `content[0]` может быть не текстовым блоком; не проверены `stop_reason` и отказ.
6. Отправляет модели её ответ вместе с текстом ошибки валидации и просит исправить; повторяет до `max_retries`, потом бросает исключение.
7. Объявление о прошлом листинге законно содержит прошлую дату; правило верно только относительно даты публикации.
8. **b.** Генерацию оборвали на лимите токенов; проверяй причину остановки до парсинга.
9. Ключ остаётся в `required`, а тип допускает `null` (`X | None`).
10. Когда JSON — это аргументы действия (вызов функции/API), особенно если инструментов несколько и модель выбирает, какой вызвать.
11. Режимы Instructor на базе инструментов принудительно задают вызов конкретного инструмента, а самые новые модели Claude принудительный `tool_choice` не поддерживают. Нужен режим на базе structured outputs, другая модель или нативный `messages.parse`.

12. Уровень 2: синтаксически валидный JSON без гарантии полей (и с документированным случаем пустого ответа). Гарантию схемы даёт только strict-инструмент на бета-эндпоинте (`base_url=.../beta`, `"strict": true`) с поддерживаемым подмножеством JSON Schema; ещё вариант — Pydantic-валидация с повтором (Instructor).
13. `json_schema` в `response_format` DeepSeek не поддерживает (только `text`/`json_object`); в промпте нет слова «json» и примера; не выключено размышление (лишние токены); не проверены пустой `content` и `finish_reason == "length"`; текст не обёрнут в теги.
14. **b.** `format=Listing.model_json_schema()` включает ограниченную генерацию под схему; `format="json"` даёт только «какой-то JSON».

## Что дальше

Сегодня же прочитай [2.3 · Обзор моделей и провайдеров (AIL-58)](AIL-58.md) и [2.4 · OpenRouter: один API ко многим моделям (AIL-69)](AIL-69.md), а затем в [2.5 · Упражнение: JSON из 20 текстов (AIL-9)](AIL-9.md) ты измеришь, насколько *правильны* значения, которые возвращает `extract()`.
