# 10.3 · Tracing an LLM application and the cost of an answer  (AIL-46)

> **Week 10** · Production · ⏱ ~4 h · Practice

<!-- description: Tracing an LLM app: logs, metrics and traces, the cost and latency of one answer, dashboard metrics and trace privacy. -->
<!-- source-sha256: e484897e569e -->

## Why an AI engineer needs this

A customer writes "the bot answered nonsense," and without a trace there is no way to know what went wrong: search did not find the right chunk, the model ignored the context, a tool returned nothing, or a fallback to a weaker model kicked in. Money works the same way: "why did we spend three times more yesterday" cannot be explained without traces. In interviews, observability is a mandatory part of system design: "how do you find out that quality dropped?", "how much does one answer cost?", "what is your p95?".

## Theory

### Logs vs metrics vs traces

We already have pieces of observability: in Project 1 the bot writes the cost of every answer to a log (AIL-16), in chapter 6.5 (AIL-30) we connected Langfuse to the support assistant, and in chapter 10.2 (AIL-45) the cache and budget numbers went into the jsonl files in `bench/`. Now we assemble this into one system for all four projects. Let's start with vocabulary: observability is made of three kinds of data, and each answers its own question.

| | What it answers | Example |
|---|---|---|
| **Log** | what happened at a moment | `12:03:11 tool=get_open_orders rows=14` |
| **Metric** | how much / how often, an aggregate | p95 latency = 4.2 s, errors 1.3% |
| **Trace** | how **one** request went through all the steps | tree: search 180 ms → rerank 300 ms → LLM 2.1 s ($0.004) |

In a regular backend, tracing means "where is it slow." In an LLM application, a trace is also **about content**: it holds the prompt, the retrieved documents, the tool arguments and the answer. That is why the trace is the main tool for error analysis (AIL-34): we open a bad answer about the warranty on the Light Mini, see that chunks from the page of the Light lamp got into the context, and the problem is in retrieval, not in the model.

### Anatomy of a trace

Here is the trace of one answer from the support assistant, the pipeline from chapters 5.1–5.3: a cheap model rewrites the question (`plan_query`), search pulls candidates, the reranker keeps the best five, the main model writes the answer. Every step is visible with its time, and model calls also with tokens and price:

```
trace  "support-answer"  user=demo  session=tg-123  tags=[support, answer_v3]   total: 3.1 s, $0.0061
├─ span        "plan_query"                       0.6 s
│  └─ generation  model=small  in=220 out=40     0.6 s   $0.0002
├─ span        "retrieve"   top_k=8               0.2 s
│     input: "return of opened tea"  output: [8 chunk ids]
├─ span        "rerank"     top=5                 0.3 s
└─ generation  "answer"  model=main  in=4100 (cache_read=1800) out=380   2.0 s  $0.0059
      output: "No: tea in an opened package cannot be returned [1] ..."
```

- **Trace** — one whole user request. Attributes: `user_id`, `session_id` (a Telegram dialog), `tags` (prompt version, project), `metadata`.
- **Span** — any step with a start and an end (search, a tool call, parsing).
- **Generation** — a span that is a model call: the model, parameters, usage (tokens, including cache), cost.
- **Score** — an evaluation attached to a trace: from the user (👍/👎 in the bot), from an LLM judge, from evals (AIL-29).

Langfuse is built on OpenTelemetry (OTel), an open tracing standard. For LLMs, OTel has the GenAI semantic conventions (attribute names such as the model and tokens). The practical meaning: traces can be sent to any compatible backend, and instrumentation for libraries (OpenAI SDK, LangChain, LlamaIndex) often comes ready-made.

### How to instrument

For such a tree to appear, the code has to be instrumented: we mark where each step begins and ends. Three levels, from simple to flexible:

1. **A client wrapper.** `from langfuse.openai import openai` is a drop-in replacement for the OpenAI SDK; every call becomes a generation with tokens and cost. It also works for Ollama (AIL-47) and LiteLLM if they go through the OpenAI client.
2. **The `@observe` decorator** on our own functions: one span per function, and nesting is built automatically from the call stack (including in async code).
3. **Manual observations** — when we need precise control over what gets recorded, for example usage with the Anthropic cache.

An illustrative example (Langfuse Python SDK; the SDK has major changes from time to time, so check the signatures against the documentation for your version):

```python
from langfuse import observe, get_client

langfuse = get_client()  # reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL

@observe(name="retrieve")
def retrieve(question: str) -> list[dict]:
    ...

@observe(name="support-answer")
def answer(question: str, user_id: str) -> str:
    chunks = retrieve(question)
    with langfuse.start_as_current_observation(
        as_type="generation", name="answer", model=MODEL
    ) as gen:
        resp, usage, cost = call_llm(question, chunks)   # your llm_utils from AIL-11/45
        gen.update(
            output=resp.text,
            usage_details=usage,   # e.g. {"input": ..., "output": ..., "cache_read_input_tokens": ...}
            cost_details=cost,     # your own computed cost, so cache discounts are right
        )
    return resp.text
```

About cost: Langfuse can compute it on its own from a table of model prices, but for new models, the cache and Ollama the price may be missing or inaccurate. It is more reliable to pass **our own** cost, computed with the formula from AIL-45, and check it against the provider's invoice. For a local model the token cost is zero, but in the README we honestly write that this is not "free" (hardware, electricity, time).

Short-lived scripts (evals, `bench_cost.py`) must call `langfuse.flush()` before exiting: the SDK sends data in the background in batches, and without a flush the last traces are lost.

### Metrics we need on the dashboard

A trace answers a question about one request; a dashboard answers about all requests for a day or a week. Metrics are not collected separately: Langfuse aggregates them from the same traces, so everything we need on the dashboard must first get into the trace (the cost in the generation, the refusal reason in metadata). We need three groups.

**Cost:** average per answer, total per day, **breakdown by model** (a fallback shows up immediately) and by step (`plan_query` is cheap, answer is expensive).

**Latency — percentiles, not the average.** The distribution of LLM latency is long-tailed: most answers take 2 s, but some take 15 s (a long answer, a retry, an agent that took 6 steps). The average hides the tail.

- **p50** (the median) — half the answers are faster than this value: the "typical" experience.
- **p95** — 95% of answers are faster: what every twentieth request sees. Targets (SLOs) are usually set on p95.
- For streaming, separately — **TTFT** (time to first token): the customer sees that the bot is "typing" and is willing to wait longer.

```python
import statistics
lat = [r["latency_s"] for r in rows]
p50 = statistics.median(lat)
p95 = statistics.quantiles(lat, n=100)[94]  # needs enough data points to be meaningful
```

As with evals in chapter 7.1 (AIL-62), a small sample gives a noisy estimate: on 20 requests p95 is practically the maximum. Next to the number we write how many requests it was computed on.

**Errors:** the share of requests that ended in an exception, a timeout, a budget refusal, a fallback. Separately, "soft" errors: an answer without citations, invalid JSON, the refusal "The knowledge base has no answer to this question." (this can be a correct refusal or a retrieval failure; we sort it out from the traces). The handoff to a human operator (`handoff` with the reason `refused`, `personal_data` or `complaint`) goes into the trace metadata so we can count its share.

**For the agent (Project 4):** the number of steps per task, the number of tool calls, the share of tasks that hit the step limit. The agent's cost is the sum of all iterations, and it grows superlinearly, because each iteration repeats the whole history.

### Four projects — what to trace in each

The metrics are the same, but "one trace" means something different in each project: an owner's message, a customer's question, a case run or a whole agent investigation.

| Project | Trace = | Key spans | Special |
|---|---|---|---|
| 1. Telegram bot "shop analyst" (AIL-13–16) | one message from the owner | tool choice, calls to read-only functions over SQLite (`get_sales`, `get_open_orders`), answer | `session_id` = chat; **order data in traces** |
| 2. Support assistant over `kb/` (AIL-23) | one customer question | `plan_query`, retrieve, rerank, answer | chunk `url` in the retrieve output; **customer messages in traces** |
| 3. Evals/experiments (AIL-32–35) | one case run | as in project 2 + score | tag = experiment name, to compare |
| 4. Order-investigating agent (AIL-41) | one investigation | every iteration, every tool call | step limit, cost of the whole chain |

### Trace privacy

The last column of the table is the most important: a trace contains everything the model saw. For Projects 1 and 4 this is data from the shop's database snapshot: orders, amounts, payments, and customer comments in `events.message`. For Project 2, real customer messages, which can contain a phone number, an e-mail and an order number. The data is made up, but we treat it as real. Rules:

- Traces with the database snapshot and with real customer messages go only to a self-hosted Langfuse on our own machine (AIL-66), not to the cloud. Or masking: Langfuse has a mechanism for masking data before sending; we plug `contains_personal_data()` from `rag/privacy.py` into it and replace amounts and contacts with `***`.
- Made-up questions from `eval/golden.jsonl` over the public knowledge base can be traced in Langfuse Cloud too.
- The public demo version and dashboard screenshots for the README use only the **demo database** `data/demo_shop.db` and questions from the set.
- Keys and tokens never get into trace metadata. We check that the whole config object or the headers are not being logged.

### A tracing failure must not break the answer

Tracing is an auxiliary system. The Langfuse SDK sends data asynchronously and should not throw exceptions into our code, but our own wrappers (cost calculation, writing to SQLite) must be in `try/except` with logging. The check from AIL-66: we stop the Langfuse container, and the assistant keeps answering.

### LLM CLI: experiments from the terminal

Langfuse traces the application. But part of the work happens outside the application: comparing three wordings of a prompt, checking a new model on a couple of questions. Writing instrumented code for this takes long, and without a log the results get lost. For such cases there is a lightweight tool.

[LLM](https://llm.datasette.io) by Simon Willison is a CLI for talking to models: `llm "question"`, `llm -m <model> -s "system prompt" < file.md`, templates, embeddings. Providers are connected through plugins (`llm-anthropic`, `llm-ollama` and others). Why it is useful in the context of this chapter: **every request is automatically written to SQLite** — the prompt, the answer, the model, the tokens (`llm logs -u`, `llm logs --json`, the database path is `llm logs path`). This is mini-tracing for quick experiments: three prompt wordings compared from the terminal leave a log with tokens that can be opened in Datasette or queried with SQL.

LLM plugins are third-party code that receives our keys. We install `llm` itself with `uv tool install llm`, and plugins only the ones we need and after the usual review of third-party code (author, repository, what the installation does). It is worth noting how it stores keys (`llm keys set` writes them to a file in the user profile); we can pass them through environment variables instead.

## DeepSeek and Ollama: how we do it

Tracing hardly depends on the provider: Langfuse does not care who answered. What depends on the provider is **usage and cost**: each has its own fields, and that is exactly where "the cost of one answer" breaks. The facts were checked against the DeepSeek, Ollama and OpenRouter documentation in November 2026.

### Where to get the numbers for a generation

| What we need in the trace | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Input / output tokens | `usage.input_tokens` / `output_tokens` | `usage.prompt_tokens` / `completion_tokens` | same as OpenAI | native API: `prompt_eval_count` / `eval_count`; OpenAI-compatible: we need to check that `usage` is filled in (the compatibility page does not say so explicitly) |
| Cache | `cache_creation_input_tokens`, `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (in the example at the top level of `usage`, in the schema in `prompt_tokens_details`; we read both) | `prompt_eval_cached_count` |
| Thinking tokens | in `output_tokens` (thinking) | `completion_tokens_details.reasoning_tokens` | `completion_tokens_details.reasoning_tokens`; thinking is **on by default** | depends on the model |
| Cost in the response | no, we compute it ourselves | no, we compute it ourselves | no, we compute it ourselves; the price depends on **peak hours in UTC** | $0 API |
| Time | we compute it ourselves | we compute it ourselves | we compute it ourselves | `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration` in **nanoseconds** |
| Usage when streaming | in the final `message_delta` | `stream_options={"include_usage": True}` | `stream_options` is supported | `include_usage` is supported |

Through OpenRouter (chapter 2.4 · OpenRouter: one API for many models, AIL-69) the cost arrives ready-made in `usage.cost`, with no extra parameters ([Usage Accounting](https://openrouter.ai/docs/guides/guides/usage-accounting)). This is convenient, but it is worth checking against our own calculation at least on a sample.

### DeepSeek cost in Langfuse

We should not trust Langfuse's built-in price table for DeepSeek: its price for a cache miss and a cache hit differs by tens of times, and outside peak hours (01:00–04:00 and 06:00–10:00 UTC on weekdays are peak) everything costs half as much. The automatic calculation may know neither of these; it is worth checking on your version, and it is more reliable to pass our own cost with the `deepseek_cost` function from chapter 10.2 (AIL-45):

```python
# illustrative: one DeepSeek call as a Langfuse generation with your own cost
from datetime import datetime, timezone
from common.llm_utils import deepseek, deepseek_cost, ds_cache_tokens, is_peak

with langfuse.start_as_current_observation(as_type="generation", name="answer",
                                           model="deepseek-flash") as gen:
    ts = datetime.now(timezone.utc)
    resp = deepseek.chat.completions.create(model="deepseek-flash", messages=messages,
                                            extra_body={"thinking": {"type": "disabled"}})
    hit, miss = ds_cache_tokens(resp.usage)
    details = resp.usage.completion_tokens_details
    gen.update(
        output=resp.choices[0].message.content,
        usage_details={"input_cache_hit": hit, "input_cache_miss": miss,
                       "output": resp.usage.completion_tokens,
                       "reasoning": getattr(details, "reasoning_tokens", 0) or 0},
        cost_details={"total": deepseek_cost("deepseek-flash", resp.usage, ts)},
        metadata={"provider": "deepseek", "peak": is_peak(ts)},
    )
```

Two things to check on our own responses rather than take on faith: whether `reasoning_tokens` are included in `completion_tokens` (in the OpenAI convention they are; DeepSeek's documentation says billing is by the sum of input and output tokens), otherwise the reasoning gets counted twice or not at all; and whether the sum of our `cost` for a day matches the spend in the DeepSeek account dashboard.

### Ollama: zero cost, time is the main metric

For a local model the token cost is $0, and the interesting part is time. The native Ollama API ([Usage](https://docs.ollama.com/api/usage)) reports it by phase, and from this we get the metrics for chapter 10.4 (AIL-47):

```python
# illustrative: Ollama native /api/chat metrics -> trace metadata
import ollama  # official Python library; pin the version

r = ollama.chat(model=MODEL, messages=messages, options={"num_ctx": 16384})
ns = 1e9
meta = {
    "load_s": r.load_duration / ns,                       # >0 = cold start, exclude from latency stats
    "prefill_s": r.prompt_eval_duration / ns,             # ~ TTFT without network
    "decode_tok_per_s": r.eval_count / (r.eval_duration / ns),
    "prompt_tokens": r.prompt_eval_count,                 # compare with num_ctx: truncation?
    "cached_prompt_tokens": getattr(r, "prompt_eval_cached_count", None),
}
```

If `load_duration` is noticeably above zero, the model was being loaded (a cold start after `keep_alive`); we tag such requests and do not mix them with the rest in p95.

### Privacy: which provider in which project

The course rule: customers' personal data and the shop's database snapshot never go to cloud models; a local model processes them. DeepSeek's servers are in China, but the rule applies to any cloud provider.

| Project | Provider | Where the traces go |
|---|---|---|
| 1. Bot "shop analyst" | the `data/shop.db` snapshot — **Ollama only**; DeepSeek only with the demo database `data/demo_shop.db` | snapshot — self-hosted Langfuse only (chapter 10.1, AIL-66) |
| 2. Support assistant | questions from the set over the public `kb/` — DeepSeek, Ollama as the fallback; real customer messages — **Ollama only** | the set — Langfuse cloud is fine; customer messages — self-hosted or with masking |
| 3. Evals | DeepSeek for generation and the judge on public data | cloud is fine |
| 4. Order-investigating agent | **Ollama only** on the snapshot; DeepSeek only on the demo database | snapshot — self-hosted only |

If the traces of Project 1 or 4 show `provider=deepseek` while working with the database snapshot, or in Project 2 on a real customer message, that is an incident, not a metric. We turn this into a check: a test or an alert on metadata.

### What to use for the practice

Load runs for Projects 2 and 3 go on DeepSeek (`deepseek-flash`) over the questions from `eval/golden.jsonl`: the knowledge base is public, the questions are made up, and the numbers are cheap and realistic for the cloud. Projects 1 and 4 run on Ollama with the database snapshot locally, or on DeepSeek with the **demo database** (then we write in the README what it was measured on). For comparison we can repeat 20 requests of Project 2 on Claude and compare cost and p95: the price difference will be an order of magnitude or more, and that makes a good line for the README.

## Learning path

1. [Langfuse docs](https://langfuse.com/docs) → the Observability section: overview, data model (traces, observations, generations, sessions, scores) and the Python SDK (≈45 min). We pay attention to `@observe`, nesting, `flush()` and how `user_id`/`session_id`/tags are set.
2. In the same docs → the section on model usage and cost: how Langfuse computes cost, how to set our own model price and how to pass a ready-made cost (≈20 min). We note what to do with cache tokens.
3. In the docs → the OpenAI SDK integration (`from langfuse.openai import openai`), if our projects (or Ollama/LiteLLM) go through the OpenAI client (≈10 min).
4. In the docs → the section on dashboards/metrics and on data masking (≈20 min). We look at which charts come out of the box (cost, latency, by model) and how to build our own.
5. [LLM CLI](https://llm.datasette.io) → installation, "Usage", "Logging to SQLite", plugins (≈25 min). We install it and make 5 requests, then `llm logs -n 5 -u`.
6. [DeepSeek: Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) → the schema of the `usage` object in the response (≈10 min). We write down all the fields, including cache and `reasoning_tokens`, and find where they sit in a real response (`print(resp.usage.model_dump())`).
7. [Ollama: Usage](https://docs.ollama.com/api/usage) → the time and token metrics of the native API (≈10 min). Important: durations are in nanoseconds.
8. (If OpenRouter is used) [Usage Accounting](https://openrouter.ai/docs/guides/guides/usage-accounting) → `usage.cost`, `cached_tokens`, `reasoning_tokens` (≈10 min).
9. In the LLM CLI docs we find how to connect an OpenAI-compatible model (DeepSeek) and the `llm-ollama` plugin for a local one (≈10 min); before installing the plugin, the usual review of third-party code.
10. (For reference) In the OpenTelemetry documentation we find the page on the GenAI semantic conventions — just skim which attributes are standardized (≈10 min).

## What to watch out for

- **Flat traces.** If everything is recorded as one generation without spans, we cannot tell whether search or the model is to blame. The minimum: retrieve and answer separately.
- **No `flush()` in scripts** — the evals "passed," but Langfuse is empty or has half of them.
- **Double-counted cost:** the client wrapper counted it, and another generation was recorded by hand for the same call. The total on the dashboard doubles.
- **Cost without the cache.** If Langfuse computes from the price list without accounting for `cache_read`, the savings from AIL-45 are not visible on the dashboard, and the cost is overstated.
- **The average instead of percentiles**, and percentiles on 15 points.
- **Traces with the database snapshot or real customer messages in the cloud** or on screenshots in the README.
- **High tag cardinality:** we do not put unique values (request id, question text) into tags; those belong in metadata.
- **In async code** the trace context is passed through contextvars; if a task runs in a separate thread or pool, the nesting can get lost, so we check the tree in the UI.
- **Sampling:** with heavy traffic, not everything gets traced. At our scale we trace 100%.
- **DeepSeek by the Langfuse price list** — without hit/miss and peak hours the cost will be wrong in both directions. We pass our own.
- **Ollama: nanoseconds** in the native API durations, and the cold start (`load_duration`) inside p95.
- **A trace with `provider=deepseek` on the database snapshot or on a customer message** is a leak, not just a record.

## Practice

- [ ] Bring up Langfuse (self-hosted from AIL-66, or the cloud for demo data and questions from the set). Create a project for each of the four course projects, or one project with a `project:<name>` tag; choose and write down why.
- [ ] **Project 2 (support assistant):** spans `plan_query`, `retrieve` (the output has the `url` and score of the chunks), `rerank`, and a generation `answer` on DeepSeek with our own cost (`deepseek_cost` from chapter 10.2: hit/miss + peak hours) and `usage_details` with cache and `reasoning`. Ask 5 questions from the set (for example, "can I return opened tea?", "what is the warranty on LAMP-LIGHT-MINI?"), open the traces: the tree is nested correctly, and the cost matches our calculation.
- [ ] **Project 2, real messages:** in the trace metadata, the result of `contains_personal_data` and the `handoff` reason if there was one. Such traces are produced only by Ollama and written only to a self-hosted Langfuse, or masked before sending.
- [ ] **Project 1 (Telegram bot):** a trace per message, `session_id` = chat id, a span for every read-only tool (arguments and row count, but not the amounts themselves — masking). The database snapshot is **Ollama only** and self-hosted Langfuse only; DeepSeek only with the **demo database**. In metadata: `provider`, `load_s`, `decode_tok_per_s`.
- [ ] Add 👍/👎 to the bot as a score on the trace.
- [ ] **Project 3 (evals):** every case run is a trace with the experiment tag; the check result is a score. `flush()` at the end of the script.
- [ ] **Project 4 (agent):** a span per iteration, a generation per model call, a span per tool call; in the trace metadata, the number of steps and the stop reason.
- [ ] In every trace, the provider and model that actually answered (this shows the DeepSeek → OpenRouter → Ollama fallbacks from chapter 10.2).
- [ ] Check the day's total `cost` against the spend in the DeepSeek account dashboard; if the difference is more than a few percent, find out why (cache, peak hours, reasoning).
- [ ] Privacy check: a test or a Langfuse query that finds traces of projects 1 and 4 with the database snapshot and traces of Project 2 with real customer messages where `provider != "ollama"`. There must be zero.
- [ ] **Load for the numbers:** run 50–100 requests in each project (questions from the eval sets; for the agent, the 20 cases from AIL-42).
- [ ] **A dashboard** in Langfuse: average cost per answer, p50/p95 latency, error rate, cost breakdown by model, for each project.
- [ ] Cross-check: compute p50/p95 and the average cost ourselves with a `trace_metrics.py` script that takes data from our own log (or a Langfuse export) and prints a table. The numbers must match the dashboard within rounding.
- [ ] Find one bad answer in the traces and use the tree to determine the cause (retrieval / prompt / model / tool). Write it into the error log (AIL-34).
- [ ] Install LLM CLI, connect DeepSeek as an OpenAI-compatible model and Ollama through the plugin, compare two wordings of the system prompt from the terminal on 3 questions from the set on both, look at `llm logs -u`.
- [ ] A table in the README of each project:
  ```markdown
  | Metric | Value | Requests |
  |---|---|---|
  | Average cost per answer | $0.0042 | 100 |
  | Latency p50 / p95 | 2.1 s / 5.8 s | 100 |
  | Error rate | 1% | 100 |
  ```

## Done when

- In all four projects, every request produces a trace with nested steps, the model, tokens and cost.
- For each project we know the average cost per answer, p50/p95 latency and the error rate, with the sample size stated; the numbers are in the README.
- Traces with the database snapshot and real customer messages do not leave our machine and are produced only by Ollama; public screenshots use the demo database and questions from the set.
- DeepSeek cost in the traces is computed with the cache and peak hours and matches the account dashboard.

## Self-check quiz

1. How does a generation differ from a span in Langfuse?
2. Why do we look at p95 rather than the average for the latency of LLM answers?
3. In which projects do traces contain sensitive data, and what do we do about it?
4. What is wrong with this eval run script?
   ```python
   from langfuse import observe

   @observe(name="eval-case")
   def run_case(case): ...

   for case in cases:
       run_case(case)
   print("done")
   ```
5. What goes better into `tags`, and what into `metadata`: the experiment name `chunking-B`, the request id, the prompt version `v3`, the question text?
6. The dashboard shows that the average cost per answer is 2 times higher than the manual calculation. Which two causes could lead to this?
7. What is TTFT, and why does it matter for a Telegram bot with streaming?
8. The trace shows: the question was about the warranty on the Light Mini, retrieve returned 8 chunks, all from the page of the Light lamp, and the answer is wrong (12 months instead of 6). Where is the problem, and what next?
   a) in the model — switch to a stronger one
   b) in retrieval — look at the query, `plan_query`, chunking and metadata
   c) in the prompt — add "be more careful"
   d) in tracing
9. p95 was computed on 12 requests. How much can we trust this number?
10. Why LLM CLI if we have Langfuse?
11. Why is it better to pass our own cost calculation to Langfuse explicitly rather than rely on the automatic one?
12. In a DeepSeek trace, `prompt_tokens=5000`, `prompt_cache_hit_tokens=4000`. Why can't the cost be computed as `5000 × input_price`, and what else affects the price of this request besides tokens?
13. An Ollama request has `eval_count=300`, `eval_duration=6000000000`. How many tokens/s is that? And if `load_duration` is 4 seconds, what does that mean for the latency statistics?
14. In Project 4, on the database snapshot, Langfuse shows a generation with `model=deepseek-flash`. What does this mean, and what do we do?

## Answers

1. A span is any step with a duration; a generation is a span that represents a model call, with the model, parameters, usage and cost. Cost and tokens are aggregated over generations.
2. The distribution is long-tailed: the average hides slow answers that a noticeable share of users sees. p95 shows the experience of "every twentieth."
3. In Projects 1 and 4, data from the database snapshot (orders, amounts, payments, customer comments in `events`); in Project 2, real customer messages with phone numbers, e-mails and order numbers. Only a self-hosted Langfuse locally, or masking (`contains_personal_data`); demos and screenshots use the demo database and questions from the set.
4. There is no `langfuse.flush()` at the end: the SDK sends data in the background, the script exits, and the last traces are lost.
5. In tags, low-cardinality values for filtering: `chunking-B`, `v3`. The request id and question text go into metadata/input.
6. A generation recorded twice (wrapper + manual); automatic cost without the cache discount; a wrong model price in the Langfuse table; a fallback to a more expensive model.
7. Time to first token — the time until the first token of the answer. With streaming the customer sees that the answer has started, and the total duration feels more tolerable; TTFT is the main measure of "responsiveness."
8. **b.** The model answered from what it was given; we need to examine the search query, the rewriting, the metadata filters (AIL-60) and the chunking: similar products differ in warranty, and search must recognize the right product.
9. Hardly at all: on 12 points p95 is practically equal to the maximum and depends heavily on a single outlier. We need more requests and the sample size stated.
10. For quick experiments from the terminal without code: a prompt against several models, everything automatically logged to SQLite with tokens. Langfuse is for the application.
11. The automatic calculation may not know the price of a new model, the cache multipliers or a local model. Our own formula (AIL-45) is reconciled with the invoice and accounts for the cache.
12. 4000 tokens are cache hits, which at DeepSeek are tens of times cheaper than misses; hits and misses must be counted separately. The time of the request also affects the price: outside peak hours in UTC everything costs half as much.
13. 300 / 6 s = 50 tokens/s (durations are in nanoseconds). A `load_duration` of 4 s is a cold start: the model was being loaded into memory; such a request is tagged and excluded from p95 or counted separately.
14. Database snapshot data (orders, payments, customer comments) went to the DeepSeek cloud — a privacy incident: somewhere a fallback or a config let the private path into the cloud. Stop it, find the cause (the fallback chain, an environment variable), add a test that the private path is local only.

## What's next

Now we have a ruler for measuring any model replacement. In chapter 10.4 · A local LLM with Ollama: a comparison on our own evals (AIL-47) we connect a local model and compare it with a cloud one on quality, latency and cost; these same metrics go into the experiment table.
