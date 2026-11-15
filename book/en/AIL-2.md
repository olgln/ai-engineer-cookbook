# 1.3 · Python: uv, async, Pydantic  (AIL-2)

> **Week 1** · Preparation · ⏱ ~4 h · Practice

<!-- description: Python project tooling for LLM work: uv and Ruff, asyncio and httpx for parallel requests, Pydantic validation, pytest and debugging in VS Code. -->
<!-- source-sha256: e1498c0edcf5 -->

## Why an AI engineer needs this

Every LLM project is an environment with dependencies (uv), lots of network calls that have to run in parallel and under a rate limit (asyncio + httpx), and data that cannot be taken on trust (Pydantic). The rate limiting is needed because every provider has a rate limit: a cap on requests per unit of time or on concurrent requests. Pydantic matters most: its models produce JSON Schema (the standard description of a JSON document's shape) for structured output, where the model answers strictly by a given schema, and for tool calling, where the model asks to call our function with arguments that follow a schema (both topics are week 2); it also validates the model's response.

In chapter 1.1 we wrote scripts with the system `python3`; now we set up a real project and go through it in order: environment and dependencies, linter, async requests, data validation, tests and debugging. Tests (pytest) and a linter (Ruff) are what a code review uses to tell an engineer from a "script from a chat".

## Theory

### 1. uv — project manager and Python version manager in one

In Python, packages are not installed into the project folder but into a **virtual environment**: an isolated copy of the interpreter with its own `site-packages`. Without it, all projects would share the same library versions. uv creates and maintains this environment itself.

For orientation, the npm equivalents (Maven, Cargo or Go modules have the same roles):

| npm | uv | What it does |
|---|---|---|
| `npm init` | `uv init name` | creates `pyproject.toml`, `.python-version`, `main.py`, git |
| `package.json` | `pyproject.toml` | metadata and dependencies |
| `package-lock.json` | `uv.lock` | exact versions, committed |
| `node_modules/` | `.venv/` | installed packages, in `.gitignore` |
| `npm install x` | `uv add x` | add a dependency |
| `npm install -D x` | `uv add --dev x` | dev dependency (pytest, ruff) |
| `npm ci` | `uv sync` | bring `.venv` in line with the lock |
| `npx x` / `npm run` | `uv run x` | run inside the environment |
| nvm | `uv python install 3.12` | install the required Python version |

uv itself is installed with one command following the [official instructions](https://docs.astral.sh/uv/getting-started/installation/) for each OS; to check, `uv --version`.

Before running anything, `uv run` checks that the environment is in sync with the lock file, so there is no need to "activate" `.venv` by hand. We do not use a global `pip install`: it puts the package into the system Python, and a month later nobody knows what came from where.

```toml
# pyproject.toml after `uv add httpx pydantic` and `uv add --dev pytest ruff`
[project]
name = "learn-python"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["httpx>=0.28", "pydantic>=2.10"]   # versions illustrative

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.8"]
```

The exact sections and versions will differ for us; we look at what uv generated.

### 2. Ruff — linter and formatter

The project's first dev dependencies are quality-control tools. Ruff replaces both a linter and a formatter (in the JavaScript world, ESLint and Prettier). `uv run ruff check .` is the linter (unused imports, suspicious constructs), `uv run ruff check --fix .` fixes automatically, `uv run ruff format .` is the formatter. Settings go into `pyproject.toml` under `[tool.ruff]`. A moderate rule set is on by default; it is worth adding import sorting and "bugbear":

```toml
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]   # pycodestyle, pyflakes, isort, bugbear, pyupgrade
```

The bugbear rule `B006` catches the mutable default from AIL-1, a good example of why model-written code needs a linter.

### 3. asyncio — an event loop we have to start ourselves

An LLM application spends most of its time waiting on the network: one model response takes seconds. Sending 100 requests one after another adds up the waits; async code lets them wait at the same time. Some environments (JavaScript in the browser and Node) always have an event loop. In Python, code is synchronous until we explicitly start the loop:

```python
import asyncio

async def fetch_one(i: int) -> int:     # coroutine function
    await asyncio.sleep(1)              # non-blocking wait
    return i

async def main() -> None:
    results = await asyncio.gather(*(fetch_one(i) for i in range(5)))
    print(results)                      # [0, 1, 2, 3, 4] after ~1 s, not 5

asyncio.run(main())                     # start the loop, run main, close the loop
```

Equivalents in JavaScript, where most people know async/await:

| JavaScript | Python |
|---|---|
| `async function` | `async def` |
| `Promise` | coroutine / `Task` |
| `await p` | `await coro` |
| `Promise.all([...])` | `asyncio.gather(*coros)` |
| `Promise.allSettled` | `asyncio.gather(*coros, return_exceptions=True)` |
| `setTimeout` (waiting) | `await asyncio.sleep(s)` |
| `AbortSignal.timeout` | `async with asyncio.timeout(s):` (3.11+) |
| p-limit | `asyncio.Semaphore(n)` |

The key difference: **calling `fetch_one(1)` starts nothing**; it returns a coroutine object. A JS promise starts running right away, a coroutine only when it is `await`ed or wrapped in a task (`asyncio.create_task`, `gather`). A forgotten `await` produces the warning `coroutine ... was never awaited` and silently skipped work.

**Blocking calls kill concurrency.** Inside `async def` there must be no `time.sleep()`, `requests.get()` or heavy synchronous computation: they stop the whole loop, like an infinite `while` in a single-threaded event loop. For blocking code, use `await asyncio.to_thread(func, *args)`.

A **semaphore** limits the number of concurrent requests; without one, a `gather` over 1000 LLM calls hits the provider's rate limit instantly. In the example, `client` is the HTTP client from the next section, and `async with` is the async version of `with` from AIL-1: entering the block may wait until a slot frees up:

```python
sem = asyncio.Semaphore(5)

async def limited(client, url):
    async with sem:                     # at most 5 inside at once
        r = await client.get(url)
        return r.status_code
```

`asyncio.TaskGroup` (3.11+) is a stricter alternative to `gather`: if one task fails, the rest are cancelled. Both appear in new code and in the official examples.

### 4. httpx — an HTTP client with async

Asyncio does not touch the network by itself: it needs an HTTP client that can `await`. The popular `requests` library is synchronous, so in async code we use httpx:

```python
import httpx

async def main() -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:   # reuse one client: connection pool
        r = await client.get("https://httpbin.org/get", params={"q": "mug"})
        r.raise_for_status()            # 4xx/5xx do NOT raise by default, only after this call
        data = r.json()
```

`httpx.Client` is the synchronous version with the same API. The official Anthropic and OpenAI SDKs are built on httpx, so timeouts, retries and errors look similar there. `async with` is an async context manager: the client is guaranteed to close its connections.

### 5. Pydantic — runtime data validation

The request is sent and the JSON has arrived; now it has to be checked before we trust it. Pydantic v2 describes data as a class with type hints and **checks it at runtime**, which plain annotations do not do (AIL-1). The closest equivalents in other ecosystems are zod, Jackson with Bean Validation, and struct tags with a validator in Go.

```python
from datetime import datetime
from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, Field, ValidationError, field_validator

class OrderItem(BaseModel):
    sku: str = Field(min_length=3, description="Product SKU, e.g. MUG-NORTH")
    unit: Literal["pcs", "g"]
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal = Field(gt=0)
    created_at: datetime

    @field_validator("sku")
    @classmethod
    def upper_sku(cls, v: str) -> str:
        return v.upper()

raw = '{"sku": "mug-north", "unit": "pcs", "quantity": "2", "unit_price": "8.90", "created_at": "2026-11-16T10:00:00Z"}'
item = OrderItem.model_validate_json(raw)   # parse + validate JSON string
print(item.sku, item.quantity)              # MUG-NORTH 2

try:
    OrderItem.model_validate({"sku": "x", "unit": "box", "quantity": -1, "unit_price": 1, "created_at": "nope"})
except ValidationError as e:
    print(e.error_count(), e.errors()[0]["loc"])   # all errors at once, with field paths
```

How to read the example. The class inherits `BaseModel`, the fields are described by annotations, and `Field(...)` adds constraints (`gt=0` means strictly greater than zero) and a description. `@field_validator("sku")` attaches our own function to the field: Pydantic calls it after the type check and uses the returned value (here, the SKU in upper case); the `@classmethod` under it is the form from the Pydantic docs: the validator is called on the class, not on a finished object. `model_validate_json` takes a JSON string, `model_validate` an already parsed dict.

What matters:
- **Type coercion.** By default Pydantic works in "lax" mode: it turns the string `"2"` into a `Decimal` and an ISO string into a `datetime`. That is convenient for JSON. For strictness, use `model_config = ConfigDict(strict=True)` or `Field(strict=True)`.
- **All errors at once**, with the path to the field (`loc`): this is what we can later send back to the model: "fix the `unit` field".
- **Serialization:** `item.model_dump()` → dict, `item.model_dump_json()` → JSON string.
- **Schema:** `OrderItem.model_json_schema()` → a dict in JSON Schema format.

```json
{
  "properties": {
    "sku": {"description": "Product SKU, e.g. MUG-NORTH", "minLength": 3, "title": "Sku", "type": "string"},
    "unit": {"enum": ["pcs", "g"], "title": "Unit", "type": "string"},
    "quantity": {"anyOf": [{"exclusiveMinimum": 0, "type": "number"}, {"type": "string"}], "title": "Quantity"},
    ...
  },
  "required": ["sku", "unit", "quantity", "unit_price", "created_at"],
  "title": "OrderItem",
  "type": "object"
}
```

(The fragment is approximate; the exact output depends on the version. It is worth noticing how `Decimal` becomes "number or string".) This is exactly the kind of schema we will pass to an LLM for structured output and as a tool's `input_schema`. Field `description`s end up in the schema, so they are effectively part of the prompt.

`@dataclass` versus `BaseModel`: a dataclass is for internal structures we trust; Pydantic is for the system boundary, where data comes from outside (a file, an API, an LLM response).

### 6. pytest — tests without ceremony

The model is described; now we pin its behavior down with tests so that a change to a validator does not break what already worked. Tests live in `tests/` next to the code:

```python
# tests/test_order_item.py
import pytest
from pydantic import ValidationError
from models import OrderItem   # models.py in the project root, see pythonpath below

def test_sku_is_uppercased():
    item = OrderItem.model_validate({"sku": "tea-sencha", "unit": "g", "quantity": "250", "unit_price": "4.20", "created_at": "2026-11-16T10:00:00Z"})
    assert item.sku == "TEA-SENCHA"

@pytest.mark.parametrize("bad_unit", ["kg", "", "PCS "])
def test_rejects_bad_unit(bad_unit):
    with pytest.raises(ValidationError):
        OrderItem.model_validate({"sku": "MUG-NORTH", "unit": bad_unit, "quantity": "1", "unit_price": "1", "created_at": "2026-11-16T10:00:00Z"})
```

Files `test_*.py`, functions `test_*`, a plain `assert` (pytest shows what was compared with what). `pytest.raises` expects an exception, `parametrize` gives table-driven tests, **fixtures** are reusable setup (a function argument named after the fixture). Run: `uv run pytest -q`. Tests must not go to the network; that rule holds for any project.

`uv init` creates a flat project: `models.py` sits in the root, not in a package. For the tests in `tests/` to import it, we add to `pyproject.toml`:

```toml
[tool.pytest.ini_options]
pythonpath = ["."]
```

### 7. Debugging in VS Code

When a test fails and the cause is not clear from the message, it is easier to stop the code and look at the variables. This needs the Python extension (it installs Python Debugger, based on debugpy). Command Palette → "Python: Select Interpreter" → the project's `.venv`. After that, F5 on an open file starts the debugger; a breakpoint is a click to the left of the line number; then the Variables and Watch panels and the Debug Console (it evaluates expressions in the current frame). Tests are debugged from the Testing panel (the flask icon) → "Debug Test". In code we can put `breakpoint()`, a built-in function, the equivalent of `debugger;` in JS.

## DeepSeek and Ollama: how we do it

The course's main models are DeepSeek (cloud, cheap, OpenAI-compatible API, servers in China) and Ollama (local models on our own computer); Claude and OpenAI are for comparison. The DeepSeek key and the Ollama installation are in chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3); here is how this chapter's tools apply to them. Facts checked against the documentation on November 13, 2026.

**httpx and SDKs.** The official `openai` package (also built on httpx) works with both DeepSeek and Ollama; only `base_url` changes. It has an async client, `AsyncOpenAI`; the `ollama` library has `AsyncClient`. The "one client for the whole job" rule applies the same way.

**Semaphore: the cloud and the local model have different reasons.**
- DeepSeek limits the **number of concurrent requests per account** (as of November 2026 the docs say 2,500 for `deepseek-flash` and 500 for `deepseek-v4-pro`); beyond that, HTTP 429. While a request waits, the server sends empty lines (or `: keep-alive` in streaming, the mode where the response arrives in pieces, chapter 2.7). The SDK handles them; a hand-written parser has to.
- Ollama is limited by **our hardware**: the model runs on our computer's GPU (or CPU), and ten parallel requests will not make the work ten times faster; they will queue or share memory. For a local model, a semaphore of 1–2 is a normal starting point; we tune it by measuring.

```python
# illustrative: the same async pattern for both providers
import asyncio, os
from openai import AsyncOpenAI

deepseek = AsyncOpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")
local = AsyncOpenAI(api_key="ollama", base_url="http://localhost:11434/v1")   # key is ignored by Ollama

async def ask(client: AsyncOpenAI, model: str, sem: asyncio.Semaphore, q: str) -> str:
    async with sem:
        r = await client.chat.completions.create(model=model, messages=[{"role": "user", "content": q}])
        return r.choices[0].message.content or ""

async def main() -> None:
    sem = asyncio.Semaphore(2)          # local model: keep it small
    qs = [f"One word for the number {i}" for i in range(6)]
    answers = await asyncio.gather(*(ask(local, os.environ["OLLAMA_MODEL"], sem, q) for q in qs))
    print(answers)
```

**Pydantic as a response schema.** This is where providers differ most (details in chapter 2.2 · Structured output: Pydantic + Instructor):
- **Ollama** takes a JSON Schema in the `format` parameter and constrains the output to it: `chat(model=..., messages=..., format=OrderItem.model_json_schema())`, then `OrderItem.model_validate_json(reply.message.content)`. Through the OpenAI-compatible endpoint, it is `response_format`. The docs recommend `temperature=0` for predictability.
- **DeepSeek** offers JSON mode: `response_format={"type": "json_object"}` guarantees valid JSON but **not our schema** (the JSON mode docs say nothing about a schema). Requirements: the word "json" in the prompt and an example of the desired format; `content` may come back as nothing but whitespace, and such a response is handled and the request retried. So Pydantic validation after the response is mandatory.
- **Claude / OpenAI** support strict structured responses by schema; we compare them in week 2.

| What this chapter needs | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Async client | `AsyncAnthropic` | `AsyncOpenAI` | `AsyncOpenAI` + `base_url` | `AsyncOpenAI` + `base_url` or `ollama.AsyncClient` |
| Reason for a semaphore | rate limits | rate limits | concurrent request limit per account, 429 | computer performance |
| Response by Pydantic schema | structured outputs | structured outputs | only JSON mode without a schema → we validate ourselves | `format=<JSON Schema>` |
| Customer data, work code | **no** | **no** | **no** | yes |

**What to use here:** none of the chapter's exercises need a model. The optional bonus below runs on local Ollama (if chapter 1.5 is done): free, and it can be run as often as we like.

## Learning path

1. [uv](https://docs.astral.sh/uv/) → Getting started, then [Working on projects](https://docs.astral.sh/uv/guides/projects/) (≈25 min). Pay attention to: project structure, `uv add`/`uv remove`, `uv run`, `uv sync`, what `uv.lock` and `.python-version` are.
2. [Ruff](https://docs.astral.sh/ruff/) → the Linter and Formatter sections, Configuring Ruff (≈15 min). We take from there how to enable rule sets with `select`.
3. [asyncio](https://docs.python.org/3/library/asyncio.html) → the [Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html) page: Coroutines, Awaitables, Creating Tasks, Task Groups, Sleeping, Running Tasks Concurrently (`gather`), Timeouts (≈35 min). Then [Synchronization Primitives](https://docs.python.org/3/library/asyncio-sync.html) → Semaphore (≈5 min).
4. [httpx](https://www.python-httpx.org) → QuickStart and the Async Support section (≈20 min). Pay attention to Client/AsyncClient, timeouts, `raise_for_status`.
5. [Pydantic](https://docs.pydantic.dev) → Concepts: [Models](https://docs.pydantic.dev/latest/concepts/models/), Fields, Validators, JSON Schema (≈45 min). The essentials: `model_validate` versus `model_validate_json`, lax/strict, `Field` with constraints, `field_validator`, `model_json_schema`.
6. [pytest](https://docs.pytest.org) → [Get Started](https://docs.pytest.org/en/stable/getting-started.html) and the How-to guides on fixtures and parametrize (≈25 min).
7. VS Code: [Python debugging](https://code.visualstudio.com/docs/python/debugging) → "Basic debugging" (≈10 min).
8. (≈15 min) How it looks at the providers: [DeepSeek Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit): the concurrent request limit and 429; [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode): what JSON mode guarantees and what it does not; [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs): an example with Pydantic and `format`. The takeaway: a semaphore is needed in both cases, but for different reasons; Ollama enforces the schema, DeepSeek only "valid JSON".

## What to watch out for

- **A forgotten `await`.** Generated code with `client.get(url)` without `await` inside `async def` does not fail right away: a coroutine comes back instead of a response, and the error surfaces somewhere later.
- **`requests` and `time.sleep` in async code.** Models reach for `requests` out of habit; inside `async def` it serializes all requests. We look for them in review.
- **`asyncio.run` inside an already running loop** (in Jupyter, in FastAPI) fails with `RuntimeError`. In a notebook we write `await main()` directly in the cell (AIL-57).
- **A new `AsyncClient` per request** loses the connection pool, and with hundreds of requests we run into socket limits. One client for the whole job.
- **An unbounded `gather`** over hundreds of LLM calls = an instant 429 from the provider. Always a semaphore.
- **`gather` without `return_exceptions=True`** propagates the first error, but the other tasks keep running in the background, and their results are lost.
- **Pydantic's lax mode** can "rescue" what should have failed: `"1"` becomes `1`, while `1` in a `str` field no longer passes in v2. It is important to know where strictness is needed.
- **A float for a price in the model** has the same precision problems as in AIL-1; money takes `Decimal`.
- **Pydantic v1 versus v2.** Old code and old model answers use `.dict()`, `.json()`, `parse_obj`, `@validator`. In v2 these are `model_dump`, `model_dump_json`, `model_validate`, `@field_validator`. When v1 style shows up, we check which version is installed.

## Practice

The project lives in `exercises/learn-python/` of the study repository (AIL-56). The commands below run from the repository root; uv must be installed (section 1). Inside an existing git repository, `uv init` does not create a nested one.

- [ ] **Project.**
  ```bash
  cd exercises && uv init learn-python && cd learn-python
  uv add httpx pydantic
  uv add --dev pytest ruff
  uv run python -c "import httpx, pydantic; print(pydantic.VERSION)"
  ```
  We look at `pyproject.toml` and `uv.lock` and make sure `.venv/` is ignored (`git status`).
- [ ] **Async versus sequential.** `fetch_compare.py`: a list of 5 public URLs, each responding with a 1 s delay (for example `https://httpbin.org/delay/1`, a public test service). Two functions: `sequential()` with a loop of `await client.get(...)` and `parallel()` with `asyncio.gather`. Measure with `time.perf_counter()`. Expected: ~5 s versus ~1 s. We add `Semaphore(2)` to the parallel version and predict the time before running it (≈3 s). Other public APIs are fine too, but only open endpoints, no keys.
- [ ] **The "order item" model.** `models.py` with `OrderItem` (sku, unit, quantity, unit_price, created_at) as in the theory, plus one rule of our own (for example, for `unit="pcs"` the quantity must be a whole number, via `model_validator(mode="after")`).
- [ ] **10 JSON lines.** `order_items.jsonl`: 10 made-up lines, 4 of them invalid in different ways (negative quantity, `unit: "kg"`, broken date, missing field). The `validate.py` script reads line by line, prints the valid ones and, for invalid ones, the line number and a short `e.errors()` (`loc` + `msg`). Expected: 6 OK, 4 with clear reasons.
- [ ] **Schema.** `print(json.dumps(OrderItem.model_json_schema(), indent=2))`. We answer in `notes/week-01.md`: where the field descriptions are in the schema, what `Literal` and `Decimal` look like, what ended up in `required`. We add a `description` to every field and look at how the schema changed.
- [ ] **Tests.** We add `pythonpath = ["."]` to `pyproject.toml` (section 6). `tests/test_models.py`: at least 3 tests: SKU normalization, `parametrize` over invalid values, our own rule from `model_validator`. `uv run pytest -q` is green.
- [ ] **Ruff.** We enable `select = ["E", "F", "I", "B", "UP"]`, run `uv run ruff check --fix .` and `uv run ruff format .`. We deliberately write a function with `def f(x=[])` and make sure Ruff catches it.
- [ ] **Debugging.** We select the `.venv` interpreter, put a breakpoint in `validate.py` inside `except`, start with F5, look at `e.errors()` in Variables and run `e.error_count()` in the Debug Console. Then we debug one test from the Testing panel.
- [ ] *(Bonus, after chapter 1.5, once Ollama is installed)* **Schema on a local model.** `uv add "ollama==<version>"` (take today's version from PyPI and pin it). The `extract.py` script: we give the local model one made-up sentence ("Yesterday at 14:00 someone ordered 250 g of TEA-SENCHA tea at $4.20 per 100 g") and ask for an `OrderItem` via `format=OrderItem.model_json_schema()` and `temperature=0` (in the `ollama` library, via `options={"temperature": 0}`); the result goes through `OrderItem.model_validate_json`. Then we wrap 5 such calls in `gather` with `Semaphore(1)` and `Semaphore(3)` and compare the times: on a local model the gain from concurrency is noticeably smaller than with httpbin. Made-up lines only.
- [ ] *(For comparison, optional)* The same `extract.py` on DeepSeek with `response_format={"type": "json_object"}`: we put the word "json" and an example object in the prompt and check that Pydantic catches the response if the model returns the wrong format. Made-up data only: customer data and work code are never sent to cloud models.

## Done when

- The project runs via `uv run`, `uv.lock` is committed, `.venv` is not in git.
- The measurement shows the parallel version's gain, and we can explain where the numbers with the semaphore come from.
- `validate.py` finds all 4 invalid lines, `uv run pytest` is green, `uv run ruff check .` reports no errors.
- We have seen our model's `model_json_schema()` and understand how fields turn into the schema.

## Self-check quiz

1. What does `uv run pytest` do if the dependencies in `pyproject.toml` have just changed?
2. What does this code print, and why?
   ```python
   async def get_price():
       return 100

   async def main():
       p = get_price()
       print(p + 1)
   asyncio.run(main())
   ```
3. How does `asyncio.gather` differ from `Promise.all` in JavaScript at the moment coroutine functions are called?
4. What is wrong with this code?
   ```python
   async def fetch_all(urls):
       async with httpx.AsyncClient() as client:
           for url in urls:
               r = requests.get(url)
               time.sleep(0.5)
   ```
5. Why is `asyncio.Semaphore` needed for bulk LLM API calls?
6. Which Pydantic v2 method parses a JSON string and validates it in one step?
   a) `parse_raw` b) `model_validate_json` c) `model_dump_json` d) `json.loads`
7. A field is declared as `quantity: Decimal = Field(gt=0)`. Does `{"quantity": "0.5"}` pass validation in the default mode? And `{"quantity": "0"}`?
8. What does an AI engineer need `model_json_schema()` for?
9. When to choose `@dataclass`, and when `BaseModel`?
10. How does pytest check that a function raises an exception?
11. Why does `asyncio.run(main())` fail in a Jupyter cell?
12. What is `uv.lock`, and how does it differ from the dependencies in `pyproject.toml`?
13. Why a semaphore for bulk requests to DeepSeek, and why for local Ollama? Is the reason the same?
14. DeepSeek is called with `response_format={"type": "json_object"}`, and right after it comes `OrderItem(**json.loads(content))` without a `try`. What can go wrong?
15. Which of the four providers constrains the model's output to the JSON Schema from `OrderItem.model_json_schema()` through the `format` parameter?
    a) DeepSeek b) Ollama c) none d) all of them equally

## Answers

1. Before running, uv checks the environment against `pyproject.toml`/the lock, updates the lock and `.venv` if needed, then runs pytest inside the environment. No need to activate `.venv` by hand.
2. `TypeError`: `get_price()` without `await` returns a coroutine object, not 100, and 1 cannot be added to it. Plus the warning "coroutine was never awaited".
3. In JS a promise starts running right after the function is called; in Python the call returns a "sleeping" coroutine, and execution starts only when `gather` wraps it in a task and the loop runs it.
4. Inside an async function, the synchronous `requests.get` and `time.sleep` block the event loop, everything runs sequentially, and the created `AsyncClient` goes unused. It should be `await client.get(url)` and `await asyncio.sleep(0.5)`, plus `gather` for concurrency.
5. To limit the number of concurrent requests and avoid a 429 or a ban for exceeding the rate limit (and not to burn the budget in a burst).
6. **b.** `parse_raw` is the Pydantic v1 API; `model_dump_json` is serialization in the opposite direction.
7. `"0.5"` passes: lax mode coerces the string to `Decimal`. `"0"` does not: the `gt=0` constraint requires strictly greater than zero.
8. It is the JSON Schema passed to the model for structured output and as the parameter description of a tool in tool calling; the model sees the field types, constraints and `description`s.
9. `dataclass` for internal data we trust (no runtime validation). `BaseModel` at the boundary, where data comes from outside: files, HTTP, LLM responses.
10. `with pytest.raises(ValidationError): ...`: the test fails if an exception of that type is not raised.
11. In Jupyter the event loop is already running, and `asyncio.run` tries to start a new one, hence `RuntimeError`. In a notebook, `await main()` goes directly in the cell.
12. `pyproject.toml` sets ranges (`httpx>=0.28`), `uv.lock` pins the exact resolved versions of all packages, including transitive ones, which makes installs reproducible. Both are committed.
13. No. DeepSeek has a concurrent request limit per account (beyond it, 429) and a budget. For Ollama the limit is the computer's hardware: parallel requests share the GPU and memory, and high concurrency only slows down each response.
14. JSON mode guarantees valid JSON but not the required schema: fields may be named differently or missing, and per the docs `content` may come back as nothing but whitespace, in which case `json.loads` itself fails. It should be `OrderItem.model_validate_json(content)` in a `try` that handles `ValidationError` and retries.
15. **b.** Ollama takes a JSON Schema in `format`. The DeepSeek docs describe only `json_object` without a schema; Claude and OpenAI have their own structured output mechanisms, not a `format` parameter.

## What's next

Chapter 1.4 · Jupyter notebooks in VS Code (AIL-57): we connect this project's `.venv` as the notebook kernel and repeat the exercise interactively. Then chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3): intuition about LLMs, the DeepSeek key and the Ollama installation, followed by the first real model call.
