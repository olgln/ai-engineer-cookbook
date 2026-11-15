# 8.5 · An MCP server for the shop database (read-only)  (AIL-39)

> **Week 8** · Agents · ⏱ ~4–5 h · Project

<!-- description: A read-only Python MCP server for the shop database: MCP primitives and transports, tool descriptions for the model, and server security. -->
<!-- source-sha256: 65435ed8e5f5 -->

## Why an AI engineer needs this

MCP (Model Context Protocol) is an open standard for connecting tools and data to LLM clients: Claude Desktop, Claude Code, Cursor, IDEs and our own agents. The server is written once, and the data becomes available from any compatible client. Our own MCP server for the shop database with a well-thought-out security model is a strong line on a résumé and a good topic to talk about in an interview.

> ⚠️ **Read-only.** No functions that change orders, issue refunds or hand out promo codes, and no requests to the payment provider or the delivery service with keys: only a database snapshot made with `VACUUM INTO`. The server does not import the shop application's code, does not read `.env` and does not know a single key.

## Theory

Until now the agent's tools lived in the same file as the loop: `tools.py` from chapter 8.3 works only in our `agent_oai.py`. For project 4 the agent needs access to the shop database, and after chapter 8.4 it is clear that this access must be narrow and read-only. We move it into a separate process with a standard interface: an MCP server. Then the security rules live in one place, and we can connect the server to our own agent, to Claude Code or to any other client.

### What MCP is

MCP is a protocol on top of JSON-RPC 2.0 between a **client** (it lives inside a host application: Claude Desktop, Claude Code, our agent) and a **server** (our program, which provides capabilities).

```
┌──────────── Host (Claude Desktop / Claude Code / your agent) ───────────┐
│   LLM  ◄──►  MCP client ──── JSON-RPC over stdio or HTTP ────┐          │
└──────────────────────────────────────────────────────────────┼──────────┘
                                                               ▼
                                          MCP server (your Python process)
                                           ├─ tools:     list_orders, ...
                                           ├─ resources: schema://shop
                                           └─ prompts:   order_postmortem
                                                  │ read-only
                                                  ▼
                                          data/shop.db (snapshot, events inside)
```

An analogy: MCP is to LLMs what LSP is to editors. Before, every editor wrote support for every language; with LSP, a language writes one server. Here, every tool is written once and works in all clients.

### The three server primitives

A server can offer a client three kinds of capabilities. They differ in who decides to use them:

| Primitive | Who controls it | What it is | Our example |
|---|---|---|---|
| **Tools** | The model (decides to call) | Functions with a JSON Schema of parameters | `list_orders(status, since, until, limit)` |
| **Resources** | The application/user (decides to load) | Data by URI, like files | `schema://shop`: a description of the tables |
| **Prompts** | The user (picks a template) | Ready-made request templates with parameters | `order_postmortem(order_id)` |

Clients support them differently: tools are supported almost everywhere, resources and prompts are not. We build the core functionality as tools.

### Transports

What is left is to choose how the client and the server exchange JSON-RPC messages. There are two options:

- **stdio**: the client launches the server as a child process and talks to it over stdin/stdout. For local servers this is the standard: no port, no network, no authorization. This is our case.
- **Streamable HTTP**: the server listens on HTTP, and clients connect over the network (remote servers, multiple users). Then authorization is needed (the spec describes OAuth). For a database with orders and customer data **we do not open an HTTP port to the outside**: stdio closes off a whole class of problems.

An important stdio trap: **stdout belongs to the protocol**. Any `print()` to stdout breaks JSON-RPC. Logs go only to stderr or to a file.

### A minimal server on the Python SDK

Here is what it looks like in code: one tool, a read-only database connection, launch over stdio. The `mcp` package is the official Python SDK; versions and installation are at the end of the section.

```python
# server.py — illustrative, check the MCP Python SDK README for the current API
import os, sqlite3, sys
from pathlib import Path
from mcp.server.fastmcp import FastMCP  # SDK v1 style; in v2: from mcp.server import MCPServer

# Set at server start, never by a tool argument; default is the snapshot next to this file
DB_PATH = os.environ.get("SHOP_DB_PATH", str(Path(__file__).parent / "data" / "shop.db"))
mcp = FastMCP("shop-readonly")

def connect() -> sqlite3.Connection:
    # Read-only at the OS/SQLite level: any write fails even if code has a bug
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn

@mcp.tool()
def list_orders(status: str = "all", since: str | None = None,
                until: str | None = None, limit: int = 20) -> list[dict]:
    """List orders from a read-only snapshot of the shop DB.
    ... (full description: see section 'Tool descriptions' below)
    """
    ...

if __name__ == "__main__":
    print(f"shop MCP starting, db={DB_PATH}", file=sys.stderr)  # stderr only, never stdout
    mcp.run()  # stdio transport by default
```

FastMCP builds the tool's JSON Schema from the type hints and takes the description from the docstring, just as the Pydantic model in chapter 3.2 gave the schema for tool calling (and in many languages libraries like zod do something similar). The body of `list_orders` itself is ordinary SQL; before writing it, let's look at what data the server connects to.

### Data: what we have

The database is the same as in project 1 (chapter 3.1 (AIL-13)): the live one sits in `../shop-live/`, and the server, like the bot, works only with a **snapshot**: a consistent copy in the project's `data/` folder (it is in `.gitignore`). The difference from the bot is that more tables are needed: to investigate an order, sales are not enough, we need delivery and the event log.

- **`shop.db`** (`shop-analytics.db` is not needed). The server needs `orders`, `order_items`, `products`, `payments`, `shipments`, `events`. The server does not read the `customers` table (names, emails, phones) at all.
- **`events(id, order_id, time, type, message)`**: the order event log: payments, promo code rejections, delivery updates, cancellations. It keeps **30 days**: for older orders the honest answer is "not enough data".

To have something to investigate, we extend the generator from chapter 3.1: `make_shop_db.py --incidents 20` plants 20 problem orders with a known cause and writes the answers to `../shop-live/incidents.json`. The causes come from the incident catalog, which in chapter 9.2 becomes the reference for the project 4 agent: `double_charge` (two successful payments), `stuck_in_delivery` (delivery not updated for days), `promo_not_applied` (promo code entered, discount 0), `refund_not_arrived` (the refund did not go through), `out_of_stock_cancel` (cancellation after payment: the product ran out), `payment_failed` (auto-cancellation after failed payments), `unknown` (not enough data). The traces of each cause are in `payments`, `shipments`, `products.stock` and `events` (for example, `promo_rejected` or `auto_cancel`).

`incidents.json` is the answer key for the evals in chapter 9.3. **Neither the server nor the model ever sees it**: not in `data/`, not in descriptions, not in prompts. Otherwise the eval stops measuring anything.

We make the snapshot itself the same way as in project 1, only through `VACUUM INTO` (the database is in WAL mode, and a plain `cp` can produce an inconsistent file):

```bash
# run from the repo root; reads the live DB, writes a consistent snapshot
rm -f projects/mcp-shop/data/shop.db
sqlite3 ../shop-live/shop.db "VACUUM INTO '/abs/path/ai-engineering-journey/projects/mcp-shop/data/shop.db'"
```

If the copy fails to open in `mode=ro` (the copy may keep WAL mode in its header), we run `sqlite3 data/shop.db "PRAGMA journal_mode=DELETE"` once on the **copy**. The MCP server never opens the live database.

One last thing about the data, and it is where the model makes mistakes most often. We remember the database facts from chapter 3.1: **one order = several `order_items` rows**; for `unit = 'g'` (tea and coffee by weight) `quantity` is in grams, and `unit_price` and `unit_cost` are per 100 g; **the order total and profit are not stored**, they are computed by `item_amount`, `order_total`, `order_profit` from `bot/domain.py` in project 1. We move this logic into the server's `domain.py` together with the tests, otherwise the model will confidently answer with wrong numbers: 250 g of Sencha tea at $4.80 per 100 g will turn into $1,200 instead of $12.

### The tool set

The data is clear; now we decide what the server will tell the model about it. The principle from chapter 8.2 (AIL-63), where the `order` handler ran prewritten queries: **narrow tools with prewritten parameterized queries** are better than "run any SQL".

| Tool | What it does |
|---|---|
| `get_product(sku)` | A product: name, category, unit (`pcs`/`g`), price, stock, whether it is on sale |
| `list_orders(status, since, until, limit)` | Orders with filters, already assembled from items, with a computed total |
| `get_order(order_id)` | One whole order: items, payments, delivery + computed total and profit |
| `search_events(query, order_id, date_from, date_to, limit)` | Search over the `events` log: substring, order, interval; rows with time and type, truncated |
| `summary_stats(since, until)` | Number of orders, revenue, status distribution, number of problem signals by type |

`summary_stats` counts the signals from the data (orders with two successful payments, `promo_rejected` events, `auto_cancel` and so on), not from `incidents.json`.

If we really want to allow free-form SQL, it is only as a separate `run_readonly_sql` tool with three layers: a `mode=ro` connection, `PRAGMA query_only=ON` and `conn.set_authorizer(...)` that allows only `SQLITE_SELECT`, `SQLITE_READ` and `SQLITE_FUNCTION` (and forbids reading `customers`); plus a `LIMIT` and a timeout through `conn.set_progress_handler`. But we start without it.

### Tool descriptions (after "Writing effective tools for agents")

The tool set defines *what* the model can ask; the description decides whether it asks correctly. The model sees only the name, the description and the schema. A good description answers these questions: what it does; when to use it and when **not** to; what the parameters mean and in what format (dates: ISO, UTC!); what it returns; what the limits are.

```text
list_orders: List orders from a read-only snapshot of the shop DB, newest first.
One order has several items (order_items rows); this tool returns whole orders,
already assembled. Use get_order to see items, payments and shipment of one order.
Args:
  status: "new" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded" | "all"
          (default "all")
  since/until: ISO 8601 UTC datetimes like 2026-11-10T00:00:00Z, compared with created_at
  limit: 1..50, default 20
Returns: id, status, created_at, paid_at, shipped_at, closed_at (UTC), delivery_method,
promo_code, discount, items_count, total_usd (computed: items - discount + delivery_cost;
totals are not stored in the DB). Customer names, emails and phones are never returned.
The snapshot may lag behind the live shop; snapshot time is in the 'snapshot_at' field.
```

More advice from the article: return meaningful fields, not internal IDs without context; limit the size of the response and say when the result is truncated; make errors **helpful** ("since must be ISO date like 2026-11-10T00:00:00Z") so the model can correct itself; name tools consistently.

### Server security

We apply the conclusions from chapter 8.4 (AIL-64): even a fully hijacked model must not be able to do harm through this server.

1. **No write tools.** No order changes, no refunds, no promo codes, no messages to customers, no sending to Telegram.
2. **No network.** The server does not import the payment provider's or delivery service's SDK, makes no HTTP requests and knows no keys. The "channel out" leg is absent from the server itself.
3. **Read-only at the SQLite level** (`mode=ro` + `query_only`), not just "there is no INSERT in the code".
4. **Copies only.** The database path is set when the server starts (the `SHOP_DB_PATH` variable, `data/shop.db` by default), not by a tool parameter.
5. **A size limit** on every response.
6. **The event log is untrusted input.** `events.message` contains texts we did not write: statuses from the delivery service, payment provider errors, customer comments. We mark the result of `search_events` as data.
7. **Annotations.** The MCP spec has tool hints (for example, `readOnlyHint`); we set them, but remember that this is a hint for the client, not protection.
8. **Client permissions.** In Claude Code we can explicitly allow only our server's tools; we do not turn on modes where the agent runs everything without asking.
9. **Everything a tool returns goes to the model provider.** We return nothing we are not ready to send to the API: the server does not read `customers`, and in `events.message` we mask phones and emails.

**Installation.** The `mcp` package is the official SDK from the `modelcontextprotocol` organization on GitHub. As with any third-party code: we check the exact name on PyPI, the author, the version; we pin the version.

**SDK version (checked November 13, 2026):** the current stable line of the Python SDK is v2, and in its documentation the server is created as `from mcp.server import MCPServer; mcp = MCPServer("...")` with the same `@mcp.tool()` decorator, and the client as `from mcp import Client`. The code above is written in v1 style (`FastMCP` from `mcp.server.fastmcp`). We pick one: pin v1 and use the v1 documentation, or take v2 and replace the import following the [Migration Guide](https://py.sdk.modelcontextprotocol.io/). We do not mix examples from the two versions.

## DeepSeek and Ollama: how we do it

> ⚠️ **This server returns snapshot data.** Orders, payments and the event log are customer data, even if there are no names or phones in the responses. Everything a tool returns ends up in the model's context, which means it goes wherever the model runs. So for the `data/shop.db` snapshot **the main path is a local model in Ollama**. DeepSeek (servers in China), as well as Claude Code / Claude Desktop with cloud Claude, are **demo database only**. Item 9 from "Server security" is now stricter: the snapshot does not leave our machine.

### Who will be the MCP client

The server itself does not depend on the provider: it speaks MCP, not to the model. What changes is the **host**: who launches the server and passes its tools to the model.

| Host | Model | Snapshot? | Comment |
|---|---|---|---|
| **Our own bridge `bridge.py`** (MCP client + the loop from chapter 8.3) | Ollama (`qwen3:4b`) | **Yes: the main path** | ~80 lines, everything is visible, data does not leave the machine. We run Ollama with `OLLAMA_NO_CLOUD=1` |
| The same bridge | DeepSeek `deepseek-flash` | Demo database only | Comparing the quality of tool choice |
| Claude Code / Claude Desktop | Claude | Demo database only (for comparison) | Best UX, but data goes to Anthropic |
| Claude Code with `ANTHROPIC_BASE_URL=http://localhost:11434` | A local Ollama model | Technically yes, but not the main path | Ollama has [instructions](https://docs.ollama.com/integrations/claude-code); Anthropic does not officially support non-Claude models through gateways; Claude Code's system prompt and tools are large, so a context of ≥ 64k is needed (unrealistic on an 8 GB machine) and a model with the `tools` label; Ollama does not support `tool_choice` or caching |
| Claude Code with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` | DeepSeek | Demo database only | DeepSeek has [instructions](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code); the DeepSeek API ignores `mcp_servers`, but Claude Code acts as the MCP client itself |

Ollama and DeepSeek have no "MCP in the API" (like Anthropic's MCP connector or OpenAI's remote MCP tool): the MCP client is always our process.

### The bridge: MCP server → Ollama tools

```python
# bridge.py — illustrative, MCP Python SDK v2 client API; verify against the docs of your pinned version
import asyncio, json, os, sys
from mcp import Client, StdioServerParameters
from mcp.types import TextContent
from openai import OpenAI

llm = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # local only
MODEL = os.environ.get("LLM_MODEL", "qwen3:4b")
SERVER = StdioServerParameters(command="uv", args=["run", "server.py"])  # env is NOT inherited

def to_oai(tools) -> list[dict]:
    return [{"type": "function", "function": {"name": t.name, "description": t.description or "",
             "parameters": t.input_schema}} for t in tools]

async def ask(question: str, system: str) -> str:
    async with Client(SERVER) as mcp:
        tools = to_oai((await mcp.list_tools()).tools)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": question}]
        for _ in range(8):                                   # step limit
            msg = llm.chat.completions.create(model=MODEL, messages=messages,
                                              tools=tools).choices[0].message
            messages.append({"role": "assistant", "content": msg.content or "",
                             "tool_calls": [c.model_dump() for c in msg.tool_calls or []]})
            if not msg.tool_calls:
                return msg.content or ""
            for call in msg.tool_calls:
                try:
                    args = json.loads(call.function.arguments or "{}")
                    res = await mcp.call_tool(call.function.name, args)
                    text = "\n".join(b.text for b in res.content if isinstance(b, TextContent))
                    text = ("ERROR: " + text) if res.is_error else text
                except Exception as e:                       # bad JSON, unknown tool, ...
                    text = f"ERROR: {type(e).__name__}: {e}"
                print(f"tool {call.function.name}({call.function.arguments})", file=sys.stderr)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": text[:8000]})
        return "STOPPED: step limit"

if __name__ == "__main__":
    print(asyncio.run(ask(sys.argv[1], open("prompts/system.md").read())))
```

The child process does not inherit the bridge's environment: we pass the path to the demo database explicitly (`env={"SHOP_DB_PATH": ...}` in `StdioServerParameters`). When connecting DeepSeek to the bridge (demo database only!), we repeat the `assert_data_policy` check from chapter 3.1 and add saving `reasoning_content` in the assistant message, as in chapter 8.3, or turn thinking mode off: otherwise the second step returns a 400.

### Tool descriptions for a small model

What Claude "figures out", `qwen3:4b` will not. For a local model:

- **5–6 tools is the upper limit.** If the model confuses `list_orders` and `get_order` (for example, looks up one order through the list), we refine the descriptions or rename them to something even more distinct (`find_orders` / `get_order_details`); this takes 5 minutes to check.
- **`enum` wherever possible** (`status`): FastMCP/MCPServer builds the schema from type hints, so we use `Literal["new", "paid", "shipped", "delivered", "cancelled", "refunded", "all"]`.
- **Dates with a format example right in the parameter description.** Small models most often get date arguments wrong.
- **Tool errors are instructions for fixing the call**, not a traceback.
- **Compact responses:** a local model's context is smaller, and it reads long JSON worse. We aggregate on the server.

### Comparison: theirs vs. ours

| | Claude (Desktop/Code) | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Ready-made MCP host | Yes (Desktop, Code) | Agents SDK, Responses API (remote MCP) | None of its own; works as a backend for Claude Code and other agents | None of its own; through Claude Code (not supported by Anthropic) or our own bridge |
| Where tool data goes | Anthropic | OpenAI | China | Our machine |
| Snapshot with customer data | No (by the book's rule) | No | No | **Yes** |
| Quality of tool choice | High | High | Good (we measure) | Noticeably lower at 4B; needs simple descriptions and few tools |

## Learning path

1. [Model Context Protocol documentation](https://modelcontextprotocol.io) → the section on architecture and concepts (host/client/server, tools, resources, prompts, transports) and the quickstart for Python server developers (≈60 min). Note the paragraph on logging in stdio servers.
2. [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) → README: Quickstart, Tools, Resources, Prompts, Running your server, Development mode (Inspector) (≈40 min). What we take away: how FastMCP builds the schema from type hints and the docstring, how to run `mcp dev`.
3. [MCP server examples](https://github.com/modelcontextprotocol/servers) → open the reference server for SQLite or the filesystem (if they are in the current version of the repository or in the archive) (≈20 min). We look at how they describe tools and restrict access.
4. [Anthropic: Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) → read it in full (≈30 min). Write down 5 rules for our own descriptions.
5. The Claude Code / Claude Desktop documentation on connecting MCP servers (the MCP section of the Claude Code docs; the `claude mcp add` command) (≈15 min), for the comparison on the demo database.
6. [MCP Python SDK: Clients](https://py.sdk.modelcontextprotocol.io/client/) and [Client transports](https://py.sdk.modelcontextprotocol.io/client/transports/) (≈20 min): `Client`, `StdioServerParameters`, `list_tools`, `call_tool`, `is_error`. Note: the child process does not inherit the parent's environment. If v1 is pinned, read the v1 documentation.
7. Ollama: [Tool calling](https://docs.ollama.com/capabilities/tool-calling), [Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) on `OLLAMA_NO_CLOUD` (≈15 min). Optionally, [Claude Code with Ollama](https://docs.ollama.com/integrations/claude-code) and [Claude Code with DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) (≈10 min).
8. Practice (≈2.5 h).

## What to watch out for

- **`print()` to stdout** breaks a stdio server; the client shows a vague connection error.
- **Relative paths.** The client launches the server from its own working folder; `data/shop.db` will not be found. We build paths from `Path(__file__).parent`.
- **Time in UTC.** Dates in the database are UTC (`YYYY-MM-DD HH:MM:SS`, like `current_timestamp` in SQLite). If the owner asks "what happened yesterday evening" and the model compares against local time, the answer shifts by the time zone difference. We write in the descriptions that time is UTC, and return both forms if convenient.
- **Several rows per order.** Without an explicit explanation, the model counts each `order_items` row as a separate order and inflates the statistics.
- **The order total is not stored, grams are not pieces.** A model that adds up `quantity × unit_price` by itself will be off by a factor of 100 on tea. The total and profit come from the tool, computed by code with tests; profit is before delivery costs (they are not in the database).
- **A stale snapshot.** We return `snapshot_at`: when the copy was made.
- **Huge responses.** All events for a month are thousands of rows, and they will flood the context. We aggregate and limit.
- **The temptation of a "convenient" write tool**: no. Even "just mark the order as checked" or "give a promo code for the inconvenience" is an action in the shop's system.
- **We never connect the server to the live database, not even for a minute** "to check".

## Practice

```
projects/mcp-shop/
  server.py
  db.py              # connect() read-only, query helpers
  domain.py          # item_amount, order_total, order_profit from project 1 + tests
  bridge.py          # MCP client + Ollama loop
  tests/test_tools.py
  data/              # gitignored: shop.db (snapshot), demo_shop.db
  scripts/snapshot.sh   # the VACUUM INTO commands above
  .gitignore
```

- [ ] **Incidents in the live database.** We extend `projects/01-shop-analyst-bot/scripts/make_shop_db.py` with an `--incidents N` argument: N problem orders with causes from the catalog, traces in `payments`, `shipments`, `events`; 2 of them are orders older than 30 days whose event log has already been purged (the correct answer is `unknown`, "not enough data"); the answers (`order_id`, `cause_category`) go to `incidents.json` next to the databases. We delete the old `../shop-live/` (the generator does not overwrite files) and run from the repo root: `python3 projects/01-shop-analyst-bot/scripts/make_shop_db.py --seed 1 --out ../shop-live/ --incidents 20`. Then we make new snapshots.
- [ ] `scripts/snapshot.sh`: a copy of `shop.db` through `VACUUM INTO` into `data/`, then `journal_mode=DELETE` on the copy. We check that `data/` is in `.gitignore` (`git check-ignore -v data/shop.db`).
- [ ] `db.py`: `connect()` with `mode=ro` and `query_only`. Test: an `INSERT` attempt fails with `attempt to write a readonly database`.
- [ ] `domain.py`: `item_amount`, `order_total`, `order_profit` from project 1 and their tests (tea by weight, discount, fee).
- [ ] Tools: `get_product`, `list_orders`, `get_order`, `search_events`, `summary_stats`. All queries are parameterized, all have limits, none reads `customers`.
- [ ] Tool descriptions following the article's rules: date format, grams and price per 100 g, one order = several items, totals are computed, status and event type values, a 30-day log, limits.
- [ ] Resource `schema://shop`: a short description of the tables and the meaning of the fields (for clients that load resources).
- [ ] Prompt `order_postmortem(order_id)`: the template "investigate this order: items, payments, delivery, events during the order's lifetime, the likely cause from the incident catalog; if there are no events, say so".
- [ ] Check through the Inspector (`mcp dev server.py`): call each tool by hand, look at the schemas.
- [ ] `bridge.py`: MCP client + a loop on Ollama (see the DeepSeek and Ollama section). Ollama runs with `OLLAMA_NO_CLOUD=1` and a 16k context; the model is `qwen3:4b` (the default for 8 GB of memory; with 16 GB we can use `qwen3:8b` if the machine is not busy with something heavy). This is the main host for the snapshot.
- [ ] **Demo database.** We extend `make_fake_db.py` from chapter 3.2: the `shipments` and `events` tables (without `customers`) and `--incidents N`, with its own set (20 cases, as in the live database: the public evals in 9.3 run on it) with answers in `data/demo_incidents.json`; the database goes into the server's `data/demo_shop.db`. The server takes the path from `SHOP_DB_PATH` (default `data/shop.db`) and at startup writes to stderr which file it opened. The public evals of project 4 will run on this database.
- [ ] (for comparison, demo database only) We connect the server to Claude Code under the name `shop` (`claude mcp add --env SHOP_DB_PATH=/abs/path/ai-engineering-journey/projects/mcp-shop/data/demo_shop.db shop -- uv run --directory /abs/path/ai-engineering-journey/projects/mcp-shop server.py`) or to Claude Desktop (`claude_desktop_config.json`, the `mcpServers` section, with the same `SHOP_DB_PATH` in `env`), and/or run `bridge.py` with DeepSeek. In this mode the server looks at the demo database; we check this before the first question.
- [ ] We ask 5 questions through `bridge.py` on Ollama and save the answers to `notes/mcp-questions.md`, for example:
  1. "How many orders were placed in the last 3 days, and how are the statuses distributed?"
  2. "What was the revenue for the week, and how many orders were cancelled or refunded?"
  3. "Investigate order <id>: what happened to it?"
  4. "Were there any double charges or stuck deliveries this week? With which carriers?"
  5. "Why was order <id> cancelled after payment, and how much of this product is in stock now?"
  We check the answers against the database by hand, at least two of them. For question 3 we check the cause against `../shop-live/incidents.json` ourselves, not through the model.
- [ ] We note which tool the model chose wrongly and improve its description.
- [ ] A comparison on the demo database: the same 5 questions (reworded for the demo data) on Ollama, DeepSeek and (optionally) Claude. We record where the local model picked the wrong tool or got the arguments wrong.

## Done when

- A local model in Ollama answers questions about orders through our MCP server and `bridge.py`, and the answers match the database; the snapshot never went to any cloud.
- The generator plants 20 incidents and writes `incidents.json`, which the server does not read.
- There is a demo database with events and deliveries, and a comparison with DeepSeek/Claude on it.
- The server physically cannot write (verified by a test), has no network and no keys, does not read `customers`, and works only with a copy.
- The tool descriptions explain "one order, several items", grams, computed totals, UTC and the 30-day log.

## Self-check quiz

1. What three primitives does an MCP server have, and who initiates the use of each?
2. Which transport should we choose for a local server for the shop database, and why?
3. What breaks if we write `print("debug")` in a stdio server?
4. Why are `PRAGMA query_only=ON` and `mode=ro` better than "there is simply no INSERT in the code"?
5. What is wrong with this tool?
   ```python
   @mcp.tool()
   def query(sql: str, db_path: str = "../shop-live/shop.db") -> list:
       """Run SQL."""
       return sqlite3.connect(db_path).execute(sql).fetchall()
   ```
6. Why is the database copy made through `VACUUM INTO` rather than `cp`?
7. Asked "how many orders this week", the model answered 126, while the real number is 42. What is the likely cause, and how do we fix it on the server side?
8. Is `readOnlyHint` in a tool annotation a protection?
   a) yes, the client will not allow a write to be called; b) no, it is a hint for the client, the protection is in the server code; c) yes, the server checks it itself; d) it is a field for resources.
9. What should a good tool description contain? At least 4 points.
10. Why should the result of `search_events` be treated as untrusted input?
11. Why must the database path not be a tool parameter?
12. The MCP server is connected to the `data/shop.db` snapshot, and questions are asked through Claude Code configured for DeepSeek (`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`). The server only reads, has no network and does not return names or phones. What is wrong?
13. Why is the MCP client always our process with Ollama and DeepSeek, but not necessarily with Anthropic and OpenAI?
14. Through the bridge, `qwen3:4b` answers "what's up with order 1042?" by calling `list_orders` instead of `get_order` and writes dates in the "18.01" format. What do we change on the server side?
15. Why is `incidents.json` not put into the server's `data/` and not mentioned in the tool descriptions?

## Answers

1. Tools: called by the model; resources: loaded by the application or the user; prompts: picked by the user.
2. stdio: no network port and no authorization, the client launches the process locally itself; it shuts off remote access to the data.
3. Garbage in stdout breaks the JSON-RPC stream; the client cannot parse the messages and disconnects or shows an error.
4. Protection at the database level works even when there is a bug in the code or with free-form SQL; this is defense in depth.
5. Everything: free-form SQL without read-only (`DELETE`, `UPDATE orders SET status='refunded'` are possible), reading `customers` with emails and phones, the database path as a parameter (we can point it at the live database or any file), the live database rather than the snapshot by default, no limits and no description. It breaks the "read only from a copy" rule.
6. The database is in WAL mode: part of the data sits in the `-wal` file, and a copy of a single file can be inconsistent. `VACUUM INTO` makes a consistent snapshot.
7. One order is several `order_items` rows (three on average here), and the model counted rows. Explain this in the description, or better, return orders already assembled (`list_orders`) and provide `summary_stats`, which counts `COUNT(DISTINCT orders.id)`.
8. **b.** An annotation is a hint for the client; the protection is `mode=ro`, `query_only` and the absence of write tools in the server code.
9. What it does; when to use it and when not to; parameters with formats and units (UTC, ISO, grams and price per 100 g); what it returns; limits (cap, truncation, the 30-day log, snapshot staleness); examples.
10. The log contains text we did not write (delivery service statuses, payment provider errors, customer comments), and indirect injection is possible through it.
11. Otherwise the model (or an injection) can point the tool at the live database or at any other file; the path is set at startup and points to a copy.
12. Everything the tools returned goes into the model's context, that is, to DeepSeek's servers in China; orders, payments and events are customer data even without names. A read-only server does not protect against a leak through the provider. The snapshot goes only with a local model; DeepSeek only on the demo database.
13. Ollama and DeepSeek have no MCP client on the API side: the tools are passed to them as ordinary `tools`, and our code (the bridge, Claude Code, a framework) calls the server. Anthropic has the MCP connector, and OpenAI has the remote MCP tool in the Responses API: there the provider itself can be the client (for remote servers).
14. Make the descriptions and names distinct, use `Literal`/`enum` for parameters, put a date format example in the parameter description, return a clear error with the correct format; if needed, reduce the number of tools.
15. It is the answer key for the project 4 evals: having seen it, the model takes the cause from the answer instead of the data, and the eval measures nothing.

## What's next

Week 9 is Project 4. First chapter 9.1 · Memory and context of an AI agent (AIL-65), then chapter 9.2 · Project 4: an AI agent that investigates orders (AIL-41), where the agent uses the tools of this MCP server on a local model, and in chapter 9.3 the incidents we planted today become the reference for the evals.
