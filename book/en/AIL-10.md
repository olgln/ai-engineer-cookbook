# 2.6 · Tool calling: the model calls 3 functions  (AIL-10)

> **Week 2** · LLM basics · ⏱ ~4 h · Practice

<!-- description: Tool calling: how a model calls functions and who runs them. Tool definitions, the agentic loop, parallel calls, errors and security. -->
<!-- source-sha256: 19f327e54213 -->

## Why an AI engineer needs this

Tool calling (function calling) is the mechanism behind agents, MCP, assistants with access to databases and APIs, and in general any integration of an LLM with real systems. Every agent framework is the loop from this chapter plus conveniences. An interview is almost guaranteed to ask: "How does a model call a function? Who runs it? What happens if the function fails?" — and to ask us to draw the loop.

## Theory

### The model does not run code

So far the model has only returned text or JSON matching a schema (chapter 2.2), and our code decided what to do with it. Tool calling takes the next step: the model itself decides it needs a function and asks for it to be called. The most important point: the model **calls nothing itself**. It generates a *structured request*: "call `get_exchange_rate` with the arguments `{"base": "USD", "quote": "EUR"}`". Our code runs it, we return the result to the model in the next message, and it continues.

An example: a shop supplier sent an invoice for three lamps at 100 USD each, and we want the total in EUR.

```
 our code                             model
 ─────────────────────────────────────────────────────────────
 messages=[user: "100 USD to EUR × 3?"], tools=[...]  ──►
                                    ◄── assistant: tool_use get_exchange_rate{USD,EUR}
                                        stop_reason = "tool_use"
 run get_exchange_rate → 0.92
 messages += [assistant(tool_use), user(tool_result 0.92)] ──►
                                    ◄── assistant: tool_use calculate{"100*0.92*3"}
 run → 276
 messages += [assistant(tool_use), user(tool_result 276)] ──►
                                    ◄── assistant: "100 USD ≈ 92 EUR, ×3 = 276 EUR"
                                        stop_reason = "end_turn"
```

A handy analogy is RPC, where the client (the model) only builds the request and the server (our code) decides whether to execute it. And, as in any RPC, **the server does not trust the client**: arguments are validated, dangerous actions are forbidden or require confirmation.

### Defining a tool

For the model to ask for a tool, it has to know the tool exists. The list of tools is sent with every request. We go through the format on the Claude API, which has the clearest structure; the DeepSeek and Ollama variant is in the "DeepSeek and Ollama" section below. At Anthropic a tool is a name, a description and a JSON Schema of its input:

```python
TOOLS = [
    {
        "name": "get_exchange_rate",
        "description": (
            "Get the latest official exchange rate between two fiat currencies "
            "(ECB reference rates, updated once per working day). "
            "Use it for any currency conversion. Returns only the latest rate, not historical ones."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "base": {"type": "string", "description": "ISO 4217 code, e.g. 'USD'"},
                "quote": {"type": "string", "description": "ISO 4217 code, e.g. 'EUR'"},
            },
            "required": ["base", "quote"],
            "additionalProperties": False,
        },
        "strict": True,   # arguments are guaranteed to match the schema
    },
]
```

OpenAI (the Responses API) has almost the same: `{"type": "function", "name": ..., "description": ..., "parameters": {...}, "strict": True}`.

**The name and description are a prompt.** The model chooses a tool by them alone. A good description answers the questions: what it does, when to use it, when *not* to use it, what it returns, what the limits are (updated once per working day, returns only the latest rate). A bad one: `"name": "tool1", "description": "rates"`.

### The loop (agentic loop)

The exchange in the diagram above is a loop: we send a request, run the tools the model asked for, return the results and repeat until the model answers with text. It is called the agentic loop — the very loop agents are built on. Illustrative, in the style of Anthropic's Python SDK:

```python
MAX_ITERATIONS = 5

def run(question: str) -> str:
    messages = [{"role": "user", "content": question}]
    for _ in range(MAX_ITERATIONS):
        resp = client.messages.create(
            model=MODEL, max_tokens=2048, tools=TOOLS, messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})   # keep all blocks

        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")

        results = []
        for block in resp.content:
            if block.type == "tool_use":
                results.append(execute(block))      # returns a tool_result dict
        messages.append({"role": "user", "content": results})   # ALL results in ONE message
    raise RuntimeError("tool loop did not finish in time")
```

And the tool result. `DISPATCH` is a "tool name → Python function" dict, `validate` is our argument check (more on it in the security section):

```python
def execute(block) -> dict:
    try:
        output = DISPATCH[block.name](**validate(block.name, block.input))
        return {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(output)}
    except Exception as e:                      # tool failure is data for the model
        return {"type": "tool_result", "tool_use_id": block.id,
                "content": f"Error: {e}", "is_error": True}
```

Key details:
- `tool_use_id` in the result must match the `id` of the `tool_use` block;
- the **whole** `resp.content` goes into the history (it can hold text, thinking and several `tool_use` blocks);
- the results of all calls of one turn go in **one** `user` message;
- an **iteration limit** is mandatory: the model can get stuck in a loop (repeating the same call and getting the same error).

At OpenAI the loop is the same with different names: `response.output` contains items `{"type": "function_call", "name", "arguments" (a JSON string), "call_id"}`, and the result is added to the input as `{"type": "function_call_output", "call_id": ..., "output": "..."}`. Note that at OpenAI `arguments` is a string and has to be parsed with `json.loads`.

### Parallel calls

In the lamp example the calls went one at a time. But if the tools are independent ("the USD/EUR rate and the time in Tokyo"), the model can return **several `tool_use` blocks in one response**. We run them (possibly in parallel, with `asyncio.gather`) and return all the results in one message. If the results are split across several messages, the model "unlearns" parallel calls. Sequential dependent calls (first the rate, then the multiplication) naturally go in different iterations of the loop.

### tool_choice

By default the model decides on its own whether to call a tool. The `tool_choice` parameter controls whether it must:

| Value | Meaning |
|---|---|
| `auto` (default) | The model decides: call a tool or answer with text |
| `none` | Forbid calls (the tools are visible but not used) |
| `any` | Must call some tool |
| `tool` + name | Must call a specific tool |

Important: on the newest Claude models (e.g. Opus 5.5, Sonnet 5.5) the forced modes `any` / `tool` **are not supported and return 400**. There we use `auto` + an explicit instruction in the prompt ("use tool X") and `strict: true` to guarantee the argument format; if the call was needed only to get JSON, structured outputs (AIL-8). On cheaper and older models forced choice works. OpenAI also has `tool_choice` (`auto`/`none`/`required`/a specific function) and the `parallel_tool_calls` flag.

### Tool errors are data

Back to `execute()`: the `except` block in it is there for a reason. If the exchange rate API returned 500 or the model passed `"quote": "EURO"`, the loop must not crash. We return a `tool_result` with `is_error: true` and **clear text**: "Unknown currency code 'EURO'. Use ISO 4217 codes like 'EUR'". Good models correct themselves and repeat the call. With a bad error text (`Error 22`) the model guesses or gives up.

### Security: the server does not trust the client

Arguments come from the model, and the model reads external text, which may contain someone else's instructions (prompt injection, chapter 2.1). Therefore:

1. **Validate arguments** before running: types (`strict` helps), ranges, allowlists (currencies only from a known list; time zone only a valid IANA one).
2. **No `eval()`** for the calculator: the model (or an injection in the data) will send `__import__('os').system(...)`. The expression is parsed safely (the `ast` module with an allowlist of operations), or the tool is described as `{"a": number, "op": "+|-|*|/", "b": number}`.
3. **Least privilege.** A tool does exactly one job; an agent has no tools it doesn't need.
4. **Irreversible actions only with human confirmation**, or better, none at all. For our shop: **the model gets only read functions — no tools that change an order, issue a refund or hand out a promo code, and no requests with keys to the payment provider** — neither in study projects nor in "demo" ones. Public data (exchange rates, time) is fine.
5. **Timeouts** on every external call, so that a hung API doesn't hang the agent.

### How to write tools the model uses well

Security answers the question "what can a tool do"; the remaining question is "will the model use it correctly". The essentials from Anthropic's article on designing tools for agents:
- fewer, more meaningful tools are better than a wrapper around every endpoint;
- clear names, and with many tools, a namespace prefix (`fx_get_rate`, `time_now`);
- return what the model needs, not a 5,000-token raw API response; human-readable fields instead of internal IDs;
- errors with a hint on how to fix them;
- test tools with evals: look at which calls the model makes and where it goes wrong.

## DeepSeek and Ollama: how we do it

The mechanics are the same — the model asks, our code runs. But the format is Chat Completions (as at OpenAI), not Anthropic's blocks, and DeepSeek has two traps related to thinking mode.

### The loop on DeepSeek (Chat Completions)

A tool is described in a `{"type": "function", "function": {...}}` wrapper, the call arrives in `message.tool_calls`, and the result is returned as a message with the `tool` role and a `tool_call_id`. Here `execute(name, args)` takes the name and already parsed arguments and returns a string: the result as JSON or the error text. Illustrative, following the [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) guides (November 13, 2026):

```python
TOOLS_OAI = [
    {"type": "function", "function": {
        "name": "get_exchange_rate",
        "description": "Get the latest official ECB exchange rate between two fiat currencies. "
                       "Use it for any currency conversion. Returns only the latest rate.",
        "parameters": {
            "type": "object",
            "properties": {
                "base": {"type": "string", "description": "ISO 4217 code, e.g. 'USD'"},
                "quote": {"type": "string", "description": "ISO 4217 code, e.g. 'EUR'"},
            },
            "required": ["base", "quote"],
            "additionalProperties": False,
        },
    }},
    # ... calculate, get_time
]

def run(question: str) -> str:
    messages = [{"role": "user", "content": question}]
    for _ in range(MAX_ITERATIONS):
        r = deepseek.chat.completions.create(
            model="deepseek-flash", messages=messages, tools=TOOLS_OAI, max_tokens=2048,
        )
        choice = r.choices[0]
        msg = choice.message
        # Append the whole assistant message: content, tool_calls AND reasoning_content.
        # With tools in thinking mode, dropping reasoning_content of earlier turns -> 400.
        messages.append(msg)
        if choice.finish_reason != "tool_calls":
            return msg.content or ""
        for call in msg.tool_calls:                         # may be several (parallel)
            args = json.loads(call.function.arguments)      # a JSON string, like OpenAI
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,                    # must match the call
                "content": execute(call.function.name, args),   # str; errors as text
            })
    raise RuntimeError("tool loop did not finish in time")
```

Differences from Claude to keep in mind:

- **No `is_error`.** In Chat Completions a `tool` message has only text. We write the error into `content` explicitly: `"ERROR: Unknown currency code 'EURO'. Use ISO 4217 codes like 'EUR'."`
- **Each result is a separate `tool` message**, not all in one `user` message as at Claude. This does not contradict the "all results of one turn together" rule: here they go one after another, right after the `assistant` message with the calls.
- **Sending `reasoning_content` back is mandatory.** In thinking mode (the default) with tools, the reasoning of all previous turns has to be returned in the history; otherwise 400. The simplest way is to put the `message` object itself into the history, as in the code above (DeepSeek's documentation does the same). If the dict is built by hand, this field must not be forgotten.
- **`tool_choice`: `none` / `auto` / `required` / a specific function — but `required` and a specific function give 400 in thinking mode.** To force a call, we turn thinking off (`extra_body={"thinking": {"type": "disabled"}}`). Sounds familiar? On new Claude models forced choice is always forbidden, on DeepSeek only in thinking mode.
- **Strict** is a beta: a client with `base_url="https://api.deepseek.com/beta"` and `"strict": true` on the function; a reduced subset of JSON Schema (all fields in `required`, `additionalProperties: false`; details in chapter 2.2).
- DeepSeek also has built-in server-side tools (`deepseek_web_search`, `deepseek_read_url` among the `tools` types), the counterpart of Claude's server tools. This chapter doesn't need them: the goal is our own loop.

### Ollama: tools on small models

Through the OpenAI-compatible endpoint the code above works almost unchanged (we change the client and the model; `tool_choice` is not supported there). The native `ollama` library has a handy feature: Python functions can be passed straight into `tools`, and the schema is built from the signature and docstring ([Tool calling](https://docs.ollama.com/capabilities/tool-calling)):

```python
def get_time(timezone: str) -> str:
    """Current time in an IANA timezone, e.g. 'Asia/Tokyo'."""
    ...

resp = ollama.chat(model="qwen3:4b", messages=messages, tools=[get_time, calculate], think=False)
messages.append(resp.message)
for call in resp.message.tool_calls or []:
    result = DISPATCH[call.function.name](**call.function.arguments)   # already a dict here
    messages.append({"role": "tool", "tool_name": call.function.name, "content": str(result)})
```

Specifics: in the native API the arguments are already a dict, not a string; the result is sent back with `tool_name`; the model needs the *tools* label in the catalog. The main thing is **quality**: a 4B model (the course default, suitable for machines with 8 GB of memory) noticeably more often picks the wrong tool, mixes up arguments or "answers from memory". That is not a reason to drop it but a reason for good descriptions, validation and an iteration limit — exactly what this chapter teaches.

### Comparison

| | Claude | OpenAI (Responses) | DeepSeek | Ollama |
|---|---|---|---|---|
| Definition | `name`, `description`, `input_schema` | `type: function`, `parameters` | `{"type":"function","function":{...parameters}}` | like OpenAI; natively, Python functions are possible |
| Call in the response | `tool_use` blocks, `stop_reason="tool_use"` | `function_call` items | `message.tool_calls`, `finish_reason="tool_calls"` | `message.tool_calls` |
| Arguments | `input` object | JSON string | JSON string | compatible: string; native: dict |
| Result | `tool_result` in one `user` | `function_call_output` | `tool` messages with `tool_call_id` | `tool` with `tool_call_id` / `tool_name` |
| Error flag | `is_error` | no | no — text | no — text |
| Forced call | on the newest models — 400 | `required` / function | `required` / function, but 400 in thinking mode | `tool_choice` not supported (compatible) |
| Strict | yes | yes | beta endpoint | not documented |
| Parallel calls | yes | yes, `parallel_tool_calls` | several `tool_calls` in a response | yes (depends on the model) |
| Special | thinking blocks in the history | — | `reasoning_content` in the history is mandatory with tools | a 4B model's quality is lower — validate everything |

### What to use for the practice

- **The main loop**: DeepSeek `deepseek-flash` in the default thinking mode: we run into `reasoning_content` in the history right away, which is valuable experience.
- **A second run of the scenarios**: Ollama `qwen3:4b`: we see how a small model makes mistakes in choosing tools (the step with bad descriptions is especially telling).
- The tools in this chapter are public and safe (a calculator, ECB rates, time), so they can be run through DeepSeek. Once tools start reading the shop's database (chapter 3.3 · Project 1: tool calling + Telegram), everything they return also goes to the model: a snapshot with customers' personal data goes only to Ollama; only the demo database goes to the cloud.

## Learning path

1. [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) (≈1 h). We read the overview (how the loop works, client and server tools) and the implementation pages: defining tools, `tool_choice`, parallel calls, handling results and errors (`is_error`), strict tool use. We pay attention to the formatting rules for `tool_result` and to the fact that the SDK has a ready-made "tool runner" (beta) that runs the loop for us; today we write the loop by hand to understand the mechanics.
2. [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling) (≈30 min). We compare: `function_call` / `function_call_output`, `call_id`, `arguments` as a string, `strict`, `parallel_tool_calls`. We take away: a mapping table of Anthropic ↔ OpenAI terms.
3. [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (≈30 min). The main points: how to choose a set of tools, name them, return "useful context", write descriptions and errors, and how to evaluate tools.
4. For the calculator: the [`ast`](https://docs.python.org/3/library/ast.html) module documentation (≈10 min) — `ast.parse(expr, mode="eval")` and walking the `BinOp`, `UnaryOp`, `Constant` nodes. For time, the [`zoneinfo`](https://docs.python.org/3/library/zoneinfo.html) module (≈5 min).
5. A public exchange rate API with no key, for example Frankfurter ([frankfurter.dev](https://frankfurter.dev/); the old domain frankfurter.app redirects there), ECB rates (≈5 min): we find the latest-rate endpoint and the response format in its documentation. It is a public unsigned request — no keys.
6. DeepSeek (≈30 min): [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) (the loop, strict mode), in [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) the section on tools and returning `reasoning_content`, in [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) `tools` and `tool_choice` with the thinking mode restrictions. We take away: what to do to avoid a 400.
7. Ollama (≈15 min): [Tool calling](https://docs.ollama.com/capabilities/tool-calling) — passing functions, parallel calls, the agent loop, streaming with tools. We take away: the format of the `tool` message with `tool_name`.
8. Practice (≈2 h).

## What to watch out for

- **`tool_use` not put into the history** before `tool_result` → 400: a result without a call.
- **A `tool_use_id` mismatch** → 400, or the model mixes up the results.
- **Results of parallel calls in different messages** → the model stops calling in parallel; some results may get "lost".
- **No iteration limit** → an infinite loop and an infinite bill. We log every iteration and its cost.
- **`max_tokens` during a call.** If `stop_reason == "max_tokens"` and the response has an incomplete `tool_use`, it must not be run.
- **The model "answers from memory"** instead of calling a tool (especially with exchange rates: it remembers approximate ones). The fix is the description ("always use for conversion: rates in the model's memory are outdated") and the system prompt; on models where it is allowed, `tool_choice`.
- **A tool result that is too large** eats context and money. We trim and format it.
- **Numbers.** Models do mental arithmetic well but not perfectly. If there is a calculator, we require it for any arithmetic.
- **Argument JSON** is parsed with a library (`json.loads` / the SDK object), never compared as strings — escaping differs between models.

## Practice

`exercises/week-02/tools/`: `tools.py` (definitions + implementations), `loop.py` (the loop), `run_cases.py` (the scenarios). All external calls are public only, without keys, with a timeout.

- [ ] **1. Calculator.** `calculate(expression: str) -> float` on `ast` with an allowlist: numbers, `+ - * / **`, parentheses, unary minus. Tests: `"2+2*2" == 6`, `"__import__('os')"` → `ValueError`, `"10**100**100"` → refusal (we limit the exponent).
- [ ] **2. Exchange rate.** `get_exchange_rate(base, quote) -> dict` via `httpx.get(..., timeout=10)` to a public API. Validation: codes are 3 uppercase letters, from the list of currencies the API supports. We return it compactly: `{"base": "USD", "quote": "EUR", "rate": 0.92, "date": "2026-11-13"}`.
- [ ] **3. Time.** `get_time(timezone: str) -> dict` on `zoneinfo`: `{"timezone": "Asia/Tokyo", "iso": "...", "weekday": "Wednesday"}`. An invalid zone → a clear error with an example of a valid one.
- [ ] **4. Schemas** of the three tools with good descriptions (when to use / when not / format) and `strict: true` (on DeepSeek it only takes effect on the beta endpoint — step 8b; on the regular one our code does the validation).
- [ ] **5. The loop** `run(question)` with a limit of 5 iterations and logging of every iteration (which tools, arguments, result, tokens, cost via `estimate_cost`).
- [ ] **6. Scenarios** in `run_cases.py`; for each one we save the call trace:
  - "What is 17.5% of 2340?" → the calculator only;
  - "What time is it in Tokyo and in New York?" → we expect two parallel `get_time` calls in one turn;
  - "A supplier sells a lamp for 100 USD. How much do three lamps cost in EUR?" → the rate, then the calculator (two iterations);
  - "Hi, how are you?" → no tools.
- [ ] **7. A tool error.** We temporarily make `get_exchange_rate` throw an "Upstream API timeout" exception for `EUR`. We return the error to the model (on DeepSeek, text with the `ERROR:` prefix; on Claude, `is_error: true`). We watch: what does the model do with it? Retry? Tell the user? Then we return the error with a hint ("try again later or ask the user") — did the behavior change?
- [ ] **8. Bad vs good descriptions.** We replace the descriptions with bad ones (`"name": "t2", "description": "rate"` and so on) and run the scenarios from step 6. We record where the model picked the wrong tool or answered from memory. We restore the good ones.
- [ ] **8b. DeepSeek traps.** (a) We build the history by hand without `reasoning_content` in thinking mode, get a 400 and record the error text. (b) We set `tool_choice="required"` with thinking on — 400; we turn thinking off — it works. (c) We enable strict on the beta endpoint for `get_exchange_rate`.
- [ ] **8c. Ollama.** We run the step 6 scenarios on Ollama (`qwen3:4b`, the native API, functions passed directly). A table: scenario → DeepSeek correct? → Ollama correct? → what mistakes the small model makes.
- [ ] **9. (Optional, for comparison) Claude and OpenAI.** The same loop on Anthropic Messages (`tool_use`/`tool_result` blocks, `is_error`) and on the Responses API; we note the differences in format. We try a forced `tool_choice` on the newest Claude model — 400.
- [ ] **10. A note** `notes/tool-calling.md`: a diagram of the loop, 5 rules of good tools, what we saw in steps 7–8.

## Done when

- The model (DeepSeek) picks the right tool on its own in all the step 6 scenarios and correctly combines two tools in the question about three lamps at 100 USD; for Ollama, where it goes wrong is recorded.
- The loop on DeepSeek works correctly in thinking mode (`reasoning_content` is returned to the history).
- The loop is limited to 5 iterations, tool errors are returned to the model as data (`ERROR:` in `content` on DeepSeek, `is_error` on Claude), arguments are validated, and there is no `eval()` anywhere.
- The call traces and the conclusions about bad/good descriptions are written down.

## Self-check quiz

1. Who runs the function in tool calling — the model or the application code? What exactly does the model generate?
2. Which `stop_reason` means the model is waiting for a tool result?
   a) `end_turn`; b) `tool_use`; c) `max_tokens`; d) `pause_turn`
3. The model returned two `tool_use` blocks in one response. What is the correct way to return the results?
4. What is wrong with this code?
   ```python
   def calculator(expression: str) -> str:
       return str(eval(expression))
   ```
5. What is wrong with this loop?
   ```python
   while True:
       resp = client.messages.create(model=M, max_tokens=1024, tools=TOOLS, messages=messages)
       if resp.stop_reason == "end_turn":
           break
       for b in resp.content:
           if b.type == "tool_use":
               messages.append({"role": "user", "content": [
                   {"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b)}]})
   ```
6. A tool failed with an exception. Which is better: break the loop or return the error to the model? How?
7. Why, from the model's point of view, does a tool's description matter more than its code?
8. The newest Claude model was given `tool_choice={"type": "tool", "name": "get_time"}` and returned 400. Why, and what should be done?
9. Why, under this course's rules, can a "refund an order" tool not be given to an agent even in a demo — and what general principle is behind it?
10. How do OpenAI's `arguments` differ from Anthropic's `input` from the code's point of view?
11. Why have an iteration limit if the model "will finish anyway"?
12. What is wrong with this loop for DeepSeek (thinking mode is on by default)?
    ```python
    msg = r.choices[0].message
    messages.append({"role": "assistant", "content": msg.content, "tool_calls": msg.tool_calls})
    for c in msg.tool_calls:
        messages.append({"role": "tool", "tool_call_id": c.id, "content": run_tool(c)})
    ```
13. How is a tool error returned to the model on DeepSeek if there is no `is_error` field?
14. DeepSeek has to be forced to call `get_time`. What happens with `tool_choice={"type": "function", "function": {"name": "get_time"}}` by default, and how is it fixed?
    a) it always works; b) 400 in thinking mode — turn thinking off or use `auto` + an instruction; c) DeepSeek has no `tool_choice`; d) `is_error` is needed

## Answers

1. The application code. The model generates a structured call request: the tool name and arguments matching the schema.
2. **b.**
3. Run both, then add the whole `assistant` response to the history and **one** `user` message with two `tool_result` blocks, each with its own `tool_use_id`.
4. `eval` runs arbitrary Python: the model or a prompt injection in the data can execute any code. A safe `ast`-based parser with an allowlist of operations and limits is needed.
5. The `assistant` response with `tool_use` is not added to the history (the API returns an error); the results of different calls go in different messages; there is no iteration limit; `max_tokens` and other stop reasons are not handled (the loop spins forever); tool exceptions are not caught.
6. Return a `tool_result` to the model with `is_error: true` and a clear error text with a hint; the model can fix the arguments, try another way or honestly tell the user.
7. The model doesn't see the code — only the name, description and schema. By them it decides whether to call the tool and with which arguments.
8. On the newest Claude models a forced `tool_choice` (`tool`/`any`) is not supported. Use `auto` + an explicit instruction in the prompt and `strict: true`, or structured outputs if only JSON is needed.
9. The arguments come from the model, which can make a mistake or fall for a prompt injection, and the action is irreversible and involves money. The principle: least privilege, the model gets only read functions; irreversible actions (changing an order, issuing a refund, handing out a promo code) don't go through the LLM, or only with explicit human confirmation (and in this course, never).
10. At OpenAI `arguments` is a JSON string that has to go through `json.loads`; at Anthropic `input` is an already parsed object. In both cases the arguments are validated afterwards.
11. The model can get stuck in a loop (repeating a call with the same error, "clarifying" endlessly); the limit protects against an endless bill and hangs.
12. `reasoning_content` did not make it into the history — with tools in thinking mode that is a 400 on the next request (it is simpler to put the `msg` object itself). Also: `finish_reason` is not checked, there is no iteration limit, the arguments are not parsed or validated, and `run_tool` exceptions are not caught.
13. As text in the `content` of the `tool` message: an explicit prefix like `ERROR:` plus a clear explanation and a hint on how to fix it.
14. **b.** Forced choice (`required` or a specific function) gives 400 in thinking mode; without thinking it works.

## What's next

The last chapter of the week is [2.7 · Streaming, retries, rate limits, prompt caching (AIL-11)](AIL-11.md): we turn our scripts into a reliable mini-library, `llm_utils.py`, which all the projects will be built on, including agents with tools.
