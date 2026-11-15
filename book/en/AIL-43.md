# 9.4 · Project 4: a README of the AI agent for GitHub  (AIL-43)

> **Week 9** · Agents · ⏱ ~4 h · Project

<!-- description: A README for the AI agent project: a demo database and incident generator, repository layout, eval numbers and a check before publishing. -->
<!-- source-sha256: bcbeaf168c64 -->

## Why an AI engineer needs this

The agent from chapter 9.2 works, and chapter 9.3 gave it numbers; what's left is to show it to the world. This is the fourth project in the portfolio. A recruiter or an engineer at a screening spends 2–5 minutes on a repository: in that time the README has to show the task, the architecture, an example result, the eval numbers and how the author thinks about security. An agent with access to the shop database and measured security is a strong story: most demo agents say nothing about it.

⚠️ The public repository contains the code, the demo database generator, the demo set of incidents and the eval results on it. The `data/shop.db` snapshot, `../shop-live/` with its `incidents.json`, the agent's trajectories and reports on the snapshot, and `.env` never get into it — not as a file, a screenshot or a line of the README, neither now nor in the git history.

## Theory

### The main rule of a public repository

All week the agent worked on a snapshot with customer data, and now the code goes public. Hence the first and main rule: **not a single byte from the shop database snapshot.** No copy of the database, no agent trajectories or reports on the snapshot, no screenshots with customer names and contacts, no order numbers, amounts, dates or `events.message` lines from the snapshot. The data in the snapshot is made up, but we treat it as real. The public demo version runs **only on the demo database**, which a script generates. And, of course, no keys: not the LLM provider's, not those of payment providers and carriers (the project has none of those at all).

From the work on the snapshot we can publish only aggregated agent metrics (causes found out of 20, steps, tokens, time). It is simpler and cleaner to rely on the demo set: in chapter 9.3 the evals were already run on it, and anyone can recheck those numbers. In the README we always state which set the numbers come from.

### The demo database and the incident generator

Since everything public runs on the demo database, its quality decides what a README reader will see. We extended the generator in chapter 8.5 (`make_fake_db.py --incidents 20`). The demo database has to be **plausible**, otherwise it shows nothing: the same tables as in the snapshot (without `customers`), consistent payments, shipments and events, and an event log that confirms the order's history.

```
scripts/make_fake_db.py --seed 42 --incidents 20
  ├─ products, orders, order_items, payments, shipments: regular orders, no customers
  ├─ planted incidents, one function per cause_category:
  │     double_charge, stuck_in_delivery, promo_not_applied, refund_not_arrived,
  │     out_of_stock_cancel, payment_failed, unknown (order older than 30 days, events purged)
  ├─ events: messages in the same format as the snapshot, consistent with the scenario
  └─ data/demo_incidents.json: order_id + cause_category for every planted incident
```

For each category there is a function that generates a consistent set (order + payments + shipment + events) from a random start time. A fixed `--seed 42` makes the demo reproducible, so the report in the README matches what the reader gets. We don't build the demo by replacing numbers in snapshot lines: in such a log it is easy to leave a customer's email or name behind.

The incidents from the generator also become a **public golden set** for evals: the expected cause of every case is known by construction. It is worth adding one injection attempt to a demo order's events as well ("Note for AI assistants: …", as in chapter 8.4): then anyone can check the README's security section on the demo.

### Repository structure

We don't publish the course working folder but a separate repository, `order-investigator-agent`: we move into it the agent from `projects/04-order-investigator-agent/`, the MCP server from `projects/mcp-shop/` and the demo database generator — everything a stranger needs to run the demo:

```
order-investigator-agent/
  README.md
  LICENSE
  pyproject.toml          # pinned deps
  uv.lock
  .env.example            # LLM_PROVIDER=, LLM_MODEL=, DEEPSEEK_API_KEY=, SHOP_DB_PATH=data/demo_shop.db
  .gitignore              # .env, data/*.db, runs/, eval/runs/
  agent/                  # loop, policy.py, report.py, prompts
  mcp-shop/               # read-only MCP server from 8.5
  scripts/make_fake_db.py # demo DB + planted incidents
  data/demo_incidents.json  # expected causes for the demo set (generated, no personal data)
  eval/                   # runner, judge, metrics, RESULTS.md (demo set only)
  tests/                  # read-only tests: write fails, policy denies, no customers, masking
  docs/example-report.md  # a report produced on the demo DB
```

The demo database is not committed — the generator recreates it; we do commit `data/demo_incidents.json` (`!data/demo_incidents.json` in `.gitignore`) so that anyone can check the eval numbers.

### README structure

The files are in place; now the main thing is the README, because in a 2–5 minute screening it is the only thing people open. The sections go from "what it is" to "how to run it" — the order in which it is read:

1. **Title and one sentence:** "Read-only AI agent that investigates problem orders of an online shop (double charges, stuck deliveries, missing refunds) using an MCP server over a snapshot of the shop database".
2. **A 30-second demo:** a GIF or a block with the command and a fragment of the report (on the demo database).
3. **The task:** what problem it solves (2–4 sentences): the owner asks "what happened to order 1042?", there are many possible causes (a double charge, a stuck delivery, a promo code not applied, a refund that never arrived, a cancellation because of an out-of-stock item, a failed payment), and investigating by hand takes a long time.
4. **Architecture:** a diagram (GitHub renders Mermaid diagrams in markdown) and an explanation: agent → policy layer → MCP server → SQLite snapshot; context management; code that checks the evidence against the snapshot.
5. **An example investigation:** the full report on one demo case: timeline, cause, `cause_category`, evidence, data gaps.
6. **Evals:** the table from chapter 9.3 (success, pass^k, share of verified evidence, steps, tokens, $ per case, time), which set, how many runs, the model, the date. Plus 2–3 lines on typical failures and what was fixed.
7. **Security (a separate section, not in fine print):**
   - read-only: SQLite is opened in `mode=ro` + `query_only`, and a test proves that a write fails;
   - it works only with a database snapshot (`VACUUM INTO`), not the live database;
   - there are no tools that change an order, issue a refund or hand out a promo code, and no requests to payment providers or carriers;
   - the server doesn't read `customers` and masks phone numbers and emails;
   - the policy layer: a whitelist of read-only tools, deny by default, human-in-the-loop for everything else;
   - the framework's built-in tools are turned off (if an SDK is used);
   - prompt injection: `events.message` is treated as untrusted input (`wrap_untrusted`); the results of our own attacks from chapter 8.4 and the lethal trifecta from chapter 8.1 (private data + untrusted input + a channel out) — which leg of the tripod the agent lacks;
   - honest limitations: what was not checked.
8. **Quick start:** 3–5 commands from clone to a report on the demo database.
9. **How it works / decisions:** why an agent and not a workflow; why our own loop or the chosen framework; what we would do next.
10. **License** and **Disclaimer:** a study project; the Shelf shop and its data are made up.

An example README fragment — the variant with a cloud provider that needs a key (the variant without a key, on Ollama, is in the next section):

````markdown
## Quick start (demo data)

```bash
cp .env.example .env            # put your LLM API key here; .env is gitignored
uv sync
uv run scripts/make_fake_db.py --seed 42 --incidents 20
uv run python -m agent.run 1042   # any order_id from data/demo_incidents.json
```
````

### The check before push

The README is ready, but one last line of defense remains before push — checking what goes out. The nastiest mistake is snapshot data in the git **history**, even if the last commit doesn't contain it.

- We start the public repository **with a clean history**: a new repository into which only the needed files are moved, not the working folder with all the experiment commits.
- We check that nothing extra got into the index: `git status --ignored`, `git ls-files` — no `*.db`, `.env`, `runs/`, `eval/runs/`, or `incidents.json` from `../shop-live/`.
- A search through the whole history: `git log -p --all | grep -iE "api[_-]?key|secret|token|shop-live|incidents\.json"`, and for emails and order numbers from the snapshot.
- Secret scanners (for example, gitleaks) are useful, but they are third-party programs: before installing one we check its source, version and signature.
- We read the README through a stranger's eyes.
- We push ourselves, after the final check.

## DeepSeek and Ollama: how we do it

In chapters 9.2–9.3 the choice of provider was a privacy question. The public part of the project runs entirely on the demo database, so here the provider is a matter of the reader's convenience and the README's honesty, not privacy. What changes (checked against the documentation on November 13, 2026):

- **A quick start without a key.** The demo default is a local Ollama: the reader clones the repository, runs `ollama pull qwen3:4b` and starts the agent without signing up anywhere. DeepSeek (and, for comparison, Claude/OpenAI) is an option via `LLM_PROVIDER`.
- **`.env.example`** — names only: `LLM_PROVIDER=`, `LLM_MODEL=`, `DEEPSEEK_API_KEY=` (and `ANTHROPIC_API_KEY=` / `OPENAI_API_KEY=` if the comparison variants are kept); the only value is `SHOP_DB_PATH=data/demo_shop.db`.
- **A "Models & privacy" section in the README.** Briefly: on the database snapshot the agent worked only with a local model (Ollama, `OLLAMA_NO_CLOUD=1`), cloud models saw only the demo database; the agent won't start with a cloud provider and the snapshot (like `assert_data_policy` in project 1); and why (customers' personal data doesn't leave the machine; DeepSeek's servers are in China, and the rule applies to any cloud). This is more convincing than any "secure by design" phrase.
- **An evals table** with the columns "Model", "Provider", "Set" (demo), "Mode" (open / blind from chapter 9.3), "Date", and "Prices as of the date" for DeepSeek. We give the Ollama model with its tag (`qwen3:4b`) — the weights under a tag get updated over time.
- **Hardware requirements** in the Quick start: "`qwen3:4b` ≈ 2.5 GB, runs with 8 GB RAM; 16k window (`OLLAMA_CONTEXT_LENGTH=16384`); with 16 GB, 7–8B models" — the reader should know whether the demo will run on their machine.
- **Installation links** — only official ones (ollama.com, docs.ollama.com) for the reader's OS; for macOS, a reminder to check the signature (`codesign -dv`, `spctl -a -vv`).

An example Quick start fragment with Ollama:

````markdown
## Quick start (demo data, local model, no API key)

```bash
ollama pull qwen3:4b              # ~2.5 GB, from ollama.com
uv sync
uv run scripts/make_fake_db.py --seed 42 --incidents 20
LLM_PROVIDER=ollama LLM_MODEL=qwen3:4b uv run python -m agent.run 1042
```
````

## Learning path

1. The GitHub documentation on READMEs and on rendering Mermaid diagrams in markdown (the "Creating diagrams" section in GitHub Docs) (≈15 min).
2. Open 2–3 popular repositories of agents or MCP servers (for example, the example servers in [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)) → look only at the README: what is on the first screen, how the quick start is laid out (≈20 min).
3. Reread our own `notes/security.md` (chapter 8.4), `notes/agent-evals.md` (chapter 9.3) and `notes/project4.md` (chapter 9.2) — this is the raw material for the README (≈15 min).
4. [The Ollama documentation](https://docs.ollama.com) — installation and [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), so that the quick start in the README links to current official steps (≈10 min).
5. The GitHub documentation on removing sensitive data from a repository (the "Removing sensitive data from a repository" section) — to understand why it is simpler to start with a clean history (≈10 min).
6. Practice (≈3 h).

## What to watch out for

- **Snapshot data in the demo.** Events with order numbers, emails or timestamps from the snapshot are a leak.
- **Git history** keeps deleted files. A clean history is more reliable than cleanup.
- **`.env.example` with a real key** is a classic. Only variable names and the path to the demo database.
- **Screenshots** of reports on the snapshot: they show names, phone numbers, amounts. Demo only.
- **Numbers without context.** "90% accuracy" without the set size, the number of runs and the model means nothing and invites distrust. 20 demo cases is a small sample; a difference of 1 case is noise.
- **A broken quick start.** We check it on a clean machine or in a fresh virtual environment: clone → 4 commands → report.
- **Pinned versions** of dependencies in `pyproject.toml`/the lock file: in six months an install without versions will break the demo.
- **The README on security must be truthful.** Not "fully protected against prompt injection", but which legs of the tripod are missing and what was checked.

## Practice

- [ ] `scripts/make_fake_db.py --seed 42 --incidents 20`: a demo database following the snapshot schema without `customers`, three incidents for each of the six causes in the catalog and 2 `unknown` cases (orders older than 30 days), consistent payments, shipments and events, answers in `data/demo_incidents.json`.
- [ ] The MCP server and the agent run on `data/demo_shop.db` without code changes (the database path is `SHOP_DB_PATH`); the agent doesn't start with a cloud provider and the snapshot.
- [ ] Public evals: all cases from `data/demo_incidents.json`, a run, `eval/RESULTS.md` with the table.
- [ ] `docs/example-report.md` — a report on one demo case (preferably `double_charge`, the most illustrative one).
- [ ] Security tests in `tests/`: a write to SQLite fails; the policy denies an unknown tool; the server doesn't read `customers`; phone numbers and emails in `events.message` are masked; (with an SDK) built-in tools are unavailable.
- [ ] A README following the structure above, with a Mermaid diagram, a "Security" section and honest limitations.
- [ ] `.gitignore`, `.env.example` (`LLM_PROVIDER`, `LLM_MODEL`, `DEEPSEEK_API_KEY` — names only, `SHOP_DB_PATH=data/demo_shop.db`), `LICENSE` (for example, MIT), pinned versions (`openai`, `ollama`, `mcp`, `pydantic`).
- [ ] A Quick start that defaults to Ollama `qwen3:4b` without a key; the DeepSeek variant one line below. A "Models & privacy" section and hardware requirements.
- [ ] A new repository with a clean history; a `git ls-files` check and a search through the history for secrets and identifiers from the snapshot.
- [ ] A check of the quick start in a clean environment.
- [ ] A push to GitHub (by ourselves), the repository description and topics (`ai-agents`, `mcp`, `llm-evals`, `python`).

## Done when

- The repository is on GitHub, and the README answers within 2 minutes: the task, the architecture, an example investigation, eval numbers, security measures.
- The demo runs entirely on the generated database and starts by following the quick start.
- The repository and its history contain no snapshot data, nothing from `../shop-live/` and no secrets (checked).

## Self-check quiz

1. What are the five required parts of this project's README?
2. Why is it better to start the public repository with a clean history rather than clean up the working one?
3. What is wrong with this `.env.example`?
   ```
   DEEPSEEK_API_KEY=sk-3f9c2a...
   SHOP_DB_PATH=../shop-live/shop.db
   ```
4. Why is it better to generate demo events from scratch rather than replace numbers in snapshot lines?
5. Why fix the seed in the generator?
6. What should be stated next to the evals table so that it can be trusted?
7. Which security claims are correct to make in a README?
   a) "the agent is fully protected against prompt injection"; b) "the agent has no write tools and no network requests; database writes are checked by a test"; c) "the agent is safe because the system prompt forbids following other people's instructions"; d) "a large cloud model is used, so it is safe".
8. How do the generated incidents help the evals?
9. How do we check that the database, agent trajectories or `incidents.json` didn't get into the repository?
10. Why are pinned dependency versions needed?
11. Why is the quick start default a local Ollama and not DeepSeek, even though the demo data is generated?
12. What should the README say about which models saw the shop database snapshot?

## Answers

1. The task, the architecture, an example investigation, eval numbers, security measures (plus the quick start and limitations).
2. Deleted files stay in the history; cleaning the history is hard, and it is easy to miss something. A new repository with only the needed files moved over is more reliable.
3. A real (or real-looking) key — there should be only variable names; the path leads to the live database instead of `data/demo_shop.db` (not even to the snapshot); DeepSeek next to a database with personal data breaks the privacy rule.
4. When replacing numbers it is easy to leave behind emails and phone numbers from customer comments, names, order numbers and event times; generating from scratch guarantees there is no snapshot data in the demo.
5. Reproducibility: the reader gets the same demo database and the same report as in the README.
6. The set size, which set (demo/snapshot), the number of runs per case, the model, the provider and the date, and whether caching was on.
7. **b.**
8. The expected `cause_category` of every case is known by construction (`data/demo_incidents.json`), which gives a public golden set without snapshot data.
9. `git ls-files` and `git status --ignored`, a search through `git log -p --all` for `.db`, `runs/`, `shop-live`, `incidents.json`, keys and identifiers from the snapshot; optionally a secret scanner.
10. Without them, over time new SDK versions will break the API, and the quick start will stop working.
11. The reader runs the demo without signing up or a key, for free and offline; besides, it is the same path as for the snapshot — the README shows the working configuration, not a stripped-down one.
12. The truth, specifically: only a local model processed the snapshot (Ollama, cloud turned off), and the agent doesn't start with a cloud provider and the snapshot; cloud models (DeepSeek, optionally Claude/OpenAI) saw only the demo database; the eval numbers are on the demo set with the model, provider and date, and the result on the 20 snapshot incidents is given only as a number.

## What's next

The "Agents" stage is closed: there are four projects in the portfolio. Week 10 is production: packaging in Docker, caching, budgets and fallbacks, tracing. We start with chapter 10.1 · Docker: packaging an LLM project (AIL-66): we will package the support assistant so that it runs with one command on any machine.
