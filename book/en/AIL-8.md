# 2.2 · Structured output: Pydantic + Instructor  (AIL-8)

> **Week 2** · LLM basics · ⏱ ~3 h · Practice

<!-- description: Structured output: getting valid JSON from an LLM. Pydantic schemas and validators, JSON mode, retry on errors, Instructor with DeepSeek and Ollama. -->
<!-- source-sha256: 0286824823f8 -->

## Why an AI engineer needs this

In a product, a model almost never writes "text for a human": it returns data that code processes next — extracted fields, labels, API parameters. If the JSON is invalid once in a hundred times, at a thousand requests a day that is ten failures. Structured output is one of the most common topics in real work and in interviews ("how do we guarantee valid JSON from an LLM?").

In chapter 2.1 (AIL-7) we already ran into the problem on a small scale: the model answered "Label: Positive." instead of `positive`, and the answer had to be normalized with a regex. A single label can be rescued that way; a five-field record can't. Here we look at how to get data from the model that code accepts without "digging it out".

## Theory

### Three levels of reliability

```
1. "Ask for JSON in the prompt"  → usually works, sometimes not
2. JSON mode                    → guaranteed valid JSON, but of any shape
3. Strict schema (structured outputs / strict tools)
                                → the JSON is guaranteed to match our schema
```

The higher the level, the more work the provider takes on and the less is left for our code. Let's go through them in order.

**Level 1: the prompt.** "Return JSON with the fields product, supplier, date". It breaks like this: the model writes "Here is your JSON:" before the object, wraps it in ```json, forgets a field, names it `item` instead of `product`, writes `"date": "starting next week"`. We need a "dig-it-out" parser and validation. Good enough for a prototype.

**Level 2: JSON mode.** The provider constrains generation so that the result is syntactically valid JSON. But fields and types are not guaranteed. At OpenAI this is `{"type": "json_object"}` in the format settings; it is now considered a legacy option compared to schemas.

**Level 3: a strict schema.** We pass a JSON Schema, and the provider uses **constrained decoding**: at each generation step, tokens that would violate the schema are simply forbidden. By construction, the result parses and passes the schema. It comes in two forms:
- **response format**: the model's whole answer is JSON matching the schema (at Anthropic `output_config.format` / `client.messages.parse(...)`, at OpenAI Structured Outputs via `text.format` / `client.responses.parse(...)`);
- **strict tool**: the model is given a description of a function (a tool) it can "call" by returning its arguments as JSON; with `strict: true` those arguments are guaranteed to match the schema. This fits when the JSON is needed as a function call; we cover tools in detail in chapter 2.6 (AIL-10). Historically, "JSON via tool use" was the main way to get structure out of Claude.

The key point: **a schema guarantees shape, not truth.** The model will return a perfectly valid `{"product": "North Mug", "supplier": "Northern Ceramics"}` even if the text was about a different product and a different supplier. Valid ≠ correct; correctness is checked by evals (chapter 2.5 (AIL-9)).

### Pydantic: a data model and a schema

Level 3 needs a JSON Schema, and levels 1–2 need a check of the answer. We don't have to write the schema and the validator separately: both come from one Pydantic class. We met Pydantic in chapter 1.3 · Python: uv, async, Pydantic (AIL-2) (the `OrderItem` model): it is a library in which a class describes the shape of data, a JSON Schema is generated from it, and the same class validates incoming data. Many languages have similar tools (Zod in JavaScript, for example).

The chapter's running example is messages from Shelf's suppliers about products: a new arrival, a discontinued product, a price change. From each such text we want to get one record:

```python
from datetime import date
from typing import Literal
from pydantic import BaseModel, Field

class ProductUpdate(BaseModel):
    product: str = Field(description="Product name only, as written in the text, without quotes, "
                                     "SKU or price, e.g. 'North Mug'")
    supplier: str = Field(description="Supplier name as written in the text, e.g. 'Northern Ceramics'")
    effective_date: date | None = Field(
        description="Date the change takes effect, ISO 8601. null if the text gives no date")
    update_type: Literal["new_arrival", "discontinued", "price_change"] | None = Field(
        description="'new_arrival' for new products, 'discontinued' if the product is no longer "
                    "supplied, 'price_change' for a new price, null if unclear")
    confidence: float = Field(ge=0, le=1,
        description="How sure you are the text announces a product update (0..1)")

print(ProductUpdate.model_json_schema())   # this is what the model sees
```

`ProductUpdate.model_validate(dict)` checks a dict and returns an object, `ProductUpdate.model_validate_json(text)` does the same straight from a string; on a mismatch it raises `ValidationError` with a list of errors per field.

**`Field(description=...)` is a prompt.** The descriptions end up in the JSON Schema, and the model reads them as instructions. "Product name only, without quotes, SKU or price" in the description sharply cuts the number of `"North Mug, SKU MUG-NORTH, $5.90"`.

**`Literal` instead of `str`** for closed sets: a schema with an `enum` won't let the model write `"price_update"` instead of `"price_change"`.

### Missing data: the main source of made-up values

A strict schema forces every field to be filled in, and this is its flip side. If a field is required and the text doesn't have it, the model **makes up a plausible value**: "today" as the date, a supplier from a neighboring email. The schema forces it to put something in. The defense:

1. The field must allow `null` (`date | None`), so the model has somewhere to "fall back" to.
2. **We say explicitly when to put null**, in the field description and in the prompt: "if the text has no date, return null; do not infer the date from context".
3. We add a `confidence` field or an `is_product_update: bool` flag for texts with no product news at all.
4. For "no data at all", we make the top level look like `{"updates": [...]}`: an empty list is more honest than a made-up object.

A subtlety about strict schemas: in strict mode, providers usually require **all keys to be in `required`**, and "optionality" is expressed with the type `X | null`. A Pydantic field `x: str | None = None` is an optional key in plain JSON Schema; SDK helpers (`parse`) and Instructor bring the schema into the right form themselves, but if we write the schema by hand, we watch for this. Also, not every JSON Schema keyword is supported in strict mode (numeric ranges, `pattern`, formats may be limited): an SDK may move unsupported constraints into the description and check them on the client. It is worth reading the limitations section in the provider's documentation.

### Validators: business rules on top of the schema

The schema catches types; a validator catches meaning.

```python
from pydantic import field_validator

class ProductUpdate(BaseModel):
    ...
    @field_validator("product")
    @classmethod
    def bare_name(cls, v: str) -> str:
        v = v.strip().strip('"“”«»').strip()
        if not v or len(v) > 80 or "$" in v or "sku" in v.lower():
            raise ValueError(f"'{v}' is not a bare product name")
        return v
```

The second natural candidate is a date validator, and it shows a trap. The rule "the date is not in the past" seems obvious, but a three-month-old supplier message legitimately contains a past date, and a validator "relative to today" will break processing of the archive. It is better to compare with the date of the message itself (pass it in the validation context) or to check "the date is not earlier than the message". What matters is thinking about *what* the rule holds *relative to*.

### Three ways in code (illustrative)

The data model is ready; what's left is to hand it to the provider. Below are the native helpers of Anthropic and OpenAI (level 3) and Instructor, which adds an error-fixing loop on top of any level.

**Anthropic, natively**: a Pydantic model in, an object out:

```python
import anthropic
client = anthropic.Anthropic()

resp = client.messages.parse(
    model="claude-haiku-5-5",           # check the current id
    max_tokens=1024,
    system="Extract product update info. Use null for anything not stated in the text.",
    messages=[{"role": "user", "content": f"<message>{text}</message>"}],
    output_format=ProductUpdate,
)
update = resp.parsed_output             # a validated ProductUpdate instance
```

Under the hood this is `output_config={"format": {"type": "json_schema", "schema": ...}}` in `messages.create`.

**OpenAI, natively:**

```python
from openai import OpenAI
client = OpenAI()

resp = client.responses.parse(
    model="gpt-5-mini",                 # check current model names
    input=[
        {"role": "system", "content": "Extract product update info. Use null for anything not stated."},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    text_format=ProductUpdate,
)
update = resp.output_parsed
```

**Instructor** is a library on top of the SDKs of different providers: it takes `response_model=ProductUpdate`, validates the answer with Pydantic and, **on a validation error, sends the error text to the model and asks it to fix the answer** (`max_retries`). Its strength is exactly this loop with our validators, plus one codebase for many providers:

```python
import instructor

client = instructor.from_provider("anthropic/claude-haiku-5-5")   # see Instructor docs for the current API
update = client.chat.completions.create(
    response_model=ProductUpdate,
    max_retries=2,                       # re-ask with the validation error
    messages=[{"role": "user", "content": f"<message>{text}</message>"}],
    max_tokens=1024,
)
```

Instructor's API has changed between versions (`from_anthropic(...)`, `from_openai(...)`, `from_provider(...)`, `Mode.*` modes), so we check against the documentation of the installed version.

When to choose what:

| Situation | Choice |
|---|---|
| One provider, a simple schema | Native structured output |
| Complex business validators, auto-repair needed | Instructor (or our own "error → retry" loop) |
| A model/provider without strict schemas (some open-weight ones) | Instructor / prompt + validation + retries |
| The JSON is the arguments of an action | Strict tool use (chapter 2.6 (AIL-10)) |

### The "validate → retry" loop by hand

It is useful to understand what Instructor does:

```
model answer ──► model_validate_json ──ok──► object
                       │ ValidationError
                       ▼
     messages += [assistant: <answer>, user: "Error: <error text>. Fix it."]
                       │
                       └──► retry (at most N times) ──► otherwise an exception
```

N is worth limiting (1–2): each retry costs a full request.

## DeepSeek and Ollama: how we do it

This is where providers differ the most, and it is a good lesson: each one implements the "three levels of reliability" from the theory in its own way. In short: **Ollama has a strict schema right in the response format; DeepSeek has only JSON mode and strict tools.**

### Ollama: a schema in `format` (level 3)

Ollama's native API takes a JSON Schema in the `format` parameter and constrains generation to it ([Structured outputs](https://docs.ollama.com/capabilities/structured-outputs), checked on November 13, 2026):

```python
import ollama

resp = ollama.chat(
    model="qwen3:4b",
    messages=[
        {"role": "system", "content": "Extract product update info. Use null for anything not stated in the text. "
                                      f"Return JSON matching this schema: {ProductUpdate.model_json_schema()}"},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    format=ProductUpdate.model_json_schema(),   # constrained decoding on the schema
    options={"temperature": 0},                 # docs recommend 0 for extraction
    think=False,
)
update = ProductUpdate.model_validate_json(resp.message.content)
```

The documentation advises duplicating the schema as text in the prompt: the model understands the meaning of the fields better. Structured outputs also work through the OpenAI-compatible endpoint (via `response_format`), but the native API is more reliable for them and better documented. `format="json"` (without a schema) is level 2, JSON of any shape.

### DeepSeek: JSON mode (level 2) and strict tools (level 3)

**JSON Output** is `response_format={"type": "json_object"}`. The `json_schema` type in `response_format` is **not supported** (per the API Reference as of November 13, 2026, only `text` and `json_object` are allowed). Requirements ([guide](https://api-docs.deepseek.com/guides/json_mode)): the word "json" must be in the prompt, and it is better to give an example of the JSON we need; `max_tokens` with room to spare. A quirk: if the model failed to produce JSON, the API returns `content` made of whitespace only, with `finish_reason == "stop"`; we check for emptiness and retry.

```python
# deepseek = OpenAI(...) client from chapter 1.6
r = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "Extract product update info and answer in json. Use null for anything "
                                      'not stated. Example: {"product": "North Mug", "supplier": "Northern Ceramics", '
                                      '"effective_date": "2026-11-20", "update_type": "new_arrival", "confidence": 0.9}'},
        {"role": "user", "content": f"<message>{text}</message>"},
    ],
    response_format={"type": "json_object"},
    max_tokens=1024,
    extra_body={"thinking": {"type": "disabled"}},
)
raw = r.choices[0].message.content or ""
if not raw.strip():
    ...  # documented edge case: blank content, retry
update = ProductUpdate.model_validate_json(raw)   # the shape is NOT guaranteed: validate
```

**A strict tool** is the only way to get a schema guarantee from DeepSeek ([Tool Calls → strict mode](https://api-docs.deepseek.com/guides/tool_calls), beta): a client with `base_url="https://api.deepseek.com/beta"`, `"strict": true` on the function; the server checks the schema and rejects an unsupported one. Schema limitations: objects must have all properties in `required` and `additionalProperties: false`; strings have `pattern` and `format` only from a list (email, hostname, ipv4, ipv6, uuid), and **`format: date` is not on that list**, while Pydantic generates it for a field of type `date`; `minLength`/`maxLength` and `minItems`/`maxItems` are not supported; for numbers, `minimum`/`maximum` are supported; `enum` and `anyOf` (and so `X | None`) are too. So the schema from Pydantic has to be "tidied up" by hand or with a helper function: all fields required (optionality via `None`), the date as a string with a `pattern`, and then Pydantic on the client checks the real type.

To make sure the model calls this tool, it has to be forced (`tool_choice` with the function name), and **in thinking mode a forced `tool_choice` gives a 400 at DeepSeek**. So: thinking is off, or `tool_choice="auto"` plus an instruction in the prompt. The situation is familiar: it is the same fork as with the newest Claude models and a forced `tool_choice` (see "What to watch out for").

### Instructor with DeepSeek and Ollama

```python
import instructor

# DeepSeek: default mode is TOOLS (forced tool call) -> 400 while thinking is on.
ds = instructor.from_provider("deepseek/deepseek-flash", base_url="https://api.deepseek.com",
                              mode=instructor.Mode.MD_JSON)   # the docs suggest MD_JSON for reasoning models
# Ollama: TOOLS for models with function calling, JSON otherwise; can be overridden with mode=...
local = instructor.from_provider("ollama/qwen3:4b")

update = ds.create(response_model=ProductUpdate, max_retries=2,
                   messages=[{"role": "user", "content": f"<message>{text}</message>"}])
```

(Based on the [DeepSeek integration](https://python.useinstructor.com/integrations/deepseek/) and [Ollama integration](https://python.useinstructor.com/integrations/ollama/) pages in the Instructor documentation; their DeepSeek example still uses the old name `deepseek-v4-flash`. Instructor's API changes, so we check against the installed version.) Instructor runs the "validation error → retry" loop the same way for every provider, which is exactly why it is most useful where there is no strict schema, that is, on DeepSeek.

### Comparison

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON mode (level 2) | not as a separate mode | `json_object` (legacy) | `response_format: json_object` + the word "json" in the prompt; an empty answer is possible | `format="json"` |
| Schema in the response format (level 3) | `output_config.format` / `messages.parse` | Structured Outputs / `responses.parse` | **no** (`json_schema` is not accepted) | `format=<JSON Schema>` (native), `response_format` (compatible) |
| Strict tools | `strict: true` | `strict: true` | beta: `base_url=.../beta` + `strict: true`, a cut-down JSON Schema | `strict` not documented; there is the schema in `format` |
| Forced call | 400 on the newest models | `tool_choice` | 400 in thinking mode, works without it | `tool_choice` not supported in compatible mode |
| What to do without level 3 | — | — | JSON mode + Pydantic + retry (Instructor `MD_JSON`/`JSON`) or a strict tool without thinking | — |

### What to use for the practice

- **The main `extract()`**: Ollama with `format=schema`. It is real level 3, free, and supplier messages can be run as many times as we like.
- **DeepSeek**: for comparing levels 2 and 3 on one provider: JSON mode versus a strict tool, and Instructor on top of JSON mode. The supplier messages in the practice are made up and contain no personal data, so they can be sent to the cloud. Customer messages cannot: they go only to the local model (in chapter 2.5 (AIL-9) such texts will be marked `"private": true`).
- **Claude/OpenAI `parse`**: optional, for comparison: it shows how much more convenient it is when the schema in the response format is supported natively.

## Learning path

1. [OpenAI: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) (≈40 min). We read the introduction, the Structured Outputs vs JSON mode comparison, the Pydantic examples, the section on supported schemas and limitations, and the part about refusals. What to take away: why all fields must be required and how to express optionality.
2. [Anthropic documentation](https://docs.anthropic.com) → the Structured outputs page in the Build with Claude section ([docs.anthropic.com/en/docs/build-with-claude/structured-outputs](https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs)) (≈30 min). We look for: `output_config.format`, the `messages.parse` helper, strict tool use, JSON Schema limitations, incompatible features. We compare with OpenAI.
3. [Instructor](https://python.useinstructor.com) (≈40 min): Getting started, the page on the Anthropic integration, the sections on validation and retries (reasking), on `Optional`/missing data. We pay attention to the modes (Mode): some of them are based on a forced tool call.
4. [Pydantic docs](https://docs.pydantic.dev/latest/) → Models, Fields, Validators (≈30 min). What to take away: `Field(description=...)`, `Literal`, `field_validator`, `model_validator`, `model_json_schema()`.
5. In the Anthropic Cookbook (linked in chapter 1.6) we find the notebook on JSON extraction / structured output and skim it (≈10 min).
6. Ollama: [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈15 min). What to take away: `format=Model.model_json_schema()`, `model_validate_json`, the advice about temperature 0 and the schema in the prompt.
7. DeepSeek (≈25 min): [JSON Output](https://api-docs.deepseek.com/guides/json_mode): the requirements and the empty-answer case; [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls), the strict mode section: the list of supported JSON Schema keywords; in [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion): the allowed `response_format` values and the `tool_choice` limitations in thinking mode.
8. Instructor: the integration pages for [DeepSeek](https://python.useinstructor.com/integrations/deepseek/) and [Ollama](https://python.useinstructor.com/integrations/ollama/) (≈15 min). What to take away: the `from_provider` line, the default mode and when to change it.

## What to watch out for

- **Valid ≠ correct.** The structure is guaranteed, the facts are not. Accuracy has to be measured per field (chapter 2.5 (AIL-9)).
- **A required field with no data = a made-up value.** If the model is not given `null` and a rule for using it, it fills in a "reasonable" value.
- **A field named `date` with the type `date`.** In Pydantic, a field named the same as the type in its annotation (`date: date | None = None`) can lead to strange errors, because the name shadows the type in the class body. Better to name it `effective_date`.
- **Truncation at `max_tokens`.** If the answer hit the limit, the JSON may be cut off even with a schema. We check `stop_reason`/`status` before parsing.
- **Model refusal (`refusal`).** For a request the model refused to fulfill, the answer will not be a schema object; this is handled by a code branch, not by a parser exception.
- **Instructor and the new Claude models.** Instructor's tool-based modes use a forced call (`tool_choice` with a specific tool). The newest Claude models (for example, Opus 5.5, Sonnet 5.5) don't accept a forced `tool_choice` and return a 400. If this error shows up, we need a mode based on structured outputs (if the installed Instructor version has one), a model that supports a forced call, or the native `messages.parse`.
- **DeepSeek: empty `content` with `finish_reason == "stop"`** in JSON mode is documented behavior, not a network failure. We check `raw.strip()` before parsing. And we remember: at DeepSeek, Instructor's default mode (TOOLS) is a forced call, which gives a 400 in thinking mode.
- **Ollama: a 4096 context by default.** A long message + the schema in the prompt + the schema in `format` may not fit, so we raise `num_ctx`.
- **Field descriptions affect quality more than it seems.** And cost too: the schema is input tokens on every request.
- **Complex schemas** (deep nesting, dozens of fields, large `enum`s) compile more slowly and hit strict-mode limitations more often. It is worth starting with a flat schema.

## Practice

The texts are messages from Shelf's suppliers about products: a new arrival, a discontinued product, a price change, with dates and names of suppliers and products. We write them ourselves (or ask a model to sketch drafts and edit them by hand). The data is made up and contains no customers' personal data, so these texts can also be sent to cloud models.

The extraction methods follow the levels of reliability from the theory: first a request in the prompt (level 1), then a strict schema (level 3; at DeepSeek we also compare it with level 2), then Instructor with a retry loop. Each function returns a `ProductUpdate`, so the results compare one to one.

- [ ] **1. Five texts.** `exercises/week-02/supplier_texts/`: 5 messages: a new arrival, a price change, a message with no date, a discontinued product, and one text not about products at all (for example, a supplier warning about holiday closures of the warehouse).
- [ ] **2. The model.** `exercises/week-02/product_update_model.py`: the `ProductUpdate` class from the theory (with `effective_date`, `Literal`, descriptions, `confidence`).
- [ ] **3. Method 1: the prompt.** `extract_prompt(text) -> ProductUpdate | None`: we ask for JSON in the prompt, parse with `ProductUpdate.model_validate_json`, and on failure try to cut out `{...}` with a regex. We count how many of the 5 parsed on the first try.
  We do method 1 on DeepSeek (without JSON mode) and on Ollama (without `format`).
- [ ] **4. Method 2: native.** `extract_native(text) -> ProductUpdate` via Ollama with `format=ProductUpdate.model_json_schema()`. We compare the results with method 1.
- [ ] **4b. DeepSeek: level 2 versus level 3.** (a) `extract_ds_json(text)` with `response_format={"type": "json_object"}` + Pydantic validation + handling of an empty answer; (b) `extract_ds_strict(text)` via a strict tool on the beta endpoint (thinking off, `tool_choice` on the function). First we send the schema straight from `ProductUpdate.model_json_schema()` and see what the server says about `format: date` and the optional fields; then we fix the schema. We write down in a note which JSON Schema limitations came up. Then we turn thinking on and keep the forced `tool_choice`, and make sure we get a 400.
- [ ] **4c. (For comparison)** The same via `client.messages.parse` at Claude or `responses.parse` at OpenAI, if there is a key.
- [ ] **5. Method 3: Instructor.** `extract_instructor(text) -> ProductUpdate` with `max_retries=2`, on top of DeepSeek (`Mode.MD_JSON` or `Mode.JSON`) and on top of Ollama. Before installing, we check the package: the exact name `instructor` on PyPI, the author/organization (567-labs), how recent the release is, whether there are suspicious install scripts; we pin the version.
- [ ] **6. Break it.** On the warehouse holiday text: what did each method return? Did the model make up a product and a date? We add `is_product_update: bool` to the model (or return `{"updates": []}`) and a rule to the prompt/descriptions; we check that the made-up values are gone.
- [ ] **7. Validators.** We add a product name validator and a date validator "not earlier than the message date" (the message date is passed as a separate context field or checked in the function after parsing). We feed Instructor a text where the model tends to make a mistake (for example, "North Mug, SKU MUG-NORTH, $5.90" on one line) and watch in the log how it "re-asks" (request logging with `log_call` from chapter 1.6 (AIL-4)).
- [ ] **8. The final function.** `extract(text: str) -> ProductUpdate` (or `-> list[ProductUpdate]`): we choose the method ourselves, with handling of `max_tokens` and refusals. We run the 5 texts 3 times: all 15 results must be valid objects.
- [ ] **9. A note.** In `notes/structured-output.md`: a table "provider → method → valid out of 5 → made-up values on the empty text → tokens → cost", and 3–4 lines of conclusions: where each provider has level 3 and what we pay for it.

## Done when

- `extract(text) -> ProductUpdate` reliably returns a valid object (15 out of 15 on repeated runs) and doesn't make up data on a text that isn't about products.
- The comparison of methods is written down in `notes/structured-output.md`, including DeepSeek JSON mode vs strict tool and Ollama `format`.
- We can explain the difference between "JSON in the prompt / JSON mode / strict schema" and why valid JSON doesn't yet mean correct.

## Self-check quiz

1. How does JSON mode differ from a strict schema (structured outputs)?
2. What does constrained decoding guarantee, and what doesn't it?
   a) that the JSON is valid and matches the schema; b) that the field values are true; c) that the model won't refuse; d) a and b
3. Why does a required field `effective_date: date` without a `None` option lead to hallucinations?
4. Why use `Field(description=...)` if the field name is clear anyway?
5. What is wrong with this code?
   ```python
   class ProductUpdate(BaseModel):
       product: str
       date: date
       type: str
   data = ProductUpdate.model_validate_json(resp.content[0].text)
   ```
6. How does Instructor handle an answer that failed Pydantic validation?
7. Why is the validator "the change date is not in the past (relative to today)" a bad idea for a system that also processes an archive of supplier messages?
8. The model returned truncated JSON even though a strict schema is used. What is the most likely cause?
   a) a provider bug; b) `stop_reason == "max_tokens"`; c) a wrong `Literal`; d) a high `confidence`
9. In strict mode, how is an "optional" field usually expressed?
10. When should strict tool use be chosen over the response format?
11. Instructor with the newest Claude model returns a 400 about `tool_choice`. Why?
12. What level of reliability does `response_format={"type": "json_object"}` give at DeepSeek, and how can a schema guarantee be obtained at DeepSeek?
13. What is wrong with this code for DeepSeek?
    ```python
    r = deepseek.chat.completions.create(
        model="deepseek-flash",
        messages=[{"role": "user", "content": f"Extract the product update: {text}"}],
        response_format={"type": "json_schema", "json_schema": {"schema": ProductUpdate.model_json_schema()}},
    )
    update = ProductUpdate.model_validate_json(r.choices[0].message.content)
    ```
14. How do we get JSON strictly matching a schema from a local model in Ollama?
    a) it's impossible, only via the prompt; b) pass a JSON Schema in the `format` parameter of the native API; c) `tool_choice="required"`; d) `format="json"`

## Answers

1. JSON mode guarantees only syntactically valid JSON of any shape; a strict schema guarantees that the JSON matches the given JSON Schema (fields, types, enum).
2. **a.** The shape is guaranteed; the truth of the values and the absence of a refusal are not.
3. The schema forces the model to put in a date even if the text has none; the model picks a plausible value. We need `None` and an explicit rule for when to use it.
4. The description goes into the JSON Schema and works as an instruction: the value format, examples, the rule for missing data. This noticeably improves quality.
5. The `date` field shadows the `date` type (better `effective_date`); `type: str` instead of `Literal["new_arrival","discontinued","price_change"]` lets any value through; there is no `None` for missing data and no descriptions; `content[0]` may not be a text block; `stop_reason` and refusal are not checked.
6. It sends the model its answer together with the validation error text and asks it to fix it; it repeats up to `max_retries`, then raises an exception.
7. An old message about a past change legitimately contains a past date; the rule holds only relative to the date of the message itself.
8. **b.** Generation was cut off at the token limit; the stop reason has to be checked before parsing.
9. The key stays in `required`, and the type allows `null` (`X | None`).
10. When the JSON is the arguments of an action (a function/API call), especially if there are several tools and the model chooses which one to call.
11. Instructor's tool-based modes force a call to a specific tool, and the newest Claude models don't support a forced `tool_choice`. We need a mode based on structured outputs, a different model or the native `messages.parse`.
12. Level 2: syntactically valid JSON with no guarantee of fields (and with the documented empty-answer case). A schema guarantee comes only from a strict tool on the beta endpoint (`base_url=.../beta`, `"strict": true`) with a supported subset of JSON Schema; another option is Pydantic validation with a retry (Instructor).
13. DeepSeek doesn't support `json_schema` in `response_format` (only `text`/`json_object`); the prompt has no word "json" and no example; thinking is not turned off (extra tokens); empty `content` and `finish_reason == "length"` are not checked; the text is not wrapped in tags.
14. **b.** `format=ProductUpdate.model_json_schema()` turns on generation constrained to the schema; `format="json"` gives only "some JSON".

## What's next

Next we read [2.3 · How to choose an LLM: models and providers (AIL-58)](AIL-58.md) and [2.4 · OpenRouter: one API for many models (AIL-69)](AIL-69.md), and then in [2.5 · The first eval: extracting JSON from 20 texts (AIL-9)](AIL-9.md) we measure how *correct* the values returned by `extract()` are.
