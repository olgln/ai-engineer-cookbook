# 3.1 · Project 1: LLM bot architecture and a database copy  (AIL-13)

> **Week 3** · LLM basics · ⏱ ~4 h · Project

<!-- description: Project 1, a Telegram shop analyst bot: a tool-calling architecture, a read-only database copy via VACUUM INTO and why not text-to-SQL. -->
<!-- source-sha256: 91162a48990a -->

## Why an AI engineer needs this

This is the first portfolio project: a Telegram "shop analyst" bot that answers the Shelf online shop owner's questions about orders and sales through tool calling. In an interview, the questions about such a project are not "which prompt" but "how did you keep the model from doing something dangerous" and "where does it get its data". Today we lay the groundwork for both answers: the model sees data only through functions, the functions see only a copy of the database, and the copy is opened read-only.

⚠️ **Read-only.** No functions that change orders, issue refunds or hand out promo codes, and no requests with keys to the payment provider or the delivery service — only the database copy.

## Theory

### 1. What we build and what we don't

The bot is an "analyst", not a "shop manager". It does exactly one thing: turns a natural-language question ("what's the revenue this week?") into a call to one or more reading functions and retells the result in plain language. Everything that can change the state of the world — changing an order, a refund, a promo code, requests with keys to the payment provider and the delivery service — is physically absent from the project, not "forbidden by the prompt". A prompt is a request, not a protection: the model can be talked into things, confused by a long story, or it can simply make a mistake. Protection is an architecture in which the dangerous action does not exist in the code.

A principle worth remembering for a whole career: **an LLM has exactly the permissions of the functions we gave it**. If the model must not be able to delete data, we don't give it a function with `DELETE` and don't open the database for writing.

### 2. Architecture

```
 Telegram (shop owner)
     │  message
     ▼
 ┌──────────────┐   unknown user_id → refusal
 │ aiogram bot  │
 └──────┬───────┘
        │ question + history + system prompt with the date
        ▼
 ┌──────────────┐  tool_use: get_sales(period="week")
 │  call_llm()  │◄──────────────────────────────┐
 │ (Ollama/DS)  │──────────┐                    │
 └──────────────┘          ▼                    │ tool_result (compact JSON)
                    ┌─────────────────┐         │
                    │  tools.py       │─────────┘
                    │  4 reading      │
                    │  functions      │
                    └───────┬─────────┘
                            │ SELECT ... (mode=ro, query_only)
                            ▼
                    ┌───────────────────┐
                    │ data/shop.db      │  ← VACUUM INTO from the live db
                    │ data/analytics.db │     (manually, on command)
                    └───────────────────┘

  The shop's live databases (../shop-live/) — the bot NEVER opens them.
  The snapshot (customers' personal data) is seen only by the local
  model (Ollama); cloud models see only the demo database (see below).
```

Note the three layers of protection:

1. **The data layer.** The bot works with a snapshot, not the live database. Even if everything else breaks, the shop application won't notice a thing.
2. **The connection layer.** The snapshot is opened with `mode=ro` in the URI and with `PRAGMA query_only = ON`. Any `INSERT/UPDATE/DELETE` fails with an error.
3. **The tools layer.** The model doesn't write SQL. It calls 4 functions with typed parameters; we write the SQL inside the functions. (The "give the model text-to-SQL" option is discussed below — for this project it is worse.)

A web development analogy: it is as if the frontend called only `GET` routes and the server had no `POST /api/orders/{id}/refund` at all. Not "the route exists but the button is hidden", but there is no route.

### 3. What is actually in the shop database

Before designing the functions, we need to know the data. The shop application has two SQLite databases, both next to the repository, in the `shop-live/` folder (one level above the repository):

| File | What's inside | What the bot needs |
|---|---|---|
| `shop.db` | `customers`, `products`, `orders`, `order_items`, `payments`, `shipments`, `events`, `settings` | `products`, `orders`, `order_items`, `payments` |
| `shop-analytics.db` | `product_stats` (hourly buckets: views and add-to-carts per product), `searches` | `product_stats` |

The schema (table and column names are used in all chapters of the project from here on):

```sql
customers(id, name, email, phone, city, created_at)
products(id, sku, name, category, unit, price, cost, stock, is_active)   -- unit: 'pcs' | 'g'
orders(id, customer_id, status, created_at, paid_at, shipped_at, delivered_at, closed_at,
       delivery_method, delivery_cost, promo_code, discount)
       -- status: new | paid | shipped | delivered | cancelled | refunded
order_items(id, order_id, product_id, quantity, unit_price, unit_cost)
payments(id, order_id, provider, amount, fee, status, created_at)        -- status: succeeded | failed | refunded
shipments(id, order_id, carrier, tracking_number, status, updated_at)
events(id, order_id, time, type, message)
product_stats(time, product_id, views, cart_adds)                        -- time: integer, hourly buckets
```

**Where the "live" databases come from.** We don't have a running shop, so we create the databases ourselves: `scripts/make_shop_db.py --seed 1 --out ../shop-live/` (we write the generator with a model's help in the practice). It fills both databases with 30 days of data, including made-up customers with emails and phone numbers, and leaves them in WAL mode. From then on we assume the shop application is writing to these databases right now. The data is made up, but we treat it as real — this habit will be needed at work. If we have our own data and the right to use it, we can take it — the chapter's rules are the same.

Key facts that will affect the functions:

- **One order = several rows** in `order_items`, one per product, with the same `order_id`. An order's revenue and profit are the sum over its rows.
- **An order's total and profit are not stored in the database.** Order total = sum of the rows − `discount` + `delivery_cost`; profit = sum of the rows − cost of the rows − `discount` − `fee` (the fee of successful payments from `payments`). We have to compute them ourselves.
- **Quantity means different things**: for `unit = 'pcs'` it is pieces and the price per piece; for `unit = 'g'` (tea, coffee) it is grams and the price (and `unit_cost`) per 100 g. A classic source of bugs — we keep the rule in one place, in the function `item_amount(unit, quantity, unit_price)`.
- **Actual delivery expenses are not in the database**: the shop pays the delivery services on a monthly invoice, and `delivery_cost` is what the customer paid. So the profit from the database is profit before delivery expenses. The bot must say so honestly.
- **Dates** `created_at/closed_at` and the rest are written in UTC as text `YYYY-MM-DD HH:MM:SS` (the same way SQLite's `current_timestamp` writes them). "Today" in the owner's time zone ≠ "today" in UTC.
- **`product_stats` keeps 30 days.** The bot honestly can't answer "how many times was the North Mug viewed in August".
- `product_stats.time` is an integer; whether it is seconds or milliseconds we check with one `SELECT time FROM product_stats LIMIT 1`.
- **Refunds and cancellations are not revenue**: orders with the statuses `refunded` and `cancelled` don't count toward revenue.

### 4. Why a copy, and why only `VACUUM INTO`

Now it's clear what the bot needs from the database. The next question is how to get this data without touching the database the shop application writes to. The answer is to work with a copy, and making it correctly is harder than it seems.

The live database is in **WAL** (write-ahead log) mode. In this mode fresh changes are first written to the `shop.db-wal` file and only move to the main file at a checkpoint. If we do `cp shop.db`, we get the main file without the latest transactions from `-wal`, and if a checkpoint was running during the copy, torn pages as well. The copy looks normal and may even open, but its data is inconsistent. Copying three files (`.db`, `-wal`, `-shm`) is not an option either: between copying the first and the last one the application manages to write.

`VACUUM INTO 'path'` does something else: it opens a read transaction and writes a **consistent snapshot** of the database to a new file — with all committed changes from the WAL, without garbage, compactly. It doesn't change the source database. This is the official way to "back up a live SQLite database", along with the Backup API (`Connection.backup()` in Python).

```bash
# run from the shop-live folder next to the repo, where shop.db lives
sqlite3 shop.db "VACUUM INTO '/path/to/ai-engineering-journey/projects/01-shop-analyst-bot/data/shop.db'"
sqlite3 shop-analytics.db "VACUUM INTO '/path/to/ai-engineering-journey/projects/01-shop-analyst-bot/data/analytics.db'"
```

Important: `VACUUM INTO` doesn't overwrite an existing file — if a copy already exists, it has to be deleted before a new one. One more detail: the copy may keep a WAL journal; to open it strictly read-only later without auxiliary files, we switch it to the regular journal mode once:

```bash
sqlite3 data/shop.db "PRAGMA journal_mode=DELETE;"
```

This is a command for the **copy**, not the live database. Only one operation is allowed on the live database — `VACUUM INTO`.

### 5. Opening read-only: URI and `query_only`

We have a copy; what's left is to open it so that the bot physically can't write to it. In Python, `sqlite3.connect()` opens a file for reading and writing by default and **creates an empty database** if the file doesn't exist (a typo in the path → the bot silently works with an empty database and answers "there are no orders"). URI mode solves both problems:

```python
import sqlite3
from pathlib import Path

def open_readonly(path: Path) -> sqlite3.Connection:
    # mode=ro: read-only, and the file must already exist
    uri = f"file:{path.resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row          # rows behave like dicts
    conn.execute("PRAGMA query_only = ON")  # second layer: reject any write
    return conn
```

- `mode=ro` — SQLite opens the file read-only; if the file doesn't exist, the error is `unable to open database file`, not a new empty database.
- `PRAGMA query_only = ON` — a second lock at the connection level.
- `row_factory = sqlite3.Row` — rows with access by column name (`row["unit_price"]`), like dicts.

There is also `immutable=1` in the URI: it tells SQLite the file never changes at all and disables locking. For a snapshot this is correct, but if it is pointed at the live file by mistake, the reads become inconsistent. For learning, `mode=ro` is enough.

### 6. Why not text-to-SQL

The temptation: give the model a single function `run_sql(query)` and the database schema. The downsides for this project:

| | 4 narrow functions | `run_sql` |
|---|---|---|
| Security | we write the SQL | the model writes any SQL (even on a ro database — heavy queries, reading everything, including customers' personal data) |
| Correct profit | the pieces/grams rule, discount and fee — in one place, covered by tests | the model "remembers" from scratch each time how to compute profit |
| Response size | aggregates, ≤ 20 rows | easy to return 5000 rows into the context |
| Testability | pytest for each function | almost none |

Text-to-SQL is a legitimate pattern for "ask anything" analytics, but it requires evals and a sandbox. We come back to it in chapter 9.5 · An MCP server for the shop database (read-only) (AIL-39): there free-form SQL is allowed only as a separate tool with three layers of protection. Here — narrow functions.

### 7. Stack and project structure

- **Python 3.12+**, environment manager — `uv` or `venv` + `pip`.
- **aiogram 3** — an asynchronous bot framework. An analogy: like a web framework (Flask, Express) for HTTP, only for Telegram updates. Key concepts: `Bot` (the Bot API client), `Dispatcher` (the root router, distributes updates), `Router` (groups of handlers), filters (`Command`, `F.text`), middleware.
- **openai** SDK as the client for Ollama and DeepSeek (both speak the OpenAI Chat Completions format, only `base_url` differs) + our `call_llm()` wrapper from chapter 2.7 · Streaming, retries, rate limits, prompt caching (AIL-11). **anthropic** SDK — optional, for comparison on the demo database.
- **pydantic** — result models (AIL-14), **pytest** — tests.

The project lives in the study repository from AIL-56, in the `projects/01-shop-analyst-bot/` folder with its own `pyproject.toml` and README:

```
01-shop-analyst-bot/
├── README.md
├── .gitignore
├── .env.example          # names of variables, no values
├── pyproject.toml
├── data/                 # ignored: snapshots and demo db
├── scripts/
│   ├── make_shop_db.py   # "live" shop databases in ../shop-live/ (this chapter)
│   ├── snapshot.sh       # VACUUM INTO from the live db (manual run)
│   └── make_fake_db.py   # demo data (AIL-14)
├── bot/
│   ├── main.py           # aiogram entry point (AIL-15)
│   ├── db.py             # open_readonly(), paths from env
│   ├── tools.py          # read-only functions (AIL-14)
│   ├── llm_utils.py      # call_llm() from AIL-11
│   └── config.py
└── tests/
```

### 8. The list of questions is the specification

The architecture and the data are clear; what's left is to pin down what exactly the bot must be able to do. Before writing the functions, we write down the questions the owner will ask. In AIL-14 they grow into four functions: `get_open_orders()` — orders in progress, `get_sales(period)` — revenue and profit for a day, week or month, `get_product_interest(product, period)` — views and add-to-carts, `get_recent_orders(period, limit)` — the latest orders. The names are needed already today: in `questions.md` we mark for each question which function answers it.

A list of 10–15 questions is not a formality. It is our first mini-eval: in AIL-15 the bot counts as done when it answers 12 of the 15 questions correctly. A good list:

- covers **each** function at least twice;
- contains questions that need **two functions** ("which orders are in progress now and what's the revenue this week?");
- contains **relative dates** ("yesterday", "last week", "since the start of the month");
- contains **out-of-scope questions** ("issue a refund for order 1042", "how much did we actually pay for delivery", "how many times was the North Mug viewed in August") — the correct answer to them is a polite refusal with an explanation;
- for each question records the **expected answer** or a way to check it (an SQL query we run ourselves).

## DeepSeek and Ollama: how we do it

### The project's key decision: which model sees the snapshot data

Tool results are revenue, profit and orders, and right next to them in the snapshot are customers' names, emails and phone numbers. Everything a function returns goes into the model's context, that is, **to the provider's server**. So in this project the provider is chosen not by price and not by quality, but by the data:

| What data the bot sees | Ollama (local) | DeepSeek | Claude / OpenAI |
|---|---|---|---|
| Snapshot `data/shop.db` (customers' personal data) | ✅ the main path | ❌ never: cloud, servers in China | ❌ cloud, not in this project |
| Demo database `data/demo_shop.db` (AIL-14) | ✅ | ✅ the main cloud path | ✅ for comparison only |

With Ollama the model runs on our machine, the request goes to `http://localhost:11434` and goes nowhere else. A caveat: the Ollama library has **cloud** models (marked `cloud` or with a `-cloud` suffix in the tag, e.g. `gpt-oss:20b-cloud`) — they run on Ollama's servers. For the snapshot — local tags only.

This is the same rule as with refunds: the protection is in the code, not in discipline. At startup the bot itself checks that a cloud provider is given only the demo database.

### One client for two providers

Both DeepSeek and Ollama accept the OpenAI Chat Completions format (checked against the docs, November 2026): DeepSeek has `base_url="https://api.deepseek.com"`, Ollama has `http://localhost:11434/v1/` and any non-empty `api_key` (it is ignored). So the whole bot is written on one SDK, `openai`, and the provider is switched with environment variables:

```python
# bot/config.py (illustrative)
import os
from pathlib import Path

PROVIDERS = {
    # name: (base_url, env var holding the key, runs on this machine?)
    "ollama":   ("http://localhost:11434/v1/", None, True),
    "deepseek": ("https://api.deepseek.com", "DEEPSEEK_API_KEY", False),
}
DEMO_SHOP_DB = Path("data/demo_shop.db").resolve()

def llm_settings() -> tuple[str, str, str]:
    provider = os.environ["LLM_PROVIDER"]            # "ollama" | "deepseek"
    base_url, key_env, _ = PROVIDERS[provider]
    api_key = os.environ[key_env] if key_env else "ollama"   # Ollama ignores the key
    return provider, base_url, api_key

def assert_data_policy(provider: str, model: str, shop_db: Path) -> None:
    # A cloud model may only ever see the demo database (no personal data).
    _, _, local = PROVIDERS[provider]
    if model.endswith("-cloud") or ":cloud" in model:   # Ollama cloud tags run remotely
        local = False
    if not local and shop_db.resolve() != DEMO_SHOP_DB:
        raise SystemExit(f"{provider} is a cloud provider: "
                         f"SHOP_DB_PATH must be {DEMO_SHOP_DB}, got {shop_db}")
```

`assert_data_policy` is called in `main.py` before the bot starts receiving messages from Telegram (polling, chapter 3.3), and in `run_questions.py` (the script that runs the questions from `questions.md`, also chapter 3.3) before the first question. If out of habit we set `LLM_PROVIDER=deepseek` next to `SHOP_DB_PATH=data/shop.db`, the bot won't start — rather than "start and send customers' data to the cloud". We add a pytest test for this.

A small thing that can easily cost an hour: if `HTTP_PROXY`/`HTTPS_PROXY` is set in the environment, the `openai` client (it is built on `httpx`) may send even a request to `localhost` through the proxy. We add `NO_PROXY=localhost,127.0.0.1`.

### Comparing providers for this project

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Where it runs | Anthropic's cloud | OpenAI's cloud | cloud, servers in China | our machine (except `cloud` tags) |
| Snapshot with personal data allowed | no (in this project) | no | never | yes |
| Key | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `DEEPSEEK_API_KEY` | not needed |
| API format | its own Messages API | Chat Completions / Responses | OpenAI-compatible; there is also an Anthropic-compatible `https://api.deepseek.com/anthropic` | OpenAI-compatible `/v1` + native `/api/chat` |
| Money | per token | per token | per token, very cheap, with peak and off-peak prices (chapter 3.4) | 0; we pay with memory, response time and load on the machine |
| Tool calling | yes | yes | yes (`deepseek-flash`, `deepseek-v4-pro`) | yes, but quality depends on the model and its size (chapter 3.3) |
| Works offline | no | no | no | yes |

DeepSeek models as of November 2026 per the [pricing page](https://api-docs.deepseek.com/quick_start/pricing): `deepseek-flash` and `deepseek-v4-pro`, both with a 1M context; the old name `deepseek-v4-flash` is still accepted but served by the new model. Names change — we check the page before starting.

### Ollama: how much memory is needed

The main constraint on choosing a local model is memory, which it shares with everything running on the machine:

- Ollama is available for macOS, Linux and Windows. On a Mac it requires macOS Sonoma (14) or newer and uses the GPU on Apple Silicon ([docs.ollama.com/macos](https://docs.ollama.com/macos)). Models live in `~/.ollama`.
- A rough size guide: 8 GB of memory — 3–4B models in q4 quantization (≈2.5 GB on disk); 16 GB — 7–8B (≈5 GB); 32 GB and more — 14B and larger. For example, `gpt-oss:20b` needs at least 16 GB of memory according to its page.
- **We don't load a model right up to the limit of free memory.** Next to an IDE, a browser and Docker a large model goes into swap, and everything starts to crawl. Ollama unloads a model after a few minutes of idling (`keep_alive`, `5m` by default) — we run the questions when the machine isn't busy with something heavy, or keep the model small.

Which model exactly to take and how to check it is covered in detail in chapter 3.3 · Project 1: tool calling + Telegram. To start today: `qwen3:4b-instruct-2507-q4_K_M` (2.5 GB, supports tools).

### Installation — only from the official source

1. We download the app from [ollama.com/download](https://ollama.com/download), not from third-party mirrors and not via `curl … | sh` without reading the script.
2. On macOS, before the first launch, we check the signature and notarization:
   ```bash
   codesign -dv --verbose=4 /Applications/Ollama.app   # who signed it (Developer ID, Team ID)
   spctl -a -vv /Applications/Ollama.app               # expect: accepted, source=Notarized Developer ID
   ```
   On Linux the official installation is a script; we download and read it first, then run it.
3. We pull models from the official library by the **full tag** (`ollama pull qwen3:4b-instruct-2507-q4_K_M`), not `latest` — otherwise a month later a different model sits under the same name and comparisons stop adding up.
4. We pin Python packages: `openai==<version>` and, if the native API is needed, `ollama==<version>` (the official client, 0.6.3 on PyPI as of November 2026).

## Learning path

1. We open [sqlite3 in Python](https://docs.python.org/3/library/sqlite3.html) → read the Tutorial, then in the Reference: `sqlite3.connect()` (the `uri` parameter), `Connection.execute`, `Row`, `row_factory`, the How-to sections "How to work with SQLite URIs" and "How to use placeholders to bind values" (≈40 min). We take away: `?`/`:name` placeholders instead of f-strings in SQL, `mode=ro`.
2. We open [SQLite: VACUUM](https://www.sqlite.org/lang_vacuum.html) → the section on `VACUUM INTO` (≈10 min). Note: the source doesn't change, the target file must not exist.
3. We open [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html) → the first sections: how WAL works, checkpoint, the `-wal`/`-shm` files (≈15 min). We take away: why `cp` gives an inconsistent copy.
4. We open [SQLite: URI filenames](https://www.sqlite.org/uri.html) → the `mode` and `immutable` parameters (≈10 min).
5. We open [aiogram](https://docs.aiogram.dev) → Quick start / the echo bot example, then the Dispatcher, Router, Filters (magic filter `F`) and Middlewares sections (≈60 min). There's no need to learn everything: what matters is understanding how an update flows `Dispatcher → Router → filter → handler`, and that handlers are `async def`.
6. We open [Telegram Bot API: tutorial](https://core.telegram.org/bots/tutorial) → the section on getting a token from @BotFather (≈15 min). We create a bot; the token goes straight into `.env`.
7. (If a Python refresher is needed) [asyncio](https://docs.python.org/3/library/asyncio.html) → "Coroutines and Tasks", only the beginning (≈20 min). `async/await` exists in many languages, but here we start the event loop ourselves with `asyncio.run()`.
8. We open [GitHub: Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) → Mermaid in a README (≈10 min). The diagram in the README renders right on GitHub.
9. We open [Ollama: macOS](https://docs.ollama.com/macos) and the [Ollama FAQ](https://docs.ollama.com/faq) → requirements, where models live, `keep_alive`, the privacy section ("Ollama runs locally…") (≈15 min). We take away: local models don't send data, cloud (`cloud`) ones do.
10. We open [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) → the base URL, what is supported in `/v1/chat/completions` and what isn't (no `tool_choice`) (≈10 min).
11. We open [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and [Your First API Call](https://api-docs.deepseek.com) → model names, base URL, an example with the `openai` SDK (≈10 min). We record the date of the check in our notes.

## What to watch out for

- **Personal data in a public repository is the project's main risk.** `data/`, `*.db`, `*.db-wal`, `*.db-shm`, `logs/`, `.env` go into `.gitignore` before the first commit. If a snapshot ever lands in a commit, it stays in the git history even after the file is deleted. The check: `git check-ignore -v data/shop.db` must show the rule.
- **Screenshots and examples in the README — only on the demo database.** Numbers and customers from the snapshot must not reach the public repository as a file, an image or a line in the README.
- **`sqlite3.connect("data/shop.db")` without `mode=ro` creates an empty file on a typo** — and the bot confidently answers "there are no orders".
- **We don't open the live database from the bot "just to take a look"**, even read-only: a read transaction in WAL interferes with checkpoints and can bloat the running application's `-wal`. Only the snapshot.
- **`sqlite3 -readonly` doesn't work on a live WAL database.** For the snapshot we open it with plain `sqlite3` and run only `VACUUM INTO`.
- **We don't mix up paths**: `VACUUM INTO` with a path pointing to an existing file fails — that's good. But the `rm` before a snapshot is aimed only at files in the bot's `data/`.
- **We don't connect the bot to the payment provider's and delivery service's APIs with keys** "to show live statuses". These are signed requests with keys and a different class of risk (refunds are issued through the same API); this project has none of them.
- **Time**: SQLite stores UTC, while the shop owner thinks in local time. We record this in the README right away, otherwise in AIL-15 "today" will be off by several hours.
- **"Just to see how DeepSeek answers on the snapshot"** — not allowed. Model comparison is done on the demo database; only the local Ollama works on the snapshot. `assert_data_policy` guarantees this, not memory.
- **Ollama's `-cloud` tags are the cloud**, even though they are started with the same `ollama run` command.

## Practice

- [ ] **The project folder.** In the study repository from AIL-56 we create `projects/01-shop-analyst-bot/` (the repository can stay private for now; it becomes public in AIL-16). Inside: `uv init` or `python -m venv .venv`. Dependencies: `aiogram`, `openai` (the client for Ollama and DeepSeek), `pydantic`, `python-dotenv`, `pytest`; `anthropic` — optional, for comparison. We pin the versions.
- [ ] **`.gitignore` before the first commit.** At minimum:
  ```gitignore
  .env
  .venv/
  data/
  *.db
  *.db-wal
  *.db-shm
  logs/
  __pycache__/
  ```
  The check: `git check-ignore -v data/shop.db .env`.
- [ ] **`.env.example`** with variable names and no values: `TELEGRAM_BOT_TOKEN=`, `OWNER_TELEGRAM_ID=`, `LLM_PROVIDER=ollama`, `LLM_MODEL=`, `DEEPSEEK_API_KEY=`, `ANTHROPIC_API_KEY=` (for comparison), `SHOP_DB_PATH=data/shop.db`, `ANALYTICS_DB_PATH=data/analytics.db`, `SHOP_LIVE_DIR=` (only for `snapshot.sh`, the bot doesn't read it), `TIMEZONE=`, `NO_PROXY=localhost,127.0.0.1`.
- [ ] **The shop's "live" databases.** With a model's help we write `scripts/make_shop_db.py` on the standard library. The request contains only the schema from section 3, so any provider will do; we read the code in full before running it. Requirements: `--seed` and `--out` arguments; `random.Random(seed)` so that one seed gives the same data; both databases with the schema verbatim; `PRAGMA journal_mode=WAL`; 8–12 products in 4–5 categories, including tea and coffee by weight (`unit = 'g'`); several hundred orders over 30 days, including unfinished ones, refunds and cancellations; customers with names, emails and phone numbers; hourly `product_stats` for 30 days; a refusal if the files already exist. At the end the generator prints `journal_mode` (expected `wal`) and the row counts — after that we don't open the live databases by hand. Run it from the repository root so that `shop-live/` ends up next to it, not inside: `python3 projects/01-shop-analyst-bot/scripts/make_shop_db.py --seed 1 --out ../shop-live/`.
- [ ] **Ollama.** We install it from ollama.com (on macOS, `codesign -dv` and `spctl -a -vv` before the first launch), then `ollama pull qwen3:4b-instruct-2507-q4_K_M` and a check on a question without shop data: `ollama run qwen3:4b-instruct-2507-q4_K_M "Say hi in Russian"`. We look at `ollama ps`: how much memory the model took.
- [ ] **The DeepSeek key** — in `.env`, a top-up of a couple of dollars. The first request is an abstract question, not about orders.
- [ ] **`bot/config.py`** with `llm_settings()` and `assert_data_policy()` as in the section above + a test: `deepseek` + `data/shop.db` → `SystemExit`; `deepseek` + demo database → ok; `ollama` + a local tag + `data/shop.db` → ok; `ollama` + `gpt-oss:20b-cloud` + `data/shop.db` → `SystemExit`.
- [ ] **The snapshot.** We write `scripts/snapshot.sh`: it takes the live databases folder from `SHOP_LIVE_DIR`, deletes the old `data/shop.db` and `data/analytics.db`, runs `VACUUM INTO` for both databases, switches the **copies** to `journal_mode=DELETE`, prints the size and `SELECT count(*) FROM orders`. We run the script manually; we don't put it in cron. Inside the script, the only thing done to the live database is `VACUUM INTO`.
- [ ] **`bot/db.py`.** The function `open_readonly(path)` as in the theory. A manual test in `python -i`:
  ```python
  from pathlib import Path
  from bot.db import open_readonly
  conn = open_readonly(Path("data/shop.db"))
  conn.execute("SELECT count(*) FROM orders").fetchone()[0]   # works
  conn.execute("DELETE FROM orders")                          # must raise
  open_readonly(Path("data/nope.db"))                         # must raise, no file created
  ```
  Expected: the second and third calls fail (`sqlite3.OperationalError`), and the file `data/nope.db` doesn't appear.
- [ ] **Exploring the data.** Five SQL queries against the copy, results go into personal notes (not into the repository): the number of unfinished orders by status (`new`, `paid`, `shipped`), which products are in them (`JOIN order_items` and `products`), the oldest and the newest `closed_at`, whether there are anomalies like `status = 'delivered'` with `delivered_at IS NULL` or a paid order without a row in `payments`, the units of `product_stats.time`.
- [ ] **The order profit formula** — we write it down in words in our notes and check it by hand on 2–3 orders from the copy, at least one with tea or coffee by weight: the row amount for `pcs` is `quantity × unit_price`, for `g` it is `quantity / 100 × unit_price` (the cost the same way via `unit_cost`); profit = sum of the rows − cost of the rows − `discount` − `fee`. We check how `fee` and refunds are recorded.
- [ ] **A diagram in the README** (Mermaid or ASCII): Telegram → bot → LLM → functions → SQLite (read-only). On a separate line: "the shop's live databases, the payment provider and the delivery service are not accessible to the bot".
- [ ] **`questions.md`** — 15 questions in a table: `# | question | which functions | how to check the answer`. Required: 2+ questions with two functions, 3+ with relative dates, 3 "out of scope" (issue a refund, actual delivery expenses, interest in a product older than 30 days).

## Done when

- The `projects/01-shop-analyst-bot/` folder is created, `.gitignore` protects `data/`, `.env`, `logs/`, `*.db*` — checked with `git check-ignore`.
- `make_shop_db.py` creates both live databases in `../shop-live/` in WAL mode; `scripts/snapshot.sh` makes a copy via `VACUUM INTO`, the copy opens via `open_readonly`, writing to it fails with an error, a nonexistent path doesn't create a file.
- The README has a diagram with an explicit "read-only" boundary.
- There is a `questions.md` with 10–15 questions, the expected functions and a way to check.
- Ollama is installed from the official source (signature checked), the local model answers; `assert_data_policy` doesn't let a cloud provider run on the snapshot — checked with a test.

## Self-check quiz

1. Why can't `cp shop.db` be used to copy a live WAL database?
   a) `cp` is slower; b) transactions from `-wal` may not get into the copy, and it may turn out inconsistent; c) `cp` changes the file permissions; d) SQLite blocks `cp`.
2. What happens on `sqlite3.connect("data/shpo.db")` (a typo) and on `sqlite3.connect("file:data/shpo.db?mode=ro", uri=True)`?
3. Which two independent mechanisms make the connection read-only in our `open_readonly`?
4. Why is "the system prompt says not to issue refunds" insufficient protection?
5. How many `order_items` rows correspond to one order, and how are they linked to the order?
   a) one; b) one per product, by `order_id`; c) one per product, by `product_id`; d) it depends on the delivery service.
6. An `order_items` row: `quantity = 250`, `unit_price = 4.80`. What is the row amount if the product is tea (`unit = 'g'`)? And if it is mugs (`unit = 'pcs'`) with the same numbers?
7. What is wrong with this snapshot script?
   ```bash
   cp "$SHOP_LIVE_DIR/shop.db" data/shop.db
   sqlite3 data/shop.db "PRAGMA journal_mode=DELETE;"
   git add data/shop.db
   ```
8. The question is "how much did we net this week, taking delivery expenses into account?". What should the bot answer based on this database?
9. What are two downsides of the "one function `run_sql(query)`" approach for this project?
10. Why may `closed_at >= date('now', '-1 day')` not match the shop owner's "yesterday"?
11. Why does `questions.md` need questions the bot can't answer?
12. We need to compare how DeepSeek and a local Qwen answer 15 questions. Which database does each model run on, and why?
13. Why does the same `openai` SDK work for both DeepSeek and Ollama? What changes in the code when switching?
14. What is wrong with this configuration?
    ```env
    LLM_PROVIDER=ollama
    LLM_MODEL=gpt-oss:20b-cloud
    SHOP_DB_PATH=data/shop.db
    ```

## Answers

1. **b.** The latest transactions may sit in `-wal`, and during a checkpoint the main file changes — the copy comes out inconsistent. `VACUUM INTO` writes a consistent snapshot.
2. The first call silently creates an empty database `shpo.db`, and the bot answers "no data". The second fails with `unable to open database file` — the error is visible right away.
3. `mode=ro` in the URI (SQLite opens the file read-only) and `PRAGMA query_only = ON` (the connection rejects any changes).
4. A prompt is a request; the model can make a mistake or fall for an injection. Real protection is the absence of the function and the permissions: there is nothing to call and nothing to write with.
5. **b.** One row per product in the order, all with the same `order_id`; an order's revenue and profit are the sum over the rows.
6. Tea: `quantity` is in grams, the price is per 100 g → `250 / 100 × 4.80 = 12.00`. Mugs: `quantity` is in pieces, the price is per piece → `250 × 4.80 = 1200.00`. That's why the rule lives in a single function, `item_amount`.
7. `cp` instead of `VACUUM INTO` (an inconsistent copy) and `git add` of the snapshot — customers' personal data goes into the git history; `data/` must be in `.gitignore`.
8. That actual delivery expenses are not in the database: it can give the week's profit before delivery expenses and state explicitly that they are not included.
9. The model writes arbitrary SQL (the risk of heavy queries, of reading personal data, and of getting the profit and grams/pieces logic wrong anew each time), it is hard to limit the output size, and there is almost nothing to test.
10. `date('now')` in SQLite is UTC, while the owner's "yesterday" is in their time zone; the day boundaries are shifted by the time zone difference.
11. They test the behavior at the boundaries: the bot must politely refuse (there is no refund function, no data on actual delivery expenses, no product stats older than 30 days) rather than make up an answer.
12. Both on the demo database: tool results go to the provider, and DeepSeek is a cloud (servers in China) that must not be shown customers' personal data. The local model is then additionally run on the snapshot; DeepSeek never sees it.
13. Both implement the OpenAI Chat Completions format. Only `base_url`, `api_key` (any value for Ollama, it is ignored) and the model name change — that is, environment variables, not code.
14. The `-cloud` tag runs on Ollama's servers, not on the local machine — the snapshot with personal data goes to the cloud. The snapshot needs a local tag; `assert_data_policy` from this chapter rejects such a configuration.

## What's next

In AIL-14, "Project 1: read-only tools for the LLM", we turn the explored schema and the profit formula into four functions with Pydantic models, pytest tests and a demo database generator without personal data.
