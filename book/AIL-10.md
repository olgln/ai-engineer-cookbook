# 2.6 · Tool calling: модель вызывает 3 функции  (AIL-10)

> **Неделя 2** · Основы LLM · ⏱ ~4 ч · Практика

## Зачем это AI-инженеру

Tool calling (function calling) — механизм, на котором стоят агенты, MCP, ассистенты с доступом к базам и API, и вообще любая интеграция LLM с реальными системами. Все агентные фреймворки — это цикл из этой главы плюс удобства. На собеседовании почти гарантированно спросят: «Как модель вызывает функцию? Кто её выполняет? Что будет, если функция упала?» — и попросят нарисовать цикл.

## Теория

### Модель не выполняет код

Самое важное: модель **ничего не вызывает сама**. Она генерирует *структурированную просьбу*: «вызови `get_rate` с аргументами `{"base": "USD", "quote": "EUR"}`». Выполняет твой код, результат ты возвращаешь модели следующим сообщением, и она продолжает.

```
 ты                                   модель
 ─────────────────────────────────────────────────────────────
 messages=[user: "100 USD в EUR × 3?"], tools=[...]  ──►
                                    ◄── assistant: tool_use get_rate{USD,EUR}
                                        stop_reason = "tool_use"
 выполняешь get_rate → 0.92
 messages += [assistant(tool_use), user(tool_result 0.92)] ──►
                                    ◄── assistant: tool_use calculator{"100*0.92*3"}
 выполняешь → 276
 messages += [assistant(tool_use), user(tool_result 276)] ──►
                                    ◄── assistant: "100 USD ≈ 92 EUR, ×3 = 276 EUR"
                                        stop_reason = "end_turn"
```

Аналогия для тебя: это как RPC, где клиент (модель) только формирует запрос, а сервер (твой код) решает, исполнять ли его. И, как в любом RPC, **сервер не доверяет клиенту**: аргументы валидируются, опасные действия запрещены или требуют подтверждения.

### Определение инструмента

У Anthropic инструмент — это имя, описание и JSON Schema входа:

```python
TOOLS = [
    {
        "name": "get_exchange_rate",
        "description": (
            "Get the latest official exchange rate between two fiat currencies "
            "(ECB reference rates, updated once per working day). "
            "Use it for any currency conversion. Does not support crypto."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "base": {"type": "string", "description": "ISO 4217 code, e.g. 'USD'"},
                "quote": {"type": "string", "description": "ISO 4217 code, e.g. 'EUR'"},
            },
            "required": ["base", "quote"],
            "additionalProperties": False,
        },
        "strict": True,   # arguments are guaranteed to match the schema
    },
]
```

У OpenAI (Responses API) почти то же: `{"type": "function", "name": ..., "description": ..., "parameters": {...}, "strict": True}`.

**Имя и описание — это промпт.** Модель выбирает инструмент только по ним. Хорошее описание отвечает на вопросы: что делает, когда использовать, когда *не* использовать, что возвращает, какие ограничения (обновляется раз в день, не поддерживает крипту). Плохое: `"name": "tool1", "description": "rates"`.

### Цикл (agentic loop)

Иллюстративно, в стиле Python SDK Anthropic:

```python
MAX_ITERATIONS = 5

def run(question: str) -> str:
    messages = [{"role": "user", "content": question}]
    for _ in range(MAX_ITERATIONS):
        resp = client.messages.create(
            model=MODEL, max_tokens=2048, tools=TOOLS, messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})   # keep all blocks

        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")

        results = []
        for block in resp.content:
            if block.type == "tool_use":
                results.append(execute(block))      # returns a tool_result dict
        messages.append({"role": "user", "content": results})   # ALL results in ONE message
    raise RuntimeError("tool loop did not finish in time")
```

И результат инструмента:

```python
def execute(block) -> dict:
    try:
        output = DISPATCH[block.name](**validate(block.name, block.input))
        return {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(output)}
    except Exception as e:                      # tool failure is data for the model
        return {"type": "tool_result", "tool_use_id": block.id,
                "content": f"Error: {e}", "is_error": True}
```

Ключевые детали:
- `tool_use_id` в результате обязан совпадать с `id` блока `tool_use`;
- в историю кладётся **весь** `resp.content` (там могут быть текст, thinking и несколько `tool_use`);
- результаты всех вызовов одного хода — в **одном** сообщении `user`;
- **лимит итераций** обязателен: модель может зациклиться (повторять один и тот же вызов, получая ту же ошибку).

У OpenAI цикл тот же, другие имена: в `response.output` приходят элементы `{"type": "function_call", "name", "arguments" (JSON-строка), "call_id"}`, а результат ты добавляешь во вход как `{"type": "function_call_output", "call_id": ..., "output": "..."}`. Обрати внимание: у OpenAI `arguments` — строка, её надо распарсить `json.loads`.

### Параллельные вызовы

Если инструменты независимы («курс USD/EUR и время в Токио»), модель может вернуть **несколько `tool_use` в одном ответе**. Ты выполняешь их (можно параллельно — `asyncio.gather`, как `Promise.all`) и возвращаешь все результаты одним сообщением. Если разбить результаты на несколько сообщений, модель «отучивается» от параллельных вызовов. Последовательные зависимые вызовы (сначала курс, потом умножение) естественно идут в разных итерациях цикла.

### tool_choice

Управляет, обязана ли модель вызвать инструмент:

| Значение | Смысл |
|---|---|
| `auto` (по умолчанию) | Модель решает сама: вызвать инструмент или ответить текстом |
| `none` | Запретить вызовы (инструменты видны, но не используются) |
| `any` | Обязательно вызвать какой-то инструмент |
| `tool` + имя | Обязательно вызвать конкретный инструмент |

Важно: на самых новых моделях Claude (например, Opus 5.5, Sonnet 5.5) принудительные режимы `any` / `tool` **не поддерживаются и возвращают 400**. Там используют `auto` + явную инструкцию в промпте («используй инструмент X») и `strict: true` для гарантии формата аргументов; если вызов был нужен только ради JSON — structured outputs (AIL-8). На моделях подешевле и постарше принудительный выбор работает. У OpenAI тоже есть `tool_choice` (`auto`/`none`/`required`/конкретная функция) и флаг `parallel_tool_calls`.

### Ошибки инструментов — это данные

Если API курсов вернул 500 или модель передала `"quote": "EURO"`, не роняй цикл. Верни `tool_result` с `is_error: true` и **понятным текстом**: «Unknown currency code 'EURO'. Use ISO 4217 codes like 'EUR'». Хорошие модели исправляются и повторяют вызов. Плохой текст ошибки (`Error 22`) — модель гадает или сдаётся.

### Безопасность: сервер не доверяет клиенту

Аргументы приходят от модели, а модель читает внешний текст (prompt injection, AIL-7). Поэтому:

1. **Валидируй аргументы** перед выполнением: типы (`strict` помогает), диапазоны, белые списки (валюты — только из известного списка; часовой пояс — только валидный IANA).
2. **Никакого `eval()`** для калькулятора: модель (или injection в данных) пришлёт `__import__('os').system(...)`. Парси выражение безопасно (модуль `ast` с белым списком операций) или опиши инструмент как `{"a": number, "op": "+|-|*|/", "b": number}`.
3. **Минимум прав.** Инструмент делает ровно одно дело; у агента нет инструментов, которые ему не нужны.
4. **Необратимые действия — только с подтверждением человека**, а лучше вообще без них. В контексте твоего трейдинга: **никаких инструментов, которые ставят, меняют или отменяют ордера, и никаких подписанных запросов к биржам** — ни в учебных, ни в «демо» проектах. Публичные данные (курсы, публичные цены) — можно.
5. **Таймауты** на каждый внешний вызов, чтобы зависший API не повесил агента.

### Как писать инструменты, которые модель использует хорошо

Из статьи Anthropic о проектировании инструментов для агентов — главное:
- меньше, но более осмысленных инструментов лучше, чем обёртка над каждым эндпоинтом;
- понятные имена, при множестве инструментов — с префиксом-неймспейсом (`fx_get_rate`, `time_now`);
- возвращай то, что нужно модели, а не сырой ответ API на 5 000 токенов; человекочитаемые поля вместо внутренних ID;
- ошибки — с подсказкой, как исправить;
- проверяй инструменты evals: смотри, какие вызовы модель делает и где ошибается.

## DeepSeek и Ollama: как это сделать у нас

Механика та же — модель просит, твой код выполняет. Но формат — Chat Completions (как у OpenAI), а не блоки Anthropic, и у DeepSeek есть две ловушки, связанные с режимом размышления.

### Цикл на DeepSeek (Chat Completions)

Инструмент описывается в обёртке `{"type": "function", "function": {...}}`, вызов приходит в `message.tool_calls`, результат возвращается сообщением с ролью `tool` и `tool_call_id`. Иллюстративно, по гайдам [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) и [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (13.11.2026):

```python
TOOLS_OAI = [
    {"type": "function", "function": {
        "name": "get_exchange_rate",
        "description": "Get the latest official ECB exchange rate between two fiat currencies. "
                       "Use it for any currency conversion. Does not support crypto.",
        "parameters": {
            "type": "object",
            "properties": {
                "base": {"type": "string", "description": "ISO 4217 code, e.g. 'USD'"},
                "quote": {"type": "string", "description": "ISO 4217 code, e.g. 'EUR'"},
            },
            "required": ["base", "quote"],
            "additionalProperties": False,
        },
    }},
    # ... calculate, get_time
]

def run(question: str) -> str:
    messages = [{"role": "user", "content": question}]
    for _ in range(MAX_ITERATIONS):
        r = deepseek.chat.completions.create(
            model="deepseek-flash", messages=messages, tools=TOOLS_OAI, max_tokens=2048,
        )
        choice = r.choices[0]
        msg = choice.message
        # Append the whole assistant message: content, tool_calls AND reasoning_content.
        # With tools in thinking mode, dropping reasoning_content of earlier turns -> 400.
        messages.append(msg)
        if choice.finish_reason != "tool_calls":
            return msg.content or ""
        for call in msg.tool_calls:                         # may be several (parallel)
            args = json.loads(call.function.arguments)      # a JSON string, like OpenAI
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,                    # must match the call
                "content": execute(call.function.name, args),   # str; errors as text
            })
    raise RuntimeError("tool loop did not finish in time")
```

Отличия от Claude, которые надо держать в голове:

- **Нет `is_error`.** В Chat Completions у сообщения `tool` есть только текст. Ошибку пиши в `content` явно: `"ERROR: Unknown currency code 'EURO'. Use ISO 4217 codes like 'EUR'."`
- **Каждый результат — отдельное сообщение `tool`**, а не все в одном `user`, как у Claude. Это не противоречит правилу «все результаты одного хода вместе»: здесь они идут подряд, сразу после сообщения `assistant` с вызовами.
- **`reasoning_content` назад обязателен.** В режиме размышления (он по умолчанию) с инструментами рассуждение всех прошлых ходов надо возвращать в истории; иначе 400. Проще всего класть в историю сам объект `message`, как в коде выше (так делает и документация DeepSeek). Если собираешь dict руками — не забудь поле.
- **`tool_choice`: `none` / `auto` / `required` / конкретная функция — но `required` и конкретная функция в режиме размышления дают 400.** Хочешь принудить вызов — выключи размышление (`extra_body={"thinking": {"type": "disabled"}}`). Узнаёшь? У новых Claude принудительный выбор запрещён всегда, у DeepSeek — только в режиме размышления.
- **Strict** — бета: клиент с `base_url="https://api.deepseek.com/beta"` и `"strict": true` у функции; урезанное подмножество JSON Schema (все поля в `required`, `additionalProperties: false`; подробности — глава 2.2).
- У DeepSeek есть и встроенные серверные инструменты (`deepseek_web_search`, `deepseek_read_url` в типах `tools`) — аналог серверных инструментов Claude. В этой главе они не нужны: цель — свой цикл.

### Ollama: tools у маленьких моделей

Через OpenAI-совместимый эндпоинт код выше работает почти без изменений (поменяй клиента и модель; `tool_choice` там не поддерживается). У нативной библиотеки `ollama` удобная особенность — можно передать Python-функции прямо в `tools`, схема построится из сигнатуры и docstring ([Tool calling](https://docs.ollama.com/capabilities/tool-calling)):

```python
def get_time(timezone: str) -> str:
    """Current time in an IANA timezone, e.g. 'Asia/Tokyo'."""
    ...

resp = ollama.chat(model="qwen3:4b", messages=messages, tools=[get_time, calculate], think=False)
messages.append(resp.message)
for call in resp.message.tool_calls or []:
    result = DISPATCH[call.function.name](**call.function.arguments)   # already a dict here
    messages.append({"role": "tool", "tool_name": call.function.name, "content": str(result)})
```

Особенности: аргументы в нативном API — уже словарь, а не строка; результат отдаётся с `tool_name`; модели нужна метка *tools* в каталоге. Главное — **качество**: 4B-модель (дефолт для твоего M2 с 8 ГБ) заметно чаще выбирает не тот инструмент, путает аргументы или «отвечает из головы». Это не повод отказаться от неё, а повод для хороших описаний, валидации и лимита итераций — ровно то, чему учит глава.

### Сравнение

| | Claude | OpenAI (Responses) | DeepSeek | Ollama |
|---|---|---|---|---|
| Определение | `name`, `description`, `input_schema` | `type: function`, `parameters` | `{"type":"function","function":{...parameters}}` | как OpenAI; нативно — можно Python-функции |
| Вызов в ответе | блоки `tool_use`, `stop_reason="tool_use"` | items `function_call` | `message.tool_calls`, `finish_reason="tool_calls"` | `message.tool_calls` |
| Аргументы | объект `input` | JSON-строка | JSON-строка | совместимо — строка; нативно — dict |
| Результат | `tool_result` в одном `user` | `function_call_output` | сообщения `tool` с `tool_call_id` | `tool` с `tool_call_id` / `tool_name` |
| Флаг ошибки | `is_error` | нет | нет — текст | нет — текст |
| Принудительный вызов | на новейших — 400 | `required` / функция | `required` / функция, но в режиме размышления — 400 | `tool_choice` не поддерживается (совместимо) |
| Strict | да | да | бета-эндпоинт | не документирован |
| Параллельные вызовы | да | да, `parallel_tool_calls` | несколько `tool_calls` в ответе | да (зависит от модели) |
| Особое | thinking-блоки в истории | — | `reasoning_content` в истории обязателен с tools | качество 4B-модели ниже — валидируй всё |

### Что брать для практики

- **Основной цикл** — DeepSeek `deepseek-flash` в режиме размышления по умолчанию: сразу столкнёшься с `reasoning_content` в истории — это ценный опыт.
- **Второй прогон сценариев** — Ollama `qwen3:4b`: увидишь, как маленькая модель ошибается в выборе инструментов (шаг с плохими описаниями будет особенно показателен).
- Инструменты в этой главе публичные и безопасные (калькулятор, курсы ЕЦБ, время) — их можно гонять через DeepSeek. Когда инструменты начнут читать твою базу (глава 3.3 · Проект 1: tool calling + Telegram), всё, что возвращают инструменты, тоже уходит в модель — тогда работаем с Ollama или с фейковой копией данных.

## Маршрут изучения

1. [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) (≈1 ч). Прочитай обзор (как работает цикл, клиентские и серверные инструменты), страницы про реализацию: определение инструментов, `tool_choice`, параллельные вызовы, обработку результатов и ошибок (`is_error`), strict tool use. Обрати внимание на правила форматирования `tool_result` и на то, что в SDK есть готовый «tool runner» (бета), который крутит цикл за тебя — сегодня пиши цикл руками, чтобы понять механику.
2. [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling) (≈30 мин). Сравни: `function_call` / `function_call_output`, `call_id`, `arguments` как строка, `strict`, `parallel_tool_calls`. Возьми: таблицу соответствия терминов Anthropic ↔ OpenAI.
3. [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (≈30 мин). Главное: как выбирать набор инструментов, называть их, возвращать «полезный контекст», писать описания и ошибки, и как оценивать инструменты.
4. Для калькулятора: документация модуля [`ast`](https://docs.python.org/3/library/ast.html) (≈10 мин) — `ast.parse(expr, mode="eval")` и обход узлов `BinOp`, `UnaryOp`, `Constant`. Для времени — модуль [`zoneinfo`](https://docs.python.org/3/library/zoneinfo.html) (≈5 мин).
5. Публичный API курсов валют без ключа — например, Frankfurter ([frankfurter.dev](https://frankfurter.dev/); старый домен frankfurter.app перенаправляет туда), курсы ЕЦБ (≈5 мин): найди в его документации эндпоинт последнего курса и формат ответа. Это публичный неподписанный запрос — никаких ключей.
6. DeepSeek (≈30 мин): [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) (цикл, strict mode), в [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) — раздел про инструменты и возврат `reasoning_content`, в [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) — `tools` и `tool_choice` с ограничениями в режиме размышления. Возьми: что делать, чтобы не получить 400.
7. Ollama (≈15 мин): [Tool calling](https://docs.ollama.com/capabilities/tool-calling) — передача функций, параллельные вызовы, агентный цикл, стриминг с инструментами. Возьми: формат сообщения `tool` с `tool_name`.
8. Практика (≈2 ч).

## На что обратить внимание

- **Забыл положить `tool_use` в историю** перед `tool_result` → 400: результат без вызова.
- **Несовпадение `tool_use_id`** → 400 или модель путает результаты.
- **Результаты параллельных вызовов в разных сообщениях** → модель перестаёт вызывать параллельно; часть результатов может «потеряться».
- **Нет лимита итераций** → бесконечный цикл и счёт. Логируй каждую итерацию и стоимость.
- **`max_tokens` во время вызова.** Если `stop_reason == "max_tokens"` и в ответе неполный `tool_use` — не выполняй его.
- **Модель «отвечает из головы»** вместо вызова инструмента (особенно с курсами валют — она помнит примерные). Лечится описанием («всегда используй для конвертации, твои знания устарели») и системным промптом; на моделях, где можно, — `tool_choice`.
- **Слишком большой результат инструмента** съедает контекст и деньги. Обрезай и форматируй.
- **Числа.** Модели неплохо, но не идеально считают в уме. Если есть калькулятор, требуй использовать его для любой арифметики.
- **JSON аргументов** парси библиотекой (`json.loads` / объект SDK), никогда не сравнивай строки — экранирование у разных моделей разное.

## Практика

`week2/tools/`: `tools.py` (определения + реализации), `loop.py` (цикл), `run_cases.py` (сценарии). Все внешние вызовы — только публичные, без ключей, с таймаутом.

- [ ] **1. Калькулятор.** `calculate(expression: str) -> float` на `ast` с белым списком: числа, `+ - * / **`, скобки, унарный минус. Тесты: `"2+2*2" == 6`, `"__import__('os')"` → `ValueError`, `"10**100**100"` → отказ (ограничь степень).
- [ ] **2. Курс валют.** `get_exchange_rate(base, quote) -> dict` через `httpx.get(..., timeout=10)` к публичному API. Валидация: коды — 3 заглавные буквы, из списка поддерживаемых API валют. Возвращай компактно: `{"base": "USD", "quote": "EUR", "rate": 0.92, "date": "2026-11-25"}`.
- [ ] **3. Время.** `get_time(timezone: str) -> dict` на `zoneinfo`: `{"timezone": "Asia/Tokyo", "iso": "...", "weekday": "Wednesday"}`. Невалидный пояс → понятная ошибка с примером валидного.
- [ ] **4. Схемы** трёх инструментов с хорошими описаниями (когда использовать / когда нет / формат) и `strict: true`.
- [ ] **5. Цикл** `run(question)` с лимитом 5 итераций, логированием каждой итерации (какие инструменты, аргументы, результат, токены, стоимость через `estimate_cost`).
- [ ] **6. Сценарии** в `run_cases.py`; для каждого сохрани трассу вызовов:
  - «Сколько будет 17.5% от 2340?» → только калькулятор;
  - «Который час в Токио и в Нью-Йорке?» → ожидаем два параллельных `get_time` в одном ходе;
  - «Сколько будет 100 USD в EUR, умноженное на 3?» → курс, затем калькулятор (две итерации);
  - «Привет, как дела?» → без инструментов.
- [ ] **7. Ошибка инструмента.** Временно сделай так, чтобы `get_exchange_rate` для `EUR` бросал исключение «Upstream API timeout». Посмотри: что модель делает с `is_error: true`? Повторяет? Сообщает пользователю? Потом верни ошибку с подсказкой («try again later or ask the user») — изменилось ли поведение?
- [ ] **8. Плохие vs хорошие описания.** Замени описания на плохие (`"name": "t2", "description": "rate"` и т. п.), прогони сценарии из шага 6. Запиши: где модель ошиблась в выборе инструмента или ответила из головы. Верни хорошие.
- [ ] **8б. Ловушки DeepSeek.** (а) Собери историю руками без `reasoning_content` в режиме размышления — получи 400 и запиши текст ошибки. (б) Поставь `tool_choice="required"` при включённом размышлении — 400; выключи размышление — работает. (в) Включи strict на бета-эндпоинте для `get_exchange_rate`.
- [ ] **8в. Ollama.** Прогони сценарии шага 6 на Ollama (`qwen3:4b`, нативный API, функции переданы напрямую). Таблица: сценарий → DeepSeek верно? → Ollama верно? → какие ошибки у маленькой модели.
- [ ] **9. (Опционально, для сравнения) Claude и OpenAI.** Тот же цикл на Anthropic Messages (блоки `tool_use`/`tool_result`, `is_error`) и на Responses API — отметь отличия в формате. Попробуй принудительный `tool_choice` на новейшей модели Claude — 400.
- [ ] **10. Заметка** `notes/tool-calling.md`: схема цикла, 5 правил хороших инструментов, что ты увидел в шагах 7–8.

## Готово, когда

- Модель (DeepSeek) сама выбирает нужный инструмент во всех сценариях шага 6 и правильно комбинирует два инструмента в вопросе про 100 USD × 3; для Ollama записано, где она ошибается.
- Цикл на DeepSeek корректно работает в режиме размышления (`reasoning_content` возвращается в историю).
- Цикл ограничен 5 итерациями, ошибки инструментов возвращаются модели как `is_error`, аргументы валидируются, `eval()` нигде нет.
- Трассы вызовов и выводы о плохих/хороших описаниях записаны.

## Тест для самопроверки

1. Кто выполняет функцию при tool calling — модель или твой код? Что именно генерирует модель?
2. Какой `stop_reason` означает, что модель ждёт результата инструмента?
   a) `end_turn`; b) `tool_use`; c) `max_tokens`; d) `pause_turn`
3. Модель вернула два блока `tool_use` в одном ответе. Как правильно вернуть результаты?
4. Что не так в этом коде?
   ```python
   def calculator(expression: str) -> str:
       return str(eval(expression))
   ```
5. Что не так в этом цикле?
   ```python
   while True:
       resp = client.messages.create(model=M, max_tokens=1024, tools=TOOLS, messages=messages)
       if resp.stop_reason == "end_turn":
           break
       for b in resp.content:
           if b.type == "tool_use":
               messages.append({"role": "user", "content": [
                   {"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b)}]})
   ```
6. Инструмент упал с исключением. Что лучше: прервать цикл или вернуть модели ошибку? Как?
7. Почему описание инструмента важнее его кода с точки зрения модели?
8. Ты передал `tool_choice={"type": "tool", "name": "get_time"}` самой новой модели Claude и получил 400. Почему и что делать?
9. Почему инструмент «поставить ордер на бирже» нельзя давать агенту даже в демо, по правилам этого курса — и какой общий принцип за этим стоит?
10. Чем отличаются `arguments` у OpenAI от `input` у Anthropic с точки зрения кода?
11. Зачем лимит итераций, если модель «и так закончит»?
12. Что не так в этом цикле для DeepSeek (режим размышления по умолчанию)?
    ```python
    msg = r.choices[0].message
    messages.append({"role": "assistant", "content": msg.content, "tool_calls": msg.tool_calls})
    for c in msg.tool_calls:
        messages.append({"role": "tool", "tool_call_id": c.id, "content": run_tool(c)})
    ```
13. Как вернуть модели ошибку инструмента у DeepSeek, если поля `is_error` нет?
14. Ты хочешь заставить DeepSeek обязательно вызвать `get_time`. Что будет с `tool_choice={"type": "function", "function": {"name": "get_time"}}` по умолчанию и как это починить?
    a) работает всегда; b) 400 в режиме размышления — выключить размышление или использовать `auto` + инструкцию; c) `tool_choice` у DeepSeek не существует; d) нужно `is_error`

## Ответы

1. Твой код. Модель генерирует структурированный запрос на вызов: имя инструмента и аргументы по схеме.
2. **b.**
3. Выполнить оба, затем добавить в историю весь ответ `assistant` и **одно** сообщение `user` с двумя `tool_result`, у каждого свой `tool_use_id`.
4. `eval` исполняет произвольный Python: модель или prompt injection в данных может выполнить любой код. Нужен безопасный парсер на `ast` с белым списком операций и ограничениями.
5. Не добавляется ответ `assistant` с `tool_use` в историю (API вернёт ошибку); результаты разных вызовов идут разными сообщениями; нет лимита итераций; не обработаны `max_tokens`/другие причины остановки (цикл крутится вечно); исключения инструмента не перехватываются.
6. Вернуть модели `tool_result` с `is_error: true` и понятным текстом ошибки с подсказкой; модель может исправить аргументы, попробовать иначе или честно сообщить пользователю.
7. Модель не видит код — только имя, описание и схему. По ним она решает, вызывать ли инструмент и с какими аргументами.
8. На новейших моделях Claude принудительный `tool_choice` (`tool`/`any`) не поддерживается. Использовать `auto` + явную инструкцию в промпте и `strict: true`, либо structured outputs, если нужен только JSON.
9. Аргументы приходят от модели, которая может ошибиться или поддаться prompt injection, а действие необратимо и связано с деньгами. Принцип: минимум прав; необратимые действия — не через LLM или только с явным подтверждением человека (а в этом курсе — никогда).
10. У OpenAI `arguments` — JSON-строка, её надо `json.loads`; у Anthropic `input` — уже разобранный объект. В обоих случаях после этого валидируешь.
11. Модель может зациклиться (повторять вызов с той же ошибкой, «уточнять» бесконечно); лимит защищает от бесконечного счёта и зависаний.
12. В историю не попал `reasoning_content` — с инструментами в режиме размышления это 400 на следующем запросе (проще класть сам объект `msg`). Ещё: не проверен `finish_reason`, нет лимита итераций, аргументы не распарсены и не провалидированы, исключения `run_tool` не перехвачены.
13. Текстом в `content` сообщения `tool`: явный префикс вроде `ERROR:` плюс понятное объяснение и подсказка, как исправить.
14. **b.** Принудительный выбор (`required` или конкретная функция) в режиме размышления даёт 400; без размышления работает.

## Что дальше

Последняя глава недели — [2.7 · Стриминг, ретраи, rate limits, prompt caching (AIL-11)](AIL-11.md): превратишь свои скрипты в надёжную мини-библиотеку `llm_utils.py`, на которой будут стоять все проекты, включая агентов с инструментами.
