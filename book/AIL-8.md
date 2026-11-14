# 2.2 · Structured output: Pydantic + Instructor  (AIL-8)

> **Неделя 2** · Основы LLM · ⏱ ~3 ч · Практика

<!-- description: Structured output: как получить от LLM валидный JSON. Pydantic-схемы и валидаторы, JSON mode, повтор после ошибки, Instructor с DeepSeek и Ollama. -->

## Зачем это AI-инженеру

В продукте модель почти никогда не пишет «текст для человека» — она возвращает данные, которые дальше обрабатывает код: извлечённые поля, метки, параметры для API. Если JSON невалиден один раз из ста, на тысяче запросов в день это десять падений. Structured output — одна из самых частых тем в реальной работе и на собеседованиях («как гарантировать валидный JSON от LLM?»).

В главе 2.1 (AIL-7) мы уже столкнулись с проблемой в малом: модель отвечала «Label: Positive.» вместо `positive`, и ответ приходилось нормализовать регуляркой. Одну метку так спасти можно; запись из пяти полей — уже нет. Здесь разбираем, как получить от модели данные, которые код примет без «выковыривания».

## Теория

### Три уровня надёжности

```
1. «Просим JSON в промпте»     → обычно работает, иногда нет
2. JSON mode                  → гарантированно валидный JSON, но любой формы
3. Строгая схема (structured outputs / strict tools)
                              → JSON гарантированно соответствует нашей схеме
```

Чем выше уровень, тем больше работы берёт на себя провайдер и тем меньше остаётся нашему коду. Разберём их по очереди.

**Уровень 1 — промпт.** «Верни JSON с полями product, supplier, date». Ломается так: модель пишет «Вот ваш JSON:» перед объектом, оборачивает в ```json, забывает поле, называет его `item` вместо `product`, пишет `"date": "со следующей недели"`. Нужен парсер-«выковыриватель» и валидация. Годится для прототипа.

**Уровень 2 — JSON mode.** Провайдер ограничивает генерацию так, что результат — синтаксически валидный JSON. Но поля и типы не гарантированы. У OpenAI это `{"type": "json_object"}` в настройках формата; сейчас его считают устаревающим вариантом по сравнению со схемами.

**Уровень 3 — строгая схема.** Мы передаём JSON Schema, и провайдер использует **constrained decoding**: на каждом шаге генерации токены, которые нарушили бы схему, просто запрещены. Результат по построению парсится и проходит схему. Есть в двух формах:
- **формат ответа**: весь ответ модели — JSON по схеме (у Anthropic `output_config.format` / `client.messages.parse(...)`, у OpenAI Structured Outputs через `text.format` / `client.responses.parse(...)`);
- **строгий инструмент**: модели описывают функцию (инструмент), которую она может «вызвать», вернув её аргументы в JSON; со `strict: true` эти аргументы гарантированно соответствуют схеме. Подходит, когда JSON нужен как вызов функции; подробно инструменты разберём в главе 2.6 (AIL-10). Исторически «JSON через tool use» был основным способом получить структуру от Claude.

Ключевое: **схема гарантирует форму, а не правду.** Модель вернёт идеально валидный `{"product": "Кружка «Север»", "supplier": "Керамика Севера"}`, даже если в тексте был другой товар и другой поставщик. Валидность ≠ корректность — корректность проверяют evals (глава 2.5 (AIL-9)).

### Pydantic: модель данных и схема

Для уровня 3 нужна JSON Schema, а для уровней 1–2 — проверка ответа. Писать схему и валидатор по отдельности не придётся: оба получаются из одного класса Pydantic. Pydantic мы встречали в главе 1.3 · Python: uv, async, Pydantic (AIL-2) (модель `OrderItem`): это библиотека, в которой класс описывает форму данных, из него генерируется JSON Schema, и он же валидирует входящие данные. Похожие инструменты есть во многих языках (например, Zod в JavaScript).

Сквозной пример главы — сообщения поставщиков магазина «Полка» о товарах: новое поступление, снятие с производства, изменение цены. Из каждого такого текста хотим получить одну запись:

```python
from datetime import date
from typing import Literal
from pydantic import BaseModel, Field

class ProductUpdate(BaseModel):
    product: str = Field(description="Product name only, as written in the text, without quotes, "
                                     "article or price, e.g. 'Кружка Север'")
    supplier: str = Field(description="Supplier name as written in the text, e.g. 'Керамика Севера'")
    effective_date: date | None = Field(
        description="Date the change takes effect, ISO 8601. null if the text gives no date")
    update_type: Literal["new_arrival", "discontinued", "price_change"] | None = Field(
        description="'new_arrival' for new products, 'discontinued' if the product is no longer "
                    "supplied, 'price_change' for a new price, null if unclear")
    confidence: float = Field(ge=0, le=1,
        description="How sure you are the text announces a product update (0..1)")

print(ProductUpdate.model_json_schema())   # this is what the model sees
```

`ProductUpdate.model_validate(dict)` проверяет словарь и возвращает объект, `ProductUpdate.model_validate_json(text)` — то же сразу из строки; при несоответствии — `ValidationError` со списком ошибок по полям.

**`Field(description=...)` — это промпт.** Описания попадают в JSON Schema, и модель читает их как инструкции. «Product name only, without quotes, article or price» в описании резко снижает число `"Кружка «Север», арт. MUG-NORTH, 590 ₽"`.

**`Literal` вместо `str`** для закрытых множеств: схема с `enum` не даст модели написать `"price_update"` вместо `"price_change"`.

### Отсутствующие данные: главный источник выдумок

Строгая схема заставляет заполнить каждое поле — и здесь у неё обратная сторона. Если поле обязательно, а в тексте его нет, модель **выдумает правдоподобное значение**: дату «сегодня», поставщика из соседнего письма. Схема заставляет её что-то вписать. Защита:

1. Поле должно допускать `null` (`date | None`) — модели есть куда «отступить».
2. **Явно говорим, когда ставить null** — в описании поля и в промпте: «если даты нет в тексте, верни null; не выводи дату из контекста».
3. Добавляем поле `confidence` или флаг `is_product_update: bool` — для текстов, где вообще нет новостей о товаре.
4. Для «нет данных вообще» делаем верхний уровень вида `{"updates": [...]}` — пустой список честнее, чем выдуманный объект.

Тонкость про строгие схемы: в строгом режиме провайдеры обычно требуют, чтобы **все ключи были в `required`**, а «необязательность» выражается типом `X | null`. Pydantic-поле `x: str | None = None` в обычном JSON Schema — необязательный ключ; SDK-хелперы (`parse`) и Instructor приводят схему к нужному виду сами, но если пишем схему руками — следим за этим. Также не все ключевые слова JSON Schema поддерживаются в строгом режиме (числовые диапазоны, `pattern`, форматы бывают ограничены): SDK может переносить неподдерживаемые ограничения в описание и проверять их уже на клиенте. Стоит прочитать раздел ограничений в документации провайдера.

### Валидаторы: бизнес-правила поверх схемы

Схема ловит типы, валидатор — смысл.

```python
from pydantic import field_validator

class ProductUpdate(BaseModel):
    ...
    @field_validator("product")
    @classmethod
    def bare_name(cls, v: str) -> str:
        v = v.strip().strip('«»"„“').strip()
        if not v or len(v) > 80 or "₽" in v or "арт." in v.lower():
            raise ValueError(f"'{v}' is not a bare product name")
        return v
```

Второй естественный кандидат — валидатор даты, и на нём видна ловушка. Правило «дата не в прошлом» кажется очевидным, но сообщение поставщика трёхмесячной давности законно содержит прошлую дату, и валидатор «относительно сегодня» сломает обработку архива. Правильнее сравнивать с датой самого сообщения (передать её в контексте валидации) или проверять «дата не раньше сообщения». Важно думать, *относительно чего* правило верно.

### Три способа в коде (иллюстративно)

Модель данных готова; осталось передать её провайдеру. Ниже — нативные хелперы Anthropic и OpenAI (уровень 3) и Instructor, который добавляет к любому уровню цикл исправления ошибок.

**Anthropic, нативно** — Pydantic-модель на вход, объект на выход:

```python
import anthropic
client = anthropic.Anthropic()

resp = client.messages.parse(
    model="claude-haiku-5-5",           # check the current id
    max_tokens=1024,
    system="Extract product update info. Use null for anything not stated in the text.",
    messages=[{"role": "user", "content": f"<message>{text}</message>"}],
    output_format=ProductUpdate,
)
update = resp.parsed_output             # a validated ProductUpdate instance
```

Под капотом это `output_config={"format": {"type": "json_schema", "schema": ...}}` в `messages.create`.

**OpenAI, нативно:**

```python
from openai import OpenAI
client = OpenAI()

resp = client.responses.parse(
    model="gpt-5-mini",                 # check current model names
    input=[
        {"role": "system", "content": "Extract product update info. Use null for anything not stated."},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    text_format=ProductUpdate,
)
update = resp.output_parsed
```

**Instructor** — библиотека поверх SDK разных провайдеров: принимает `response_model=ProductUpdate`, валидирует ответ Pydantic'ом и **при ошибке валидации отправляет модели текст ошибки и просит исправить** (`max_retries`). Её сила — именно этот цикл с нашими валидаторами и единый код для многих провайдеров:

```python
import instructor

client = instructor.from_provider("anthropic/claude-haiku-5-5")   # see Instructor docs for the current API
update = client.chat.completions.create(
    response_model=ProductUpdate,
    max_retries=2,                       # re-ask with the validation error
    messages=[{"role": "user", "content": f"<message>{text}</message>"}],
    max_tokens=1024,
)
```

API Instructor менялся между версиями (`from_anthropic(...)`, `from_openai(...)`, `from_provider(...)`, режимы `Mode.*`) — сверяемся с документацией установленной версии.

Когда что выбирать:

| Ситуация | Выбор |
|---|---|
| Один провайдер, простая схема | Нативный structured output |
| Сложные бизнес-валидаторы, нужен авто-ремонт | Instructor (или свой цикл «ошибка → повтор») |
| Модель/провайдер без строгих схем (часть open-weight) | Instructor / промпт + валидация + ретраи |
| JSON — это аргументы действия | Strict tool use (глава 2.6 (AIL-10)) |

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

N стоит ограничивать (1–2): каждый повтор — полная цена запроса.

## DeepSeek и Ollama: как это сделать у нас

Здесь провайдеры различаются сильнее всего, и это хороший урок: «три уровня надёжности» из теории у каждого реализованы по-своему. Коротко: **у Ollama есть строгая схема прямо в формате ответа, у DeepSeek — только JSON mode и строгие инструменты.**

### Ollama: схема в `format` (уровень 3)

Нативный API Ollama принимает JSON Schema в параметре `format` и ограничивает генерацию под неё ([Structured outputs](https://docs.ollama.com/capabilities/structured-outputs), проверено 13.11.2026):

```python
import ollama

resp = ollama.chat(
    model="qwen3:4b",
    messages=[
        {"role": "system", "content": "Extract product update info. Use null for anything not stated in the text. "
                                      f"Return JSON matching this schema: {ProductUpdate.model_json_schema()}"},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    format=ProductUpdate.model_json_schema(),   # constrained decoding on the schema
    options={"temperature": 0},                 # docs recommend 0 for extraction
    think=False,
)
update = ProductUpdate.model_validate_json(resp.message.content)
```

Документация советует дублировать схему текстом в промпте — модель лучше понимает смысл полей. Через OpenAI-совместимый эндпоинт structured outputs тоже работают (через `response_format`), но для них нативный API надёжнее и лучше описан. `format="json"` (без схемы) — это уровень 2, JSON любой формы.

### DeepSeek: JSON mode (уровень 2) и строгие инструменты (уровень 3)

**JSON Output** — `response_format={"type": "json_object"}`. Тип `json_schema` в `response_format` **не поддерживается** (по API Reference на 13.11.2026 допустимы только `text` и `json_object`). Требования ([гайд](https://api-docs.deepseek.com/guides/json_mode)): слово «json» должно быть в промпте, и лучше дать пример нужного JSON; `max_tokens` с запасом. Особенность: если модель не смогла выдать JSON, API вернёт `content` из одних пробелов при `finish_reason == "stop"` — проверяем пустоту и повторяем.

```python
# deepseek = OpenAI(...) client from chapter 1.6
r = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "Extract product update info and answer in json. Use null for anything "
                                      'not stated. Example: {"product": "Кружка Север", "supplier": "Керамика Севера", '
                                      '"effective_date": "2026-11-20", "update_type": "new_arrival", "confidence": 0.9}'},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    response_format={"type": "json_object"},
    max_tokens=1024,
    extra_body={"thinking": {"type": "disabled"}},
)
raw = r.choices[0].message.content or ""
if not raw.strip():
    ...  # documented edge case: blank content, retry
update = ProductUpdate.model_validate_json(raw)   # the shape is NOT guaranteed: validate
```

**Строгий инструмент** — единственный способ получить у DeepSeek гарантию схемы ([Tool Calls → strict mode](https://api-docs.deepseek.com/guides/tool_calls), бета): клиент с `base_url="https://api.deepseek.com/beta"`, у функции `"strict": true`, сервер проверяет схему и отвергает неподдерживаемую. Ограничения схемы: у объектов все свойства в `required` и `additionalProperties: false`; у строк есть `pattern` и `format` только из списка (email, hostname, ipv4, ipv6, uuid) — **`format: date` в этом списке нет**, а Pydantic генерирует его для поля типа `date`; `minLength`/`maxLength`, `minItems`/`maxItems` не поддерживаются; у чисел `minimum`/`maximum` — поддерживаются; `enum` и `anyOf` (значит, и `X | None`) — да. Поэтому схему из Pydantic придётся «причесать» руками или вспомогательной функцией: все поля обязательные (необязательность — через `None`), дата — строкой с `pattern`, а потом уже Pydantic на клиенте проверит настоящий тип.

Чтобы модель точно вызвала этот инструмент, его надо выбрать принудительно (`tool_choice` с именем функции) — а **в режиме размышления принудительный `tool_choice` у DeepSeek даёт 400**. Значит: размышление выключено, или `tool_choice="auto"` + инструкция в промпте. Ситуация знакомая: это та же развилка, что у новых Claude с принудительным `tool_choice` (см. «На что обратить внимание»).

### Instructor с DeepSeek и Ollama

```python
import instructor

# DeepSeek: default mode is TOOLS (forced tool call) -> 400 while thinking is on.
ds = instructor.from_provider("deepseek/deepseek-flash", base_url="https://api.deepseek.com",
                              mode=instructor.Mode.MD_JSON)   # the docs suggest MD_JSON for reasoning models
# Ollama: TOOLS for models with function calling, JSON otherwise; can be overridden with mode=...
local = instructor.from_provider("ollama/qwen3:4b")

update = ds.create(response_model=ProductUpdate, max_retries=2,
                   messages=[{"role": "user", "content": f"<message>{text}</message>"}])
```

(По [интеграции DeepSeek](https://python.useinstructor.com/integrations/deepseek/) и [интеграции Ollama](https://python.useinstructor.com/integrations/ollama/) в документации Instructor; в их примере для DeepSeek ещё старое имя `deepseek-v4-flash`. API Instructor меняется — сверяемся с установленной версией.) Цикл «ошибка валидации → повтор» Instructor делает одинаково для всех провайдеров — именно поэтому он полезнее всего там, где нет строгой схемы, то есть на DeepSeek.

### Сравнение

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON mode (уровень 2) | нет как отдельного режима | `json_object` (устаревает) | `response_format: json_object` + слово «json» в промпте; возможен пустой ответ | `format="json"` |
| Схема в формате ответа (уровень 3) | `output_config.format` / `messages.parse` | Structured Outputs / `responses.parse` | **нет** (`json_schema` не принимается) | `format=<JSON Schema>` (нативно), `response_format` (совместимо) |
| Строгие инструменты | `strict: true` | `strict: true` | бета: `base_url=.../beta` + `strict: true`, урезанный JSON Schema | `strict` не документирован; есть схема в `format` |
| Принудительный вызов | на новейших моделях — 400 | `tool_choice` | в режиме размышления — 400, без него — работает | `tool_choice` не поддерживается в совместимом режиме |
| Что делать, если нет уровня 3 | — | — | JSON mode + Pydantic + повтор (Instructor `MD_JSON`/`JSON`) или strict tool без размышления | — |

### Что брать для практики

- **Основной `extract()`** — Ollama с `format=схема`: это настоящий уровень 3, бесплатно, а сообщения поставщиков можно гонять сколько угодно.
- **DeepSeek** — для сравнения уровней 2 и 3 на одном провайдере: JSON mode против strict tool, и Instructor поверх JSON mode. Сообщения поставщиков в практике выдуманные и без персональных данных — их отправлять в облако можно. Сообщения клиентов — нет: они идут только в локальную модель (в главе 2.5 (AIL-9) такие тексты будут помечены `"private": true`).
- **Claude/OpenAI `parse`** — по желанию, для сравнения: видно, насколько удобнее, когда схема в формате ответа поддерживается нативно.

## Маршрут изучения

1. [OpenAI: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) (≈40 мин). Читаем введение, сравнение Structured Outputs vs JSON mode, примеры с Pydantic, раздел о поддерживаемых схемах и ограничениях, а также про отказы (refusal). Что взять: почему все поля должны быть required и как выражать необязательность.
2. [Документация Anthropic](https://docs.anthropic.com) → страница Structured outputs в разделе Build with Claude ([docs.anthropic.com/en/docs/build-with-claude/structured-outputs](https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs)) (≈30 мин). Ищем: `output_config.format`, хелпер `messages.parse`, strict tool use, ограничения JSON Schema, несовместимые функции. Сравниваем с OpenAI.
3. [Instructor](https://python.useinstructor.com) (≈40 мин): Getting started, страница про интеграцию с Anthropic, разделы про валидацию и ретраи (reasking), про `Optional`/missing data. Обратим внимание на режимы (Mode): часть из них основана на принудительном вызове инструмента.
4. [Pydantic docs](https://docs.pydantic.dev/latest/) → Models, Fields, Validators (≈30 мин). Что взять: `Field(description=...)`, `Literal`, `field_validator`, `model_validator`, `model_json_schema()`.
5. В Anthropic Cookbook (ссылка в главе 1.6) находим ноутбук про извлечение JSON / structured output и пролистываем (≈10 мин).
6. Ollama: [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈15 мин). Что взять: `format=Model.model_json_schema()`, `model_validate_json`, совет про temperature 0 и схему в промпте.
7. DeepSeek (≈25 мин): [JSON Output](https://api-docs.deepseek.com/guides/json_mode) — требования и случай пустого ответа; [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls), раздел strict mode — список поддерживаемых ключевых слов JSON Schema; в [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) — допустимые `response_format` и ограничения `tool_choice` в режиме размышления.
8. Instructor: страницы интеграций [DeepSeek](https://python.useinstructor.com/integrations/deepseek/) и [Ollama](https://python.useinstructor.com/integrations/ollama/) (≈15 мин). Что взять: строку `from_provider`, режим по умолчанию и когда его менять.

## На что обратить внимание

- **Валидный ≠ верный.** Структура гарантирована, факты — нет. Точность нужно считать по полям (глава 2.5 (AIL-9)).
- **Обязательное поле без данных = выдумка.** Если не дать модели `null` и правило его использования, она впишет «разумное» значение.
- **Имя поля `date` с типом `date`.** В Pydantic поле, названное так же, как тип в аннотации (`date: date | None = None`), может приводить к странным ошибкам, потому что имя затеняет тип в теле класса. Лучше назвать `effective_date`.
- **Обрезка по `max_tokens`.** Если ответ упёрся в лимит, JSON может оказаться оборванным даже со схемой. Перед парсингом проверяем `stop_reason`/`status`.
- **Отказ модели (`refusal`).** На запрос, который модель отказалась выполнять, ответ не будет объектом схемы — это обрабатывается ветвью кода, а не исключением парсера.
- **Instructor и новые модели Claude.** Режимы Instructor на основе инструментов используют принудительный вызов (`tool_choice` с конкретным инструментом). Самые новые модели Claude (например, Opus 5.5, Sonnet 5.5) принудительный `tool_choice` не принимают и возвращают 400. Если появилась такая ошибка — нужен режим на базе structured outputs (если он есть в установленной версии Instructor), модель, которая поддерживает принудительный вызов, или нативный `messages.parse`.
- **DeepSeek: пустой `content` при `finish_reason == "stop"`** в JSON mode — документированное поведение, а не сбой сети. Проверяем `raw.strip()` до парсинга. И помним: у DeepSeek режим Instructor по умолчанию (TOOLS) — это принудительный вызов, который в режиме размышления даёт 400.
- **Ollama: контекст 4096 по умолчанию.** Длинное сообщение + схема в промпте + схема в `format` могут не влезть — поднимаем `num_ctx`.
- **Описания полей влияют на качество сильнее, чем кажется.** И на стоимость: схема — это input-токены каждого запроса.
- **Сложные схемы** (глубокая вложенность, десятки полей, большие `enum`) медленнее компилируются и чаще упираются в ограничения строгого режима. Начинать стоит с плоской схемы.

## Практика

Тексты — сообщения поставщиков «Полки» о товарах: новое поступление, снятие с производства, изменение цены, с датами, названиями поставщиков и товаров. Пишем их сами (или просим модель набросать черновики и правим руками). Данные выдуманы и не содержат персональных данных клиентов, поэтому эти тексты можно отправлять и в облачные модели.

Способы извлечения идут по уровням надёжности из теории: сначала просьба в промпте (уровень 1), затем строгая схема (уровень 3; у DeepSeek заодно сравниваем её с уровнем 2), затем Instructor с циклом повтора. Каждая функция возвращает `ProductUpdate`, так что результаты сравниваются один к одному.

- [ ] **1. Пять текстов.** `exercises/week-02/supplier_texts/` — 5 сообщений: новое поступление, изменение цены, сообщение без даты, снятие товара с производства, и один текст вообще не про товары (например, поставщик предупреждает о праздничных выходных склада).
- [ ] **2. Модель.** `exercises/week-02/product_update_model.py` — класс `ProductUpdate` из теории (с `effective_date`, `Literal`, описаниями, `confidence`).
- [ ] **3. Способ 1: промпт.** `extract_prompt(text) -> ProductUpdate | None`: просим JSON в промпте, парсим `ProductUpdate.model_validate_json`, при неудаче — пробуем вырезать `{...}` регуляркой. Считаем, сколько из 5 распарсилось с первого раза.
  Способ 1 делаем на DeepSeek (без JSON mode) и на Ollama (без `format`).
- [ ] **4. Способ 2: нативно.** `extract_native(text) -> ProductUpdate` через Ollama с `format=ProductUpdate.model_json_schema()`. Сравниваем результаты со способом 1.
- [ ] **4б. DeepSeek: уровень 2 против уровня 3.** (а) `extract_ds_json(text)` с `response_format={"type": "json_object"}` + Pydantic-валидация + обработка пустого ответа; (б) `extract_ds_strict(text)` через strict-инструмент на бета-эндпоинте (размышление выключено, `tool_choice` на функцию). Сначала отправляем схему прямо из `ProductUpdate.model_json_schema()` и смотрим, что ответит сервер на `format: date` и необязательные поля; потом исправляем схему. Записываем в заметку, какие ограничения JSON Schema встретились. Потом включаем размышление и оставляем принудительный `tool_choice` — убеждаемся, что получаем 400.
- [ ] **4в. (Для сравнения)** То же через `client.messages.parse` у Claude или `responses.parse` у OpenAI, если есть ключ.
- [ ] **5. Способ 3: Instructor.** `extract_instructor(text) -> ProductUpdate` с `max_retries=2` — поверх DeepSeek (`Mode.MD_JSON` или `Mode.JSON`) и поверх Ollama. Перед установкой проверяем пакет: точное имя `instructor` на PyPI, автор/организация (567-labs), свежесть релиза, нет ли подозрительных install-скриптов; фиксируем версию.
- [ ] **6. Сломать.** На тексте про выходные склада: что вернул каждый способ? Модель выдумала товар и дату? Добавляем в модель `is_product_update: bool` (или возвращаем `{"updates": []}`) и правило в промпт/описания; проверяем, что выдумки исчезли.
- [ ] **7. Валидаторы.** Добавляем валидатор названия товара и валидатор даты «не раньше даты сообщения» (дату сообщения передаём отдельным полем контекста или проверяем в функции после парсинга). Подсовываем Instructor'у текст, где модель склонна ошибиться (например, «Кружка „Север“, арт. MUG-NORTH, 590 ₽» в одной строке), и смотрим в логе, как он «переспрашивает» (логирование запросов `log_call` из главы 1.6 (AIL-4)).
- [ ] **8. Итоговая функция.** `extract(text: str) -> ProductUpdate` (или `-> list[ProductUpdate]`) — способ выбираем сами, с обработкой `max_tokens` и отказа. Прогоняем 5 текстов 3 раза: все 15 результатов должны быть валидными объектами.
- [ ] **9. Заметка.** В `notes/structured-output.md`: таблица «провайдер → способ → валидных из 5 → выдумок на пустом тексте → токенов → стоимость», и 3–4 строки вывода: где у каждого провайдера уровень 3 и чем мы за него платим.

## Готово, когда

- `extract(text) -> ProductUpdate` стабильно возвращает валидный объект (15 из 15 на повторных прогонах), а на тексте не про товары не выдумывает данные.
- Сравнение способов записано в `notes/structured-output.md`, включая DeepSeek JSON mode vs strict tool и Ollama `format`.
- Можем объяснить разницу «JSON в промпте / JSON mode / строгая схема» и почему валидный JSON ещё не значит верный.

## Тест для самопроверки

1. Чем JSON mode отличается от строгой схемы (structured outputs)?
2. Что гарантирует constrained decoding, а что нет?
   a) что JSON валиден и соответствует схеме; b) что значения полей правдивы; c) что модель не откажется; d) a и b
3. Почему обязательное поле `effective_date: date` без варианта `None` приводит к галлюцинациям?
4. Зачем `Field(description=...)`, если имя поля и так понятно?
5. Что не так в этом коде?
   ```python
   class ProductUpdate(BaseModel):
       product: str
       date: date
       type: str
   data = ProductUpdate.model_validate_json(resp.content[0].text)
   ```
6. Как Instructor обрабатывает ответ, не прошедший валидацию Pydantic?
7. Почему валидатор «дата изменения не в прошлом (относительно сегодня)» — плохая идея для системы, которая обрабатывает и архив сообщений поставщиков?
8. Модель вернула оборванный JSON, хотя используется строгая схема. Какая самая вероятная причина?
   a) баг провайдера; b) `stop_reason == "max_tokens"`; c) неправильный `Literal`; d) высокий `confidence`
9. В строгом режиме как обычно выражают «необязательное» поле?
10. Когда выбрать strict tool use, а не формат ответа?
11. Instructor с самой новой моделью Claude возвращает 400 про `tool_choice`. Почему?
12. Какой уровень надёжности даёт `response_format={"type": "json_object"}` у DeepSeek и как у DeepSeek получить гарантию схемы?
13. Что не так в этом коде для DeepSeek?
    ```python
    r = deepseek.chat.completions.create(
        model="deepseek-flash",
        messages=[{"role": "user", "content": f"Extract the product update: {text}"}],
        response_format={"type": "json_schema", "json_schema": {"schema": ProductUpdate.model_json_schema()}},
    )
    update = ProductUpdate.model_validate_json(r.choices[0].message.content)
    ```
14. Как получить JSON строго по схеме от локальной модели в Ollama?
    a) это невозможно, только промпт; b) передать JSON Schema в параметр `format` нативного API; c) `tool_choice="required"`; d) `format="json"`

## Ответы

1. JSON mode гарантирует только синтаксически валидный JSON любой формы; строгая схема гарантирует, что JSON соответствует переданной JSON Schema (поля, типы, enum).
2. **a.** Форма гарантирована; правдивость значений и отсутствие отказа — нет.
3. Схема заставляет модель вписать дату, даже если её нет в тексте; модель выбирает правдоподобное значение. Нужен `None` и явное правило, когда его ставить.
4. Описание попадает в JSON Schema и работает как инструкция: формат значения, примеры, правило для отсутствующих данных. Это заметно повышает качество.
5. Поле `date` затеняет тип `date` (лучше `effective_date`); `type: str` вместо `Literal["new_arrival","discontinued","price_change"]` пропустит любые значения; нет `None` для отсутствующих данных и нет описаний; `content[0]` может быть не текстовым блоком; не проверены `stop_reason` и отказ.
6. Отправляет модели её ответ вместе с текстом ошибки валидации и просит исправить; повторяет до `max_retries`, потом бросает исключение.
7. Старое сообщение о прошлом изменении законно содержит прошлую дату; правило верно только относительно даты самого сообщения.
8. **b.** Генерацию оборвали на лимите токенов; причину остановки нужно проверять до парсинга.
9. Ключ остаётся в `required`, а тип допускает `null` (`X | None`).
10. Когда JSON — это аргументы действия (вызов функции/API), особенно если инструментов несколько и модель выбирает, какой вызвать.
11. Режимы Instructor на базе инструментов принудительно задают вызов конкретного инструмента, а самые новые модели Claude принудительный `tool_choice` не поддерживают. Нужен режим на базе structured outputs, другая модель или нативный `messages.parse`.
12. Уровень 2: синтаксически валидный JSON без гарантии полей (и с документированным случаем пустого ответа). Гарантию схемы даёт только strict-инструмент на бета-эндпоинте (`base_url=.../beta`, `"strict": true`) с поддерживаемым подмножеством JSON Schema; ещё вариант — Pydantic-валидация с повтором (Instructor).
13. `json_schema` в `response_format` DeepSeek не поддерживает (только `text`/`json_object`); в промпте нет слова «json» и примера; не выключено размышление (лишние токены); не проверены пустой `content` и `finish_reason == "length"`; текст не обёрнут в теги.
14. **b.** `format=ProductUpdate.model_json_schema()` включает ограниченную генерацию под схему; `format="json"` даёт только «какой-то JSON».

## Что дальше

Дальше читаем [2.3 · Как выбрать LLM: обзор моделей и провайдеров (AIL-58)](AIL-58.md) и [2.4 · OpenRouter: один API ко многим моделям (AIL-69)](AIL-69.md), а затем в [2.5 · Первый eval: извлечение JSON из 20 текстов (AIL-9)](AIL-9.md) измерим, насколько *правильны* значения, которые возвращает `extract()`.
