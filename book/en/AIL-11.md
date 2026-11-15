# 2.7 · Streaming, retries, rate limits, prompt caching  (AIL-11)

> **Week 2** · LLM basics · ⏱ ~4–5 h · Theory, Practice

<!-- description: Production LLM calls: retries with backoff and jitter, timeouts, rate limits, prompt caching, Batch API and streaming in one wrapper. -->
<!-- source-sha256: 89b10e6475e9 -->

## Why an AI engineer needs this

Over two weeks we have piled up a bunch of scripts: `chat.py` and `cost.py`, the review classifier, `extract()`, `compare.py`, the tool loop. Each has its own model call, and they all share the same weaknesses. The script from chapter 1.6 crashes on the first 429, hangs for 10 minutes on a stuck connection and pays full price for the same system prompt in every request. A service can't behave like that. Retries with backoff, timeouts, rate-limit awareness, prompt caching and batching are what separate a "quick-and-dirty prototype" from production; interviews ask "what do you retry and how", "how did you cut costs" and "how does prompt caching work". In this chapter we put all of this into one mini-library, `llm_utils.py`, which every model call in the rest of the course goes through.

## Theory

### What errors happen and what to do with them

Let's start with what can go wrong. A retry is an automatic repeat of a failed request; it only helps with transient errors. We split API response codes into two groups (type names follow the Anthropic documentation; other providers use the same or similar codes):

| Code | Type (Anthropic) | Meaning | Retry? |
|---|---|---|---|
| 400 | `invalid_request_error` | A mistake in the request: a parameter, the format, a prompt that is too long | **No** — a repeat gives the same result |
| 401 / 403 | `authentication_error` / `permission_error` | Invalid key / no access | No |
| 402 | `billing_error` | A billing problem | No |
| 404 | `not_found_error` | Wrong path or model name | No |
| 413 | `request_too_large` | The request body is too large | No |
| 429 | `rate_limit_error` | Request/token limit exceeded | **Yes**, after a pause (respecting `retry-after`) |
| 500 | `api_error` | Internal provider error | Yes |
| 529 | `overloaded_error` | The provider is overloaded | Yes, with a longer pause |
| — | timeout, dropped connection | Network | Yes (with a caveat about duplicates, see below) |

The rule in one line: **4xx is our mistake, 429/5xx/network is transient.** OpenAI has a special case: 429 comes in two kinds — a rate limit (retry) and `insufficient_quota` (out of money — don't retry; the error body tells them apart).

### Exponential backoff with jitter

We retry a transient error, but not immediately. Backoff is a pause before the repeat that grows with each attempt; jitter is a random addition to it. Why randomness: if 1000 clients get a 429 at the same moment and all retry after exactly 1 second, they hit the API at the same moment again (a "thundering herd"). The solution:

```
delay = random(0, min(cap, base * 2^attempt))      # "full jitter"
attempt 0: 0..1 s   attempt 1: 0..2 s   attempt 2: 0..4 s   ... no more than cap
```

If the server sent a `retry-after` header, we respect it (it knows better).

```python
import random, time

def backoff_delay(attempt: int, base: float = 1.0, cap: float = 30.0,
                  retry_after: float | None = None) -> float:
    if retry_after is not None:
        return retry_after
    return random.uniform(0, min(cap, base * 2 ** attempt))
```

### The SDK already retries — don't double it

Before writing our own retry loop, it is worth knowing that one already exists. The official Anthropic and OpenAI SDKs **retry on their own** network errors, 408/409/429 and 5xx (2 retries by default) with an exponential pause and respect for `retry-after`. That leaves two correct options:

1. Trust the SDK: set `max_retries` and `timeout` on the client; our wrapper only logs and counts money.
2. Turn off SDK retries (`max_retries=0`) and retry ourselves (for example, with the `tenacity` library) — when we need our own policy (different pauses, switching to a fallback model, per-attempt metrics).

The mistake is doing both: 3 of our attempts × 3 SDK attempts = up to 9 requests, and the pauses add up.

### Timeouts

A retry fires when a request finishes with an error. But a request may never finish — then a timeout cuts it off. The SDK default timeout is minutes (10 minutes in the Anthropic Python SDK). For an interactive bot that is an eternity. We set the timeout for the task: short for short answers, and long generations go through streaming (the connection stays alive while tokens arrive). Important: a timeout is retried too, so the total time can reach `timeout × (max_retries + 1)`.

### Retries and side effects

Repeating a model request is safe (at worst we pay twice). But in an agent with tools (AIL-10) we repeat the **model call**, not tool actions that have already run. If a tool does something irreversible, repeating the loop can do it twice — one more reason to keep such tools outside the LLM.

### Rate limits

The most common transient error is 429, a limit exceeded. To avoid getting it all the time, we need to understand how limits work. Providers limit an account along several axes at once: requests per minute (RPM), input tokens per minute (ITPM), output tokens per minute (OTPM), sometimes daily limits. Limits depend on the account level (tier) and grow as spending grows. Responses carry headers with the remaining quota (Anthropic's `anthropic-ratelimit-*` family, OpenAI's `x-ratelimit-*`) and `retry-after` on a 429.

How to live with limits:
- limit concurrency (a semaphore: no more than N requests at once — `asyncio.Semaphore`, the counterpart of `p-limit` in Node or a worker pool in other languages);
- for bulk background jobs, the Batch API (below);
- Anthropic's prompt cache reduces the counted input tokens (tokens read from the cache in most cases don't count toward ITPM — worth checking in the rate-limits documentation);
- a 429 at startup is normal; a constant 429 is a signal to rethink the architecture or move up a tier.

### Prompt caching

Retries and limits take care of reliability; next comes money and speed. We have already met the cache: in chapter 1.6 we watched `prompt_cache_hit_tokens` grow at DeepSeek, and in chapter 1.7 we calculated the price of a hit. Now we take the mechanism apart. The idea: if the beginning of a request (the system prompt, documentation, tools, a long history) repeats, the provider can store its computed internal state and not process it again. We pay less and get the answer faster (lower TTFT).

```
request 1:  [tools][system: 20K tokens of docs][question 1]
             └──────── cache write ───────┘
request 2:  [tools][system: the same 20K tokens][question 2]
             └──────── cache read ────────┘  ← ~10% of the price, faster
```

How it works at Anthropic:

- **The cache is a prefix match.** A request is assembled in the order `tools` → `system` → `messages`. Any changed byte in the prefix invalidates everything after it.
- We mark the boundary with `cache_control: {"type": "ephemeral"}` on a block (up to 4 breakpoints) or put it at the top level of the request — then caching happens automatically up to the last eligible block.
- **Price**: a cache write costs more than regular input (about ×1.25 with a 5-minute TTL), a read about ×0.1. The cache pays off if the prefix is reused at least a couple of times within its lifetime.
- **TTL** is 5 minutes by default (refreshed on every hit); there is a 1-hour option with a more expensive write.
- **The minimum length** of a cacheable prefix depends on the model (from hundreds to a few thousand tokens). If it is shorter, caching silently doesn't happen, with no error.
- **Checking** is possible only through `usage`: `cache_creation_input_tokens` (written), `cache_read_input_tokens` (read), `input_tokens` (regular). If `cache_read_input_tokens` is always 0, something breaks the prefix.

```python
resp = client.messages.create(
    model=MODEL,
    max_tokens=1024,
    system=[
        {"type": "text", "text": "You answer questions about the shop's delivery and return rules."},
        {"type": "text", "text": DOCS_TEXT, "cache_control": {"type": "ephemeral"}},
    ],
    messages=[{"role": "user", "content": question}],
)
u = resp.usage
print(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens)
```

**Silent cache killers**: `datetime.now()` or a UUID in the system prompt; JSON serialized with a different key order; tools in a different order; switching models (the cache is tied to the model); editing the beginning of the history. The rule: **stable content first, changing content last**.

At OpenAI, prefix caching is **automatic** for long enough prompts (a threshold of about a thousand tokens), with no markup; the cached part shows up in the `usage` details (`cached_tokens`) and is billed at a discount. The "stable first" principle is the same.

### Batch API

The second way to save is for jobs where the answer isn't needed right away (dataset labeling, overnight analysis, evals): providers offer a Batch API — we send a batch of requests, and results arrive asynchronously (usually within 24 hours, often sooner) at roughly **half the price**. Results arrive in arbitrary order, so we match them by our own `custom_id`, not by position. Caching and batching can be combined.

### Streaming in the wrapper

The last piece of the puzzle is streaming from chapter 1.6. It complicates retries: if the error happens **before the first token**, we retry as usual; if it happens **mid-answer** and the text has already been shown to the user, a transparent retry is impossible — we either start the answer over (and warn about it) or return the error. Usage and `stop_reason` arrive at the end of the stream, so we log them after it finishes.

### The `llm_utils.py` skeleton

Everything above comes together in one module. Every later script and project calls the model only through it, so retries, timeouts, cache accounting and cost are written once:

```
llm_utils.py
  PROVIDERS                          ← base_url and the key variable, as in chapter 2.4
  PRICES, estimate_cost()            ← from chapter 1.7
  @dataclass CallResult              ← text, content blocks, usage, cost, latency, stop_reason, attempts
  call_llm(messages, *, provider, system, model, max_tokens, tools=None,
           cache_system=False, timeout=60, max_retries=3) -> CallResult
  stream_llm(...) -> Iterator[str] + a final CallResult
  log_call(...)                      ← JSONL: time, model, tokens (incl. cache), cost, latency, attempts, error
  is_retryable(exc) -> bool
```

### For comparison: other languages

We write this wrapper ourselves to understand the mechanics; in other ecosystems it is often taken off the shelf. [Vercel AI SDK](https://ai-sdk.dev) is a popular library in the JavaScript ecosystem with a single interface to different providers (`generateText`, `streamText`, `generateObject` with a Zod schema, tools, built-in retries). It comes in handy if the web interface to an LLM is written in JavaScript. It is useful to see that under the hood it has the same concepts: roles, streaming, the tool loop, schemas, retries with backoff.

## DeepSeek and Ollama: how we do it

Everything above uses Claude and OpenAI as examples. For DeepSeek and Ollama we use the `openai` package, so **retries, timeouts and exception classes are the same as in the OpenAI SDK** (`openai.APIConnectionError`, `APITimeoutError`, `RateLimitError`, `APIStatusError` with `status_code`; 2 retries by default). What differs is the error codes, the nature of the limits and, most of all, the cache.

### DeepSeek errors and what to retry

According to the [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes) page (November 13, 2026):

| Code | Meaning at DeepSeek | Retry? |
|---|---|---|
| 400 | invalid body format (including a missing `reasoning_content` with tools, a forced `tool_choice` in thinking mode) | no |
| 401 | invalid key | no |
| 402 | **balance exhausted** | no — top up (the counterpart of OpenAI's `insufficient_quota`, but with its own code) |
| 422 | invalid parameters | no |
| 429 | concurrency / rate limit exceeded | yes, with backoff |
| 500 | server error | yes |
| 503 | server overloaded | yes, with a longer pause (the counterpart of Anthropic's 529) |
| 408 / 413 / 504 | file uploads, OCR, etc. | 408/504 — yes, 413 — no |

Ollama is a different world: `APIConnectionError` most often means "the server isn't running" (retries won't help — the app has to be started), 404 means the model isn't downloaded (`ollama pull`), and 500 crashes on a local machine can come from running out of memory. With 8 GB of RAM this is a real scenario if the model is larger than the 3–4B class or `num_ctx` is large; with 16 GB the same limit hits on models larger than 7–8B.

### Limits: concurrency, not RPM

DeepSeek's limit is **the number of concurrent requests per account** (per [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit): 2500 for `deepseek-flash`, 500 for `deepseek-v4-pro`), not tiered RPM/TPM as at Anthropic and OpenAI. The documentation describes no headers with remaining quota and no `retry-after`, so our `backoff_delay` works without a hint from the server. A semaphore is still needed: 4–8 concurrent requests are enough for study.

An important quirk under load: if inference hasn't started yet, DeepSeek **holds the connection for up to 10 minutes**, sending empty lines (without streaming) or `: keep-alive` SSE comments (with streaming). HTTP clients usually count the read timeout from the last byte received — and bytes keep arriving, so a "30-second timeout" may never fire. For an interactive scenario we set an overall deadline for the whole call (for example, `asyncio.wait_for` around the request) and check it against the wall clock.

Ollama has no limits, but **by default a model handles one request at a time** (`OLLAMA_NUM_PARALLEL`); the rest wait in a queue, and each additional parallel slot needs memory for its own context. With 8 GB: a semaphore of 1–2 and no `gather` over a hundred requests.

### DeepSeek's cache: automatic and with no surcharge

According to the [Context Caching](https://api-docs.deepseek.com/guides/kv_cache) guide:

- **On for everyone, no markup needed** — `cache_control` doesn't exist (through the Anthropic-compatible endpoint it is simply ignored).
- The cache is a **prefix** match; "units" are cached at message boundaries and at fixed intervals in long texts. A shared prefix starts hitting after the system has seen it in several requests (in the documentation's example, the first two requests miss and the third hits).
- It lives from a few hours to a few days, best effort — 100% hits are not guaranteed.
- In `usage`: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (and `prompt_tokens_details.cached_tokens`).
- **No surcharge for writes** — a miss costs the same as regular input, a hit is about 50 times cheaper (chapter 1.7). So the question "can the cache cost more" doesn't arise at DeepSeek, but it does at Anthropic.

The "stable first, changing last" rule and the list of silent cache killers apply one to one.

### Ollama's cache: speed, not money

Ollama's native response contains `prompt_eval_cached_count` — how many prompt tokens were taken from already computed state while the model is in memory. This saves no money (there is none to save) but saves seconds: on an ordinary laptop, processing a long prompt is a noticeable share of the time. Unloading the model (`keep_alive`, 5 minutes of idle by default) resets this too.

### Batch: DeepSeek doesn't have it — it has an off-peak rate

There is no Batch API in DeepSeek's documentation. The equivalent in spirit for background jobs is **running them outside peak hours** (a 50% discount, chapter 1.7): dataset labeling, evals, overnight runs. This needs not a new API but a scheduler and a UTC time check before starting.

### Comparison

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| SDK retries | `anthropic`, 2 by default | `openai`, 2 by default | same as `openai` | same as `openai` (or its own in `ollama`) |
| Overload | 529 | 5xx | 503 | — (locally: OOM / slow) |
| Out of money | 402 `billing_error` | 429 `insufficient_quota` | 402 | — |
| Limits | RPM/ITPM/OTPM by tier, headers | RPM/TPM by tier, headers | concurrency per account, headers not documented | 1 request per model by default, memory |
| Cache | manual `cache_control` markup, write ×1.25, read ×0.1, TTL 5 min / 1 h | automatic | automatic, no surcharge, hours to days, best effort | `prompt_eval_cached_count`, while the model is loaded |
| Cache fields | `cache_creation_input_tokens`, `cache_read_input_tokens` | `cached_tokens` | `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` | `prompt_eval_cached_count` |
| Batch | −50% | −50% | none; −50% off-peak | — |
| Timeout quirks | — | — | keep-alive for up to 10 min, the read timeout may not fire | the first request loads the model |

### What to use for practice

- **`llm_utils.py`** — with `deepseek` and `ollama` as the main providers (one codebase on the `openai` SDK, different `base_url`, prices and cache fields); `openrouter` from chapter 2.4 is added as one more line in `PROVIDERS`; `anthropic` is an optional branch for comparison.
- **The cache experiment** runs on DeepSeek (the cache is automatic, we only watch `usage`); the experiment with manual `cache_control` markup runs on Claude, for comparison.
- The long text for the cache is public: Shelf's delivery, return and warranty rules (they can be generated by a model) or the public documentation of any API. Customers' personal data, work code and anything that must not be shown to outsiders never go to cloud models.

## Learning path

1. [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) (≈45 min). We read: how the prefix works, where to put `cache_control`, what a write and a read cost, TTL, minimum length per model, what invalidates the cache, how to read `usage`. We write down: the minimum-length table for the chosen model and the list of invalidators.
2. The Anthropic errors page ([docs.anthropic.com/en/api/errors](https://docs.anthropic.com/en/api/errors)) and the rate limits page ([docs.anthropic.com/en/api/rate-limits](https://docs.anthropic.com/en/api/rate-limits)) (≈30 min). We write down: error codes and types, the limit axes, response headers, how the cache affects input-token accounting.
3. The AWS article "Exponential Backoff And Jitter" ([aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)) (≈15 min). We write down: why jitter, how "full jitter" differs from the other variants.
4. Batch API (≈20 min): [Anthropic: Batch processing](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing) and [OpenAI: Batch](https://platform.openai.com/docs/guides/batch). We write down: the discount, the turnaround, the `custom_id` format, the fact that results arrive in any order.
5. OpenAI for comparison (≈15 min): [Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) and [Rate limits](https://platform.openai.com/docs/guides/rate-limits). We note: the cache is automatic, a 429 can be a "quota" error.
6. The Anthropic Python SDK README on GitHub ([anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python)) → the Retries, Timeouts, Handling errors sections (≈15 min). We write down: `max_retries`, `timeout`, exception classes.
7. (Comparison with the JavaScript ecosystem) [Vercel AI SDK](https://ai-sdk.dev) → Getting Started and the page on `streamText` / `generateObject` (≈20 min).
8. DeepSeek (≈30 min): [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes), [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit) (concurrency, keep-alive, 10 minutes), [Context Caching](https://api-docs.deepseek.com/guides/kv_cache) (how the cache is built and how long it lives, the `usage` fields). We write down: a "retry / don't retry" table by code and the rules for cache hits.
9. Ollama (≈15 min): [FAQ](https://docs.ollama.com/faq) — `keep_alive`, `OLLAMA_NUM_PARALLEL`, memory; in the [Chat API](https://docs.ollama.com/api/chat) — the `prompt_eval_cached_count` field and the durations.
10. The OpenAI Python SDK README on GitHub ([openai-python](https://github.com/openai/openai-python)) → Retries, Timeouts, Handling errors (≈10 min): this is the SDK we use with DeepSeek and Ollama.
11. Practice (≈2 h).

## What to watch out for

- **We don't retry 400s.** It is a mistake in the request; a repeat won't help and only burns the limit. 400s caused by API changes are especially treacherous (removed parameters, prefill, a forced `tool_choice` on new models).
- **Double retries** (the SDK's + our own) multiply attempts and delays.
- **DeepSeek 402 — don't retry**, it means an empty balance. And don't confuse it with 429: at DeepSeek, 429 is about concurrency, not money.
- **Ollama with 8 GB:** parallel requests and a large `num_ctx` eat memory the model shares with the browser, the IDE and other programs. A semaphore of 1–2 and a modest context.
- **A cache that doesn't cache**: a prompt shorter than the minimum, `datetime.now()` in the system prompt, a model switch. We check `cache_read_input_tokens`, not our faith.
- **The cache can cost more**: if the prefix is used once per TTL, we pay the write surcharge and get no reads.
- **Timeout × retries** = the real maximum wait time. It is worth calculating for an interactive scenario.
- **Cost logs** include cache tokens at their own prices; otherwise `estimate_cost` lies.
- **Keys** come only from the environment and never appear in logs (`log_call` doesn't write headers).
- **Unbounded concurrency** (`asyncio.gather` over 500 requests) = a guaranteed storm of 429s.

## Practice

Everything goes into `common/llm_utils.py` (we will import it in all the following projects) and `exercises/week-02/reliability/`.

- [ ] **1. `is_retryable(exc)`.** The core is the exceptions of the `openai` package (we reach DeepSeek and Ollama through it): `openai.APIConnectionError` / `APITimeoutError` → yes; `openai.APIStatusError` → by `exc.status_code` (429, 500, 502, 503, 504 → yes; 400, 401, 402, 422 → no; 429 with the `insufficient_quota` code from the real OpenAI → no). For `anthropic` (optional) — likewise, plus 529 → yes. We cover it with tests on fake exceptions.
- [ ] **2. `call_llm()`.** A `provider` parameter (`deepseek` | `ollama` | optionally `anthropic`). A client with `max_retries=0`, our own retry loop with `backoff_delay` (respecting `retry-after` from `exc.response.headers`, if present), a timeout, an attempt counter. It returns a `CallResult` with the cost from `estimate_cost` (including cache tokens). Every call (and every failed attempt) is a line in `logs/llm_calls.jsonl`. For DeepSeek we add an overall deadline per call (because of keep-alive), for Ollama a semaphore of 1–2 concurrent requests.
- [ ] **3. Testing retries without a real API.** We replace the send function with a fake that raises 503 the first 2 times (DeepSeek overload; 529 for the `anthropic` branch) and then answers. We check: 3 attempts, growing pauses, everything visible in the log. A second fake raises 400 — we check that there is no retry.
- [ ] **4. Prompt caching on DeepSeek.** We take a long public text of at least several thousand tokens — for example, Shelf's delivery, return and warranty rules, generated by a model and saved to a file. We make 6 requests in a row with different questions ("How much is delivery to another city?", "Can I return opened tea?"), with the document at the start of `system`. For each we record `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens`, latency, cost. Expected: the first requests miss, then the prefix starts hitting (the cache is built within seconds and is best effort — if there are no hits, we pause and repeat). We compare the input cost of the first and the last request.
- [ ] **4b. (For comparison) Prompt caching with Claude.** The same experiment with `cache_control`: (a) without it, (b) with it; we record `cache_creation_input_tokens`, `cache_read_input_tokens`. We compare the billing models: Anthropic's write surcharge versus its absence at DeepSeek.
- [ ] **4c. Ollama.** The same document (with a `num_ctx` it fits into without overloading memory) twice in a row through the native API: we record `prompt_eval_cached_count` and `prompt_eval_duration`. Then we unload the model (`keep_alive=0`) and repeat — what happened to the cache and the time?
- [ ] **5. Break the cache.** In the step 4 experiment we add `f"Current time: {datetime.now()}"` at the start of the system prompt. We show that DeepSeek's `prompt_cache_hit_tokens` (and Claude's `cache_read_input_tokens`, if we compare) dropped almost to 0. We move the time to the end of the user message — the cache works again.
- [ ] **6. `stream_llm()`.** A streaming version: it retries only before the first token; after that it re-raises the error. On completion, the same log with usage and cost.
- [ ] **7. Table.** In `notes/reliability.md`:
  ```
  | provider / variant | requests | input (miss) | cache write | cache read (hit) | $ total | avg latency, s |
  | DeepSeek, stable prefix       | 6 | ... |
  | DeepSeek, time at the start   | 6 | ... |
  | Ollama (cached_count, time)   | 2 | ... |
  | (Claude without / with cache) | 6 | ... |
  ```
  and 3–4 conclusions: when the cache pays off, what breaks it, what to retry, which timeout was chosen for the chat and why.
- [ ] **8. Off-peak rate instead of batch.** We add an `is_offpeak(now_utc) -> bool` function to `llm_utils.py` following DeepSeek's rules and run the classification of 20 texts from chapter 2.1 off-peak. We compare the cost with a run at peak time (through `estimate_cost`).
- [ ] **8b. (Optional, for comparison) Batch.** The same classification through the Anthropic or OpenAI Batch API, matched by `custom_id`.

## Done when

- `llm_utils.py` contains `call_llm()` for DeepSeek and Ollama (retries with backoff and jitter, timeout/deadline, logging of tokens, cache fields and cost) and `stream_llm()`; retries are covered by tests on fakes, and 402 and 400 are not retried.
- There is a cache table (DeepSeek, Ollama and, optionally, Claude) by cost and time, and a demonstration of how the cache breaks.
- We can explain which errors to retry and which not, and why our own retries shouldn't be combined with the SDK's.

## Self-check quiz

1. Which of these responses are worth retrying: 400, 401, 429, 500, 529, a connection timeout?
2. Why is random jitter added to exponential backoff?
3. What is wrong with this code?
   ```python
   client = anthropic.Anthropic()            # default retries
   for attempt in range(5):
       try:
           return client.messages.create(**params)
       except Exception:
           time.sleep(1)
   ```
4. How does prompt caching work at Anthropic: what exactly is cached and what invalidates it?
5. The first line of the system prompt is `Today is {datetime.now().isoformat()}`, followed by 30K tokens of documentation with `cache_control`. Why is `cache_read_input_tokens` always 0, and how is it fixed?
6. When can prompt caching *increase* the cost?
   a) when the prefix is used many times within 5 minutes; b) when the prefix is used once within the cache lifetime; c) when the requests are short; d) never
7. What makes the Batch API worthwhile, and what jobs is it unsuitable for?
8. A 429 error from OpenAI with the code `insufficient_quota`. Retry?
9. A stream broke off mid-answer, and the user already sees half the text. Why can't the request "just be repeated" transparently, and what should be done?
10. The default timeout is 10 minutes, `max_retries=2`. What is the longest the user may wait in the worst case, and what should a chat bot do about it?
11. Why must Batch API results be matched by `custom_id` rather than by order?
12. DeepSeek returned 402. Retry? And 503?
13. How does prompt caching at DeepSeek differ from Anthropic's? Can it increase the cost at DeepSeek?
    a) the same way, `cache_control` is needed; b) automatic, no write surcharge — it can't increase the cost, but a hit is not guaranteed; c) there is no cache; d) the cache works only in batch
14. A DeepSeek client has `timeout=30`, yet a request at peak hour hung for 8 minutes. How is that possible, and what should be done?

## Answers

1. 429, 500, 529 and the timeout — yes (transient). 400 and 401 — no: it is a mistake in the request or the key, and a repeat gives the same result.
2. So that clients that got an error at the same moment don't retry in sync and create a new wave of overload.
3. Everything is retried, including 400/401; the pause is constant, with no exponent or jitter; `retry-after` is ignored; SDK retries aren't turned off (attempts multiply); the last error is swallowed — the function returns `None`; there is no logging.
4. The request prefix (`tools` → `system` → `messages`) up to the `cache_control` point is cached; on the next request with a byte-for-byte identical prefix it is read from the cache. Any change in the prefix (or a model switch, or TTL expiry) invalidates the cache from the point of the change.
5. The time changes on every request and sits at the start of the prefix — everything after it, including the documentation, never matches. Move the changing part (the time) after the cached part, for example into the user message.
6. **b.** A cache write costs more than regular input; without subsequent reads it is pure overpayment.
7. It is about half the price and doesn't consume the regular limits the way synchronous requests do; it is unsuitable for interactive jobs where the answer is needed right away (the result may arrive hours later).
8. No: the quota/billing is exhausted, it is not a temporary limit; a repeat won't help.
9. A repeat generates different text (not a continuation), and the user sees two answers glued together. Either show the error and offer to retry, or explicitly start the answer over, clearing the output.
10. Up to ~30 minutes (10 min × 3 attempts) plus pauses. In a chat bot: a short timeout matched to the expected answer length, streaming, a limited number of retries and a clear error message.
11. The batch is processed asynchronously, and results arrive in arbitrary order; `custom_id` is the only reliable link between a request and its response.
12. 402 — no: the balance is exhausted, a repeat won't help, a top-up is needed. 503 — yes: the server is overloaded, retry with backoff and a longer pause.
13. **b.** The prefix cache is always on, a miss costs the same as regular input, a hit is dozens of times cheaper; but it is best effort, and hits don't start from the first request.
14. Under load DeepSeek holds the connection for up to 10 minutes, sending keep-alives (empty lines/SSE comments), and the read timeout counts from the last byte, so it never fires. What is needed is an overall deadline per call (`asyncio.wait_for` or a wall-clock check) and a clear message to the user.

## What's next

The LLM basics are done: we have our own API layer, prompting, structured output, a first eval and tool calling. Next is [3.1 · Project 1: LLM bot architecture and a database copy (AIL-13)](AIL-13.md): the first project is built on `llm_utils.py`, and `eval_extract.py` comes back at the evals stage — we keep both tidy and in git.
