# 1.4 · Jupyter notebooks in VS Code  (AIL-57)

> **Week 1** · Preparation · ⏱ ~1.5 h · Practice

<!-- description: Jupyter notebooks in VS Code: a kernel from the uv environment, the hidden state trap, async and autoreload, when to move code into modules, notebooks in git. -->
<!-- source-sha256: 09efbdb118d6 -->

## Why an AI engineer needs this

Almost all courses, provider cookbooks (Anthropic, OpenAI), LlamaIndex and LangGraph examples and articles about evals are published as notebooks. A notebook is the best tool for trying a prompt, looking at embeddings, or going through eval errors in a table. But production code doesn't live in a notebook, and knowing when to move code into a module is also a skill that shows in a portfolio.

In this chapter we connect a notebook to the `learn-python` project from chapter 1.3: we look at how a notebook works and where it lets us down, run it on the uv environment, and then decide what to move from the notebook into modules and how to keep extra stuff out of git.

## Theory

### 1. What a notebook is

A notebook (`.ipynb`) is a JSON file with a list of **cells**: code and Markdown. Code is executed by the **kernel**, a separate Python process that lives until it is restarted. All cells share this process's namespace.

```
 VS Code (UI)                       Kernel (python from .venv)
┌───────────────────────┐   run    ┌───────────────────────────┐
│ [1] import httpx      │ ───────▶ │ globals: httpx, df, orders│
│ [2] orders = load()   │ ◀─────── │ state survives between    │
│ [3] orders[:5]        │  output  │ cells until restart       │
└───────────────────────┘          └───────────────────────────┘
```

The closest analogy is the interactive console (REPL) of Python or any other language, with the input split into saved blocks and the output (tables, charts, HTML) saved next to the code.

### 2. The main feature and the main trap: state

Cells can be run in any order and any number of times. The number `[5]` on the left is the execution order, not the position. Hence the classic bugs:
- we deleted the cell that defined a variable, but it is still in the kernel's memory and the notebook "works"; after a restart it breaks;
- we changed a function above but didn't rerun its cell, so the old version is called below;
- a cell with `x = x + 1` gives a new result every time it is rerun.

The rule: before considering a notebook done or committing it, we do **Restart Kernel → Run All**. If it runs top to bottom, the notebook is honest.

For the kernel to start at all and see the project's packages, it has to be chosen correctly; that's the next step.

### 3. A kernel from the uv environment

A kernel is a specific Python interpreter. For the notebook to see the project's packages, it must run on the project's `.venv`, and that environment must have the `ipykernel` package (VS Code talks to the interpreter through it):

```bash
cd exercises/learn-python
uv add --dev ipykernel
```

Then in VS Code: we open the `.ipynb` → the **Select Kernel** button at the top right → Python Environments → the project's `.venv`. If `.venv` isn't listed, we first run "Python: Select Interpreter" for the workspace folder or open VS Code in the project folder itself.

Installing packages with `%pip install` in a cell is unnecessary: uv environments are created without pip by default, and an installation that bypasses `uv add` won't make it into `pyproject.toml` and the lock file. A new dependency means `uv add x` in the terminal, then **Restart Kernel**.

### 4. What VS Code can do with notebooks

The kernel is connected; next come the working techniques we will need in the practice:

- Run a cell: Shift+Enter (and move to the next one), Ctrl+Enter (stay).
- Switching the cell type: in command mode (Esc) `M` is Markdown, `Y` is code; `A`/`B` insert above/below; `DD` deletes.
- **Jupyter Variables** (the Variables button on the notebook toolbar): a list of the kernel's variables with types and sizes; a DataFrame (a table from the pandas library) opens in the Data Viewer.
- **Debugging** a cell: Debug Cell in the menu next to the run button; breakpoints work as in a regular file.
- **Restart / Interrupt** kernel: buttons on the toolbar. Interrupt is for when a cell hangs on a network request.
- **Interactive Window**: in a regular `.py` file, cells can be marked with a `# %%` comment and run one by one. The code stays a normal module that diffs cleanly in git, a good compromise between a notebook and a script.

### 5. Async in a notebook

The Jupyter kernel is IPython, an extended interactive Python shell. It supports `await` at the top level of a cell, because the kernel is already running its own event loop:

```python
# cell — works in Jupyter, would be a SyntaxError in a plain .py
import httpx
async with httpx.AsyncClient() as client:
    r = await client.get("https://httpbin.org/get")
r.status_code
```

A consequence from AIL-2: `asyncio.run(main())` in a cell fails with `RuntimeError` (the loop is already running), so we write `await main()`.

### 6. Importing our own code and autoreload

A notebook is handy for experiments, but functions written right in cells can't be tested or reused. So we keep the logic in `.py` modules, and in the notebook we only call it and look at the results. To have module edits picked up without restarting the kernel:

```python
%load_ext autoreload
%autoreload 2
from models import OrderItem      # module in the same project
```

`%` commands are IPython "magics"; plain Python doesn't have them. Useful ones: `%time` / `%timeit` (timing), `%env` (better not used for keys, see below).

### 7. Notebook or script

The split "logic in a module, experiment in a notebook" leads to a general rule of choice:

| Notebook | Script / module |
|---|---|
| exploration, "what if" | code that runs regularly |
| prompt experiments, looking at model responses | a bot, a server, an MCP server |
| charts, eval result tables | tests, CI, cron |
| an explanation for a reader (tutorial, report) | anything other files import |
| once, by hand | needs review in a git diff |

The typical path in an AI project: an experiment in a notebook → the function moves into a module with a test → the notebook only imports it. For evals (weeks 6–8) a notebook is a convenient "showcase" of results, while the run itself is a script.

### 8. Notebooks and git

One question remains, and it comes up with the very first notebook commit. An `.ipynb` is JSON that stores the cells' **outputs** and execution counters. The consequences:
- diffs are noisy: a restart changes every `execution_count`;
- the output may contain anything: printed orders with customer data, an API response with personal data, a key if a cell had `print(os.environ)`. All of it ends up in git;
- images in the output bloat the repository.

Solutions: before committing, Clear All Outputs (if the output isn't needed for a reader), or the [nbstripout](https://github.com/kynan/nbstripout) tool, which strips output automatically on commit (before installing it, it is worth checking like any third-party package). Secrets in a notebook are read only from the environment (`os.environ["DEEPSEEK_API_KEY"]` after loading `.env` with `load_dotenv()`, chapter 1.5), never printed and never typed into a cell. The `.ipynb_checkpoints/` folder is already in `.gitignore` from AIL-56.

## DeepSeek and Ollama: how we do it

In this book the models in a notebook are DeepSeek (cloud, cheap, an OpenAI-compatible API, servers in China) and a local Ollama; Claude and OpenAI are for comparison. Jupyter itself doesn't depend on the provider, and little changes (the key and the installation are in chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3); checked against the documentation on November 13, 2026):

- **Clients in a notebook are async**, since top-level `await` works: `AsyncOpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])` for DeepSeek and `AsyncOpenAI(base_url="http://localhost:11434/v1", api_key="ollama")` for Ollama (Ollama ignores the key, but the SDK requires a string). We create them in one cell at the top and reuse them.
- **A notebook's output is data too.** A local model's answer about orders and customers never went over the network, but it is saved in the `.ipynb` and ends up in git unless the output is cleared. Notebooks with customer data live outside the repository or in an ignored folder.
- **Choosing a model in a notebook = choosing where the data goes.** In one session it is easy to pass a DataFrame with orders and customer data to the DeepSeek client instead of the local one by mistake. We keep such data in a separate notebook where only the Ollama client is created.
- **Rerunning a cell** costs pennies with DeepSeek and nothing with Ollama, but minutes of waiting on a large model. The advice "request and analysis in separate cells" still holds.
- **DeepSeek has thinking on by default**: the response contains the reasoning in the `reasoning_content` field next to `content`. In a notebook it is convenient to look at, but printing it in full into committed output isn't worth it: it is long.

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Async client in a cell | `AsyncAnthropic()` | `AsyncOpenAI()` | `AsyncOpenAI(base_url=...)` | `AsyncOpenAI(base_url=...)` or `ollama.AsyncClient()` |
| What goes in `.env` | key | key | key | only the address and the model name |
| Rerunning a cell | paid | paid | very cheap | free, but slow |
| Customer data in a cell | **never** | **never** | **never** | yes, but don't commit the output |

**For this chapter's practice** no models are needed; if Ollama is already installed, the bonus below runs on it.

## Learning path

1. We open [Jupyter Notebooks in VS Code](https://code.visualstudio.com/docs/datascience/jupyter-notebooks) → the sections on creating a notebook, choosing a kernel, running cells, Variables Explorer and Data Viewer, debugging (≈30 min). Special attention goes to choosing the kernel and the Restart/Interrupt buttons.
2. We open the uv guide [Using uv with Jupyter](https://docs.astral.sh/uv/guides/integration/jupyter/) → the section on VS Code and on installing `ipykernel` into the project (≈10 min). What we take from it: why `%pip` behaves differently in a uv environment.
3. (Optional) [Python Interactive window](https://code.visualstudio.com/docs/python/jupyter-support-py) → about `# %%` cells in `.py` (≈10 min).
4. If broader context about the ecosystem is needed: [jupyter.org](https://jupyter.org) (≈5 min), only to understand the difference between Notebook / JupyterLab / kernel.
5. (≈10 min, for the bonus) [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility): which `base_url`, and that the key isn't checked; [DeepSeek Quick Start](https://api-docs.deepseek.com): `base_url` and an example with `openai`. The takeaway: in a notebook only the client's address and key change.

## What to watch out for

- **Hidden state.** A notebook that works only with a particular cell order is not a result. Restart + Run All before committing.
- **The wrong kernel.** `ModuleNotFoundError: No module named 'pydantic'` in a notebook while `uv run` works almost always means the system kernel is selected, not `.venv`.
- **`%pip install` in a cell** installs a package bypassing the lock file (or doesn't work at all in a uv environment). Only `uv add` + Restart Kernel.
- **Secrets and data in the output.** We don't print keys or environment variables; we don't commit outputs with customer and order data. For experiments with the shop database, only a copy made with `VACUUM INTO` outside the repository, read-only. The data in the study database is made up, but we treat it as real; this habit will be needed at work.
- **Long cells with network calls.** Rerunning a cell with 100 LLM requests means paying again. We cache the results in a variable or a file and split "request" and "analysis" into separate cells.
- **A notebook as production.** If code from a notebook has to run on a schedule or from a bot, it belongs in a module with tests.

## Practice

- [ ] We install the **Jupyter** extension in VS Code (it usually comes with the Python extension; we check that it is from Microsoft).
- [ ] In `exercises/learn-python/` we run `uv add --dev ipykernel`.
- [ ] We create `exercises/learn-python/explore.ipynb` and select the `.venv` kernel. The first cell:
  ```python
  import sys
  sys.executable   # must point into .../learn-python/.venv/
  ```
- [ ] We repeat the exercise from AIL-2 interactively:
  - a cell with `%load_ext autoreload` / `%autoreload 2` and an import of `OrderItem` from `models.py`;
  - a cell that reads `order_items.jsonl` and collects valid order items into a list and invalid ones into a list of errors;
  - a Markdown cell with conclusions: which errors were found;
  - a cell with `OrderItem.model_json_schema()`.
- [ ] We change a validator in `models.py` (for example, our own rule for the quantity) and, **without restarting the kernel**, rerun the validation cell: the change should be picked up thanks to autoreload.
- [ ] An async cell: `from fetch_compare import parallel` and `await parallel()` right in the cell (if `asyncio.run(...)` in the file sits under `if __name__ == "__main__":`, the import won't run it, AIL-1); then we make sure that `asyncio.run(parallel())` fails here and read the error.
- [ ] We open Jupyter Variables and find the list of items; we set a breakpoint and run Debug Cell.
- [ ] We set up the state trap: define `fee = 0.025`, use it below, delete the cell with the definition. The notebook keeps working. Restart Kernel → Run All, and we see `NameError`. We fix it.
- [ ] We create `scratch.py` with two `# %%` cells and run them in the Interactive Window.
- [ ] *(Bonus, after chapter 1.5, once Ollama is installed)* A cell with `AsyncOpenAI(base_url="http://localhost:11434/v1", api_key="ollama")` and an `await` of one call to the local model: "Explain in one sentence what average order value is." Below it, a separate cell that only prints the saved answer and `usage` (how many tokens went into the request and the response; tokens are covered in chapter 1.5). We rerun the second cell several times: the request isn't repeated.
- [ ] *(For comparison, optional)* The same question to DeepSeek in a neighboring cell; we look at `reasoning_content` and compare `completion_tokens` with the local model. Only the study question, no shop data.
- [ ] Before committing: Restart + Run All, Clear All Outputs (or we keep the output if it contains only made-up data), a look at `git diff --stat`.

## Done when

- The notebook opens in VS Code and runs on the kernel from the project's `.venv` (`sys.executable` confirms it).
- The exercise from AIL-2 is repeated in the notebook and passes Restart + Run All.
- We can explain when to write a notebook and when a module, and why `asyncio.run` doesn't work in a cell.

## Self-check quiz

1. What is a notebook kernel, and how long does its state live?
2. The number `[7]` to the left of a cell means:
   a) the cell's position in the file b) the execution order in the current kernel session c) the number of runs d) the line number
3. In a notebook `import pydantic` gives `ModuleNotFoundError`, while `uv run python -c "import pydantic"` works. What to check first?
4. What is the right way to add a new library for a notebook in a uv project?
5. What is wrong with this cell?
   ```python
   import os
   print(os.environ)
   resp = call_llm(os.environ["OPENAI_API_KEY"], prompt)
   ```
6. Why can `await main()` be written in a cell but not at the top level of a `.py` file?
7. What does `%autoreload 2` do?
8. Which two signs say it's time to move code from a notebook into a module?
9. Why do Restart Kernel → Run All before committing?
10. Why are `# %%` cells in a `.py` file better than `.ipynb` for git?
11. A cell sends 200 requests to an LLM and immediately builds a table from them. What is wrong here in terms of cost?
12. A copy of the shop database with customer data is analyzed in a notebook that creates two clients at the top, `deepseek` and `local`. Why is this dangerous, and how can the work be made safer?
13. A local Ollama model answered questions about orders from a copy of the database with customer data; the data was never sent anywhere. Can the notebook be committed with this output?

## Answers

1. A separate Python process that executes the cells; its variables live until the kernel is restarted or shut down, regardless of which cells are in the file.
2. **b.** The execution order; the cells may not have been run top to bottom.
3. The selected kernel: most likely it is the system Python, not the project's `.venv`. Select Kernel → `.venv`, check `sys.executable`.
4. `uv add <package>` in the project terminal, then Restart Kernel. Not `%pip install`: the installation bypasses `pyproject.toml` and the lock file (or doesn't work at all).
5. `print(os.environ)` prints all environment variables, including keys; they are saved in the notebook's output and may end up in git. Keys are never printed; the SDK usually reads them from the environment itself.
6. The IPython kernel already keeps an event loop running and allows top-level `await`. A regular script has no loop; it has to be started with `asyncio.run`.
7. Before each cell execution it reloads changed modules, so edits in `.py` files are picked up without restarting the kernel.
8. For example: it has to run regularly or from other code (a bot, cron); other files import it; it needs tests; it needs proper review in a git diff.
9. To make sure the notebook doesn't depend on hidden state and run order and is reproducible top to bottom.
10. It is plain Python: clean diffs, no saved outputs or counters, and it can be imported, linted and tested.
11. Request and analysis are in one cell: every tweak to the table reruns 200 paid requests. The results should be saved (to a variable or a file) in a separate cell, and the analysis should work on them.
12. One typo in the client name, and customer data goes to the cloud (in DeepSeek's case, to servers in China). Such data gets a separate notebook where only the local Ollama client is created.
13. No. The output is saved in the `.ipynb` and retells order and customer data; it must not end up in git. Clear All Outputs, or keep such a notebook outside the repository / in an ignored folder.

## What's next

Chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3): an intuition for how LLMs work, the DeepSeek key and the Ollama installation (Anthropic and OpenAI keys are optional, for comparison). The notebook from this chapter becomes the place for the first model calls at the end of the week.
