# 7.5 · Project 3: an experiments table in the README  (AIL-35)

> **Week 7** · Evals · ⏱ ~4 h · Project

<!-- description: A README for a project with evals: the experiments table, a chart, how quality is measured, what helped and what didn't, a 60-second project pitch. -->
<!-- source-sha256: c326eb829523 -->

## Why an AI engineer needs this

The README of Project 3 is the main interview artifact of the whole plan: it shows the ability not just to build RAG but to **measure and improve** it. The phrase "we raised correctness from X% to Y%, and here is the table of how" with honest numbers, spread and conclusions sets a candidate apart from hundreds with a "chatbot over PDFs". A reviewer spends a couple of minutes on a README, so the story has to read from the first screen.

⚠️ Only made-up things are public in the project: the knowledge base `kb/`, the set `eval/golden.jsonl` and the runs on it. A run may be published only if it contains not a single real customer message; `outputs/handoff.jsonl`, the bot's logs and snapshots of the shop's database never get into the repository.

## Theory

### What the reader is looking for

Week 7 left behind the logs `experiments/EXP-*.md`, the runs in `eval/runs/` and the table of all runs `eval/RESULTS.md`. All of this is raw material; the README turns it into a story that a stranger reads in a couple of minutes. We start with what this person is looking for. A hiring engineer who opens the repository wants to understand within 1–2 minutes:

1. **The task**: what the system is and what problem it solves.
2. **How quality is measured**: the set, the metrics, the judge and how it was checked.
3. **The result**: where we started, where we ended up, on what.
4. **How the author thinks**: hypotheses, what didn't work, what was surprising, limitations.
5. **Can it be run**: one command for the evals.

Point 4 is underrated. A table where everything helped looks suspicious; an honest "the reranker gave the large model nothing, but gave the small one +N pp" and "an improvement of 3 pp is within the noise, we don't count it" say more about maturity than any number.

### The structure of the README

The reader's five questions set the order of the sections. Project 3 lives in the same folder `projects/02-support-kb-rag/` as project 2, so there is one README: the evals story becomes its first part, while the architecture and the Quickstart from [AIL-25](AIL-25.md) stay below; we link to them instead of duplicating them.

```
# Shop Support Assistant: evals & experiments

One-paragraph summary: what it is + headline result
("correctness 0.6x → 0.8x on a 7x-question human-reviewed set, at N× lower cost")

## Results at a glance        ← table + one chart
## The system                 ← short diagram, link to the Architecture section (project 2)
## How quality is measured    ← dataset, metrics, judge validation, noise
## Experiments                ← table with all experiments + per-experiment conclusions
## What worked, what didn't, what surprised us
## Error analysis             ← distribution of failure causes, the fix
## Limitations
## How to run evals           ← commands, env vars, cost of a run
## Repo layout
```

The summary paragraph and "Results at a glance" are the most important part: many people don't read further.

### The experiments table

The heart of the README is a table where each row is one experiment of week 7. The columns are the same metrics as in the `EXP-*.md` logs: retrieval and answer quality, cost, latency and the conclusion by the significance rule:

| # | Experiment | hit@5 | correctness | faithfulness | $ / 100 q | p50 / p90, s | Conclusion |
|---|---|---|---|---|---|---|---|
| 0 | Baseline: fixed-512, hybrid + query rewriting, model L | 0.71 | 0.64 ± 0.02 | 0.83 | … | … | — |
| 1 | Heading-based chunking (EXP-01) | 0.84 | 0.72 ± 0.02 | 0.86 | … | … | Accepted: +13 pp hit (11/2, p≈0.02) |
| 2 | Model S without a reranker (EXP-02) | … | … | … | … | … | Rejected: below the quality threshold |
| 3 | Model S + reranker (EXP-02) | … | … | … | … | … | Accepted: quality within the noise of L, N times cheaper |
| 4 | Product filter (EXP-03, from the error analysis) | … | … | … | … | … | … |
| **Final (holdout)** | | … | … | … | … | … | The honest number |

(The numbers are illustrative; everyone will have their own.) The rules:

- **Cumulative or independent?** We state it explicitly. Usually the rows are cumulative (each adds a change to the previous accepted one); rejected experiments are marked and not carried forward.
- **Spread** in the form "± half the range of three runs" or "(min–max)"; we explain the format under the table.
- **The "Conclusion" column** with the significance rule from [AIL-62](AIL-62.md): accepted / rejected / trend, and the paired disagreements.
- **The holdout as a separate row.** If the number on the holdout is lower than on dev, we say so; this is expected and honest.
- **The set version.** If `golden.jsonl` changed (fixes after [AIL-34](AIL-34.md)), we either rerun all rows on the final version (better, if it's cheap) or state the version in each row.

The table is generated by a script from the runs' `summary.json`, not by hand: copying numbers by hand is a source of errors. The script `eval/make_table.py` reads the list of runs from `experiments/runs.yaml` (paths to the folders `eval/runs/<timestamp>_<index>_<retriever>_k<k>/`) and prints markdown. `eval/RESULTS.md` stays the log of all runs in a row, while the table in the README is a curated story.

### One chart

A table is precise, but the eye grasps dynamics and trade-offs faster in a picture. One good chart is worth half the text. Options:
- "quality versus cost" with points for the configurations and the Pareto front (from [AIL-33](AIL-33.md));
- "correctness by step": bars baseline → … → final with spread whiskers.

Axis labels, units, a legend; a PNG in `docs/` or `experiments/`, embedded in the README.

### The "How quality is measured" section

The numbers in the table will be trusted only if it is clear how they were obtained. This section is short but concrete:
- **The set**: how many questions, types and categories (the "type × category" matrix from [AIL-28](AIL-28.md)), traps (the archived page, the rate tables, similar products, the conflicting free delivery threshold), how many are handwritten and how many synthetic, all checked by a human, dev/holdout. The questions are made up, and so is the knowledge base.
- **Metrics**: hit@k, MRR, correctness, faithfulness, correct refusals, `archived_in_context`: one line of definition each.
- **The judge**: binary, with a critique; agreement with the hand labels on N examples: X% (TPR/TNR). Refusals are checked by code, not by the judge.
- **Noise**: the spread of repeated runs, the significance rule.

This is what they will ask about in an interview, so the wording here is a ready-made set of answers.

### "What helped, what didn't, what surprised us"

The table answers "what changed"; this section answers "what we learned": point 4 from the list of the reader's questions. 3–6 points, each with a number and an explanation of the mechanism. Examples of the format (not results):
- "Heading-based chunking gave the biggest gain: the delivery rate table by weight and zone stopped being cut off from its heading."
- "The reranker didn't help the large model (within the noise), but gave the small one +N pp: it is worse at ignoring extra context."
- "Surprising: 13% of failures were errors of the set (outdated reference answers after edits to `kb/`), not of the system."

### The "How to run evals" section

The reader's last question is whether it can be run. A reviewer must be able to reproduce it. The minimum:

```markdown
## How to run evals

    uv sync                                  # versions pinned in uv.lock
    cp .env.example .env                     # fill in your API keys
    uv run python ingest.py                  # builds index.db from kb/ (committed)
    uv run python eval/run.py --config eval/configs/final.json        # dev split
    uv run python eval/compare.py eval/runs/<A> eval/runs/<B>
    uv run python eval/make_table.py experiments/runs.yaml

A full run on the dev split costs about $X and takes ~Y min (prices as of <date>).
```

`.env.example` contains the **names** of the variables without values. We state how much a run costs: it is a courtesy to the reader and a sign that the author keeps track of money.

### Public repository hygiene

The README is ready, but a public repository shows not only the README but the whole commit history. Before the push we check:

- **Secrets.** `.env` is in `.gitignore`; a search over the history: `git log -p | grep -iE "sk-|api_key|secret"` (and the same over the working copy) or gitleaks from [AIL-25](AIL-25.md). If a key ever got into a commit, we **revoke the key** with the provider; removing it from the history doesn't help if the repository has already been public. After the push we check whether a GitHub secret scanning alert has arrived.
- **No shop or customer data.** Project 3 is about a made-up knowledge base and a made-up set. No `shop.db`, `analytics.db` or paths to `../shop-live/` from project 1, no `outputs/handoff.jsonl`, no bot logs with customer questions, no Telegram tokens. We publish runs in `eval/runs/` only if they were made on `golden.jsonl` without a single real message; a run that ever included real questions stays local. The shop's data in the course is made up, but we treat it as real.
- **The knowledge base and other people's content.** We commit `kb/` and `golden.jsonl`: these are our own made-up texts, and without them the index can't be built and the evals can't be reproduced; the short `evidence` quotes in the set come from our own base. The `raw/web/` cache with someone else's public page (the optional item of [AIL-20](AIL-20.md)) is not committed.
- **Large files.** `index*.db` (`index.db`, `index_ctx.db`, `index_fixed512.db`, `index_headings.db`), embeddings, the judge cache go into `.gitignore`. We commit the runs' `summary.json` and `config.json` (they are small), `results.jsonl` optionally.
- **Dependency versions** are pinned (`uv.lock` or `requirements.txt` with exact versions).

### A 60-second pitch

The same story is needed without a screen too: in an interview we are asked to tell it. The README doubles as the script of a spoken story. We rehearse it out loud:

> I built a support assistant for an online shop that answers from a knowledge base with a link to the section, and built an evaluation system for it: 7x questions of four types, checked by hand, retrieval and answer metrics, an LLM judge checked against my own labels on N examples. I ran four experiments. Heading-based chunking had the strongest effect, +X pp hit rate. Error analysis showed that 30% of failures were retrieval finding the page of a similar product, for example the Light Mini warranty instead of Light; a product filter removed most of them. In the end correctness rose from A to B on the holdout, and switching to a small model with a reranker cut the cost N times with no loss of quality within the noise.

## DeepSeek and Ollama: how we do it

The structure of the README doesn't depend on the provider. What changes is what the reader needs to know about the models so that the numbers can be trusted and reproduced. The provider facts were checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com).

### What we must write about the models

- **Exact ids and dates.** `deepseek-flash` / `deepseek-v4-pro` plus `resp.model` from the runs and the date: DeepSeek reassigns names (right now `deepseek-flash` is V4.1-Flash-1017), and in half a year "deepseek-flash" will be a different model.
- **The thinking mode** of the answerer and the judge (thinking on/off): it changes the quality, the cost and the noise.
- **For Ollama, the exact tag and the hardware.** "`qwen3:4b`, a laptop with 8 GB of RAM, no discrete GPU, 8k context": without this the latency of a local model means nothing. We note that Ollama tags are quantized by default.
- **The judge and how it was checked.** "Judge: `deepseek-v4-pro`, thinking off, temperature 0; agreement with our labels X% on N answers; second opinion from <Claude/OpenAI model> on disputed cases". If the judge is from the same family as the answerer, we write how we checked for self-preference.
- **Cost with caveats.** For DeepSeek: at the prices as of a date, including the cache, and in which window (peak or off-peak) the runs were made. For Ollama: "$0 API, runs on the user's device", with p50/p90 latency next to it.
- **A comparison with Claude/OpenAI only if it was actually run.** One or two "for comparison" rows on the same questions make a README much stronger; made-up numbers or numbers "from the leaderboards" kill it.

### `.env.example` and "How to run" on our stack

```text
# .env.example — names only, no values
DEEPSEEK_API_KEY=
ANSWER_PROVIDER=
ANSWER_MODEL=
ANSWER_MODEL_LOCAL=
EMBED_BACKEND=
EMBED_MODEL=
RERANK_MODEL=
GEN_MODEL=
# optional, for the comparison rows
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
# optional: Langfuse tracing (only the fictional golden set goes there)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=
# local models, OpenAI-compatible form: http://localhost:11434/v1
OLLAMA_BASE_URL=
```

In "How to run evals" we add steps for the local part: install Ollama following the official instructions for your OS from ollama.com (on macOS, check the app with `codesign -dv` and `spctl -a -vv` before the first launch), `ollama pull <exact tag>` for the answerer and `ollama pull bge-m3` for the embeddings, and how to set the context (`OLLAMA_CONTEXT_LENGTH`). A nice gesture for the reviewer: **a configuration that works with no cloud keys at all** (a local answerer + local embeddings, only the retrieval metrics and the refusal checks in code), so the project can be run in 5 minutes for free. We also state the cost of a full run on DeepSeek (for example, "≈$0.6 at peak prices, about half off-peak, as of <date>"), taking the number from our own runs.

### Privacy: one line, but an accurate one

The reviewer will ask: "DeepSeek is a Chinese provider, what about the data?" A ready answer in the README: "Only the public, fictional knowledge base (`kb/`) and the fictional eval questions are sent to DeepSeek. Real customer messages are answered by a local model only; no shop database, customer data or keys are in this repository". We write this line only if it is true, and check it before the push (the "Public repository hygiene" section above).

### Comparing providers for the README

| What to show | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Model identifier | id from the docs (with the snapshot date) | id from the docs | id + `resp.model` + date | exact tag + quantization |
| Price | from the pricing page as of a date | from the pricing page as of a date | from the pricing page, cache, peak/off-peak | $0 API + hardware and latency |
| Key in `.env.example` | `ANTHROPIC_API_KEY` (optional) | `OPENAI_API_KEY` (optional) | `DEEPSEEK_API_KEY` | no key needed |
| The reviewer's question | "why not only Claude?" | the same | "what about the data?" | "how much worse, and on what hardware?" |

## Learning path

1. [GitHub Docs: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) (≈10 min): where GitHub shows the README, relative links, images.
2. [GitHub Docs: Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) → tables, images, collapsible sections (≈15 min).
3. [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) once more, this time as an example of presentation (≈10 min): how the experiments and numbers are presented briefly. We borrow the manner "change → effect in percent → cost".
4. We reread our own README of Project 2 ([AIL-25](AIL-25.md)) (≈10 min): Project 3 links to it instead of duplicating it.
5. We reread the logs `experiments/EXP-*.md` (≈20 min) and write down a one-sentence conclusion for each.
6. [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) on the day the README is published (≈5 min): we check the ids and prices in the table against the current ones and put down the date.
7. The page of our local model on [ollama.com/library](https://ollama.com/library) (≈5 min): the exact tag and size go into the "How to run evals" section.

## What to watch out for

- **Numbers without spread and set size** look like marketing. Always "on N questions", "± spread".
- **Dev numbers only.** The final result is the holdout; if there is none, an engineer reading the README will notice.
- **Copying numbers into the table by hand** means typos and mismatches with the runs. The table is generated by a script.
- **Incomparable rows**: different versions of the set without a note.
- **Hidden failures.** Rejected experiments are a result too; we show them.
- **A README that can't be run**: no `.env.example`, `kb/` not committed, versions not pinned.
- **A secret in the git history**: revoke the key, don't just clean the history.
- **A run with real customer questions in `eval/runs/`.** Only runs on the made-up set may be published.
- **A wall of text.** The first screen: the summary paragraph + the table + the chart.
- **"deepseek-flash" without a date and `resp.model`**: in half a year the numbers will be impossible to reproduce or explain.
- **Ollama latency without the hardware** ("p90 9 s") says nothing: on a laptop with 8 GB and on a server with a GPU these are different numbers.
- **"Claude/OpenAI for comparison" rows without real runs.** Only what we ran ourselves on the same set.

## Practice

- [ ] We create `experiments/runs.yaml`: the list of table rows (the experiment name, the path to the run folder in `eval/runs/`, whether it is cumulative, the conclusion).
- [ ] We write `eval/make_table.py`: it reads `summary.json` of the listed runs and prints a markdown table with hit@5, correctness (with spread), faithfulness, $/100q, p50/p90 and the conclusion.
- [ ] If the set version changed, we rerun the key configurations (the baseline and the accepted steps) on the final version if the budget allows; otherwise we mark the versions in the table.
- [ ] We build one chart (quality versus cost or correctness by step) → `experiments/*.png`.
- [ ] We write the README following the structure above: the summary paragraph, the table, the chart, how quality is measured, the experiments, "what helped / didn't / surprised us", the error analysis, limitations, "How to run evals", the repo layout; the sections of project 2 (architecture, Quickstart) stay below.
- [ ] In the "How quality is measured" section we state the answerer and judge models with exact ids, `resp.model`, the thinking mode and the date; for a local model, the tag, the hardware and the context.
- [ ] We update `.env.example`: `DEEPSEEK_API_KEY`, the model variables, the optional keys for the comparison and Langfuse, `OLLAMA_BASE_URL`, names only. We check `.gitignore` (`.env`, `index*.db*`, the judge caches, `raw/`, `outputs/`, `data/`).
- [ ] We make the configuration `eval/configs/local_only.json` that runs without cloud keys (a local answerer, only the retrieval metrics and the refusal checks in code).
- [ ] We check the history and the working copy for secrets; we make sure there are no `*.db`, `outputs/handoff.jsonl` or runs with real customer messages (`git ls-files`, `git log --all --stat -- '*.db' 'outputs/*'`). Only after this check do we add the privacy line to the README.
- [ ] We go through "How to run evals" from scratch in a clean folder (a new clone, a new environment), including `local_only.json`. We fix everything that didn't work.
- [ ] Push to GitHub. We open the README in the browser: the table and the chart render, the links work.
- [ ] We rehearse the 60-second pitch out loud and write it down in `notes/pitch.md`.

## Done when

- The README tells the story of improvements in numbers: start → finish on the holdout, each experiment with a conclusion, the spread and the set size stated.
- There are sections "what helped / didn't help / surprised us", "Limitations", "How to run evals".
- The evals run from the README in a clean clone.
- The repository on GitHub has no secrets, no shop data and no real customer messages; `kb/` and `eval/golden.jsonl` are in place.

## Self-check quiz

1. What should be on the first screen of the Project 3 README?
2. Why show rejected experiments?
3. Why is the final number taken from the holdout and not from dev?
4. What is wrong with this line in a README?
   ```
   Added a reranker, and quality went up from 74% to 77%!!!
   ```
5. Why generate the table with a script from `summary.json`?
6. A commit with an API key was found in the git history, and the repository is already public. What do we do first?
   a) `git rebase` and force push; b) revoke the key with the provider; c) make the repository private; d) nothing, nobody will notice.
7. Why are `kb/` and `eval/golden.jsonl` committed, but `outputs/handoff.jsonl` and a run that included real customer questions are not?
8. What should be in `.env.example`?
9. The rows of the table were computed on different versions of the set. What do we do?
10. Why is it worth stating the cost of one eval run in the README?
11. Why is "answer model: deepseek-flash" not enough in a README? What should be added?
12. A reviewer asks: "You sent data to DeepSeek, isn't that China?" What must be true in the project to answer briefly, and where is it written?

## Answers

1. A paragraph with the task and the main result (start → finish, on what set, the cost), the results table and the chart.
2. They show how the author thinks and tests hypotheses; a table where everything helped looks implausible, and honest negative results are useful to the reader too.
3. Dev was used to choose configurations and for the error analysis, so its numbers are optimistic; the holdout took no part in the choice.
4. No set size and no spread; +3 pp is most likely within the noise (no paired comparison); it doesn't say what was fixed, how much it cost or how latency changed; exclamation marks instead of a conclusion.
5. So that the numbers in the README match the runs exactly and the table can be rebuilt after new experiments without manual errors.
6. **b.** The key may already have been copied; revoke it first, then clean the history if we want to.
7. `kb/` and the set are made up and belong to the author; without them the index can't be built and the evals can't be reproduced. `handoff.jsonl` and such a run contain customer messages, personal data that is not published (and not sent to the cloud), even though the shop's data in the course is made up: we treat it as real.
8. The names of the required environment variables (without values), so the reader knows what to fill in.
9. Rerun the key configurations on the final version of the set; if that is too expensive, explicitly mark the set version in each row and don't compare what can't be compared.
10. The reader understands what reproducing it will cost and sees that the author keeps track of money: this is part of engineering work.
11. A DeepSeek name can point to different versions over time. We need `resp.model` from the runs, the date, the thinking mode and the prices as of the date (including the cache and the peak/off-peak window).
12. Only the public made-up knowledge base and the made-up questions of the set were sent to DeepSeek; real customer messages are handled only by a local model, and there is no shop data, customer data or keys anywhere in the repository. This is one line in the README (the privacy section) and a check of the repository before the push.

## What's next

Project 3 is complete. The next stage is agents: we start with [AIL-37 · AI agents: Building effective agents and the OWASP LLM Top 10](AIL-37.md); the evals skill comes back in [AIL-42 · Project 4: agent evals on 20 cases](AIL-42.md).
