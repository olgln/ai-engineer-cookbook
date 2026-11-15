# 3.3 · Project 1: tool calling + Telegram  (AIL-15)

> **Week 3** · LLM basics · ⏱ ~8 h (2 days) · Project

<!-- description: Building a Telegram bot with aiogram: the tool calling loop, the trust boundary for function calls, the system prompt, dialog history, error handling. -->
<!-- source-sha256: 8ed8eaaad4ed -->

## Why an AI engineer needs this

This is where everything comes together: the shop owner writes a question → the model picks functions → the code runs them → the bot answers. This glue — the tool loop, history, errors, access, the date in the prompt — is exactly what separates a notebook demo from a product. In an interview we will be asked to draw this loop and asked what happens if the model gets stuck in a loop, a function fails or a stranger writes to the bot.

⚠️ **Read-only.** No functions that change orders, issue refunds or hand out promo codes, and no requests with keys to the payment provider or the delivery service — only the database snapshot.

## Theory

We already wrote the `tool_use → tool_result` loop in AIL-10, and the `call_llm()` wrapper with retries and cost counting in AIL-11. Here we look at how to fit them into a live bot.

### 1. Application layers

```
aiogram handler (bot/main.py)          ← Telegram: access, "typing…", sending
        │ question, history
        ▼
agent.answer() (bot/agent.py)          ← loop: call_llm ↔ run_tool, max 5 steps
        │                     │
        ▼                     ▼
llm_utils.call_llm()     tools.run_tool(name, input)   ← Pydantic validation,
 (AIL-11: retries,          │                              errors → is_error
  timeout, usage)           ▼
                       tools.get_sales(...) → SQLite (mode=ro, snapshot)
```

The main rule: **`agent.answer()` knows nothing about Telegram**. It is a "question + history → answer + metadata" function. Then it can be run from a script over a list of questions (that is our eval), from the console and later from a web interface. The aiogram handler is thin: it checks access, fetches the history, calls `answer()` and sends the text.

### 2. The agent loop

Below is the loop in the Anthropic format, as in chapter 2.6 · Tool calling: the model calls 3 functions (AIL-10). The working version of the bot uses the OpenAI format for Ollama and DeepSeek; it is in the "DeepSeek and Ollama" section below. The logic is the same, only the field names differ.

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
    return AgentResult(text="Couldn't answer in 5 steps; try rephrasing the question.",
                       tool_calls=calls)
```

Details that are easy to miss:

- **All `tool_result` blocks of one step go into one user message**, one per `tool_use` with a matching `tool_use_id`. The model may ask for two functions at once ("which orders are in progress right now and what's the revenue this week").
- **The assistant reply with `tool_use` is added to the history in full** (`resp.content`), including the text before the call.
- **A step limit is mandatory**: without it, a model that keeps getting an error may call the same function forever, and every step costs money.
- `asyncio.to_thread` is needed if our `call_llm()` is synchronous: a synchronous HTTP request inside an `async` handler blocks the event loop, and the bot stops answering everything else for 5–20 seconds. The alternative is the async client `AsyncAnthropic` and `async def call_llm`. The analogy from other languages: synchronously reading a large file (e.g. `fs.readFileSync` in Node.js) right inside an HTTP request handler.

### 3. `run_tool`: the trust boundary

In the loop above every call the model requests goes through `run_tool`. Input from the model is untrusted, and `run_tool` is the only point where a name and arguments turn into a code call:

```python
def run_tool(tool_use_id: str, name: str, raw_input: dict) -> dict:
    entry = TOOLS.get(name)
    if entry is None:
        return _error(tool_use_id, f"Unknown tool {name}")
    args_model, fn, _ = entry
    try:
        args = args_model.model_validate(raw_input)
        with closing(open_readonly(SHOP_DB)) as conn:   # fresh read-only connection, closed after the call
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

- The `TOOLS` registry is an allowlist. The model can't call anything that isn't in it.
- A function error goes back **to the model** as `is_error`, not to the user as a traceback. The model often fixes the arguments itself (`period="2 weeks"` → `"week"`) or honestly says there is no data.
- Internal details (paths, SQL, the stack) don't go into `content`: they would end up in the context and could show up in the answer.
- Why `closing` (from `contextlib`): `open_readonly` from AIL-13 returns a plain `sqlite3.Connection`, and in Python `with conn:` manages a transaction and **does not close** the connection. `closing(...)` guarantees `conn.close()` even on an exception.
- `get_product_interest` from AIL-14 also takes a connection to the `analytics.db` snapshot: `run_tool` opens it the same way, with `closing(open_readonly(ANALYTICS_DB))`, and passes it as the second argument.
- By default a SQLite connection can't be used from another thread (`check_same_thread=True`). Opening a connection per call is cheap and removes the problem.

### 4. The system prompt

The loop and the trust boundary are ready. What remains is to tell the model who it is, what time it is now and which rules to follow — that is the system prompt, which `build_system_prompt()` assembles before every request:

```text
Role: analyst of the Shelf online shop, answers the owner. Answers in English, brief.
Now: {now:%Y-%m-%d %H:%M} ({tz}), day of the week: {weekday}.

Rules:
- Take numbers only from tool results. Don't make them up and don't round
  them more than they came.
- Profit is calculated from prices, cost of goods, discounts and payment fees;
  actual shipping costs are not included — say so in answers about profit.
- Statistics on views and add-to-carts are kept for 30 days.
- The bot only reads data. It cannot change orders, issue refunds
  or hand out promo codes. To such requests, answer that the bot is read-only.
- If a question is ambiguous (several products match), ask a clarifying question.
- Format: plain text without Markdown tables, amounts with 2 decimal places.
```

Why the date is mandatory: the model doesn't know "today". Without a date, for "this week" it either picks a parameter at random or, if the tools take explicit dates, counts from a date in its training data. With `period: Literal["day","week","month"]` this is less critical (the code computes the window), but questions like "what happened on Monday" or "since the start of the month" can't be solved without the date in the prompt: the model won't know which window to choose or how to tell the owner which days the numbers cover. So the owner's date, time and time zone go into every system prompt.

The date line changes every minute, while prompt caching (AIL-11) caches a prefix. If we ever need to cache a long prompt, we put the date at the end of the system prompt or into the user message, and the unchanging part at the beginning.

### 5. Dialog history

One question is one run of the loop. But the owner also writes follow-ups like "and for the month?", which make no sense without the previous question. The model doesn't remember previous requests (AIL-4), so we pass the history ourselves. For the bot:

```python
from collections import defaultdict, deque

HISTORY_TURNS = 6                                   # user+assistant pairs
_history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY_TURNS * 2))
```

- We store **only the question text and the final answer text**, not the intermediate `tool_use/tool_result`. This is compact, and trimming by `maxlen` never breaks a `tool_use`→`tool_result` pair (the API rejects a history where a `tool_result` has no `tool_use` of its own).
- The history must start with `user`. A `deque` of user/assistant pairs guarantees this if we add them as a pair and only after a successful answer.
- The price: on a follow-up like "and for mugs?" the model calls the tool again, since it doesn't see the numbers from the previous step. For this bot that's fine and even good: the numbers are always fresh from the function.
- The `/reset` command clears the history. The history lives in the process memory and disappears on restart — fine for a single-owner bot.

### 6. aiogram: access, "typing…", sending

`answer()` and the history know nothing about Telegram. The last layer is a thin aiogram handler that lets in only the owner, shows "typing…", calls `answer()` and sends the reply:

```python
# bot/main.py (illustrative, aiogram 3)
router = Router()
router.message.filter(F.chat.type == "private",
                      F.from_user.id == settings.owner_telegram_id)

@router.message(CommandStart())
async def start(message: Message):
    await message.answer("Questions about the shop: revenue, orders in progress, interest in products.")

@router.message(Command("reset"))
async def reset(message: Message):
    _history.pop(message.chat.id, None)
    await message.answer("History cleared.")

@router.message(F.text)
async def question(message: Message, bot: Bot):
    await bot.send_chat_action(message.chat.id, ChatAction.TYPING)
    try:
        result = await answer(message.text, list(_history[message.chat.id]))
    except Exception:
        log.exception("answer failed")
        await message.answer("Couldn't answer: the model service is unavailable. "
                             "Try again in a minute.")
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

- **A filter on the router** applies to all of its handlers. Messages from strangers don't get in — the bot stays silent. Silence is better than answering "access denied": that way we don't confirm the bot can do anything.
- **A Telegram ID isn't a secret, but we don't hardcode it** — it goes into `.env`, next to the token. We can find our own ID by logging `message.from_user.id` once.
- **A separate bot.** A new token from @BotFather; we don't reuse the token of another bot (e.g. the shop's notification bot). One token is polled by only one process — otherwise we get the error `Conflict: terminated by other getUpdates request`.
- **Polling, not a webhook**: the bot runs on our machine, no public URL is needed.
- **Telegram's message limit is 4096 characters**: we truncate or split into parts.
- **We don't turn on parse mode**: Markdown from the model with an unpaired `_` or `*` makes sending fail. Plain text is more reliable.

### 7. Errors: what the user sees

Errors happen at every layer: in a function, in the model API, in the loop itself. Let's put them into one table: where each one is caught and what the owner ends up seeing:

| What failed | What the code does | What the user sees |
|---|---|---|
| Function: invalid arguments | `is_error` to the model | the model corrected itself and answered |
| Function: an exception | log + `is_error` to the model | "the data is unavailable right now" (said by the model) |
| API: 429/5xx/529 | retries in `call_llm()` (AIL-11) | nothing, if a retry helped |
| API: all retries exhausted, timeout | exception → handler | "the model service is unavailable, try again later" |
| Step limit | fallback text | "try rephrasing the question" |
| Empty answer (only tool_use, no text) | an `if not text` check | "couldn't put together an answer" |

The user never sees a traceback, and the log always has the traceback.

### 8. Checking against the list of questions

The bot is assembled; what's left is to check it against `questions.md` from AIL-13. The "12 out of 15" done criterion is checked by a script, not by eye in Telegram. `scripts/run_questions.py` runs `answer()` on each question from `questions.md` (without history) and prints the tools called and the answer. We compare with the expected one (the manual SQL from AIL-13) and mark ✓/✗. This is a prototype of the evals that week 6 is devoted to: we keep the script and the run results (results on the live database snapshot stay local only, in `logs/`, not in git).

## DeepSeek and Ollama: how we do it

A reminder from chapter 3.1: **the snapshot of the "live" database (`data/shop.db`, it holds customers' personal data) is seen only by the local Ollama model**; DeepSeek (servers in China), and Claude/OpenAI for comparison, work only with the demo database `data/demo_shop.db`. The data is made up, but we treat it as real. `assert_data_policy()` is called when the bot starts and in `run_questions.py`.

### The loop in the OpenAI format

One code path for Ollama and DeepSeek — only `base_url`, the key and the model from `.env` change:

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
    return AgentResult(text="Couldn't answer in 5 steps; try rephrasing the question.",
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

For brevity the `AsyncOpenAI` client is called directly here, with the SDK's own retries (`max_retries=2`), and `settings` is an object with the environment variables from `bot/config.py`. In the project this is the place for `call_llm()` from AIL-11: our own retry loop, logging of tokens and cost (they will be needed in AIL-16). If `call_llm()` is synchronous, we call it through `asyncio.to_thread`, as in the theory.

What changed compared to the Anthropic version:

- **The system prompt is the first message** with `role: "system"`, not a separate parameter.
- **The sign of a call** is a non-empty `message.tool_calls`. We check it rather than `finish_reason == "tool_calls"`: that is more reliable across different servers.
- **Arguments arrive as a JSON string**, not a dict. A small local model may send invalid JSON — that is the same kind of argument error, and we return it to the model.
- **Each result is a separate message** with `role: "tool"` and `tool_call_id` (in Anthropic, all `tool_result` blocks go in one user message).
- **There is no `is_error` flag** — we write `ERROR: ...` into `content`.
- It is useful to split `run_tool` from the theory: the core `execute_tool(name, raw) -> (content, is_error)` (allowlist, Pydantic, read-only connection) knows nothing about the provider, and two thin adapters wrap the result into a `tool_result` (Anthropic) or a `role: "tool"` message (OpenAI format). The tests in the practice are written against the core.
- The async client `AsyncOpenAI` means `asyncio.to_thread` is no longer needed.

### DeepSeek: why the bot runs without thinking

According to the [thinking mode documentation](https://api-docs.deepseek.com/guides/thinking_mode) (November 2026), the thinking mode of `deepseek-flash` and `deepseek-v4-pro` is **on by default**, and if the request has `tools`, the `reasoning_content` field must be sent back to the API in all subsequent requests — otherwise **error 400**. Our bot stores only the text of questions and answers in the history. Besides, in thinking mode `tool_choice="required"` and choosing a specific function also give 400, and `temperature` is silently ignored. A bot with 4 simple functions doesn't need thinking, hence `extra_body={"thinking": {"type": "disabled"}}`. To compare with thinking, the history has to store full assistant messages (`messages.append(msg)` in full, as in the loop above), not just the text. How exactly the API reacts to a history where old turns are trimmed to text the documentation doesn't say directly — we check it ourselves on the demo database.

### Ollama: the context window and no `tool_choice`

- **The window.** By default 4k tokens on machines with < 24 GB of video memory ([Context length](https://docs.ollama.com/context-length)). For the bot we set 8–16k: the slider in the Ollama app settings or `OLLAMA_CONTEXT_LENGTH=16384` for the server. The check is `ollama ps`: the `CONTEXT` column shows the window, `PROCESSOR` shows whether the model fits in the GPU (we need `100% GPU`; if part of it is on the CPU, the window or the model is too large for our memory).
- **`tool_choice` is not supported in `/v1`** ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)) — there is no way to force the model to call a function. The workaround: if the answer contains numbers and `tool_calls` is empty, we repeat the request once with an added user message "Use the tools to get the numbers, do not answer from memory" and flag the case in the log.
- **The first request is slow**: the model is loading into memory. After that it stays loaded for `keep_alive` (5 minutes by default) and is unloaded. For a single-owner bot that's fine; we don't make `keep_alive` infinite on a machine where something else important is running.

### Which Ollama models handle tool calling for this bot

The numbers below are not a run on a particular machine but a public benchmark plus memory constraints. **Our own run of the 15 questions decides.** The benchmark is the [Berkeley Function Calling Leaderboard (BFCL)](https://gorilla.cs.berkeley.edu/leaderboard.html), the April 12, 2026 update. Columns: the overall score (it includes many multi-turn agentic scenarios our bot doesn't need), Live (real user functions) and Non-Live (simple, multiple and parallel calls) — the last two are closest to our bot.

| Ollama tag | Download | On an 8 GB machine alongside other programs | BFCL: overall / live / non-live | Verdict |
|---|---|---|---|---|
| `qwen3:4b-instruct-2507-q4_K_M` | 2.5 GB | yes | 35.68% / 76.39% / 87.88% (Qwen3-4B-Instruct-2507, FC) | **the main candidate** |
| `qwen3:8b` (q4_K_M) | 5.2 GB | barely: only with the browser closed and no heavy programs | 42.57% / 80.53% / 87.58% (Qwen3-8B, FC) | stronger at multi-turn; we try it if 4B falls short |
| `llama3.1:8b` | 4.9 GB | barely | 25.83% / 70.76% / 84.00% (Llama-3.1-8B-Instruct, Prompt) | noticeably weaker than Qwen of the same size |
| `qwen3:1.7b` | 1.4 GB | yes | 28.41% / 74.61% / 82.92% (Qwen3-1.7B, FC) | the lower bound for comparison |
| `gpt-oss:20b` | 14 GB | no (the model page says 16 GB or more is needed) | not found in the BFCL export | for machines with 16+ GB |

Takeaways for this bot:

- 4B and 8B barely differ on single and parallel calls (Non-Live ~88%); the difference is in long dialogs. We have 1–2 calls per question, so 4B is a sensible start, and 8B on 8 GB of memory is an expensive luxury (on 16 GB, 7–8B models already fit comfortably).
- The `qwen3:4b-instruct-…` tag has no thinking and answers faster. The plain `qwen3:8b` is a hybrid with a thinking mode; in the native API it is turned off with `think: false`, and for `/v1` this is worth checking in the model's documentation.
- Typical small-model errors we will see in the run: an argument outside the `enum` (`period="7d"`), an answer without a tool call with made-up numbers, a repeated call of the same function with the same arguments, an answer in the wrong language. The remedies: a validation error sent back to the model, `MAX_STEPS`, a retry with a hint (above), a language rule in the system prompt and a repeated-call detector (the same name+arguments twice in a row → break the loop).
- The reference from above is `deepseek-flash` on the **demo database**: if even it doesn't reach 12/15, the problem is in the functions or the questions, not in the model size.

### Comparison: what this bot uses from each provider

| Capability | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Sign of a call | `stop_reason == "tool_use"`, `tool_use` blocks | `message.tool_calls` | as OpenAI | as OpenAI in `/v1`; in the native `/api/chat`, `message.tool_calls` |
| Arguments | an `input` dict | a JSON string | a JSON string | `/v1`: a JSON string; native: an object |
| Where the result goes | `tool_result` in a user message, `tool_use_id` | `role: "tool"`, `tool_call_id` | the same | `/v1`: as OpenAI; native: `role: "tool"`, `tool_name` |
| Error flag | `is_error: true` | none, in text | none, in text | none, in text |
| Several calls per step | yes | yes | `tool_calls` is an array; parallelism isn't described separately in the docs | yes (an example in the docs) |
| `tool_choice` | yes | `auto`/`required`/`none`/a function | the same, but `required` and choosing a function → 400 in thinking mode | not supported in `/v1` |
| Thinking + tools | see chapter 2.6 | — | send `reasoning_content` back in all subsequent requests, otherwise 400 | the `think` parameter for hybrid models |
| Errors to retry | 429, 5xx, 529 (chapter 2.7) | 429, 5xx | 429, 500, 503; **don't retry 402 (no balance) and 401** | `Connection refused` — the Ollama server isn't running; retries won't help |

### What to use for the practice

- **The main path:** Ollama (`qwen3:4b-instruct-2507-q4_K_M` or whatever wins our comparison) — first on the demo database, then on the live database snapshot. Only this combination counts toward the final "12 out of 15 on the snapshot" criterion.
- **DeepSeek** — on the demo database: the quality reference and a check that the bot is provider-independent.
- **Claude / OpenAI** — optional, on the demo database, to compare formats (the Anthropic version of the loop from the theory).

## Learning path

1. We reread [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) → the sections on handling tool results, `is_error`, parallel calls, `tool_choice` (≈30 min). We check our loop from AIL-10 against the documentation: the `tool_result` format, the order of blocks.
2. [aiogram](https://docs.aiogram.dev) → Dispatcher (start_polling), Router (`include_router`, router-level filters), Filters (the magic filter `F`, `Command`, `CommandStart`) (≈45 min). We pay attention to how filters apply to the whole router.
3. In the same place → the Middlewares section (≈20 min): access can also be done with middleware; we compare it with a filter on the router and pick one way.
4. [Telegram Bot API](https://core.telegram.org/bots/api) → `sendMessage` (the text limit, `parse_mode`), `sendChatAction` (≈15 min).
5. [asyncio: Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html) → `asyncio.to_thread` (≈10 min). What we take: how not to block the event loop with synchronous code.
6. [Anthropic: Errors](https://docs.anthropic.com/en/api/errors) → error codes (≈10 min) — a refresher on what to retry (AIL-11).
7. (Optional) [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) → the beginning, on workflows vs agents (≈20 min). Our bot is the simplest agent: one loop, narrow tools.
8. [Ollama: Tool calling](https://docs.ollama.com/capabilities/tool-calling) → the sections on parallel calls and the multi-turn loop (≈15 min). We compare their `while True` loop with our `MAX_STEPS`.
9. [Ollama: Context length](https://docs.ollama.com/context-length) and [Ollama FAQ](https://docs.ollama.com/faq) → the default window, `ollama ps`, `keep_alive` (≈10 min).
10. [DeepSeek: Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) → how to return a result (`role: "tool"`, `tool_call_id`), how to turn off thinking, the rule about `reasoning_content` (≈20 min).
11. [DeepSeek: Error Codes](https://api-docs.deepseek.com/quick_start/error_codes) and [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) → what to retry and what not to (402, 401); keep-alive with empty lines under load (≈10 min).
12. [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) → we find Qwen3-4B/8B and Llama-3.1-8B in the table; we look at what the Live, Non-Live and Multi Turn categories mean (≈15 min). What we take: the overall score ≠ fitness for our task.

## What to watch out for

- **The model may "answer" without calling a tool**, making up numbers. The prompt rule "numbers only from tools" plus a check in `run_questions.py`: if the answer has a number and `tool_calls` is empty, it's suspicious.
- **The wrong period.** "Last week" ≠ "the last 7 days". If the code has only sliding windows, the prompt must tell the model to say which window it took.
- **A synchronous call in an async handler** — the bot "hangs" for all updates. The symptom: the second question is processed only after the first.
- **A history with a broken tool_use/tool_result pair** → a 400 error from the API on every next message. The fix is to store only text.
- **The bot in a group.** If the owner is added to a group with the bot, the `from_user.id` filter lets their messages through and everyone sees the answer. `F.chat.type == "private"` closes this.
- **Logs are real data.** Questions and answers with the shop's revenue and orders are written to `logs/`, which is in `.gitignore`.
- **Prompt injection through data** is unlikely here (the data comes from our own database), but the rule is the same: a tool result is data, not instructions. The habit will come in handy in RAG (weeks 4–5) and with agents (week 8).
- **Not a single new tool "just in case".** The tool list in this project is the 4 functions from AIL-14. If the thought "let the bot also issue refunds" comes up — no.
- **Cost.** Every step of the loop resends the whole context: the system prompt + the schemas of 4 tools + the history + the results. An answer in 3 steps costs roughly three times as much as one step. In AIL-16 we will measure it. On Ollama it costs no money, but it costs seconds: every step means processing the whole prompt again on our machine.
- **Comparing models on the live database snapshot.** The temptation "I'll run DeepSeek on the real questions, to be fair" — no. The comparison is on the demo database; on the snapshot, only Ollama.
- **A local model and other programs on the same machine.** A run of 15 questions on an 8B model can go into swap and slow down everything else running alongside. We run it when the machine isn't busy with important work.
- **DeepSeek in thinking mode + a text-only history** → a risk of 400 on the second message. Hence `thinking: disabled`.

## Practice

- [ ] **An "echo" bot with access control.** `bot/main.py` with a router filter on `OWNER_TELEGRAM_ID` and the chat type. We check: our account gets the echo, a second account (or a friend) gets silence. The token and the ID come from `.env` via `python-dotenv`.
- [ ] **`bot/agent.py`.** `answer(question, history) -> AgentResult(text, tool_calls, usage...)` in the OpenAI format following the skeleton from the "DeepSeek and Ollama" section (`AsyncOpenAI`, the provider from `.env`), `MAX_STEPS = 5`, `build_system_prompt()` with the date, time and time zone from `TIMEZONE` (`zoneinfo.ZoneInfo`). For DeepSeek, `thinking: disabled`.
- [ ] **`execute_tool` + adapters.** The core `execute_tool(name, raw) -> (content, is_error)` with the registry and Pydantic validation; the `run_tool_openai` adapter (the main one) and, for comparison, `run_tool` in the Anthropic format with `is_error`. pytest tests on the core: an unknown tool, invalid arguments, invalid JSON in `arguments`, an exception inside a function — in every case an error without a traceback in `content`.
- [ ] **The Ollama window.** We raise the context to 8–16k (the slider in the app or `OLLAMA_CONTEXT_LENGTH`) and make sure in `ollama ps` that the model is `100% GPU`.
- [ ] **Console mode.** `python -m bot.agent "what's the revenue this week?"` — debugging without Telegram. We print the steps: which tool, with which arguments, how many characters of result.
- [ ] **Connect the agent to the handler**, "typing…", truncation to 4000 characters, `/start`, `/reset`.
- [ ] **History**: the last 6 pairs in a `deque`. We check the follow-ups: "what's the revenue this week?" → "and for the month?" → "and which category sold best?".
- [ ] **Errors.** We check four scenarios by hand: (1) rename the database snapshot file → the bot answers with a human phrase, the log has the traceback; (2) close the Ollama app → "the model service is unavailable"; (3) with DeepSeek on the demo database, a deliberately wrong key (401) → the same message, no retries; (4) write "refund order 1042" → a polite refusal, not a single call to a write tool (there are none).
- [ ] **`scripts/run_questions.py`.** Arguments `--provider`, `--model`, `--db`; `assert_data_policy` comes first. Output: `# | question | tools | answer | time`. We mark ✓/✗ against the expected answers. We save the result to `logs/eval-<model>-YYYY-MM-DD.md` (it doesn't go into git).
- [ ] **Choosing a local model (demo database).** We run the 15 questions on `deepseek-flash` (the reference), `qwen3:4b-instruct-2507-q4_K_M` and, if memory allows, `qwen3:8b`. A table in `logs/model-compare.md`: model | ✓ out of 15 | wrong tool/arguments | numbers without a call | median time. We choose the model for the live database snapshot and write its tag into `.env`.
- [ ] **Getting to 12/15 on the snapshot with Ollama.** Typical fixes: a tool description, the wording of a rule in the system prompt, the period parameter, the product resolver, a retry with a hint when the answer has no tool calls. After each change, a full run, not a single question.
- [ ] *(For comparison, optional, demo database)* The same run through the Anthropic loop from the theory. We note what had to change in the code besides the client.

## Done when

- The bot answers only the owner and only in a private chat; messages from others are ignored.
- The model calls tools from the registry, and the answers contain numbers only from function results.
- The history of the last N messages works, and `/reset` clears it.
- A failure of a function or the model, or a timeout, produces a human message; the traceback is only in the log.
- `run_questions.py` shows **at least 12 out of 15** correct answers on the `data/shop.db` snapshot **with a local Ollama model**; "out of scope" questions get a refusal, not a made-up answer.
- There is `logs/model-compare.md`: DeepSeek and 1–2 local models on the demo database, and the chosen tag is written into `.env`.
- The cloud provider doesn't start on the live database snapshot — `assert_data_policy` is in the bot and in `run_questions.py`.

## Self-check quiz

1. The model returned two `tool_use` blocks in one reply. What is the correct way to send the results?
   a) two separate user messages; b) one user message with two `tool_result` blocks; c) only the first result; d) an assistant message with the results.
2. Why is `MAX_STEPS` needed in the agent loop?
3. What is wrong with this handler?
   ```python
   @router.message(F.text)
   async def question(message: Message):
       resp = anthropic_client.messages.create(...)   # sync client
       await message.answer(resp.content[0].text)
   ```
4. Why is it better to store only the text of questions and answers in the history, and not the `tool_use/tool_result` blocks?
5. A function failed with an exception. What does the model get and what does the user get?
6. Why add the current date to the system prompt if `period` is computed in the code?
7. How is the bot restricted to the owner only in aiogram 3, and why should the bot stay silent for strangers?
8. What is wrong with this system prompt?
   ```text
   Role: the shop owner's assistant. Helps with orders: can analyze them,
   change them, issue refunds and hand out promo codes at the user's request.
   ```
9. The bot runs on two machines with the same token. What happens?
10. Why must `answer()` not import anything from aiogram?
11. The model answered "revenue this week is $483.20", and `tool_calls` is empty. What does this mean and how is it caught?
12. What is wrong with this code for DeepSeek/Ollama?
    ```python
    msg = resp.choices[0].message
    for tc in msg.tool_calls:
        result = execute_tool(tc.function.name, tc.function.arguments)
        messages.append({"role": "user", "content": result})
    ```
13. A bot on DeepSeek without `extra_body` answers the first question, but on the second one (with history) gets a 400. Why, and how is it fixed?
14. Why, in the BFCL table, is the overall score of Qwen3-4B noticeably lower than that of Qwen3-8B, yet 4B is a sensible start for this bot?
15. Ollama doesn't allow `tool_choice="required"`. How then do we fight answers without a tool call?

## Answers

1. **b.** All results of one step go into one user message, each with its own `tool_use_id`.
2. So that the model doesn't get stuck in a loop on errors or repeated calls: every step costs money and time. After the limit, a fallback answer.
3. The sync client blocks the event loop — the bot doesn't process other updates during the request; there is no error handling; `content[0]` may be `tool_use` rather than text; there are no tools and no loop.
4. It is more compact, and trimming the history won't break a `tool_use`→`tool_result` pair, which would make the API return 400. On a follow-up the model gets the numbers from the function again.
5. The model gets a `tool_result` with `is_error: true` and a short message without details; the user gets a human answer from the model ("the data is unavailable right now"); the traceback is only in the log.
6. The model doesn't know "today": without a date it can't work out what "Monday" or "since the start of the month" means, and may pick the wrong period or misinterpret the result.
7. A filter on the router: `router.message.filter(F.chat.type == "private", F.from_user.id == OWNER_ID)` (or middleware). Silence doesn't reveal that the bot can do anything and doesn't spend tokens on strangers' requests.
8. It promises the ability to change orders, issue refunds and hand out promo codes — this contradicts the project's architecture (read-only) and pushes the model to promise actions; there is no date, no rules about numbers from tools and no data restrictions.
9. Telegram delivers updates to only one process, the other gets the error `Conflict: terminated by other getUpdates request`; answers will come unpredictably from one of the machines.
10. So that it can be called from the evaluation script, the console and tests without Telegram; the handler stays a thin transport layer.
11. The model made up the number (a hallucination). It is caught in `run_questions.py`: a number in the answer with an empty `tool_calls` is a flag; it is treated with a rule in the prompt and, if needed, `tool_choice` (where it exists).
12. `arguments` is a JSON string, it needs `json.loads` (and handling of invalid JSON); the assistant message with `tool_calls` isn't added to the history; the result must go as `role: "tool"` with `tool_call_id`, not as `user`; there is no check that `tool_calls` isn't `None`.
13. DeepSeek has thinking on by default, and with `tools` the `reasoning_content` field must be sent back in subsequent requests, while the history stores only text. The fix for the bot is `extra_body={"thinking": {"type": "disabled"}}` (or storing full assistant messages).
14. The overall BFCL score is pulled down by multi-turn agentic scenarios; on single and parallel calls (Non-Live) 4B and 8B are almost equal (~88%). The bot makes 1–2 calls per question, and 4B takes half the memory — which matters on 8 GB. The final decision comes from running our own 15 questions.
15. A rule in the system prompt; a "numbers without a call" detector and one retry with the hint "Use the tools…"; narrow, clear tool descriptions; if that doesn't help, a bigger model.

## What's next

In AIL-16, "Project 1: cost logging, README, GitHub", we start logging the tokens, cost and time of every request, add `/stats` and bring the repository to a public-ready state on the demo database.
