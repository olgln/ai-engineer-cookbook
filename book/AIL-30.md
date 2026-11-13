# 6.5 · Подключить Langfuse или promptfoo  (AIL-30)

> **Неделя 6** · Evals · ⏱ ~4 ч · Практика

## Зачем это AI-инженеру

Свой скрипт из [AIL-29](AIL-29.md) считает цифры, но смотреть в нём отдельные запросы неудобно: JSONL в терминале — не лучший интерфейс. Инструменты наблюдаемости (observability) показывают каждый запрос как дерево шагов с промптом, ответом, токенами, ценой и временем, хранят датасеты и результаты прогонов. В вакансиях AI-инженера Langfuse, LangSmith, Braintrust, promptfoo и подобные упоминаются постоянно; понимать, какую задачу они решают, важнее, чем знать конкретный.

## Теория

### Две разные задачи: трейсинг и сравнение промптов

| | Langfuse | promptfoo |
|---|---|---|
| Что это | Платформа наблюдаемости: трейсы, датасеты, эксперименты, оценки, промпты | CLI для сравнения промптов, моделей и конфигураций на наборе тестов |
| Где живёт | Сервер (облако или self-hosted в Docker) + SDK в твоём коде | Локально, Node.js-утилита + YAML-конфиг |
| Сильная сторона | Видеть, что происходит в продакшене и в каждом прогоне | Быстро сравнить «промпт A против B» таблицей |
| Аналогия из твоего мира | Логи сервера `logs/prod/*.log` + дашборд `/health`, только структурированные | `npm test` с матрицей вариантов |

Это не конкуренты, а соседи: Langfuse для «что происходит в системе», promptfoo для «какой вариант лучше». В задаче ты пробуешь оба.

### Трейс, спан, генерация

**Trace** — один запрос пользователя целиком. Внутри — вложенные **observations** (спаны): поиск, реранкинг, сборка промпта, вызов модели. Вызов модели — особый тип наблюдения, **generation**: у него есть модель, вход, выход, токены и стоимость.

```
trace: "Как часто funding на OKX?"            2.3s   $0.004
 ├─ span: rewrite_query                       0.4s
 │   └─ generation: <small model>             0.4s   $0.0003
 ├─ span: retrieve (hybrid, k=5)              0.2s
 ├─ span: rerank                              0.3s
 └─ generation: answer <main model>           1.4s   $0.0037
       input: system + 5 chunks + question
       output: "Обычно каждые 8 часов... [1]"
       usage: in 3120 / out 140
```

Глядя на такое дерево, ты сразу видишь, что съедает время и деньги, и что именно модель получила на вход. Для разбора ошибок в [AIL-34](AIL-34.md) это сильно удобнее, чем `results.jsonl`.

### Как Langfuse попадает в код

Три уровня интеграции (точные имена функций сверь с текущей документацией SDK, они менялись между версиями):

1. **Декоратор `@observe()`** на своих функциях: каждая обёрнутая функция становится спаном, вложенность определяется стеком вызовов. Это похоже на middleware, которое оборачивает обработчик.
2. **Готовые интеграции**: для OpenAI SDK есть замена импорта (`from langfuse.openai import OpenAI`), вызовы модели логируются автоматически вместе с токенами. Для других SDK — обёртка вручную или OpenTelemetry-инструментация.
3. **Ручной генерации** (`as_type="generation"`) с `model`, `usage_details` и выходом.

Иллюстративный пример по документации Langfuse Python SDK:

```python
# rag.py  (illustrative; check the current Langfuse SDK docs)
from langfuse import observe, get_client

langfuse = get_client()  # reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from env

@observe()
def retrieve(question: str, cfg: dict) -> list[dict]:
    ...  # vector / hybrid search; inputs and outputs are captured automatically

@observe(as_type="generation", name="answer")
def generate(question: str, chunks: list[dict], cfg: dict) -> dict:
    resp = llm_call(question, chunks, cfg)   # your Anthropic / OpenAI call
    langfuse.update_current_generation(
        model=cfg["answer_model"],
        usage_details={"input_tokens": resp.in_tokens, "output_tokens": resp.out_tokens},
    )
    return {"text": resp.text}

@observe()
def ask(question: str, cfg: dict) -> dict:
    chunks = retrieve(question, cfg)
    return generate(question, chunks, cfg)

# in short-lived scripts, flush before exit, otherwise events may be lost
langfuse.flush()
```

Стоимость Langfuse вычисляет по модели и токенам, если модель есть в его таблице цен; для остальных можно задать цену самому (см. раздел про модели и цены в документации). Сверь его цифру с той, что считает твой скрипт.

### Датасеты и эксперименты в Langfuse

Датасет в Langfuse — те же элементы, что в `evals/dataset.jsonl`: `input` (вопрос), `expected_output` (эталон), `metadata` (тип, биржа, цитаты). **Эксперимент** (dataset run) — прогон твоей функции по всем элементам датасета; каждый элемент связан со своим трейсом, а оценки (scores) прикрепляются к трейсам. В UI можно сравнить два прогона бок о бок по каждому вопросу.

В текущем Python SDK для этого есть «experiment runner»: ты передаёшь задачу (`task`) и функции-оценщики (`evaluators`), он прогоняет, связывает трейсы и записывает оценки. Схема (иллюстративно, по документации экспериментов через SDK):

```python
from langfuse import Evaluation, get_client

langfuse = get_client()
dataset = langfuse.get_dataset("exchange-docs-dev-v1")

def task(*, item, **kwargs):
    return ask(item.input, CFG)["text"]

def correctness(*, input, output, expected_output, metadata, **kwargs):
    verdict = judge_correctness_raw(input, expected_output, output)  # your judge from AIL-29
    return Evaluation(name="correctness", value=1.0 if verdict == "PASS" else 0.0)

result = dataset.run_experiment(name="baseline", task=task)  # see docs for passing evaluators
print(result.format())
```

Источник истины — всё равно твой `dataset.jsonl` в git. В Langfuse загружаешь копию с версией в имени (`exchange-docs-dev-v1`), чтобы не путать версии.

### Облако или self-hosted

- **Langfuse Cloud** — быстрее начать, есть бесплатный тариф (условия смотри на сайте). Трейсы уходят на чужой сервер. Для вопросов по публичной документации бирж это допустимо.
- **Self-hosted через Docker Compose** — всё локально, подходит, если не хочешь отдавать данные. Требует Docker и несколько контейнеров (Postgres, ClickHouse и др.); для учебы на одной машине нормально.

Правило: **никаких приватных данных в трейсах**. Langfuse пишет весь вход и выход функций под `@observe`. Если когда-нибудь подключишь к трейсингу что-то, что работает с арбитражным приложением (агент недели 9–10), убедись, что в трейсы не попадают ключи и детали аккаунтов, или используй self-hosted.

### promptfoo: декларативное сравнение

promptfoo — Node.js CLI. Ты описываешь в `promptfooconfig.yaml` промпты, провайдеров (модели или свой код) и тесты с проверками (assertions), запускаешь `promptfoo eval` и смотришь матрицу результатов в `promptfoo view`. Для тебя как TypeScript-разработчика он привычен: это по сути тест-раннер.

```yaml
# promptfoo/promptfooconfig.yaml  (illustrative)
description: Answer prompt v3 vs v4 on exchange docs questions

prompts:
  - file://prompts/answer_v3.txt
  - file://prompts/answer_v4.txt

providers:
  - id: file://provider.py        # your Python wrapper: retrieve + call the model
    label: rag-baseline

defaultTest:
  assert:
    - type: llm-rubric
      value: The answer only states facts present in the provided excerpts and cites them like [1].
    - type: latency
      threshold: 8000

tests:
  - vars:
      question: "Как часто начисляется funding на OKX?"
    assert:
      - type: icontains
        value: "8"
      - type: llm-rubric
        value: Says the interval can differ per contract.
  - vars:
      question: "Как получить API-ключ Bybit без KYC?"
    assert:
      - type: llm-rubric
        value: Refuses or says the docs do not contain this.
```

Типы проверок, которые пригодятся: `contains`/`icontains`, `regex`, `javascript` и `python` (своя функция), `llm-rubric` (судья по критерию), `cost`, `latency`. Есть и RAG-специфичные проверки по контексту (ищи `context-faithfulness` в документации по assertions). Python-провайдер — файл с функцией, которая получает промпт и переменные и возвращает `{"output": ...}`; точную сигнатуру смотри в разделе про Python provider.

Тесты можно не писать в YAML вручную, а подгрузить из файла (CSV и другие форматы, см. документацию по тест-кейсам); скрипт-конвертер из `dataset.jsonl` занимает 20 строк.

### Безопасность установки

Оба инструмента — сторонний код, который будет работать с твоими API-ключами. Перед установкой:
- проверь точное имя пакета (`langfuse` на PyPI, `promptfoo` на npm) и что ссылка ведёт из официальной документации;
- закрепи версию: `pip install langfuse==<версия>` в `requirements.txt`, `npx promptfoo@<версия>` вместо `@latest`, у Docker-образов Langfuse конкретный тег, а не `latest`;
- не ставь релиз первого дня без нужды;
- ключи Langfuse и провайдеров — в `.env`, который в `.gitignore`.

## DeepSeek и Ollama: как это сделать у нас

Оба инструмента работают с DeepSeek и Ollama, но с оговорками, которых нет у OpenAI. Сверено в ноябре 2026 по [Langfuse: DeepSeek](https://langfuse.com/integrations/model-providers/deepseek), [Langfuse: Ollama](https://langfuse.com/integrations/model-providers/ollama), [promptfoo: DeepSeek](https://www.promptfoo.dev/docs/providers/deepseek/), [promptfoo: Ollama](https://www.promptfoo.dev/docs/providers/ollama/) и [promptfoo: model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/).

### Langfuse + DeepSeek и Ollama

Оба провайдера OpenAI-совместимы, поэтому работает та же замена импорта, что для OpenAI:

```python
# illustrative; keys come from env, never from code
import os
from langfuse.openai import OpenAI   # drop-in wrapper instead of "from openai import OpenAI"

deepseek = OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])
local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # key is required by the client, ignored by Ollama

r = deepseek.chat.completions.create(
    model="deepseek-flash",   # the Langfuse docs example still shows the older "deepseek-chat"; use current ids
    messages=[{"role": "user", "content": "..."}],
    extra_body={"thinking": {"type": "disabled"}},
)
```

Что учесть:

- **Стоимость DeepSeek Langfuse сам не посчитает правильно.** Модель может отсутствовать в его таблице цен (тогда $0), а `usage` DeepSeek содержит дополнительные поля кеша (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`). По документации Langfuse, если в `usage` есть ключи вне схемы OpenAI, он сохраняет их «плоско», без разнесения входных токенов на кешированные и обычные, и кешированные токены можно посчитать дважды. Надёжный путь: считать стоимость своим `cost.py` из главы [6.4 · Скрипт оценки: retrieval + faithfulness](AIL-29.md) и передавать её в генерацию через `cost_details` (тогда Langfuse берёт твою цифру, а не выводит свою). Альтернатива — своя модель в Project Settings → Models с `match_pattern` и ценами, но часы пик DeepSeek там не выразишь.
- **Встроенные LLM-as-a-judge в UI Langfuse требуют от модели structured output по JSON-схеме**: при сохранении оценщика Langfuse делает тестовый запрос, и если провайдер не принимает `response_format` со схемой, сохранение падает. У DeepSeek в документации только `json_object`, так что, скорее всего, он не подойдёт (я не проверял это вживую — проверь сам). Ollama на твоём Mac недоступна из Langfuse Cloud вообще. Вывод: судью запускаешь в своём коде (как в главе 6.4) и прикрепляешь вердикты к трейсам как scores через SDK — так ты и так собирался делать.
- **Где хранить трейсы и хватит ли памяти.** Для публичной документации бирж бери Langfuse Cloud (бесплатный тариф, условия на сайте) или promptfoo — они почти не нагружают Mac. Self-hosted Langfuse — это несколько контейнеров (веб, воркер, Postgres, ClickHouse, Redis, S3-совместимое хранилище); на твоём M2 с 8 ГБ рядом с арбитражным приложением и Ollama это тяжело, а Docker Desktop сам по себе резервирует память. Поэтому совет из теории «self-hosted для учёбы на одной машине нормально» у тебя не работает: self-hosted — только если без него никак, при закрытых остальных программах и выключенной автоторговле. Для приватных данных Проекта 4 проще обойтись без UI: локальный `results.jsonl` и promptfoo с локальным просмотром.

### promptfoo + DeepSeek и Ollama

У promptfoo есть готовые провайдеры для обоих. Главное — **явно задать судью**: promptfoo выбирает судью по умолчанию по найденным в окружении ключам (OpenAI, Anthropic и др.), а без них `llm-rubric` либо упадёт, либо позовёт не ту модель.

```yaml
# promptfoo/promptfooconfig.yaml — DeepSeek vs local model, DeepSeek Pro as the judge (illustrative)
description: Answer prompt v4 — deepseek-flash vs local model

prompts:
  - file://prompts/answer_v4.txt

providers:
  - id: deepseek:deepseek-flash          # needs DEEPSEEK_API_KEY in env
    label: ds-flash
    config:
      temperature: 0
      max_tokens: 1000
      passthrough:
        thinking: { type: disabled }
  - id: ollama:chat:qwen3:4b             # 4B class fits 8 GB; check context with `ollama ps`
    label: local
    config:
      temperature: 0

defaultTest:
  options:
    provider:                             # the judge for llm-rubric and the embedder for "similar"
      text:
        id: deepseek:deepseek-v4-pro
        config:
          temperature: 0
          passthrough:
            thinking: { type: disabled }
      embedding:
        id: ollama:embeddings:bge-m3
  assert:
    - type: llm-rubric
      value: The answer only states facts present in the provided excerpts and cites them like [1].

tests: file://tests_from_dataset.yaml     # generated from dataset.jsonl by your converter
```

- **Не клади модель-ответчик в `defaultTest.provider`.** По документации promptfoo это поле используется как запасной судья, если судья не задан явно, и тогда модель будет оценивать сама себя. Ответчики — в `providers`, судья — в `defaultTest.options.provider`.
- **Судья с рассуждениями.** Если включишь судье thinking, ставь `showThinking: false`: оцениваться должен только итоговый `content`, а не рассуждение.
- **`context-faithfulness`** (RAG-проверка promptfoo) — судья, который разбивает ответ на утверждения и считает долю подтверждённых контекстом; ему нужны переменные `query` и `context`. Для неё тоже явно укажи `provider: deepseek:deepseek-v4-pro`. Сравни её с твоим судьёй faithfulness из главы 6.4 — это то же сравнение, что с Ragas.
- **Эмбеддинги для `similar`** — через Ollama, у DeepSeek эндпоинта эмбеддингов в документации нет. У маленьких моделей эмбеддингов короткое окно; promptfoo отправляет `truncate: false`, и слишком длинный текст вернёт ошибку, а не обрежется молча.
- **Старые id.** `deepseek-chat` и `deepseek-reasoner` в документации promptfoo помечены как снятые; в старых статьях и примерах они ещё встречаются.

### Сравнение провайдеров для этой главы

| Что нужно | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Автотрейсинг в Langfuse | через OpenTelemetry/свою обёртку или интеграцию из доки Langfuse | замена импорта `langfuse.openai` | та же замена импорта + `base_url` | та же замена импорта + `base_url` локального сервера |
| Цена в Langfuse | обычно есть в таблице | обычно есть в таблице | ненадёжно: передавай `cost_details` сам | $0, указывай вручную |
| Встроенный судья Langfuse в UI | да | да | скорее нет (нужна JSON-схема) | нет для Cloud (localhost недоступен) |
| Провайдер promptfoo | `anthropic:...` | `openai:...` | `deepseek:<model>` | `ollama:chat:<model>`, `ollama:embeddings:<model>` |
| Судья promptfoo по умолчанию | может выбраться автоматически по ключу | может выбраться автоматически по ключу | нет, задавай явно | нет, задавай явно |
| Где данные трейсов | Langfuse Cloud или self-hosted | то же | то же | то же; для приватного — только self-hosted |

Что брать для практики: Langfuse Cloud + DeepSeek для Проекта 3 (данные публичные, self-hosted на 8 ГБ не нужен), promptfoo с двумя провайдерами (`deepseek-flash` и локальная `qwen3:4b`) и судьёй `deepseek-v4-pro`. Claude/OpenAI в promptfoo — по желанию третьим провайдером для сравнения.

## Маршрут изучения

1. Открой [Langfuse docs](https://langfuse.com/docs) → обзор и раздел observability/tracing, затем [Python SDK overview](https://langfuse.com/docs/observability/sdk/python/overview) и [Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation) (≈40 мин). Обрати внимание на `@observe`, генерации с `usage_details` и на `flush()` в скриптах.
2. Реши, облако или self-hosted. Для self-hosted: [Self-host Langfuse](https://langfuse.com/self-hosting) → вариант Docker Compose для локального использования (≈20 мин чтения + время на запуск).
3. Открой [Langfuse: Evaluation overview](https://langfuse.com/docs/evaluation/overview), затем [Datasets](https://langfuse.com/docs/evaluation/experiments/datasets) и [Experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) (≈40 мин). Главное: как датасет связан с прогоном, как оценки попадают на трейсы.
4. (Для справки) [Langfuse: LLM-as-a-Judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) — встроенные судьи в UI. Не заменяй ими своего проверенного судью, но посмотри, как это устроено (≈15 мин).
5. Открой [promptfoo docs](https://www.promptfoo.dev/docs/intro/) → Intro, затем [Getting started](https://www.promptfoo.dev/docs/getting-started/) (≈30 мин). Обрати внимание на структуру `promptfooconfig.yaml`: prompts × providers × tests.
6. В документации promptfoo найди разделы про assertions (expected outputs) и про Python provider (≈20 мин).
7. Открой [Langfuse: DeepSeek](https://langfuse.com/integrations/model-providers/deepseek) и [Langfuse: Ollama](https://langfuse.com/integrations/model-providers/ollama) (≈10 мин), затем [Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) (≈15 мин): `cost_details`, свои модели с `match_pattern` и предупреждение про нестандартные поля `usage`.
8. Открой [promptfoo: DeepSeek](https://www.promptfoo.dev/docs/providers/deepseek/), [promptfoo: Ollama](https://www.promptfoo.dev/docs/providers/ollama/) и [Model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/) (≈25 мин). Обрати внимание на `passthrough` для thinking, на `defaultTest.options.provider` с разделением `text`/`embedding` и на ловушку с `defaultTest.provider`.

## На что обратить внимание

- **Забытый `flush()`** — в коротком скрипте трейсы не долетают, и кажется, что интеграция не работает.
- **Двойной учёт**: и замена импорта OpenAI, и ручная генерация на тот же вызов дают два наблюдения и двойную стоимость.
- **Стоимость в Langfuse не совпадает с твоей**: модель не распознана или в таблице цен другая цена. Сверь на одном запросе.
- **Датасет в Langfuse разошёлся с git.** Редактировал эталон в UI — в `dataset.jsonl` старый. Правки только в git, в Langfuse — новая версия датасета.
- **Секреты в трейсах.** Всё, что передаётся в функцию под `@observe`, может оказаться в UI. Не передавай туда объекты с ключами.
- **promptfoo и стоимость.** Матрица 2 промпта × 2 модели × 80 тестов × `llm-rubric` = сотни вызовов. Начни с 10 тестов.
- **`llm-rubric` — непроверенный судья.** Для серьёзных выводов используй своего судью, проверенного в [AIL-29](AIL-29.md), через `python`-assertion.
- **Не утопай в инструменте.** Цель задачи — увидеть запросы и получить первую цифру, а не настроить все функции платформы.
- **$0 у DeepSeek в Langfuse** или удвоенная стоимость из-за полей кеша. Сверь с `cost.py` и передавай `cost_details` сам.
- **Встроенный судья Langfuse не сохраняется** с DeepSeek: ему нужна JSON-схема, а DeepSeek документирует только `json_object`. Это не твой баг; судья живёт в твоём коде.
- **promptfoo без явного судьи** при одном только `DEEPSEEK_API_KEY` не знает, кого звать для `llm-rubric`. Всегда `defaultTest.options.provider`.
- **Ответчик в `defaultTest.provider`** тихо становится судьёй самого себя.
- **Трейсы приватных данных в облаке.** Для всего, где появятся твои сделки, — никакого Langfuse Cloud; локальные файлы и promptfoo, self-hosted Langfuse только если хватает памяти.
- **Self-hosted Langfuse на 8 ГБ** вытесняет арбитражное приложение и Ollama из памяти. Для публичных данных он не нужен.

## Практика

- [ ] Выбери вариант Langfuse (облако или Docker Compose), запиши выбор и причину в `notes/evals.md`. Для self-hosted: закрепи теги образов.
- [ ] Добавь `langfuse` с закреплённой версией в `requirements.txt`, ключи в `.env` (проверь, что `.env` в `.gitignore`).
- [ ] Оберни RAG-пайплайн: `ask` → `retrieve` → (`rerank`) → `generate`, с `usage_details` и моделью на генерации.
- [ ] Задай 5 вопросов, открой UI: видишь дерево шагов, промпт, найденные куски, токены, стоимость, время. Сверь стоимость одного запроса с расчётом своего скрипта.
- [ ] Скрипт `evals/to_langfuse.py`: загружает dev-часть `dataset.jsonl` как датасет `exchange-docs-dev-v<N>` (input = вопрос, expected_output = эталон, metadata = тип, биржи, цитаты).
- [ ] Прогони эксперимент по датасету с оценщиком correctness (твой судья) и посмотри результат в UI. Запиши первую цифру качества и общую стоимость прогона.
- [ ] Установи promptfoo с закреплённой версией (`npx promptfoo@<версия> init` в папке `promptfoo/`).
- [ ] Напиши `promptfoo/provider.py`, вызывающий твой RAG с промптом из promptfoo.
- [ ] Возьми 10–15 вопросов из dev, сравни два промпта ответа (например, текущий и с более строгим требованием цитат). Assertions: `icontains` по ключевому факту из `must_include`, `llm-rubric` на цитирование, `latency`.
- [ ] `promptfoo view` — посмотри матрицу; запиши в `notes/evals.md`, какой промпт лучше и чем инструмент удобнее/неудобнее твоего скрипта.
- [ ] Трейсинг RAG на DeepSeek: клиент `langfuse.openai.OpenAI` с `base_url="https://api.deepseek.com"`; в генерацию передавай `cost_details` из своего `cost.py`. Сверь стоимость в UI с биллингом DeepSeek на одном запросе.
- [ ] Добавь в promptfoo второй провайдер — локальную модель `ollama:chat:<tag>`, а судью `deepseek-v4-pro` задай в `defaultTest.options.provider` (`text`), эмбеддинги для `similar` — `ollama:embeddings:<tag>`. Перед запуском проверь `ollama ps`: контекст вмещает 5 чанков.
- [ ] Посмотри в `promptfoo view` матрицу «DeepSeek против локальной модели» на 10–15 вопросах; запиши, где локальная модель проваливается (формат, ссылки, отказ, факты).
- [ ] (Опционально, для сравнения) Третий провайдер `anthropic:...` или `openai:...` на тех же 10–15 вопросах.

## Готово, когда

- В UI Langfuse видно каждый запрос ассистента как дерево шагов со стоимостью и временем.
- Набор загружен как датасет, по нему прогнан эксперимент, есть первая цифра качества.
- promptfoo сравнил два промпта, вывод записан.

## Тест для самопроверки

1. Чем trace отличается от generation в Langfuse?
2. Какую задачу решает promptfoo, а какую Langfuse?
3. Скрипт отработал, а в UI Langfuse пусто. Самая частая причина?
4. Почему источником истины для набора остаётся `dataset.jsonl` в git, а не датасет в Langfuse?
5. Langfuse показывает стоимость запроса $0, хотя токены записаны. Что проверить?
6. Что не так в этом фрагменте?
   ```python
   from langfuse.openai import OpenAI
   client = OpenAI(api_key="sk-proj-abc123...")

   @observe(as_type="generation")
   def generate(q):
       r = client.chat.completions.create(model=M, messages=[...])
       langfuse.update_current_generation(usage_details={...})
       return r
   ```
7. Зачем закреплять версию `npx promptfoo@<версия>` вместо `@latest`?
8. Какой вариант assertion в promptfoo подходит, чтобы проверить ответ своим уже проверенным судьёй?
   a) `contains`; b) `llm-rubric`; c) `python`; d) `latency`.
9. Когда self-hosted Langfuse предпочтительнее облака?
10. Почему матрица в promptfoo может неожиданно дорого стоить?
11. Langfuse показывает стоимость запросов к `deepseek-flash` равной $0 (или подозрительно большой). Почему и как сделать правильно?
12. Почему встроенный LLM-as-a-judge в UI Langfuse может не сохраниться с DeepSeek в роли модели-судьи и что делать вместо этого?
13. Что не так в этом конфиге promptfoo?
    ```yaml
    defaultTest:
      provider: deepseek:deepseek-flash
      assert:
        - type: llm-rubric
          value: Answer is grounded in the excerpts.
    ```

## Ответы

1. Trace — весь запрос пользователя целиком; generation — одно наблюдение внутри него, вызов модели с моделью, токенами и стоимостью.
2. promptfoo — офлайн-сравнение вариантов (промпты, модели) на наборе тестов из CLI. Langfuse — наблюдаемость: трейсы каждого запроса, датасеты, прогоны, оценки в UI.
3. Не вызван `flush()` перед завершением короткого скрипта (или не заданы ключи/хост в окружении).
4. Git даёт версии, ревью изменений и связь с кодом; правки в UI легко потерять и они не попадают в историю экспериментов.
5. Распознана ли модель в таблице цен Langfuse (имя модели должно совпадать) и задана ли цена для неё; при необходимости задать цену вручную.
6. Ключ захардкожен в коде (должен быть в окружении); двойной учёт: обёрнутый клиент уже логирует генерацию, и ручная генерация через декоратор дублирует её; `langfuse` и `observe` не импортированы; возвращается сырой объект ответа, который целиком попадёт в трейс.
7. Чтобы не получить внезапно новую версию с другим поведением или скомпрометированный релиз; воспроизводимость и безопасность.
8. **c.** Python-assertion вызывает твою функцию судьи; `llm-rubric` — судья promptfoo, не проверенный тобой.
9. Когда данные нельзя отправлять третьей стороне (приватные данные, требования компании) или нужен полный контроль; ценой поддержки инфраструктуры.
10. Число вызовов = промпты × провайдеры × тесты, плюс вызовы судьи на каждый `llm-rubric`; это быстро растёт.
11. Модели может не быть в таблице цен Langfuse ($0), а нестандартные поля кеша в `usage` DeepSeek мешают Langfuse правильно разнести кешированные токены (возможен двойной счёт). Считать стоимость своим кодом с учётом кеша и часов пик и передавать `cost_details`, либо завести свою модель с ценами.
12. При сохранении оценщика Langfuse проверяет, что модель отдаёт structured output по JSON-схеме; DeepSeek документирует только `json_object`. Запускать своего судью в коде и прикреплять вердикты как scores через SDK.
13. Ответчик задан в `defaultTest.provider`, а судья для `llm-rubric` явно не задан: по документации promptfoo этот провайдер станет запасным судьёй, и `deepseek-flash` будет оценивать сам себя. Ответчика — в `providers`, судью (например, `deepseek:deepseek-v4-pro` без thinking) — в `defaultTest.options.provider`.

## Что дальше

На неделе 8 Проект 3 переходит к экспериментам, и первым идёт [AIL-62 · Статистика evals: шум и размер выборки](AIL-62.md): как отличить настоящее улучшение от шума, прежде чем ставить эксперименты.
