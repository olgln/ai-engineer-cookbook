# 10.4 · A local LLM with Ollama: a comparison on our own evals  (AIL-47)

> **Week 10** · Production · ⏱ ~4 h · Practice

<!-- description: A local LLM with Ollama: memory for the weights, Q4 and Q8 quantization, generation speed, vLLM and a fair comparison with a cloud model on our own evals. -->
<!-- source-sha256: 405c308eb2a2 -->

## Why an AI engineer needs this

Clients regularly ask: "can we keep the data from going to the cloud?", "can it be cheaper on our own hardware?". The right answer is neither "yes" nor "no" but "here are the numbers on our evals: the local model gets X% versus Y% for the cloud one, here is the latency, here is what we would have to buy". In this chapter we get such numbers for the Shelf shop's support assistant and, along the way, figure out how quantization and model serving work, a frequent interview question.

## Theory

### When a local model makes sense at all

| Argument for | Comment |
|---|---|
| **Privacy** | The data never leaves the machine. For the shop this is not an abstraction: by the course rule, customer messages with phone numbers, emails and order numbers (`contains_personal_data` from 5.3) and the database snapshot `data/shop.db` in projects 1 and 4 are processed only by a local model. |
| **Zero price per token** | We pay for hardware and electricity, not per request. Pays off with large, steady traffic or background jobs. |
| **Offline and independence** | No 529 from the provider, no rate limit, no model changes without warning. Can serve as a fallback (AIL-45). |
| **Control** | A fixed version of the weights; we can fine-tune it (AIL-48). |

| Argument against | Comment |
|---|---|
| **Quality** | A 7–8B-parameter model is noticeably weaker than top cloud models at reasoning, following long instructions, tool calling and working with long context. |
| **Speed on a long prompt** | A 4–8k-token RAG prompt on an ordinary laptop takes seconds before the first token. |
| **Operations** | Memory, updates, monitoring, scaling are now ours. |

The conclusion we need to be able to back with numbers: a local model is good for **narrow, simple, frequent** tasks (classification, field extraction, query rewriting, summarizing short text) and for data that must not be sent out; a cloud model is for complex reasoning and agents.

### How much memory we need: the arithmetic of weights

If the arguments for win, the first practical question is whether the model fits on our machine. A model is an array of numbers (weights). Size in memory ≈ number of parameters × bytes per parameter:

How many bytes go to a parameter depends on the storage format: FP16/BF16 are ordinary 16-bit numbers, Q8 and Q4 are quantized variants with 8 and 4 bits (we cover what that means below):

```
8B params × 2 bytes (FP16/BF16)  ≈ 16 GB
8B × ~1 byte   (Q8)              ≈ 8.5 GB
8B × ~0.5–0.6  (Q4)              ≈ 4.5–5 GB
+ KV cache (grows with context length) + the process itself
```

The **KV cache** is memory for intermediate attention results for every token of the context. An 8B model with a 4k context takes less than the same model with a 32k context, and the difference can be gigabytes. So "the model fits" ≠ "the model fits with our RAG prompt".

On a Mac with Apple Silicon, memory is **shared** between the CPU and GPU, so the model runs entirely on the GPU if it fits into the part of RAM available to it; on a machine with a discrete graphics card, the model has to fit into video memory. A guide by memory size: **8 GB — 3–4B models in Q4** (the course default `qwen3:4b`, or an explicit tag such as `qwen3:4b-instruct-2507-q4_K_M`), 7–8B in Q4 only with everything else closed; **16 GB — 7–8B in Q4**; **32 GB and more — Q8 or models of 14B and larger**. The memory is shared by the model, `bge-m3`, the reranker, the browser and the IDE, so we leave headroom. If the model does not fit, some layers move to the CPU and speed drops several-fold.

### Quantization: Q4, Q8 and what the letters mean

Quantization is what lets an 8B model fit into 5 GB instead of 16. Quantization means storing weights with lower precision: instead of a 16-bit number, 8 or 4 bits plus scale factors per block of weights. An analogy: storing product prices not as `float64` but as small integers with one multiplier for the whole block, compact but lossy.

Ollama uses the **GGUF** format (from the llama.cpp project, which Ollama is built on). Quantization names:

| Label | Bits per weight (≈) | Quality | When to use |
|---|---|---|---|
| `fp16` / `bf16` | 16 | reference | research, if memory allows |
| `q8_0` | 8 | practically lossless | if memory allows |
| `q5_K_M` | ~5.5 | very close to q8 | a compromise |
| `q4_K_M` | ~4.5–5 | noticeably but moderately worse | a common default in Ollama |
| `q3`, `q2` | 3 and below | noticeable degradation | only when nothing else fits |

`K` is the "k-quants" family (block quantization with different precision for different parts), `M`/`S`/`L` is the size variant within it. The rule of thumb: **a large model in Q4 is usually better than a small one in FP16** with the same memory. But the losses from quantization depend on the task; precise things suffer most: arithmetic (an order total, a shipping rate by weight), strict format, long context. That is exactly why we measure them on our own evals instead of trusting tables.

### Speed: prefill and decode

Memory decides whether the model runs at all; speed decides whether it is usable. Generation has two phases:

```
prefill (processing the prompt)  decode (generating the answer)
all 5000 tokens of RAG context   token by token
in parallel, bound by            sequentially, bound by
compute                          memory bandwidth
   ↓                               ↓
determines TTFT                  determines tokens/s
```

Hence the surprise for RAG: in a short chat a local model seems fast (decode at tens of tokens per second), but on a prompt with 5–8 chunks from `kb/` the first letter appears after several seconds. We measure both values: TTFT and tokens/s.

### Ollama: what it is and how it works

We will measure all of this (memory, quantization, prefill and decode) on Ollama, which we have used since the first weeks of the course to run `qwen3:4b` and `bge-m3`. Now let's look at how it works in more detail. [Ollama](https://ollama.com) is a local model server: it downloads models from its registry (`ollama pull`), keeps them in memory and serves an HTTP API on `127.0.0.1:11434`. The facts that matter to us:

- **An OpenAI-compatible endpoint**: `base_url="http://localhost:11434/v1"`, any `api_key` (the client needs one, Ollama ignores it). Code on the OpenAI SDK or LiteLLM changes only the base_url and the model name.
- There is also a **native API** (`/api/chat`, `/api/generate`) with extra options, including `format` for structured output by a JSON schema.
- **The default context is 4096 tokens** (with less than 24 GB of memory, that is, on almost any laptop; we already ran into this in chapter 3.2, AIL-14). Anything longer is silently truncated. For RAG this is trap number one: the model "does not see" some of the chunks, and it looks stupid. It is increased with `OLLAMA_CONTEXT_LENGTH` when starting the server, `num_ctx` in the native API's `options`, or through a Modelfile (`PARAMETER num_ctx 16384`) by creating our own model (`ollama create`). A bigger context means more memory for the KV cache.
- The model is unloaded from memory after 5 minutes of idling (`keep_alive`). The first request after that includes the loading, so we exclude it from latency measurements (we warm up).
- Models live in `~/.ollama/models`.

An illustrative example, the same code as for the cloud:

```python
from openai import OpenAI

local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # key is ignored

resp = local.chat.completions.create(
    model="<model:tag from ollama list>",
    messages=[{"role": "system", "content": SYSTEM_RAG},
              {"role": "user", "content": build_user_msg(question, chunks)}],
    temperature=0,
)
print(resp.choices[0].message.content, resp.usage)
```

### Security: both the program and the model are third-party

- **Installing and updating Ollama** (we installed it in chapter 1.5 · How LLMs work: Karpathy's lecture and API keys, AIL-3) works like for any program: from the official site (on macOS also Homebrew), not a first-day release. On macOS, before the first launch we check the signature: `codesign -dv` and `spctl -a -vv` on the `.app`; on Linux and Windows we install following the official instructions on ollama.com.
- **The server listens only on `127.0.0.1`**: that is the default, and we keep it. Thousands of open Ollama servers without authentication are regularly found on the internet: anyone can run models on someone else's hardware, and vulnerabilities have been found in some versions. We do not set `OLLAMA_HOST` to `0.0.0.0`. From a Docker container (AIL-66) we go to `host.docker.internal:11434`.
- **Models only from the official Ollama registry or from known authors on Hugging Face** (the model developers' organizations, well-known quantizers). GGUF is a data format, not executable code, which makes it safer than pickle files, but a model from an unknown author may be fine-tuned for behavior the author wants (for example, inserting links or ignoring instructions). On top of that, the chat template in the Modelfile affects behavior.
- **The model license**: open-weight models come with different licenses (Apache 2.0, MIT, custom licenses with restrictions). For a learning project it does not matter, for a client it does; we check the model card.

### vLLM: how it is done in production

Ollama is a developer tool: one user, one laptop, convenience. When a model serves many users on a GPU server, people use serving engines such as [vLLM](https://docs.vllm.ai). The key ideas (for interviews):

- **Continuous batching**: requests from different users are merged into a shared batch on the fly, so a new request does not wait for others to finish. This sharply raises throughput.
- **PagedAttention**: the KV cache is stored in pages, like virtual memory in an OS, without fragmentation, so more concurrent requests fit.
- An OpenAI-compatible server, support for quantized models, distribution across several GPUs.

The trade-off: throughput (tokens per second for the whole server) versus the latency of a single request. Ollama optimizes for the convenience of one user, vLLM for throughput.

### A fair comparison with a cloud model

Now we know what to measure and what to run it on; what remains is to set up the experiment so that its result can be trusted. The experiment must change **one** variable: the generator. Everything else is fixed: the same set `eval/golden.jsonl` (AIL-28), the same index, retrieval and embeddings (we do not switch embeddings in this same experiment; that is a second experiment plus reindexing), the same answer prompt, `temperature=0`, the same LLM judge (a cloud one, the same for all rows; otherwise we are comparing judges).

| Column | How to measure |
|---|---|
| Retrieval hit rate | does not change: a control number showing nothing is broken; `archived_in_context` = 0 |
| Correctness / faithfulness | `eval/run.py` from AIL-29 |
| Share of answers with correct [n] citations to `kb/` | regex + judge |
| Correct refusals on questions with no answer in the knowledge base (`refusal_ok`, `false_refusals`) | from AIL-23 and AIL-29 |
| TTFT, p50/p95 latency, tokens/s | after warm-up, streaming for TTFT |
| Cost of 100 answers | cloud: `eval/cost.py` (AIL-29), the formula from AIL-45; local: $0 API + a note on hardware |

Taking noise into account (AIL-62): a difference of 2–3 pp on 50 questions can be random. We write down the number of questions.

## DeepSeek and Ollama: how we do it

This chapter is about Ollama anyway, so the section below adds to the theory what we will need when Ollama becomes not an experiment but a second working provider next to DeepSeek. The facts were checked against [docs.ollama.com](https://docs.ollama.com) and [api-docs.deepseek.com](https://api-docs.deepseek.com) in November 2026.

### The cloud row of the comparison: DeepSeek

In the "fair comparison" from the theory, the cloud model is **DeepSeek** (`deepseek-flash`; `deepseek-v4-pro` as the stronger one), on the set `eval/golden.jsonl` over the **public** knowledge base `kb/`. The questions and the knowledge base are made up and public, so we may send them to the cloud. Only `base_url` and the model change. `rag-local-q4` and `rag-local-q8` are our local models with an increased context in two quantizations; we create them in the Practice through a Modelfile:

```python
import os
from openai import OpenAI

cloud = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com", timeout=60)
local = OpenAI(api_key="ollama", base_url="http://localhost:11434/v1")   # key is ignored

GENERATORS = {
    "deepseek-flash": (cloud, "deepseek-flash", {"extra_body": {"thinking": {"type": "disabled"}}}),
    "local-q4":       (local, "rag-local-q4", {"temperature": 0}),
    "local-q8":       (local, "rag-local-q8", {"temperature": 0}),
}
```

In the runner from chapter 6.4 these are three configs for `eval/run.py --config`: `eval/configs/baseline.json` (`"answer_model": "deepseek-flash"`, `"answer_thinking": false`) and `eval/configs/local_q4.json`, `local_q8.json`, copies of baseline that differ only in `answer_model` (`rag-local-q4`, `rag-local-q8`).

A subtlety that spoils the comparison: DeepSeek has thinking mode **on by default**, and in it `temperature` is silently ignored. Either we turn thinking off for the cloud row (as above), or we compare "cloud with thinking" as a separate row, but we do not mix them. Local models with thinking (if the chosen one supports it) are also a separate row.

**The judge** is a model stronger than the ones being evaluated and the same for all rows: `deepseek-v4-pro` for the public set; Claude if we want to compare judges. On data with personal details (customer messages, the snapshot `data/shop.db`), a cloud judge is forbidden by the same rule as a cloud generator: there the judge is code, manual review and the strongest local model that fits in memory, or the evaluation runs on the demo database `data/demo_shop.db`.

### The OpenAI-compatible endpoint vs the native Ollama API

The [OpenAI-compatible layer](https://docs.ollama.com/api/openai-compatibility) is handy for switching but does not support everything. As of November 2026, `/v1/chat/completions` has **no** `tool_choice`, `logprobs`, `n`, `logit_bias`, `user`, and images are base64 only. If our code needs any of these (for example, a forced tool call), that is a difference between providers, not a bug. The native API (`/api/chat`, the official `ollama` library) gives what the compatible layer lacks or makes awkward:

- `options={"num_ctx": 16384}` per request: context without a separate Modelfile;
- `keep_alive` per request (`-1` keeps the model in memory, `0` unloads it right away);
- per-phase metrics in nanoseconds (`load_duration`, `prompt_eval_duration`, `eval_duration`, `prompt_eval_cached_count`), which give TTFT without the network and tokens/s, see chapter 10.3 (AIL-46);
- **structured output by a JSON schema** via `format` ([Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)); in the compatible layer, via `response_format`.

```python
# illustrative: native Ollama call with a JSON schema (ollama Python library, pinned)
from pydantic import BaseModel
import ollama

class StructuredAnswer(BaseModel):   # not rag.pipeline.Answer: this is the raw model output
    answer: str
    sources: list[int]      # chunk numbers [n]
    found: bool             # False -> code returns REFUSAL and offers handoff()

r = ollama.chat(model="rag-local-q4", messages=messages,
                format=StructuredAnswer.model_json_schema(), options={"num_ctx": 16384, "temperature": 0})
ans = StructuredAnswer.model_validate_json(r.message.content)   # still validate: the schema guides, code verifies
```

DeepSeek does structured output differently: a JSON mode through `response_format` (chapter 2.2 · Structured output: Pydantic + Instructor, AIL-8). If the assistant's answer is structured, we compare the same modes.

### Embeddings: local only

DeepSeek has **no** embeddings endpoint (there is none in the API Reference as of November 2026), so embeddings in this book come from Ollama (`bge-m3` via `/api/embed`, or `/v1/embeddings` through the OpenAI client, [Embeddings](https://docs.ollama.com/capabilities/embeddings)) or sentence-transformers. For this chapter the rule from the theory stands: we **do not change** the embeddings in the experiment; switching the generator and reindexing are two different experiments.

### Ollama on a Mac: native, not in Docker

On macOS Ollama uses the Apple Silicon GPU through Metal ([Hardware support](https://docs.ollama.com/gpu)), but **only when run natively**: in Docker Desktop on macOS the GPU is unavailable, as there is no GPU passthrough ([FAQ](https://docs.ollama.com/faq)). The `ollama/ollama` container on a Mac runs on the CPU and is several times slower. So on a Mac, Ollama is a native app, and the support assistant in a container reaches it through `host.docker.internal:11434` (chapter 10.1 · Docker: packaging an LLM project, AIL-66). The Ollama container is for a Linux server with a GPU and for a portfolio reviewer; graphics card support on Linux and Windows is described on the same Hardware support page.

Memory, beyond the weights and KV cache from the theory:

- `OLLAMA_NUM_PARALLEL` (default 1): how many requests the model handles at once; per the FAQ, the required RAM grows as `OLLAMA_NUM_PARALLEL × OLLAMA_CONTEXT_LENGTH`. A parallel evals run with `num_ctx=16384` and 4 threads means four contexts in memory.
- `OLLAMA_KV_CACHE_TYPE` (default `f16`): quantization of the KV cache; it works with Flash Attention enabled and noticeably saves memory on long context. This is yet another experiment variable: if we change it, it is a separate row in the table.
- `OLLAMA_MAX_LOADED_MODELS`: how many models are in memory at once. Two quantizations of the same model in one run mean two copies of the weights.

### Ollama Cloud is not local

Ollama has cloud models and a cloud API (`https://ollama.com/v1`, key `OLLAMA_API_KEY`, [Cloud](https://docs.ollama.com/cloud)). A request to a cloud model goes to their servers instead of staying on our machine, even if it is called through the same `ollama` command. For customer messages and the database snapshot this is the same as any cloud: not allowed. We check that `ollama list` for private tasks shows only local models and that `base_url` is `localhost`.

### Comparing providers on what this chapter relies on

| What | Claude | OpenAI | DeepSeek | Ollama (local) |
|---|---|---|---|---|
| Where the data is processed | Anthropic's cloud | OpenAI's cloud | cloud, servers in China: **no customer personal data** | our own machine |
| Price of 100 answers | per price list, with caching | per price list, with caching | an order of magnitude cheaper, automatic caching, −50% off-peak | $0 API + hardware |
| Context length | large, see the model docs | large, see the model docs | 1M tokens for both models | **4096 by default** (with less than 24 GB of memory), more via `num_ctx`, at the cost of memory |
| Structured output | tool use / structured outputs | `response_format` with a JSON schema | JSON mode (`response_format`) | `format` with a JSON schema (native API), `response_format` (compatible) |
| Tool calling | yes, including forced choice | yes, including `tool_choice` | yes; in thinking mode `reasoning_content` has to be sent back in the following requests | only for models with tools support; no `tool_choice` in the compatible layer |
| Embeddings | no endpoint of its own | yes | **no** | yes |
| `temperature=0` for reproducibility | see the limitations of newer models (chapter 1.7, AIL-5) | works | ignored in thinking mode | works |
| Cold start | no | no | no (but a queue under load) | model loading after `keep_alive` |

### What to use for the practice

Generators: `deepseek-flash` (cloud) versus a local model in two quantizations; the judge is `deepseek-v4-pro`, the same for all rows; the set is `eval/golden.jsonl` over the public `kb/`. Then a separate small run, "what to choose for private tasks", where the cloud does not take part at all: only local models on the snapshot `data/shop.db` (`scripts/snapshot.sh`, `VACUUM INTO`, read-only), the analyst bot from project 1 with the questions from `questions.md`.

## Learning path

1. Open [Ollama](https://ollama.com) and [GitHub ollama/ollama](https://github.com/ollama/ollama) → README: installation, `ollama run/pull/list/ps`, the REST API, the section on models and memory (≈30 min). Note the RAM requirements for different model sizes.
2. In the Ollama documentation open the [OpenAI compatibility](https://docs.ollama.com/openai) page and the [FAQ](https://docs.ollama.com/faq) → how to set the context (`num_ctx`, `OLLAMA_CONTEXT_LENGTH`), `keep_alive`, `OLLAMA_HOST`, where models live (≈25 min). The main thing is the default of 4096 context tokens.
3. Open the [Ollama model library](https://ollama.com/library) → pick 2 candidates by your machine's memory (8 GB — 3–4B; 16 GB — 7–8B; 32 GB+ — 14B and larger) with support for the functions we need (tools, for the analyst bot from project 1), look at the available quantization tags and sizes (≈20 min). Read the model card: author, license, context length.
4. Quantization: in the llama.cpp repository on GitHub, find the description of GGUF quantizations / k-quants; plus the GGUF page in the Hugging Face Hub docs (≈20 min). The goal is to understand what `q4_K_M` and `q8_0` mean, not the formulas.
5. Open [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) → the lists of supported and **unsupported** fields for chat completions and embeddings (≈10 min). Mark everything our code uses.
6. Open [Ollama: Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs), [Embeddings](https://docs.ollama.com/capabilities/embeddings) and [Tool calling](https://docs.ollama.com/capabilities/tool-calling) (≈25 min). Note that `format` accepts the JSON schema of a Pydantic model.
7. Open [Ollama: Usage](https://docs.ollama.com/api/usage) and [Hardware support](https://docs.ollama.com/gpu) → the timing metrics (nanoseconds) and the section on your platform: Metal on a Mac, graphics cards on Linux and Windows (≈10 min).
8. Open [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) → how to turn thinking off and what is ignored in this mode (≈10 min): we need this so the cloud row of the comparison is fair.
9. Open [vLLM](https://docs.vllm.ai) → the overview / Getting started and the section describing PagedAttention and continuous batching (≈25 min). The goal is to be able to explain in 2 minutes how vLLM differs from Ollama.

## What to watch out for

- **Truncated context.** The most common reason for "the local model answers nonsense" in RAG. We check: is `usage.prompt_tokens` in the response ≈ the expected prompt length? If it hits exactly 4096, that is truncation.
- **Cold start in measurements.** The first request includes loading the model into memory. We warm up, then measure.
- **Comparing different things:** if we changed the model and the embeddings at once, or tuned the prompt for the local model, the result cannot be interpreted.
- **Answer format.** Small models are worse at keeping rules like "every claim with a citation [n]" and "if the answer is not in the knowledge base, reply with the phrase REFUSAL". That is normal, and it is a result, not a bug; a simplified prompt may be needed, but then it is a separate row in the table.
- **Tool calling** is not supported by all local models and works less reliably. For the analyst bot (project 1) and the order-investigating agent (project 4) this is especially noticeable.
- **The laptop at work.** With 8 GB, even a 4B model in Q4 takes a noticeable share of memory, and an 8B in Q4 takes more than half; with 16 GB, an 8B in Q4 with a long context takes about a third. The model heats the laptop and drains the battery. During a run we close heavy things (a browser with dozens of tabs, an IDE that is indexing, Docker), otherwise the latency measures swap, not the model. `ollama stop <model>` after work.
- **Unofficial models** like "uncensored-super-v2" from unknown authors: no.
- **"Free".** The tokens are, but in the README we state the hardware and that on a server this would be GPU rental.
- **Ollama in Docker on a Mac** runs without a GPU, on the CPU. We do not compare latency numbers from a container on a Mac with native ones.
- **A cloud model through `ollama`** is not local. For private tasks we check that the model is downloaded and `base_url` is `localhost`.
- **The conclusion "the local one is worse, so everything goes to the cloud"** breaks the privacy rule: messages with customers' personal data and the database snapshot still do not go to the cloud. The choice for them is a local model or a human operator (`handoff`), not DeepSeek.
- **Unequal conditions with DeepSeek:** thinking is on by default and `temperature` is ignored in that mode; the cloud row is then a different configuration than it seems.
- **Code that relies on `tool_choice`** will not work on Ollama through the compatible layer: the field is not there.

## Practice

- [ ] Check the Ollama installed in chapter 1.5: `ollama --version`. If it needs updating: on macOS from the official site or via brew, checking the new version's signature (`codesign -dv`, `spctl -a -vv`) before the first launch; on Linux and Windows, following the official instructions. Make sure the server listens only on loopback: `lsof -nP -iTCP:11434 -sTCP:LISTEN` (macOS, Linux) shows `127.0.0.1`.
- [ ] Pick a model from the official registry by memory size (8 GB — 3–4B, `qwen3:4b` by default; 16 GB — 7–8B; 32 GB+ — 14B and larger) and download it in two quantizations if available (for example, `q4_K_M` and `q8_0`; with 8 GB, Q8 still fits for a 4B but not for an 8B). Write down the size on disk (`ollama list`) and in memory (`ollama ps`).
- [ ] A quick test in the terminal: `ollama run <model>` and 3 questions about the Shelf shop's rules without context ("can I return opened tea?", "what is the warranty on LAMP-LIGHT-MINI?", "does TEA15 stack with a discount?"); watch how the model makes things up without RAG.
- [ ] Increase the context for the RAG prompt: create a `Modelfile`:
  ```
  FROM <model:tag>
  PARAMETER num_ctx 16384
  PARAMETER temperature 0
  ```
  `ollama create rag-local-q4 -f Modelfile` (and `rag-local-q8` with `FROM` set to the second quantization). With 8 GB, start with `num_ctx 8192`: the context takes memory too. Check `ollama ps`: how much memory it takes now and whether the model is entirely on the GPU.
- [ ] Connect it to the support assistant: in `.env` set `ANSWER_PROVIDER=ollama`, `ANSWER_MODEL_LOCAL=rag-local-q4`, `OLLAMA_BASE_URL=http://localhost:11434/v1` (or `host.docker.internal` from a container). Switching is done with an environment variable, without editing code.
- [ ] Truncation check: on 3 questions, compare the expected prompt length (count the tokens) with `usage.prompt_tokens` from Ollama.
- [ ] Run the set `eval/golden.jsonl` over the **public** `kb/`: `eval/run.py` with the configs `baseline.json` (`deepseek-flash`, thinking off), `local_q4.json` and `local_q8.json`. For each row: correctness/faithfulness (the judge is `deepseek-v4-pro`, the same for all rows), the share of answers with correct citations, correct refusals, p50/p95, the cost of 100 answers. Measure TTFT and tokens/s with a separate script `eval/bench_local.py` (warm-up, streaming, sequentially). Traces go to Langfuse tagged with the model (AIL-46): the set contains only made-up questions, so they may go there.
- [ ] Rows in the experiments table (AIL-35):
  ```markdown
  | Experiment | Hit rate | Correctness | Citations OK | p50 / p95 | Cost of 100 answers |
  |---|---|---|---|---|---|
  | Cloud deepseek-flash | ... | ... | ... | ... | $... (peak/off-peak) |
  | Local <model> q4_K_M | ... | ... | ... | ... | $0 API (CPU/GPU ?, RAM ? GB) |
  | Local <model> q8_0 | ... | ... | ... | ... | $0 API |
  ```
- [ ] (For comparison) Add a row with Claude or OpenAI on the same questions, if we have a key: how much more expensive, and is it better.
- [ ] Structured output: switch the local model's answer to `format` with the Pydantic schema `StructuredAnswer` (`answer`, `sources`, `found`) through the native API. Compare the share of valid answers and correct citations with free text.
- [ ] Metrics from the native API: for 10 requests, record `load_duration`, `prompt_eval_duration`, `eval_count/eval_duration`. Does the tokens/s match our measurement through streaming?
- [ ] Review: 5 questions where the local model was wrong and the cloud one was not. What type of error (did not find it in the context, broke the format, made things up, confused Light and Light Mini, did not refuse)? Write them down, possibly with the codes from 7.4 (AIL-34).
- [ ] A conclusion in 3–5 sentences: where the local model is good enough (for example, query rewriting `plan_query_ollama` from AIL-60, which can be checked separately with `eval/run_query_eval.py`), where it is not, and what to choose for private tasks. For those we compare only local candidates (the cloud is not an option there): the analyst bot from project 1 with `LLM_PROVIDER=ollama` on the snapshot `data/shop.db` (read-only), 10 questions from `questions.md` via `scripts/run_questions.py` on two local models; `assert_data_policy` will not let us accidentally plug in a cloud one.
- [ ] After work: `ollama stop <model>`.

## Done when

- The experiments table has a "local model" row (better two, for different quantizations) with quality, latency and cost computed on the same set as the cloud one.
- The context is configured for the RAG prompt and truncation has been checked via `usage`.
- There is a written conclusion: where the local model is sufficient and where it is not, with numbers, and what we use for customer data.

## Self-check quiz

1. Roughly how much memory will the weights of an 8B-parameter model take in FP16 and in Q4?
2. Why can a model that "fits" in memory fail to fit with a 16k-token RAG prompt?
3. A local model in RAG answers as if it does not see half of the knowledge base chunks. What is the most likely cause in Ollama, and how do we check it?
4. What is usually better with the same memory?
   a) a 3B model in FP16  b) an 8B model in Q4  c) always the same  d) a 1B model in FP32
5. How does prefill differ from decode, and which phase determines TTFT?
6. What is wrong with this experiment: "we switched the generator to a local model, switched the embeddings to different ones too, simplified the prompt, made the judge local as well, and quality dropped by 20%, so local models are bad"?
7. Why should we not run Ollama with `OLLAMA_HOST=0.0.0.0` on a laptop or a server?
8. Why is the first request to Ollama after a pause slow, and how do we account for it in measurements?
9. What are the two key vLLM techniques that raise throughput on a server?
10. Which tasks from the course projects are good candidates for a local model, and which are not?
11. Why should models be taken only from the official registry or from known authors, if GGUF is a data format and not code?
12. The `ollama/ollama` container on a Mac with Apple Silicon gives 3 tokens/s versus 40 for native Ollama. Why?
13. The cloud row of the comparison is DeepSeek with default parameters and `temperature=0`. What is wrong with this row?
14. Why are the embeddings in this book computed by Ollama and not DeepSeek, and why can they still not be changed in this experiment?

## Answers

1. FP16: ≈ 8B × 2 bytes ≈ 16 GB. Q4: ≈ 4.5–5 GB. Plus the KV cache and overhead.
2. The KV cache grows with context length and can take gigabytes; memory = weights + KV cache + process.
3. The default context is 4096 tokens, so the prompt is truncated. Check `usage.prompt_tokens` against the expected length; increase `num_ctx` (Modelfile/`OLLAMA_CONTEXT_LENGTH`/options).
4. **b.** Usually a larger model with moderate quantization beats a small one at full precision, but we have to check on our own evals.
5. Prefill processes the whole prompt in parallel, decode generates token by token. TTFT is determined by prefill, tokens/s by decode.
6. Four variables were changed at once, including the judge, so the result cannot be attributed to the generator. We change one variable, and the judge is the same for all rows.
7. A server without authentication becomes reachable from the network: strangers can use our hardware, and the server's vulnerabilities become remotely exploitable. Listen only on `127.0.0.1`.
8. Through `keep_alive` (5 minutes by default) the model is unloaded, and the request includes loading it into memory. Send a warm-up request and exclude it from the statistics.
9. Continuous batching (dynamically merging requests into a batch) and PagedAttention (paged storage of the KV cache without fragmentation).
10. Good: query rewriting, classifying and routing a customer's question, extracting fields from supplier messages, short summaries, and everything where the data must not leave: customer messages with phone numbers, emails and order numbers, the shop's database snapshot. Bad: the order-investigating agent with multi-step tool calling, answers with strict citation of a long context.
11. The weights determine behavior: a model from an unknown author may be fine-tuned for harmful behavior (inserting links, ignoring instructions), and the chat template affects the answers. A trusted source lowers the risk of a swap.
12. Docker Desktop on macOS has no GPU passthrough: the container runs on the CPU. On a Mac, Ollama is run natively (Metal), and containers reach it through `host.docker.internal`.
13. DeepSeek has thinking on by default, and in that mode `temperature` is ignored: the row is "cloud with thinking", more expensive and slower, and not the configuration written in the report. Turn thinking off (`thinking: disabled`) or make two separate rows.
14. DeepSeek has no embeddings endpoint, while Ollama does (`/api/embed`). In the experiment only the generator changes: changing the embeddings requires reindexing and changes retrieval, which is a second experiment.

## What's next

We have seen where a small model loses. The next question is whether fine-tuning can pull it up: in chapter 10.5 · Fine-tuning: a basic LoRA example (AIL-48) we look at when that is justified and when a prompt or RAG solves the task.
