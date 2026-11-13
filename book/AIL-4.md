# 1.6 · Сырой API: первые запросы к Claude и OpenAI  (AIL-4)

> **Неделя 1** · Основы LLM · ⏱ ~4 ч · Практика

## Зачем это AI-инженеру

LangChain, LlamaIndex, Vercel AI SDK, Instructor, агентные фреймворки — всё это обёртки над одним HTTP-запросом: «вот список сообщений, продолжи». Когда что-то ломается (модель «забыла» контекст, ответ обрезался, счёт вырос втрое), отлаживать приходится именно этот запрос. На собеседованиях часто просят на доске показать, как устроен многоходовый диалог и что такое `stop_reason`, — сегодня потрогаем это руками.

В главе 1.5 · Видео Карпатого + ключи API (AIL-3) мы получили ключ DeepSeek, установили Ollama и сделали по одному запросу «Say ok» к каждому. Теперь разбираем, из чего этот запрос состоит, что приходит в ответ и как из таких запросов собирается диалог.

## Теория

### Модель — это функция без памяти

Самое важное, что нужно усвоить в первый день: **LLM API stateless**. Сервер не хранит наш диалог. Каждый запрос — это полный «сценарий» разговора, который мы присылаем целиком, а модель дописывает следующую реплику.

```
запрос 1:  [user: "Меня зовут Анна"]                          → "Привет, Анна!"
запрос 2:  [user: "Меня зовут Анна",
            assistant: "Привет, Анна!",
            user: "Как меня зовут?"]                           → "Анна"
запрос 2': [user: "Как меня зовут?"]                           → "Не знаю"
```

Если в запросе 2 не передать историю, модель «забудет» имя. Аналогия из веб-разработки: это как REST-эндпоинт без сессии — весь стейт в теле запроса. Отсюда следствия:

- длинный диалог = каждый следующий запрос дороже (мы снова платим за все прошлые токены как за input);
- «память» чат-бота — это наш код, который решает, что положить в `messages` (вся история, последние N реплик, краткое резюме);
- историю можно подделать: в `messages` можно вписать реплику `assistant`, которую модель никогда не говорила. На этом построен один из способов показать модели примеры (few-shot, глава 2.1 · Промптинг: роли, few-shot, структура (AIL-7)).

(У некоторых провайдеров есть опциональное серверное хранение — у OpenAI в Responses API это `previous_response_id`, у Anthropic есть бета-функции вроде threads. Но на учёбе храним историю сами: так видно, что реально уходит в модель.)

### Анатомия запроса Messages API (Anthropic)

Посмотрим, как этот «сценарий» выглядит на проводе. Начнём с API Anthropic: в нём каждая часть запроса и ответа названа явно, поэтому на нём удобно учить устройство. Потом увидим, что у OpenAI, DeepSeek и Ollama те же части называются иначе, но смысл не меняется.

```
POST https://api.anthropic.com/v1/messages
headers:
  x-api-key: <ключ из переменной окружения>
  anthropic-version: 2023-06-01      ← версия API, обязательный заголовок
  content-type: application/json
body:
{
  "model": "claude-haiku-5-5",
  "max_tokens": 1024,
  "system": "Лаконичный ассистент интернет-магазина «Полка». Отвечай кратко.",
  "messages": [
    {"role": "user", "content": "Что такое наложенный платёж?"}
  ]
}
```

| Поле | Что это |
|---|---|
| `model` | ID модели. Точные имена меняются — смотрим страницу Models в документации |
| `max_tokens` | **Жёсткий потолок** на длину ответа в токенах. Модель о нём не знает: на лимите её просто обрезают |
| `system` | Системный промпт: роль, правила, контекст. Отдельное поле, не сообщение |
| `messages` | Диалог: чередование `user` / `assistant`, первым идёт `user` |

Поле `content` может быть строкой или списком блоков: `{"type": "text", ...}`, `{"type": "image", ...}`, `{"type": "tool_result", ...}` и т. д. Строка — это сокращение для одного текстового блока.

### Анатомия ответа

Иллюстративный ответ (поля сокращены):

```json
{
  "id": "msg_01...",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-5-5",
  "content": [
    {"type": "text", "text": "Наложенный платёж — оплата заказа при получении..."}
  ],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 31, "output_tokens": 87}
}
```

Три поля, на которые придётся смотреть всю карьеру:

1. **`content` — список блоков, а не строка.** У современных моделей Claude по умолчанию включено «размышление» (adaptive thinking): прежде чем ответить, модель пишет рассуждение для себя, и оно приходит отдельным блоком. Первым блоком может прийти `{"type": "thinking", ...}`, а текст — вторым. Поэтому `response.content[0].text` — плохая привычка. Правильно: пройти по блокам и взять те, у которых `type == "text"`.
2. **`stop_reason` — почему модель остановилась:**

| `stop_reason` | Значение | Что делать |
|---|---|---|
| `end_turn` | Модель закончила сама | Всё хорошо |
| `max_tokens` | Упёрлась в наш `max_tokens` | Ответ обрезан! Увеличить лимит или продолжить |
| `stop_sequence` | Встретилась наша стоп-последовательность | Ожидаемо, если мы её задали |
| `tool_use` | Модель хочет вызвать инструмент | Тема главы 2.6 (AIL-10) |
| `refusal` | Модель отказалась отвечать по соображениям безопасности | Не читать `content` как нормальный ответ |

3. **`usage` — сколько токенов съедено.** `input_tokens` (всё, что мы прислали: system + история) и `output_tokens` (что модель сгенерировала, включая размышления). Именно за это мы платим; подробно — в главе 1.7 (AIL-5).

### Роли сообщений

В запросе уже встретились `system` и сообщения с полем `role`. Разберём, чем роли отличаются.

- **system** — «инструкция работодателя»: кто модель, что можно, в каком формате отвечать. Модели обучены относиться к нему как к правилам с высоким приоритетом.
- **user** — реплики пользователя (и всё, что мы подставляем от его имени: документы, результаты инструментов).
- **assistant** — реплики модели. Мы возвращаем их обратно в историю.

У OpenAI ролей чуть больше: в Chat Completions есть `system` (в новых моделях его роль играет `developer`), в Responses API системный промпт передаётся параметром `instructions`. Идея та же.

### Anthropic vs OpenAI: одно и то же разными словами

У OpenAI два API для генерации текста, и оба встречаются в чужом коде. Сопоставим их поля с уже разобранными:

| | Anthropic Messages | OpenAI Responses | OpenAI Chat Completions |
|---|---|---|---|
| Эндпоинт | `/v1/messages` | `/v1/responses` | `/v1/chat/completions` |
| Системный промпт | `system` | `instructions` | сообщение `system`/`developer` |
| Вход | `messages` | `input` (строка или список) | `messages` |
| Лимит ответа | `max_tokens` (обязателен) | `max_output_tokens` | `max_completion_tokens` |
| Почему стоп | `stop_reason` | `status` + `incomplete_details` | `choices[0].finish_reason` |
| Токены | `usage.input_tokens/output_tokens` | `usage.input_tokens/output_tokens` | `usage.prompt_tokens/completion_tokens` |
| Текст в SDK | блоки `type=="text"` | `response.output_text` | `choices[0].message.content` |

Responses — более новый API OpenAI, его и рекомендуют для новых проектов; Chat Completions по-прежнему жив и стал де-факто стандартом «OpenAI-совместимых» API (Ollama, OpenRouter, многие open-source серверы говорят именно на нём). Знать стоит оба.

### Python SDK: минимальный вызов

Руками собирать HTTP-запрос не нужно: у провайдеров есть официальные SDK. Иллюстративно, в стиле официальных SDK (имена моделей сверяем с документацией на день работы):

```python
import anthropic
from openai import OpenAI

claude = anthropic.Anthropic()          # reads ANTHROPIC_API_KEY from env
resp = claude.messages.create(
    model="claude-haiku-5-5",
    max_tokens=512,
    system="Answer in one sentence.",
    messages=[{"role": "user", "content": "What is cash on delivery?"}],
)
text = "".join(b.text for b in resp.content if b.type == "text")
print(text, resp.stop_reason, resp.usage)

oai = OpenAI()                          # reads OPENAI_API_KEY from env
r = oai.responses.create(
    model="gpt-5-mini",                 # check current model names in the docs
    instructions="Answer in one sentence.",
    input="What is cash on delivery?",
    max_output_tokens=512,
)
print(r.output_text, r.status, r.usage)
```

SDK — это тонкий слой над HTTP: он подставляет заголовки, ретраит сетевые ошибки и 429/5xx, превращает JSON в объекты с типами. Сам он ничего «умного» не делает.

### Стриминг

Пока ответ генерируется, пользователь чат-бота смотрит на пустой экран. Без стриминга мы ждём весь ответ (10–30 секунд для длинного текста), потом получаем его разом. Со стримингом сервер шлёт **Server-Sent Events**: поток мелких событий `content_block_delta` с кусочками текста. Это тот же принцип, что у WebSocket-уведомлений о статусе заказа: подписка на поток вместо опроса.

```
event: message_start         → метаданные, usage.input_tokens
event: content_block_start   → начался блок (thinking / text / tool_use)
event: content_block_delta   → "Налож"
event: content_block_delta   → "енный платёж"
...
event: message_delta         → stop_reason, usage.output_tokens
event: message_stop
```

В Python SDK Anthropic есть удобный хелпер:

```python
with claude.messages.stream(model=MODEL, max_tokens=1024, messages=history) as stream:
    for chunk in stream.text_stream:       # only text deltas
        print(chunk, end="", flush=True)
    final = stream.get_final_message()     # full Message with usage and stop_reason
```

У OpenAI: `oai.responses.create(..., stream=True)` возвращает итератор событий; текст приходит в событиях типа `response.output_text.delta` (поле `delta`).

Стриминг не делает ответ дешевле и не ускоряет генерацию — он сокращает **время до первого токена**, которое видит пользователь, и защищает длинные запросы от HTTP-таймаутов.

### Секреты

Все примеры выше берут ключ из окружения — так мы договорились в главе 1.5 (AIL-3). Напомним схему для учебного репо:

```
ai-engineering-journey/
  .env            # ANTHROPIC_API_KEY=..., OPENAI_API_KEY=...  ← в .gitignore!
  .gitignore      # .env, .venv/, logs/
  exercises/week-01/chat.py
```

`python-dotenv` загружает `.env` в `os.environ` (`from dotenv import load_dotenv; load_dotenv()`), а SDK уже сами читают `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Ключ в коде, в ноутбуке с выводом или в логе — это утечка; ключи сканируют боты на GitHub за минуты.

## DeepSeek и Ollama: как это сделать у нас

Учимся мы на двух дешёвых/бесплатных вариантах, а Claude и OpenAI из теории выше остаются как эталон для сравнения:

- **DeepSeek API** — основная облачная модель: дёшево, говорит на протоколе OpenAI Chat Completions. **Серверы в Китае**: туда уходят только учебные вопросы и публичные тексты, никогда — данные клиентов, рабочий код, журнал событий заказов, ключи, `.env` и что-то личное. Это правило касается любого облачного провайдера. Политика конфиденциальности DeepSeek прямо говорит, что данные хранятся и обрабатываются в КНР, а вопрос, учатся ли модели на данных из API, в документах сформулирован неоднозначно — исходим из того, что могут.
- **Ollama** — локальный сервер моделей на нашей машине: бесплатно, офлайн, данные не покидают компьютер. Всё, что касается данных, которые нельзя показывать посторонним, в этом курсе делается только на нём.

### Что есть у DeepSeek (проверено по api-docs.deepseek.com 13.11.2026 — стоит перепроверить)

- Base URL для OpenAI SDK: `https://api.deepseek.com`; есть ещё Anthropic-совместимый `https://api.deepseek.com/anthropic` и Responses API.
- Модели: `deepseek-flash` (сейчас за ним стоит DeepSeek-V4.1-Flash-1017) и `deepseek-v4-pro`. Контекст 1M, максимум ответа 384K. Старые имена `deepseek-v4-flash` ещё принимаются, но модели за ними сняты — в старых туториалах встречаются `deepseek-chat` / `deepseek-reasoner`, в текущей документации их нет.
- **Режим размышления включён по умолчанию.** Рассуждение приходит в отдельном поле `message.reasoning_content` рядом с `content` (аналог блока `thinking` у Claude) и оплачивается как output. Выключается так: `extra_body={"thinking": {"type": "disabled"}}`. Для первых опытов выключаем — так проще видеть, что происходит.

```python
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
deepseek = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")

r = deepseek.chat.completions.create(
    model="deepseek-flash",                       # check current names on the pricing page
    messages=[
        {"role": "system", "content": "Answer in one sentence."},
        {"role": "user", "content": "What is cash on delivery?"},
    ],
    max_tokens=512,
    extra_body={"thinking": {"type": "disabled"}},  # thinking is ON by default
)
choice = r.choices[0]
print(choice.message.content)
print(choice.finish_reason)                       # "stop" / "length" / "tool_calls"
print(r.usage)   # prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens
```

С включённым размышлением читаем `getattr(choice.message, "reasoning_content", None)` — это поле не входит в стандартную схему OpenAI, SDK кладёт его как «лишнее». В историю диалога без инструментов его возвращать не нужно (API его игнорирует); с инструментами — обязательно, иначе 400 (глава 2.6 · Tool calling: модель вызывает 3 функции (AIL-10)).

Стриминг — как у OpenAI Chat Completions: `stream=True`, текст в `chunk.choices[0].delta.content`, рассуждение — в `delta.reasoning_content`; чтобы получить `usage`, добавляем `stream_options={"include_usage": True}` — он придёт в последнем чанке, у которого `choices` может быть пустым (проверяем `if chunk.choices`). Под нагрузкой DeepSeek держит соединение пустыми строками / SSE-комментариями `: keep-alive` — SDK их переваривает, а свой парсер SSE должен их пропускать.

### Что есть у Ollama (проверено по docs.ollama.com 13.11.2026)

Ollama мы установили в главе 1.5 по чек-листу для стороннего кода: только с [ollama.com](https://ollama.com) (macOS 14+; на Apple Silicon работает GPU), на macOS до первого запуска — проверка подписи `codesign -dv --verbose=4 /Applications/Ollama.app` (кто подписал) и `spctl -a -vv /Applications/Ollama.app` (нотаризация Apple); на других ОС — официальный установщик по документации. Если этот шаг пропущен, делаем его сейчас. Сервер слушает `127.0.0.1:11434` — в сеть его не открываем (`OLLAMA_HOST` не трогаем). Модели весят гигабайты и лежат в `~/.ollama`.

**Размер модели зависит от памяти машины.** Память делят модель, система и все открытые программы (на Apple Silicon она ещё и общая для CPU и GPU), поэтому ориентир такой:

- **8 ГБ RAM — модели класса 3–4B.** По умолчанию курс использует `ollama pull qwen3:4b` (≈2.5 ГБ, умеет tools и thinking) — на неё рассчитаны все примеры;
- **16 ГБ — 7–8B** (`qwen3:8b`, ≈5.2 ГБ). На 8 ГБ такая модель запустится только при закрытых остальных программах: если система начнёт выдавливать память в swap, тормозить будет всё, включая рабочие приложения;
- **32 ГБ и больше — 14B и крупнее** (`gpt-oss:20b` и т. п.); на 8 ГБ они не помещаются вообще.

Держим `num_ctx` скромным (8K, а не 32K — KV-кэш тоже ест память) и выгружаем модель после работы: `ollama stop qwen3:4b` или `keep_alive=0` в запросе. Каталог меняется быстро, выбираем по [ollama.com/library](https://ollama.com/library), смотрим на метки *tools* / *thinking* и на размер.

В главе 1.5 мы обращались к Ollama через пакет `openai`. Есть и второй путь — её собственный клиент; полезно знать оба:

```python
from openai import OpenAI
import ollama   # official client: pip package "ollama" (github.com/ollama/ollama-python); pin the version

# 1) OpenAI-compatible endpoint: the same code as for DeepSeek, another base_url
local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")   # key is required by the SDK but ignored
r = local.chat.completions.create(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "What is cash on delivery? One sentence."}],
)
print(r.choices[0].message.content, r.choices[0].finish_reason, r.usage)

# 2) Native API: more knobs (think, options, keep_alive, timings)
resp = ollama.chat(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "What is cash on delivery? One sentence."}],
    think=False,                      # True/False or a model-defined level, see /api/show
    options={"num_ctx": 8192},        # default context is only 4096 tokens!
)
print(resp.message.content, resp.done_reason, resp.prompt_eval_count, resp.eval_count)
```

Нативный ответ полезен для учёбы: `prompt_eval_count` / `eval_count` — токены входа и выхода, `prompt_eval_duration` / `eval_duration` — время в наносекундах (видно скорость нашей машины в токенах/с), `load_duration` — сколько грузилась модель в память (первый запрос всегда медленный, потом модель живёт в памяти 5 минут по умолчанию).

### Одна задача — четыре провайдера

Сведём всё вместе: одна и та же операция «отправить диалог, получить ответ» у четырёх провайдеров.

| | Claude (Messages) | OpenAI (Responses) | DeepSeek | Ollama |
|---|---|---|---|---|
| Протокол | свой `/v1/messages` | `/v1/responses` (+ Chat Completions) | Chat Completions; также Anthropic-совместимый и Responses | OpenAI-совместимый `/v1/...` и нативный `/api/chat` |
| SDK | `anthropic` | `openai` | `openai` с `base_url` (или `anthropic` с base URL `/anthropic`) | `openai` с `base_url` или `ollama` |
| Ключ | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `DEEPSEEK_API_KEY` | не нужен (локально) |
| Системный промпт | поле `system` | `instructions` | сообщение `system` | сообщение `system` |
| Лимит ответа | `max_tokens` (обязателен) | `max_output_tokens` | `max_tokens` (необязателен, по умолчанию 8K без размышления, 64K с ним) | `max_tokens` / нативно `options.num_predict` |
| Почему стоп | `stop_reason` | `status` + `incomplete_details` | `finish_reason` (`stop`/`length`/`tool_calls`) | `finish_reason` / нативно `done_reason` |
| Токены | `usage.input/output_tokens` | `usage.input/output_tokens` | `usage.prompt/completion_tokens` + кэш-поля | `usage` / нативно `prompt_eval_count`, `eval_count` |
| Размышление | блоки `thinking` в `content` | reasoning items в `output` | поле `reasoning_content`, включено по умолчанию | поле `message.thinking` (нативно), параметр `think` |
| Сервер хранит диалог | нет | опционально (`previous_response_id`) | нет | нет |
| Где данные | США (провайдер) | США (провайдер) | **КНР** | наша машина |
| Цена | за токен | за токен | за токен, очень дёшево (вне пиковых часов вдвое дешевле, глава 1.5) | бесплатно, но платим RAM, диском и скоростью |

Чего у нас нет по сравнению с Claude: эндпоинта `count_tokens` (у DeepSeek — только `usage` в ответе и офлайн-токенизатор-архив на сайте; глава 1.7), заголовка версии API, типизированных блоков `content`. Чего нет у Ollama: ограничений по деньгам и rate limits — зато есть ограничение по памяти и скорости, и контекст по умолчанию всего 4096 токенов (длинная история молча обрежется, если не поднять `num_ctx`).

### Что брать для практики этой главы

- **Чат и стриминг** — DeepSeek `deepseek-flash` с выключенным размышлением: быстро, копейки, тот же SDK, что у OpenAI.
- **Тот же чат локально** — Ollama `qwen3:4b`: смена одного `base_url` показывает, что «OpenAI-совместимый» — это про протокол, а не про модель.
- **Claude / OpenAI** — по желанию, для сравнения формата ответа (если ключи есть). Вся теория выше про `stop_reason`, блоки `content` и Responses API остаётся верной — это то, что встретится в чужом коде.

## Маршрут изучения

1. Открываем [Anthropic API docs](https://docs.anthropic.com) (домен сейчас перенаправляет на platform.claude.com/docs) → раздел Get started / Quickstart для Python и страницу Messages API в API Reference (≈40 мин). Обращаем внимание на обязательные заголовки, поля `model`, `system`, `messages`, `max_tokens`, структуру ответа и список `stop_reason`. Там же находим страницу Models и выписываем ID самой дешёвой модели.
2. В той же документации: страница Streaming Messages (≈20 мин). Смотрим последовательность событий SSE и пример с `stream`. Берём оттуда: какие события несут текст, а какое — финальный `stop_reason`.
3. [OpenAI API docs](https://platform.openai.com/docs) → Quickstart и гайд Text generation, затем страница Responses в API Reference (≈40 мин). Важно понять, чем `instructions` отличается от сообщения `system`, как выглядит `output` (список item'ов) и где `usage`. Раздел про Chat Completions пролистываем, чтобы узнавать его в чужом коде.
4. [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) → открываем README и пролистываем список ноутбуков (≈20 мин). Пока ничего не запускаем: просто запоминаем, где лежат примеры по tool use, structured output (JSON) и caching — вернёмся к ним в главах 2.2 (AIL-8), 2.6 (AIL-10) и 2.7 (AIL-11). Если код в ноутбуке использует старые имена моделей или параметры, которые API уже не принимает, — сверяемся с документацией.
5. Страница API versioning в документации Anthropic ([docs.anthropic.com/en/api/versioning](https://docs.anthropic.com/en/api/versioning)) (≈10 мин): разбираемся, зачем заголовок `anthropic-version` и что новые версии могут убирать параметры.
6. [DeepSeek API docs](https://api-docs.deepseek.com) → Your First API Call, затем [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) и гайд [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (≈30 мин). Выписываем текущие имена моделей, base URL, как включается/выключается размышление и где лежит `reasoning_content`. Заглядываем в [API Reference → Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion): поля `usage` и значения `finish_reason`.
7. Документация Ollama: [Quickstart / macOS](https://docs.ollama.com/macos), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) и [Chat API](https://docs.ollama.com/api/chat) (≈30 мин). Берём: base URL `http://localhost:11434/v1`, что поддерживается и что нет в совместимом режиме, поля таймингов нативного ответа, параметры `think`, `options.num_ctx`, `keep_alive`. Если Ollama ещё не установлена в главе 1.5 — устанавливаем (с проверкой подписи, см. раздел выше) и скачиваем `qwen3:4b`.
8. Дальше — практика ниже (≈2 ч).

## На что обратить внимание

- **`content[0].text` ломается.** Первым может быть блок `thinking`. Всегда фильтруем по `type`.
- **`max_tokens` — не «желаемая длина».** Модель не знает о лимите и не сокращает ответ; её просто обрывают на полуслове. `stop_reason == "max_tokens"` в продакшене — это баг, а не норма. На моделях с размышлением токены thinking тоже идут в этот лимит: слишком маленький `max_tokens` может кончиться ещё до текста.
- **В историю возвращаем ответ целиком.** Для Claude безопаснее класть в историю `response.content` (все блоки, включая thinking), а не только склеенную строку — так рекомендует документация для моделей с размышлением.
- **Первое сообщение — `user`**, роли чередуются. Два `user` подряд API склеит, но лучше этого не делать специально.
- **Стоимость диалога растёт быстрее числа реплик:** запрос N несёт всю историю 1..N-1, поэтому суммарный input за диалог растёт примерно квадратично. В консольном чате на 30 реплик последние запросы в разы дороже первых.
- **SDK сам ретраит** сетевые ошибки и ответы 408/409/429/5xx (по умолчанию 2 повтора). Поэтому один «вызов» в логе прокси может оказаться тремя HTTP-запросами. Подробно — глава 2.7 (AIL-11).
- **Сэмплинг-параметры.** В старых туториалах встречается `temperature=0`. У новых моделей Claude и в новых версиях API эти параметры убраны (запрос с ними возвращает 400). Подробно — глава 1.7 (AIL-5).
- **Логируем сырое.** Когда через неделю модель «странно ответила», единственное, что поможет, — сохранённые запрос и ответ. Но лог — тоже место утечки: никаких ключей и заголовков авторизации в нём.
- **«OpenAI-совместимый» ≠ «такой же, как OpenAI».** У DeepSeek свои поля (`reasoning_content`, кэш-поля в `usage`), у Ollama часть параметров не поддерживается (`tool_choice`, `logprobs` в совместимом режиме). Ошибки не будет — параметр просто проигнорируется. Читаем страницу совместимости, а не надеемся.
- **Первый запрос к Ollama медленный** — модель грузится в память (`load_duration`). Скорость по первому вызову не замеряем.
- **Куда уходят данные.** DeepSeek — серверы в КНР; Ollama — наша машина. Перед каждым запросом с «настоящими» данными стоит спросить себя, к какому `base_url` он уйдёт.

## Практика

Подготовка: uv-проект из главы 1.3 (AIL-2) (если ключи в 1.5 проверяли в нём, `openai` и `python-dotenv` там уже стоят), зависимости `openai`, `ollama`, `httpx`, `python-dotenv` (и `anthropic`, если будем сравнивать с Claude). Перед установкой сверяем точные имена пакетов на PyPI (это официальные пакеты OpenAI, Ollama (ollama/ollama-python), Anthropic, encode/httpx и theskumar/python-dotenv) и фиксируем версии (`uv add` записывает их в `uv.lock`). В `.env` — `DEEPSEEK_API_KEY` (и, по желанию, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Ollama установлен и проверен (`codesign`/`spctl`), модель `qwen3:4b` скачана (`ollama pull qwen3:4b`; в 1.5 для проверки хватало `llama3.2:3b`).

Правило для всей практики: в DeepSeek уходят только учебные вопросы. Никаких данных клиентов, рабочего кода, логов, содержимого баз и `.env`.

- [ ] **1. Hello, two providers.** `exercises/week-01/hello.py` — продолжение `check_keys.py` из 1.5, но теперь смотрим не только на текст, а на все поля ответа: один и тот же вопрос («Объясни, что такое наложенный платёж, в двух предложениях») к DeepSeek (`deepseek-flash`, размышление выключено) и к Ollama (`qwen3:4b`). Печатаем текст, `finish_reason`, `usage`. Потом включаем размышление у DeepSeek и выводим отдельно `reasoning_content` и `content` — сравниваем `completion_tokens`.
- [ ] **1б. (Для сравнения)** Тот же вопрос к Claude и к OpenAI через их SDK: `stop_reason`/`status`, блоки `content`, `usage`. Записываем в `notes/` три отличия формата.
- [ ] **2. Системный промпт.** `exercises/week-01/system_prompts.py`: вопрос «Стоит ли небольшому интернет-магазину ввести бесплатную доставку от 3000 ₽?» с тремя системными промптами: (а) пустой, (б) «Роль: осторожный финансовый аналитик. Отвечай списком рисков», (в) «Отвечай строго одним словом: да/нет». Сохраняем три ответа и сравниваем: насколько system управляет формой и тоном.
- [ ] **3. Логгер.** Дальше запросов станет много, и разбирать странный ответ без записи не получится. `exercises/week-01/llm_log.py` с функцией `log_call(provider, request: dict, response: dict)`, которая дописывает строку JSON в `logs/calls.jsonl` (время, провайдер, модель, тело запроса, тело ответа). Ответ SDK превращается в dict через `response.model_dump()`. Добавляем `logs/` в `.gitignore` и вызываем `log_call` во всех следующих скриптах.
- [ ] **4. Консольный чат с историей.** `exercises/week-01/chat.py`, флаг `--provider deepseek|ollama` (по желанию ещё `claude|openai`). DeepSeek и Ollama — один и тот же код на `openai` SDK, отличаются `base_url`, ключом и именем модели: выносим это в словарь `PROVIDERS`. Функция `ask` отправляет историю, пишет вызов через `log_call` и возвращает текст ответа и токены входа/выхода (у Chat Completions это `usage.prompt_tokens` и `usage.completion_tokens`, у Claude — `usage.input_tokens` и `usage.output_tokens`). Каркас:

```python
history: list[dict] = []
while True:
    user_text = input("you> ").strip()
    if user_text in {"/exit", "/quit"}:
        break
    if user_text == "/reset":
        history.clear()
        continue
    history.append({"role": "user", "content": user_text})
    reply_content, tokens_in, tokens_out = ask(provider, history)   # TODO: implement per provider
    history.append({"role": "assistant", "content": reply_content})
    print(f"\n[in={tokens_in} out={tokens_out}]")
```

Проверка: пишем «меня зовут Анна, я веду небольшой интернет-магазин посуды и подарков», через 3 реплики спрашиваем «чем я занимаюсь?». Потом `/reset` и тот же вопрос — модель не должна знать. Смотрим, как растёт `in` с каждой репликой. У DeepSeek заодно смотрим на `prompt_cache_hit_tokens`: история — это повторяющийся префикс, и он начнёт попадать в кэш (подробно — глава 2.7 · Стриминг, ретраи, rate limits, prompt caching (AIL-11)).
- [ ] **5. Стриминг.** Делаем в `chat.py` вывод по мере генерации: для DeepSeek/Ollama — `stream=True` + `stream_options={"include_usage": True}`, usage — из последнего чанка (у него пустой `choices`). Для сравнения у Claude — `messages.stream` и `get_final_message()`.
- [ ] **6. Упереться в лимит.** Просим «Напиши подробное эссе про историю чая» с `max_tokens=50`. Ожидаемо: `finish_reason == "length"` у DeepSeek и Ollama (нативно у Ollama — `done_reason == "length"`). Для сравнения: `stop_reason == "max_tokens"` у Claude, `status == "incomplete"` с причиной `max_output_tokens` у OpenAI. Добиваемся, чтобы чат печатал предупреждение `⚠ ответ обрезан`. Включаем у DeepSeek размышление и повторяем с `max_tokens=50` — что окажется в `content`?
- [ ] **6б. Контекст Ollama.** Вставляем в чат с Ollama текст на ~6000 токенов (например, публичную документацию API службы доставки) и спрашиваем о его начале. С контекстом по умолчанию (4096) модель «не увидит» начала; с `options={"num_ctx": 8192}` в нативном API — увидит. Смотрим в системном мониторе (Activity Monitor на macOS), сколько памяти заняла модель (на машине с 8 ГБ контекст сильно выше не поднимаем).
- [ ] **7. Без SDK.** `exercises/week-01/raw_http.py` через `httpx`. Основной вариант — DeepSeek: `POST https://api.deepseek.com/chat/completions`, заголовок `Authorization: Bearer <DEEPSEEK_API_KEY>`, тело `{"model", "messages", "max_tokens", "thinking": {"type": "disabled"}}` (вне SDK `thinking` — просто поле тела). И Ollama: `POST http://localhost:11434/api/chat` с `"stream": false`. Для сравнения — Claude:

```python
import os, json, httpx
from dotenv import load_dotenv

load_dotenv()
resp = httpx.post(
    "https://api.anthropic.com/v1/messages",
    headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],
        "anthropic-version": "2023-06-01",   # see the versioning page for newer versions
        "content-type": "application/json",
    },
    json={
        "model": "claude-haiku-5-5",         # check the current model id
        "max_tokens": 200,
        "messages": [{"role": "user", "content": "Say hi"}],
    },
    timeout=60,
)
print(resp.status_code)
print(json.dumps(resp.json(), indent=2, ensure_ascii=False))
```

То же делаем для `https://api.openai.com/v1/responses` (заголовок `Authorization: Bearer <ключ>`, тело `{"model", "input", "max_output_tokens"}`). Сравниваем сырой JSON с объектом SDK. Потом ломаем запрос (убираем `max_tokens`, путаем имя модели) и смотрим на тело ошибки — пригодится в главе 2.7 (AIL-11).

## Готово, когда

- `chat.py` работает с DeepSeek и Ollama (и, если есть ключи, с Claude/OpenAI): помнит контекст, `/reset` его стирает, ответ стримится, обрезанный ответ помечается.
- Ollama установлен из официального источника, подпись проверена, сервер слушает только `127.0.0.1`.
- В `logs/calls.jsonl` лежат сырые запросы/ответы, ключей там нет; `.env` и `logs/` в `.gitignore`.
- Можем без подсказки нарисовать JSON запроса и ответа Messages API и объяснить каждое поле.

## Тест для самопроверки

1. Отправлен запрос 1 «Меня зовут Анна», затем запрос 2 с `messages=[{"role":"user","content":"Как меня зовут?"}]`. Что ответит модель и почему?
2. Что означает `stop_reason == "max_tokens"`?
   a) модель решила, что ответ готов; b) ответ обрезан на заданном лимите; c) у аккаунта кончились токены; d) модель хочет вызвать инструмент
3. Какие поля обязательны в теле запроса к `/v1/messages`?
4. Чем `system` отличается от первого `user`-сообщения с инструкциями?
5. Что не так в этом коде?
   ```python
   resp = client.messages.create(model=MODEL, max_tokens=1024, messages=history)
   answer = resp.content[0].text
   history.append({"role": "assistant", "content": answer})
   ```
6. Стриминг уменьшает стоимость запроса? Что он даёт на самом деле?
7. Почему 20-я реплика в чате стоит дороже первой, даже если вопрос короткий?
8. Как в Chat Completions называется аналог `stop_reason` и какое значение соответствует обрыву по лимиту?
   a) `status: "incomplete"`; b) `finish_reason: "length"`; c) `stop: true`; d) `finish_reason: "max_tokens"`
9. Где хранить API-ключ в учебном проекте и что обязательно проверить перед первым коммитом?
10. Запросы к модели логируются в файл. Что в лог писать нельзя?
11. Сколько HTTP-запросов может стоять за одним `client.messages.create(...)` в Python SDK по умолчанию и почему?
12. Как с одним и тем же пакетом `openai` обратиться к DeepSeek и к Ollama? Что меняется в коде?
13. Запрос к DeepSeek `deepseek-flash` без дополнительных параметров вернул `completion_tokens` в 10 раз больше, чем длина видимого ответа. Почему и как это выключить?
14. Какие данные этого курса можно отправлять в DeepSeek, а какие — только в Ollama?
    a) всё можно, если есть ключ; b) учебные вопросы и публичные тексты — в DeepSeek, данные клиентов, рабочий код, логи и всё, что нельзя показывать посторонним, — только в локальную модель; c) в DeepSeek — только данные из логов без ключей; d) ничего нельзя никуда
15. Ollama отвечает так, будто не видела начала длинного документа. Что проверить первым?

## Ответы

1. Модель не знает имени: API без состояния, каждый запрос самодостаточен. Чтобы она «помнила», историю нужно передать в `messages`.
2. **b.** Генерацию оборвали на `max_tokens`; ответ неполный, его нельзя молча показывать пользователю как готовый.
3. `model`, `max_tokens`, `messages` (плюс заголовки `x-api-key`, `anthropic-version`, `content-type`). `system` — опционален.
4. `system` — отдельный канал «правил оператора», который модели обучены ставить выше пользовательских реплик; первая реплика `user` — это просто сообщение собеседника, его модель может «переспорить» следующими репликами.
5. Две проблемы: `content[0]` может быть блоком `thinking` без `.text` (упадёт или вернёт не то); в историю кладётся только строка вместо полного `resp.content`. Плюс не проверен `stop_reason` — обрезанный ответ уйдёт как нормальный.
6. Нет, токены те же. Стриминг сокращает время до первого видимого токена и спасает длинные ответы от HTTP-таймаутов.
7. Каждый запрос несёт всю историю как input; к 20-й реплике input — это все 19 предыдущих пар.
8. **b.** `finish_reason: "length"`. Вариант a — из Responses API.
9. В переменных окружения через `.env`, загружаемый `python-dotenv`; `.env` должен быть в `.gitignore` — проверяем `git status`, что он не попал в индекс.
10. Ключи и заголовки авторизации; в реальном проекте ещё — персональные и чувствительные данные пользователей (или их маскированную версию).
11. До трёх: SDK по умолчанию делает 2 повтора при сетевых ошибках, 408/409/429/5xx с экспоненциальной паузой.
12. Создать `OpenAI(base_url=..., api_key=...)`: для DeepSeek `https://api.deepseek.com` и ключ DeepSeek, для Ollama `http://localhost:11434/v1` и любой ключ-заглушку. Плюс имя модели; дальше код Chat Completions одинаковый.
13. У DeepSeek режим размышления включён по умолчанию: рассуждение (`reasoning_content`) оплачивается как output и входит в `completion_tokens`. Выключить — `extra_body={"thinking": {"type": "disabled"}}`.
14. **b.** Серверы DeepSeek в КНР, и обучение на входах не исключено: туда — только то, что не жалко опубликовать. Данные клиентов и рабочие данные — только Ollama на нашей машине; то же правило действует для любого облачного провайдера.
15. Размер контекста: по умолчанию у Ollama 4096 токенов, лишнее отрезается. Поднять `num_ctx` (в `options` нативного API или через `OLLAMA_CONTEXT_LENGTH`) с оглядкой на память.

## Что дальше

В [1.7 · Скрипт: temperature, токены, стоимость (AIL-5)](AIL-5.md) научимся считать, сколько стоит каждый такой запрос, и разберёмся, почему ответы на один и тот же вопрос различаются.
