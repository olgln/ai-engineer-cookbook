# 2.4 · OpenRouter: one API for many models  (AIL-69)

> **Week 2** · LLM basics · ⏱ ~3 h · Theory, Practice

<!-- description: OpenRouter: one key and an OpenAI-compatible API for hundreds of models. Free models, fallbacks, provider routing and where the data goes. -->
<!-- source-sha256: d308fbb51b80 -->

## Why an AI engineer needs this

In chapter 2.3 · How to choose an LLM: models and providers (AIL-58) we put together a table of models, but a table is not enough to choose: a model is chosen by our own evals. Running one prompt through five models from five labs takes five accounts, five keys and five SDKs. Or one aggregator. OpenRouter is the most widely used one: one key, one OpenAI-compatible API and hundreds of models. At work it is used for quick comparisons, fallbacks and access to open-weight models without a GPU of our own. An interview asks something else: "how is an aggregator worse than a direct provider, and where does the data go?"

## Theory

### What OpenRouter is

OpenRouter is a layer between our code and the model providers:

```
our code ──► https://openrouter.ai/api/v1  (one key OPENROUTER_API_KEY)
                    │  router: picks model + provider endpoint
     ┌──────────────┼───────────────┬─────────────────┐
     ▼              ▼               ▼                 ▼
 Anthropic       OpenAI       DeepSeek (itself) open-weight hosts
 (Claude)        (GPT)        and other hosts   (Llama, Qwen, Mistral...)
```

It does three things:

1. **A single protocol.** OpenAI Chat Completions (`/api/v1/chat/completions`), plus the Responses API. The code from chapter 1.6 works with OpenRouter once `base_url` and the key are changed.
2. **Single billing.** We buy credits, and the cost of requests to any model is deducted from them.
3. **Routing.** One model can have several *providers* (endpoints): for an open-weight model these are different hosts; for DeepSeek, DeepSeek itself and third-party hosts. OpenRouter picks the provider itself (balancing price, speed and reliability) or by our rules, and on a failure tries the next one.

An analogy from the world of online shops: it is like a payment aggregator for LLMs. One interface over dozens of payment providers, but under the hood each has its own limits, quirks and fees, and the abstraction leaks in places.

Next we look at how to use it: how models are named, what it costs (including "free"), how to control routing, where the abstraction leaks and what happens to the data.

### Models and their names

A model on OpenRouter is named `<organization>/<model>`, for example `deepseek/deepseek-v4.1-flash` (as of November 13, 2026, the DeepSeek catalog has such a slug too). Exact names come only from the [catalog](https://openrouter.ai/models) or from `GET /api/v1/models`; we never write them from memory. Besides regular names there are:

- **"Latest" aliases** with a tilde (`~deepseek/deepseek-flash-latest`) point to the newest model of a family. Handy for experiments and dangerous for a product (see chapter 2.3: the model changes right under our feet).
- **Suffix variants** ([Model variants](https://openrouter.ai/docs/guides/routing/model-variants)):

| Suffix | What it does |
|---|---|
| `:free` | the free version of a model, a separate catalog entry with its own limits and providers |
| `:nitro` | sorts providers by speed (throughput) |
| `:floor` | sorts providers by price |
| `:exacto` | sorts providers by tool calling quality |
| `:batch` | batch pricing, via the Batch API |
| `:thinking`, `:online`, `:extended` | deprecated; reasoning has the `reasoning` parameter, search has the server-side web search tool |

`:free` and `:batch` are separate catalog entries. `:nitro`, `:floor` and `:exacto` work with any model and change only the choice of provider.

### Free models: what they give and how we pay for them

The most visible suffix is `:free`: with it, models can be compared without spending a cent. Models with the `:free` suffix are free, but with limits (per [Limits](https://openrouter.ai/docs/api/reference/limits), November 13, 2026):

| Credits bought in total | Requests per minute | Requests per day to `:free` |
|---|---|---|
| less than $10 | 20 | 50 |
| $10 or more | 20 | 1000 |

What is left is visible via `GET https://openrouter.ai/api/v1/key` (the `free_model_daily_requests` field). With a negative balance even free models can answer 402.

There is also the `openrouter/free` router, which picks a free model itself and on a failure switches only to other free ones. The set of free models changes all the time, so we check the catalog on the day of work.

The main price of free is **data**. Providers of free endpoints often make a living by logging requests or training on them. OpenRouter shows the data policy of each endpoint and has separate settings for paid and free models, but the decision about what to send stays with us. The course rule: **only study questions and public texts go to `:free` models**, exactly as with DeepSeek and any other cloud model.

### Money

Paid models are paid from a single credit balance. The main things to know about it:

- **Model prices are the providers' prices, with no markup** (per the [FAQ](https://openrouter.ai/docs/faq)). The fee is charged when buying credits: 5.5% (minimum $0.80), 5% with crypto. Unused credits may expire a year after purchase.
- **The cost of each request comes in the response**: `usage` has a `cost` field (in credits), plus `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` ([Usage accounting](https://openrouter.ai/docs/guides/guides/usage-accounting)). Nothing needs to be turned on. This is more convenient than maintaining a `PRICES` table, but checking against it is useful.
- **BYOK** (bring your own key): we can connect our own provider key, and then OpenRouter works only as a router. The terms change; it is worth checking them against the FAQ.
- **A limit per key.** A key can be given a spending cap (the `limit` and `limit_remaining` fields in `/api/v1/key`). For a study key we always set one: a typo in a loop must not cost more than $5.

### Provider routing and fallbacks

Back to OpenRouter's third function, routing: price, speed and who sees our data all depend on it. A fallback is a backup option used when the main one doesn't respond. The default behavior ([Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)): OpenRouter weighs price, speed, latency, reliability and tool calling quality, tries the next provider on an error, and tries to keep a conversation's continuation with the same provider while its cache is "warm". This is controlled with the `provider` object in the request body:

| Field | What for |
|---|---|
| `order`, `only`, `ignore` | which providers and in what order |
| `allow_fallbacks` | whether other providers may be used (yes by default) |
| `sort` | `price` / `throughput` / `latency` |
| `require_parameters` | only providers that support all the request's parameters; otherwise, for example, `response_format` can be silently ignored |
| `data_collection: "deny"` | only providers that don't collect data |
| `zdr: true` | only endpoints with Zero Data Retention |
| `quantizations` | a filter by quantization (`int4`, `fp8`...): the same open-weight model at a different precision answers differently |
| `max_price` | a price ceiling |

Besides fallback between providers of one model there is **fallback between models**: the `models` parameter with a list in priority order ([Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)). If the first model fails (a limit, overload, a context that is too long, moderation), the next one is taken. We pay the price of the model that answered, and which one answered is visible in the `model` field of the response. The trap: if a free model "fell back" to a paid one, we pay. To keep a request free, we list only `:free` models.

### Features that depend on the provider

Routing is convenient as long as all providers can do the same things. They can't. OpenRouter unifies the protocol, not the features. Structured outputs (`response_format` with `json_schema`), tool calling, caching and `reasoning` are supported **not by all endpoints**, even of the same model ([Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)). So:

- for strict JSON we filter models by `supported_parameters` and set `provider.require_parameters: true`;
- caching works the way the provider does it ([Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)): automatic for DeepSeek and OpenAI, Anthropic needs `cache_control` (OpenRouter passes it through), implicit for Gemini. Hits are visible in `usage.prompt_tokens_details.cached_tokens`;
- parameters like `temperature` don't work on reasoning models and new Claude models, just as they don't directly (chapter 1.7): OpenRouter can't turn on a knob the model doesn't have.

### Privacy: two levels

Since a request can go to any of a model's providers, the question "who sees the data" is now answered in two steps:

1. **OpenRouter itself** doesn't store prompts and responses by default ([Data collection](https://openrouter.ai/docs/guides/privacy/data-collection)). Request logs and the 1% discount for allowing use of our data are turned on separately and are off by default.
2. **The provider the request went to** follows its own policy: some store nothing (ZDR), others store for abuse prevention, others may train on the data ([Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)). The settings are in the account's [Privacy settings](https://openrouter.ai/settings/privacy) and in `provider.data_collection` / `provider.zdr` in the request.

An important subtlety: a request to a DeepSeek model through OpenRouter doesn't necessarily reach DeepSeek's servers in China. Open-weight models also have other hosts, and this is visible in the Providers tab on the model's page. But **the course rule doesn't change**: customers' personal data, the order event log, shop database snapshots and work code never go to the cloud by any route. OpenRouter solves a convenience problem, not the problem of our data.

### What to use when

| Situation | Choice |
|---|---|
| Compare 5 models from different labs on one prompt or eval | **OpenRouter** |
| Fallback to another model or provider on a failure | **OpenRouter** (`models`, `provider`) or our own logic (chapter 11.2 · Prompt caching, budgets, fallbacks (AIL-45)) |
| Everyday study on one cheap model | **DeepSeek directly**: its own features (continuing a started answer via the beta prefix from chapter 2.1, strict tools from chapter 2.2, `reasoning_content`) are documented, with no extra hop |
| A specific provider's features (Anthropic's Batch API, Files API, fresh betas) | **Directly with the provider**: an aggregator often doesn't pass them through or lags behind |
| Customer data, the order event log, a database snapshot, embeddings of our own data | **Ollama locally**, no alternatives |
| Try a large open-weight model that doesn't fit in our machine's memory | **OpenRouter** (on public data) |
| Production with data requirements | A direct contract with a provider or cloud; OpenRouter only with ZDR and after checking the policies |

## DeepSeek and Ollama: how we do it

### Code: the same client, a third `base_url`

```python
import os, time
from openai import OpenAI

router = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],     # from .env, listed in .gitignore
)

r = router.chat.completions.create(
    model="deepseek/deepseek-v4.1-flash",          # copy exact slugs from openrouter.ai/models
    messages=[{"role": "user", "content": "Explain gross margin in two sentences."}],
    max_tokens=300,
    extra_body={
        "provider": {"data_collection": "deny", "sort": "price"},   # OpenRouter-specific
        "models": ["deepseek/deepseek-v4.1-flash", "openrouter/free"],  # fallback chain
    },
)
print(r.model)                                     # who actually answered
print(r.choices[0].message.content)
print(r.usage)                                     # includes cost (credits) and token details
```

The `HTTP-Referer` and `X-OpenRouter-Title` headers are optional: they are only needed for the public app rankings on the OpenRouter site, and a study script doesn't need them. The `provider`, `models` and `reasoning` fields are specific to OpenRouter, so in the OpenAI SDK they are passed via `extra_body`.

This is the same `openai` client we have used for DeepSeek and Ollama since chapter 1.6. Let's put the three addresses into one table:

```python
PROVIDERS = {
    "deepseek":   {"base_url": "https://api.deepseek.com",     "key_env": "DEEPSEEK_API_KEY"},
    "ollama":     {"base_url": "http://localhost:11434/v1",    "key_env": None},   # any placeholder key
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY"},
}
```

In the `llm_utils.py` wrapper that we build in chapter 2.7 · Streaming, retries, rate limits, prompt caching (AIL-11), OpenRouter becomes just one more line of this configuration. That is the whole point of an OpenAI-compatible protocol.

### DeepSeek through OpenRouter and directly

| | DeepSeek directly | DeepSeek through OpenRouter |
|---|---|---|
| Model name | `deepseek-flash` (alias) | `deepseek/deepseek-v4.1-flash` (or the alias `~deepseek/deepseek-flash-latest`) |
| Where it runs | DeepSeek's servers (China) | depends on the chosen provider, visible in the Providers tab |
| Thinking mode | `extra_body={"thinking": {...}}`, `reasoning_content` | OpenRouter's unified `reasoning` parameter; the reasoning format may differ, we check the docs |
| Beta features (prefix, strict on `/beta`) | available | not guaranteed |
| Cache | automatic, `prompt_cache_hit_tokens` fields | visible as `cached_tokens`; works if the request reached a provider with caching |
| Price | DeepSeek's price list, off-peak discount | the specific provider's price + 5.5% when buying credits |

### Comparing our four providers from OpenRouter's point of view

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Available through OpenRouter | yes | yes | yes, plus third-party hosts | no: a local model, no router needed |
| What we lose through OpenRouter | some beta features, Batch API on its own terms | some Responses-specific features | the beta endpoint and its features | — |
| Cache through OpenRouter | needs `cache_control` | automatic | automatic | — |
| Free option | see the catalog | see the catalog | as of November 13, 2026, the DeepSeek section had no `:free`, see the catalog | always free |
| Data | Anthropic | OpenAI | DeepSeek or another host | our computer |

### What to use for the practice

- **Comparing 4–5 models:** OpenRouter (this is its main study role).
- **Baseline:** DeepSeek directly (`deepseek-flash`) and Ollama (`qwen3:4b`). The size of the local model depends on memory: with 8 GB of RAM, 3–4B-class models; with 16 GB, 7–8B; with 32 GB or more, 14B and larger.
- **The LLM judge**, if we grade answers with a model, must be stronger than the models being graded: for example, `deepseek-v4-pro` or a Claude/OpenAI model through OpenRouter.
- **Data:** public supplier messages about products and study questions. No customer data, event logs or shop database snapshots go to any cloud model.

## Learning path

1. [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart) (≈15 min). We take the base URL, the OpenAI SDK example and the model name format. We create an account and a key, **set a spending cap on the key right away** and put the key into `.env`.
2. [Model catalog](https://openrouter.ai/models) (≈20 min). We filter by price (free), by `supported_parameters` (tools, structured outputs) and by context. We open the DeepSeek model page and its Providers tab: how many hosts, what prices, speed, data policy. We pick 4–5 models for the practice and write down their exact slugs.
3. [Model variants](https://openrouter.ai/docs/guides/routing/model-variants) and [Limits](https://openrouter.ai/docs/api/reference/limits) (≈15 min). What we take: what each suffix means and the `:free` limits for our account.
4. [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection) and [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) (≈25 min). What we take: the fields of the `provider` object, `require_parameters`, who pays on a fallback.
5. [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging) and our own [Privacy settings](https://openrouter.ai/settings/privacy) (≈20 min). We check that logging and the use of data for training are off, and decide whether to allow free endpoints that may train on inputs. If we allow them, then only for public texts.
6. [Usage accounting](https://openrouter.ai/docs/guides/guides/usage-accounting), [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) (≈20 min). What we take: the `cost` field, the cache fields, why schemas need `require_parameters`.
7. [FAQ](https://openrouter.ai/docs/faq) → the sections on payment and BYOK (≈10 min).
8. Practice (≈1.5 h).

## What to watch out for

- **Free ≠ safe.** A `:free` model may train on our data. It is the same category as DeepSeek and Gemini's free tier: only public and study material.
- **Fallback to a paid model.** In `models`, a paid model comes after `:free`, and the bill grows unnoticed. We log `r.model` and `usage.cost` on every call.
- **Silently ignored parameters.** A provider without `response_format` support returns plain text. For schemas and tools we set `require_parameters: true` and validate the response with Pydantic as usual.
- **Different providers give different quality for the same model.** Quantization, template versions, context limits. If results "drift" between runs, it is worth checking whether the provider changed (Activity in the account) and pinning it with `provider.order`/`only` for the experiment.
- **Latency.** An extra hop adds time, and free endpoints are often overloaded. We measure TTFT and total time and don't trust our impressions.
- **429 on `:free`** comes quickly at 20 requests per minute. For now it is enough to run tasks sequentially with a pause; a semaphore and backoff are covered in chapter 2.7.
- **`~` aliases** are handy in a notebook and dangerous in project code. In eval runs we write the exact slug and save `r.model`.
- **Credits are non-refundable and may expire after a year.** We top up in small amounts.
- **This is not a replacement for direct integrations.** Anthropic's Batch API, DeepSeek's beta features and providers' fresh features may be unavailable through an aggregator.

## Practice

`exercises/week-02/openrouter/`: `compare.py`, `tasks.jsonl`, `results/`. The key is in `.env` (`OPENROUTER_API_KEY`); the key has a spending cap of $2–5.

- [ ] **1. Key and check.** We create a key with a cap and check `GET https://openrouter.ai/api/v1/key` (via `httpx` with `Authorization: Bearer`): `limit_remaining`, `is_free_tier`, `free_model_daily_requests`. In Privacy settings we turn off logging and training on our data.
- [ ] **2. Choosing models.** 4–5 models from the catalog: DeepSeek (`deepseek/deepseek-v4.1-flash` or the current slug), one Claude model and one OpenAI model (cheap ones), one open-weight model from another family (Qwen/Llama/Mistral), one free one (`openrouter/free` or a specific `:free`). We record the slug, price and providers in `notes/openrouter.md`.
- [ ] **3. Tasks.** `tasks.jsonl`, 3–4 tasks on **public** data with a checkable answer:
  - extracting `ProductUpdate` from two supplier messages from chapter 2.2 (we already have the reference answer);
  - classifying two texts from chapter 2.1;
  - one "reasoning" question, for example: a mug costs $12, its cost price is $7, the discount is 10%, the payment provider's fee is 2.5% of the amount paid. What is the profit on the order before shipping costs? (we check the answer ourselves: $10.80 − $7.00 − $0.27 = $3.53).
- [ ] **4. Comparison script.** For each model and task, `compare.py` makes a streaming request (as in `chat.py` from chapter 1.6: TTFT can only be measured on a stream, it is the moment the first chunk of text arrives) and writes to `results/run_<date>.jsonl` the fields `requested_model`, `answered_model` (`r.model`), the text, TTFT, total time, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`, `cost`. A skeleton:

```python
def run_one(model: str, messages: list[dict]) -> dict:
    t0 = time.perf_counter()
    ttft, parts, usage, answered = None, [], None, None
    stream = router.chat.completions.create(
        model=model, messages=messages, max_tokens=800, stream=True,
        extra_body={"provider": {"data_collection": "deny"}},
    )
    for chunk in stream:
        answered = answered or chunk.model
        if chunk.choices and chunk.choices[0].delta.content:
            ttft = ttft or time.perf_counter() - t0
            parts.append(chunk.choices[0].delta.content)
        if getattr(chunk, "usage", None):
            usage = chunk.usage                  # arrives with the last chunk
    # TODO: total time, cost = getattr(usage, "cost", None), token details
    ...
```

- [ ] **5. Baselines.** The same tasks directly through DeepSeek (`deepseek-flash`, thinking off) and through Ollama (`qwen3:4b`). These are two more rows in the table: "the same DeepSeek directly vs. OpenRouter" and "a local model".
- [ ] **6. Quality grading.** For extraction we compare the fields with the reference answer by hand (automatic field-by-field comparison, the `compare` function, comes in the next chapter, and then we can return to this run). Classification is compared with the label. The reasoning task we grade ourselves by whether the number is correct.
- [ ] **7. A table** in `notes/openrouter.md`:
  ```
  | model | answered (r.model) | provider | quality (of N) | TTFT, s | total, s | in/out tokens | $ per run | notes |
  ```
  Under the table, 4–5 conclusions: which is best on quality, which on price per correct answer, which is fastest, what the free option gave and what it cost (limits, latency, data policy).
- [ ] **8. Fallback and routing.** A request with `models=[<a nonexistent or deliberately unavailable slug>, "openrouter/free"]`: we look at who answered. Then the same request with `provider.sort = "price"` and `"throughput"` to an open-weight model: did the provider, time and price change?
- [ ] **9. Structured output through OpenRouter.** Extracting `ProductUpdate` with a `json_schema` `response_format` and `provider.require_parameters: true` for 2 models from the list. We compare with chapter 2.2: how many valid responses.

## Done when

- One prompt set has been run through 4–5 models on OpenRouter, plus DeepSeek directly and Ollama. A table with quality, latency (TTFT and total time), tokens and cost is in `notes/openrouter.md`.
- The OpenRouter key has a spending cap, logging and training on data are off, and nothing but public texts went to the cloud.
- We can explain when to use OpenRouter, when a direct provider and when Ollama, and what happens to the data on each path.

## Self-check quiz

1. What changes in the code when switching from DeepSeek directly to OpenRouter, if the `openai` package is used?
2. What does the `:free` suffix mean, and what are its limits for an account that has never bought credits?
   a) unlimited; b) 20 requests per minute and 50 per day; c) 1000 per day with no per-minute limit; d) only 10 requests in total
3. How do `:nitro` and `:floor` differ from `:free`?
4. A request passes `models=["some/model:free", "anthropic/<paid-model>"]`. The free model failed on a rate limit. What happens, and who pays for it?
5. Why do structured outputs through OpenRouter need `provider.require_parameters: true`?
6. What is wrong with this code?
   ```python
   client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key="sk-or-v1-3f9a...")
   for line in open("exports/order_events_2026-11-12.log"):
       client.chat.completions.create(model="openrouter/free",
           messages=[{"role": "user", "content": f"Explain this order event: {line}"}])
   ```
7. OpenRouter doesn't store prompts by default. Does that mean nobody will store our data?
8. Why record `r.model` in the comparison results if the model is specified in the request?
9. Which task is better done through OpenRouter, and which directly through DeepSeek?
   a) comparing 5 models: OpenRouter; using DeepSeek's beta prefix: directly; b) everything only through OpenRouter; c) everything only directly; d) comparing models: directly with each provider, with five keys
10. Where on OpenRouter is the cost of a specific request visible?
11. The same open-weight model through OpenRouter answered better yesterday than today. What are two likely causes related to routing?
12. Why doesn't Ollama need OpenRouter, and in what situation can OpenRouter replace it for study, and in what situation can it not?

## Answers

1. `base_url` (`https://openrouter.ai/api/v1`), the key (`OPENROUTER_API_KEY`) and the model name (`deepseek/...`). OpenRouter-specific parameters (`provider`, `models`, `reasoning`) are passed via `extra_body`.
2. **b.** 20 requests per minute and 50 per day to `:free` models. After buying $10 or more in credits, the daily limit becomes 1000.
3. `:free` is a separate free catalog entry with its own limits. `:nitro` and `:floor` are routing variants for any model: sorting providers by speed or by price.
4. OpenRouter moves to the next model in `models`, the paid Anthropic one, and the request is billed at its price. To keep a request free, we list only `:free` models.
5. Support for `response_format`/`json_schema` depends on the endpoint. Without the flag the request can go to a provider that silently ignores the parameter. With the flag it reaches only those that support it.
6. The key is hardcoded. The order event log (it can contain customer data) is sent to a free cloud model that may train on inputs (a violation of the course rule: such data goes only to Ollama). There is no request limit, semaphore or 429 handling. The log line isn't wrapped in tags. The result isn't saved.
7. No. OpenRouter may not store it, but the provider the request went to follows its own policy: it may store it for abuse prevention or train on the data. We need `data_collection: "deny"`, `zdr` and the privacy settings, and for real data only a local model.
8. Because of fallbacks and aliases, a different model may have answered. Without `r.model` the comparison may turn out to compare the wrong models.
9. **a.** An aggregator is good for breadth: one key is enough for many models. A provider's specific features are more reliable directly.
10. In the response's `usage.cost` (in credits), and also in the account's Activity and via the generation endpoint by the response `id`.
11. The request went to a different provider (load balancing or a fallback) with a different quantization or different settings. Or an alias pointed to a new version of the model. For experiments we pin the provider (`order`/`only`) and the exact slug.
12. Ollama runs locally, it doesn't need a router, and that is its point: the data doesn't leave our computer. OpenRouter can replace it for trying large open-weight models on public data, if such models don't fit in our memory. For customer data, the order event log and embeddings of our own data it can't replace it.

## What's next

Next is [2.5 · The first eval: extracting JSON from 20 texts (AIL-9)](AIL-9.md): we measure field-level extraction quality, and `compare.py` from this chapter lets us run the same eval through several models. Production-level fallbacks and budgets come back in chapter 11.2 · Prompt caching, budgets, fallbacks (AIL-45).
