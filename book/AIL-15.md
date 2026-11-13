# 3.3 · Проект 1: tool calling + Telegram  (AIL-15)

> **Неделя 3** · Основы LLM · ⏱ ~8 ч (2 дня) · Проект

## Зачем это AI-инженеру

Здесь всё соединяется: пользователь пишет вопрос → модель выбирает функции → код их выполняет → бот отвечает. Именно эта склейка — цикл инструментов, история, ошибки, доступ, дата в промпте — отличает демо в ноутбуке от продукта. На собеседовании тебя попросят нарисовать этот цикл и спросят, что будет, если модель зациклится, функция упадёт или бот напишет кто-то чужой.

⚠️ **Только чтение.** Никаких функций, которые ставят или отменяют ордера, и никаких запросов к биржам с ключами — только копия базы.

## Теория

Цикл `tool_use → tool_result` ты уже писал в AIL-10, обёртку `call_llm()` с ретраями и подсчётом стоимости — в AIL-11. Здесь — как встроить их в живой бот.

### 1. Слои приложения

```
aiogram handler (bot/main.py)          ← Telegram: доступ, "печатает…", отправка
        │ question, history
        ▼
agent.answer() (bot/agent.py)          ← цикл: call_llm ↔ run_tool, max 5 шагов
        │                     │
        ▼                     ▼
llm_utils.call_llm()     tools.run_tool(name, input)   ← валидация Pydantic,
 (AIL-11: retries,          │                              ошибки → is_error
  timeout, usage)           ▼
                       tools.get_pnl(...) → SQLite (mode=ro, копия)
```

Главное правило: **`agent.answer()` ничего не знает о Telegram**. Это функция «вопрос + история → ответ + метаданные». Тогда её можно прогнать из скрипта по списку вопросов (это твой eval), из консоли, а позже — из веб-интерфейса. Хендлер aiogram — тонкий: проверил доступ, достал историю, вызвал `answer()`, отправил текст.

### 2. Цикл агента

Ниже цикл в формате Anthropic, как в главе 2.6 · Tool calling. Рабочая версия бота — на OpenAI-формате для Ollama и DeepSeek, она в разделе «DeepSeek и Ollama» ниже; логика та же, отличаются имена полей.

```python
# bot/agent.py (illustrative, Anthropic format - kept for comparison)
MAX_STEPS = 5

async def answer(question: str, history: list[dict]) -> AgentResult:
    messages = [*history, {"role": "user", "content": question}]
    calls: list[str] = []
    for _ in range(MAX_STEPS):
        resp = await asyncio.to_thread(
            call_llm,
            system=build_system_prompt(),
            messages=messages,
            tools=tool_definitions(),
        )
        if resp.stop_reason != "tool_use":
            text = "".join(b.text for b in resp.content if b.type == "text")
            return AgentResult(text=text, tool_calls=calls)
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:            # may hold several tool_use blocks
            if block.type == "tool_use":
                calls.append(block.name)
                results.append(run_tool(block.id, block.name, block.input))
        messages.append({"role": "user", "content": results})
    return AgentResult(text="Не смог ответить за 5 шагов, переформулируй вопрос.",
                       tool_calls=calls)
```

Детали, которые легко упустить:

- **Все `tool_result` одного шага — в одном user-сообщении**, по одному на каждый `tool_use` с совпадающим `tool_use_id`. Модель может попросить две функции сразу («какие пары открыты и какой PnL за неделю»).
- **Ответ ассистента с `tool_use` добавляется в историю целиком** (`resp.content`), включая текст перед вызовом.
- **Лимит шагов обязателен**: без него модель, получающая ошибку, может вызывать одну и ту же функцию бесконечно, и каждый шаг стоит денег.
- `asyncio.to_thread` нужен, если твой `call_llm()` синхронный: синхронный HTTP-запрос внутри `async`-хендлера заблокирует event loop, и бот перестанет отвечать на всё остальное на 5–20 секунд. Альтернатива — асинхронный клиент `AsyncAnthropic` и `async def call_llm`. Аналогия с Node: это как вызвать `fs.readFileSync` на большом файле в обработчике HTTP-запроса.

### 3. `run_tool`: граница доверия

Вход от модели — недоверенный. `run_tool` — единственная точка, где имя и аргументы превращаются в вызов кода:

```python
def run_tool(tool_use_id: str, name: str, raw_input: dict) -> dict:
    entry = TOOLS.get(name)
    if entry is None:
        return _error(tool_use_id, f"Unknown tool {name}")
    args_model, fn, _ = entry
    try:
        args = args_model.model_validate(raw_input)
        with open_readonly(TRADES_DB) as conn:   # fresh read-only connection
            result = fn(conn, **args.model_dump())
        return {"type": "tool_result", "tool_use_id": tool_use_id,
                "content": result.model_dump_json()}
    except ValidationError as e:
        return _error(tool_use_id, f"Invalid arguments: {e.errors()}")
    except Exception:
        log.exception("tool %s failed", name)
        return _error(tool_use_id, "Internal error while reading data")

def _error(tool_use_id, msg):
    return {"type": "tool_result", "tool_use_id": tool_use_id,
            "content": msg, "is_error": True}
```

- Реестр `TOOLS` — белый список. Модель не может вызвать то, чего в нём нет.
- Ошибка функции возвращается **модели** как `is_error`, а не пользователю как traceback. Модель часто сама исправит аргументы (`period="2 weeks"` → `"week"`) или честно скажет, что данных нет.
- Внутренние детали (пути, SQL, стек) в `content` не отдавай — они уйдут в контекст и могут оказаться в ответе.
- Осторожно с `with sqlite3.connect(...) as conn`: в Python такой `with` управляет транзакцией, а не закрывает соединение. Сделай `open_readonly` контекст-менеджером через `contextlib.closing` или закрывай явно.
- Соединение SQLite по умолчанию нельзя использовать из другого потока (`check_same_thread=True`). Открывать соединение на каждый вызов — дешево и снимает проблему.

### 4. Системный промпт

```text
Ты — аналитик торгового журнала владельца. Отвечаешь по-русски, коротко.
Сейчас: {now:%Y-%m-%d %H:%M} ({tz}), день недели: {weekday}.

Правила:
- Цифры бери только из результатов инструментов. Не выдумывай и не округляй
  сильнее, чем пришло.
- PnL посчитан по ценам и комиссиям, фандинг не учтён — говори об этом,
  когда отвечаешь про прибыль.
- История спреда хранится около 7 дней.
- Ты только читаешь данные. Ты не можешь открывать, закрывать или менять
  позиции и ордера. На такие просьбы отвечай, что бот только для чтения.
- Если вопрос неоднозначен (несколько пар подходят) — переспроси.
- Формат: обычный текст без Markdown-таблиц, суммы в USDT с 2 знаками.
```

Почему дата обязательна: модель не знает «сегодня». Без даты «за неделю» она либо выберет параметр наугад, либо, если в инструментах есть явные даты, посчитает от даты из своего обучения. С `period: Literal["day","week","month"]` это менее критично (окно считает код), но вопросы «что было в понедельник» или «с начала месяца» без даты в промпте не решаются. Добавь в системный промпт текущую дату — иначе «за неделю» модель посчитает неверно.

Строка с датой меняется каждую минуту, а prompt caching (AIL-11) кэширует префикс. Если захочешь кэшировать длинный промпт — ставь дату в конец системного промпта или в user-сообщение, а неизменную часть — в начало.

### 5. История диалога

Модель не помнит прошлые запросы (AIL-4) — историю передаёшь сам. Для бота:

```python
from collections import defaultdict, deque

HISTORY_TURNS = 6                                   # user+assistant pairs
_history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY_TURNS * 2))
```

- Храни **только текст вопроса и финальный текст ответа**, не промежуточные `tool_use/tool_result`. Это компактно, и обрезка по `maxlen` никогда не разорвёт пару `tool_use`→`tool_result` (API отклонит историю, где `tool_result` без своего `tool_use`).
- История должна начинаться с `user`. `deque` пар user/assistant это гарантирует, если ты добавляешь их парой и только после успешного ответа.
- Плата: на follow-up «а по ETH?» модель вызовет инструмент заново — цифр прошлого шага она не видит. Для этого бота это нормально и даже хорошо: цифры всегда свежие из функции.
- Команда `/reset` очищает историю. История в памяти процесса и пропадает при перезапуске — для личного бота это нормально.

### 6. aiogram: доступ, «печатает…», отправка

```python
# bot/main.py (illustrative, aiogram 3)
router = Router()
router.message.filter(F.chat.type == "private",
                      F.from_user.id == settings.owner_telegram_id)

@router.message(CommandStart())
async def start(message: Message):
    await message.answer("Спроси про свои сделки: PnL, открытые пары, спред.")

@router.message(Command("reset"))
async def reset(message: Message):
    _history.pop(message.chat.id, None)
    await message.answer("История очищена.")

@router.message(F.text)
async def question(message: Message, bot: Bot):
    await bot.send_chat_action(message.chat.id, ChatAction.TYPING)
    try:
        result = await answer(message.text, list(_history[message.chat.id]))
    except Exception:
        log.exception("answer failed")
        await message.answer("Не получилось ответить: сервис модели недоступен. "
                             "Попробуй через минуту.")
        return
    _history[message.chat.id].extend([
        {"role": "user", "content": message.text},
        {"role": "assistant", "content": result.text},
    ])
    await message.answer(result.text[:4000])

async def main():
    bot = Bot(token=settings.telegram_bot_token)
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)
```

- **Фильтр на роутере** применяется ко всем его хендлерам. Чужие сообщения в него не попадают — бот молчит. Молчать лучше, чем отвечать «доступ запрещён»: не подтверждаешь, что бот что-то умеет.
- **Telegram ID не секрет, но в код его не зашивай** — в `.env`, рядом с токеном. Свой ID можно узнать, залогировав `message.from_user.id` один раз.
- **Отдельный бот.** Новый токен у @BotFather; не используй токен бота уведомлений из приложения арбитража. Один токен опрашивает (polling) только один процесс — иначе ошибка `Conflict: terminated by other getUpdates request`.
- **Polling, не webhook**: бот работает у тебя на Mac, публичный URL не нужен.
- **Лимит сообщения Telegram — 4096 символов**: обрезай или режь на части.
- **Parse mode** не включай: Markdown от модели с непарной `_` или `*` приводит к ошибке отправки. Простой текст надёжнее.

### 7. Ошибки: что видит пользователь

| Что упало | Что делает код | Что видит пользователь |
|---|---|---|
| Функция: неверные аргументы | `is_error` модели | модель исправилась и ответила |
| Функция: исключение | лог + `is_error` модели | «данные сейчас недоступны» (сказала модель) |
| API: 429/5xx/529 | ретраи в `call_llm()` (AIL-11) | ничего, если ретрай помог |
| API: все ретраи исчерпаны, таймаут | исключение → хендлер | «сервис модели недоступен, попробуй позже» |
| Лимит шагов | фолбэк-текст | «переформулируй вопрос» |
| Ответ пустой (только tool_use без текста) | проверка `if not text` | «не смог сформулировать ответ» |

Пользователь никогда не видит traceback, а в логе всегда есть traceback.

### 8. Проверка по списку вопросов

Критерий «12 из 15» проверяется скриптом, а не на глаз в Telegram. `scripts/run_questions.py` прогоняет `answer()` по каждому вопросу из `questions.md` (без истории), печатает вызванные инструменты и ответ. Ты сравниваешь с ожидаемым (ручной SQL из AIL-13) и ставишь ✓/✗. Это прототип evals из этапа 3: сохрани скрипт и результаты прогонов (результаты на реальной копии — только локально, в `logs/`, не в git).

## DeepSeek и Ollama: как это сделать у нас

Напоминание из главы 3.1: **реальную копию базы видит только локальная модель Ollama**; DeepSeek (серверы в Китае), а для сравнения и Claude/OpenAI, работают только с демо-базой. `assert_data_policy()` вызывается при старте бота и `run_questions.py`.

### Цикл на OpenAI-формате

Один код для Ollama и DeepSeek — меняются только `base_url`, ключ и модель из `.env`:

```python
# bot/agent.py (illustrative, OpenAI Chat Completions format: Ollama and DeepSeek)
import json
from openai import AsyncOpenAI

provider, base_url, api_key = llm_settings()            # from bot/config.py
client = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=120, max_retries=2)

# DeepSeek: thinking mode is on by default; the bot runs it off (see below)
EXTRA = {"extra_body": {"thinking": {"type": "disabled"}}} if provider == "deepseek" else {}

async def answer(question: str, history: list[dict]) -> AgentResult:
    messages = [{"role": "system", "content": build_system_prompt()},
                *history, {"role": "user", "content": question}]
    calls: list[str] = []
    for _ in range(MAX_STEPS):
        resp = await client.chat.completions.create(
            model=settings.llm_model, messages=messages,
            tools=tool_definitions("openai"), **EXTRA)
        msg = resp.choices[0].message
        if not msg.tool_calls:                         # final answer
            return AgentResult(text=msg.content or "", tool_calls=calls)
        messages.append(msg)                           # the whole assistant message, with tool_calls
        for tc in msg.tool_calls:                      # may be several in one step
            calls.append(tc.function.name)
            messages.append(run_tool_openai(tc))
    return AgentResult(text="Не смог ответить за 5 шагов, переформулируй вопрос.",
                       tool_calls=calls)

def run_tool_openai(tc) -> dict:
    try:
        raw = json.loads(tc.function.arguments or "{}")   # arguments arrive as a JSON string
    except json.JSONDecodeError:
        content, is_error = "Arguments are not valid JSON", True
    else:
        content, is_error = execute_tool(tc.function.name, raw)  # provider-neutral core
    # no is_error flag in this format: mark the error in the text itself
    return {"role": "tool", "tool_call_id": tc.id,
            "content": f"ERROR: {content}" if is_error else content}
```

Что изменилось по сравнению с Anthropic-версией:

- **Системный промпт — первое сообщение** с `role: "system"`, а не отдельный параметр.
- **Признак вызова** — непустой `message.tool_calls`. Проверяй его, а не `finish_reason == "tool_calls"`: так надёжнее на разных серверах.
- **Аргументы приходят JSON-строкой**, а не словарём. Маленькая локальная модель может прислать невалидный JSON — это такая же ошибка аргументов, её возвращаешь модели.
- **Каждый результат — отдельное сообщение** `role: "tool"` с `tool_call_id` (у Anthropic — все `tool_result` в одном user-сообщении).
- **Флага `is_error` нет** — пишешь `ERROR: ...` в `content`.
- `run_tool` из теории полезно разрезать: ядро `execute_tool(name, raw) -> (content, is_error)` (белый список, Pydantic, read-only соединение) не знает о провайдере, а два тонких адаптера упаковывают результат в `tool_result` (Anthropic) или `role: "tool"` (OpenAI-формат). Тесты из практики пишешь на ядро.
- Асинхронный клиент `AsyncOpenAI` — и `asyncio.to_thread` больше не нужен.

### DeepSeek: почему бот работает без thinking

По [документации thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) (ноябрь 2026): режим размышлений у `deepseek-flash` и `deepseek-v4-pro` **включён по умолчанию**, и если в запросе есть `tools`, поле `reasoning_content` нужно возвращать API во всех следующих запросах — иначе **ошибка 400**. А наш бот хранит в истории только текст вопросов и ответов. Плюс в thinking-режиме `tool_choice="required"` и выбор конкретной функции тоже дают 400, а `temperature` молча игнорируется. Для бота с 4 простыми функциями размышления не нужны, поэтому `extra_body={"thinking": {"type": "disabled"}}`. Если захочешь сравнить с thinking — храни в истории полные сообщения ассистента (`messages.append(msg)` целиком, как в цикле выше), а не только текст. Как именно API реагирует на историю, где старые ходы урезаны до текста, документация прямо не описывает — проверь сам на демо-базе.

### Ollama: окно контекста и отсутствие `tool_choice`

- **Окно.** По умолчанию 4k токенов на машинах с < 24 ГБ видеопамяти ([Context length](https://docs.ollama.com/context-length)). Для бота поставь 8–16k: ползунок в настройках приложения Ollama или `OLLAMA_CONTEXT_LENGTH=16384` для сервера. Проверка — `ollama ps`: колонка `CONTEXT` показывает окно, `PROCESSOR` — помещается ли модель в GPU (нужно `100% GPU`; если часть на CPU — окно или модель слишком большие для 8 ГБ).
- **`tool_choice` в `/v1` не поддерживается** ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)) — заставить модель вызвать функцию нельзя. Обходной путь: если в ответе есть цифры, а `tool_calls` пуст, один раз повтори запрос с добавленным user-сообщением «Use the tools to get the numbers, do not answer from memory» и пометь случай в логе.
- **Первый запрос медленный**: модель грузится в память. Потом она живёт `keep_alive` (по умолчанию 5 минут) и выгружается. Для личного бота это нормально; не ставь `keep_alive` бесконечным на машине, где работает торговое приложение.

### Какие модели Ollama справляются с tool calling для этого бота

Цифры ниже — не прогон на твоём Mac (на момент написания главы Ollama на нём ещё не стояла), а публичный бенчмарк плюс ограничения памяти. **Решает твой прогон 15 вопросов.** Бенчмарк — [Berkeley Function Calling Leaderboard (BFCL)](https://gorilla.cs.berkeley.edu/leaderboard.html), обновление от 2026-04-12. Колонки: общий балл (в нём много многоходовых агентных сценариев, которые нашему боту не нужны), Live (реальные пользовательские функции) и Non-Live (простые, множественные и параллельные вызовы) — две последние ближе всего к нашему боту.

| Тег Ollama | Скачать | На Mac с 8 ГБ рядом с приложением | BFCL: overall / live / non-live | Вывод |
|---|---|---|---|---|
| `qwen3:4b-instruct-2507-q4_K_M` | 2.5 ГБ | да | 35.68% / 76.39% / 87.88% (Qwen3-4B-Instruct-2507, FC) | **основной кандидат** |
| `qwen3:8b` (q4_K_M) | 5.2 ГБ | впритык: только с закрытым браузером и без автоторговли | 42.57% / 80.53% / 87.58% (Qwen3-8B, FC) | сильнее на многоходовых; пробуй, если 4B не дотянет |
| `llama3.1:8b` | 4.9 ГБ | впритык | 25.83% / 70.76% / 84.00% (Llama-3.1-8B-Instruct, Prompt) | заметно слабее Qwen того же размера |
| `qwen3:1.7b` | 1.4 ГБ | да | 28.41% / 74.61% / 82.92% (Qwen3-1.7B, FC) | нижняя граница для сравнения |
| `gpt-oss:20b` | 14 ГБ | нет (по странице модели нужно от 16 ГБ) | в выгрузке BFCL не нашёл | если появится Mac на 16+ ГБ |

Выводы для этого бота:

- 4B и 8B почти не различаются на одиночных и параллельных вызовах (Non-Live ~88%), разница — на длинных диалогах. У нас 1–2 вызова на вопрос, поэтому 4B — разумный старт, а 8B на 8 ГБ памяти — дорогое удовольствие.
- Тег `qwen3:4b-instruct-…` без размышлений, отвечает быстрее. Обычный `qwen3:8b` — гибрид с режимом thinking; в нативном API его выключают `think: false`, через `/v1` — проверь в документации модели.
- Типичные ошибки маленьких моделей, которые увидишь в прогоне: аргумент вне `enum` (`period="7d"`), ответ без вызова инструмента с выдуманными цифрами, повторный вызов той же функции с теми же аргументами, ответ не по-русски. Лекарства — ошибка валидации в ответ модели, `MAX_STEPS`, повтор с подсказкой (выше), правило языка в системном промпте и детектор повторного вызова (одинаковые имя+аргументы дважды подряд → прервать цикл).
- Эталон сверху — `deepseek-flash` на **демо-базе**: если и он не набирает 12/15, проблема в функциях или вопросах, а не в размере модели.

### Сравнение: что этот бот использует у провайдеров

| Возможность | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Признак вызова | `stop_reason == "tool_use"`, блоки `tool_use` | `message.tool_calls` | как OpenAI | как OpenAI в `/v1`; в нативном `/api/chat` — `message.tool_calls` |
| Аргументы | словарь `input` | JSON-строка | JSON-строка | `/v1`: JSON-строка; нативно — объект |
| Куда результат | `tool_result` в user-сообщении, `tool_use_id` | `role: "tool"`, `tool_call_id` | то же | `/v1`: как OpenAI; нативно — `role: "tool"`, `tool_name` |
| Флаг ошибки | `is_error: true` | нет, текстом | нет, текстом | нет, текстом |
| Несколько вызовов за шаг | да | да | `tool_calls` — массив; отдельно параллельность в доке не описана | да (пример в доке) |
| `tool_choice` | есть | `auto`/`required`/`none`/функция | то же, но `required` и выбор функции → 400 в thinking-режиме | в `/v1` не поддерживается |
| Thinking + tools | см. главу 2.6 | — | `reasoning_content` возвращать во всех следующих запросах, иначе 400 | у гибридных моделей параметр `think` |
| Ошибки, которые ретраить | 429, 5xx, 529 (глава 2.7) | 429, 5xx | 429, 500, 503; **402 (нет баланса) и 401 — не ретраить** | `Connection refused` — сервер Ollama не запущен; ретраи не помогут |

### Что использовать для практики

- **Основной путь:** Ollama (`qwen3:4b-instruct-2507-q4_K_M` или то, что победит в твоём сравнении) — сначала на демо-базе, потом на реальной копии. Только это сочетание попадает в итоговый критерий «12 из 15 на копии».
- **DeepSeek** — на демо-базе: эталон качества и проверка, что бот провайдеро-независим.
- **Claude / OpenAI** — по желанию, на демо-базе, для сравнения форматов (Anthropic-версия цикла из теории).

## Маршрут изучения

1. Перечитай [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) → разделы про обработку результатов инструментов, `is_error`, параллельные вызовы, `tool_choice` (≈30 мин). Сверь свой цикл из AIL-10 с документацией: формат `tool_result`, порядок блоков.
2. Открой [aiogram](https://docs.aiogram.dev) → Dispatcher (start_polling), Router (`include_router`, фильтры на уровне роутера), Filters (magic filter `F`, `Command`, `CommandStart`) (≈45 мин). Обрати внимание, как фильтры применяются к роутеру целиком.
3. Там же → раздел Middlewares (≈20 мин): понять, что доступ можно сделать и middleware; сравни с фильтром на роутере и выбери один способ.
4. Открой [Telegram Bot API](https://core.telegram.org/bots/api) → `sendMessage` (лимит текста, `parse_mode`), `sendChatAction` (≈15 мин).
5. Открой [asyncio: Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html) → `asyncio.to_thread` (≈10 мин). Возьми: как не блокировать event loop синхронным кодом.
6. Открой [Anthropic: Errors](https://docs.anthropic.com/en/api/errors) → коды ошибок (≈10 мин) — освежить, что ретраить (AIL-11).
7. (По желанию) [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) → начало, про workflows vs agents (≈20 мин). Твой бот — самый простой агент: один цикл, узкие инструменты.
8. Открой [Ollama: Tool calling](https://docs.ollama.com/capabilities/tool-calling) → разделы про параллельные вызовы и multi-turn цикл (≈15 мин). Сравни их цикл `while True` со своим `MAX_STEPS`.
9. Открой [Ollama: Context length](https://docs.ollama.com/context-length) и [Ollama FAQ](https://docs.ollama.com/faq) → окно по умолчанию, `ollama ps`, `keep_alive` (≈10 мин).
10. Открой [DeepSeek: Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) и [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) → как вернуть результат (`role: "tool"`, `tool_call_id`), как выключить thinking, правило про `reasoning_content` (≈20 мин).
11. Открой [DeepSeek: Error Codes](https://api-docs.deepseek.com/quick_start/error_codes) и [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) → что ретраить, а что нет (402, 401); keep-alive пустыми строками при нагрузке (≈10 мин).
12. Открой [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) → найди в таблице Qwen3-4B/8B, Llama-3.1-8B; посмотри, что значат категории Live, Non-Live, Multi Turn (≈15 мин). Возьми: общий балл ≠ пригодность для твоей задачи.

## На что обратить внимание

- **Модель может «ответить» без вызова инструмента**, выдумав цифры. Правило в промпте «цифры только из инструментов» плюс проверка в `run_questions.py`: если в ответе есть число, а `tool_calls` пустой — подозрительно.
- **Неверный выбор периода.** «За прошлую неделю» ≠ «за последние 7 дней». Если ты сделал только скользящие окна — промпт должен велеть модели сказать, какое окно она взяла.
- **Синхронный вызов в async-хендлере** — бот «зависает» для всех апдейтов. Симптом: второй вопрос обрабатывается только после первого.
- **История с обрезанной парой tool_use/tool_result** → ошибка 400 от API на каждом следующем сообщении. Решение — хранить только текст.
- **Бот в группе.** Если тебя добавят в группу с ботом, фильтр по `from_user.id` пропустит твои сообщения и ответ увидят все. `F.chat.type == "private"` закрывает это.
- **Логи — это реальные данные.** Вопросы и ответы с твоими PnL пишутся в `logs/`, которые в `.gitignore`.
- **Prompt injection через данные** здесь маловероятна (данные — твои), но правило то же: результат инструмента — это данные, а не инструкции. Привычка пригодится в RAG (этап 2).
- **Ни одного нового инструмента «на всякий случай».** Список инструментов в этом проекте — 4 функции из AIL-14. Если в голове возникает «а пусть бот ещё сможет закрыть позицию» — нет.
- **Стоимость.** Каждый шаг цикла повторно отправляет весь контекст: системный промпт + схемы 4 инструментов + история + результаты. Ответ в 3 шага стоит примерно втрое больше одного. В AIL-16 ты это измеришь. На Ollama денег это не стоит, но стоит секунд: каждый шаг — новая обработка всего промпта на твоём M2.
- **Сравнение моделей на реальной копии.** Соблазн «прогоню DeepSeek на настоящих вопросах, для честности» — нет. Сравнение — на демо-базе; на копии — только Ollama.
- **Локальная модель и торговое приложение на одной машине.** Прогон 15 вопросов на 8B-модели может уйти в swap и замедлить сервер арбитража. Прогоняй, когда автоторговля не взведена.
- **DeepSeek в thinking-режиме + история только из текста** → риск 400 на втором сообщении. Отсюда `thinking: disabled`.

## Практика

- [ ] **Бот-«эхо» с доступом.** `bot/main.py` с фильтром на роутере по `OWNER_TELEGRAM_ID` и типу чата. Проверь: ты получаешь эхо, второй аккаунт (или друг) — тишину. Токен и ID — из `.env` через `python-dotenv`.
- [ ] **`bot/agent.py`.** `answer(question, history) -> AgentResult(text, tool_calls, usage...)` на OpenAI-формате по скелету из раздела «DeepSeek и Ollama» (`AsyncOpenAI`, провайдер из `.env`), `MAX_STEPS = 5`, `build_system_prompt()` с датой, временем и часовым поясом из `TIMEZONE` (`zoneinfo.ZoneInfo`). Для DeepSeek — `thinking: disabled`.
- [ ] **`execute_tool` + адаптеры.** Ядро `execute_tool(name, raw) -> (content, is_error)` с реестром и валидацией Pydantic; адаптер `run_tool_openai` (основной) и, для сравнения, `run_tool` в формате Anthropic с `is_error`. Тесты pytest на ядро: неизвестный инструмент, невалидные аргументы, невалидный JSON в `arguments`, исключение внутри функции — во всех случаях ошибка без traceback в `content`.
- [ ] **Окно Ollama.** Подними контекст до 8–16k (ползунок в приложении или `OLLAMA_CONTEXT_LENGTH`), убедись в `ollama ps`, что модель `100% GPU`.
- [ ] **Консольный режим.** `python -m bot.agent "какой PnL за неделю?"` — отладка без Telegram. Печатай шаги: какой инструмент, с какими аргументами, сколько символов результата.
- [ ] **Подключить агента к хендлеру**, «печатает…», обрезка до 4000 символов, `/start`, `/reset`.
- [ ] **История**: последние 6 пар в `deque`. Проверь follow-up: «какой PnL за неделю?» → «а за месяц?» → «а по какой паре больше всего?».
- [ ] **Ошибки.** Проверь руками четыре сценария: (1) переименуй файл копии базы → бот отвечает человеческой фразой, в логе traceback; (2) закрой приложение Ollama → «сервис модели недоступен»; (3) с DeepSeek на демо-базе — заведомо неверный ключ (401) → то же сообщение, без ретраев; (4) напиши «закрой позицию по BTC» → вежливый отказ, ни одного вызова инструмента записи (их нет).
- [ ] **`scripts/run_questions.py`.** Аргументы `--provider`, `--model`, `--db`; первым делом `assert_data_policy`. Вывод: `# | вопрос | инструменты | ответ | время`. Отметь ✓/✗ по ожидаемым ответам. Сохрани результат в `logs/eval-<model>-YYYY-MM-DD.md` (в git не попадает).
- [ ] **Выбор локальной модели (демо-база).** Прогони 15 вопросов на `deepseek-flash` (эталон), `qwen3:4b-instruct-2507-q4_K_M` и, если память позволяет, `qwen3:8b`. Таблица в `logs/model-compare.md`: модель | ✓ из 15 | неверный инструмент/аргументы | цифры без вызова | медиана времени. Выбери модель для реальной копии, запиши тег в `.env`.
- [ ] **Доведи до 12/15 на реальной копии с Ollama.** Типичные исправления: описание инструмента, формулировка правила в системном промпте, параметр периода, резолвер пары, повтор с подсказкой при ответе без инструментов. После каждого изменения — полный прогон, а не один вопрос.
- [ ] *(Для сравнения, по желанию, демо-база)* Тот же прогон через Anthropic-цикл из теории. Запиши, что пришлось поменять в коде, кроме клиента.

## Готово, когда

- Бот отвечает только тебе и только в личке; чужие сообщения игнорируются.
- Модель вызывает инструменты из реестра, ответы содержат цифры только из результатов функций.
- История последних N сообщений работает, `/reset` её очищает.
- Падение функции, модели или таймаут дают человеческое сообщение, traceback только в логе.
- `run_questions.py` показывает **не меньше 12 из 15** правильных ответов на копии базы **с локальной моделью Ollama**; вопросы «вне возможностей» получают отказ, а не выдумку.
- Есть `logs/model-compare.md`: DeepSeek и 1–2 локальные модели на демо-базе, выбранный тег записан в `.env`.
- Облачный провайдер не запускается на реальной копии — `assert_data_policy` стоит в боте и в `run_questions.py`.

## Тест для самопроверки

1. Модель вернула два блока `tool_use` в одном ответе. Как правильно отправить результаты?
   a) два отдельных user-сообщения; b) одно user-сообщение с двумя `tool_result`; c) только первый результат; d) assistant-сообщение с результатами.
2. Зачем `MAX_STEPS` в цикле агента?
3. Что не так в этом хендлере?
   ```python
   @router.message(F.text)
   async def question(message: Message):
       resp = anthropic_client.messages.create(...)   # sync client
       await message.answer(resp.content[0].text)
   ```
4. Почему лучше хранить в истории только текст вопросов и ответов, а не блоки `tool_use/tool_result`?
5. Функция упала с исключением. Что получает модель и что — пользователь?
6. Почему в системный промпт нужно добавлять текущую дату, если `period` считается в коде?
7. Как ограничить бота только тобой в aiogram 3 и почему бот должен молчать для чужих?
8. Что не так в этом системном промпте?
   ```text
   Ты помощник трейдера. Помогай с позициями: можешь их анализировать,
   открывать и закрывать по просьбе пользователя.
   ```
9. Бот работает на двух машинах с одним токеном. Что произойдёт?
10. Почему `answer()` не должна импортировать ничего из aiogram?
11. Модель ответила «PnL за неделю +312 USDT», а `tool_calls` пустой. Что это значит и как это ловить?
12. Что не так в этом коде для DeepSeek/Ollama?
    ```python
    msg = resp.choices[0].message
    for tc in msg.tool_calls:
        result = execute_tool(tc.function.name, tc.function.arguments)
        messages.append({"role": "user", "content": result})
    ```
13. Бот на DeepSeek без `extra_body` отвечает на первый вопрос, а на втором (с историей) получает 400. Почему и как исправить?
14. Почему в таблице BFCL общий балл Qwen3-4B заметно ниже, чем Qwen3-8B, но для этого бота 4B — разумный старт?
15. На Ollama нельзя `tool_choice="required"`. Как тогда бороться с ответами без вызова инструмента?

## Ответы

1. **b.** Все результаты одного шага — в одном user-сообщении, каждый со своим `tool_use_id`.
2. Чтобы модель не зациклилась на ошибках или повторных вызовах: каждый шаг стоит денег и времени. После лимита — фолбэк-ответ.
3. Синхронный клиент блокирует event loop — бот не обрабатывает другие апдейты во время запроса; нет обработки ошибок; `content[0]` может быть `tool_use`, а не текстом; нет инструментов и цикла.
4. Компактнее, и обрезка истории не разорвёт пару `tool_use`→`tool_result`, из-за которой API вернёт 400. Цифры на follow-up модель получит заново из функции.
5. Модель — `tool_result` с `is_error: true` и коротким сообщением без деталей; пользователь — человеческий ответ модели («данные сейчас недоступны»); traceback — только в логе.
6. Модель не знает «сегодня»: без даты она не решит, что такое «понедельник», «с начала месяца», и может неверно выбрать период или интерпретировать результат.
7. Фильтр на роутере: `router.message.filter(F.chat.type == "private", F.from_user.id == OWNER_ID)` (или middleware). Молчание не раскрывает, что бот что-то умеет, и не тратит токены на чужие запросы.
8. Обещает возможность открывать и закрывать позиции — это противоречит архитектуре проекта и подталкивает модель обещать действия; нет даты, правил про цифры из инструментов и ограничений данных.
9. Telegram отдаст апдейты только одному процессу, второй получит ошибку `Conflict: terminated by other getUpdates request`; ответы будут непредсказуемо приходить с одной из машин.
10. Чтобы её можно было вызывать из скрипта оценки, консоли и тестов без Telegram; хендлер остаётся тонким транспортным слоем.
11. Модель выдумала цифру (галлюцинация). Ловить в `run_questions.py`: число в ответе при пустом `tool_calls` — флаг; лечить правилом в промпте и, при необходимости, `tool_choice` (там, где он есть).
12. `arguments` — JSON-строка, её надо `json.loads` (и обработать невалидный JSON); ассистентское сообщение с `tool_calls` не добавлено в историю; результат должен идти как `role: "tool"` с `tool_call_id`, а не `user`; нет проверки, что `tool_calls` не `None`.
13. У DeepSeek thinking включён по умолчанию, и с `tools` поле `reasoning_content` нужно возвращать в следующих запросах, а история хранит только текст. Исправление для бота — `extra_body={"thinking": {"type": "disabled"}}` (или хранить полные сообщения ассистента).
14. Общий балл BFCL тянут вниз многоходовые агентные сценарии; на одиночных и параллельных вызовах (Non-Live) 4B и 8B почти равны (~88%). У бота 1–2 вызова на вопрос, а 4B в 2 раза меньше по памяти — важно на 8 ГБ. Окончательно решает прогон своих 15 вопросов.
15. Правило в системном промпте; детектор «цифры без вызова» и один повтор с подсказкой «используй инструменты»; узкие понятные описания инструментов; если не помогает — модель покрупнее.

## Что дальше

В AIL-16 «Проект 1: логирование стоимости, README, GitHub» ты начнёшь логировать токены, стоимость и время каждого запроса, добавишь `/stats` и доведёшь репозиторий до публичного вида на фейковой базе.
