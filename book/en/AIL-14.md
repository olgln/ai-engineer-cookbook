# 3.2 · Project 1: read-only tools for the LLM  (AIL-14)

> **Week 3** · LLM basics · ⏱ ~5 h · Project

<!-- description: How to design tools for an LLM: read-only functions, Pydantic input and output schemas, testability and a fake database. -->
<!-- source-sha256: cd77821463b6 -->

## Why an AI engineer needs this

Tools are the interface between the model and our system, and more depends on their quality than on the prompt. The model sees only the name, the description and the JSON schema of the parameters; if a function has a vague name or returns 1000 rows, the model will make mistakes and waste money. In interviews about agents the question "how do you design tools" comes up all the time, and the right answer is "like a public API for a not very attentive but very diligent client".

⚠️ **Read-only.** No functions that change orders, issue refunds or hand out promo codes, and no requests with keys to payment providers or delivery services — only the database copy.

## Theory

We already covered the tool calling loop in AIL-10 and Pydantic models in AIL-8. Here we cover how to design **the functions themselves** for a real project: a Telegram "shop analyst" bot for the owner of the Shelf shop (`projects/01-shop-analyst-bot/`). The inputs are ready from the previous chapter: a database snapshot opened via `open_readonly`, the explored schema, the profit formula and `questions.md` with the owner's questions.

### 1. Four functions

In AIL-13 we already named four functions and assigned the questions from `questions.md` to them. Now we pin down what each one returns:

| Function | Questions it answers | What it returns |
|---|---|---|
| `get_open_orders()` | "which orders are in progress right now?", "what is stuck?" | the number of orders by status, the oldest unfinished ones |
| `get_sales(period)` | "what is the revenue for the week?" | revenue, profit, number of orders, average check, best/worst category |
| `get_product_interest(product, period)` | "which product do people view but not buy?" | views, add-to-carts, peak hour, orders — aggregates only |
| `get_recent_orders(period, limit)` | "show the latest orders" | up to `limit` orders, already assembled from their items |

Note: **no function returns "table rows"**. Each one returns an answer to a class of questions: an aggregate or a short list. This is the main rule of tool design; the other rules follow from the fact that the model sees our functions only through their descriptions.

### 2. Principles of a good tool

**One function, one clear task.** A model chooses well among 4–10 dissimilar tools and badly among 30 similar ones. If two tools differ by a single flag, they are one tool with a parameter.

**The name and the description are written for the model.** The description is a prompt. It contains: what the tool does, when to use it, when *not* to use it, units of measurement, limits of the data.

```text
get_sales: Revenue and profit of paid orders for a period, in USD.
Refunded and cancelled orders are excluded. Profit = item amounts - item
costs - discounts - payment fees; it does NOT include actual delivery expenses.
Use for questions about revenue, profit, average check. For a list of
individual orders use get_recent_orders instead.
```

**Parameters have narrow types.** `period: Literal["day", "week", "month"]` is better than `period: str`: the model won't invent `"last fortnight"`, and the schema itself suggests the options. Every parameter has a `description`.

**Compact output.** We don't give the model 1000 rows — we aggregate and cap the output, otherwise it is expensive and the model gets lost. We pay for every token of the result as input, and again on every following step of the loop. Practical rules:
- aggregates instead of rows;
- a hard `limit` ceiling (for example, `≤ 20`), even if the model asked for 500;
- rounding: money to 2 decimal places, percentages to 1, grams to whole numbers;
- dates in ISO 8601 with the time zone;
- a `truncated: true` / `total_count` field if not everything is shown — the model will say "showing 20 of 143".

**Errors as data, not exceptions thrown outward.** An empty result is not an error: `{"orders": [], "note": "no open orders"}`. An unknown product gets a clear message with a list of similar ones: the model will ask again or correct itself.

**Honesty about the limits of the data.** If `product_stats` keeps 30 days, the function must say so in the description and in the response (`"data_available_from": "..."`). Otherwise, asked about last quarter, the model will answer "nobody viewed the product".

### 3. Pydantic: the input schema and the output format

Narrow types, parameter descriptions and compact output are convenient to define in one place. A single source of truth: the Pydantic model of the parameters gives both the JSON schema for the API and validation of what the model sent, and the result model fixes the output format.

```python
from typing import Literal
from pydantic import BaseModel, Field

Period = Literal["day", "week", "month"]

class GetSalesArgs(BaseModel):
    period: Period = Field(
        description="Rolling window ending now: day=24h, week=7d, month=30d"
    )

class CategorySales(BaseModel):
    category: str = Field(description="Product category, e.g. 'mug', 'tea'")
    revenue_usd: float
    orders: int

class SalesResult(BaseModel):
    period: Period
    date_from: str          # ISO 8601 with timezone
    date_to: str
    revenue_usd: float
    profit_usd: float
    orders: int
    avg_check_usd: float | None
    best: CategorySales | None
    worst: CategorySales | None
    note: str = "Profit is before delivery expenses (not in the database)"

# the tool definition for the API (illustrative, Anthropic format)
GET_SALES_TOOL = {
    "name": "get_sales",
    "description": "...see above...",
    "input_schema": GetSalesArgs.model_json_schema(),
}
```

The tool definition is shown in the Anthropic format because it is shorter. The bot will work in the OpenAI format (DeepSeek, Ollama); how to get both formats from one Pydantic model is covered in the "DeepSeek and Ollama" section below.

On the calling side: `args = GetSalesArgs.model_validate(tool_input)` → a `ValidationError` is turned into a `tool_result` with `is_error: true` and the error text. The result is returned as `result.model_dump_json()`.

Similar libraries exist in many languages (for example, zod in JavaScript): one schema gives the type, the runtime check and the JSON Schema.

### 4. Testability: dependence on the connection and on "now"

The schema describes what a function takes and returns. Now — how the function itself is built so that a test can check it. A function that opens a file and calls `datetime.now()` inside itself is hard to test. We pass dependencies explicitly:

```python
from datetime import datetime, timedelta, timezone
import sqlite3

def get_sales(conn: sqlite3.Connection, period: Period,
              now: datetime | None = None) -> SalesResult:
    now = now or datetime.now(timezone.utc)
    start = now - PERIOD_DELTA[period]
    rows = conn.execute(
        """
        SELECT o.id, o.discount, o.delivery_cost, o.paid_at,
               (SELECT SUM(fee) FROM payments
                 WHERE order_id = o.id AND status = 'succeeded') AS fee,
               p.unit, p.category, i.quantity, i.unit_price, i.unit_cost
        FROM orders o
        JOIN order_items i ON i.order_id = o.id
        JOIN products p ON p.id = i.product_id
        WHERE o.status NOT IN ('cancelled', 'refunded')
          AND o.paid_at >= ? AND o.paid_at < ?
        """,
        (to_sqlite_utc(start), to_sqlite_utc(now)),
    ).fetchall()
    ...  # group rows by o.id (one order = several items), order_total / order_profit
```

In a test we plug in a fake database and a fixed `now`, so the result is deterministic. In the bot the functions will be called by the `run_tool` wrapper (AIL-15): it passes the real connection to the snapshot and `now=None`.

The helper names in this code come from the `bot/domain.py` module: `PERIOD_DELTA` maps `"day"/"week"/"month"` to a `timedelta` (24 hours, 7 and 30 days), `to_sqlite_utc()` formats a date, and `order_total`/`order_profit` are covered in the next section. Note `to_sqlite_utc()`: in the database, dates are text `YYYY-MM-DD HH:MM:SS` in UTC (the `current_timestamp` format). String comparison works correctly only if the format matches character for character: no `T`, no `+00:00` and no microseconds.

### 5. Domain logic: one function per formula

`get_sales` above only selects rows; it computes each order's total and profit with functions from `bot/domain.py`. The item amount and the order profit are exactly where the model would be guaranteed to make a mistake if it did the math itself. So the formulas from the exploration in AIL-13 live in code:

```python
def item_amount(unit: str, quantity: float, unit_price: float) -> float:
    # 'pcs': quantity in pieces, price per piece
    # 'g': quantity in grams, price per 100 g (250 g at 6.40 -> 16.0)
    return quantity * unit_price / 100 if unit == "g" else quantity * unit_price

def order_total(items: list[tuple[str, float, float, float]],
                discount: float | None, delivery_cost: float | None) -> float:
    # items: (unit, quantity, unit_price, unit_cost)
    goods = sum(item_amount(u, q, price) for u, q, price, _cost in items)
    return goods - (discount or 0) + (delivery_cost or 0)

def order_profit(items: list[tuple[str, float, float, float]],
                 discount: float | None, fee: float | None) -> float:
    # unit_cost uses the same unit rule as unit_price
    gross = sum(item_amount(u, q, price) - item_amount(u, q, cost)
                for u, q, price, cost in items)
    return gross - (discount or 0) - (fee or 0)
```

We check the sign of the discount and the fee in our own data (AIL-13, the exploration): if the discount is stored as a negative number, the formula has to be fixed, and a test will pin that down. Items without a cost (`unit_cost IS NULL`, if there are any) are not silently dropped: we count them separately and return `skipped_items: N` with an explanation.

### 6. Product interest: only from the analytics.db snapshot, only as an aggregate

The third function works differently from `get_sales`: it reads two databases. Views and add-to-carts live in the `data/analytics.db` snapshot (the path comes from `ANALYTICS_DB_PATH`), and the orders with this product live in `data/shop.db`. No JOIN across files is needed: each database gives its own aggregates, so `get_product_interest` receives a second connection, `analytics_conn`, opened by the same `open_readonly`.

`product_stats` holds hourly buckets: over a month that is 720 rows per product. The model needs a few numbers:

```python
class ProductInterest(BaseModel):
    product: str
    period: Period
    buckets: int
    views: int
    cart_adds: int
    cart_rate_pct: float | None     # cart_adds / views, %
    peak_hour: str | None           # ISO time of the hour with most views
    orders: int                     # paid orders with this product
    data_available_from: str        # product_stats keeps 30 days
```

The model will send the `product` parameter as "mug" or "North": the catalog names are in English, and the model translates the owner's words ("how is the mug doing?") into the catalog's words. We write a simple resolver: we search by name and `sku` among the products on sale (`is_active = 1`), and if several match, we return a hint error with the list of candidates ("please specify: North Mug (MUG-NORTH) or South Mug (MUG-SOUTH)"). We don't silently choose for the user. If nothing matches (the model sent the word in the owner's language, e.g. Russian), we also return a hint: product not found, the catalog names are in English, for example North Mug. The comparison is done in Python with `casefold()`: SQLite's built-in `LOWER()` and `LIKE` change case only for ASCII letters (Cyrillic, for instance, is left as is), and the model may send the name in another language.

The units of `time` (seconds or milliseconds) were figured out in AIL-13 — we fix them with a constant and a test.

### 7. The fake database

The functions are ready, but there is nothing to check them on yet: the snapshot with personal data can neither be given to a cloud model nor shown in a public repository, and its numbers are not known in advance. Tests and a public demo need a database with the same schema but made-up data. Requirements:

- **Generated from scratch, without reading the live database.** No "orders from the live database + noise" — that is still customer data. The fact that our live database is also generated (AIL-13) changes nothing: we treat it as a real one — this habit will be needed at work.
- **Deterministic:** `random.Random(seed)`, so that screenshots and tests are reproducible.
- **Plausible:** 8–12 products in 4–5 categories, 150–300 orders over 30 days, a few unfinished ones, refunds and cancellations, tea and coffee by weight, products with similar names, hourly `product_stats` buckets for 30 days.
- **Minimal schema:** only the tables and columns the functions read — `customers`, `shipments` and `events` are not in the demo at all. We write the schema in `scripts/fake_schema.sql` by hand, modeled on the live one.

For pytest tests, a small **hand-written** fixture is more convenient than the generator: 3–4 orders with numbers we can calculate on paper. The generator is for the demo, the fixture is for checking the formulas.

The demo database here is not only for the portfolio. It is **the only database cloud models will see** (DeepSeek, and Claude/OpenAI for comparison): all model comparisons in chapter 3.3 are done on it. So it must be close enough to the live one in structure and in the difficulty of the questions (several mugs with similar names, products by weight, a refund, an order on a week boundary), otherwise a model that answers well on the demo will fail on the snapshot. Anyone who has their own shop data and the right to use it can work with a snapshot of that database instead of the generated one — the rule is the same: the cloud sees only the demo.

## DeepSeek and Ollama: how we do it

The functions themselves don't depend on the provider: the SQL, Pydantic, the formulas and the tests are the same. Two things change: **the tool description format** and **how "convenient" the tools must be for a weak model**.

### One registry, two formats

Anthropic accepts a tool as `{name, description, input_schema}`, while OpenAI, DeepSeek and Ollama accept it as `{"type": "function", "function": {name, description, parameters}}`. The schema inside is the same JSON Schema from Pydantic. So there stays one `TOOLS` registry, and the format is chosen on output:

```python
# bot/tools.py (illustrative)
from typing import Literal

def tool_definitions(fmt: Literal["openai", "anthropic"] = "openai") -> list[dict]:
    defs = []
    for name, (args_model, _fn, description) in TOOLS.items():
        schema = args_model.model_json_schema()
        if fmt == "anthropic":
            defs.append({"name": name, "description": description,
                         "input_schema": schema})
        else:  # OpenAI Chat Completions format: DeepSeek, Ollama /v1, OpenAI
            defs.append({"type": "function",
                         "function": {"name": name, "description": description,
                                      "parameters": schema}})
    return defs
```

The `ollama` Python library can also turn ordinary functions with a docstring into a tool schema by itself (`tools=[get_sales]`) — handy for experiments, but in the project there is one source of truth: the Pydantic models. Otherwise the docstring description and the validation drift apart.

### Comparison: what matters for tools

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Schema field | `input_schema` | `function.parameters` | `function.parameters` | `function.parameters` |
| Strict schema adherence | see chapter 2.6 · Tool calling: the model calls 3 functions (AIL-10) | `strict: true` | `strict: true`, only on the beta address `https://api.deepseek.com/beta` | no: validation only by our Pydantic |
| Strict schema limitations | — | all fields in `required`, `additionalProperties: false` | the same; `minLength`/`maxLength` and `minItems`/`maxItems` are not supported; `minimum`/`maximum`, `enum`, `anyOf`, `$ref` are supported | — |
| How forgiving the model is of vague descriptions | a strong model | a strong model | a strong model | a small local model — not very forgiving |
| How much context schemas + results take | not critical | not critical | 1M context | **4k tokens by default** if the machine has less than 24 GB of VRAM ([Context length](https://docs.ollama.com/context-length)) |

The last row is the least obvious. On an ordinary laptop without a powerful GPU, Ollama gives the model a 4096-token window by default. A system prompt + 4 schemas + history + a couple of results easily overflow it, and the model silently "forgets" the beginning — for example, the rule about delivery expenses. The window can be enlarged (chapter 3.3), but the machine's memory is not unlimited, especially with 8 GB of RAM. Hence the practical rules for this chapter:

- **Tool results even more compact.** The `test_result_size` test with a 2000-character threshold is not overcaution: 2000 characters ≈ 500–700 tokens, and one answer can involve two or three results.
- **Short schemas.** A tool description is 2–4 sentences in English (English text takes fewer tokens than, e.g., Russian, and small models understand it better), a parameter description is one line. We measure the size: we keep `len(json.dumps(tool_definitions()))` within ~3000 characters for all four.
- **Less freedom, fewer errors.** `Literal`/`enum` instead of strings, default values, not a single optional parameter "for the future". A small model most often makes mistakes precisely in the arguments: `period="7 days"`, `limit="ten"`. Pydantic validation + a clear error in the response is its safety net.
- **Flat schemas.** Pydantic puts nested models into `$defs` with `$ref` references. DeepSeek strict supports this, but a small model finds a flat list of primitive parameters easier — our inputs have no nesting anyway, and we keep it that way.

### If we want to try strict on DeepSeek (optional, demo database only)

Strict requires `"strict": true` in every function, `base_url="https://api.deepseek.com/beta"`, all fields in `required` and `"additionalProperties": false`. In Pydantic that is `model_config = ConfigDict(extra="forbid")` (gives `additionalProperties: false`) and fields without default values. Note the conflict: `limit` has a default of `10`, and in a strict schema it has to become required. This project doesn't need strict — Pydantic does the validation anyway — but it is a good exercise on the differences between providers.

### What to use in this chapter

- Tests and functions — with no model at all: pytest on a fixture.
- To check that the schemas are clear to a model — one or two calls on the **demo database**: DeepSeek (`deepseek-flash`) as the "reference strong model" and the local Qwen from chapter 3.1 as "the one that will work with the snapshot containing customer data". If Qwen mixes up arguments where DeepSeek doesn't, we fix the descriptions and the types, not the prompt.

## Learning path

1. Open [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → read it in full (≈40 min). Pay attention to the sections on choosing tools, naming, returning meaningful context and saving tokens, the description as a prompt. We write down 5 rules we will apply to our 4 functions.
2. Open [Anthropic: Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) → the section on defining tools and best practices for descriptions (≈20 min). We take away: the `input_schema` format, the advice on detailed descriptions.
3. Open [Pydantic docs](https://docs.pydantic.dev/latest/) → Concepts: Models, Fields (`Field(description=...)`), JSON Schema (`model_json_schema`), Serialization (`model_dump`, `model_dump_json`) (≈40 min).
4. Open [pytest: Get started](https://docs.pytest.org/en/stable/getting-started.html) → then the "fixtures" how-to and the built-in `tmp_path` fixture, `pytest.raises`, `pytest.mark.parametrize` (≈40 min). An analogy: a fixture is like a setup method in xUnit frameworks, but it is wired in by the argument name.
5. Reread in [sqlite3 in Python](https://docs.python.org/3/library/sqlite3.html) the section on placeholders and on date adapters (≈10 min). We take away: dates are passed as strings in the right format, not as `datetime` objects — the built-in date adapters are deprecated in Python 3.12.
6. (Optional) [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling) → the best practices section (≈15 min) — the same principles from the other side. The `{"type": "function", "function": {...}}` format from here is also used by DeepSeek and Ollama.
7. Open [DeepSeek: Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) → the tool format and the strict mode (Beta) section: the beta address, the schema requirements, which JSON Schema keywords are not supported (≈15 min).
8. Open [Ollama: Tool calling](https://docs.ollama.com/capabilities/tool-calling) → the `tools` format, how the Python library builds a schema from a function, the `role: "tool"` message (≈15 min).
9. Open [Ollama: Context length](https://docs.ollama.com/context-length) → the default window depending on the amount of VRAM and how to see it in `ollama ps` (≈5 min). We take away: why compact results are critical on a local model.

## What to watch out for

- **The model can't scroll.** If a function returned 1000 rows, the model will either hit the context limit or "read" them superficially and get the sum wrong. The code computes the sum; the model retells it.
- **SQL only with placeholders.** Parameters come from the model — this is untrusted input. `f"... WHERE name = '{product}'"` is SQL injection even on a read-only database (reading extra data, heavy queries).
- **Double validation of `limit`.** Pydantic: `Field(ge=1, le=20)`; in the function, `min(limit, 20)`. The model sometimes violates the schema.
- **Period boundaries.** Is a "week" a rolling 7 days or a calendar week? We decide, write it in the description and cover it with a test. An order paid exactly on the boundary must fall into exactly one period (`>=` on the left, `<` on the right).
- **Date strings in SQLite** are compared lexicographically: `'2026-12-01 09:00:00'` and `'2026-12-01T09:00:00+00:00'` in one query give a silently wrong result.
- **Float and money.** `round(x, 2)` is enough for display, but floats are not compared for equality in tests — `pytest.approx`.
- **Grams and pieces.** A tea quantity of `250` is grams, and the price is per 100 g. Only `item_amount` computes the item amount; neither SQL nor the model multiplies `quantity * unit_price` directly.
- **An order without a payment or with two payments.** An order with status `paid` that has no successful payment in `payments` (or has two) is a special case. Deciding what to do with it is our job, not the model's.
- **Discontinued products** (`is_active = 0`) — their orders stay in the history. For revenue we count them; for the "which products are on sale now" resolver we don't.
- **No write functions — not even "harmless" ones.** `save_note`, `mark_as_reviewed`, "hand out a promo code" — we add none of them to this project.

## Practice

- [ ] **`bot/models.py`.** Pydantic models for the arguments (`GetOpenOrdersArgs` empty, `GetSalesArgs`, `GetProductInterestArgs`, `GetRecentOrdersArgs` with `limit: int = Field(10, ge=1, le=20)`) and the results (`OpenOrdersResult`, `SalesResult`, `ProductInterest`, `RecentOrdersResult`). Every field has a `description`.
- [ ] **`bot/domain.py`.** `item_amount`, `order_total`, `order_profit`, `to_sqlite_utc(dt)`, `PERIOD_DELTA`. Pure functions without a database.
- [ ] **`bot/tools.py`.** Four functions with the signature `(conn, ..., now=None)`; `get_product_interest` has a second connection, `analytics_conn`. A skeleton:
  ```python
  def get_recent_orders(conn, period: Period, limit: int = 10,
                        now: datetime | None = None) -> RecentOrdersResult:
      limit = min(limit, 20)
      # 1. select orders created in [start, now) with their items
      # 2. group by order id -> one order = several order_items rows
      # 3. sort by created_at desc, keep `limit`, set total_count/truncated
      ...
  ```
  Plus a registry for the LLM wrapper:
  ```python
  TOOLS = {
      "get_sales": (GetSalesArgs, get_sales, "description for the model..."),
      # ... one entry per tool
  }
  def tool_definitions(fmt="openai") -> list[dict]: ...   # OpenAI format by default, "anthropic" for comparison
  ```
- [ ] **Tool descriptions.** For each function, 3–5 sentences: what it does, when to use it, when not to, units, limitations (delivery expenses are not included; product interest only for 30 days).
- [ ] **`tests/conftest.py`.** A `fake_conn(tmp_path)` fixture: creates a database from `scripts/fake_schema.sql`, inserts 3–4 hand-written orders (one with tea by weight, to check the "price per 100 g" rule; one refunded; one unfinished; one paid exactly on the week boundary), returns the connection via `open_readonly`.
- [ ] **Tests (at least 2 per function):**
  - `test_item_amount_grams_vs_pieces` — the "price per 100 g" rule;
  - `test_sales_week_matches_hand_calc` — with a fixed `now`, `pytest.approx`;
  - `test_sales_boundary` — an order on the boundary falls into one period;
  - `test_recent_orders_limit_capped` — `limit=500` → no more than 20, `truncated=True`;
  - `test_interest_ambiguous_product` — a clear error with a list of candidates;
  - `test_empty_period` — an empty result, not an exception;
  - `test_connection_is_readonly` — `INSERT` fails with `sqlite3.OperationalError`;
  - `test_result_size` — `len(result.model_dump_json()) < 2000` characters for each function on the generated database;
  - `test_tool_definitions_formats` — in the `openai` format every element has `type == "function"` and `function.parameters`, in the `anthropic` format `input_schema`; the total size of `json.dumps(tool_definitions())` < 3000 characters.
- [ ] **Schema check by a model (demo database only).** A script `scripts/schema_smoke.py`: sends `tool_definitions()` and 4 questions (one per function) to DeepSeek and to the local Ollama model, **without executing the functions** — it only prints which tool and which arguments the model chose. The questions contain no shop data, but we call `assert_data_policy` anyway. Where the local model got the arguments wrong, we fix the description or the type.
- [ ] **`scripts/make_fake_db.py`.** The demo database generator: `--seed`, `--out data/demo_shop.db` and `data/demo_analytics.db`, made-up products and prices, without a single read of the live database. At the end it prints a summary: orders, unfinished ones, total revenue and profit.
- [ ] **A manual run.** In `python -i` we call each function on the demo database and on the `data/shop.db` snapshot and look at the JSON. We ask ourselves: "if we were the model and saw only this, could we answer the questions from `questions.md`?".

## Done when

- The four functions work on the snapshot and on the demo database, all are covered by pytest tests, `pytest` is green.
- Every result is a Pydantic model, compact (aggregates, `limit ≤ 20`, rounding), with explicit data limitations.
- `tool_definitions()` returns correct schemas with parameter descriptions in the OpenAI format (for DeepSeek and Ollama) and the Anthropic format (for comparison); the total size of the schemas fits the budget.
- On the demo database, the local model chooses the right tool and arguments on the 4 control questions.
- `make_fake_db.py` generates the demo database from scratch by seed; the live database is not read in it.

## Self-check quiz

1. Why should `get_recent_orders` return orders already assembled from their items rather than `order_items` rows?
2. Which is better for the period parameter, and why?
   a) `period: str`; b) `period: Literal["day","week","month"]`; c) `days: int` with no limits; d) `period: dict`.
3. What is wrong with this code?
   ```python
   def get_product_interest(conn, product, period):
       rows = conn.execute(
           f"SELECT * FROM product_stats WHERE product_id = '{product}'"
       ).fetchall()
       return [dict(r) for r in rows]
   ```
4. Why pass `now` to the function as a parameter?
5. The model called `get_recent_orders(period="week", limit=500)`. What should happen?
6. How is a fake database generated "correctly"?
   a) copy the live one and multiply the prices by 1.1; b) take real orders and change the customer names; c) generate it from scratch by seed without reading the live database; d) use the live one but hide emails and phones.
7. An order was paid at `2026-12-01 00:00:00` UTC. The "week" period = `[now−7d, now)`, `now = 2026-12-08 00:00:00`. Does it fall into the period? And with `now = 2026-11-24 00:00:00 + 7d`?
8. Why is a tool description a prompt? What must it contain for `get_sales`?
9. The model asks for the interest in the product "mug", and `products` has three mugs. What should the function return?
10. Why is `test_result_size` a useful test and not a formality?
11. How does a tool description for Anthropic differ from one for DeepSeek/Ollama? Does that require two registries?
12. Why is compact output even more important on a local Ollama than on cloud models?
    a) Ollama charges for tokens; b) the default context window is 4k tokens on machines with < 24 GB of VRAM; c) Ollama doesn't support JSON; d) local models can't sum.
13. Strict mode is enabled in DeepSeek, and the server rejected the `GetRecentOrdersArgs` schema. What are two likely reasons?

## Answers

1. The model shouldn't group items and compute the order total itself — that is domain logic (grams and pieces, discount, delivery) in which it will make mistakes. Plus several times fewer rows in the context.
2. **b.** A narrow type: the model sees the allowed values in the schema, Pydantic rejects an invented value, the function knows the exact boundaries.
3. SQL injection through an f-string (a `?` placeholder is needed); `SELECT *` without aggregation or a limit — hundreds of raw hourly rows in the model's context; no period; the product name is not turned into a `product_id` by a resolver, and ambiguity ("mug") is not checked.
4. For deterministic tests: with a fixed `now`, the period boundaries and the result are known in advance.
5. Pydantic with `le=20` rejects it, or the function cuts it to 20 (`min(limit, 20)`); the result has `truncated: true` and `total_count`, so that the model reports that not everything is shown.
6. **c.** The other options are still real data, slightly masked.
7. With `now = 2026-12-08 00:00:00` the period starts at `2026-12-01 00:00:00`, `>=` → it falls in. In the second case `now` is also `2026-12-01 00:00:00`, and the right boundary is `<` → it doesn't fall in. Exactly one period, as it should be.
8. The model decides whether to call the function and with which arguments based only on the name, the description and the schema. For `get_sales`: what it computes (revenue and profit of paid orders, excluding refunds and cancellations), the units (dollars), what is not included (actual delivery expenses), when to use another tool.
9. A hint error with a list of candidates (the name and `sku` of each mug), so that the model asks the user rather than choosing silently.
10. It catches the regression "the function suddenly started returning raw rows" — this directly affects the cost and quality of answers, and on its own such an error breaks nothing and goes unnoticed.
11. Anthropic: `{name, description, input_schema}`; OpenAI-compatible: `{"type": "function", "function": {name, description, parameters}}`. The schema inside is the same (from Pydantic), so there is one registry, and the format is chosen in `tool_definitions(fmt)`.
12. **b.** The system prompt, schemas, history and results easily overflow 4k, and the model loses the beginning of the context. The window can be enlarged, but that takes memory, which a machine with 8 GB doesn't have much of.
13. Not all fields are in `required` (`limit` has a default value) and/or `"additionalProperties": false` is missing; other options are unsupported keywords (`minLength`, `maxItems`) or a request not sent to the `/beta` address.

## What's next

In AIL-15 "Project 1: tool calling + Telegram" we connect these functions to the model through `call_llm()` and to an aiogram bot available only to the shop owner.
