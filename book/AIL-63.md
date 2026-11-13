# 9.2 · Workflow-паттерны: chaining, routing, parallelization  (AIL-63)

> **Неделя 9** · Агенты · ⏱ ~4 ч · Практика

## Зачем это AI-инженеру

Большинство «агентов» в продакшене — на самом деле workflow: фиксированная цепочка вызовов LLM с проверками между ними. Они проще, дешевле, быстрее и, главное, тестируемы по шагам. На собеседовании ценится умение сказать: «тут хватит роутера и двух промптов» — и показать код.

## Теория

Определения и общую картину пяти паттернов ты разобрал в AIL-37. Здесь — как три самых частых паттерна выглядят в коде и какие решения ты принимаешь при их реализации.

### Общий каркас: один вызов LLM как функция

Любой workflow строится из маленьких функций «вход → LLM → проверенный выход». Сделай одну обёртку и используй её везде:

```python
# llm.py — illustrative, check current SDK docs for exact params and model names
import os
from anthropic import Anthropic

client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment
MODEL = os.environ["LLM_MODEL"]  # pick a current model name from the docs

def ask(system: str, user: str, max_tokens: int = 500) -> str:
    resp = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return resp.content[0].text
```

Аналогия с TypeScript: это как `fetchJson()` — одна точка, где живут таймауты, ретраи, логирование и подсчёт токенов (`resp.usage`). Если используешь OpenAI — то же самое через `client.responses.create` или `chat.completions.create`; паттерны от провайдера не зависят.

Для шагов, чей выход читает код, а не человек, нужен **структурированный вывод**: JSON по схеме (structured output) или Pydantic-модель с валидацией — ты разбирал это раньше в главе про structured output. Правило: каждый выход шага проверяется кодом **до** передачи дальше.

### 1. Prompt chaining

```
news ──► [extract: coin, event] ──► gate ──► [assess impact] ──► [summary] ──► out
                                     │
                                     └─ no coin found → stop early
```

Ключевые решения:

- **Нарезка.** Каждый шаг должен быть проще целого и проверяем отдельно. «Извлечь тикер» — проверяем по списку рынков. «Оценить влияние» — по enum `{bullish, bearish, neutral}`.
- **Gate (ворота).** Программная проверка между шагами: если монета не найдена в твоём списке рынков, дальше не идём. Gate экономит токены и обрывает цепочку ошибок.
- **Что передавать дальше.** Только нужное. Шагу «сводка» не нужен полный текст новости, если ему передали извлечённые факты; меньше контекста — меньше места для инъекции и путаницы.

Плата: латентность складывается (3 шага = 3 запроса подряд). Выигрыш: точность каждого шага выше, чем у одного огромного промпта.

### 2. Routing

```
question ──► [classify] ──► "positions" ──► handler_positions (SQL over DB copy)
                       ├──► "docs"      ──► handler_docs (RAG over exchange docs)
                       └──► "general"   ──► handler_general (plain LLM)
```

Ключевые решения:

- **Классификатор** может быть LLM (небольшая дешёвая модель), обычным ML-классификатором или даже правилами по ключевым словам. Часто комбинация: сначала правила, LLM — для остального.
- **Закрытый набор меток** + метка-фолбэк (`general` или `unknown`). Выход классификатора проверяется: если метка не из набора — фолбэк.
- **Разные обработчики = разные права и модели.** Обработчик «позиции» получает доступ к копии базы, «общий» — нет. Это уже безопасность: вопрос, не прошедший роутинг в `positions`, физически не может прочитать базу.
- **Оценка роутера отдельно.** Сделай 20–30 размеченных вопросов и меряй accuracy классификатора: ошибка роутинга ломает весь ответ.

### 3. Parallelization

Две формы:

- **Sectioning** — разные независимые части параллельно. Например, один вызов отвечает, второй проверяет вопрос на недопустимое (guardrail). Или сводка новости и извлечение сущностей одновременно.
- **Voting** — одна задача N раз (разные промпты или та же с temperature > 0), затем агрегация: большинство, минимум, среднее, «все согласны».

```
news ─┬─► [judge prompt A] ─► bearish ─┐
      ├─► [judge prompt B] ─► bearish ─┼─► majority: bearish (2/3)
      └─► [judge prompt C] ─► neutral ─┘
```

В Python параллельность — через `asyncio`, как `Promise.all` в Node:

```python
# illustrative
import asyncio
from anthropic import AsyncAnthropic

aclient = AsyncAnthropic()

async def judge(prompt: str, news: str) -> str:
    resp = await aclient.messages.create(
        model=MODEL, max_tokens=50, system=prompt,
        messages=[{"role": "user", "content": news}],
    )
    return resp.content[0].text.strip().lower()

async def vote(news: str, prompts: list[str]) -> list[str]:
    return await asyncio.gather(*(judge(p, news) for p in prompts))  # like Promise.all
```

Ключевые решения:

- **Правило агрегации** выбирается по цене ошибки. Для «стоит ли оповестить» — большинство. Для «это безопасно» — требуй единогласия (лучше лишний раз отказать).
- **Разнообразие голосов.** Три одинаковых промпта при temperature 0 дадут почти один и тот же ответ — голосование бессмысленно. Меняй формулировку, угол зрения («оцени как трейдер», «оцени как риск-менеджер») или модель.
- **Стоимость ×N.** Голосование утраивает расход — используй там, где ошибка дорогая.
- **Rate limits.** `gather` на 50 задачах упрётся в лимиты провайдера; ограничивай конкурентность `asyncio.Semaphore`.

### Где хранить и как смотреть результаты

Для каждого запуска пиши в лог: вход, выход каждого шага, токены (`resp.usage.input_tokens`, `output_tokens`), время. Без этого ты не узнаешь, какой шаг цепочки ломается. Это та же идея, что трассировка в твоём сервере: один ID запроса проходит через все шаги.

### Данные для упражнений

Новости бери публичные (анонсы листингов/делистингов бирж, блоги проектов) — скопируй текст вручную в файлы `exercises/data/news_*.txt`. Для routing-обработчика «позиции» используй копию базы, сделанную через `VACUUM INTO`, и открывай её только на чтение; никаких запросов к биржам с ключами.

## DeepSeek и Ollama: как это сделать у нас

Паттерны от провайдера не зависят, поэтому главное — одна обёртка, в которой провайдер выбирается переменной окружения. И DeepSeek, и Ollama говорят на OpenAI Chat Completions, так что хватит одного SDK `openai` с разным `base_url`. Факты проверены по документации DeepSeek и Ollama 13 ноября 2026; имена моделей и цены меняются — сверяйся с [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) и [библиотекой Ollama](https://ollama.com/library).

### Обёртка `llm.py` на двух провайдерах

```python
# llm.py — illustrative; pin `openai` and `pydantic` versions in pyproject.toml
import os, time, sys, json
from openai import OpenAI
from pydantic import BaseModel, ValidationError

PROVIDERS = {
    # DeepSeek: cloud, servers in China -> public/fake data only
    "deepseek": dict(base_url="https://api.deepseek.com",
                     api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
                     model=os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")),
    # Ollama: local, private; the key is required by the SDK but ignored by Ollama
    "ollama": dict(base_url="http://localhost:11434/v1", api_key="ollama",
                   model=os.environ.get("OLLAMA_MODEL", "qwen3:4b")),
}

def make(provider: str):
    cfg = PROVIDERS[provider]
    return OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"]), cfg["model"]

def ask(provider: str, system: str, user: str, max_tokens: int = 800, **kw) -> str:
    client, model = make(provider)
    extra = {}
    if provider == "deepseek":
        # Thinking is ON by default on DeepSeek; a classifier/extractor does not need it
        extra["extra_body"] = {"thinking": {"type": "disabled"}}
    t0 = time.monotonic()
    resp = client.chat.completions.create(
        model=model, max_tokens=max_tokens,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        **extra, **kw)
    u = resp.usage
    print(json.dumps({"provider": provider, "in": u.prompt_tokens, "out": u.completion_tokens,
                      # DeepSeek-only fields; absent elsewhere
                      "cache_hit": getattr(u, "prompt_cache_hit_tokens", None),
                      "ms": int((time.monotonic() - t0) * 1000)}), file=sys.stderr)
    return resp.choices[0].message.content or ""
```

### `ask_json`: у каждого провайдера свой способ

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON по схеме | Structured outputs / tool с `input_schema` | `response_format` типа `json_schema` (strict) | **Только** `response_format={"type": "json_object"}` — валидный JSON без схемы; слово «json» обязано быть в промпте; иногда `content` приходит пустым — нужен повтор | `format=<JSON-схема>` в нативном API (ограниченное декодирование) или `response_format` в OpenAI-совместимом |
| Если схема не поддерживается | — | — | Схему и пример кладёшь в промпт, проверяешь Pydantic, при ошибке — повтор | Схему ещё и в промпт (так советует сама Ollama), `temperature=0` |

```python
def ask_json(provider: str, system: str, user: str, schema: type[BaseModel], retries: int = 2):
    hint = f"\nReturn only json matching this schema:\n{json.dumps(schema.model_json_schema())}"
    for attempt in range(retries + 1):
        if provider == "deepseek":
            raw = ask(provider, system + hint, user, response_format={"type": "json_object"})
        else:  # Ollama via OpenAI compat; native lib: ollama.chat(..., format=schema.model_json_schema())
            raw = ask(provider, system + hint, user, temperature=0,
                      response_format={"type": "json_schema",
                                       "json_schema": {"name": schema.__name__,
                                                       "schema": schema.model_json_schema()}})
        try:
            return schema.model_validate_json(raw)
        except ValidationError as e:
            print(f"bad json (attempt {attempt}): {e}", file=sys.stderr)
    raise RuntimeError("model did not return valid json")
```

Документация Ollama говорит, что structured outputs работают через `response_format` в OpenAI-совместимом API, но не расписывает, какой вариант `response_format` принят; если `json_schema` не сработает, используй нативную библиотеку: `ollama.chat(model=..., messages=..., format=Schema.model_json_schema(), options={"temperature": 0})` — этот путь описан в доке прямо.

### Параллельность и голосование: что меняется

- **DeepSeek**: лимит — число одновременных запросов на аккаунт (на ноябрь 2026: 2500 для `deepseek-flash`, 500 для `deepseek-v4-pro`), при превышении — HTTP 429. `Semaphore(5–10)` для учёбы с запасом.
- **Ollama**: по умолчанию `OLLAMA_NUM_PARALLEL=1` — запросы к одной модели выполняются **по очереди**. `asyncio.gather` на 3 голоса не ускорит ничего, пока не поднимешь параметр (и память на это есть: расход растёт как `NUM_PARALLEL × контекст`).
- **Thinking-режим DeepSeek игнорирует `temperature`** (ошибки не будет, просто не сработает). Голосование «та же модель, temperature > 0» в thinking-режиме не даст разнообразия — выключи thinking или меняй промпты.
- **Лучший источник разнообразия у нас — разные модели**: `deepseek-flash`, `deepseek-v4-pro` и локальная `qwen3:4b`. Ошибки разных моделей коррелированы слабее, чем ошибки одной модели с тремя похожими промптами.

### Какие данные куда

| Упражнение | Данные | Провайдер |
|---|---|---|
| 01_chaining | Публичные новости | DeepSeek (основной) или Ollama |
| 02_routing | Вопросы о **твоих** позициях + строки копии базы | **Только Ollama** — и классификатор, и обработчики: сам текст вопроса («почему закрылась моя позиция по X на bybit») уже приватен |
| 03_parallel_voting | Публичные новости | Смесь моделей DeepSeek + Ollama |

Ollama ставь с ollama.com (проверь `codesign -dv` и `spctl -a -vv` у приложения перед первым запуском), модель — `ollama pull qwen3:4b` (≈2.5 ГБ; на твоём M2 с 8 ГБ это потолок для постоянной работы рядом с арбитражным приложением, `qwen3:8b` — только когда всё остальное закрыто и автоторговля не взведена). Для упражнения с реальной базой запускай Ollama с `OLLAMA_NO_CLOUD=1`, чтобы случайно не уйти в облачную модель.

## Маршрут изучения

1. [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) → перечитай раздел Workflows: Prompt chaining, Routing, Parallelization (≈20 мин). Обрати внимание на абзацы «When to use this workflow» и примеры — сравни со своими.
2. [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) → найди папку с паттернами агентов (`patterns/agents`, ноутбук про базовые workflow) (≈40 мин). Прочитай реализацию chain, route и parallel. Обрати внимание, как они парсят ответы через XML-теги и как устроен `parallel` (пул потоков). Не копируй — пиши своё, но сверяйся.
3. Документация твоего провайдера по structured output / tool use (раздел про JSON-схемы) — освежи то, что разбирал в главе про structured output (≈20 мин). Цель: выход классификатора и экстрактора — валидный JSON по схеме.
4. Python: официальная документация `asyncio` → `asyncio.gather` и `asyncio.Semaphore` (≈20 мин). Сопоставь с `Promise.all` и `p-limit` в Node.
5. DeepSeek: [JSON Output](https://api-docs.deepseek.com/guides/json_mode) (≈10 мин) — требования к промпту и пустой `content`; [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) — как выключить thinking и какие параметры он игнорирует (≈10 мин); [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) (≈5 мин).
6. Ollama: [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) и [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (≈15 мин); в [FAQ](https://docs.ollama.com/faq) — `OLLAMA_NUM_PARALLEL` (≈5 мин).
7. Дальше — практика (≈2.5 ч).

## На что обратить внимание

- **Не проверять выход шага** — главная ошибка цепочек. LLM вернула «Тикер: BTC.» вместо `{"coin": "BTC"}` — следующий шаг молча получает мусор.
- **Тикеры неоднозначны.** «SUN», «AI», «ONE» — и монеты, и слова. Сверяй с реальным списком рынков (выгрузи его заранее в JSON, без ключей — это публичные данные).
- **Роутер без фолбэка** рано или поздно вернёт метку, которой нет в словаре обработчиков, и упадёт с `KeyError`.
- **Голосование с одинаковыми голосами** создаёт иллюзию надёжности.
- **Параллельность ≠ бесплатность**: латентность падает, стоимость — нет.
- **Не храни ключ в коде**: `DEEPSEEK_API_KEY` (и для сравнения `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) — из окружения или `.env`, который в `.gitignore`.
- **Инъекция в новости.** Текст новости — недоверенный ввод. Пока шаги только читают и пишут текст, это не опасно; не давай этим шагам инструментов.

## Практика

Структура:

```
exercises/
  llm.py                 # shared ask() wrapper with logging of tokens and time
  data/news_*.txt        # 5 public news texts, copied by hand
  data/markets.json      # list of symbols from public market data
  01_chaining.py
  02_routing.py
  03_parallel_voting.py
```

- [ ] **llm.py.** Обёртка `ask(provider, ...)` + `ask_json(provider, system, user, schema)` с валидацией через Pydantic и повтором (см. раздел про DeepSeek и Ollama). Провайдер — аргумент или `LLM_PROVIDER` из окружения; ключ DeepSeek — из `.env` в `.gitignore`. Логи в stderr: провайдер, шаг, токены, `prompt_cache_hit_tokens` (DeepSeek), мс.
- [ ] (для сравнения, по желанию) Та же обёртка на `anthropic` / `openai` с их нативным structured output — посмотри, сколько кода ремонта JSON становится не нужно.
- [ ] **01_chaining.py.** Цепочка из трёх шагов:
  1. `extract(news) -> {"coin": str | None, "event": str}`;
  2. gate: `coin` есть в `markets.json`, иначе вывести «монета не найдена» и выйти;
  3. `assess(coin, event) -> {"impact": "bullish"|"bearish"|"neutral", "reason": str}`;
  4. `summarize(...) -> str` до 280 символов, на русском.
  Прогони на 5 новостях на `deepseek` и на `ollama`. Ожидаемый результат: для новости без монеты цепочка останавливается на gate, для остальных — короткая сводка. Запиши, сколько раз у каждого провайдера сработал повтор в `ask_json`.
- [ ] **02_routing.py.** Классификатор → `positions` / `docs` / `general` (+ фолбэк). Обработчики:
  - `positions`: открывает копию базы на чтение (`sqlite3.connect("file:arb-copy.db?mode=ro", uri=True)`) и выполняет **один из заранее написанных** SQL-запросов (например, «последние 10 закрытых позиций»), LLM только формулирует ответ по результату;
  - `docs`: использует свой RAG-индекс из прошлых глав;
  - `general`: просто `ask()`.
  Сделай 15 вопросов с правильными метками в `data/routing_eval.json`, посчитай accuracy роутера. Ожидаемо — 13+/15; разберись с ошибками. **Весь файл работает только через `ollama`** (вопросы и строки базы — твои реальные данные; в DeepSeek они не уходят). Если хочешь сравнить с DeepSeek — сделай 15 вопросов про выдуманные позиции и фейковую базу.
- [ ] **03_parallel_voting.py.** Три разных промпта-«судьи» оценивают влияние одной новости; `asyncio.gather` (клиент `AsyncOpenAI` с тем же `base_url`); агрегация по большинству; при трёх разных ответах — `uncertain`. Выведи все голоса и итог. Второй вариант: один промпт, три **модели** (`deepseek-flash`, `deepseek-v4-pro`, `qwen3:4b`) — сравни, как часто голоса расходятся в двух вариантах.
- [ ] Для каждого файла запиши в комментарий в начале: сколько вызовов LLM, сколько токенов в среднем, время.

## Готово, когда

- В `exercises/` три рабочих мини-примера, каждый запускается одной командой.
- В цепочке есть gate, в роутере — фолбэк и измеренная accuracy, в голосовании — понятное правило агрегации.
- Логи показывают токены и время каждого шага.

## Тест для самопроверки

1. Зачем нужен gate между шагами цепочки?
2. Что из этого лучше всего подходит под routing?
   a) перевод длинного документа по частям; b) разные типы вопросов в боте с разными источниками данных; c) три независимых оценки одной новости; d) генерация и правка текста по критериям.
3. Чем sectioning отличается от voting?
4. Что не так в этом коде?
   ```python
   HANDLERS = {"positions": h_pos, "docs": h_docs, "general": h_gen}
   label = ask("Classify the question into positions/docs/general", q)
   return HANDLERS[label](q)
   ```
5. Почему голосование трёх одинаковых промптов при temperature 0 почти ничего не даёт?
6. Какой Python-аналог `Promise.all`?
7. Как ограничить число одновременных запросов к API в asyncio?
8. Обработчик `positions` в роутере: почему лучше набор заранее написанных SQL-запросов, а не «LLM пишет SQL»?
9. Цепочка из трёх шагов работает медленнее одного большого промпта. Почему её всё равно часто выбирают?
10. Для решения «показывать ли пользователю этот ответ как безопасный» какое правило агрегации голосов разумнее: большинство или единогласие?
11. Ты запускаешь голосование на DeepSeek с `temperature=1.0` и одним промптом, но все три голоса всегда одинаковы, а thinking не выключен. В чём может быть дело, и как получить разнообразие?
12. `asyncio.gather` трёх запросов к локальной Ollama занимает втрое больше времени, чем один запрос. Почему?
13. Чем `response_format={"type": "json_object"}` у DeepSeek отличается от `json_schema` у OpenAI и `format` у Ollama? Что из этого следует для кода?
14. Почему в `02_routing.py` и классификатор, а не только обработчик `positions`, должен работать на Ollama?

## Ответы

1. Программно проверить выход шага и остановить цепочку, если он неверен: экономит токены и не даёт ошибке распространиться дальше.
2. b. Routing — классификация входа и отправка в специализированный обработчик.
3. Sectioning — разные независимые подзадачи параллельно; voting — одна и та же задача несколько раз, затем агрегация ответов.
4. Ответ модели не нормализуется и не проверяется: придёт «Positions.» или «docs\n» — будет `KeyError`. Нужны structured output или `strip().lower()`, проверка по набору и фолбэк `HANDLERS.get(label, h_gen)`.
5. Ответы будут почти идентичны, ошибки скоррелированы — голоса не независимы, большинство ничего не исправляет.
6. `asyncio.gather(*coros)`.
7. `asyncio.Semaphore(n)` и `async with sem:` вокруг вызова.
8. Предсказуемость и безопасность: заранее написанные запросы проверены, параметризованы и только читают; сгенерированный SQL может быть неверным, тяжёлым или (через инъекцию) делать не то. Это минимизация прав (LLM06).
9. Каждый шаг проще и точнее, его можно проверить и протестировать отдельно, легко найти, какой шаг ломается.
10. Единогласие (или «любой против — отказ»): цена ложного «безопасно» выше цены лишнего отказа.
11. В thinking-режиме DeepSeek `temperature` не действует (ошибки нет, эффекта тоже). Выключи thinking через `extra_body={"thinking": {"type": "disabled"}}`, меняй промпты или голосуй разными моделями.
12. По умолчанию `OLLAMA_NUM_PARALLEL=1`: запросы к одной модели обрабатываются по очереди. Нужно поднять параметр (если хватает памяти) — или принять, что локально параллельность не ускоряет.
13. `json_object` гарантирует только валидный JSON, не схему; `json_schema`/`format` ограничивают вывод самой схемой. На DeepSeek схема и пример идут в промпт, а ответ обязательно проверяется Pydantic с повтором; пустой `content` тоже надо обработать.
14. Классификатор получает текст вопроса, а вопрос уже содержит приватное (пары, биржи, твои позиции). Отправить его в DeepSeek — значит отправить приватные данные в облако в Китае.

## Что дальше

Глава 9.3 · Цикл агента руками (AIL-38): от фиксированных путей переходишь к циклу, где следующий шаг выбирает сама модель через tool calling.
