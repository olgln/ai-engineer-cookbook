# 1.6 · The raw API: first requests to Claude and OpenAI  (AIL-4)

> **Week 1** · LLM basics · ⏱ ~4 h · Practice

<!-- description: The raw LLM API: request and response anatomy, message roles, multi-turn chat, stop_reason and streaming in Anthropic, OpenAI, DeepSeek and Ollama. -->
<!-- source-sha256: 4ae3addbc0b6 -->

## Why an AI engineer needs this

LangChain, LlamaIndex, Vercel AI SDK, Instructor, agent frameworks — all of them are wrappers around a single HTTP request: "here is a list of messages, continue it". When something breaks (the model "forgot" the context, the response was cut off, the bill tripled), this request is what we end up debugging. Interviews often ask to show on a whiteboard how a multi-turn conversation works and what `stop_reason` is — today we get our hands on it.

In chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3) we got a DeepSeek key, installed Ollama and sent one "Say ok" request to each. Now we take apart what that request is made of, what comes back and how a conversation is assembled from such requests.

## Theory

### The model is a function without memory

The most important thing to learn on day one: **the LLM API is stateless**. The server does not store our conversation. Every request is the full "script" of the conversation, which we send in its entirety, and the model writes the next line.

```
request 1:  [user: "My name is Emily"]                        → "Hi, Emily!"
request 2:  [user: "My name is Emily",
             assistant: "Hi, Emily!",
             user: "What is my name?"]                         → "Emily"
request 2': [user: "What is my name?"]                         → "I don't know"
```

If request 2 doesn't include the history, the model "forgets" the name. An analogy from web development: it is like a REST endpoint without a session — all the state is in the request body. The consequences:

- a long conversation = every next request costs more (we pay again for all the previous tokens as input);
- a chatbot's "memory" is our code, which decides what to put into `messages` (the whole history, the last N turns, a short summary);
- the history can be faked: we can write an `assistant` turn into `messages` that the model never said. One of the ways to show the model examples is built on this (few-shot, chapter 2.1 · Prompting: roles, few-shot, structure (AIL-7)).

(Some providers offer optional server-side storage — in OpenAI's Responses API it is `previous_response_id`, Anthropic has beta features such as threads. But while learning we keep the history ourselves: that way we see what actually goes to the model.)

### Anatomy of a Messages API request (Anthropic)

Let's see what this "script" looks like on the wire. We start with the Anthropic API: every part of the request and response is named explicitly there, so it is convenient for learning how things work. Later we will see that OpenAI, DeepSeek and Ollama name the same parts differently, but the meaning doesn't change.

```
POST https://api.anthropic.com/v1/messages
headers:
  x-api-key: <key from an environment variable>
  anthropic-version: 2023-06-01      ← API version, a required header
  content-type: application/json
body:
{
  "model": "claude-haiku-5-5",
  "max_tokens": 1024,
  "system": "A concise assistant of the Shelf online shop. Answer briefly.",
  "messages": [
    {"role": "user", "content": "What is cash on delivery?"}
  ]
}
```

| Field | What it is |
|---|---|
| `model` | The model ID. Exact names change — we check the Models page in the docs |
| `max_tokens` | **A hard ceiling** on the response length in tokens. The model doesn't know about it: at the limit it is simply cut off |
| `system` | The system prompt: role, rules, context. A separate field, not a message |
| `messages` | The conversation: alternating `user` / `assistant`, `user` goes first |

The `content` field can be a string or a list of blocks: `{"type": "text", ...}`, `{"type": "image", ...}`, `{"type": "tool_result", ...}` and so on. A string is shorthand for a single text block.

### Anatomy of a response

An illustrative response (fields shortened):

```json
{
  "id": "msg_01...",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-5-5",
  "content": [
    {"type": "text", "text": "Cash on delivery means paying for the order when it is received..."}
  ],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 31, "output_tokens": 87}
}
```

Three fields we will be looking at for our whole career:

1. **`content` is a list of blocks, not a string.** Modern Claude models have "thinking" (adaptive thinking) on by default: before answering, the model writes reasoning for itself, and it arrives as a separate block. The first block may be `{"type": "thinking", ...}`, with the text second. So `response.content[0].text` is a bad habit. The right way: go through the blocks and take those with `type == "text"`.
2. **`stop_reason` — why the model stopped:**

| `stop_reason` | Meaning | What to do |
|---|---|---|
| `end_turn` | The model finished on its own | All good |
| `max_tokens` | It hit our `max_tokens` | The response is truncated! Raise the limit or continue |
| `stop_sequence` | One of our stop sequences appeared | Expected, if we set one |
| `tool_use` | The model wants to call a tool | The topic of chapter 2.6 (AIL-10) |
| `refusal` | The model refused to answer for safety reasons | Don't read `content` as a normal response |

3. **`usage` — how many tokens were consumed.** `input_tokens` (everything we sent: system + history) and `output_tokens` (what the model generated, including thinking). This is exactly what we pay for; details in chapter 1.7 (AIL-5).

### Message roles

The request already had `system` and messages with a `role` field. Let's see how the roles differ.

- **system** — "the employer's instructions": who the model is, what is allowed, what format to answer in. Models are trained to treat it as high-priority rules.
- **user** — the user's turns (and everything we insert on the user's behalf: documents, tool results).
- **assistant** — the model's turns. We put them back into the history.

OpenAI has a few more roles: Chat Completions has `system` (in newer models `developer` plays its role), and in the Responses API the system prompt is passed as the `instructions` parameter. The idea is the same.

### Anthropic vs OpenAI: the same thing in different words

OpenAI has two APIs for text generation, and both show up in other people's code. Let's map their fields to the ones we've already covered:

| | Anthropic Messages | OpenAI Responses | OpenAI Chat Completions |
|---|---|---|---|
| Endpoint | `/v1/messages` | `/v1/responses` | `/v1/chat/completions` |
| System prompt | `system` | `instructions` | a `system`/`developer` message |
| Input | `messages` | `input` (a string or a list) | `messages` |
| Response limit | `max_tokens` (required) | `max_output_tokens` | `max_completion_tokens` |
| Why it stopped | `stop_reason` | `status` + `incomplete_details` | `choices[0].finish_reason` |
| Tokens | `usage.input_tokens/output_tokens` | `usage.input_tokens/output_tokens` | `usage.prompt_tokens/completion_tokens` |
| Text in the SDK | blocks with `type=="text"` | `response.output_text` | `choices[0].message.content` |

Responses is OpenAI's newer API, and it is the one recommended for new projects; Chat Completions is still alive and has become the de facto standard of "OpenAI-compatible" APIs (Ollama, OpenRouter and many open-source servers speak exactly that). It is worth knowing both.

### Python SDK: a minimal call

There is no need to build the HTTP request by hand: providers have official SDKs. Illustrative, in the style of the official SDKs (we check model names against the docs on the day we work):

```python
import anthropic
from openai import OpenAI

claude = anthropic.Anthropic()          # reads ANTHROPIC_API_KEY from env
resp = claude.messages.create(
    model="claude-haiku-5-5",
    max_tokens=512,
    system="Answer in one sentence.",
    messages=[{"role": "user", "content": "What is cash on delivery?"}],
)
text = "".join(b.text for b in resp.content if b.type == "text")
print(text, resp.stop_reason, resp.usage)

oai = OpenAI()                          # reads OPENAI_API_KEY from env
r = oai.responses.create(
    model="gpt-5-mini",                 # check current model names in the docs
    instructions="Answer in one sentence.",
    input="What is cash on delivery?",
    max_output_tokens=512,
)
print(r.output_text, r.status, r.usage)
```

An SDK is a thin layer over HTTP: it adds the headers, retries network errors and 429/5xx, turns JSON into typed objects. It does nothing "smart" by itself.

### Streaming

While the response is being generated, the chatbot user stares at an empty screen. Without streaming we wait for the whole response (10–30 seconds for a long text) and then get it all at once. With streaming the server sends **Server-Sent Events**: a stream of small `content_block_delta` events with pieces of text. It is the same principle as WebSocket notifications about an order's status: subscribing to a stream instead of polling.

```
event: message_start         → metadata, usage.input_tokens
event: content_block_start   → a block started (thinking / text / tool_use)
event: content_block_delta   → "Cash on"
event: content_block_delta   → " delivery"
...
event: message_delta         → stop_reason, usage.output_tokens
event: message_stop
```

The Anthropic Python SDK has a handy helper:

```python
with claude.messages.stream(model=MODEL, max_tokens=1024, messages=history) as stream:
    for chunk in stream.text_stream:       # only text deltas
        print(chunk, end="", flush=True)
    final = stream.get_final_message()     # full Message with usage and stop_reason
```

With OpenAI: `oai.responses.create(..., stream=True)` returns an iterator of events; the text arrives in events of type `response.output_text.delta` (the `delta` field).

Streaming doesn't make a response cheaper and doesn't speed up generation — it shortens the **time to first token** the user sees and protects long requests from HTTP timeouts.

### Secrets

All the examples above take the key from the environment — that is what we agreed on in chapter 1.5 (AIL-3). A reminder of the layout for the study repo:

```
ai-engineering-journey/
  .env            # ANTHROPIC_API_KEY=..., OPENAI_API_KEY=...  ← in .gitignore!
  .gitignore      # .env, .venv/, logs/
  exercises/week-01/chat.py
```

`python-dotenv` loads `.env` into `os.environ` (`from dotenv import load_dotenv; load_dotenv()`), and the SDKs read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` themselves. A key in the code, in a notebook with output or in a log is a leak; bots scan GitHub for keys within minutes.

## DeepSeek and Ollama: how we do it

We learn on two cheap/free options, while Claude and OpenAI from the theory above remain the reference for comparison:

- **DeepSeek API** — the main cloud model: cheap, speaks the OpenAI Chat Completions protocol. **The servers are in China**: only study questions and public texts go there, never customer data, work code, the order event log, keys, `.env` or anything personal. This rule applies to any cloud provider. DeepSeek's privacy policy states plainly that data is stored and processed in China, and whether the models are trained on API data is worded ambiguously in its documents — we assume they may be.
- **Ollama** — a local model server on our machine: free, offline, the data doesn't leave the computer. Everything involving data that must not be shown to outsiders is done only on it in this course.

### What DeepSeek offers (checked against api-docs.deepseek.com on November 13, 2026 — worth rechecking)

- Base URL for the OpenAI SDK: `https://api.deepseek.com`; there is also an Anthropic-compatible `https://api.deepseek.com/anthropic` and the Responses API.
- Models: `deepseek-flash` (currently backed by DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro`. A 1M context, a maximum response of 384K. The old name `deepseek-v4-flash` is still accepted, but the models behind it have been retired — old tutorials mention `deepseek-chat` / `deepseek-reasoner`, which are not in the current docs.
- **Thinking mode is on by default.** The reasoning arrives in a separate field, `message.reasoning_content`, next to `content` (the counterpart of Claude's `thinking` block) and is billed as output. It is turned off like this: `extra_body={"thinking": {"type": "disabled"}}`. For the first experiments we turn it off — that makes it easier to see what is going on.

```python
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
deepseek = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")

r = deepseek.chat.completions.create(
    model="deepseek-flash",                       # check current names on the pricing page
    messages=[
        {"role": "system", "content": "Answer in one sentence."},
        {"role": "user", "content": "What is cash on delivery?"},
    ],
    max_tokens=512,
    extra_body={"thinking": {"type": "disabled"}},  # thinking is ON by default
)
choice = r.choices[0]
print(choice.message.content)
print(choice.finish_reason)                       # "stop" / "length" / "tool_calls"
print(r.usage)   # prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens
```

With thinking on, we read `getattr(choice.message, "reasoning_content", None)` — this field is not part of the standard OpenAI schema, and the SDK stores it as an "extra". In a conversation history without tools there is no need to send it back (the API ignores it); with tools it is required, otherwise a 400 (chapter 2.6 · Tool calling: the model calls 3 functions (AIL-10)).

Streaming works as in OpenAI Chat Completions: `stream=True`, the text is in `chunk.choices[0].delta.content`, the reasoning in `delta.reasoning_content`; to get `usage`, we add `stream_options={"include_usage": True}` — it arrives in the last chunk, whose `choices` may be empty (we check `if chunk.choices`). Under load DeepSeek keeps the connection alive with empty lines / `: keep-alive` SSE comments — the SDK handles them, but a hand-written SSE parser must skip them.

### What Ollama offers (checked against docs.ollama.com on November 13, 2026)

We installed Ollama in chapter 1.5 following the checklist for third-party code: only from [ollama.com](https://ollama.com) (macOS 14+; on Apple Silicon the GPU is used), on macOS, before the first launch, a signature check with `codesign -dv --verbose=4 /Applications/Ollama.app` (who signed it) and `spctl -a -vv /Applications/Ollama.app` (Apple notarization); on other OSes, the official installer per the docs. If this step was skipped, we do it now. The server listens on `127.0.0.1:11434` — we don't expose it to the network (we leave `OLLAMA_HOST` alone). Models weigh gigabytes and live in `~/.ollama`.

**The model size depends on the machine's memory.** Memory is shared by the model, the system and all open programs (on Apple Silicon it is also shared between the CPU and GPU), so the rule of thumb is:

- **8 GB RAM — models of the 3–4B class.** By default the course uses `ollama pull qwen3:4b` (≈2.5 GB, supports tools and thinking) — all the examples are designed for it;
- **16 GB — 7–8B** (`qwen3:8b`, ≈5.2 GB). On 8 GB such a model runs only with all other programs closed: if the system starts pushing memory into swap, everything slows down, including work applications;
- **32 GB and more — 14B and larger** (`gpt-oss:20b` and the like); on 8 GB they don't fit at all.

We keep `num_ctx` modest (8K, not 32K — the KV cache eats memory too) and unload the model after work: `ollama stop qwen3:4b` or `keep_alive=0` in the request. The catalog changes fast; we choose from [ollama.com/library](https://ollama.com/library), looking at the *tools* / *thinking* tags and the size.

In chapter 1.5 we talked to Ollama through the `openai` package. There is a second way too — its own client; it is useful to know both:

```python
from openai import OpenAI
import ollama   # official client: pip package "ollama" (github.com/ollama/ollama-python); pin the version

# 1) OpenAI-compatible endpoint: the same code as for DeepSeek, another base_url
local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")   # key is required by the SDK but ignored
r = local.chat.completions.create(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "What is cash on delivery? One sentence."}],
)
print(r.choices[0].message.content, r.choices[0].finish_reason, r.usage)

# 2) Native API: more knobs (think, options, keep_alive, timings)
resp = ollama.chat(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "What is cash on delivery? One sentence."}],
    think=False,                      # True/False or a model-defined level, see /api/show
    options={"num_ctx": 8192},        # default context is only 4096 tokens!
)
print(resp.message.content, resp.done_reason, resp.prompt_eval_count, resp.eval_count)
```

The native response is useful for learning: `prompt_eval_count` / `eval_count` are the input and output tokens, `prompt_eval_duration` / `eval_duration` are times in nanoseconds (they show our machine's speed in tokens/s), `load_duration` is how long the model took to load into memory (the first request is always slow; after that the model stays in memory for 5 minutes by default).

### One task, four providers

Let's put it all together: the same operation, "send a conversation, get a response", across four providers.

| | Claude (Messages) | OpenAI (Responses) | DeepSeek | Ollama |
|---|---|---|---|---|
| Protocol | its own `/v1/messages` | `/v1/responses` (+ Chat Completions) | Chat Completions; also Anthropic-compatible and Responses | OpenAI-compatible `/v1/...` and native `/api/chat` |
| SDK | `anthropic` | `openai` | `openai` with `base_url` (or `anthropic` with the `/anthropic` base URL) | `openai` with `base_url` or `ollama` |
| Key | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `DEEPSEEK_API_KEY` | not needed (local) |
| System prompt | the `system` field | `instructions` | a `system` message | a `system` message |
| Response limit | `max_tokens` (required) | `max_output_tokens` | `max_tokens` (optional; defaults to 8K without thinking, 64K with it) | `max_tokens` / natively `options.num_predict` |
| Why it stopped | `stop_reason` | `status` + `incomplete_details` | `finish_reason` (`stop`/`length`/`tool_calls`) | `finish_reason` / natively `done_reason` |
| Tokens | `usage.input/output_tokens` | `usage.input/output_tokens` | `usage.prompt/completion_tokens` + cache fields | `usage` / natively `prompt_eval_count`, `eval_count` |
| Thinking | `thinking` blocks in `content` | reasoning items in `output` | the `reasoning_content` field, on by default | the `message.thinking` field (native), the `think` parameter |
| Server stores the conversation | no | optionally (`previous_response_id`) | no | no |
| Where the data goes | US (provider) | US (provider) | **China** | our machine |
| Price | per token | per token | per token, very cheap (half price off-peak, chapter 1.5) | free, but we pay with RAM, disk and speed |

What we lack compared with Claude: a `count_tokens` endpoint (DeepSeek has only `usage` in the response and an offline tokenizer archive on its site; chapter 1.7), an API version header, typed `content` blocks. What Ollama lacks: spending limits and rate limits — but it has memory and speed limits instead, and a default context of only 4096 tokens (a long history is silently cut off unless `num_ctx` is raised).

### What to use for this chapter's practice

- **Chat and streaming** — DeepSeek `deepseek-flash` with thinking off: fast, costs pennies, the same SDK as OpenAI.
- **The same chat locally** — Ollama `qwen3:4b`: changing a single `base_url` shows that "OpenAI-compatible" is about the protocol, not the model.
- **Claude / OpenAI** — optional, to compare the response format (if we have keys). All the theory above about `stop_reason`, `content` blocks and the Responses API stays valid — it is what we will meet in other people's code.

## Learning path

1. We open the [Anthropic API docs](https://docs.anthropic.com) (the domain currently redirects to platform.claude.com/docs) → the Get started / Quickstart section for Python and the Messages API page in the API Reference (≈40 min). We pay attention to the required headers, the `model`, `system`, `messages`, `max_tokens` fields, the response structure and the list of `stop_reason` values. There we also find the Models page and note down the ID of the cheapest model.
2. In the same docs: the Streaming Messages page (≈20 min). We look at the sequence of SSE events and the `stream` example. What we take from it: which events carry text and which one carries the final `stop_reason`.
3. [OpenAI API docs](https://platform.openai.com/docs) → the Quickstart and the Text generation guide, then the Responses page in the API Reference (≈40 min). It is important to understand how `instructions` differs from a `system` message, what `output` looks like (a list of items) and where `usage` is. We skim the Chat Completions section so we recognize it in other people's code.
4. [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) → we open the README and skim the list of notebooks (≈20 min). We don't run anything yet: we just remember where the examples on tool use, structured output (JSON) and caching are — we will come back to them in chapters 2.2 (AIL-8), 2.6 (AIL-10) and 2.7 (AIL-11). If a notebook's code uses old model names or parameters the API no longer accepts, we check against the docs.
5. The API versioning page in the Anthropic docs ([docs.anthropic.com/en/api/versioning](https://docs.anthropic.com/en/api/versioning)) (≈10 min): we figure out why the `anthropic-version` header exists and that new versions may remove parameters.
6. [DeepSeek API docs](https://api-docs.deepseek.com) → Your First API Call, then [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and the [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) guide (≈30 min). We note down the current model names, the base URL, how thinking is turned on/off and where `reasoning_content` lives. We take a look at [API Reference → Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion): the `usage` fields and the `finish_reason` values.
7. The Ollama docs: [Quickstart / macOS](https://docs.ollama.com/macos), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and [Chat API](https://docs.ollama.com/api/chat) (≈30 min). What we take: the base URL `http://localhost:11434/v1`, what is and isn't supported in compatibility mode, the timing fields of the native response, the `think`, `options.num_ctx`, `keep_alive` parameters. If Ollama wasn't installed in chapter 1.5, we install it (with the signature check, see the section above) and download `qwen3:4b`.
8. Then — the practice below (≈2 h).

## What to watch out for

- **`content[0].text` breaks.** The first block may be `thinking`. We always filter by `type`.
- **`max_tokens` is not "the desired length".** The model doesn't know about the limit and doesn't shorten its response; it is simply cut off mid-word. `stop_reason == "max_tokens"` in production is a bug, not the norm. On models with thinking, thinking tokens count toward this limit too: a `max_tokens` that is too small may run out before any text.
- **We put the whole response back into the history.** For Claude it is safer to put `response.content` (all blocks, including thinking) into the history, not just the joined string — that is what the docs recommend for models with thinking.
- **The first message is `user`**, and the roles alternate. The API will merge two `user` messages in a row, but it is better not to do that on purpose.
- **The cost of a conversation grows faster than the number of turns:** request N carries the whole history 1..N-1, so the total input over a conversation grows roughly quadratically. In a 30-turn console chat the last requests cost several times more than the first ones.
- **The SDK retries on its own** network errors and 408/409/429/5xx responses (2 retries by default). So one "call" in a proxy log may turn out to be three HTTP requests. Details in chapter 2.7 (AIL-11).
- **Sampling parameters.** Old tutorials use `temperature=0`. Newer Claude models and newer API versions have removed these parameters (a request with them returns 400). Details in chapter 1.7 (AIL-5).
- **We log the raw data.** When a week later the model "answered strangely", the only thing that helps is the saved request and response. But a log is also a place for leaks: no keys or authorization headers in it.
- **"OpenAI-compatible" ≠ "the same as OpenAI".** DeepSeek has its own fields (`reasoning_content`, cache fields in `usage`), and Ollama doesn't support some parameters (`tool_choice`, `logprobs` in compatibility mode). There is no error — the parameter is simply ignored. We read the compatibility page instead of hoping.
- **The first request to Ollama is slow** — the model is loading into memory (`load_duration`). We don't measure speed on the first call.
- **Where the data goes.** DeepSeek — servers in China; Ollama — our machine. Before every request with "real" data it is worth asking which `base_url` it will go to.

## Practice

Setup: the uv project from chapter 1.3 (AIL-2) (if we checked the keys in it in 1.5, `openai` and `python-dotenv` are already there), the dependencies `openai`, `ollama`, `httpx`, `python-dotenv` (and `anthropic`, if we will compare with Claude). Before installing, we check the exact package names on PyPI (these are the official packages from OpenAI, Ollama (ollama/ollama-python), Anthropic, encode/httpx and theskumar/python-dotenv) and pin the versions (`uv add` writes them to `uv.lock`). In `.env` — `DEEPSEEK_API_KEY` (and, optionally, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Ollama is installed and verified (`codesign`/`spctl`), the `qwen3:4b` model is downloaded (`ollama pull qwen3:4b`; in 1.5 `llama3.2:3b` was enough for the check).

The rule for the whole practice: only study questions go to DeepSeek. No customer data, work code, logs, database contents or `.env`.

- [ ] **1. Hello, two providers.** `exercises/week-01/hello.py` — a continuation of `check_keys.py` from 1.5, but now we look not only at the text but at all the fields of the response: the same question ("Explain what cash on delivery is in two sentences") to DeepSeek (`deepseek-flash`, thinking off) and to Ollama (`qwen3:4b`). We print the text, `finish_reason`, `usage`. Then we turn on DeepSeek's thinking and print `reasoning_content` and `content` separately — comparing `completion_tokens`.
- [ ] **1b. (For comparison)** The same question to Claude and to OpenAI through their SDKs: `stop_reason`/`status`, the `content` blocks, `usage`. We write down three format differences in `notes/`.
- [ ] **2. The system prompt.** `exercises/week-01/system_prompts.py`: the question "Should a small online shop introduce free shipping on orders over $30?" with three system prompts: (a) empty, (b) "Role: a cautious financial analyst. Answer with a list of risks", (c) "Answer strictly with one word: yes/no". We save the three responses and compare: how much does system control the form and tone.
- [ ] **3. A logger.** From here on there will be many requests, and a strange response can't be analyzed without a record. `exercises/week-01/llm_log.py` with a function `log_call(provider, request: dict, response: dict)` that appends a JSON line to `logs/calls.jsonl` (time, provider, model, request body, response body). An SDK response is turned into a dict with `response.model_dump()`. We add `logs/` to `.gitignore` and call `log_call` in all the following scripts.
- [ ] **4. A console chat with history.** `exercises/week-01/chat.py`, with a `--provider deepseek|ollama` flag (optionally also `claude|openai`). DeepSeek and Ollama use the same code on the `openai` SDK and differ in `base_url`, key and model name: we move these into a `PROVIDERS` dict. The `ask` function sends the history, records the call via `log_call` and returns the response text and the input/output tokens (in Chat Completions these are `usage.prompt_tokens` and `usage.completion_tokens`, in Claude `usage.input_tokens` and `usage.output_tokens`). Skeleton:

```python
history: list[dict] = []
while True:
    user_text = input("you> ").strip()
    if user_text in {"/exit", "/quit"}:
        break
    if user_text == "/reset":
        history.clear()
        continue
    history.append({"role": "user", "content": user_text})
    reply_content, tokens_in, tokens_out = ask(provider, history)   # TODO: implement per provider
    history.append({"role": "assistant", "content": reply_content})
    print(f"\n[in={tokens_in} out={tokens_out}]")
```

Check: we write "my name is Emily, I run a small online shop of tableware and gifts", and 3 turns later ask "what do I do?". Then `/reset` and the same question — the model must not know. We watch how `in` grows with every turn. With DeepSeek we also look at `prompt_cache_hit_tokens`: the history is a repeating prefix, and it will start hitting the cache (details in chapter 2.7 · Streaming, retries, rate limits, prompt caching (AIL-11)).
- [ ] **5. Streaming.** We make `chat.py` print output as it is generated: for DeepSeek/Ollama — `stream=True` + `stream_options={"include_usage": True}`, usage from the last chunk (its `choices` is empty). For comparison, with Claude — `messages.stream` and `get_final_message()`.
- [ ] **6. Hitting the limit.** We ask "Write a detailed essay on the history of tea" with `max_tokens=50`. Expected: `finish_reason == "length"` with DeepSeek and Ollama (natively in Ollama, `done_reason == "length"`). For comparison: `stop_reason == "max_tokens"` with Claude, `status == "incomplete"` with the reason `max_output_tokens` with OpenAI. We make the chat print the warning `⚠ response truncated`. We turn on DeepSeek's thinking and repeat with `max_tokens=50` — what ends up in `content`?
- [ ] **6b. Ollama's context.** We paste a text of ~6000 tokens into the chat with Ollama (for example, a delivery service's public API documentation) and ask about its beginning. With the default context (4096) the model "won't see" the beginning; with `options={"num_ctx": 8192}` in the native API it will. We check in the system monitor (Activity Monitor on macOS) how much memory the model took (on an 8 GB machine we don't raise the context much higher).
- [ ] **7. Without the SDK.** `exercises/week-01/raw_http.py` with `httpx`. The main variant is DeepSeek: `POST https://api.deepseek.com/chat/completions`, the header `Authorization: Bearer <DEEPSEEK_API_KEY>`, the body `{"model", "messages", "max_tokens", "thinking": {"type": "disabled"}}` (outside the SDK, `thinking` is just a body field). And Ollama: `POST http://localhost:11434/api/chat` with `"stream": false`. For comparison — Claude:

```python
import os, json, httpx
from dotenv import load_dotenv

load_dotenv()
resp = httpx.post(
    "https://api.anthropic.com/v1/messages",
    headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],
        "anthropic-version": "2023-06-01",   # see the versioning page for newer versions
        "content-type": "application/json",
    },
    json={
        "model": "claude-haiku-5-5",         # check the current model id
        "max_tokens": 200,
        "messages": [{"role": "user", "content": "Say hi"}],
    },
    timeout=60,
)
print(resp.status_code)
print(json.dumps(resp.json(), indent=2, ensure_ascii=False))
```

We do the same for `https://api.openai.com/v1/responses` (the header `Authorization: Bearer <key>`, the body `{"model", "input", "max_output_tokens"}`). We compare the raw JSON with the SDK object. Then we break the request (remove `max_tokens`, misspell the model name) and look at the error body — it will come in handy in chapter 2.7 (AIL-11).

## Done when

- `chat.py` works with DeepSeek and Ollama (and, if there are keys, with Claude/OpenAI): it remembers the context, `/reset` erases it, the response streams, a truncated response is flagged.
- Ollama is installed from the official source, its signature is verified, the server listens only on `127.0.0.1`.
- `logs/calls.jsonl` holds raw requests/responses with no keys in them; `.env` and `logs/` are in `.gitignore`.
- We can draw the JSON of a Messages API request and response without hints and explain every field.

## Self-check quiz

1. Request 1 "My name is Emily" is sent, then request 2 with `messages=[{"role":"user","content":"What is my name?"}]`. What will the model answer and why?
2. What does `stop_reason == "max_tokens"` mean?
   a) the model decided the response was complete; b) the response was cut off at the set limit; c) the account ran out of tokens; d) the model wants to call a tool
3. Which fields are required in the body of a request to `/v1/messages`?
4. How does `system` differ from a first `user` message with instructions?
5. What is wrong with this code?
   ```python
   resp = client.messages.create(model=MODEL, max_tokens=1024, messages=history)
   answer = resp.content[0].text
   history.append({"role": "assistant", "content": answer})
   ```
6. Does streaming reduce the cost of a request? What does it actually give?
7. Why does the 20th turn in a chat cost more than the first, even if the question is short?
8. What is the counterpart of `stop_reason` called in Chat Completions, and which value corresponds to a cutoff at the limit?
   a) `status: "incomplete"`; b) `finish_reason: "length"`; c) `stop: true`; d) `finish_reason: "max_tokens"`
9. Where should an API key be stored in a study project, and what must be checked before the first commit?
10. Requests to the model are logged to a file. What must not be written to the log?
11. How many HTTP requests can stand behind a single `client.messages.create(...)` in the Python SDK by default, and why?
12. How can the same `openai` package be used to reach both DeepSeek and Ollama? What changes in the code?
13. A request to DeepSeek `deepseek-flash` without extra parameters returned `completion_tokens` 10 times larger than the length of the visible response. Why, and how is this turned off?
14. Which of this course's data may be sent to DeepSeek, and which only to Ollama?
    a) everything is allowed if there is a key; b) study questions and public texts go to DeepSeek; customer data, work code, logs and anything that must not be shown to outsiders go only to the local model; c) to DeepSeek, only log data without keys; d) nothing may be sent anywhere
15. Ollama answers as if it hadn't seen the beginning of a long document. What should be checked first?

## Answers

1. The model doesn't know the name: the API is stateless, every request is self-contained. For it to "remember", the history has to be passed in `messages`.
2. **b.** Generation was cut off at `max_tokens`; the response is incomplete and must not be silently shown to the user as finished.
3. `model`, `max_tokens`, `messages` (plus the `x-api-key`, `anthropic-version`, `content-type` headers). `system` is optional.
4. `system` is a separate channel for "the operator's rules", which models are trained to rank above user turns; a first `user` turn is just a message from the other party, and the model can be "talked out of" it by later turns.
5. Two problems: `content[0]` may be a `thinking` block without `.text` (it fails or returns the wrong thing); only a string goes into the history instead of the full `resp.content`. Plus `stop_reason` isn't checked — a truncated response passes as a normal one.
6. No, the tokens are the same. Streaming shortens the time to the first visible token and saves long responses from HTTP timeouts.
7. Every request carries the whole history as input; by the 20th turn the input is all 19 previous pairs.
8. **b.** `finish_reason: "length"`. Option a comes from the Responses API.
9. In environment variables via `.env`, loaded by `python-dotenv`; `.env` must be in `.gitignore` — we check with `git status` that it hasn't ended up in the index.
10. Keys and authorization headers; in a real project also users' personal and sensitive data (or a masked version of it).
11. Up to three: by default the SDK makes 2 retries on network errors and 408/409/429/5xx, with exponential backoff.
12. Create `OpenAI(base_url=..., api_key=...)`: for DeepSeek `https://api.deepseek.com` and the DeepSeek key, for Ollama `http://localhost:11434/v1` and any placeholder key. Plus the model name; after that the Chat Completions code is identical.
13. DeepSeek has thinking mode on by default: the reasoning (`reasoning_content`) is billed as output and counted in `completion_tokens`. To turn it off — `extra_body={"thinking": {"type": "disabled"}}`.
14. **b.** DeepSeek's servers are in China, and training on inputs can't be ruled out: only what we wouldn't mind publishing goes there. Customer data and work data go only to Ollama on our machine; the same rule applies to any cloud provider.
15. The context size: Ollama's default is 4096 tokens, and the rest is cut off. Raise `num_ctx` (in the native API's `options` or via `OLLAMA_CONTEXT_LENGTH`), keeping memory in mind.

## What's next

In [1.7 · Tokens, temperature and the cost of an LLM request (AIL-5)](AIL-5.md) we learn to calculate how much each such request costs and figure out why answers to the same question differ.
