# 1.5 · How LLMs work: Karpathy's lecture and API keys  (AIL-3)

> **Week 1** · Preparation · ⏱ ~4.5 h (+ 3.5 h of the second video in parts over the first weeks) · Theory

<!-- description: How LLMs work, after Karpathy's lecture: tokens, training, the context window, why models hallucinate. Plus a DeepSeek key, Ollama setup and a first call. -->
<!-- source-sha256: 3f0cafc83214 -->

## Why an AI engineer needs this

Without a mental model, an LLM's behavior looks like a set of random whims: why it confidently invents an API function, mixes up 9.11 and 9.9, "forgets" an instruction from the middle of a long prompt, knows nothing about yesterday's change to a carrier's rates. With a mental model, these are predictable consequences of how it was trained and how it reads text, and we know in advance where we need RAG (putting retrieved documents into the prompt, weeks 4–5), where tool calling (the model asks to call our function, week 2), where validation. In interviews, "what is a token", "where do hallucinations come from", "what is a context window and why is it limited" come up almost every time. The second half of the chapter is about API keys: without them there is no project at all, and they carry a beginner's most expensive mistake, a leaked key.

## Theory

### 1. An LLM is a function "text → probabilities of the next token"

A large language model takes a sequence of tokens as input and outputs a **probability distribution** for the next token. That's all. Generating an answer is a loop:

```
prompt tokens ──▶ [ model ] ──▶ P(next token) ──▶ sample one ──┐
      ▲                                                        │
      └──────────── append it to the sequence ◀────────────────┘
          repeat until a stop token or max_tokens
```

Several consequences follow right away:
- The model **does not "look up the answer"**; it continues the text plausibly. Plausible and correct often coincide, but not always, and that gap is a hallucination.
- Choosing a token is **sampling** from the distribution. The `temperature` parameter "flattens" or "sharpens" it: at a low value the model almost always takes the most likely token, at a high one it picks less likely ones more often. We cover this in detail in AIL-5.
- Each next token depends on all the previous ones, including those already generated. A mistake at the start of an answer drags the rest along, which is why it helps to ask the model to reason first and answer afterwards (chain-of-thought, week 2).

An analogy for a developer: it is IDE autocomplete that has read almost the entire internet and was then fine-tuned for a long time to behave like an assistant.

In all the consequences above, the model's unit of work is the token. Let's look at what that is.

### 2. Tokens

The model does not see letters and words; it sees **tokens**: pieces of text from a fixed vocabulary (tens to hundreds of thousands of entries) built by an algorithm such as BPE (byte pair encoding): frequent byte sequences are merged into one token.

```
"Delivery cost for MUG-NORTH-350"  →  ["Del", "ivery", " cost", " for", " MUG", "-N", "ORTH", "-", "350"]   (illustrative)
```

What this means in practice:
- **Prices and limits are counted in tokens**, not characters or words. For English text, a rough estimate is about 4 characters per token; non-English text (Russian, for example) usually takes noticeably more tokens for the same idea, so it costs more and eats the context faster. Different models have different tokenizers, so the same text gives different token counts on Claude and GPT.
- **Arithmetic and character-level tasks go badly.** The number `97342.15` may be split into the tokens `973`, `42`, `.`, `15`; the model does not "see" the digit positions the way we do. Hence "how many r's are in strawberry" and comparing 9.11 with 9.9. The takeaway for any applied domain, our shop included: **we never trust the model to calculate revenue, profit, discounts or payment provider fees**. Our code does that, and the model only calls it (tool calling, week 2) or explains numbers that are already computed.
- Spaces and case are part of tokens: `" MUG"` and `"MUG"` are different tokens.

To see it for ourselves: [OpenAI Tokenizer](https://platform.openai.com/tokenizer). In Python, the [tiktoken](https://github.com/openai/tiktoken) library for OpenAI models; Anthropic has a token counting endpoint in its API (it is in the documentation; we will need it when we get to cost).

### 3. Where a model comes from: three stages of training

We know what the model does at each step and what pieces of text it works with. It gets its probabilities from training, which goes through three stages:

| Stage | Data | What we get |
|---|---|---|
| **Pretraining** | trillions of tokens of internet text, books, code | a "base model": continues any text, knows facts, but does not answer questions; it completes a document |
| **Supervised fine-tuning (SFT)** | tens to hundreds of thousands of "question → good answer" dialogues written by people | an assistant: understands the format of a dialogue, roles, instructions |
| **RLHF / RL** | ratings of answers by people (or by a grader model), tasks with a checkable answer | the model prefers helpful, safe answers; RL on checkable tasks teaches it to reason |

Karpathy explains this with a metaphor: pretraining is "compressing the internet" into the model's parameters (lossy, like a lossy zip), while SFT and RLHF train the assistant's "personality". Knowledge about the world comes mostly from pretraining, and it is **frozen at the data cutoff date** (knowledge cutoff). Hence:
- the model knows nothing about events after the cutoff unless we give them in the prompt (RAG, search, tools);
- it does not know what it does not know: asked about a recent event, it may confidently make up an answer;
- rare facts (the API parameters of a little-known carrier) are poorly memorized and get mixed up; this is where hallucinations happen most. The cure is to put the needed piece of documentation into the context (week 4).

### 4. The context window is working memory

Knowledge from training is frozen, and the model gets fresh data only through the text of the request. Everything the model "knows" at the moment of answering, apart from what is baked into its parameters, is the **context**: the system prompt + the dialogue history + our documents + the answer generated so far. Between requests the model **remembers nothing**: the API is stateless, and a chat's "memory" is our code sending the whole history again every time (and paying for it).

Why the window is limited:
- In a transformer, every token "looks" at all previous tokens through the **attention** mechanism. Compute and memory grow faster than linearly with length (quadratically in the basic version), so a long context is expensive and slower.
- The model was trained on sequences of a certain length; beyond it, quality is not guaranteed.

Modern windows are huge (hundreds of thousands of tokens and more; we check the documentation of the specific model), but **a large window does not mean perfect attention**. The well-known "lost in the middle" effect (Liu et al., 2023): the model uses information at the beginning and the end of a long context better than in the middle. In practice: important instructions go into the system prompt and/or at the end, documents go in compactly and only the relevant ones, not "the whole knowledge base".

An analogy: the model's parameters are long-term memory, read long ago and remembered vaguely; the context is what lies on the desk in front of it right now and is read precisely.

### 5. The transformer on one page

Attention, embeddings and parameters have already come up above; now we put them together into one diagram of the transformer, the architecture modern LLMs are built on. There is no need to be able to implement it, but the diagram is worth knowing:

```
text → tokens → embeddings (vector per token) + position info
     → N × [ self-attention  →  feed-forward ]     # each layer refines every token's vector
     → final vector of the last token → probabilities over the vocabulary
```

- **Embedding**: a vector of numbers for each token; tokens with similar meaning get close vectors. The same idea is behind document embeddings for RAG (week 4).
- **Self-attention**: each token decides which previous tokens to "look at" and how much information to take from them. This is how "it" in a sentence gets linked to the right noun.
- **Parameters** (weights): billions of numbers chosen during training. "A 70B model" means 70 billion parameters.

The Illustrated Transformer from the learning path walks through this with pictures.

### 6. Why models make mistakes: a short cheat sheet

Now every typical model mistake can be derived from how the model works, and the engineering remedy named right away:

| Symptom | Cause | What the engineer does |
|---|---|---|
| Confidently invents a fact/API method | plausible continuation, a rare fact in pretraining | RAG with documentation, "if you don't know, say so", verification |
| Mixes up numbers, bad at arithmetic | tokenization of numbers | compute in code, give the model a tool |
| Doesn't know recent events | knowledge cutoff | search, fresh data in the context |
| Ignores an instruction in the middle of a long prompt | weaker attention to the middle | structure, repeat what matters, shorter context |
| Different answers to the same question | sampling | low temperature, structured output, evals |
| "Obeys" text from a document | for the model, instructions and data are one stream of tokens | separating data from instructions, protection against prompt injection (week 8) |

### 7. API keys, money and security

From how the model works we move to practice. To call a cloud model from code we need an API key: a secret string by which the provider identifies our account and charges money. First, what exactly it charges for.

**The billing model.** We pay for tokens: separately for input and output; output is noticeably more expensive. The price is given per million tokens and differs a lot between models of the same provider: a "small" model can be dozens of times cheaper than a "large" one. Specific prices and model names change, so we always check the current pages (links in the learning path) and do not keep them in our heads as constants. Calculating the cost of a request is the topic of chapter 1.7 · Tokens, temperature and the cost of an LLM request (AIL-5).

**A key = money.** An API key is a bearer token: whoever has it spends our balance. Therefore:
1. **A spending limit** in the provider's console is mandatory, before the first request. Section names in consoles change (organization limits, project/workspace budgets, notifications); we look up the current place in the provider's documentation.
2. **Prepay** a small amount ($10–20) instead of linking a card with auto-reload: a natural ceiling on the damage.
3. **A separate key per project** with a clear name (`learning-week01`): a leaked key is revoked without breaking everything else.
4. **Keys only in environment variables.** The `.env` file in the root, in `.gitignore` (done in AIL-56); only `.env.example` with empty values goes into git.

```python
# illustrative: load keys from .env, never hardcode them
from dotenv import load_dotenv     # uv add python-dotenv
import anthropic

load_dotenv()                      # reads .env into os.environ
client = anthropic.Anthropic()     # SDK reads ANTHROPIC_API_KEY from the environment
```

The official SDKs take the key from `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` on their own, so the code does not mention the key at all, and that is how it should be. For DeepSeek and Ollama through the `openai` SDK, we pass the key and the address explicitly (`os.environ["DEEPSEEK_API_KEY"]`, example below). The package is [python-dotenv](https://pypi.org/project/python-dotenv/); `load_dotenv()` without arguments searches for `.env` from the script's folder upwards, so it finds the file in the repository root.

**If a key has leaked** (into a commit, a screenshot, notebook output, a chat): **revoke** the key in the console **immediately** and issue a new one. Deleting the commit or rewriting history is not enough: bots scan public repositories within minutes, and copies of the history stay in clones and caches. Revoking is the only measure that actually closes the hole.

## DeepSeek and Ollama: how we do it

The general rules about keys and money apply to any provider. Now, specifically for our stack. In this book we learn on two cheap options, while Claude and OpenAI remain for comparison:

- **DeepSeek API** is the main cloud model: very cheap, compatible with the OpenAI SDK (only `base_url` and the key change). **The servers are in China.**
- **Ollama** runs local models on our own computer: free, offline, the data goes nowhere. Anything involving customers' personal data, work code and snapshots of the shop's database goes only here. Embeddings (week 4) too.

The facts below were checked against the official documentation on **November 13, 2026**; DeepSeek's models and prices change often, so before any calculations we check the pages from the learning path.

### The data rule (mandatory)

```
customers' personal data, DB snapshots, work code, event logs, keys ──▶ Ollama (local model) only
textbook exercises, public texts, demo DB, fake data                ──▶ DeepSeek / Claude / OpenAI
```

DeepSeek processes requests in China; free cloud tiers of other providers (and some free models on OpenRouter) may use input data for training. The rule applies to any cloud provider, not only DeepSeek: customers' personal data, database snapshots, the order event log, work code, keys and anything that must not be shown to outsiders are never sent to cloud models, not even "just to check". A local model handles that. Cloud models get public texts and the demo database.

### The DeepSeek key

- The key is created at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). The environment variable, per the documentation, is `DEEPSEEK_API_KEY`.
- Payment comes from a prepaid balance (the documentation: charges are deducted from the topped-up or granted balance, and the granted balance is spent first). A separate spending limit setting like Anthropic's/OpenAI's was not found in the API documentation; it is worth checking the console ourselves. So the damage ceiling here is **a small top-up without auto-reload**: at these prices even $5 is more than enough for the whole course.
- A separate key for studying, with a clear name; revoking it is on the same keys page.

### DeepSeek models and prices (as of November 13, 2026)

| Model (`model=`) | Context | Features |
|---|---|---|
| `deepseek-flash` | 1M | cheap main model; thinking and non-thinking modes (thinking by default), has vision |
| `deepseek-v4-pro` | 1M | stronger and more expensive; thinking/non-thinking; no vision |

Price per 1M tokens, USD. "Cache hit" is the part of the input that matched the prefix of recent requests (DeepSeek's caching is automatic; details in chapter 2.7 · Streaming, retries, rate limits, prompt caching (AIL-11)). On weekdays there are peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri), when the price is doubled:

| | flash, off-peak | flash, peak | pro, off-peak | pro, peak |
|---|---|---|---|---|
| input, cache hit | 0.003 | 0.006 | 0.022 | 0.044 |
| input, cache miss | 0.15 | 0.30 | 0.66 | 1.32 |
| output | 0.60 | 1.20 | 1.98 | 3.96 |

The old names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted but redirected to the current Flash. We do not copy model names from old tutorials; we keep `DEEPSEEK_MODEL` in `.env`.

What sets DeepSeek apart from what the Anthropic/OpenAI documentation says:
- **Thinking is on by default.** The model first writes its reasoning (the `reasoning_content` field next to `content`), and those tokens are billed as output. For simple checks we turn it off: `extra_body={"thinking": {"type": "disabled"}}`.
- **In thinking mode `temperature` has no effect**: the documentation says that `temperature`, `presence_penalty` and `frequency_penalty` do not raise an error, but change nothing either. This matters for chapter 1.7 · Tokens, temperature and the cost of an LLM request: temperature experiments are done in non-thinking mode.
- Tokens: per the DeepSeek documentation, 1 English character ≈ 0.3 tokens (that is, ~3 characters per token); the exact number always comes from `usage` in the response. DeepSeek's offline tokenizer is distributed as an archive from their CDN; if we need to download it, it is third-party code: a quarantine folder and reading it before running.
- The DeepSeek documentation has no embeddings (they are not in the list of models and prices), so for week 4 embeddings will be local, through Ollama.
- There is also an Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`): the `anthropic` SDK with a different `base_url`. We do not need it; the main path is the OpenAI SDK.

### Installing Ollama, with verification

Ollama is a program that will run constantly and listen on a port, so we install it by the rules for third-party code. The steps below are for macOS; on Windows and Linux the idea is the same: the official installer, a signature check, reading any script before running it.

1. **Official source only:** [ollama.com/download](https://ollama.com/download) → for macOS this is `Ollama.dmg`. We do not install via `curl -fsSL https://ollama.com/install.sh | sh`, even though the site offers that route too: running a script from the internet without reading it goes against the basic rule for third-party code. No builds from third-party sites or forks.
2. **Requirements** (docs.ollama.com/macos): macOS Sonoma 14 or newer; on Apple Silicon it runs on CPU+GPU (Metal), on Intel on the CPU only.
3. **Before the first launch** we check the signature and notarization:
   ```bash
   codesign -dv --verbose=2 /Applications/Ollama.app   # who signed it: Authority / TeamIdentifier
   spctl -a -vv /Applications/Ollama.app               # expect: accepted, source=Notarized Developer ID
   ```
   The signer must be the Ollama developer (Developer ID). If there is no signature, `spctl` says `rejected`, or the publisher is unexpected, we do not launch it: we delete it and note in our notes where we downloaded it from. A signature check lowers the risk but does not guarantee the absence of vulnerabilities.
4. On first launch the app offers to create a link to the `ollama` CLI in `/usr/local/bin`; that is normal (the documentation describes this step).
5. Models and settings live in `~/.ollama` (logs in `~/.ollama/logs`), outside our repository. Models weigh gigabytes, so it is worth keeping an eye on disk space.
6. The server listens on `http://localhost:11434`, our machine only. It must not be exposed to the network (we do not change the listen address to `0.0.0.0`): the local API has no authentication.
7. **Ollama cloud models.** The Ollama library also has cloud models (they show a context size and a price tier instead of a download size); they require an Ollama account and run on Ollama's servers, not on our machine. For our own data, only local models downloaded with `ollama pull`.

Models (checked against ollama.com/library, November 13, 2026; the list changes):

```bash
ollama pull llama3.2:3b      # ~2.0 GB, 128K context, supports tools — quick checks
ollama pull qwen3:4b         # ~2.5 GB, tools + thinking — tool calling later
ollama pull bge-m3           # embeddings for week 4 (alternatives: embeddinggemma, nomic-embed-text)
ollama list                  # what is downloaded
ollama ps                    # what is loaded in memory right now
```

The number before `b` in the name is the parameter count in billions (`qwen3:4b` is 4 billion), and it determines how much memory is needed. A rough memory rule (a heuristic, not from the documentation): the model must fit entirely in memory together with the system, the browser and everything else running (on Apple Silicon this is unified memory; on a PC with a graphics card, the amount of video memory matters too). Guidelines for Q4 models (quantization: each parameter is stored in roughly 4 bits instead of 16, so the model weighs several times less; Ollama serves models in this form by default):
- **8 GB**: 3–4B class models (for example, `qwen3:4b-instruct-2507-q4_K_M`, ≈2.5 GB); 7–8B (≈5 GB) only with the browser closed and no other heavy programs, otherwise the system starts swapping; we do not run 14B+.
- **16 GB**: 7–8B models are comfortable.
- **32 GB and more**: 14B and larger; 30B+ for 32–64 GB.

The course's default model is `qwen3:4b`: it runs even on 8 GB, and all examples from week 2 on are designed for it. `llama3.2:3b` is needed only for a quick check of the installation: it answers without a reasoning mode, so a short answer is not eaten by the token limit. With more memory, a larger model is fine. We download only from the ollama.com library or from official organizations on Hugging Face.

### The first call: one library for both providers

The key is in hand, Ollama is installed, so we can check both providers with one script. Both DeepSeek and Ollama understand the OpenAI Chat Completions format, so the single `openai` package is enough:

```python
# illustrative — verify against api-docs.deepseek.com and docs.ollama.com
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

deepseek = OpenAI(
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)
ollama = OpenAI(
    api_key="ollama",                         # required by the SDK, ignored by Ollama
    base_url="http://localhost:11434/v1",
)

def ask(client: OpenAI, model: str, **extra) -> None:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Say 'ok' and nothing else."}],
        max_tokens=50,
        **extra,
    )
    print(model, "→", resp.choices[0].message.content, resp.usage)

ask(deepseek, os.environ["DEEPSEEK_MODEL"], extra_body={"thinking": {"type": "disabled"}})
ask(ollama, os.environ["OLLAMA_MODEL"])
```

Ollama also has its own library, [`ollama`](https://pypi.org/project/ollama/) (the official client, repository github.com/ollama/ollama-python); we will need it for embeddings, structured `format` and controlling thinking (`think=False`). We install it with a pinned version (`uv add "ollama==<version>"`, taking the version from PyPI on the day of installation).

### Comparing providers for this chapter

| | Claude | OpenAI | DeepSeek | Ollama (local) |
|---|---|---|---|---|
| Where it runs | Anthropic's cloud | OpenAI's cloud | cloud, China | our computer |
| Personal data / work code allowed | no | no | **no, never** | yes |
| Key | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `DEEPSEEK_API_KEY` | not needed (any string) |
| SDK | `anthropic` | `openai` | `openai` + `base_url` | `openai` + `base_url` or `ollama` |
| Spending limit | console settings | project budgets | prepaid balance (no separate limit found in the docs) | free, we pay with memory and time |
| Price (order of magnitude) | from cheap to expensive models | same | cents per million input tokens | 0 |
| Thinking | turned on by a parameter | in reasoning models | **on by default** | depends on the model (`think=`) |
| Embeddings | no endpoint of its own | yes | not in the documentation | yes (`/api/embed`, `/v1/embeddings`) |
| Tokenizer | counting endpoint | tiktoken | offline archive / `usage` | `usage` in the response |

**For this chapter's practice:** a DeepSeek key + Ollama installed with one small model is the minimum. Anthropic and OpenAI accounts are optional, for comparison; the book will use them to show "what the big providers have", and later we will need a strong model as an LLM-as-judge (the judge must be stronger than the model it evaluates, week 6).

## Learning path

1. [Intro to Large Language Models — Andrej Karpathy](https://www.youtube.com/watch?v=zjkBMFhNj_g) (1 h, required; with pauses ≈1.5 h). We watch with a notebook at hand. What to take away: "an LLM = two files" (parameters + the code that runs them), pretraining as compressing the internet, the training stages, the LLM as an "operating system", the security section (jailbreaks, prompt injection), which comes back in week 8.
2. [The Illustrated Transformer — Jay Alammar](https://jalammar.github.io/illustrated-transformer/) (≈45 min). We read up to and including the decoder section; the formulas can be skipped. What to take away: what an embedding is, how self-attention mixes information between tokens, why positional encoding is needed. We do not get stuck: the goal is intuition, not implementation.
3. [OpenAI Tokenizer](https://platform.openai.com/tokenizer) (≈10 min). We paste in: an English sentence, the same sentence in another language (Russian, for example), the number `97342.15`, the product SKU `MUG-NORTH-350`, a piece of JSON. We compare token counts and how numbers get split.
4. [Deep Dive into LLMs like ChatGPT — Karpathy](https://www.youtube.com/watch?v=7xTGNNLPyMI) (3.5 h, **in parts over the first weeks**, 30–40 min at a time). Now, the first hour: pretraining data, tokenization, neural network training, inference. The rest (hallucinations and tool use, "models need tokens to think", RL and reasoning) as we go through weeks 1–2.
5. (Optional) [3Blue1Brown — Neural Networks](https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi): the chapters on transformers and attention (≈1 h), for visual intuition deeper than Alammar's.
6. **DeepSeek** (≈30 min): [Quick start](https://api-docs.deepseek.com) (base URL, first call), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (models, cache hit/miss, peak hours), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (what is ignored in thinking, `reasoning_content`), [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) (concurrent request limit, 429), [Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage). Then [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys): top-up and key. What to take away: today's model names, input/output prices, that thinking is on by default.
7. **Ollama** (≈40 min including downloads): [Ollama on macOS](https://docs.ollama.com/macos) (requirements, where the files live), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (base URL, which endpoints exist and which don't), [Cloud](https://docs.ollama.com/cloud) (which models do not run on our machine), [model library](https://ollama.com/library) (size, context, tools/thinking/embedding labels). Installation follows the checklist in the "DeepSeek and Ollama" section above.
8. **(For comparison, optional) Anthropic and OpenAI keys.** [Anthropic Console](https://console.anthropic.com) (the console now lives at platform.claude.com; the old address redirects) and [OpenAI Platform](https://platform.openai.com) (≈30 min for both): account, top-up, limits, key.
9. **Prices and models** (≈15 min): besides the DeepSeek page from step 6, [Anthropic pricing](https://www.anthropic.com/pricing), [the pricing page in the Claude docs](https://platform.claude.com/docs/en/about-claude/pricing), [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [OpenAI pricing](https://openai.com/api/pricing/), [OpenAI models](https://platform.openai.com/docs/models). What to take away: input versus output price, the gap between the cheapest and the most expensive model, context window sizes.
10. **The first call** (≈15 min, optional; it is covered fully in chapter 1.6 · The raw API: first requests to Claude and OpenAI (AIL-4)): the code from the "DeepSeek and Ollama" section above; for comparison, [Claude Quickstart](https://platform.claude.com/docs/en/get-started) (the Python tab) and [OpenAI Quickstart](https://platform.openai.com/docs/quickstart).

## What to watch out for

- **The model is not a calculator and not a database.** Any figure in its answer about revenue, profit, discounts or fees must come from our code or from data in the context, not from the model's "memory".
- **"The model remembers the previous conversation"**: no, the application code resends the history. A long chat = a growing price for every next request.
- **A large context window is no reason to put everything in it.** Cost grows linearly with input size, and how well the middle gets used drops.
- **Fresh data.** The question "how much does courier delivery to Chicago cost right now" without a tool or data in the context gets a made-up answer.
- **A key in the code "just for a minute"** is exactly how it ends up in git. Even in a notebook, only through the environment (AIL-57).
- **No spending limit**: a buggy loop (retries without a pause, a `gather` over a thousand requests without a semaphore) can burn the balance in minutes.
- **Model names and prices go stale.** We do not copy them from old tutorials or model answers; we take them from today's documentation and keep the model name in config/an environment variable.
- **A leak = revocation**, not `git commit --amend`.
- **"Cheap" does not mean "anything goes".** DeepSeek costs pennies, but the data goes to China. Customers' personal data, the order event log, database snapshots and work code go only to local Ollama.
- **A cloud model inside Ollama.** A model from Ollama's cloud catalog runs on their servers, even though we call it through `localhost`. For our own data we check that the model is local (`ollama list` shows its size on disk, `ollama ps` that it is loaded into memory).
- **DeepSeek's thinking burns output tokens.** "Say ok" in thinking mode can cost hundreds of reasoning tokens. We look at `usage` and turn thinking off where it isn't needed.
- **`curl … | sh`** from the Ollama site is convenient, but it means running an unread script. We install the `.dmg` (or the official installer for our OS) and check the signature.

## Practice

- [ ] **Karpathy, Intro.** We watch the video and write `notes/llm-basics.md`: 10–15 points in our own words, without copying the slides. Required points: what a token is; next-token prediction; the three training stages; what a context window is and why it is limited; why the model doesn't know recent events; where hallucinations come from; why arithmetic goes badly; what prompt injection is.
- [ ] **Tokenizer.** In the same file, a 5-row table: text → token count (English, non-English such as Russian, a number, a product SKU, JSON). A one-sentence conclusion: what costs more and why.
- [ ] **Alammar.** In `notes/llm-basics.md` we draw an ASCII diagram of the transformer in our own words (as in the theory, but from memory).
- [ ] **DeepSeek.** We sign up at platform.deepseek.com, top up the minimum amount (without auto-reload; that is our spending limit), create a `learning` key. We find where in the console the key is revoked and write it down.
- [ ] **Ollama.** We download `Ollama.dmg` from ollama.com/download, drag it into Applications, and **before the first launch** run `codesign -dv --verbose=2` and `spctl -a -vv` and record the output (who signed it, `accepted`/`rejected`) in `notes/llm-basics.md`. On Windows and Linux: the official installer and a signature check or reading the script with our OS's tools. We launch it, allow the CLI link, then `ollama --version`, `ollama pull llama3.2:3b`, `ollama run llama3.2:3b "Say ok"`. We note how much disk space the model took and how many seconds the first answer took (the first call is slower: the model loads into memory).
- [ ] *(For comparison, optional)* **Anthropic.** We sign up in the console, top up $10–20, **first** set a spending limit and a notification, then create a `learning` key (or one per project).
- [ ] *(For comparison, optional)* **OpenAI.** The same: a $10–20 top-up, a limit/project budget, a separate project for studying, a key.
- [ ] **Environment file.** In the root of `ai-engineering-journey`:
  ```bash
  cp .env.example .env      # then paste the keys into .env in the editor
  git status                # .env must NOT be listed
  git check-ignore -v .env  # shows which .gitignore rule hides it
  ```
  We do not paste keys with `echo ... >> .env` in the terminal: the command stays in the shell history.
- [ ] **Key check: DeepSeek + Ollama (the main one).** In the project from chapter 1.3 · Python: uv, async, Pydantic (AIL-2) or in a new `exercises/week-01/keys-check/` (created with `uv init`): `uv add openai python-dotenv`. In `.env`: `DEEPSEEK_API_KEY=...`, `DEEPSEEK_MODEL=deepseek-flash`, `OLLAMA_MODEL=llama3.2:3b` (we check the names against today's documentation); in `.env.example`, the same names without values. The `check_keys.py` script, modeled on the code from the "DeepSeek and Ollama" section, makes one request to each and prints **only** the answer text and `usage`. We run DeepSeek twice, with thinking off and on (for the second run we remove `extra_body` and raise `max_tokens`, say to 1000: the reasoning also counts as output, and with a limit of 50 it may never get to the answer), and compare `completion_tokens`. Expected: both answer, with thinking there are noticeably more output tokens; the cost is a fraction of a cent. If Ollama does not answer, we check that the app is running (`curl http://localhost:11434` is a request to our own machine; nothing goes outside).
- [ ] *(For comparison, optional)* **Anthropic and OpenAI key check.** `uv add anthropic` and add the functions below to `check_keys.py`. A skeleton (illustrative; check the calls against the quickstarts):
  ```python
  import os
  from dotenv import load_dotenv
  import anthropic
  from openai import OpenAI

  load_dotenv()
  ANTHROPIC_MODEL = os.environ["ANTHROPIC_MODEL"]   # pick a cheap model from the docs, put it in .env
  OPENAI_MODEL = os.environ["OPENAI_MODEL"]

  def check_anthropic() -> None:
      client = anthropic.Anthropic()
      msg = client.messages.create(
          model=ANTHROPIC_MODEL,
          max_tokens=50,
          messages=[{"role": "user", "content": "Say 'ok' and nothing else."}],
      )
      ...  # print the text block and msg.usage

  def check_openai() -> None:
      client = OpenAI()
      resp = client.responses.create(model=OPENAI_MODEL, input="Say 'ok' and nothing else.")
      ...  # print resp.output_text and resp.usage

  if __name__ == "__main__":
      check_anthropic()
      check_openai()
  ```
  Expected result: two short answers and token counts in the single digits to tens. The cost is a fraction of a cent. Model names live in `.env`, not in the code, and their names go into `.env.example`. In the notes we compare how the response shapes differ (`msg.content[0].text` for Anthropic versus `choices[0].message.content` for OpenAI-compatible APIs) and the `usage` fields.
- [ ] **Prices.** In `notes/llm-basics.md`: we write down the input price (cache miss and cache hit) and the output price per million tokens for `deepseek-flash` and `deepseek-v4-pro` (off-peak and peak) and the date we checked. We calculate how much 1000 requests of 2000 input tokens and 500 output tokens cost on each. A check for flash off-peak at the November 13, 2026 prices: 2M × $0.15 + 0.5M × $0.60 = $0.60. For comparison (if we looked): one cheap and one flagship model from Claude and OpenAI. And a row for Ollama: $0, but we record how many seconds the answer took.
- [ ] **Leak drill** (without a real leak): we find where the key is revoked in the DeepSeek console (and in the Anthropic/OpenAI consoles, if we have accounts there) and write the path down in `notes/llm-basics.md`, so we don't have to search for it under stress.
- [ ] Commit the notes. Before committing, `git diff --staged`, and we make sure with our own eyes that there isn't a single key.

## Done when

- We can explain to a friend in 2 minutes, without jargon, what a token is and why a model has a context window (and why the model doesn't remember the previous conversation).
- `notes/llm-basics.md` has 10–15 points, the token table and the price calculation.
- The DeepSeek key works and Ollama answers locally (`check_keys.py` prints both answers); the DeepSeek balance is topped up minimally, without auto-reload; the Ollama signature was checked before the first launch; `.env` does not show up in `git status`.
- If Anthropic/OpenAI keys were created, they have spending limits.
- We can say which data may be sent where (to DeepSeek and other cloud models, no personal data and no work code; to Ollama with a local model, yes).
- The first hour of "Deep Dive" is watched, and the rest is planned for the coming weeks.

## Self-check quiz

1. What exactly does a language model output at each step of generation?
   a) a finished sentence b) a probability distribution for the next token c) the closest document from the training data d) an answer from a knowledge base
2. Why is a model bad at comparing 9.11 and 9.9 and at counting letters in a word?
3. How does a base model differ from an assistant model, and which training stage turns the first into the second?
4. A user asks a model about a carrier that launched last week and gets a detailed, confident answer. What most likely happened?
5. Why is the context window limited, and why does its cost grow with length?
6. What is the "lost in the middle" effect, and how does it affect the way a prompt is assembled?
7. In a chatbot, the user says "as I wrote above…". How does the model "remember" what was above if the API is stateless?
8. What is wrong with this code?
   ```python
   client = anthropic.Anthropic(api_key="sk-ant-api03-...")
   ```
9. A `.env` file with a key was accidentally pushed to a private repository. What is the right first reaction?
   a) `git rm --cached .env` and a new commit b) rewrite history with a force push c) revoke the key in the console and issue a new one d) make the repository private once more
10. Why do output tokens usually cost more than input tokens, and what does that mean for prompt design?
11. What is wrong with this prompt if its goal is to get an exact total for the orders?
    ```
    Here are 400 shop orders in CSV. Calculate the revenue and fees for each payment provider.
    ```
12. Why set a spending limit before creating the first key, not after?
13. A short summary of the shop's monthly order export (with customers' names and addresses) is needed. Which model to choose?
    a) `deepseek-flash`, the cheapest b) `deepseek-v4-pro`, the smartest c) a local model in Ollama d) any cloud model from the Ollama catalog
14. `deepseek-flash` with default settings is passed `temperature=0`, and the answers still differ. Why, and what to do?
15. What is wrong with this code?
    ```python
    client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
    client.embeddings.create(model="deepseek-flash", input=["delivery cost"])
    ```

## Answers

1. **b.** The model outputs probabilities for every token in the vocabulary; the code around it picks (samples) one and repeats the loop.
2. The model sees tokens, not digits and letters: a number is cut into pieces that do not match the digit positions, a word into fragments. Character-level and digit-level operations are awkward for it.
3. A base model only continues text like a document from the internet; SFT on example dialogues turns it into an assistant (followed by RLHF/RL, which tune preferences and reasoning).
4. A hallucination: the event is after the knowledge cutoff, the model doesn't know about it but generates a plausible continuation. The fix is to give current data in the context (search, RAG, a tool).
5. Attention matches every token against all previous ones, so compute and memory grow faster than the length; in addition, the model was trained on sequences of limited length. We pay for every input token on every request.
6. The model uses information from the middle of a long context worse than from the beginning and the end. So: key instructions go into the system prompt and/or at the end, documents only relevant and compact.
7. The application sends the whole dialogue history in every request. The "memory" is the code and the context, and we pay for it in every next request.
8. The key is hardcoded: it will end up in git, logs, screenshots. The key should come from the environment (`ANTHROPIC_API_KEY`), and the SDK picks it up on its own.
9. **c.** Revoke the key first: only that closes the leak. Removing the file from git and cleaning up history can come later, but that is secondary.
10. Generation goes token by token and is computationally more expensive than reading the input. For design: ask for short answers, cap `max_tokens`, don't make the model rewrite large input texts.
11. The model is asked to calculate: arithmetic over 400 rows of tokenized numbers gives plausible but inaccurate sums. Code should do the calculation (pandas/SQL, on a copy of the data), and the model should get the finished totals to explain, or call a counting function as a tool. Plus, orders with customer data must not be sent to a cloud provider.
12. A bug in the very first script (endless retries, unbounded concurrency) can spend money before we get around to the limit; a limit and a small prepayment cap the damage from the first minute. For DeepSeek, a small prepaid balance plays the role of the limit.
13. **c.** Customers' personal data must not be sent to DeepSeek (servers in China) or to Ollama cloud models (they run on Ollama's servers). Only a local model downloaded with `ollama pull`. And the totals are still calculated by code; the model only describes the finished numbers.
14. DeepSeek has thinking mode on by default, and in it `temperature` has no effect (no error, no effect either). For temperature experiments we turn thinking off: `extra_body={"thinking": {"type": "disabled"}}`.
15. The client points at local Ollama, but the model given is a cloud one, DeepSeek, which Ollama doesn't know. On top of that, the DeepSeek documentation has no embeddings at all. What is needed is a local embedding model downloaded into Ollama, for example `bge-m3`.

## What's next

Next comes chapter 1.6 · The raw API: first requests to Claude and OpenAI (AIL-4), with the same requests on DeepSeek and Ollama and Claude/OpenAI for comparison, and chapter 1.7 · Tokens, temperature and the cost of an LLM request (AIL-5): a script that compares model answers and calculates the price of a request (with DeepSeek's cache hit/miss prices). In parallel, we keep watching "Deep Dive into LLMs" in parts: before week 2 (prompting, structured output, tool calling) it is useful to see its parts on hallucinations and tool use.
