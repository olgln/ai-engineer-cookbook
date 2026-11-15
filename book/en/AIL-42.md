# 9.3 · Project 4: agent evals on 20 cases  (AIL-42)

> **Week 9** · Agents · ⏱ ~4–5 h · Project

<!-- description: Evals for an AI agent on 20 cases: final answer and trajectory, answer leakage, multiple runs, an LLM judge for explanations and failure analysis. -->
<!-- source-sha256: 2b9edb022f7b -->

## Why an AI engineer needs this

Agents need measuring too, and it is harder than with RAG: an agent has not only a final answer but also a **trajectory** — which tools, how many steps, how much money and time. A line like "the agent finds the right cause in 16 of 20 problem orders at an average cost of X and 7 steps, here is the analysis of the four failures" is worth more in a README and in an interview than any demo. The basics of evals (a golden set — a reference set of questions with known answers, metrics, LLM-as-judge) are covered in week 6 on the support assistant; here we cover what agents add, using the order-investigating agent from chapter 9.2.

## Theory

### What to measure in an agent

With the support assistant we graded one answer to one question. An agent run is a chain of steps, and it has three sides: how it ended, how it got there and what it cost.

```
             ┌─ outcome:    is the final answer right?
agent run ───┼─ trajectory: how did it get there? (steps, tools, errors, loops)
             └─ cost:       tokens, money, wall-clock time, limit hits
```

| Group | Metric | How to compute |
|---|---|---|
| Outcome | **Right cause** | `report.cause_category == expected` (exact match) |
| Outcome | Evidence validity | Share of `evidence` items that pass the code check against the snapshot (the check from `report.py`, chapter 9.2) |
| Outcome | **Success** (the main metric) | Right cause **and** all evidence passed the check |
| Outcome | Explanation quality | LLM-as-judge with a rubric, or our own manual score 0–2 |
| Outcome | Honesty | When the data is missing — did it answer `unknown` with `data_gaps` filled in instead of making things up |
| Trajectory | Number of steps | From the JSONL trajectory |
| Trajectory | Tool errors | Count of `is_error` |
| Trajectory | Repeats | Identical calls with identical arguments |
| Trajectory | Hit the limit | Status `STOPPED: ...` |
| Cost | Tokens in/out | Sum of `usage` over the steps |
| Cost | Money | Tokens × the model's current price (from the provider's pricing page, not from memory) |
| Cost | Time | Wall-clock from start to report |

Why the main metric requires evidence and not just the category: the agent can guess `double_charge` from the word "charged" in the customer's comment and cite a nonexistent `payments.id=9999`. Without a code check, the metric rewards a lucky guess.

### Golden set: 20 cases with a known cause

Metrics need a reference — cases where the right cause is known in advance. We already have the answer key: in chapter 8.5, `make_shop_db.py --incidents 20` planted 20 problem orders and wrote `../shop-live/incidents.json` (`order_id`, `cause_category`). But an "order — category" list is not yet a golden set; a good set needs more:

1. **Variety.** We check the mix: all six causes from the catalog (`double_charge`, `stuck_in_delivery`, `promo_not_applied`, `refund_not_arrived`, `out_of_stock_cancel`, `payment_failed`) plus 2 orders older than 30 days whose `events` log has already been purged — the expected answer is `unknown`, an honest "not enough data". If some cause is missing, we fix the generator rather than adding a case by hand.
2. **The expected answer** is not just the category but also 1–3 key facts the agent should find ("two `succeeded` payments for the same amount 40 seconds apart"). We confirm the facts ourselves with SQL queries against the snapshot.
3. **Frozen data.** We make one database snapshot (`VACUUM INTO`, `scripts/snapshot.sh`) specifically for evals, record `snapshot_at` and never change it again. Otherwise results from different runs are not comparable.

The result is one line per case in `eval/cases.jsonl`:

```json
{"id": "case-07", "order_id": 1187,
 "expected_category": "promo_not_applied",
 "key_facts": ["promo_code TEA15 entered, discount 0", "event promo_rejected: order below minimum amount"],
 "events_available": true, "notes": "facts checked by SQL on snapshot 2026-11-10"}
```

### The answer leakage problem

The danger of a set with answers is that the answer can leak to the agent. There are two leaks, and both turn the eval into a reading test instead of an investigation test.

**The answer key.** `incidents.json` and `cases.jsonl` are read only by the run script, and only after the report is done; the agent and the MCP server never see them. The question to the agent is always the same — "What happened to order 1187?" — with no hint of the category.

**A hint in the data itself.** Event types like `auto_cancel`, `cancelled: out_of_stock`, `promo_rejected` with a reason name the answer outright: the metric would measure reading a field. So we use **two run modes**:

- **open** — everything as in production;
- **blind** — for cancellations and promo code rejections `search_events` returns only the generic type (`cancelled`, `promo`) without the reason (the `EVAL_BLIND=1` flag in the MCP server, for evals only). The agent reconstructs the cause from payments, delivery and stock.

The gap between the modes shows the agent's real "investigative" ability. That is an honest and interesting result for the README.

### Nondeterminism: multiple runs

Even without leaks, one run tells us little: the model picks tokens with an element of randomness, and the same input gives different trajectories — in one run the agent checks payments first, in another it wanders into the event log and hits the limit. So we run each case **k times** (k = 3 is a reasonable trade-off between money and time) and compute:

- the **average success rate** over all runs;
- **pass@k** — at least one of k runs is right (optimistic: "can the agent do it at all");
- **pass^k** — all k runs are right (pessimistic: "can we rely on it"). This metric was popularized by the τ-bench benchmark; for an agent whose conclusions the shop owner will trust, it matters more.

```python
# eval/metrics.py — illustrative
def pass_at_k(results: list[bool]) -> bool:
    return any(results)

def pass_hat_k(results: list[bool]) -> bool:  # "pass^k"
    return all(results)
```

### LLM-as-judge for explanations

Code checks the category and the evidence, but code cannot judge whether an explanation hangs together. Explanation quality is graded by a judge with a **narrow rubric** built on the key facts from the golden set:

```text
You grade an order investigation report against reference facts.
Reference facts: {key_facts}
Report: {report_json}
Score each, 0 or 1:
- covers_facts: every reference fact is stated or clearly implied
- no_contradiction: nothing in the report contradicts the reference facts
- no_unsupported: no claim of a specific event without evidence
Return JSON: {"covers_facts": 0|1, "no_contradiction": 0|1, "no_unsupported": 0|1, "reason": "..."}
```

The rules from week 6 still apply: binary criteria beat 1–10 scales; we check the judge by hand on 5–10 reports and record the agreement; the judge is a different or stronger model than the agent, where possible.

### Trajectory analysis (error analysis)

Metrics tell us "how many", trajectories tell us "why". This is exactly why `run.py` saves every trajectory to JSONL: for 5 failed runs we read the JSONL trajectory in full and classify the failure:

| Failure category | Sign |
|---|---|
| Wrong tool | Searched the event log for what is in `payments`, or the other way around |
| Bad arguments | Wrong date window (often a mix-up of UTC and local time), wrong order number, wrong `sku` |
| Early stop | Accepted the first hypothesis, did not check an alternative |
| Looping | Repeats one call, hits the step limit |
| Lost context | After compaction forgot a fact and contradicts itself |
| Fabrication | A claim without evidence or with a nonexistent `ref` |
| Data/tool error | The tool returned something wrong (a bug in `order_total` for loose-leaf tea, in the date filter) — a bug in our code, not the agent's |

Each category gets a concrete fix: a tool description, the prompt, a new tool, a limit, a fix in the server. After the fixes — a **full rerun**, so we do not break what used to work (regression).

### Results table

Everything we measured goes into one table: a row per mode (and model), columns for the metrics from the three groups above. It goes into the README:

| Mode | Model | Success (avg of 3) | pass^3 | Evidence valid | Steps (median) | Tokens (median) | $ / case | Time (median) | Hit the limit |
|---|---|---|---|---|---|---|---|---|---|
| open | … | … | … | … | … | … | … | … | … |
| blind | … | … | … | … | … | … | … | … | … |

The median is better than the mean for steps, tokens and time: one looping run skews the mean badly.

## DeepSeek and Ollama: how we do it

The method above does not depend on the model, but three things do depend on the provider: **which model may see which data**, **who the judge is** and **what "cost" means**. Provider facts were checked on November 13, 2026.

### Two sets, two policies

| Set | Agent | Judge | Where the data goes |
|---|---|---|---|
| **Snapshot** (20 cases from `incidents.json`, database `data/shop.db`) | Ollama `qwen3:4b` | Code + our manual score; the LLM judge is local only (the largest model the machine can run) | Only our machine, `OLLAMA_NO_CLOUD=1` |
| **Demo** (`data/demo_shop.db` with answers in `data/demo_incidents.json`) | `qwen3:4b` and `deepseek-flash` (optionally Claude/OpenAI) | `deepseek-v4-pro` | The cloud is fine — there is no personal data |

The agent's report and the key facts restate orders, payments and customer comments from the snapshot, so a cloud judge would see them just as a cloud agent would. The book's rule: customer data goes only to a local model; DeepSeek (servers in China) and any cloud provider get only the demo database.

The "judge stronger than the judged" rule is hard to meet on the snapshot: a local judge is limited by memory (16 GB — `qwen3:8b`, 32 GB+ — 14B), and on 8 GB it is the same `qwen3:4b` as the agent. So on the snapshot the main grading is **code** (category, evidence check) and **our manual score** 0–2; the local judge is auxiliary, and we measure its agreement with us on 5–10 reports. On the demo set the judge is `deepseek-v4-pro`: stronger than both `qwen3:4b` and `deepseek-flash` (but it should not judge a `deepseek-v4-pro` agent — a model tends to praise its own output).

The demo database from chapter 8.5 was already built with `--incidents 20` (answers in `data/demo_incidents.json`, from which we make `eval/cases_demo.jsonl`), so the sets are the same size; we check that it has `unknown` cases too (if it was generated with a different N, we regenerate it).

### A DeepSeek judge: what to keep in mind

- **JSON:** only `response_format={"type": "json_object"}`; the word "json" and a sample answer go in the prompt; an empty `content` can happen — retry.
- **Thinking is on by default**, and `temperature` is ignored in that mode. As in chapter 6.4, by default we turn thinking off and set `temperature=0`; the mode with reasoning is a separate judge candidate, and we measure its agreement with the manual score.
- **Cache:** the rubric and instructions go at the start of the prompt, the report at the end. Then across 120 gradings (20 cases × 3 runs × 2 modes) the start hits the automatic cache (`prompt_cache_hit_tokens`).

### Cost: money at DeepSeek, time at Ollama

| | Claude / OpenAI | DeepSeek | Ollama |
|---|---|---|---|
| $ / case | Tokens × price | Tokens × price **accounting for the cache and time of day**: a cache hit is dozens of times cheaper than a miss, off-peak (outside 01:00–04:00 and 06:00–10:00 UTC on weekdays) is half price | $0 |
| What to measure instead of money | — | — | Time per case (wall-clock), peak memory (`ollama ps`, the system monitor) |
| How to compute | `usage` | `prompt_cache_hit_tokens` × hit price + `prompt_cache_miss_tokens` × miss price + `completion_tokens` × output price | `eval_count`, `prompt_eval_count`, `total_duration` in the native API |

We take prices from the [DeepSeek page](https://api-docs.deepseek.com/quick_start/pricing) on the day of the run, keep them in `eval/prices.json` (as in Project 3) and write the date next to the table. As of November 2026, for `deepseek-flash` at peak: $0.3 / 1M input (miss), $0.006 / 1M (hit), $1.2 / 1M output.

**Time on Ollama is a real constraint.** 20 cases × 3 runs × 2 modes = 120 agent runs on a 4B model can take hours. We run overnight or in batches, when the machine is not busy with heavy work: a run loads memory and CPU/GPU. We start with k=1 on all 20, and k=3 on a selected subset.

### What to expect from comparing models

Once the table is filled in for two models on the demo set, it matters to read it correctly. As expected, `qwen3:4b` will lose to the cloud models first of all on **trajectory** (more argument errors, repeats, limit hits) and on **evidence validity**, not only on the final category. That is a valuable result for the README: "the local 4B model finds the right cause in X of 20 with pass^3 = Y; the cloud one gets Z, but it cannot be allowed near the snapshot" — an honest discussion of the privacy versus quality trade-off.

## Learning path

1. Reread [6.1](AIL-27.md) and [6.4](AIL-29.md): golden set, metrics, checking the judge (≈20 min) — to refresh, not to relearn.
2. [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) → the parts about testing agents in a sandbox and about transparency (≈10 min).
3. The paper on the τ-bench benchmark (Sierra) — find it by title, read the introduction and the definition of pass^k (≈20 min). Take away: why agent reliability is measured over repeated runs.
4. If the agent from 9.2 is built on the OpenAI Agents SDK or LangGraph — the tracing section in their docs ([OpenAI Agents SDK](https://openai.github.io/openai-agents-python/), [LangGraph](https://langchain-ai.github.io/langgraph/)) (≈15 min): the trajectories may already be recorded for you. For our own loop there is the JSONL from chapter 8.3 (AIL-38).
5. Your LLM provider's pricing page — current input/output token prices (≈5 min). For DeepSeek — [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (cache hit/miss prices, peak hours) and [Context Caching](https://api-docs.deepseek.com/guides/kv_cache) (the `usage` fields).
6. DeepSeek: [JSON Output](https://api-docs.deepseek.com/guides/json_mode) and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) — for the judge (≈15 min). Ollama: [API chat](https://docs.ollama.com/api/chat) — the `eval_count`, `prompt_eval_count`, `total_duration` fields for timing (≈10 min).
7. Practice (≈3–3.5 h).

## What to watch out for

- **20 cases is few.** A difference of 15/20 versus 16/20 is noise (we check with `wilson` and `sign_test` from `eval/stats.py` in week 7). We draw no bold conclusions from ±1 case; we talk about orders of magnitude and types of failures.
- **The data must be frozen**, otherwise we are comparing different tasks.
- **Answer leakage**: `incidents.json` within the agent's reach, or event types that name the cause. Without blind mode the metric overestimates the agent.
- **Cache and cost.** Prompt caching lowers the price; the table states whether it was on.
- **A mistake in the golden set** happens more often than it seems: the generator may have left weaker traces than intended, or traces of a second cause. When the agent "got it wrong", we check the labels first.
- **We do not tune the prompt to the 20 cases.** If the prompt is edited because of a specific failure, we keep 4–5 cases held out and check on them.
- **Evals only read too.** A 20×3×2 run = 120 agent runs — that is 120 times against the snapshot; not a single access to the live database in `../shop-live/`, the payment provider or the delivery service.
- **We do not publish snapshot runs:** the reports contain order data; the README gets the demo set's numbers.

## Practice

```
projects/04-order-investigator-agent/
  eval/
    cases.jsonl        # 20 snapshot cases (gitignored: facts from the snapshot)
    cases_demo.jsonl   # demo cases from data/demo_incidents.json (committed)
    run.py             # runs every case k times in open/blind mode
    judges.py          # rubric judge: local (snapshot) or deepseek-v4-pro (demo)
    metrics.py         # aggregation: success, pass@k, pass^k, medians, cost
    prices.json        # model prices with the date they were checked
    runs/              # <timestamp>_<dataset>_<mode>_<model>/; snapshot runs gitignored
    RESULTS.md         # one summary line per run; committed with demo numbers only
```

- [ ] Make a separate database snapshot for evals (`scripts/snapshot.sh`, `VACUUM INTO`), record `snapshot_at`.
- [ ] `eval/cases.jsonl`: 20 cases from `../shop-live/incidents.json`, each with 1–3 key facts confirmed by SQL against the snapshot.
- [ ] `eval/cases_demo.jsonl`: the same for the demo database from `data/demo_incidents.json`.
- [ ] Add a blind-mode flag to the MCP server (`EVAL_BLIND=1`: `search_events` hides the reason for cancellations and promo code rejections) — for evals only, through an environment variable.
- [ ] `eval/run.py`: for each case, k=3 runs in open and blind modes with the same question "What happened to order <id>?"; save the report, trajectory, evidence check, tokens, time and status.
- [ ] `eval/run.py` supports `--provider ollama|deepseek` and `--dataset snapshot|demo`; a cloud provider combined with `snapshot` is forbidden in code (an assert before the first request, modeled on `assert_data_policy` from Project 1).
- [ ] `eval/judges.py`: the rubric above. On the snapshot — a local judge plus manual scoring; on the demo set — `deepseek-v4-pro` with `json_object`. Check each judge by hand on 5 reports and record the agreement.
- [ ] A run on the demo set: the agent on `qwen3:4b` and on `deepseek-flash` (optionally Claude/OpenAI for comparison), judge `deepseek-v4-pro`.
- [ ] `eval/metrics.py`: the results table (success avg, pass^3, evidence valid, medians of steps/tokens/time, $ per case accounting for the DeepSeek cache, share of limit hits) with "Model" and "Set" columns; for Ollama, time per case instead of $.
- [ ] Analysis of 5 failed trajectories: failure category, a quote from the trajectory, the fix. In `notes/agent-evals.md`.
- [ ] Make 2–3 fixes, rerun the full set, add an "after fixes" row to the table.

## Done when

- There is a table of the agent's metrics (open and blind, before and after fixes) on the snapshot and on the demo set.
- 5 failed trajectories are analyzed, with categories and fixes.
- The snapshot never went to any cloud: neither to the agent nor to the judge.
- We can say in one sentence how far the agent can be trusted and where it goes wrong.

## Self-check quiz

1. How do agent evals differ from RAG evals? Which two groups of metrics are added?
2. Why can the "right cause" accuracy be inflated, and how do we fix that?
3. What does pass^k show compared with pass@k?
4. The agent found the right cause in 3 of 3 runs on case A and in 1 of 3 on case B. What are pass@3 and pass^3 for each case?
5. Why is the median better than the mean for steps, tokens and time?
6. What is wrong with this judge rubric?
   ```text
   Rate the quality of this order investigation from 1 to 10.
   ```
7. The agent "got it wrong" on a `stuck_in_delivery` case. The trajectory shows that `search_events` returned an empty list: the server compared `date_from` with event times in the local time zone, while the database is in UTC. How do we classify this?
8. After a prompt edit the result went up from 14/20 to 15/20. Which conclusion is correct?
   a) the prompt is definitely better; b) the difference is within noise, we need repeated runs and more cases; c) we need to roll back; d) the judge is broken.
9. Why freeze the database snapshot for evals?
10. Why is it useful to include 2 orders older than 30 days with a purged event log in the golden set?
11. Why can't we use `deepseek-v4-pro` as the judge on the snapshot, even though it is stronger than the agent, and what do we do instead?
12. How do we correctly compute the cost of a run on DeepSeek? Which `usage` fields are needed, and what else affects the price?
13. The agent on `qwen3:4b` lost to `deepseek-flash` on the demo set, 11/20 versus 16/20. Which conclusion is correct for the project?

## Answers

1. Besides the outcome, we measure the trajectory (steps, tool errors, repeats, limit hits) and the cost (tokens, money, time).
2. The agent can read the cause from the event type (`auto_cancel`, `promo_rejected`) or see the answer key. We need: `incidents.json` out of the agent's reach, blind mode, and success = category plus evidence that passed the code check.
3. pass@k — whether the agent can solve it at least sometimes; pass^k — whether it solves it reliably every time. For trusting its conclusions, pass^k matters more.
4. A: pass@3 = yes, pass^3 = yes. B: pass@3 = yes, pass^3 = no.
5. The distributions have a long tail: one looping run shifts the mean sharply, while the median is robust.
6. A 1–10 scale with no criteria and no reference facts: the scores are unstable and uninterpretable. We need binary criteria with a reference.
7. A data/tool error — a bug in the server code (UTC handling), not a failure of the agent's reasoning; we fix the server and the time format description, then do a full rerun.
8. **b.** On 20 cases, ±1 is within noise.
9. So that all runs and before/after comparisons work on the same data; otherwise changes in the metrics may be explained by changes in the data.
10. They test honesty: the agent should answer `unknown` with `data_gaps` ("no events, the log keeps 30 days") rather than make up events; this catches LLM09.
11. The judge sees the report and the key facts — order data and customer comments from the snapshot, and DeepSeek's servers are in China (the rule applies to any cloud provider). On the snapshot: code + manual scoring + a local judge with measured agreement; a strong cloud judge only on the demo set.
12. `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` at their own prices plus `completion_tokens` at the output price; the price depends on the model and on the time of day (off-peak is half price). Prices come from the page on the day of the run, with the date.
13. On 20 cases a difference of 5 is noticeable but noisy; the right conclusion is that the cloud model is better on the demo data, but it cannot be allowed near the snapshot with customer data, so for real cases we either improve the agent for the 4B model (tools, schemas, limits) or accept lower reliability and check its conclusions by hand.

## What's next

Chapter 9.4 · Project 4: a README of the AI agent for GitHub (AIL-43): we will package the agent, the evals table and the safety measures into a public repository with a demo on the demo database.
