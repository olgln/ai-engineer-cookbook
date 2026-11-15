# 1.7 · Tokens, temperature and the cost of an LLM request  (AIL-5)

> **Week 1** · LLM basics · ⏱ ~4 h · Practice

<!-- description: What a token is, where randomness in LLM answers comes from and what a request costs: temperature, token counting and estimating the price before a call. -->
<!-- source-sha256: 88fa59555574 -->

## Why an AI engineer needs this

An LLM product pays for every token, and the bill grows unnoticed: a long system prompt × thousands of requests × the dialog history. An engineer who sees the price of a request from day one makes different decisions (a shorter prompt, a cheaper model, a cache). The second question is randomness: an interview will almost certainly ask "why does the model answer the same thing differently, and how do we control it".

In chapter 1.6 (AIL-4) we saw the `usage` field in every response and noticed that answers to the same question differ. Here we sort out both: what tokens and their price are made of, and where the spread comes from. Both topics start with one concept — the token.

## Theory

### What a token is

In chapter 1.5 (AIL-3) the token appeared as the unit in which price and context are counted. Now let's look at how text is cut into them. A model sees neither letters nor words but **tokens** — pieces of text from a fixed vocabulary (usually 100–200 thousand entries). The vocabulary is built by the BPE (Byte Pair Encoding) algorithm: it starts from bytes and repeatedly merges the most frequent pairs. Hence:

- frequent English words are one token (` the`, ` price`);
- rare words are cut into pieces (` delivery` may be one token, while its Russian counterpart `доставка` takes three or four);
- a space is usually glued to the start of a word;
- numbers are cut unpredictably (`12345.67` is several tokens).

```
"Delivery is free today"   → [Delivery][ is][ free][ today]           ≈ 4 tokens
"Доставка бесплатная"      → [Д][ост][авка][ бес][платная]            ≈ 5+ tokens
```

(The split is illustrative — each tokenizer has its own.)

Consequences that matter in practice:

1. **Non-English text, e.g. Russian, is "more expensive".** Tokenizer vocabularies have historically been optimized for English; the same thought in another language usually takes noticeably more tokens. How many more, we measure in the practice.
2. **Models are bad at counting letters** ("how many r's in strawberry"): the model doesn't see letters, it sees tokens.
3. **Each provider has its own tokenizer.** `tiktoken` counts tokens for OpenAI models, and only for them. For Claude we need Anthropic's token counting endpoint (`client.messages.count_tokens(...)`) or the `usage` field in the response. Even different generations of Claude have different tokenizers — when switching models, the token count for the same texts may change.

The rough rule for English is ~4 characters per token; for other languages, e.g. Russian, the ratio is worse. But the rule is for back-of-the-envelope estimates; in code we count exactly.

### Where randomness comes from

A model generates an answer one token at a time. At each step it outputs not a word but a score for every token in the vocabulary — numbers called **logits** (the bigger, the more likely the token). The softmax function turns the logits into a **probability distribution** over the whole vocabulary: "the next token is ` mug` — 41%, ` cup` — 32%, ` teapot` — 9%, ...". Then a token is chosen — this is **sampling**. The chosen token is appended, and the step repeats.

```
logits ──► softmax(logits / T) ──► [top_p cutoff] ──► random choice ──► token
```

- **temperature (T)** divides the logits before softmax. T → 0: the distribution becomes "sharp", the most likely token is almost always taken (greedy). T = 1: the original distribution. T > 1: "flat", unlikely tokens come up more often — more variety and more nonsense.
- **top_p (nucleus sampling)**: we take the minimal set of the most likely tokens whose probabilities sum to ≥ p and drop the rest. top_p = 0.9 cuts off the "long tail" of strange options.
- **top_k**: keep only the k most likely tokens.

All three together are called sampling parameters. A mini example in plain Python (no API, just to get a feel):

```python
import math, random
from collections import Counter

logits = {"mug": 2.0, "cup": 1.7, "teapot": 0.5, "rocket": -1.0}

def sample(logits: dict[str, float], t: float) -> str:
    if t == 0:
        return max(logits, key=logits.get)          # greedy
    exps = {k: math.exp(v / t) for k, v in logits.items()}
    total = sum(exps.values())
    r, acc = random.random(), 0.0
    for k, e in exps.items():
        acc += e / total
        if r <= acc:
            return k
    return k

for t in (0, 0.5, 1.0, 2.0):
    print(t, Counter(sample(logits, t) for _ in range(1000)))
```

An important caveat: **temperature 0 does not guarantee determinism.** Because of parallel GPU computation, request batching and model updates, the same request sometimes gives slightly different answers. Reproducibility in production comes not from temperature but from logs, a pinned model version and evals.

### Important news of 2025–2026: temperature is leaving the APIs

The classic randomness knob is temperature, but the big cloud providers increasingly don't have it. This is what old tutorials lack. In reasoning models (which "think" before answering) sampling is controlled by the provider itself:

- **Anthropic:** new Claude models accept only the default values, and in API version `2026-10-21` a request with `temperature`, `top_p` or `top_k` returns 400 **on any model**; new Python SDKs no longer accept these parameters. Instead, quality/cost is tuned with the `effort` parameter (how deeply the model thinks) and with the prompt.
- **OpenAI:** reasoning models (the o-series and GPT-5 families) don't accept an arbitrary `temperature` either; non-reasoning models support it. Which ones exactly is shown on the specific model's page.

Why learn temperature then? Because (1) it appears in all open-weight models (Llama, Qwen, Mistral via Ollama/vLLM) and in many other people's projects; (2) understanding sampling explains "why the model sometimes answers differently" — that hasn't gone anywhere, the knob was just removed; (3) it is an interview question. The practical takeaway for the experiment: we take a model that still accepts the parameter (a non-reasoning OpenAI model or a local model) and check in the documentation that the parameter is supported.

**When low / when high randomness** (the classic rule; on models without the knob the same is achieved with the prompt and a schema):

| Task | Randomness | Why |
|---|---|---|
| Data extraction, classification, JSON | low (T≈0) | One correct answer is needed; variety = errors |
| Code, SQL | low | Syntax doesn't like creativity |
| Answering questions over documents | low–medium | Accuracy matters more than style |
| Ideas, naming, texts for posts | high (0.7–1.0) | A variety of options is needed |
| Generating synthetic test data | high | Coverage of different cases is needed |

### How the price works

The chapter's second topic is money. We already know that `usage` in the response splits tokens into input and output; the price is computed from the same numbers. Providers charge per **million tokens** (MTok), separately for input and output:

```
cost = input_tokens / 1e6 * price_in + output_tokens / 1e6 * price_out
```

For example, for a model priced at $1 / $5 per MTok, a request with 2,000 input and 500 output tokens costs 2000/1e6·1 + 500/1e6·5 = $0.002 + $0.0025 = **$0.0045**. That is roughly what an answer to one message to the shop's support costs (a system prompt, the delivery rules, the customer's question — and a short answer); 1,000 such messages — **$4.50**. Pennies — until we multiply by 100,000 requests a day.

Nuances that break the naive formula:

1. **Output is several times more expensive than input** (typically 4–5 times). Generation is sequential and expensive for the GPU; reading is parallel.
2. **Thinking (thinking/reasoning) is billed as output**, even if it isn't visible in the answer. A reasoning model may "think" for a thousand tokens on a simple question.
3. **Prompt caching**: the provider remembers the beginning (prefix) of recent requests, and reading that prefix again costs less. Input tokens read from the cache cost ~10% of the price, while writing to the cache costs more than usual (chapter 2.7 (AIL-11)). In `usage` these are separate fields (`cache_read_input_tokens`, `cache_creation_input_tokens` at Anthropic; `cached_tokens` in the usage details at OpenAI).
4. **Pricing can be tiered**: for some models the price per token is higher if the prompt is longer than a threshold (for example, 100K or 200K tokens).
5. **Batch API** — usually −50% for asynchronous processing: requests are sent in a batch, and the results arrive within hours (chapter 2.7 (AIL-11)).
6. **Prices change.** We never hardcode them deep in the code without a date. The price table lives in one place with a "checked YYYY-MM-DD" comment and a link to the pricing page.

A function that will live in all our projects:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Price:
    input: float          # USD per 1M input tokens
    output: float         # USD per 1M output tokens
    cache_read: float | None = None
    cache_write: float | None = None

# Source: provider pricing pages, checked on YYYY-MM-DD. Fill in yourself.
PRICES: dict[str, Price] = {
    # "claude-haiku-5-5": Price(input=..., output=...),
    # "gpt-5-mini":       Price(input=..., output=...),
}

def estimate_cost(model: str, input_tokens: int, output_tokens: int,
                  cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float:
    p = PRICES[model]   # KeyError on purpose: unknown model must not cost $0
    ...
```

Note the `KeyError` "on purpose": if the function returns 0 for an unknown model, we can spend a month thinking everything is free.

Let's agree on what the arguments mean: `input_tokens` is input **not** read from the cache (at full price), `cache_read_tokens` and `cache_write_tokens` are the parts of the input read from the cache and written to it. Providers lay out `usage` differently, and before the call we map their fields to this scheme: at Anthropic `input_tokens` already excludes the cache, at OpenAI `cached_tokens` is included in the total `input_tokens` and has to be subtracted, at DeepSeek miss and hit are given separately (below).

### Estimating before the request

`estimate_cost` computes from `usage`, that is, after the request. Sometimes the cost is needed in advance (for example, "will this document fit into the context and the budget"):

- Anthropic: `client.messages.count_tokens(model=..., system=..., messages=[...]).input_tokens` — the exact number of input tokens for a specific model, without generation.
- OpenAI: `tiktoken` — locally, without the network: `tiktoken.encoding_for_model(model)` or `tiktoken.get_encoding("o200k_base")` for modern models; the token count is `len(enc.encode(text))`. The service tokens of the message markup add a little on top.

Output isn't known in advance — it is estimated from history (the median `output_tokens` for such requests) and capped with `max_tokens`.

## DeepSeek and Ollama: how we do it

The good news: the temperature experiment that is no longer possible on Claude can be done honestly on DeepSeek and Ollama. Both even let us look into the probability distribution itself — via `logprobs`, the log probabilities of the chosen token and its closest alternatives. Next we go through the theory topics: randomness, price, token counting.

### Temperature at DeepSeek: works, but not always

(Based on the [API Reference](https://api-docs.deepseek.com/api/create-chat-completion) and the [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) guide as of November 13, 2026 — worth rechecking.)

- `temperature` from 0 to 2, default 1 — but it **works only in non-thinking mode**. In thinking mode (and it is on by default!) `temperature`, `presence_penalty`, `frequency_penalty` are **silently ignored**: no error, no effect. Compare with Claude, where the same request gives 400 — a loud error is better than a silent one; here it is easy to "run an experiment" and measure noise.
- `top_p` in `deepseek-flash` without thinking is fixed at 1.0 (the passed value is ignored); in `deepseek-v4-pro` without thinking it works. There is no `top_k` knob.
- `logprobs=True` and `top_logprobs` (up to 20) are available: we can see the alternatives for each token of the answer.

```python
import math   # deepseek = OpenAI(...) client from chapter 1.6

r = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "Name a support bot for a small online home goods shop. Name only."}],
    temperature=1.0,
    max_tokens=20,
    logprobs=True, top_logprobs=5,
    extra_body={"thinking": {"type": "disabled"}},   # otherwise temperature has no effect
)
first = r.choices[0].logprobs.content[0]
for alt in first.top_logprobs:
    print(repr(alt.token), round(math.exp(alt.logprob), 3))   # real next-token distribution
```

### Temperature at Ollama: full control

A local model accepts everything classic: `temperature`, `top_p`, `top_k`, `seed` (in the native API — in `options`; via the OpenAI-compatible endpoint — `temperature`, `top_p`, `seed`). `seed` + the same request on the same machine usually give the same answer — handy for experiments, though this isn't an ironclad guarantee either. The native `/api/chat` also supports `logprobs` / `top_logprobs` (in OpenAI-compatible mode `logprobs` is not supported).

```python
import ollama   # official client from chapter 1.6

resp = ollama.chat(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "Name a support bot for a small online home goods shop. Name only."}],
    think=False,
    options={"temperature": 1.0, "top_k": 40, "seed": 7},
)
```

For "thinking" local models (qwen3 and others) we turn thinking off (`think=False`), otherwise the answer contains the reasoning and the spread is awkward to measure.

### Price at DeepSeek: three rates and the time of day

DeepSeek prices input differently depending on whether the prefix hit the cache (the cache is automatic, nothing needs to be turned on) and gives a 50% discount outside peak hours. Prices per 1M tokens as of November 13, 2026 ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)):

| Model | Input, cache hit | Input, cache miss | Output | When |
|---|---|---|---|---|
| `deepseek-flash` | $0.006 | $0.30 | $1.20 | peak |
| `deepseek-flash` | $0.003 | $0.15 | $0.60 | off-peak |
| `deepseek-v4-pro` | $0.044 | $1.32 | $3.96 | peak |
| `deepseek-v4-pro` | $0.022 | $0.66 | $1.98 | off-peak |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays (except Chinese holidays); the rest of the time and weekends are cheaper. In New York time (winter time, UTC−5) the peak is 20:00–23:00 Sunday through Thursday and 01:00–05:00 Monday through Friday; in summer (UTC−4) it is an hour later. So runs during New York working hours and almost all weekends go at half price; in other time zones the windows are worth recalculating from UTC. These figures are only an example; prices change, so we put them into `PRICES` with a date.

DeepSeek's `usage` carries everything needed: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` (together = `prompt_tokens`), `completion_tokens` and, inside, `completion_tokens_details.reasoning_tokens` (thinking is already included in `completion_tokens`). In terms of `estimate_cost`: a miss is `input_tokens`, a hit is `cache_read_tokens`; there is no separate charge for cache writes. The formula:

```python
cost = (hit / 1e6 * p.cache_read + miss / 1e6 * p.input + out / 1e6 * p.output)
# and p depends on the time of the request (peak / off-peak) for DeepSeek
```

So `estimate_cost` for DeepSeek has to know the time of the request: we add a last optional argument `at` (the request time in UTC), and in `PRICES` we store two prices for DeepSeek models — peak and regular. Ollama costs $0 per token — but it isn't "free": we pay with time (tokens/s on our machine) and memory. For Ollama we log not money but speed: `eval_count / (eval_duration / 1e9)` tokens/s.

### Token counting for our providers

What remains is the estimate before the request: the tools from the theory (`tiktoken`, `count_tokens`) don't fit our providers.

- **DeepSeek:** there is no token counting endpoint. The exact number comes only from `usage` after the request; the documentation gives an estimate of "~0.3 tokens per English character, ~0.6 per Chinese one" (there is no figure for other languages such as Russian — we measure it). There is an offline tokenizer as a zip archive on the [Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage) page — it is code to run, so per the course rules it goes to quarantine and gets read first, or we simply make do with `usage` (a 500-character request costs a fraction of a cent).
- **Ollama:** input tokens are `prompt_eval_count`, output tokens are `eval_count` in the native response (or `usage` in compatible mode). Each local model has its own tokenizer.
- **tiktoken** fits neither DeepSeek nor Ollama models — just as it doesn't fit Claude.

### Comparison

| Capability | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| `temperature` | no (new models/API version — 400) | non-reasoning models only | yes, but only without thinking; silently ignored in thinking mode | yes |
| `top_p` / `top_k` | no | `top_p` on some models | `top_p` depends on model and mode; no `top_k` | both, in `options` |
| `seed` | no | see the model's docs | not documented | yes |
| `logprobs` | no | on some models | yes, up to 20 alternatives | native API — yes; compatible — no |
| "Depth" knob | `effort` | `reasoning.effort` | `reasoning_effort` (`low`/`high`/`max`) + thinking on/off | `think` (depends on the model) |
| Counting before the request | `count_tokens` | `tiktoken` locally | no (only `usage`, offline archive) | no separate one, only after the fact |
| Cache discount | read ~0.1×, write costs more | automatic | automatic, a hit ≈ 1/50 of the miss price | — (local) |
| Batch | −50% | −50% | no Batch API in the docs; there is an off-peak discount | — |

### What to use for the practice

- **The temperature experiment** — main: DeepSeek `deepseek-flash` with thinking turned off; second line — Ollama `qwen3:4b` with `think=False` and a fixed `seed`.
- **The next-token distribution** — `top_logprobs` at DeepSeek or in Ollama's native API: this is the real version of the toy `sample()`.
- **Non-English vs English tokens** — DeepSeek's `usage` and Ollama's `prompt_eval_count` (both count with their own tokenizers); `tiktoken` and Anthropic's `count_tokens` — for comparison.
- The texts for the experiment are public (delivery rules from any shop's website, a piece of a README). Customer messages and the order event log go only to Ollama.

## Learning path

1. [Let's build the GPT Tokenizer — Karpathy](https://www.youtube.com/watch?v=zduSFxRajkE) (video ~2 h 13 min; at 1.25x about 1 h 45 min). If time is short, the first ~25 minutes (why tokenization, Unicode, bytes) and the final block on the LLM "weirdnesses" that tokenization explains are enough. What we take from it: BPE, why non-English languages and numbers tokenize worse, why models are bad at counting letters.
2. We open OpenAI's web tokenizer [platform.openai.com/tokenizer](https://platform.openai.com/tokenizer) (≈10 min): we paste one phrase in English and in another language (e.g. Russian), a number and a product SKU like `MUG-NORTH-350`. We look at where the text is cut.
3. [tiktoken](https://github.com/openai/tiktoken) → README (≈15 min): how to get the encoding for a model and count tokens. Note: this is about OpenAI models only.
4. Anthropic documentation → the Token counting page ([docs.anthropic.com/en/docs/build-with-claude/token-counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)) (≈15 min): how to call the count and what it accepts (system, tools, images).
5. Pricing pages (≈20 min): [Anthropic Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) and [OpenAI API Pricing](https://openai.com/api/pricing). We write the prices of two or three models we use into `PRICES`, with a date. On the Anthropic page we find the lines about cache reads/writes and batch.
6. In the OpenAI documentation, on the page of the model chosen for the temperature experiment, we check whether the parameter is supported (≈5 min). In the Anthropic documentation we look at `effort` in the description of the Messages API / adaptive thinking — this is the knob that took the place of "creativity" in Claude.
7. DeepSeek (≈30 min): [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) — we write down the cache hit/miss/output prices and the peak hours; [Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage) — how tokens are counted; in [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) we find `temperature`, `top_p`, `logprobs`, `top_logprobs` and the notes on which mode they work in; in [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) — the list of parameters that don't work in thinking mode.
8. Ollama (≈15 min): [Chat API](https://docs.ollama.com/api/chat) — `options` (`temperature`, `top_p`, `top_k`, `seed`, `num_predict`), `logprobs`, the `prompt_eval_count`/`eval_count` fields and the durations in nanoseconds; on the [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) page — which of these parameters are available in compatible mode.

## What to watch out for

- **We don't confuse `max_tokens` with a budget.** `max_tokens` is the ceiling of one answer, not a money limit. The budget is our code that sums `estimate_cost` across calls.
- **A silently ignored parameter is worse than a 400.** DeepSeek in thinking mode and Ollama in OpenAI-compatible mode (`logprobs`, `tool_choice`) accept the parameter without an error and do nothing with it. Before an experiment we check the documentation for whether the knob works in this mode.
- **DeepSeek's price depends on the hour.** When comparing the cost of two runs, we check that both were in the same pricing window (peak/off-peak) — otherwise a "2x" difference turns out to be just the time of day.
- **tiktoken for Claude is a mistake.** The numbers will look similar but won't match, and on non-English text the discrepancy can be noticeable.
- **Thinking tokens.** If the model has thinking on, `output_tokens` includes it. A "short" answer can cost as much as a long one.
- **5 runs is a small sample.** For "spread" that's fine; for conclusions about quality it isn't (that's the topic of evals: chapter 2.5 · The first eval: extracting JSON from 20 texts (AIL-9) and week 6).
- **Temperature 0 ≠ identical answers.** If in the experiment the answers at T=0 differ slightly, it isn't a bug; it's the reality of GPU inference.
- **How this breaks in production:** a silently growing prompt. Someone added the shop's whole knowledge base to the support bot's system prompt "just in case", and the average request grew from 800 to 12,000 tokens. Without logging `usage` on every call, this is discovered from the bill at the end of the month.
- **We compare models by the price of the task, not of the token.** A model half as cheap per token that needs three attempts is more expensive.

## Practice

Code goes into `exercises/week-01/`. The model for the temperature experiment — the main one: DeepSeek `deepseek-flash` **with thinking turned off** (otherwise temperature is ignored); the second: Ollama (`qwen3:4b`, `think=False`), installed in chapter 1.5 with a signature check. A non-reasoning OpenAI model is optional, for comparison.

- [ ] **1. Toy sampling.** We run the `sample()` example from the theory for T = 0 / 0.5 / 1 / 2, 1000 times each. We write down the distributions. It should be visible: at T=0 it is always `mug`, at T=2 `rocket` shows up noticeably more often.
- [ ] **2. The temperature experiment.** `exercises/week-01/temperature.py`: a question with room for variation, for example "Come up with a name for the support bot of a small online home goods shop. Answer with the name only." For T ∈ {0, 0.5, 1} (DeepSeek and Ollama can add 1.5) — 5 runs each on DeepSeek and on Ollama. We save everything to `results/temperature.jsonl` (provider, model, temperature, run, text, input_tokens, output_tokens).
- [ ] **2b. The thinking trap.** We repeat step 2 on DeepSeek **without** `thinking: disabled` for T=0 and T=1.5. There will be no error. Is there a difference in spread? We write down the conclusion: where a parameter is silently ignored, an experiment "proves" anything — we always check in the documentation whether the knob works in this mode.
- [ ] **2c. The real distribution.** For the question from step 2 we request `logprobs=True, top_logprobs=5` from DeepSeek (without thinking) and in Ollama's native API. We print the top 5 for the first token with probabilities `exp(logprob)` and compare with the toy from step 1. We see how they change at T=0.2 and T=1.5 (hint: logprobs usually reflect the distribution before sampling — worth checking whether that holds for the specific provider).
- [ ] **3. A second, "factual" question.** "How many grams of tea are in a 0.25 kg pack? Answer with a number." The same 3 × 5 runs. We compare: on the factual question the spread should be smaller at any T.
- [ ] **4. A measure of spread.** For each T we count the number of unique answers out of 5 (after `strip().lower()`). Crude, but clear.
- [ ] **5. `estimate_cost`.** We implement the function from the theory in `exercises/week-01/cost.py` and fill in `PRICES` with the date checked: both DeepSeek models (peak and off-peak, cache hit and miss), the Ollama model with price 0 and, if we use them, Claude/OpenAI. For DeepSeek the function takes the request time `at` (UTC) and picks the rate itself. Tests: for a model priced at $1/$5 and 2000/500 tokens the result should be 0.0045 (and 1000 such support answers — 4.5); for DeepSeek a request on Wednesday at 08:00 UTC costs twice as much as the same request on Saturday. We add an `assert`.
- [ ] **5b. Ollama speed.** For 5 runs on Ollama we compute tokens/s (`eval_count / eval_duration * 1e9`) and the model load time (`load_duration`) on the first and subsequent requests. We add a "tok/s" column to the table from step 6.
- [ ] **6. Summary table.** The script prints a Markdown table:

```
| temperature | question | unique answers out of 5 | avg output_tokens | cost of 5 runs, $ |
|---|---|---|---|---|
| 0   | name | 1 | 6 | 0.00002 |
| ... |
```

- [ ] **7. Non-English vs English.** `exercises/week-01/tokens_ru_en.py`: we take 3 texts of 300–500 characters (for example, a paragraph of delivery or return rules from a shop's website, a product description, a piece of a README) in two versions — English and another language (e.g. Russian). We count tokens: the main source is DeepSeek's `usage.prompt_tokens` and Ollama's `prompt_eval_count` (we subtract the tokens of an empty request to remove the chat's service markup); for comparison — `tiktoken` (`o200k_base`) and Anthropic's `count_tokens`. Table: text × language × tokenizer × tokens × tokens per character. We print "the non-English text is X times more expensive" for each tokenizer. The texts are public; a real customer message, if there is one, goes only to Ollama.
- [ ] **8. Conclusion.** In `notes/temperature-cost.md`, 5–7 lines: when low randomness is needed and when high; how many times output is more expensive than input for the chosen models; how many times the non-English text is more expensive than English; what to do on models where temperature doesn't exist or is silently ignored; how much DeepSeek saves off-peak.

## Done when

- There is a temperature × answer spread × cost table (step 6) and a non-English/English token table (step 7).
- `estimate_cost(model, input_tokens, output_tokens)` lives in a separate module, is covered by at least one `assert`, the prices are labeled with a date and a source; for DeepSeek cache hits and peak hours are taken into account.
- We have seen the real next-token distribution (`top_logprobs`) for at least one provider.
- The conclusion is written in `notes/temperature-cost.md`: low randomness — data extraction, classification, code; high — ideas, texts, synthetic data.

## Self-check quiz

1. What does temperature do to the probability distribution of the next token?
   a) changes the model's vocabulary; b) divides the logits before softmax, making the distribution sharper or flatter; c) limits the length of the answer; d) selects the model
2. What is top_p = 0.9?
3. Why does the same phrase in a non-English language such as Russian usually take more tokens than in English?
4. At T=0, two slightly different answers came back for the same request. Is this an SDK bug?
5. A request: 10,000 input, 1,000 output, price $3 / $15 per MTok. How much does the request cost?
6. What is wrong with this code?
   ```python
   import tiktoken
   enc = tiktoken.get_encoding("o200k_base")
   def claude_cost(prompt: str) -> float:
       return len(enc.encode(prompt)) / 1e6 * PRICE_IN["claude-haiku-5-5"]
   ```
7. A request to a new Claude model with `temperature=0.2` returned 400. Why, and what should be done?
8. Why do models answer "how many letters r are in the word strawberry" poorly?
9. Which temperature (low/high) fits: (a) extracting the order total from a customer's email; (b) generating 20 variants of a post about a new mug collection; (c) generating SQL?
10. Why should the `estimate_cost` function fail on an unknown model rather than return 0?
11. A model half as cheap per token gave a correct answer in 50% of cases, the expensive one in 95%. An error is detected and the request is retried. Which is cheaper "per correct answer" if the output is the same?
12. Requests were sent to `deepseek-flash` with `temperature=0` and `temperature=1.5` and no other parameters; there are no errors, and the spread of answers is the same. Why?
    a) DeepSeek doesn't support temperature at all; b) thinking mode is on by default, and temperature is silently ignored in it; c) temperature works only above 1.0; d) a `seed` is needed
13. A request to DeepSeek: 10,000 input tokens, 8,000 of them cache hits, 1,000 output. Prices (illustrative): hit $0.01, miss $0.30, output $1.20 per MTok. How much does the request cost? And what if there were no cache?
14. Why is Ollama the best provider in this course for the sampling experiment, and why doesn't its "$0 per token" mean "free"?

## Answers

1. **b.** The logits are divided by T: a small T amplifies the difference between options, a large one smooths it out.
2. Sampling only from the minimal set of the most likely tokens with a total probability ≥ 90%; the unlikely "tail" is dropped.
3. BPE vocabularies were built on corpora dominated by English: frequent English words became whole tokens, while words of other languages, such as Russian, are cut into pieces.
4. No. Parallel GPU computation and batching produce slight nondeterminism even with greedy selection.
5. 10,000/1e6·3 + 1,000/1e6·15 = 0.03 + 0.015 = **$0.045**.
6. tiktoken is OpenAI's tokenizer, so the count for Claude is inaccurate (`count_tokens` or `usage` is needed); only input is counted, although output is more expensive; and the system prompt, history and thinking tokens aren't taken into account.
7. New Claude models accept only default sampling, and API version `2026-10-21` rejects these parameters on any model. Remove the parameter; control the behavior with the prompt, an output schema and `effort`.
8. The model sees tokens, not letters: `strawberry` is one or two tokens, and their internal "letter" structure isn't directly visible to the model.
9. (a) low, (b) high, (c) low.
10. A zero price silently hides spending; a failure immediately forces adding the price of the new model.
11. The expected number of attempts: cheap 1/0.5 = 2, expensive 1/0.95 ≈ 1.05. The price per correct answer: cheap 2 × 0.5 = 1.0 conventional unit, expensive 1.05 × 1 ≈ 1.05 — almost the same; and if errors aren't detected automatically, the cheap model costs much more.
12. **b.** DeepSeek's thinking mode is on by default, and `temperature` has no effect in it — with no error. Thinking needs to be turned off (`thinking: disabled`) and the test repeated.
13. 8,000/1e6·0.01 + 2,000/1e6·0.30 + 1,000/1e6·1.20 = 0.00008 + 0.0006 + 0.0012 ≈ **$0.0019**. Without the cache: 10,000/1e6·0.30 + 0.0012 = **$0.0042** — the cache saved more than half.
14. It accepts all the classic knobs (`temperature`, `top_p`, `top_k`, `seed`) and returns `logprobs` in the native API, and the data doesn't leave the machine. We pay with memory, disk, generation time (tokens/s on our machine) and the quality of a small model.

## What's next

Next is week 2 and the main lever of quality — [2.1 · Prompting: roles, few-shot, structure (AIL-7)](AIL-7.md). The `estimate_cost` function comes in handy right there, when comparing prompt versions, and becomes part of `llm_utils.py` in [2.7 · Streaming, retries, rate limits, prompt caching (AIL-11)](AIL-11.md).
