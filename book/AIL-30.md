# 6.5 · Observability для LLM: Langfuse и promptfoo  (AIL-30)

> **Неделя 6** · Evals · ⏱ ~4 ч · Практика

<!-- description: Observability для LLM: трейсы, спаны и датасеты в Langfuse, декларативное сравнение промптов в promptfoo, облако или self-hosted. -->

## Зачем это AI-инженеру

Свой скрипт из [AIL-29](AIL-29.md) считает цифры, но смотреть в нём отдельные запросы неудобно: JSONL в терминале — не лучший интерфейс. Инструменты наблюдаемости (observability) показывают каждый запрос как дерево шагов с промптом, ответом, токенами, ценой и временем, хранят датасеты и результаты прогонов. В вакансиях AI-инженера Langfuse, LangSmith, Braintrust, promptfoo и подобные упоминаются постоянно; понимать, какую задачу они решают, важнее, чем знать конкретный.

## Теория

### Две разные задачи: трейсинг и сравнение промптов

| | Langfuse | promptfoo |
|---|---|---|
| Что это | Платформа наблюдаемости: трейсы, датасеты, эксперименты, оценки, промпты | CLI для сравнения промптов, моделей и конфигураций на наборе тестов |
| Где живёт | Сервер (облако или self-hosted в Docker) + SDK в нашем коде | Локально, Node.js-утилита + YAML-конфиг |
| Сильная сторона | Видеть, что происходит в продакшене и в каждом прогоне | Быстро сравнить «промпт A против B» таблицей |
| Привычная аналогия | Логи веб-сервера + дашборд мониторинга, только структурированные | Тест-раннер с матрицей вариантов (параметризованные тесты в pytest, table-driven тесты в Go) |

Это не конкуренты, а соседи: Langfuse для «что происходит в системе», promptfoo для «какой вариант лучше». В практике пробуем оба. Начинаем с Langfuse: сначала его основные понятия, затем как он встраивается в код, датасеты и вопрос, где хранить трейсы; потом promptfoo.

### Трейс, спан, генерация

Трейсинг пришёл из обычной бэкенд-разработки: путь одного запроса через систему записывается как дерево шагов с временем каждого. **Trace** — один запрос пользователя целиком. Внутри — вложенные **observations** (спаны): поиск, реранкинг, сборка промпта, вызов модели. Вызов модели — особый тип наблюдения, **generation**: у него есть модель, вход, выход, токены и стоимость.

```
trace: "Можно ли вернуть вскрытый чай?"       2.3s   $0.004
 ├─ span: plan_query                          0.4s
 │   └─ generation: <small model>             0.4s   $0.0003
 ├─ span: retrieve (hybrid, k=5)              0.2s
 ├─ span: rerank                              0.3s
 └─ generation: answer <main model>           1.4s   $0.0037
       input: system + 5 chunks + question
       output: "Нет: чай во вскрытой упаковке возврату не подлежит [1]..."
       usage: in 3120 / out 140
```

По такому дереву сразу видно, что съедает время и деньги и что именно модель получила на вход: например, попал ли в контекст кусок из архивного `returns-2025.md`. Для разбора ошибок в [AIL-34](AIL-34.md) это сильно удобнее, чем `results.jsonl`.

### Как Langfuse попадает в код

Чтобы такое дерево появилось, код должен сообщать Langfuse о своих шагах. Три уровня интеграции (точные имена функций стоит сверить с текущей документацией SDK, они менялись между версиями):

1. **Декоратор `@observe()`** на своих функциях: каждая обёрнутая функция становится спаном, вложенность определяется стеком вызовов. Это похоже на middleware, которое оборачивает обработчик.
2. **Готовые интеграции**: для OpenAI SDK есть замена импорта (`from langfuse.openai import OpenAI`), вызовы модели логируются автоматически вместе с токенами. Для других SDK — обёртка вручную или OpenTelemetry-инструментация.
3. **Ручные генерации** (`as_type="generation"`) с `model`, `usage_details` и выходом.

Иллюстративный пример по документации Langfuse Python SDK — конфигурируемый пайплайн из [AIL-29](AIL-29.md) с декораторами:

```python
# rag/pipeline.py  (illustrative; check the current Langfuse SDK docs)
from langfuse import observe, get_client

langfuse = get_client()  # reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from env

@observe()
def retrieve(question: str, cfg: dict) -> list[dict]:
    ...  # vector / hybrid search over kb/; inputs and outputs are captured automatically

@observe(as_type="generation", name="answer")
def generate(question: str, chunks: list[dict], cfg: dict) -> dict:
    resp = llm_call(question, chunks, cfg)   # your DeepSeek / Ollama / Claude call
    langfuse.update_current_generation(
        model=cfg["answer_model"],
        usage_details={"input_tokens": resp.in_tokens, "output_tokens": resp.out_tokens},
    )
    return {"text": resp.text}

@observe()
def ask(question: str, cfg: dict | None = None) -> dict:   # simplified; the real ask() returns Answer (5.3)
    chunks = retrieve(question, cfg)
    return generate(question, chunks, cfg)

# in short-lived scripts, flush before exit, otherwise events may be lost
langfuse.flush()
```

Стоимость Langfuse вычисляет по модели и токенам, если модель есть в его таблице цен; для остальных можно задать цену самому (см. раздел про модели и цены в документации). Его цифру стоит сверить с той, что считает наш скрипт.

### Датасеты и эксперименты в Langfuse

Трейсы показывают отдельные запросы. Чтобы прогонять весь набор, как делает наш `eval/run.py`, у Langfuse есть датасеты. Датасет в Langfuse — те же элементы, что в `eval/golden.jsonl`: `input` (вопрос клиента), `expected_output` (эталон), `metadata` (тип, категория, `must_include`, цитаты). **Эксперимент** (dataset run) — прогон нашей функции по всем элементам датасета; каждый элемент связан со своим трейсом, а оценки (scores) прикрепляются к трейсам. В UI можно сравнить два прогона бок о бок по каждому вопросу.

В текущем Python SDK для этого есть «experiment runner»: передаём задачу (`task`) и функции-оценщики (`evaluators`), он прогоняет, связывает трейсы и записывает оценки. Схема (иллюстративно, по документации экспериментов через SDK):

```python
from langfuse import Evaluation, get_client

langfuse = get_client()
dataset = langfuse.get_dataset("support-kb-dev-v1")

def task(*, item, **kwargs):
    return ask(item.input, CFG)["text"]

def correctness(*, input, output, expected_output, metadata, **kwargs):
    item = {"q": input, "reference_answer": expected_output,
            "must_include": metadata["must_include"]}
    verdict = judge_correctness(item, output, CFG)["verdict"]  # our judge from AIL-29
    return Evaluation(name="correctness", value=1.0 if verdict == "PASS" else 0.0)

result = dataset.run_experiment(name="baseline", task=task, evaluators=[correctness])
print(result.format())
```

Источник истины — всё равно `eval/golden.jsonl` в git. В Langfuse загружаем копию с версией в имени (`support-kb-dev-v1`), чтобы не путать версии.

### Облако или self-hosted

Langfuse записывает в трейсы входы и выходы наших функций, поэтому до первого запуска решаем, на чьём сервере они окажутся.

- **Langfuse Cloud** — быстрее начать, есть бесплатный тариф (условия на сайте). Трейсы уходят на чужой сервер. Для вопросов по публичной базе знаний `kb/` и выдуманным вопросам из набора это допустимо.
- **Self-hosted через Docker Compose** — всё локально, подходит, когда данные нельзя отдавать наружу. Требует Docker и несколько контейнеров (Postgres, ClickHouse и др.); для учёбы на одной машине это реально, если хватает памяти (см. ниже).

Правило: **никаких личных данных клиентов в облачных трейсах**. Langfuse пишет весь вход и выход функций под `@observe`, то есть вопрос клиента целиком — с телефоном, e-mail, номером заказа. Пока через пайплайн идут выдуманные вопросы из набора, Langfuse Cloud подходит. Как только в трейсинг попадут настоящие сообщения клиентов (бот поддержки из [AIL-23](AIL-23.md), агент недели 9–10 со снимком базы магазина) — либо self-hosted, либо маскирование до отправки: в SDK Langfuse есть функция маскирования входа и выхода (раздел про masking в документации), и в неё можно подключить ту же проверку, что `contains_personal_data()` из `rag/privacy.py`. Ключи API в трейсы тоже не должны попадать.

### promptfoo: декларативное сравнение

Теперь вторая задача из таблицы в начале главы — сравнить варианты. promptfoo — Node.js CLI. В `promptfooconfig.yaml` описываем промпты, провайдеров (модели или свой код) и тесты с проверками (assertions), запускаем `promptfoo eval` и смотрим матрицу результатов в `promptfoo view`. По сути это тест-раннер с параметризованными тестами, только варианты — промпты и модели, а проверки — по тексту ответа.

В примере сравниваются две версии промпта ответа: `answer_v1.txt` из [AIL-23](AIL-23.md) и `answer_v2.txt` — та же инструкция с более строгим требованием цитат.

```yaml
# promptfoo/promptfooconfig.yaml  (illustrative)
description: Answer prompt v1 vs v2 on shop support questions

prompts:
  - file://../prompts/answer_v1.txt
  - file://../prompts/answer_v2.txt

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
      question: "Можно ли вернуть вскрытый чай?"
    assert:
      - type: icontains
        value: "не подлежит"
      - type: llm-rubric
        value: Says that opened tea cannot be returned and unopened packs can be returned within 14 days.
  - vars:
      question: "Какая гарантия на кофемашины?"
    assert:
      - type: llm-rubric
        value: Refuses or says the knowledge base does not contain this.
```

Типы проверок, которые пригодятся: `contains`/`icontains`, `regex`, `javascript` и `python` (своя функция), `llm-rubric` (судья по критерию), `cost`, `latency`. Есть и RAG-специфичные проверки по контексту (ищем `context-faithfulness` в документации по assertions). Python-провайдер — файл с функцией, которая получает промпт и переменные и возвращает `{"output": ...}`; точную сигнатуру смотрим в разделе про Python provider.

Тесты можно не писать в YAML вручную, а подгрузить из файла (CSV и другие форматы, см. документацию по тест-кейсам); скрипт-конвертер из `golden.jsonl` занимает 20 строк.

### Безопасность установки

Прежде чем ставить что-то из этого, правило курса для стороннего кода. Оба инструмента — сторонний код, который будет работать с нашими API-ключами. Перед установкой:
- проверяем точное имя пакета (`langfuse` на PyPI, `promptfoo` на npm) и что ссылка ведёт из официальной документации;
- закрепляем версию: `uv add "langfuse==<версия>"` (версия попадёт в `pyproject.toml` и `uv.lock`), `npx promptfoo@<версия>` вместо `@latest`, у Docker-образов Langfuse конкретный тег, а не `latest`;
- не ставим релиз первого дня без нужды;
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

- **Стоимость DeepSeek Langfuse сам не посчитает правильно.** Модель может отсутствовать в его таблице цен (тогда $0), а `usage` DeepSeek содержит дополнительные поля кеша (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`). По документации Langfuse, если в `usage` есть ключи вне схемы OpenAI, он сохраняет их «плоско», без разнесения входных токенов на кешированные и обычные, и кешированные токены можно посчитать дважды. Надёжный путь: считать стоимость своим `eval/cost.py` из главы [6.4 · Скрипт оценки RAG: retrieval и faithfulness](AIL-29.md) и передавать её в генерацию через `cost_details` (тогда Langfuse берёт нашу цифру, а не выводит свою). Альтернатива — своя модель в Project Settings → Models с `match_pattern` и ценами, но часы пик DeepSeek там не выразить.
- **Встроенные LLM-as-a-judge в UI Langfuse требуют от модели structured output по JSON-схеме**: при сохранении оценщика Langfuse делает тестовый запрос, и если провайдер не принимает `response_format` со схемой, сохранение падает. У DeepSeek в документации только `json_object`, так что, скорее всего, он не подойдёт (вживую это не проверено — стоит проверить самим). Ollama на нашей машине (`localhost`) из Langfuse Cloud недоступна вообще. Вывод: судью запускаем в своём коде (как в главе 6.4) и прикрепляем вердикты к трейсам как scores через SDK — так мы и так собирались делать.
- **Где хранить трейсы и хватит ли памяти.** Для публичной базы знаний и выдуманного набора вопросов берём Langfuse Cloud (бесплатный тариф, условия на сайте) или promptfoo — они почти не нагружают машину. Self-hosted Langfuse — это несколько контейнеров (веб, воркер, Postgres, ClickHouse, Redis, S3-совместимое хранилище), а Docker Desktop сам по себе резервирует память. Ориентир по RAM: на 8 ГБ рядом с Ollama (модель 3–4B) это тяжело — self-hosted только если без него никак и с закрытыми остальными программами; на 16 ГБ (модели 7–8B) работает, если не держать открытым всё сразу; на 32 ГБ+ спокойно уживается и с моделями 14B. Для настоящих сообщений клиентов и снимка базы Проекта 4 без self-hosted проще обойтись без UI вовсе: локальный `results.jsonl` и promptfoo с локальным просмотром.

### promptfoo + DeepSeek и Ollama

У promptfoo есть готовые провайдеры для обоих. Главное — **явно задать судью**: promptfoo выбирает судью по умолчанию по найденным в окружении ключам (OpenAI, Anthropic и др.), а без них `llm-rubric` либо упадёт, либо позовёт не ту модель.

```yaml
# promptfoo/promptfooconfig.yaml — DeepSeek vs local model, DeepSeek Pro as the judge (illustrative)
description: Answer prompt v2 — deepseek-flash vs local model

prompts:
  - file://../prompts/answer_v2.txt

providers:
  - id: deepseek:deepseek-flash          # needs DEEPSEEK_API_KEY in env
    label: ds-flash
    config:
      temperature: 0
      max_tokens: 1000
      passthrough:
        thinking: { type: disabled }
  - id: ollama:chat:qwen3:4b             # 8 GB RAM: 3-4B models; 16 GB: 7-8B; check context with `ollama ps`
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

tests: file://tests_from_dataset.yaml     # generated from eval/golden.jsonl by your converter
```

- **Не кладём модель-ответчик в `defaultTest.provider`.** По документации promptfoo это поле используется как запасной судья, если судья не задан явно, и тогда модель будет оценивать сама себя. Ответчики — в `providers`, судья — в `defaultTest.options.provider`.
- **Судья с рассуждениями.** Если включить судье thinking, нужно `showThinking: false`: оцениваться должен только итоговый `content`, а не рассуждение.
- **`context-faithfulness`** (RAG-проверка promptfoo) — судья, который разбивает ответ на утверждения и считает долю подтверждённых контекстом; ему нужны переменные `query` и `context`. Для неё тоже явно указываем `provider: deepseek:deepseek-v4-pro`. Её стоит сравнить с нашим судьёй faithfulness из главы 6.4 — это то же сравнение, что с Ragas.
- **Эмбеддинги для `similar`** — через Ollama, у DeepSeek эндпоинта эмбеддингов в документации нет. У маленьких моделей эмбеддингов короткое окно; promptfoo отправляет `truncate: false`, и слишком длинный текст вернёт ошибку, а не обрежется молча.
- **Старые id.** `deepseek-chat` и `deepseek-reasoner` в документации promptfoo помечены как снятые; в старых статьях и примерах они ещё встречаются.

### Сравнение провайдеров для этой главы

| Что нужно | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Автотрейсинг в Langfuse | через OpenTelemetry/свою обёртку или интеграцию из доки Langfuse | замена импорта `langfuse.openai` | та же замена импорта + `base_url` | та же замена импорта + `base_url` локального сервера |
| Цена в Langfuse | обычно есть в таблице | обычно есть в таблице | ненадёжно: передаём `cost_details` сами | $0, указываем вручную |
| Встроенный судья Langfuse в UI | да | да | скорее нет (нужна JSON-схема) | нет для Cloud (localhost недоступен) |
| Провайдер promptfoo | `anthropic:...` | `openai:...` | `deepseek:<model>` | `ollama:chat:<model>`, `ollama:embeddings:<model>` |
| Судья promptfoo по умолчанию | может выбраться автоматически по ключу | может выбраться автоматически по ключу | нет, задаём явно | нет, задаём явно |
| Где данные трейсов | Langfuse Cloud или self-hosted | то же | то же | то же; для сообщений клиентов — только self-hosted или с маскированием |

Что берём для практики: Langfuse Cloud + DeepSeek для Проекта 3 (база знаний публичная, вопросы набора выдуманы, self-hosted не нужен), promptfoo с двумя провайдерами (`deepseek-flash` и локальная `qwen3:4b`) и судьёй `deepseek-v4-pro`. Claude/OpenAI в promptfoo — по желанию третьим провайдером для сравнения.

## Маршрут изучения

1. [Langfuse docs](https://langfuse.com/docs) → обзор и раздел observability/tracing, затем [Python SDK overview](https://langfuse.com/docs/observability/sdk/python/overview) и [Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation) (≈40 мин). Важно: `@observe`, генерации с `usage_details` и `flush()` в скриптах.
2. Решаем, облако или self-hosted. Для self-hosted: [Self-host Langfuse](https://langfuse.com/self-hosting) → вариант Docker Compose для локального использования (≈20 мин чтения + время на запуск). В том же разделе документации стоит найти маскирование данных в трейсах.
3. [Langfuse: Evaluation overview](https://langfuse.com/docs/evaluation/overview), затем [Datasets](https://langfuse.com/docs/evaluation/experiments/datasets) и [Experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) (≈40 мин). Главное: как датасет связан с прогоном, как оценки попадают на трейсы.
4. (Для справки) [Langfuse: LLM-as-a-Judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) — встроенные судьи в UI. Заменять ими своего проверенного судью не стоит, но посмотреть, как это устроено, полезно (≈15 мин).
5. [promptfoo docs](https://www.promptfoo.dev/docs/intro/) → Intro, затем [Getting started](https://www.promptfoo.dev/docs/getting-started/) (≈30 мин). Обращаем внимание на структуру `promptfooconfig.yaml`: prompts × providers × tests.
6. В документации promptfoo находим разделы про assertions (expected outputs) и про Python provider (≈20 мин).
7. [Langfuse: DeepSeek](https://langfuse.com/integrations/model-providers/deepseek) и [Langfuse: Ollama](https://langfuse.com/integrations/model-providers/ollama) (≈10 мин), затем [Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) (≈15 мин): `cost_details`, свои модели с `match_pattern` и предупреждение про нестандартные поля `usage`.
8. [promptfoo: DeepSeek](https://www.promptfoo.dev/docs/providers/deepseek/), [promptfoo: Ollama](https://www.promptfoo.dev/docs/providers/ollama/) и [Model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/) (≈25 мин). Обращаем внимание на `passthrough` для thinking, на `defaultTest.options.provider` с разделением `text`/`embedding` и на ловушку с `defaultTest.provider`.

## На что обратить внимание

- **Забытый `flush()`** — в коротком скрипте трейсы не долетают, и кажется, что интеграция не работает.
- **Двойной учёт**: и замена импорта OpenAI, и ручная генерация на тот же вызов дают два наблюдения и двойную стоимость.
- **Стоимость в Langfuse не совпадает с нашей**: модель не распознана или в таблице цен другая цена. Сверяем на одном запросе.
- **Датасет в Langfuse разошёлся с git.** Эталон поправили в UI — в `eval/golden.jsonl` остался старый. Правки только в git, в Langfuse — новая версия датасета.
- **Секреты в трейсах.** Всё, что передаётся в функцию под `@observe`, может оказаться в UI. Объекты с ключами туда не передаём.
- **promptfoo и стоимость.** Матрица 2 промпта × 2 модели × 80 тестов × `llm-rubric` = сотни вызовов. Начинаем с 10 тестов.
- **`llm-rubric` — непроверенный судья.** Для серьёзных выводов нужен свой судья, проверенный в [AIL-29](AIL-29.md), через `python`-assertion.
- **Не утонуть в инструменте.** Цель задачи — увидеть запросы и получить первую цифру, а не настроить все функции платформы.
- **$0 у DeepSeek в Langfuse** или удвоенная стоимость из-за полей кеша. Сверяем с `eval/cost.py` и передаём `cost_details` сами.
- **Встроенный судья Langfuse не сохраняется** с DeepSeek: ему нужна JSON-схема, а DeepSeek документирует только `json_object`. Это не наш баг; судья живёт в нашем коде.
- **promptfoo без явного судьи** при одном только `DEEPSEEK_API_KEY` не знает, кого звать для `llm-rubric`. Всегда `defaultTest.options.provider`.
- **Ответчик в `defaultTest.provider`** тихо становится судьёй самого себя.
- **Сообщения клиентов в облачных трейсах.** Выдуманные вопросы набора — можно в Langfuse Cloud; настоящие сообщения клиентов (телефон, e-mail, номер заказа) и всё, где появится снимок базы магазина, — никакого Langfuse Cloud без маскирования. Варианты: self-hosted Langfuse (если хватает памяти), маскирование до отправки или локальные файлы и promptfoo.
- **Self-hosted Langfuse на 8 ГБ** вытесняет Ollama и остальные программы из памяти. Для публичных данных он не нужен.

## Практика

- [ ] Выбрать вариант Langfuse (облако или Docker Compose), записать выбор и причину в `notes/evals.md`. Для self-hosted: закрепить теги образов.
- [ ] Добавить `langfuse` с закреплённой версией в `pyproject.toml` (`uv add "langfuse==<версия>"`), ключи — в `.env` (проверить, что `.env` в `.gitignore`).
- [ ] Обернуть RAG-пайплайн: `ask` → `retrieve` → (`rerank`) → `generate`, с `usage_details` и моделью на генерации.
- [ ] Задать 5 вопросов из набора (например, «можно ли вернуть вскрытый чай?», «какая гарантия на LAMP-LIGHT-MINI?»), открыть UI: видно дерево шагов, промпт, найденные куски с `url` вида `kb/<file>.md#<anchor>`, токены, стоимость, время. Сверить стоимость одного запроса с расчётом своего скрипта.
- [ ] Скрипт `eval/to_langfuse.py`: загружает dev-часть `eval/golden.jsonl` как датасет `support-kb-dev-v<N>` (input = вопрос, expected_output = эталон, metadata = тип, категория, `must_include`, цитаты).
- [ ] Прогнать эксперимент по датасету с оценщиком correctness (наш судья) и посмотреть результат в UI. Записать первую цифру качества и общую стоимость прогона.
- [ ] Установить promptfoo с закреплённой версией (`npx promptfoo@<версия> init` в папке `promptfoo/` проекта).
- [ ] Написать `promptfoo/provider.py`, вызывающий наш RAG с промптом из promptfoo.
- [ ] Взять 10–15 вопросов из dev, сравнить два промпта ответа (например, `answer_v1.txt` и `answer_v2.txt` с более строгим требованием цитат). Assertions: `icontains` по ключевому факту из `must_include`, `llm-rubric` на цитирование, `latency`.
- [ ] `promptfoo view` — посмотреть матрицу; записать в `notes/evals.md`, какой промпт лучше и чем инструмент удобнее/неудобнее нашего скрипта.
- [ ] Трейсинг RAG на DeepSeek: клиент `langfuse.openai.OpenAI` с `base_url="https://api.deepseek.com"`; в генерацию передавать `cost_details` из `eval/cost.py`. Сверить стоимость в UI с биллингом DeepSeek на одном запросе.
- [ ] Добавить в promptfoo второй провайдер — локальную модель `ollama:chat:<tag>` по объёму RAM (8 ГБ — 3–4B, 16 ГБ — 7–8B, 32 ГБ+ — 14B), а судью `deepseek-v4-pro` задать в `defaultTest.options.provider` (`text`), эмбеддинги для `similar` — `ollama:embeddings:<tag>`. Перед запуском проверить `ollama ps`: контекст вмещает 5 чанков.
- [ ] Посмотреть в `promptfoo view` матрицу «DeepSeek против локальной модели» на 10–15 вопросах; записать, где локальная модель проваливается (формат, ссылки, отказ, факты).
- [ ] (Опционально, для сравнения) Третий провайдер `anthropic:...` или `openai:...` на тех же 10–15 вопросах.

## Готово, когда

- В UI Langfuse видно каждый запрос ассистента как дерево шагов со стоимостью и временем.
- Набор загружен как датасет, по нему прогнан эксперимент, есть первая цифра качества.
- promptfoo сравнил два промпта, вывод записан.

## Тест для самопроверки

1. Чем trace отличается от generation в Langfuse?
2. Какую задачу решает promptfoo, а какую Langfuse?
3. Скрипт отработал, а в UI Langfuse пусто. Самая частая причина?
4. Почему источником истины для набора остаётся `eval/golden.jsonl` в git, а не датасет в Langfuse?
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
8. **c.** Python-assertion вызывает нашу функцию судьи; `llm-rubric` — судья promptfoo, который мы не проверяли.
9. Когда данные нельзя отправлять третьей стороне (настоящие сообщения клиентов с личными данными, снимок базы магазина, требования компании) и маскирования недостаточно, или нужен полный контроль; ценой поддержки инфраструктуры и памяти машины.
10. Число вызовов = промпты × провайдеры × тесты, плюс вызовы судьи на каждый `llm-rubric`; это быстро растёт.
11. Модели может не быть в таблице цен Langfuse ($0), а нестандартные поля кеша в `usage` DeepSeek мешают Langfuse правильно разнести кешированные токены (возможен двойной счёт). Считать стоимость своим кодом с учётом кеша и часов пик и передавать `cost_details`, либо завести свою модель с ценами.
12. При сохранении оценщика Langfuse проверяет, что модель отдаёт structured output по JSON-схеме; DeepSeek документирует только `json_object`. Запускать своего судью в коде и прикреплять вердикты как scores через SDK.
13. Ответчик задан в `defaultTest.provider`, а судья для `llm-rubric` явно не задан: по документации promptfoo этот провайдер станет запасным судьёй, и `deepseek-flash` будет оценивать сам себя. Ответчика — в `providers`, судью (например, `deepseek:deepseek-v4-pro` без thinking) — в `defaultTest.options.provider`.

## Что дальше

Неделя 7 — запас, а на неделе 8 Проект 3 переходит к экспериментам, и первым идёт [AIL-62 · Статистика evals: шум и размер выборки](AIL-62.md): как отличить настоящее улучшение от шума, прежде чем ставить эксперименты.
