# 1.2 · A study repository: git, notes/, structure  (AIL-56)

> **Week 1** · Preparation · ⏱ ~1.5 h · Practice

<!-- description: A study repository that becomes a portfolio: monorepo structure, .gitignore for Python and AI projects, .env.example without secrets, private GitHub. -->
<!-- source-sha256: dc6ec7c92608 -->

## Why an AI engineer needs this

By the end of the course this repository becomes a portfolio: projects, eval tables and notes that show how we think. Employers look at GitHub before the résumé, and a clean commit history with a clear structure says more than the line "I know RAG". AI projects also carry plenty of secrets (API keys) and large data (databases, embeddings — the vectors a model turns texts into, week 4), so the habit of not committing anything extra is best built on day one. In this chapter we turn the exercise folder from chapter 1.1 into a git repository: we agree on a structure, set up what git should ignore, and push the first commit to a private GitHub repository.

## Theory

### 1. One repository for all the study — a monorepo

The options: one repository per project or one for everything. For study, one is more convenient (`ai-engineering-journey`), where every large project is a separate folder with its own environment (an isolated set of the project's libraries; how uv creates one is covered in chapter 1.3). Later the best projects can be moved into separate public repositories for the portfolio (or this one can be made public after checking its history for secrets and personal data).

```
ai-engineering-journey/
├── README.md                 # the plan + progress log
├── .gitignore
├── .env.example              # variable NAMES only, no values
├── notes/
│   ├── python-cheatsheet.md  # AIL-1
│   ├── llm-basics.md         # AIL-3
│   └── week-01.md            # daily notes, Friday review
├── exercises/
│   ├── week-01/
│   │   ├── pricing.py
│   │   ├── orders.csv
│   │   └── stats.py
│   └── week-02/
└── projects/
    ├── 01-shop-analyst-bot/  # own pyproject.toml, own README
    ├── 02-support-kb-rag/
    └── 04-order-investigator-agent/
```

Principles:
- **`notes/`** — notes in our own words. They are not clutter: these are exactly what we will reread before an interview.
- **`exercises/week-NN/`** — short exercises, possibly with one shared environment per week or for the whole `exercises/`.
- **`projects/NN-name/`** — each project has its own `pyproject.toml` (the description of the project and its dependencies), `uv.lock` (exact library versions), `README.md`, `tests/`. The number in the name keeps the order.

The structure is ready; next we decide what in these folders git should not store.

### 2. What `.gitignore` is and what it doesn't do

`.gitignore` is a list of path patterns that git does not offer to add. The syntax:

```
.venv/          # directory anywhere
*.db            # by extension, anywhere
/build          # only at repo root
!keep.db        # exception from a previous rule
```

Important: **`.gitignore` has no effect on files that are already tracked.** If `.env` is already committed, adding it to `.gitignore` removes nothing from the history. It takes `git rm --cached .env` (stop tracking; the file stays on disk), and if it contained a key — **revoke the key** (details in AIL-3), because it hasn't gone anywhere from the history.

To check that a file is ignored and by which rule: `git check-ignore -v .env`.

### 3. What to ignore in a Python/AI repository

With the syntax in hand, let's build the list. In a Python/AI project the extra stuff comes in three kinds: what is generated automatically (environment, caches), what is dangerous (secrets, data), and what is simply big (databases, model weights):

| Category | Patterns | Why |
|---|---|---|
| Environment | `.venv/`, `venv/` | created by `uv sync`, like `node_modules` in JavaScript |
| Python caches | `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/` | generated automatically |
| Secrets | `.env`, `.env.*`, but `!.env.example` | API keys |
| Databases | `*.db`, `*.sqlite`, `*.sqlite3`, `*.db-wal`, `*.db-shm` | snapshots of the shop database, vector indexes; WAL files next to the database |
| Data | `data/raw/`, `*.parquet` (case by case) | large files, may be personal |
| Notebooks | `.ipynb_checkpoints/` | Jupyter autosaves (AIL-57) |
| OS/IDE | `.DS_Store`, `.idea/` | macOS and IDE clutter |

`uv.lock` **must be committed** — it is a lock file, like `package-lock.json` or `go.sum`: it makes the environment reproducible. `.vscode/` is a matter of taste: a `settings.json` with the interpreter choice is worth keeping, personal settings are not.

GitHub's ready-made template: [Python.gitignore](https://github.com/github/gitignore/blob/main/Python.gitignore). We can take it and append our own block at the bottom (secrets, databases).

### 4. `.env.example` — a contract without secrets

A program reads API keys and settings that differ from machine to machine from environment variables. To avoid setting them by hand in every terminal, they are kept in a `.env` file at the project root — `NAME=value` lines that a library loads when the program starts (exactly how — in chapter 1.5). `.env` stays out of git (the rule above), but then a colleague won't know which variables are needed. `.env.example` solves this problem:

```
# .env.example — copy to .env and fill in
# main: DeepSeek (cloud, cheap) + Ollama (local, free)
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=
# optional, for comparison
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

Git holds only the list of variable names (and non-secret defaults such as the address of the local Ollama). A colleague (or we ourselves six months later) clones the repository, copies the file to `.env` and fills in their own values. The keys themselves appear in chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3).

### 5. A special case: the shop's data

In the course projects (the analyst bot in week 3, the MCP server in week 9) we work with the database of the study online shop Shelf: orders, products, payments, customers with names and phone numbers. It is SQLite — a database in a single `.db` file. We generate the database in chapter 3.1 and put it one level above the repository, in `../shop-live/`; it plays the role of production (the one the "real" shop works with). The data is made up, but we treat it as real — this habit will be needed at work. The rules from day one:
- the study repository **never receives** the "production" database from `../shop-live/`, its snapshots, or exports of orders and customers;
- for work we take a snapshot of the database with `VACUUM INTO` — an SQLite command that writes a consistent copy of the database into a new file. A plain `cp` won't do: the database runs in WAL mode (fresh changes are first written to a neighboring `-wal` file and only later moved into the main one), and a copy of one file may turn out inconsistent. The snapshot lives **outside** the repository or in an ignored folder (`data/`);
- for a public portfolio — only **made-up** demo data without personal data, generated by a script (git holds the script, not the database).

If we have our own data and the right to use it, we can work with it instead of the Shelf shop database — the rules are the same. The `*.db` rule in `.gitignore` is a safety net, not a replacement for this discipline.

### 6. Commits that are pleasant to read

Once it's clear what stays out of the repository, what remains is to agree on how to record work in it.

- One commit — one logical unit: "week-01: pricing and csv stats exercises", not "update".
- We commit every day at the end of a session; on Friday — a week review in `notes/week-NN.md`.
- Before every commit: `git status` and `git diff --staged` — a look at exactly what is going out. These are the 10 seconds that catch a stray `.env` or a database dump.

### 7. A private remote repository

It can be created in the GitHub web interface (New repository → Private) or with the [GitHub CLI](https://cli.github.com): `gh repo create ai-engineering-journey --private --source=. --remote=origin`. Branches aren't required in a study repository — we work in `main`; a branch comes in handy for experiments that may not take off.

## DeepSeek and Ollama: how we do it

We study on DeepSeek (cloud, cheap, an OpenAI-compatible API, servers in China) and Ollama (local models); Claude and OpenAI are for comparison. For the repository this changes three small things:

- **`.env.example`** lists `DEEPSEEK_API_KEY` and the model names as the main ones, the Anthropic/OpenAI keys as optional (the template above). Model names are kept in the environment, not in code: DeepSeek's change.
- **Model weights stay out of the repository.** Weights are files with the model's parameters, gigabytes of numbers. Ollama stores models in `~/.ollama`, outside the repository, and we leave it that way. But in week 11 (LoRA) our own weight and adapter files appear: `*.gguf`, `*.safetensors` and the `models/` folder are worth adding to the ignore list in advance — those are gigabytes.
- **The data boundary runs through the notes too.** DeepSeek's answers to study questions can be saved to `notes/`. But anything involving the shop customers' personal data (and, at work, work code and anything that can't be shown to outsiders) goes only through the local Ollama — never to any cloud model. The results of such runs (even "just model output") go into an ignored folder, because the model retells names, phone numbers and amounts.

| | Claude / OpenAI | DeepSeek | Ollama |
|---|---|---|---|
| Secret in `.env` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | `DEEPSEEK_API_KEY` | none (the `localhost` address is not a secret) |
| What may end up in git by mistake | the key | the key | model weights, output on real data |
| What to ignore | `.env` | `.env` | `*.gguf`, `*.safetensors`, `models/`, `outputs/` with real data |

## Learning path

1. If git is familiar, we skip this. Otherwise we open [Pro Git](https://git-scm.com/book/en/v2) → chapter 2 "Git Basics" (sections 2.1–2.5: recording changes, ignoring files, viewing the history, remote repositories) (≈40 min). The parts about `.gitignore` and `git rm --cached` matter most.
2. We open the [Python.gitignore template](https://github.com/github/gitignore/blob/main/Python.gitignore) → skim it (≈5 min): `.venv`, `__pycache__`, `.env` are already there, but databases are not.
3. (Optional) Pro Git, chapter 3 "Git Branching", sections 3.1–3.2 (≈20 min) — useful for experiments in week 8.
4. [Ollama on macOS](https://docs.ollama.com/macos) → the section on file locations (≈5 min; the documentation has the same sections for Linux and Windows). What we take from it: models and logs live in `~/.ollama`, outside the repository; models weigh from a gigabyte to hundreds of gigabytes. The installation itself happens in chapter 1.5 (AIL-3).

## What to watch out for

- **`.gitignore` first, then `git add`.** If `git add .` runs before `.gitignore` exists, `.venv` and everything else ends up in the index.
- **`git add .` is a dangerous habit** in a repository with data. It's worth adding deliberately, or at least looking at `git status` before committing.
- **A secret that is already committed isn't fixed by a new commit.** The history keeps everything; even a rewritten history may have already gone into a fork or a cache. The only reliable measure is to revoke the key.
- **Large files.** GitHub rejects files larger than 100 MB, and even smaller ones bloat the history forever. Datasets and indexes go into the ignore list; the README gets the command to recreate them.
- **Notebook output** may contain data and even the values of environment variables if they were printed. More on this in AIL-57.
- **Personal data in notes.** If the repository becomes public, `notes/` must not contain real amounts, customer names, phone numbers or account names.

## Practice

- [ ] We initialize git in the folder from chapter 1.1 (if it doesn't exist yet, the command creates it):
  ```bash
  mkdir -p ~/ai-engineering-journey && cd $_   # $_ = last argument of the previous command
  git init -b main
  mkdir -p notes exercises/week-01 projects
  ```
- [ ] We create `.gitignore`: take the contents of Python.gitignore and append our own block at the bottom:
  ```
  # --- secrets ---
  .env
  .env.*
  !.env.example

  # --- databases (never commit shop data or its copies) ---
  *.db
  *.sqlite
  *.sqlite3
  *.db-wal
  *.db-shm

  # --- model weights and outputs on real data ---
  *.gguf
  *.safetensors
  models/
  outputs/

  # --- notebooks, OS ---
  .ipynb_checkpoints/
  .DS_Store
  ```
- [ ] We create `.env.example` from the template in the theory: the main `DEEPSEEK_API_KEY=`, `DEEPSEEK_MODEL=`, `OLLAMA_BASE_URL=http://localhost:11434/v1`, `OLLAMA_MODEL=`; the optional (for comparison) `ANTHROPIC_API_KEY=` and `OPENAI_API_KEY=`.
- [ ] We move the plan over: in `README.md` at the repository root we write out the course weeks (following the book's table of contents) and add a "Progress" section at the top — a list of weeks with checkboxes.
- [ ] We check that the cheat sheet `notes/python-cheatsheet.md` and the exercises from AIL-1 are in `notes/` and `exercises/week-01/`; if they were created elsewhere, we move them.
- [ ] **Ignore check** — we create traps and make sure git doesn't see them:
  ```bash
  echo "DEEPSEEK_API_KEY=fake" > .env
  touch test.db model.gguf
  git status              # .env, test.db, model.gguf must NOT be listed
  git check-ignore -v .env test.db model.gguf
  rm test.db model.gguf
  ```
- [ ] The first commit: `git add .gitignore .env.example README.md notes exercises`, then a look at `git status` and `git diff --staged --stat`, then `git commit -m "init: structure, gitignore, plan"`.
- [ ] We create a **private** repository on GitHub, attach `origin`, push `main`. We check in the web interface that `.env` isn't there.
- [ ] We start `notes/week-01.md` with a daily template: "Done / Understood / Didn't work / Questions".

## Done when

- The private repository `ai-engineering-journey` exists on GitHub, and the first commit is pushed.
- The `notes/`, `exercises/week-01/`, `projects/` structure is in place, with the `README.md` plan at the root.
- `git status` doesn't show `.env` and `*.db` when they are in the folder.

## Self-check quiz

1. A `.env` with a key was committed, then `.env` was added to `.gitignore` and committed again. Is the key safe?
2. Which command stops tracking a file without deleting it from disk?
   a) `git rm .env` b) `git rm --cached .env` c) `git reset .env` d) `git clean .env`
3. Should `uv.lock` be committed? Why?
4. Why `!.env.example` after `.env.*`?
5. Why does `.gitignore` contain `*.db-wal` and `*.db-shm`?
6. What is wrong with this sequence of commands?
   ```bash
   git init
   git add .
   git commit -m "init"
   echo ".venv/" > .gitignore
   ```
7. How to find out exactly which rule ignores a file?
8. Why should a snapshot of the shop database be taken with `VACUUM INTO` rather than `cp`?
9. What data can go into the public version of the shop analyst project?
   a) a copy of the "production" database from `../shop-live/` b) the snapshot `data/shop.db` c) generated made-up orders d) an export of orders without names and phone numbers
10. What to do with a 300 MB dataset the project needs?
11. Which of these lines in `.env.example` are fine and which are not: `DEEPSEEK_API_KEY=`, `OLLAMA_BASE_URL=http://localhost:11434/v1`, `DEEPSEEK_API_KEY=sk-...`? Why does Ollama have no key?
12. A local Ollama model was run over a snapshot of the shop database, and its answers were saved to `notes/orders-summary.md`. The data was never sent anywhere. Can this be committed?

## Answers

1. No. The key remains in the history of the first commit (and, if there was a push, on GitHub). The key must be revoked immediately in the provider's console and a new one issued.
2. **b.** `--cached` removes the file from the index; `git rm` without the flag also deletes it from disk.
3. Yes. It is a lock file that pins the exact versions of all dependencies (like `package-lock.json` or `go.sum`); without it the environment on our machine and on CI may differ.
4. The `.env.*` rule would also catch `.env.example`; `!` makes an exception so that the template with the variable names gets into git.
5. SQLite in WAL mode keeps journal and shared-memory files next to the database; they may hold fresh data, and they don't belong in git, just like the database itself.
6. `.gitignore` is created after `git add .`: `.venv` and everything else, including possible secrets, are already in the first commit. `.gitignore` first, then `add`.
7. `git check-ignore -v <path>` — shows the file and the rule's line.
8. The database is in WAL mode: part of the data may sit in `-wal`, and simply copying the file while the database is in use gives an inconsistent copy. `VACUUM INTO` makes a consistent snapshot by means of SQLite itself.
9. **c.** Only made-up data. Even a snapshot and an "anonymized" export reveal real activity (amounts, order contents, cities) and aren't needed for a demo.
10. Don't commit it: put it into the ignored `data/` folder and describe in the README where to download it from or which script generates it.
11. An empty `DEEPSEEK_API_KEY=` and the local Ollama address are fine: these are names and a non-secret default. A line with a real key is a leak, and the key must be revoked. The local Ollama has no authentication: it listens only on `localhost`; the `openai` SDK requires some string in `api_key`, but Ollama ignores it.
12. No. A local model keeps the data from being sent out, but its answer retells orders and customers' personal data; it must not end up in git (and later, possibly, in a public repository). Such outputs go into an ignored folder (`outputs/`).

## What's next

Chapter 1.3 · Python: uv, async, Pydantic (AIL-2): the first real Python project with an environment, a lock file, tests and a linter appears in `exercises/`. Then chapter 1.4 · Jupyter notebooks in VS Code (AIL-57) connects Jupyter to it, and in chapter 1.5 (AIL-3) we fill `.env` with the DeepSeek key and install Ollama.
