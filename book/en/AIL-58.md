# 2.3 · How to choose an LLM: models and providers  (AIL-58)

> **Week 2** · LLM basics · ⏱ ~1.5 h · Theory

<!-- description: How to choose an LLM for a task: price, latency, quality, context window, reasoning and open-weight models, benchmarks and what runs on a laptop. -->
<!-- source-sha256: e404f71454f9 -->

## Why an AI engineer needs this

Choosing a model is one of the first architectural decisions in any LLM project, and price, latency, quality and even legal constraints (where the data is processed) depend on it. A typical interview question: "Why did you pick this model and not another one? What will you do if it gets more expensive or is deprecated?" The answer "it's the top one on the leaderboard" doesn't count; we need an argument tied to the task.

## Theory

### The market in one minute

So far we have worked with four providers — DeepSeek, Ollama, Claude and OpenAI — and taken the "default" model. To choose deliberately, we first look at the whole market. It splits into two parts. **Closed models** are available only through their lab's API (or a partner cloud): nobody sees the weights. **Open-weight models** are published together with their weights, the files with the parameters of the trained network; they can be downloaded and run on our own hardware (this is how Ollama works) or rented from a hosting provider. Frontier labs are the ones whose models set the upper bar of quality.

```
                  ┌──────────── closed (API only) ──────────────────────┐
Frontier labs:         Anthropic (Claude) · OpenAI (GPT, o-series) · Google (Gemini) · xAI (Grok)
                  └──────────────────────────────────────────────────────┘
                  ┌──────────── open-weight (weights downloadable) ─────┐
                       Meta (Llama) · Alibaba (Qwen) · Mistral · DeepSeek · Google (Gemma) ...
                  └──────────────────────────────────────────────────────┘
Where to run open-weight: a local GPU / Mac (Ollama, LM Studio, llama.cpp, MLX),
  the cloud (vLLM on a rented GPU), hosting aggregators (Together, Fireworks, Groq, OpenRouter ...)
Where else closed models are available: clouds — AWS Bedrock, Google Vertex AI, Azure/Microsoft Foundry
```

Inside each family there is a **lineup by size**: a small, fast, cheap model, a mid-sized "workhorse" and a large flagship. At Anthropic these are Haiku / Sonnet / Opus (plus a top tier above Opus), at OpenAI `nano` / `mini` / full-size, at Google Flash-Lite / Flash / Pro. The price difference between a provider's smallest and largest model is tens of times.

That makes dozens of candidates, and comparing them "in general" is pointless. They are compared along axes: the properties that matter for a specific task.

### The axes for comparing models

| Axis | What it is | Where to look |
|---|---|---|
| **Quality** | How well it solves *our* task | Benchmarks, Arena, but above all our own evals |
| **Price** | $ per 1M input / output tokens; there are discounts for caching (a repeated prompt prefix) and batch (unhurried bulk processing, chapter 2.7) | Providers' pricing pages |
| **Latency** | TTFT (time to first token) and speed (tokens/s) | Artificial Analysis, our own measurements |
| **Context window** | How many tokens fit into the input (currently from ~128K to 1M+) | The model page |
| **Maximum output** | How much the model can generate in one response | The model page |
| **Modalities** | Text, images, PDF, audio, video on input; what comes out | The model page |
| **API features** | Tool calling, structured outputs, caching, batch, streaming | API documentation |
| **Data and compliance** | Where it is processed, whether it is stored, ZDR (Zero Data Retention: the provider stores nothing), regions | Provider and cloud policies |
| **Stability** | How often the model is changed or retired (deprecation) | Deprecation pages |

Two axes need explaining: "quality" depends heavily on whether the model thinks before answering, and the "context window" is deceptively large. We cover them, and then where to get the numbers for quality.

### Reasoning models vs regular ones

A **reasoning model** generates internal reasoning (thinking/reasoning tokens) before answering: the same as "think step by step", but trained specifically and often hidden from the user. Pros: noticeably stronger at math, code, multi-step planning and agentic tasks. Cons: more tokens (the reasoning is billed as output), higher latency, and sampling (`temperature` and the other knobs from chapter 1.7) can't be tuned.

The line is blurring: modern flagships are hybrids that think "when needed" (adaptive thinking in Claude), and the depth is controlled by a parameter like `effort` / `reasoning.effort`. A practical rule: **for extraction, classification and short answers, low effort or a small model; for code, planning and agents, higher.** And we check it by measuring: on simple tasks high effort often costs more with no gain.

### Context window: large ≠ free and ≠ perfect

1M tokens is several thousand pages. But:
- every input token is paid for **in every request** (caching helps, chapter 2.7);
- latency grows with input length;
- models differ in how well they find a "needle" in a long context, and it is usually worse in the middle of a very long input;
- some models charge more per token once the prompt is longer than a threshold.

That is why RAG (finding the relevant pieces and passing only them) didn't die when large windows appeared: it is a matter of price, speed and accuracy.

### Benchmarks and leaderboards: how to read them

- **Academic benchmarks** (MMLU-style knowledge, GPQA, SWE-bench for code, AIME for math, agent and tool use benchmarks). Useful for a rough comparison, but they suffer from **contamination** (test tasks ended up in the training data) and from labs optimizing for well-known benchmarks.
- **[LMArena](https://lmarena.ai)**: people compare two anonymous answers and pick the better one; the votes produce a rating (Elo-like). It reflects "what people like in a chat" well. It reflects extraction accuracy, format following and work in agents poorly. Long, nicely formatted answers get a bonus.
- **[Artificial Analysis](https://artificialanalysis.ai)**: independent measurements: a composite quality index, price (a blended price per token), speed and TTFT across different providers of the same model. Handy for a "quality vs price" chart.

The bottom line: leaderboards are for a **shortlist** of 2–4 candidates. The final choice is **our own evals on our own data**: a set of our own examples with correct answers, on which each candidate model is run and the share of correct answers is counted. A prototype of such an eval was in chapter 2.1, we build the first real one in chapter 2.5, and a whole stage of the course (weeks 6–7) is devoted to evals.

Leaderboards compare models regardless of who released them. But there is one more division, which affects not quality but price, control and data: a closed model or an open-weight one.

### Closed vs open-weight

| | Closed APIs | Open-weight |
|---|---|---|
| Top-tier quality | Usually better | Catching up with a lag; the best ones are close |
| Getting started | A key, and it works | Needs hosting or an aggregator |
| Price | Per token, no infrastructure | Per token at a host, or GPU hours on our own |
| Data | Goes to the provider (with contractual guarantees) | Can be kept entirely in-house |
| Control | The model can be changed or retired | The version is ours forever; can be fine-tuned |
| Sampling, templates | Limited by the API | Full control (temperature, prefill, logprobs) |

A typical product strategy: a prototype on a strong closed model → evals → an attempt to replace it with a cheaper one (a smaller closed model or an open-weight one) while checking quality.

### How to choose a model for a task (an algorithm)

Let's put the axes, the leaderboards and this division into one sequence of steps.

1. **We state the requirements**: what inputs (text/images/PDF), whether tool calling and strict JSON are needed, acceptable latency (a chat: ≤ 2 s to the first token? a background job: doesn't matter), volume (requests per day), budget, data requirements.
2. **A shortlist** based on leaderboards and API features: 2–4 models at different price levels.
3. **We start with a strong model** and reach the quality with the prompt.
4. **We run evals** on all candidates; we count the **price per successfully solved task** (not per token) and p50/p95 latency.
5. **We pick the cheapest one that clears the bar.** Different pipeline steps can use different models (a classifier: a small one; answer generation: a mid-sized one).
6. **We plan for replacement**: the model is config, not a constant scattered through the code; evals let us switch it in an hour when a new one comes out or the old one is retired.

### An example of reference points: the Claude lineup

To make step 5 ("the cheapest one that clears the bar") tangible in money, let's look at one whole lineup. Only as an illustration of scale (prices per 1M input / output tokens as of November 3, 2026; **it is worth checking the pricing page before use**):

| Model | ID | Context | Input / Output, $ | Used for |
|---|---|---|---|---|
| Claude Haiku 5.5 | `claude-haiku-5-5` | 1M | 0.10 / 0.50 (for prompts up to 100K tokens, more beyond that) | High-volume simple tasks: classification, extraction, routing |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1M | 2 / 10 | The everyday working model: code, agents, analysis |
| Claude Opus 5.5 | `claude-opus-5-5` | 1M | 4 / 20 | Complex reasoning, long agentic tasks |
| Claude Fable 5.2 | `claude-fable-5-2` | 1M | 8 / 40 | The hardest tasks, where price is secondary |

The main point is visible: the difference between a provider's smallest and largest model is up to ~80 times in price. We build a similar table for GPT, Gemini and open-weight models ourselves.

## DeepSeek and Ollama: how we do it

The course's study stack is the two poles of the same market map: **DeepSeek** is a cheap cloud API from a Chinese lab, **Ollama** is open-weight models on our own hardware. It is useful to lay them out along the same axes as Claude.

### DeepSeek in numbers (November 13, 2026, [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing); double-check)

As in chapter 1.7, DeepSeek charges for input in two ways: a "miss" is the regular price, a "hit" is the price of the part of the prompt that matched a recent request and was taken from the cache. "Concurrency" is how many requests an account can have in flight at once (more in chapter 2.7).

| Model | Version behind the name | Context / max output | Input miss / hit, $ | Output, $ | Notes |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 1M / 384K | 0.30 / 0.006 | 1.20 | hybrid (thinking by default), vision, concurrency 2500 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M / 384K | 1.32 / 0.044 | 3.96 | hybrid, no vision, concurrency 500 |

Prices are peak prices per 1M tokens; off-peak they are half as much (chapter 1.7). Compared with the Claude table above: `deepseek-flash` is more expensive on output than Haiku 5.5 from the example, but cached input is almost free, and for "long repeated context + short answer" tasks that is a strong argument. This is exactly how models should be compared: by the price of *our* task, not by a line in the price list.

Important for "stability": `deepseek-flash` **is an alias**. DeepSeek has already moved old names (`deepseek-v4-flash`) to a new model version without the name changing on the client side. For studying this is convenient; for a product it is the very "latest" that "What to watch out for" warns about: the behavior can change unnoticed, and only evals will catch it. So we log the `model` field from the response and the date.

Data: **the servers are in China**, the jurisdiction is mainland China; the documents are ambiguous about using input data for training. For work at a company this is often a deal-breaker on its own. The course rule is broader and applies to any cloud provider: customers' personal data, work code and anything that must not be shown to outsiders never go to cloud models; the local model processes them. Only public texts and the demo database go to the cloud.

DeepSeek has historically published the weights of its models on Hugging Face (the `deepseek-ai` organization), but the flagship versions are too large for an ordinary laptop and can't be run locally; it is worth checking which weights are available now.

### Ollama: what actually runs on a laptop

A model in Ollama is quantized weights (usually 4 bits per parameter) + a chat template. A rough memory estimate: **model file size + headroom for the context** (the KV cache, the intermediate computations for each context token, grows with `num_ctx`, the window size, and with the number of parallel requests). From the [ollama.com/library](https://ollama.com/library) catalog as of November 13, 2026:

| Model | Size | What it can do | Who it's for |
|---|---|---|---|
| `qwen3:4b` | 2.5 GB | tools, thinking, context up to 256K | **the course's main study model** |
| `qwen3:1.7b` | 1.4 GB | tools, thinking | when speed matters or memory is taken |
| `qwen3:8b` | 5.2 GB | tools, thinking, context 40K | 16 GB RAM and up; on 8 GB only with everything else closed |
| `gpt-oss:20b` | 14 GB | tools, thinking, structured outputs | 32 GB RAM and up; we don't install it on 8–16 GB |
| `bge-m3` | 1.2 GB | embeddings, multilingual (non-English text included) | the RAG stage, the course's default model (chapter 4.1 · Embeddings by hand with numpy (AIL-18)) |

**Memory guideline:** 8 GB RAM: 3–4B-class models; 16 GB: 7–8B; 32 GB and more: 14B and larger. Memory is shared with the browser, the IDE and other programs, so a model at the edge of available memory goes into swap and slows everything down. The course default is `qwen3:4b`; it runs almost everywhere. The quality of a local model of this size is noticeably lower than a cloud one; for tasks on private data we compensate with simpler tasks (classification, extraction against a schema), a strict `format` and checks in code rather than relying on the model's "smarts".

The catalog also has newer families; we choose by the *tools* / *thinking* tags and size, not by name. **Be careful with models tagged *cloud*** (`deepseek-v4.1-flash` among them): they run on Ollama's servers, not on our machine. According to Ollama's FAQ, prompts to cloud models are not stored or used for training, but they leave the computer, and for customer data the course rule is local only.

A tag (`qwen3:4b`) may point to updated weights after a new `ollama pull`, so we record the ID from `ollama list` next to the eval results.

### The four providers along the axes

Now we can lay all four of the course's providers along the axes from the theory section; this is the short answer to "why is our stack like this".

| Axis | Claude | OpenAI | DeepSeek | Ollama (local) |
|---|---|---|---|---|
| Quality | top tier | top tier | close to the top for its price; we check with our own evals | noticeably lower for models that fit in a laptop's memory |
| Price | per token, discounted caching and batch | per token, caching and batch | very cheap, automatic caching, off-peak discount, no batch | $0 per token; we pay with hardware and time |
| Latency | cloud | cloud | cloud; pauses under load (keep-alive) | depends on the hardware; the first request loads the model |
| Context | up to 1M | depends on the model | 1M | each model has its own limit; Ollama defaults to 4096 |
| Tools / strict JSON | yes / yes | yes / yes | yes / strict tools only (beta), JSON mode | yes / schema in `format` |
| Embeddings | no own API | yes | **no endpoint** | yes (`/api/embed`) |
| Where the data goes | provider in the US | provider in the US | **China** | our computer |
| Stability | fixed IDs, a deprecations page | fixed IDs + aliases | alias names, versions change | the version is ours until we `pull` |

### What to use in this course

- **General cloud work** (prompts, extraction from public texts, tool calling on study tools): DeepSeek `deepseek-flash`; `deepseek-v4-pro` where flash falls short and as the "judge" in evals: the judge must be stronger than the model being checked.
- **Everything to do with the shop's orders and customers, the event log, database copies, Telegram reports**: Ollama only, local models. The shop's data is made up, but we treat it as real; this habit will be needed at work.
- **Embeddings**: Ollama (`bge-m3`; alternatives are `embeddinggemma` and similar) or `sentence-transformers` locally: DeepSeek has no embeddings.
- **Claude / OpenAI**: the reference for comparison and for understanding the industry; they are the ones that show up in job postings and other people's code.
- **Comparing many models quickly**: through OpenRouter, the next chapter.

## Learning path

1. [Artificial Analysis](https://artificialanalysis.ai) (≈25 min). We open the summary charts "Intelligence vs Price" and "Output speed". We find 3 models on the "efficiency frontier" (the best quality for their price). We look at the page of one open-weight model: how much speed and price differ across hosting providers of the same model.
2. [LMArena](https://lmarena.ai) (≈15 min). The overall leaderboard and separate categories (code, long queries, different languages: if there is one for a language we work in, it is worth a look). We play 2–3 "battle" rounds ourselves to get a feel for what people vote for.
3. Official model and pricing pages (≈30 min); the numbers for the table come from here:
   - Anthropic: [Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview) and [Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing);
   - OpenAI: [Models](https://platform.openai.com/docs/models) and [API Pricing](https://openai.com/api/pricing);
   - Google: [Gemini models](https://ai.google.dev/gemini-api/docs/models) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing);
   - open-weight: [OpenRouter models](https://openrouter.ai/models), a catalog with prices from different hosts and context sizes (handy for Llama, Qwen, Mistral, DeepSeek).
   We note which models are reasoning models, which have vision, and where the price is tiered by prompt length.
4. DeepSeek: [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit) (≈15 min). We write down which versions are behind `deepseek-flash` and `deepseek-v4-pro`, the cached and off-peak prices, the concurrency limits. We look at the News/Change Log section: how often the models behind the names change.
5. Ollama: the [model catalog](https://ollama.com/library) with the tools / thinking / embedding filters and the [macOS](https://docs.ollama.com/macos) page (or the equivalent for our OS) (≈15 min). We find 2–3 models that fit into our computer's memory alongside the other programs (for 8 GB, up to ~3 GB) and note which of them are *cloud* (not local).
6. The table below, in the practice section (≈30 min).

## What to watch out for

- **Model names and prices go stale within months.** The table in `notes/models.md` has a date and links to the source. Prices from articles and from an LLM's memory (this book included) can't be trusted.
- **Aliases vs pinned versions.** A "latest"-style alias can silently change the model, and with it the product's behavior. For production we pin a specific ID and change it deliberately, with evals.
- **Deprecation.** Models get retired; providers have pages with the dates. Code where the model is hardcoded in twenty places is technical debt.
- **The blended price in leaderboards** is computed for an assumed input:output ratio. In a specific task it can be different: RAG is input-heavy, text generation is output-heavy.
- **The speed of the same open-weight model** differs several times across hosts, and quantized versions (fewer bits per weight) can be noticeably worse in quality.
- **"The best model on Arena" ≠ the best one for JSON extraction** or for an agent with tools.
- **Data:** for study tasks it doesn't matter, but at work the first question is where the data goes and whether the provider stores it. The rule is the same for the shop's application: only what we don't mind showing goes to an external model.

## Practice

- [ ] **1. A model table.** `notes/models.md`, 10–12 models: both DeepSeek models, 2 local Ollama models that actually run on our computer, at least 2 each from Anthropic, OpenAI and Google for comparison, and 1–2 open-weight models from other families (Llama, Qwen, Mistral). Columns:
  ```
  | model (exact ID) | provider | type (reasoning/hybrid/regular) | open-weight? | context | input $/1M (miss/cache) | output $/1M | modalities | where the data goes | strengths | source, date |
  ```
  For Ollama, instead of the price: size, memory and tokens/s on our hardware (measured as in chapter 1.7).
  Prices and context come only from official pages, or from OpenRouter for open-weight models; with the date next to them.
- [ ] **2. Position on the chart.** For 5 models from the table we find the composite quality index and speed on Artificial Analysis; we add the columns.
- [ ] **3. The price of our task.** We take the review classifier from chapter 2.1 (average input/output tokens per request from our logs). We compute the cost of 10,000 classifications a day × 30 days for each model in the table with `estimate_cost` from chapter 1.7 (prices of new models go into `PRICES`). We add a "$/month for the classifier" column.
- [ ] **4. Justifications.** Under the table, a model choice with a 2–3 sentence justification for four tasks:
  1. classifying 10,000 public product reviews a day;
  2. a Telegram bot that answers questions from the shop's knowledge base (shipping, return and warranty rules) with citations;
  3. an agent that writes and edits Python scripts for order analysis (on a database copy);
  4. extracting data from screenshots/PDF invoices from suppliers and carriers.

  For each task we answer "where does the data go" separately: tasks 3 and 4, with the copy of the shop database (it holds customers' personal data) and real invoices, get a local model only (and we write down honestly whether its quality is enough and what will have to be simplified); the cloud only on demo data.
- [ ] **5. The alias under the hood.** We make one request to `deepseek-flash` and record the `model` field from the response. We compare it with the version on the pricing page. We write down in the notes how we will notice the model behind an alias being swapped (logging `model` + date + evals).

## Done when

- `notes/models.md` holds a table of 10–12 models with prices, context, type, where the data is processed and a date/source, including DeepSeek and 2 local models checked on our own computer.
- For the four tasks a model choice is written down with arguments on quality, price, latency and API features.
- We can justify a model choice for a task out loud in 2 minutes and say how we would verify it with evals.

## Self-check quiz

1. How does a reasoning model differ from a regular one, and what has to be paid for when using it?
2. What does LMArena measure best?
   a) JSON extraction accuracy; b) human preferences in a dialogue; c) generation speed; d) cost
3. What two reasons make RAG necessary even with a 1M-token context window?
4. What is benchmark contamination?
5. What is wrong with this decision?
   ```python
   MODEL = "some-model-latest"  # best on the leaderboard this week
   # used directly in 14 files
   ```
6. A model is needed to classify 10,000 reviews a day. Why is starting with the most expensive model fine, while staying on it is probably not?
7. Why can the "blended price" on Artificial Analysis be misleading?
8. Two models: A is $1/$5, B is $0.2/$1 per MTok. On our evals A scores 95%, B 80%. What else needs to be known to choose?
9. What two advantages do open-weight models have over closed APIs?
10. What is TTFT, and for which task from the practice section is it most critical?
11. Why is `deepseek-flash` like a "latest" alias from the stability point of view, and how do we live with it?
12. Embeddings are needed for RAG over the shop's knowledge base. Can they be taken from DeepSeek? What to use instead?
    a) yes, the `/embeddings` endpoint; b) no, DeepSeek has no embeddings: Ollama (`/api/embed`) or `sentence-transformers` locally; c) only from Anthropic; d) embeddings aren't needed with a 1M context
13. Why is a model from the Ollama catalog tagged *cloud* unsuitable for the shop's customer data, while `qwen3:8b` on a laptop with 8 GB RAM is suitable only with caveats?

## Answers

1. A reasoning model generates internal reasoning before answering; it is stronger on complex tasks. The reasoning is billed as output tokens and increases latency.
2. **b.** Arena is a leaderboard built from people's pairwise votes.
3. Price (every input token is paid for in every request) and latency grow with length; finding the needed fact in a very long context works worse than in a short relevant one.
4. A situation where the test tasks ended up in the model's training data, and the result reflects memorization rather than skill.
5. A "latest" alias can change the model without the team noticing; the choice was made by leaderboard, not by evals; the ID is scattered across the code but should live in one config.
6. A strong model shows the quality ceiling and helps debug the prompt; at 10,000 a day the price difference is huge, and after evals a cheaper model that clears the bar is usually found.
7. It is computed for a fixed input:output ratio, while a specific task can have a completely different ratio.
8. The cost of an error and whether it can be detected (a retry, a manual check); the required quality bar; request volume, latency, tokens per request. Then compare the price per correctly solved task.
9. For example: the data doesn't leave our own infrastructure; the version doesn't change without the team knowing; full control over sampling and the option to fine-tune.
10. Time To First Token, the time until the first token of the response. It is most critical for the interactive Telegram bot (task 2).
11. Behind the name is a specific version that DeepSeek changes without changing the name (this already happened with `deepseek-v4-flash`). Log the `model` field from the response and the date, keep the model name in config and recheck quality with evals after a swap.
12. **b.** DeepSeek's API has no embeddings endpoint (as of November 2026); embeddings are made locally, which also settles the privacy question.
13. A *cloud* model runs on Ollama's servers, so the data leaves the computer, even though Ollama promises not to store it. `qwen3:8b` is local but takes ~5 GB: on 8 GB RAM next to a browser and an IDE it works only with everything else closed, otherwise it swaps; the default for 8 GB is the 4B class, and 7–8B is a normal choice from 16 GB.

## What's next

First comes [2.4 · OpenRouter: one API for many models (AIL-69)](AIL-69.md): there we run one prompt through several models from our table with a single key. The table will also come in handy in [2.5 · The first eval: extracting JSON from 20 texts (AIL-9)](AIL-9.md): there we run extraction and see a model's quality in numbers for the first time, and at the evals stage we compare several models from the table on the same dataset.
