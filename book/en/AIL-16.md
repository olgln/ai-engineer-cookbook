# 3.4 · Project 1: cost logging, README, GitHub  (AIL-16)

> **Week 3** · LLM basics · ⏱ ~4 h · Project

<!-- description: Making an LLM bot portfolio-ready: logging cost and response time, a /stats command, demo mode, a README and a clean public repository. -->
<!-- source-sha256: 950768220e06 -->

## Why an AI engineer needs this

We bring the project to a state where we are not embarrassed to show it. An employer opens the repository for two minutes: the README, the diagram, how to run it, how much an answer costs. A line like "average cost per answer $0.004, 2.1 tools per question" says more about the author than any clever prompt: it means they think about production. And the logs of every request are the foundation for evals and monitoring, which we return to in week 6 (evals) and week 10 (production).

⚠️ The public repository gets **only the demo database**. Customers' personal data (names, emails, phones, cities) and figures from the shop's database snapshot must not end up in it — not as a file, a screenshot, a line of the README or a log entry, not now and not in the git history. The data in the snapshot is made up, but we treat it as real — this habit will be needed at work.

## Theory

### 1. What to log and why

One user request is not one API call but a loop of 1–5 steps (AIL-15). Logging is needed **at two levels**:

| Level | Fields | Why |
|---|---|---|
| Step (an LLM call) | model, input/output tokens, cache tokens, `stop_reason`, duration | to see which step is expensive |
| Request (question → answer) | time, `request_id`, question, tools called with their arguments, total tokens, cost, full response time, number of steps, status (ok / error / max_steps), answer length | `/stats`, the README, debugging, future evals |

An example request record (JSON Lines — one JSON per line):

```json
{"ts": "2026-12-04T10:15:02+00:00", "request_id": "a1b2c3", "question": "what's the revenue for the week?",
 "tools": [{"name": "get_sales", "args": {"period": "week"}, "ms": 4, "chars": 312}],
 "steps": 2, "input_tokens": 2841, "output_tokens": 96, "cache_read_tokens": 0,
 "cost_usd": 0.0099, "latency_ms": 3120, "status": "ok", "model": "<model-id>"}
```

Why JSONL: it is appended one line at a time, it doesn't break if the process crashes mid-write (at most the last line is corrupted), and it can be read by `jq`, by `pandas.read_json(..., lines=True)` and by ten lines of Python. The alternative is a separate SQLite database `logs/requests.db` with a `requests` table: more convenient for `/stats` via SQL. Both are fine; **the main thing is that it is a separate file, not a table in the shop's database snapshot**: the snapshot is opened read-only and must stay that way.

### 2. Cost

We already wrote `estimate_cost(model, input_tokens, output_tokens, cache_read_tokens=0, cache_write_tokens=0)` in AIL-5, and counting usage and the cost of a single call in `call_llm()` in AIL-11. What is new here is the cost not of a call but of a whole bot answer, and it has two subtleties:

1. **The cost of a request = the sum over all steps.** At every step the model rereads the system prompt, the tool schemas, the history and all previous results. So the second step is almost always more expensive than the first in input tokens.
2. **Cache is billed differently.** If prompt caching is enabled (AIL-11), `usage` has separate fields for cache writes and cache reads (`cache_creation_input_tokens`, `cache_read_input_tokens` in Anthropic's API), with their own prices. They have to be counted in `estimate_cost`, otherwise the cost comes out too high or too low.

Prices change — we don't hardcode them "from memory". The price dict lives in `bot/pricing.py` with a comment "checked on YYYY-MM-DD, source: pricing page" and a link to the provider's current pricing page. In the README we write "≈ $X per answer on model Y at prices as of date Z".

A worked example (the prices are made up, for the arithmetic; DeepSeek's prices and the same example with them are in the "DeepSeek and Ollama" section): step 1 is 2000 input + 60 output, step 2 is 2400 input + 120 output. At $3 / 1M input and $15 / 1M output: `(4400 × 3 + 180 × 15) / 1 000 000 = $0.0159`. There are few output tokens; what we mostly pay for is rereading the context — which is why the compact tool results from AIL-14 save money.

### 3. Response time

Money is only half the picture: the owner notices not the cost but how long they wait for an answer, and for a local model time is the only "price" at all. We measure with `time.perf_counter()` — a monotonic clock, not `time.time()`. Three numbers:

- the full request time (from receiving the message to sending the answer) — what the user feels;
- the time of each LLM call — usually 90% of the total;
- the time of each tool — should be milliseconds; if it is hundreds of ms, an index is missing or the function pulls too much.

For statistics, not only the mean is useful but also the median and p95: one request with a 40-second retry spoils the mean, and p95 shows how often that happens.

### 4. How to add logging without cluttering the code

What to write is clear; now — where to do it in the code. We collect the metadata in an object that travels through the loop and write the record **once at the end**, in `finally` — that way failed requests get into the log too:

```python
# bot/agent.py (illustrative)
async def answer(question: str, history: list[dict]) -> AgentResult:
    trace = RequestTrace(question=question)           # dataclass with counters
    started = time.perf_counter()
    try:
        ...                                           # loop from AIL-15
        # after each call_llm: trace.add_step(resp.usage, step_ms, resp.model)
        # after each tool:     trace.add_tool(name, args, tool_ms, len(content))
        trace.status = "ok"
        return result
    except Exception:
        trace.status = "error"
        raise
    finally:
        trace.latency_ms = int((time.perf_counter() - started) * 1000)
        trace.cost_usd = trace.total_cost()           # uses estimate_cost per step
        write_jsonl(LOG_PATH, trace.to_dict())
```

A failure to write the log must not break the answer to the user: we wrap `write_jsonl` in `try/except` with `log.exception`.

### 5. `/stats`

The log is written after every request, and it is easy to build a summary from it right in Telegram. `/stats` is a command for the owner; it reads the log and replies with text:

```
Requests: 47 (today 6)
Spent: $0.41 (today $0.05)
Average cost per answer: $0.0087, median $0.0071
Response time: median 2.8 s, p95 7.9 s
Tools per question: 1.6; most often get_sales (21)
Errors: 2
```

The logic is a pure function `compute_stats(records, now, tz) -> Stats` with a pytest test on 5 hand-written records; the handler only reads the file and formats. "Today" is in the shop owner's time zone, as in AIL-15.

### 6. Demo mode

So far the bot has worked on the database snapshot, but the README needs screenshots, sample answers and figures that can be shown to everyone. The demo database from AIL-14 provides them. One codebase, two data sources — switched through environment variables, without `if demo:` scattered through the code:

```
SHOP_DB_PATH=data/demo_shop.db
ANALYTICS_DB_PATH=data/demo_analytics.db
LOG_PATH=logs/demo-requests.jsonl
```

The demo databases are created by `scripts/make_fake_db.py` (AIL-14). Everything that goes into the README — a screenshot of a dialog, a sample answer, cost figures — is captured **in demo mode**. The cost on the demo database will be close to the cost on the snapshot: the context size depends on the schemas and the prompt, not on the figures in the orders.

It is handy to add a line "mode: DEMO" to `/start` — like the DEMO/PROD label in an admin panel header — so that the screenshot shows the data is generated.

### 7. A README that works

We put the figures from `/stats` and the screenshots from demo mode into the README. The structure:

1. **Name and one sentence**: "A Telegram bot for an online shop owner: answers questions about orders, sales and interest in products through tool calling. Read-only."
2. **A screenshot/GIF of a dialog** (demo database).
3. **What it can do**: 4 tools, one line each, sample questions.
4. **Architecture**: the diagram from AIL-13 (Mermaid), the three "read-only" layers.
5. **Security**: a snapshot via `VACUUM INTO`, `mode=ro` + `query_only`, no write functions (change an order, issue a refund, give out a promo code) and no requests to payment providers or delivery services, access by Telegram ID.
6. **Quick start**: Python version, installation, `.env`, generating the demo database, tests, running. The commands can be copied and work as is.
7. **Cost and quality**: average cost per answer, median time, "N of 15 questions" from `run_questions.py` on the demo database.
8. **Limitations**: delivery costs are not counted (profit is before delivery), interest in products covers only the last 30 days, history is kept in memory.
9. **What's next**: evals, caching, a web interface.

The "an outsider can run it" criterion is checked literally: a clean clone into a new folder, only the README, no knowledge that only the author has.

### 8. A clean public repository

Before making the repository public:

- `git ls-files` — no `*.db`, `.env`, `logs/`, `data/` (everyone generates the demo database themselves with `make_fake_db.py`);
- `git log --all --stat -- '*.db' '*.jsonl' '.env'` — these files were never in the history either. If they were, it is easier to create a new repository with a clean history than to scrub the old one;
- a search of the code for keys and tokens: `git grep -nE "sk-|ANTHROPIC_API_KEY=.+|[0-9]{8,10}:[A-Za-z0-9_-]{30,}"` (the last one is the Telegram token format);
- `.env.example` contains only variable names;
- screenshots: demo mode, no Telegram ID or name of ours, no customer names or contacts, no figures from the snapshot;
- `questions.md` and sample answers are from the demo database.

GitHub settings have secret scanning and push protection — we enable them for the repository, but treat them as the second safety net, not the first.

## DeepSeek and Ollama: how we do it

### One log record — four usage formats

Each provider reports tokens in its own way, and the most common mistake is adding up fields that already include each other. We normalize everything right after the call: `Usage(input_total, input_cached, output)`. In the log record from the theory these are the fields `input_tokens` (= `input_total`) and `cache_read_tokens` (= `input_cached`).

| Provider | All input tokens | Of them from cache | Output | Specifics |
|---|---|---|---|---|
| Claude | `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | `cache_read_input_tokens` | `output_tokens` | `input_tokens` **does not include** the cache; cache writes cost more than regular input |
| OpenAI | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | `completion_tokens` | the cache **is included** in `prompt_tokens` |
| DeepSeek | `prompt_tokens` (= `prompt_cache_hit_tokens + prompt_cache_miss_tokens`) | `prompt_cache_hit_tokens` | `completion_tokens` | the cache is automatic, no parameters; reasoning is in `completion_tokens_details.reasoning_tokens` (thinking is off in the bot) |
| Ollama, native `/api/chat` | `prompt_eval_count` | — | `eval_count` | plus durations in **nanoseconds**: `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration` |
| Ollama, `/v1` | `usage` in the OpenAI format | — | | the compatibility docs explicitly describe only `stream_options.include_usage` for streaming; on the first request it is worth checking that `resp.usage` is filled in a regular response, otherwise we take the numbers from the native API |

```python
# bot/usage.py (illustrative)
from dataclasses import dataclass

@dataclass
class Usage:
    input_total: int
    input_cached: int
    output: int

def from_deepseek(u) -> Usage:
    return Usage(u.prompt_tokens, getattr(u, "prompt_cache_hit_tokens", 0) or 0,
                 u.completion_tokens)

def from_ollama_native(r: dict) -> Usage:
    return Usage(r.get("prompt_eval_count", 0), 0, r.get("eval_count", 0))
```

A test for each adapter — on a hand-written fake usage object (no network).

### Cost: DeepSeek has three prices and a time of day

DeepSeek's prices as of November 2026 ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)), USD per 1M tokens:

| `deepseek-flash` | Off-peak | Peak |
|---|---|---|
| Input, cache hit | 0.003 | 0.006 |
| Input, cache miss | 0.15 | 0.30 |
| Output | 0.60 | 1.20 |

Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays, except Chinese public holidays; the rest of the time prices are half as much. `deepseek-v4-pro` costs several times more — its prices are on the same page. DeepSeek states plainly that it may change prices, so the check date in `pricing.py` is mandatory. If `llm_utils.py` already has `is_offpeak` from the AIL-11 practice, `deepseek_is_peak` below is its negation: the peak-hours rule lives in one place and is not copied.

```python
# bot/pricing.py (illustrative)
# checked on 2026-11-13, source: https://api-docs.deepseek.com/quick_start/pricing
DEEPSEEK_PRICES = {  # USD per 1M tokens
    "deepseek-flash": {
        "off_peak": {"hit": 0.003, "miss": 0.15, "out": 0.60},
        "peak":     {"hit": 0.006, "miss": 0.30, "out": 1.20},
    },
}

def deepseek_is_peak(ts_utc) -> bool:
    # Mon-Fri 01:00-04:00 and 06:00-10:00 UTC; Chinese public holidays not modelled
    return ts_utc.weekday() < 5 and (1 <= ts_utc.hour < 4 or 6 <= ts_utc.hour < 10)

def deepseek_cost(model: str, u: Usage, ts_utc) -> float:
    p = DEEPSEEK_PRICES[model]["peak" if deepseek_is_peak(ts_utc) else "off_peak"]
    miss = u.input_total - u.input_cached
    return (u.input_cached * p["hit"] + miss * p["miss"] + u.output * p["out"]) / 1_000_000
```

Which moment of a request (start or end) DeepSeek uses to assign it to peak is not stated in the documentation (checked in November 2026) — for an estimate in the README it doesn't matter, but a match with billing to the cent shouldn't be expected.

The same example as in the theory (step 1: 2000 input + 60 output, step 2: 2400 input + 120 output), on `deepseek-flash` off-peak, if on the second step 2000 prefix tokens hit the cache: `(2400 × 0.15 + 2000 × 0.003 + 180 × 0.60) / 1 000 000 ≈ $0.00047` — about 30 times cheaper than the made-up $3/$15. A cache hit is not guaranteed: DeepSeek describes the cache as best effort, so we log `input_cached` and look at the real share in `/stats`.

**Ollama:** `cost_usd = 0`, but a log record is still needed — for a local model the "cost" is time and memory. We log `latency_ms`, the tokens and the generation speed `eval_count / eval_duration × 1e9` (tokens per second), and in `/stats` we show the median and p95 response time per model. The first request after idle time includes `load_duration` — loading the model into memory; it has to be separated, otherwise the median lies.

### Comparison for this chapter

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Cost of a bot answer | count at its own prices (chapter 1.7) | at its own prices | fractions of a cent; peak/off-peak, automatic cache | $0, we pay with time |
| Cache fields | write and read separately | `cached_tokens` inside `prompt_tokens` | `prompt_cache_hit/miss_tokens` | none in money terms |
| What goes into the README | — (for comparison) | — | cost per answer on the **demo database** with the price date | median/p95 response time and the model, the hardware (CPU, amount of RAM) |
| Logs with personal data | — | — | never: DeepSeek sees only the demo | `logs/requests.jsonl`, local only |

### README: a "Models and privacy" section

For an employer this is a strong point — the author has thought about where the data goes. An example:

> The shop's database snapshot with customers' personal data is processed only by a local model via Ollama (`qwen3:4b-instruct-2507-q4_K_M`); the request never leaves the machine. Cloud models (DeepSeek) are connected only to the generated demo database; the bot refuses to start with a cloud provider and the snapshot (`assert_data_policy`). The provider is switched through environment variables; there is one codebase — an OpenAI-compatible client.

Plus two lines in "Cost and quality": DeepSeek on the demo (`$X` per answer, prices as of a date), Ollama (median N s, with the CPU and amount of RAM), and "N of 15" for both. A result like "12 of 15 on the database snapshot" can be given as a number, without the questions and answers themselves.

## Learning path

1. We open [Python: logging HOWTO](https://docs.python.org/3/howto/logging.html) → the Basic Tutorial and the beginning of the Advanced Tutorial (loggers, handlers, formatters) (≈30 min). What we take: `logging.getLogger(__name__)`, `log.exception` writes the traceback; for the request journal a separate JSONL file is simpler than a logging handler.
2. [Python: json](https://docs.python.org/3/library/json.html) → `json.dumps(..., ensure_ascii=False)` (≈5 min) — otherwise non-English question text (e.g. Russian) turns into `\u043a...`.
3. [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) → cache hit / cache miss / output prices, peak hours (≈10 min). We record the check date in `pricing.py`.
4. [DeepSeek: Context Caching](https://api-docs.deepseek.com/guides/kv_cache) and [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) → the `usage` fields (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `reasoning_tokens`), how the automatic cache works (≈15 min).
5. [Ollama: Chat API](https://docs.ollama.com/api/chat) → the response fields `prompt_eval_count`, `eval_count`, durations in nanoseconds, `load_duration` (≈10 min).
6. (For comparison) [Anthropic: Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) and [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) → prices and the usage fields for the cache (≈15 min). We compare: explicit `cache_control` in Anthropic's API versus DeepSeek's automatic cache.
7. [GitHub: Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) → Mermaid flowchart (≈10 min) — for the diagram in the README.
8. [GitHub: Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) → images, tables, code blocks (≈10 min).
9. The READMEs of 2–3 well-known projects (for example, [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook), [Instructor](https://github.com/instructor-ai/instructor)) → how their first screens are built: what is visible in 30 seconds (≈15 min).

## What to watch out for

- **The log contains questions and answers with data from the snapshot** — amounts, order numbers, sometimes customer names → `logs/` goes into `.gitignore`; the demo writes to a separate file.
- **We don't log secrets**: request headers, keys, whole client objects. We log usage and metadata, not "the whole `resp`".
- **The cost of only the last step** instead of the sum is a classic mistake: the figure in the README comes out 2–3 times lower than the real one.
- **`time.time()` for durations** can jump when the clock is synchronized; `perf_counter()` doesn't.
- **A failed log write breaks the answer** — a `try/except` around the write is needed.
- **`/stats` is available only to the owner** — it sits under the same router filter from AIL-15. It is worth checking that the command isn't attached to a separate router without the filter.
- **Outdated prices.** In six months the README will be wrong if the date and model aren't given.
- **A README that works only for the author**: absolute paths, a forgotten dependency, an implicit Python version, a "copy the shop database" step. The public README has no shop database at all — only `make_fake_db.py`.
- **Git history remembers everything.** Deleting a file in the latest commit is not enough.
- **Double-counting the cache.** In OpenAI and DeepSeek the cache is already inside `prompt_tokens`; in Anthropic it isn't. Adding `prompt_cache_hit_tokens` to `prompt_tokens` inflates the cost.
- **DeepSeek's off-peak price in the README.** If the measurement was taken off-peak, we say so: during the day (at peak) the same load costs twice as much.
- **Ollama's median with a cold start.** The first request after idle time includes loading the model; without a `cold_start` flag in the log, the time statistics mix two different modes.

## Practice

- [ ] **`bot/usage.py` and `bot/pricing.py`.** Usage normalization (DeepSeek, Ollama; Anthropic for comparison) and DeepSeek prices with peak/off-peak, the check date and source in a comment; for Ollama the cost is 0. Tests: the example from the "DeepSeek and Ollama" section gives ≈ $0.00047 off-peak and twice as much at peak (`pytest.approx`); `deepseek_is_peak` at the boundaries 01:00, 04:00, 06:00, 10:00 UTC and on a Saturday. *(For comparison)* `estimate_cost` for Claude with cache fields — the example from the theory gives $0.0159.
- [ ] **Ollama speed in the log.** For local requests we write `tokens_per_s` and a `cold_start` flag (from `load_duration` in the native API or by the first request after idle time).
- [ ] **`RequestTrace`** (a dataclass) and the JSONL write in `finally`, `ensure_ascii=False`. The path comes from `LOG_PATH`.
- [ ] **Checking the log.** We ask the bot 5 questions, then:
  ```bash
  tail -n 5 logs/requests.jsonl | python -m json.tool --json-lines
  ```
  We make sure every request has tools, tokens, `cost_usd`, `latency_ms`, `status`; a failed request (we rename the database file) is also recorded with `status: "error"`.
- [ ] **`/stats`.** `compute_stats(records, now, tz)` + a test on hand-written records (including a record with an error and a "yesterday" record); a breakdown by provider and model (money for DeepSeek, time for Ollama); the handler under the owner filter.
- [ ] **Demo.** `python scripts/make_fake_db.py --seed 42`, environment variables pointing to the demo files, `/start` shows "mode: DEMO" and the provider/model. We run `run_questions.py` on the demo database with DeepSeek and with Ollama, and record the "N/15" result and the cost/time for both.
- [ ] **A screenshot** of a dialog in demo mode (3–4 questions, including one refusal: "issue a refund for order 1042") → `docs/demo.png`. We check that it has no data from the snapshot, no customer names or contacts, no name or Telegram ID of ours.
- [ ] **The README** following the structure from the theory: a Mermaid diagram, the "Security" and "Models and privacy" sections, a quick start (with installing Ollama and the model tag; the `DEEPSEEK_API_KEY` option is for the demo only), the cost per answer on DeepSeek and the median time on Ollama from `/stats` on the demo, limitations.
- [ ] **A cleanliness check.** `git ls-files`, `git log --all --stat -- '*.db' '*.jsonl' '.env'`, `git grep` for tokens — all empty.
- [ ] **The "outsider" test.** We clone the repository into a new temporary folder, create a new environment and follow the README word for word: installation → `.env` → demo database → `pytest` → running the bot. Every place where we had to think or know something not in the README gets fixed in the README.
- [ ] **Push** and switch the repository to public (if it was private). We enable secret scanning / push protection in the repository settings.

## Done when

- Every request is written to the log: question, tools, tokens, cost (the sum over steps), response time, status — including failed ones.
- `/stats` shows the number of requests and the money spent (total and today), the average cost, the response time.
- The README: what it does, architecture, security, models and privacy, how to run it, a screenshot of a dialog, the average cost per answer (DeepSeek, with the price date) and the response time (Ollama, with the model and hardware).
- `/stats` and the log count DeepSeek usage correctly (the cache isn't double-counted, peak/off-peak) and Ollama's time.
- The demo works on the generated database; the repository and its history contain no database snapshot, no customers' personal data and no secrets.
- An outsider can run the project from the README — checked with a clean clone.

## Self-check quiz

1. A request went through 3 steps of the loop. How is its cost calculated?
   a) from the usage of the last step; b) from the usage of the first step × 3; c) as the sum of the costs of all steps, accounting for cache tokens; d) from the length of the answer.
2. Why is JSONL convenient for a request journal?
3. What is wrong with this code?
   ```python
   start = time.time()
   result = await answer(q, hist)
   log_file.write(json.dumps({"q": q, "cost": result.cost,
                              "ms": (time.time() - start) * 1000}))
   ```
4. Why is it better to write the log record in `finally`?
5. Where should the request journal be stored?
   a) in a new table of the `shop.db` snapshot; b) in a separate file `logs/requests.jsonl` or `logs/requests.db`; c) in the README; d) in the Telegram history.
6. Why is the cost per answer on the demo database an honest estimate for the README?
7. The file `data/shop.db` was removed from the repository in a separate commit. Can the repository be made public?
8. Why give the date and model next to the "average cost per answer"?
9. Why are the median/p95 of response time useful in the statistics, and not just the mean?
10. What three things need to be checked on a screenshot for the README?
11. How is the "an outsider can run the project" criterion checked?
12. What is wrong with this cost formula for DeepSeek?
    ```python
    cost = ((u.prompt_tokens + u.prompt_cache_hit_tokens) * 0.15
            + u.completion_tokens * 0.60) / 1_000_000
    ```
13. Why does a bot on Ollama still need a request journal if `cost_usd` is always 0? What matters most in it?
14. Which provider may appear in the README's "Cost and quality" section with figures from the shop's database snapshot, and which only with figures from the demo database?

## Answers

1. **c.** Each step pays for the whole context again; cache tokens are billed separately.
2. It is appended line by line, a process crash corrupts at most the last line, and it is easy to read line by line with Python, `jq`, pandas.
3. `time.time()` instead of `perf_counter()`; no newline — the records stick together into one line; `json.dumps` without `ensure_ascii=False`; tools, tokens and status are not recorded; if `answer` raises an exception, nothing is written (no `finally`).
4. Then requests that failed with an exception get into the log too — and they are exactly the ones most needed for debugging and error statistics.
5. **b.** The shop's database snapshot is opened read-only and must stay that way; the journal is a separate file.
6. The cost is determined by the context size (system prompt, schemas, history, compact results) and the number of steps, not by the specific figures in the orders; the data structure is the same.
7. No: the file with customers' personal data stays in the git history. The history has to be rewritten or, more simply, a new repository with a clean history created.
8. Prices and models change; without the date and model, the figure becomes misleading in a few months.
9. Rare long requests (retries, timeouts) shift the mean a lot; the median shows the typical experience, p95 how often things go badly.
10. Demo mode is on and the data is generated; there is no name or Telegram ID of the owner, no customer names or contacts, no figures from the snapshot; no tokens, paths or other technical secrets in the frame.
11. Clone into a clean folder, create a new environment, follow the README word for word until the bot runs and `pytest` is green; fix everything that required knowledge outside the README.
12. `prompt_tokens` already includes the cache hits, so they are counted twice; cached tokens should be billed at the hit price, and only `prompt_tokens − prompt_cache_hit_tokens` at the miss price; the prices are hardcoded as numbers with no date and without accounting for peak (twice as expensive during the day).
13. For a local model the "cost" is time and memory: the journal gives the median and p95 of response time, generation speed, cold starts, errors and the tools called — and it is still the basis for evals.
14. Only Ollama works with the database snapshot — its "N of 15" result on the snapshot can be given as a number (without the data itself). DeepSeek never sees the snapshot; its figures come only from the demo database.

## What's next

Project 1 is done. Next is the "RAG and embeddings" stage: chapter 4.1 · Embeddings by hand with numpy (AIL-18) starts the path to Project 2 — an assistant over the shop's knowledge base (delivery, returns and warranty rules, product manuals), where the request log and the question-running script from this week turn into real evals.
