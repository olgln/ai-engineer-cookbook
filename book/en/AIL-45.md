# 10.2 · Prompt caching, budgets, fallbacks  (AIL-45)

> **Week 10** · Production · ⏱ ~4 h · Practice

<!-- description: How to cut LLM costs and survive a provider outage: prompt caching, a semantic cache, fallbacks, LiteLLM, and per-answer and daily budgets. -->
<!-- source-sha256: 3a6855edbac0 -->

## Why an AI engineer needs this

In chapter 10.1 the support assistant learned to start with a single command; now it also has to not bankrupt its owner and not go down together with the provider. The LLM bill grows linearly with traffic, and providers regularly answer 429 and 529 (overloaded, at Anthropic). A service that simply crashes in those minutes, or burns a month's budget overnight because of an agent stuck in a loop, is not allowed into production. Interviews ask exactly this: "how did you cut costs?", "what happens if Anthropic is down?", "how do you avoid a $5000 bill?" — and they expect numbers and mechanisms, not "well, we kept an eye on it".

## Theory

### Where the cost of a request comes from

In chapter 1.7 · Tokens, temperature and the cost of an LLM request (AIL-5) we computed cost as `input_tokens × price_input + output_tokens × price_output` (the `estimate_cost` function). For the Shelf shop support assistant from project 2, a single answer usually breaks down like this:

```
request to the model ≈ 8k input tokens
 ├─ system prompt + citation rules          ~1.5k  always the same
 ├─ few-shot examples                       ~1k    always the same
 ├─ standing kb/ sections (optional)        ~2.5k  the same until kb/ changes
 ├─ retrieved chunks (top-5)                ~3k    different for every question
 └─ customer question                       ~50    different
answer ≈ 300 output tokens (several times more expensive per token)
```

That gives us three levers: **don't pay again for the same thing** (prompt caching), **don't make the request at all** (an answer cache), **pay less per token** (a cheaper model where it is good enough — this is decided by evals, as in chapter 7.3). Plus two protection mechanisms: **fallbacks** — switching to a backup provider when the main one is down — and a **budget** — a spending limit for when something goes wrong. The chapter follows this order: first the two kinds of cache, then fallbacks, then the budget.

### Prompt caching: a recap of chapter 2.7 and applying it to RAG

The first lever is prompt caching: the provider remembers the processed beginning of the prompt and charges less for it on repeat. We covered the mechanics in chapter 2.7 · Streaming, retries, rate limits, prompt caching (AIL-11); the key points in brief:

- What gets cached is the request **prefix**. At Anthropic the prefix order is `tools` → `system` → `messages`. A change at any level invalidates it and everything after it.
- At Anthropic the cache is enabled explicitly: `cache_control: {"type": "ephemeral"}` on a block (up to 4 breakpoints) or an automatic mode with a single top-level field. A cache write costs more than regular input (1.25× for the 5-minute TTL, 2× for the 1-hour one), a read is many times cheaper (0.1× as standard, even less on some newer models). There is a **minimum length** for the cached prefix, which differs between models — from hundreds to several thousand tokens. Below it, the cache silently does not kick in, with no error. Check the exact multipliers and thresholds against the documentation on the day you work.
- At OpenAI, prefix caching is automatic for long enough prompts; how much hit the cache is in `usage.prompt_tokens_details.cached_tokens`.
- Verify a cache hit only through `usage`: `cache_creation_input_tokens` and `cache_read_input_tokens` at Anthropic. If both are zero, there was no caching.

**The main point for RAG:** the cache works only on an identical prefix, and every question has its own chunks. So the prompt has to be **ordered** so that everything unchanging comes first and everything that changes comes last:

```
[tools]                          ─┐
[system: role, rules]             │  stable prefix → cache_control here
[few-shot examples]               │
[standing kb/ sections]          ─┘
[retrieved chunks <documents>]   ─┐  changes every time
[customer question]              ─┘
```

A typical mistake that zeroes out the cache: the current date and time ("It is now 2026-11-26 14:03:17"), a request id or the customer's name substituted into the system prompt. The prefix changes every second — the cache is never read, but it is written every time at the higher price. Dynamic parts go at the end.

If the stable prefix is shorter than the minimum threshold, the cache gives nothing in RAG. That is a normal experiment result, and it should be recorded as such. Where the cache gives a lot: long instructions, a big "cheat sheet" needed in almost every answer, multi-turn dialogs in the support Telegram bot (the whole history is the prefix of the next turn), the agent loop from chapter 8.3 (every iteration repeats the whole tool history).

For the support assistant such a "cheat sheet" comes naturally: delivery and returns are the most frequent questions, so the current `kb/delivery.md` and `kb/returns.md` can go into the prefix in full. Conditions: only current pages (the archived `kb/returns-2025.md` — never); the prefix is rebuilt on re-indexing (otherwise the assistant cites old rules); the standing sections are formatted as the same `<document>` blocks with `kb/<file>.md#<anchor>` and always get numbers `[1]`…`[m]`, retrieved chunks are numbered after them, and duplicates from the search results are removed.

An illustrative example (Anthropic SDK; check the model and parameter details against the current documentation):

```python
import anthropic

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

STABLE_KB = ["kb/delivery.md", "kb/returns.md"]  # current pages only, never archived
# rules + few-shot + stable kb sections as numbered <document> blocks; rebuilt on re-ingest
STATIC_SYSTEM = build_static_system("prompts/answer_v2.txt", STABLE_KB)

def answer(question: str, docs_xml: str, model: str):
    resp = client.messages.create(
        model=model,
        max_tokens=600,
        system=[
            {"type": "text", "text": STATIC_SYSTEM,
             "cache_control": {"type": "ephemeral"}},  # breakpoint after stable prefix
        ],
        messages=[{"role": "user",
                   "content": f"<documents>\n{docs_xml}\n</documents>\n\nQuestion: {question}"}],
    )
    u = resp.usage
    # cache_creation_input_tokens: written now; cache_read_input_tokens: served from cache
    return resp, u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens
```

The cost formula with caching (multipliers from the documentation for the chosen model):

```
cost = (input × P_in
      + cache_write × P_in × k_write
      + cache_read  × P_in × k_read
      + output × P_out) / 1_000_000
```

This is exactly what needs to go into `common/llm_utils.py` (the `cache_read_tokens` and `cache_write_tokens` parameters of `estimate_cost`); otherwise cached tokens are counted at full price and the savings will not show.

### Answer cache and semantic cache

The second lever works at a different level: not "process the prompt more cheaply" but "don't call the model at all".

**Exact cache** — the key is a hash of (model, prompt, parameters). It is safe, but in chat it almost never hits: people phrase things differently. It is useful in evals and during development — a repeat run of the same set costs nothing (incidentally, this is how the caches in promptfoo work).

**Semantic cache** — the key is the question's embedding. If a new question is close to a stored one (cosine similarity above a threshold, chapter 4.1), we return the stored answer.

```
question → embed → search for the nearest in the cache
             ├─ sim ≥ 0.95 → return the stored answer  (0 LLM tokens)
             └─ otherwise  → full RAG → store (question, answer, ts)
```

When it fits: FAQ-like traffic with many identical questions, where the answers depend neither on time nor on the customer (for example, "how many days do I have to return an item?").

When it is dangerous — and this is a favorite interview topic:

| Risk | Example from the Shelf shop assistant |
|---|---|
| Close in embedding, different in meaning | "can I return opened tea?" vs "can I return unopened tea?"; "warranty on the Light lamp" (12 months) vs "warranty on the Light Mini" (6 months) — high cosine, different answers |
| Staleness | "does TEA15 combine with a discount?", "how much is delivery" — after an edit to `kb/promo.md` or the rates, the cached answer was only correct yesterday |
| Leakage between customers | a local model's answer to a question with personal data ("where is my order 1042, phone …") served to another customer with a similar phrasing |
| Cache poisoning | a prompt injection (chapter 8.4) through a poisoned `kb/` page made the model output garbage or a "100% promo code", and now that is served to every similar question |
| Loss of traceability | an answer without fresh source links breaks the "every claim has a citation" contract from chapter 5.3 |

Hence the rules: a high threshold, a TTL, a key that includes the index version (hashes of the `kb/` pages); questions on which `contains_personal_data` fired are never cached; refusals and errors are not cached either; and **the cache is checked with an evals set**: paraphrases must hit, while "traps" with the opposite meaning must not.

### Fallbacks: what, when, to where

Caches lower the price, but they do not help when the provider does not respond. For that we need a fallback — switching to a backup model. A fallback is not "catch any exception and call another model". The rules:

- **Which errors:** 429 (after retries), 5xx, 529 overloaded, timeout, network errors. **Not** 400/401/403/404 — those are an error in our request or key; on another provider it will either repeat or mask a bug.
- **Order:** first retries with exponential backoff and jitter (chapter 2.7), then the fallback. Otherwise every random 529 switches providers.
- **Circuit breaker**: if the main provider failed 5 times in a minute, don't try it for another N seconds, go straight to the backup. Otherwise every request first waits for a timeout.
- **The data decides where to switch.** A question about policies without personal data can go to another cloud model; a message on which `contains_personal_data` fired goes only to a local model or to a human operator (`handoff`).
- **Compatibility:** the backup model has a different tokenizer, different tool calling behavior, a different citation style. The prompt may need a version per model. **Evals on the backup model are mandatory** — a fallback that answers badly is worse than an honest error.
- **The cache is lost:** the prompt cache is tied to the provider and the model; after switching, the first requests are billed at full price.
- **Observability:** we write to the log/trace which model actually answered. Otherwise in chapter 10.3 there is no way to tell why the cost jumped.
- **The backup can be local** — Ollama (in detail in chapter 10.4); then the cost is zero, but the quality has to be measured.

### LiteLLM: one interface to all providers

Retries, fallbacks, a circuit breaker, cost tracking — we can write all of this ourselves, or take it ready-made. [LiteLLM](https://docs.litellm.ai) is a library (and a separate proxy server) that offers an OpenAI-like interface `completion(model="anthropic/...", messages=...)` to dozens of providers, plus cost tracking, retries, fallbacks, caching and budgets. In spirit it is our `call_llm()` from chapter 2.7 (or the Vercel AI SDK in the JavaScript world), brought up to industrial grade.

Two modes:

- **SDK** (`from litellm import completion, Router`) — inside our Python code.
- **Proxy** — a separate service with an OpenAI-compatible API: the application talks to it, and it talks to the providers. Virtual keys, per-key budgets and shared statistics are convenient there. It is overkill for a single study project, but in an interview it helps to know that an "LLM gateway" is a standard architectural component.

An illustrative Router example with a "cloud → another cloud" fallback (check the exact model names and format in the docs):

```python
import os
from litellm import Router

router = Router(
    model_list=[
        {"model_name": "primary",
         "litellm_params": {"model": "anthropic/<claude-model-id>",
                            "api_key": os.environ["ANTHROPIC_API_KEY"]}},
        {"model_name": "backup",
         "litellm_params": {"model": "openai/<gpt-model-id>",
                            "api_key": os.environ["OPENAI_API_KEY"]}},
    ],
    fallbacks=[{"primary": ["backup"]}],
    num_retries=2,
    timeout=30,
)

resp = router.completion(model="primary", messages=[{"role": "user", "content": "ping"}])
```

**Dependency security.** LiteLLM is a package that sees every provider key. Such packages are an attractive target for supply chain attacks (tampered releases on PyPI), so we treat it as code with access to money. Before installing: the project's GitHub Security Advisories, a version that is not from its first day, pinned in `uv.lock`, the list of what the package pulls in. An alternative that is perfectly fine for a study project: our own 40-line fallback on top of `common/llm_utils.py` from chapter 2.7 (such a skeleton is in the DeepSeek section below). We record the decision and its reason in the README.

### Budget: per answer and per day

The last mechanism catches what all the previous ones missed. A budget is a **fuse**, not a report. The support assistant has two natural scales: **the cost of one answer** and **the spend per day**. Let's compute it on the breakdown above: `deepseek-flash` at peak hours (prices are in the DeepSeek section below), 8,050 input tokens (1,500 + 1,000 + 2,500 + 3,000 + 50 from the diagram; the first three parts, 5,000 tokens, are the stable prefix), 300 output.

| | input, $ | output, $ | answer, $ | 100 answers a day, $ |
|---|---|---|---|---|
| no cache (all misses) | 8,050 × 0.30 / 1M = 0.002415 | 300 × 1.20 / 1M = 0.00036 | 0.002775 | 0.28 |
| 5,000-token prefix in cache | 5,000 × 0.006 / 1M + 3,050 × 0.30 / 1M = 0.000945 | 0.00036 | 0.001305 | 0.13 |

The savings are about 53%. The amounts are small: the limits protect not against normal traffic but against an accident — a retry loop, a spam bot, a bug that sends the whole `kb/` into the prompt. The daily limit is set several times above normal (for example, $1), the per-answer limit above the worst normal case: all misses plus the full `max_tokens=600` give 8,050 × 0.30 / 1M + 600 × 1.20 / 1M ≈ $0.0031, so $0.01 catches a bloated context or reasoning switched on by mistake.

It is checked **before** the request:

```
before the call:
  estimated   = cost of the answer from the known input and max_tokens
  if estimated > ANSWER_LIMIT:
      don't call the model → write to the log, investigate (it's a bug, not traffic)
  spent_today = SUM(cost) WHERE day = today       (from our own log table)
  if spent_today + estimated > DAILY_LIMIT:
      notify the owner (once a day) → polite reply to the customer and handoff
after the call:
  record the actual cost
  if spent_today crossed 80% → warning
```

Details that separate a working fuse from a decorative one:

- Store the spend in a **persistent** place (SQLite, like the cost log in chapter 3.4), not in a process variable — a container restart must not reset the counter.
- Estimate the request cost **in advance** (input is known, output is capped by `max_tokens`); otherwise the last request may overshoot the limit by a lot. For agents, also a step limit.
- When stopped, the customer sees not a stack trace but "a human operator will reply shortly": `handoff(question, "unavailable")`.
- The notification goes to the owner in Telegram (chat id in `.env`, like `OWNER_TELEGRAM_ID` in project 1), **once** per event; otherwise a stop will bring 500 identical messages.
- **The second line of defense is at the provider**: spending limits in the Anthropic/OpenAI console, a spending limit on the OpenRouter key. Our code may have a bug; the provider's limit does not depend on it.
- The time zone of the "day" is explicit (UTC); otherwise the limit "jumps".

## DeepSeek and Ollama: how we do it

We do everything above on **DeepSeek** (cloud, OpenAI-compatible API) and **Ollama** (local); the cloud backup is a model from another vendor through **OpenRouter** (chapter 2.4, AIL-69). The facts below were checked against the official documentation in November 2026 — DeepSeek's prices and model names change, so open [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) before you start.

### Caching at DeepSeek: nothing to enable, we can only stay out of its way

At Anthropic caching is an explicit operation: we set `cache_control`, pay for the write and get cheap reads. At DeepSeek [context caching](https://api-docs.deepseek.com/guides/kv_cache) is **on by default for everyone**: every request builds a cache on disk by itself, and the next request with the same prefix gets a "cache hit". The differences that change how we work:

- **Nothing to enable and nothing to configure** — no `cache_control`, no TTL, no breakpoints. The only lever is the same as in the theory above: **prompt order**. Rules, few-shot and standing `kb/` sections at the start, retrieved chunks and the question at the end, no timestamps in system. This works the same at every provider.
- **No write surcharge.** A miss costs the regular input price (cache miss), a hit is dozens of times cheaper. So "the first request with caching is more expensive" (quiz question 5) is false for DeepSeek.
- **Best-effort**: the documentation says plainly that 100% hits are not guaranteed. The cache is built "within seconds" and removed when unused — "typically within a few hours to a few days". The documentation gives no fixed TTL and no minimum length; the cache matches by "prefix units" (the boundaries are the end of each user message and model answer, the common prefix of several requests, plus fixed intervals on long texts).
- **How to check for a hit:** the `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` fields in `usage`. In the sample response they sit at the top level of `usage`, while in the API schema they are inside `prompt_tokens_details`; we read both places.
- **The Anthropic-compatible endpoint** `https://api.deepseek.com/anthropic`: code on the `anthropic` SDK from the theory will run against DeepSeek, but `cache_control` is **ignored** there, hits come in `cache_read_input_tokens`, and `cache_creation_input_tokens` comes as zero ([Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)). The same interface is not the same semantics.

Prices (per 1M tokens, USD, as of November 2026, peak / off-peak):

| Model | input, cache hit | input, cache miss | output |
|---|---|---|---|
| `deepseek-flash` | $0.006 / $0.003 | $0.30 / $0.15 | $1.20 / $0.60 |
| `deepseek-v4-pro` | $0.044 / $0.022 | $1.32 / $0.66 | $3.96 / $1.98 |

DeepSeek has something Anthropic does not: **the time of day is part of the price**. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; at all other times, on weekends and on Chinese public holidays the price is half. So the cost formula depends on the **moment of the request**, and a run of 100 questions at 07:00 UTC costs twice as much as the same run at 12:00 UTC. When comparing "before/after", we compare runs from the same price window (or compute both costs at the same rate). The assistant's daily spend also depends on when customers write.

```python
# common/llm_utils.py (illustrative) - DeepSeek cost with cache hit/miss and peak hours
from datetime import datetime, timezone

# USD per 1M tokens at PEAK; off-peak is half. Checked Nov 2026 - re-check the pricing page.
DEEPSEEK_PEAK = {
    "deepseek-flash":  {"hit": 0.006, "miss": 0.30, "out": 1.20},
    "deepseek-v4-pro": {"hit": 0.044, "miss": 1.32, "out": 3.96},
}

def is_peak(ts: datetime) -> bool:
    # Chinese public holidays are off-peak too; ignoring them overestimates cost slightly
    ts = ts.astimezone(timezone.utc)
    return ts.weekday() < 5 and (1 <= ts.hour < 4 or 6 <= ts.hour < 10)

def ds_cache_tokens(usage) -> tuple[int, int]:
    # the docs show these fields both at the top level and under prompt_tokens_details
    u = usage.model_dump()
    det = u.get("prompt_tokens_details") or {}
    hit = u.get("prompt_cache_hit_tokens", det.get("prompt_cache_hit_tokens")) or 0
    miss = u.get("prompt_cache_miss_tokens", det.get("prompt_cache_miss_tokens")) or 0
    return hit, miss

def deepseek_cost(model: str, usage, ts: datetime) -> float:
    p = DEEPSEEK_PEAK[model]
    k = 1.0 if is_peak(ts) else 0.5
    hit, miss = ds_cache_tokens(usage)
    return k * (hit * p["hit"] + miss * p["miss"] + usage.completion_tokens * p["out"]) / 1_000_000
```

One more cost lever specific to DeepSeek: **thinking mode is on by default** (effort `high`, [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)). Reasoning is output tokens (visible in `completion_tokens_details.reasoning_tokens`), that is, the most expensive part. A support answer from retrieved chunks usually does not need thinking — we turn it off (as in 5.3) and check with evals:

```python
resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=messages,
    max_tokens=600,
    extra_body={"thinking": {"type": "disabled"}},  # OpenAI SDK: thinking goes in extra_body
)
```

In thinking mode `temperature` is silently **ignored** (no error) — the `temperature=0` from our runs does nothing there.

### Fallback: DeepSeek → another cloud → Ollama, and for personal data local only

The simplest option is our own wrapper: all three providers speak the same protocol and differ only in `base_url`, key and model name. The OpenAI SDK does retries with backoff itself (`max_retries`), and the loop below is the fallback and the circuit breaker.

```python
import os, openai
from openai import OpenAI

deepseek = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com",
                  timeout=60, max_retries=2)   # explicit timeout: see the keep-alive note below
openrouter = OpenAI(api_key=os.environ["OPENROUTER_API_KEY"], base_url="https://openrouter.ai/api/v1",
                    timeout=60, max_retries=2)
ollama = OpenAI(api_key="ollama", base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
                timeout=120, max_retries=0)    # key is ignored by Ollama

CLOUD = [("deepseek",   deepseek,   os.environ.get("ANSWER_MODEL", "deepseek-flash")),
         ("openrouter", openrouter, os.environ["ANSWER_MODEL_FALLBACK"])]  # another vendor's model
LOCAL = [("ollama",     ollama,     os.environ.get("ANSWER_MODEL_LOCAL", "qwen3:4b"))]

FALLBACK_ON = (openai.RateLimitError, openai.APITimeoutError,
               openai.APIConnectionError, openai.InternalServerError)  # 429, timeouts, network, 5xx

class NoProviderError(RuntimeError):
    pass

def chat(messages, *, private: bool, **kw):
    # private=True: the message has personal data -> local model only, never any cloud
    chain = LOCAL if private else CLOUD + LOCAL
    last_err = None
    for name, client, model in chain:
        if breaker.is_open(name):      # our circuit breaker: skip a provider that keeps failing
            continue
        try:
            resp = client.chat.completions.create(model=model, messages=messages, **kw)
            breaker.success(name)
            return name, model, resp   # log which provider actually answered
        except FALLBACK_ON as e:
            breaker.failure(name)
            last_err = e
    raise NoProviderError("no provider available") from last_err
```

In `ask()` the flag comes from the check in 5.3, and the last link in the chain is a human:

```python
private = contains_personal_data(question)    # runs before any cloud call
try:
    provider, model, resp = chat(messages, private=private, max_tokens=600)
except NoProviderError:
    handoff(question, "personal_data" if private else "unavailable")
    return Answer(text=OPERATOR_MESSAGE, sources=[], refused=True, latency_ms=...)
```

What is specific to our providers here:

- **The fallback direction is a security question, not only a reliability one.** The "DeepSeek → another cloud model → Ollama" chain is fine for questions about policies: the prompt contains the public `kb/` and a question without personal data. For a message where `contains_personal_data` found a phone number, an email or an order number, the chain is **local only**: Ollama, and if it is unavailable, a human operator via `handoff`. A fallback of "Ollama is down → send it to the cloud" is a leak of customer data to someone else's servers (in DeepSeek's case, in China) that we wrote ourselves. That is why the `private` flag is required, with no default value.
- **The cloud backup is from another vendor** (the same DeepSeek through OpenRouter goes down together with the main one), with `data_collection: "deny"` (see below). We pass `extra_body` with `thinking` only to DeepSeek.
- **DeepSeek errors** ([Error Codes](https://api-docs.deepseek.com/quick_start/error_codes)): 429 — the limit on **concurrent requests** was exceeded (limits are per account, not per key), 500 — server error, **503 Server Overloaded** — the equivalent of Anthropic's 529. These are reasons for a fallback. 400/401/422 are not. **402 Insufficient Balance** is a special case: it is not an outage, the prepaid balance has run out; a fallback to the backup is acceptable, but always with a notification to the owner, otherwise the assistant will run on the backup model for a week and nobody will notice.
- **Keep-alive instead of a refusal.** Under load DeepSeek does not answer with an error right away: it holds the connection, sending empty lines (without streaming) or `: keep-alive` (SSE), and closes it only if inference has not started within **10 minutes** ([Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit)). Without an explicit `timeout` in the client, the fallback fires after 10 minutes — a customer in the support Telegram bot will not wait that long.
- **Ollama has no 429 or 5xx from provider overload** — it has a queue: by default one model processes one request at a time (`OLLAMA_NUM_PARALLEL`, default 1, [FAQ](https://docs.ollama.com/faq)). When all traffic switches to Ollama, latency grows, which is why it gets a longer timeout.
- **The cache is lost on switching** here too: Ollama has its own in-memory prefix KV cache (the `prompt_eval_cached_count` field in the native API), which lives while the model is loaded (`keep_alive`, 5 minutes by default).
- **Prompt and format.** A 4B local model (or 7–8B on a 16 GB machine) is worse at following citation rules, refusals and tool calling (chapter 10.4). An evals run on the backup models is mandatory — it is the same point as in the theory, only now the quality gap will be large.

**The OpenRouter option** (chapter 2.4 · OpenRouter: one API for many models, AIL-69): a `models` array in the request — if the first model returns an error, OpenRouter tries the next one ([Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)). We pay the price of the model that actually answered (visible in the response's `model` field), and the cost arrives in `usage.cost` automatically ([Usage Accounting](https://openrouter.ai/docs/guides/guides/usage-accounting)). By default the fallback fires on **any** error, including context overflow and moderation — broader than the "only 429/5xx/timeout" rule above. Important for privacy: the `provider` object has `data_collection: "deny"` (don't route to providers that store data and may train on it) and `zdr: true` (only zero-data-retention endpoints) — [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection). But OpenRouter is a cloud: it will not put a local Ollama into the chain, and messages with customers' personal data must not go there either. And DeepSeek caching through OpenRouter depends on which host of the model the request went to.

**The LiteLLM option:** the prefixes `deepseek/<model>` (key from `DEEPSEEK_API_KEY`), `openrouter/<model>` and `ollama_chat/<model>` with `api_base="http://localhost:11434"` (LiteLLM recommends `ollama_chat/`, it calls `/api/chat`). At the time of checking, the DeepSeek provider page in the LiteLLM docs showed examples with old model names — check that LiteLLM's built-in price table knows `deepseek-flash`/`deepseek-v4-pro` and accounts for peak hours; if not, compute the cost with our own function above.

### Budget: DeepSeek is prepaid

At Anthropic and OpenAI the second line of defense is the spending limits in the console, at OpenRouter a spending limit on the key. DeepSeek's model is different: a **prepaid balance**. When it runs out, the API answers 402 — and that is the hard ceiling, independent of bugs in our code. The practical takeaway: top up the study account in small amounts. The balance can be read via `GET https://api.deepseek.com/user/balance` (fields `is_available`, `balance_infos[].total_balance`, `granted_balance`, `topped_up_balance`, [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)) — handy for a daily summary to the owner in Telegram. We still need our own `check_budget`: the balance is a ceiling on everything, while the per-answer and daily limits keep a single bug or a looping agent from eating it overnight. At the time of checking, the API documentation has no separate spending-limit setting for the DeepSeek console — look in your account dashboard.

Ollama has no money budget, but a fuse is still needed: an agent step limit and `max_tokens`; otherwise a looping agent will hog the machine that runs the shop's other services.

### Comparing providers on this chapter's features

| What | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Enabling prompt caching | explicit: `cache_control` on blocks (up to 4 breakpoints) or an automatic mode with one top-level field | automatic for long enough prompts | always automatic, nothing to disable/configure; best-effort | no paid cache; in-memory prefix KV cache while the model is loaded |
| Cache write price | 1.25× (5 min) / 2× (1 h) of input | no separate surcharge | no surcharge (miss = regular input) | — |
| Read price | 0.1× on most models (less on some newer ones) | discounted, see docs | ≈2% of the miss price (`flash`), ≈3% (`pro`) | $0 |
| Lifetime | 5 min by default, 1 h optional | see docs | no fixed TTL, hours to days | while the model is in memory (`keep_alive`, 5 min) |
| Minimum length | yes, 512–4096 tokens depending on the model | yes, see docs | not specified in the documentation | — |
| Where to see hits | `cache_creation_input_tokens`, `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` | `prompt_eval_cached_count` (native API) |
| Price by time of day | no | no | yes: 50% outside UTC peak hours | — |
| "Overloaded" | 529 | 5xx | 503; plus keep-alive up to 10 min before inference starts | a request queue, not an error |
| Hard spending ceiling | limits in the console | limits in the console | prepaid balance → 402 | no money, there's hardware |
| Embeddings for the semantic cache | no own endpoint | yes | **no** embeddings endpoint | yes (`/api/embed`, `/v1/embeddings`) |
| Backup for messages with personal data | no | no | no | **yes** (or a human operator) |

### What to use for the practice

- **The cost and cache benchmark — on DeepSeek** (`deepseek-flash`): it's cheap, and the cache works "by itself", so we measure the effect of prompt order, not the correctness of the markup. Questions come from `eval/golden.jsonl` over the public `kb/`.
- **Backup models.** For policy questions: DeepSeek → another vendor's model through OpenRouter → Ollama. For messages with personal data: Ollama only, then `handoff`.
- **Embeddings for the semantic cache — Ollama** (DeepSeek has none), with the same model as the index (`bge-m3`).
- **The judge for backup-model evals** is a model stronger than the one being checked: `deepseek-v4-pro` (on public data) against a local 4B; Claude if you want to compare judges.
- An experiment with explicit `cache_control` on Anthropic is optional, "for comparison".

## Learning path

1. [DeepSeek: Context Caching](https://api-docs.deepseek.com/guides/kv_cache) → the whole page (≈15 min). We note: how the cache is built, which fields are in `usage`, what best-effort means and how long the cache lives.
2. [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) → hit/miss/output prices for both models and the peak hours (≈10 min). We copy the current numbers into `common/llm_utils.py`.
3. [DeepSeek: Error Codes](https://api-docs.deepseek.com/quick_start/error_codes) and [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit) → which codes mean "retry", which mean "error in the request", what 402 is, how the server behaves under load (keep-alive, 10 minutes) (≈15 min).
4. [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) → how to turn thinking off and which parameters are ignored in this mode (≈10 min).
5. [Ollama FAQ](https://docs.ollama.com/faq) → `keep_alive`, `OLLAMA_NUM_PARALLEL`, the default context (≈10 min) — these are properties of our local backup provider.
6. (For comparison) [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) (the link redirects to the current docs address) → the sections on automatic and explicit caching, prices, minimum length, prefix order and what invalidates the cache (≈30 min). We note for our model: the minimum length and the write and read multipliers.
7. (For comparison) [OpenAI: Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) → how the automatic cache works and where to see `cached_tokens` (≈10 min).
8. [LiteLLM](https://docs.litellm.ai) → "Getting started" (calling `completion` for two providers), then [Routing](https://docs.litellm.ai/docs/routing) and [Fallbacks / reliability](https://docs.litellm.ai/docs/proxy/reliability) (≈40 min). We pay attention to how to test a fallback without a real provider outage (`mock_testing_fallbacks` for Router) and how to get the cost of an answer. Then the [DeepSeek](https://docs.litellm.ai/docs/providers/deepseek) and [Ollama](https://docs.litellm.ai/docs/providers/ollama) provider pages (≈10 min).
9. An alternative to LiteLLM is OpenRouter: [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) and [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) → the `models` array, which errors trigger a fallback, `data_collection` and `zdr` (≈15 min).
10. In the LiteLLM docs, the sections on caching (including the semantic cache) and budgets: just read them, to know what is available out of the box (≈20 min).
11. GitHub Security Advisories of the `BerriAI/litellm` repository — before installing, then choosing a version (≈10 min).
12. The DeepSeek account dashboard → balance and top-up; we top up the study account with a small amount — that is the hard ceiling. Plus [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance) (≈10 min). We check the spending limit on the OpenRouter key (chapter 2.4) where we created the key. (For comparison) We find the spending limits in the Anthropic and OpenAI consoles.

## What to watch out for

- **The cache is "on" but doesn't work.** The prefix is shorter than the minimum, there's a timestamp in system, the order of tools changes from request to request (for example, they are built from a `set`), or the gaps between requests are longer than the TTL. Diagnose only through `usage`.
- **Savings are computed wrong** if the cost formula doesn't know about `cache_read`/`cache_creation`. At Anthropic the first request with caching costs more than without it (a write costs 1.25–2× input).
- **A "before/after" comparison on different questions** means nothing. The same set, the same order, the same parameters.
- **Sequential vs parallel runs.** If 100 requests are sent at once, the cache hasn't been written yet — every one pays for the write. Send one "warm-up" request first.
- **Standing `kb/` sections in the prefix go stale.** `kb/` was re-indexed, but the prefix was built at process start — the assistant cites old rates. The prefix is rebuilt together with the index, and archived pages never get into it.
- **A standing section hides a conflict.** `kb/delivery.md` is always in the prefix, while `kb/promo.md` is there only if retrieval found it: on the free-delivery threshold the answer may give one number instead of two. We check the questions tagged `conflict`.
- **A fallback masks an incident.** If 30% of requests go to the backup model and nobody knows, quality has dropped silently. A "fallback share" metric must be on the dashboard from chapter 10.3.
- **Retrying something non-idempotent.** For a plain question and answer, a retry is safe; for an agent with tools, retrying a step can run a tool twice. The assistant's and the agent's tools are read-only — and that is one of the reasons it should stay that way.
- **A semantic cache without evals** is a time bomb: the problem will surface when a customer gets an answer about the Light instead of the Light Mini.
- **A budget in process memory** resets on restart.
- **DeepSeek: comparing runs from different price windows.** A run during UTC peak hours costs twice as much — the "savings" may turn out to be a change in the time of day.
- **DeepSeek: no timeout in the client.** The server holds a keep-alive connection for up to 10 minutes; a fallback without `timeout` fires too late.
- **DeepSeek: thinking is on by default.** Reasoning output tokens are expensive and not needed for an answer from ready chunks; `temperature` is silently ignored in this mode.
- **A cloud fallback for personal data.** Ollama → DeepSeek or Ollama → "another cloud" on a message with a phone number or an order number is a leak. For those, the chain is local only, then a human operator.

## Practice

We work in `projects/02-support-kb-rag/`. The set is 100 questions from `eval/golden.jsonl` (chapter 6.3, AIL-28); if there are fewer, we add paraphrases. Questions on which `contains_personal_data` fires do not go into the cloud run. Providers are as in "What to use for the practice"; customer data, logs with real questions and keys don't go to the cloud.

- [ ] **Baseline.** A `bench_cost.py` script: runs 100 questions sequentially through `ask()` on DeepSeek and, for each, writes to `bench/<run_name>.jsonl`: the question, provider, model, `prompt_tokens`, `cache_hit`, `cache_miss`, `completion_tokens`, `reasoning_tokens`, request time (UTC), peak/off-peak, cost, latency. We run `run_name=baseline` with a deliberately "bad" prompt: chunks before the instructions, the current time at the start of system. Result: total cost, the `cache_hit` share of input, average cost per answer, p50/p95 latency.
- [ ] **Update the cost formula** in `common/llm_utils.py`: hit/miss at DeepSeek prices and peak hours (the `deepseek_cost` function from the DeepSeek section). (For comparison) A branch for Anthropic with the write and read multipliers.
- [ ] **Thinking.** 20 questions with the default thinking mode and with `thinking: disabled`. We compare `reasoning_tokens`, cost, latency and correctness (the judge from chapter 6.4). We choose a mode and write down why.
- [ ] **Reorder the prompt:** everything stable (role, citation rules, few-shot) at the start, chunks and the question at the end. Remove everything dynamic from system. Count the tokens of the stable prefix (at DeepSeek, from the `usage` of one request or with their offline tokenizer from the [Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage) page; at Anthropic, `client.messages.count_tokens`).
- [ ] **Standing `kb/` sections.** Add `kb/delivery.md` and `kb/returns.md` to the prefix (as in the theory) and run the evals: correctness and faithfulness don't drop, and the questions tagged `conflict` and `archived` are reviewed separately; if it got worse, roll back. (For comparison, Anthropic) If the prefix is shorter than the model's threshold, make a deliberate decision: useful stable content (checked with evals) or the conclusion that caching gives no effect here. We don't bloat the prompt with junk for the sake of the cache.
- [ ] **A run with the right order**, `run_name=cached`, in the same price window as the baseline. On DeepSeek there's nothing to enable: we check in the jsonl that the first request has almost all of its input as `cache_miss`, while in the following ones the stable prefix goes to `cache_hit`. We compute the savings in percent, the hit share and the cost of one answer; we compare it with the calculation from the theory. We repeat the run a day later — how many hits are left (the cache is best-effort, with no fixed TTL)?
- [ ] (For comparison) The same run on Claude with `cache_control`: `cache_creation > 0` on the first request, `cache_read > 0` on the rest. We compare the savings with DeepSeek and write down why at Anthropic the first request is more expensive and at DeepSeek it isn't.
- [ ] **Fallback.** Our own wrapper (the `chat(..., private=...)` skeleton from the DeepSeek section), a LiteLLM Router or OpenRouter with a `models` array: DeepSeek → another vendor's model through OpenRouter (`ANSWER_MODEL_FALLBACK`, `data_collection: "deny"`) → Ollama. Fallback only on 429/5xx/503/timeouts; an explicit `timeout` in the client. 402 — a notification to the owner in Telegram.
- [ ] **Test of the private path.** A question with a phone number or an order number goes to neither DeepSeek nor OpenRouter **under any failure**: we stop Ollama (`ollama stop <model>` and shut down the server) and make sure the cloud clients were not called even once, and a line with the `personal_data` reason appeared in `outputs/handoff.jsonl`. This is a security test; we keep it in `tests/` (the cloud clients are fakes, as in the 5.3 tests).
- [ ] A fallback without a real outage: a deliberately wrong `base_url` for DeepSeek in the test config (or `mock_testing_fallbacks` in LiteLLM). The log records which model answered.
- [ ] A 400 (for example, `max_tokens=-1`) does **not** trigger a fallback.
- [ ] Evals on both backup models (the judge is `deepseek-v4-pro` or another model stronger than the ones being checked, one for all rows); the numbers go into the experiments table (chapter 7.5, AIL-35).
- [ ] **Budget.** A `spend(day TEXT, ts, model, cost)` table in the project's `spend.db` (not in git; in Docker, in a volume, not in the image). A `check_budget(...)` function before every call; `ANSWER_LIMIT_USD` (per answer) and `DAILY_LIMIT_USD` (per day) from `.env`. If the per-answer limit is exceeded, the model is not called and the event is logged. If the daily one is exceeded, the customer gets a polite message and `handoff(question, "unavailable")`, the owner gets **one** Telegram message per day. A skeleton:
  ```python
  def check_budget(db, estimated: float, answer_limit: float, daily_limit: float) -> str | None:
      # return "answer_limit" or "daily_limit" if the call must not run, None if it may;
      # today's spend is summed in UTC
      ...
  def notify_once(db, event: str) -> None:
      # insert (day, event) with a UNIQUE constraint; send to Telegram only if inserted
      ...
  ```
- [ ] Budget check: a daily limit of $0.01, a few requests — a stop and exactly one notification. Restart the container — the limit still holds. Separately: an artificially bloated context (for example, k=50) hits the per-answer limit.
- [ ] A daily summary to the owner in Telegram: the DeepSeek balance (`GET /user/balance`), the day's spend and the average cost per answer.
- [ ] (Optional) A semantic cache on embeddings from Ollama (DeepSeek has no embeddings): a threshold, a TTL, a key with the index version, 10 paraphrase pairs (must hit) and 10 trap pairs "opened/unopened tea", "Light/Light Mini", "TEA10/TEA15" (must not). We write down at which threshold the traps start getting through.
- [ ] Small amounts and limits on the DeepSeek balance and on the OpenRouter key: that is the ceiling. (For comparison) A spending limit in the Anthropic/OpenAI consoles, if they are used.

## Done when

- There are numbers: the cost of 100 answers before and after the optimizations, the savings in percent and the cost of one answer (or a reasoned conclusion why caching doesn't help here).
- The fallback fires on a main-provider outage and doesn't fire on a 400; the logs show who answered.
- The per-answer and daily limits stop requests and survive a restart; the daily one sends a single notification.
- The numbers are in the README/experiments table; the DeepSeek cost is computed with hit/miss and peak hours.
- The private path is covered by a test: when Ollama is down, a message with personal data goes to no cloud and is handed to a human operator.

## Self-check quiz

1. Why are retrieved chunks placed after the system prompt and few-shot in a RAG prompt, rather than before?
2. `cache_control` is on, but in `usage` both `cache_creation_input_tokens` and `cache_read_input_tokens` are zero. What are two possible causes?
3. What is wrong with this system prompt from a caching point of view?
   ```python
   system = f"""You are the support assistant of the Shelf shop. It is now {datetime.now().isoformat()}.
   Answer with citations [1], [2]. ... (3000 more tokens of rules)"""
   ```
4. Which errors should trigger a fallback to another provider?
   a) 400 and 401  b) 429 (after retries), 5xx, 529, timeout  c) any exception  d) only a timeout
5. Why is the first request with caching enabled more expensive than without caching?
6. An example from the support assistant where a semantic cache would give a dangerously wrong answer?
7. Why can't the daily budget be stored in a Python process variable?
8. What is a circuit breaker and why is it needed together with a fallback?
9. Why run evals on the backup model?
10. 100 requests were sent at once via `asyncio.gather`, and there are almost no savings from caching. Why?
11. What does an LLM gateway (LiteLLM Proxy) give compared with calling the SDK from code, and why might it be unnecessary for a single study project?
12. Code was moved from Anthropic to DeepSeek and `cache_control` was left in. What happens to caching, and how do we see it in `usage`?
13. Two runs of the same set on DeepSeek cost $0.42 and $0.21, although the prompt and the questions are the same and the cache hit share is identical. What is the most likely explanation?
14. What is wrong with the chain `chain = ["ollama", "deepseek", "openrouter"]` for messages where `contains_personal_data` returned `True`, and why is the "DeepSeek → another cloud model" chain acceptable for the question "can I return opened tea?"?
15. Under load DeepSeek doesn't return 503, and the request "hangs" for several minutes. Why, and what should the client have?

## Answers

1. The prefix is what gets cached, and any change invalidates everything after it. Chunks change from question to question, so everything stable must come before them.
2. The stable prefix is shorter than the model's minimum length; the prefix contains changing data (timestamp, id); the order of tools changes; requests are further apart than the TTL; `cache_control` is in the wrong place.
3. The current time at the start of system makes the prefix unique for every request — the cache is always written (more expensive) and never read. The date, if needed, goes at the end, into the user message.
4. **b.** 4xx (except 429) is an error in the request or key; on another provider it will repeat or hide a bug.
5. A cache write costs more than regular input (1.25× for the 5-minute TTL at Anthropic). The savings come with repeated reads. At DeepSeek there is no write surcharge: a miss costs the regular price, so the first request is not more expensive.
6. "Can I return opened tea?" and "can I return unopened tea?", or the warranty on the Light (12 months) and on the Light Mini (6 months) — the embeddings are close, the answers differ. Also "does TEA15 combine with a discount" after an edit to `kb/promo.md` — the answer goes stale; and an answer to a question with personal data served to another customer.
7. A restart or re-creation of the container resets the counter, and the limit stops working. The spend is stored persistently (SQLite).
8. After a series of failures the main provider is temporarily "switched off", and requests go straight to the backup without wasting time on timeouts. Without it, every request during an incident waits for a timeout before the fallback.
9. The backup model may answer worse or break the format (citations, refusals, tool calling). A fallback of unknown quality can be worse than an honest error.
10. All requests went out before the first one wrote the cache, so each paid for the write. We need one warm-up request, then the parallel ones.
11. A single point for keys, per-key/per-team budgets, logs, fallbacks and switching providers without changing the application. For one project it is an extra service in compose and one more dependency trusted with all the keys.
12. Through DeepSeek's Anthropic-compatible endpoint, `cache_control` is ignored, but caching works automatically: hits show up in `cache_read_input_tokens`, and `cache_creation_input_tokens` is zero. Through the OpenAI-compatible one, we look at `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.
13. One run was during peak hours (01–04 and 06–10 UTC on weekdays), the other outside them: off-peak, DeepSeek's prices are half. We should compare runs from the same window or recompute at the same rate.
14. If Ollama fails, the phone number, email or order number will go to someone else's servers (in DeepSeek's case, in China); another provider is still a cloud. For personal data the chain is local only: Ollama, then a human operator via `handoff(question, "personal_data")`. A policy question without personal data is answered from the public `kb/`, so it can go to any cloud model — with evals on the backup.
15. While waiting, DeepSeek holds a keep-alive connection (empty lines or `: keep-alive` in SSE) and closes it only if inference has not started within 10 minutes. The client needs an explicit `timeout` so the fallback fires in time.

## What's next

The savings numbers now live in jsonl files — in chapter 10.3 · Tracing an LLM application and the cost of an answer (AIL-46) they move into Langfuse, and a dashboard appears across all four projects, including the fallback share and the cost of one support answer. A local model as a free backup and the only path for personal data is in chapter 10.4 · A local LLM with Ollama: a comparison on our own evals (AIL-47).
