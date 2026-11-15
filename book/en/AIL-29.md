# 6.4 · A RAG evaluation script: retrieval and faithfulness  (AIL-29)

> **Week 6** · Evals · ⏱ ~4–5 h · Project

<!-- description: A RAG evaluation script: retrieval and answer metrics, faithfulness, a binary LLM judge with critique and its validation, run cost, saving results. -->
<!-- source-sha256: 46ad7f003e8a -->

## Why an AI engineer needs this

A dataset without a script is just a file. An evaluation script turns every change (chunking, model, prompt, reranker) into a table of numbers with a single command, the way `npm test` turns an edit into green or red tests. This is the main working tool of Project 3: all the experiments of week 8 will be runs of this script. Interviews often ask to describe an eval pipeline for RAG: which metrics, how the judge works, how we checked that the judge can be trusted.

## Theory

### Run architecture

In [AIL-28](AIL-28.md) each question got a reference answer, `must_include` and `evidence` quotes. The evaluation script runs all the questions through the assistant and compares the result with these fields at two levels: what the search found and what the model answered.

```
 eval/golden.jsonl ──► for each question:
                      │
                      ├─ ask(question, cfg) ──► Answer: text, refusal, chunks from the prompt,
                      │                          usage, latency_ms
                      │
                      ├─ chunks from the prompt + evidence ──► retrieval metrics (hit@k, MRR, recall)
                      │
                      ├─ judge_correctness(question, reference, answer)  ─┐
                      └─ judge_faithfulness(answer, chunks)               ─┴► answer metrics

 ──► results.jsonl (per question)  +  summary.json (aggregates)  +  config.json  +  a row in RESULTS.md
```

The script calls the same `ask()` from `rag/pipeline.py` ([AIL-23](AIL-23.md)) as `app.py` and `bot.py` do: we evaluate exactly what the customer will see. `Answer` gets two fields with default values: `chunks` (the chunks from the prompt with their metadata) and `usage` (tokens from the API response).

An important architectural decision: **the RAG pipeline must accept a configuration** rather than hardcoded parameters. Then an experiment is a different config, not a code edit. `ask(question, cfg=None)`: without `cfg` the parameters come from `.env`, as before. Configs are JSON files in `eval/configs/` (the base one is `eval/configs/baseline.json`), and after `json.loads` this is an ordinary dict:

```python
config = {
    "index": "index.db",           # or index_ctx.db from 5.2
    "rewrite": True,               # plan_query from 5.1
    "retriever": "hybrid",         # vector | bm25 | hybrid
    "k": 5,
    "reranker": None,              # or a cross-encoder model name (RERANK_MODEL)
    "answer_model": "<model id>",  # see provider docs for current ids
    "answer_thinking": False,      # reasoning mode of the answer model, if the provider has one
    "answer_prompt": "answer_v1",  # prompts/answer_v1.txt
    "judge_model": "<model id>",
    "judge_prompt": "judge_v1",
}
```

### Retrieval metrics

We start with retrieval: if the needed chunk is not in the context, the model can't answer correctly, and the answer metrics will be explaining the wrong thing.

**A relevant chunk.** As decided in [AIL-28](AIL-28.md), a chunk is relevant if it contains an `evidence` quote, a verbatim phrase from `kb/` (a development of `must_contain` from the week 5 golden set). For a question with several quotes there are several relevant chunks.

**hit rate@k** is the share of questions where at least one relevant chunk is in the top-k.

**recall@k** is for questions with several quotes: the share of quotes covered by the top-k. For comparative questions it is more honest than hit rate: in a question about the warranty of Light and Light Mini, finding only `lamp-light.md` is half the job.

**MRR (Mean Reciprocal Rank)** is the mean over questions of `1/rank` of the first relevant chunk (0 if it is not in the top-k). We already computed it in [AIL-22](AIL-22.md) in `eval/run_retrieval_eval.py`.

An example, k = 5:

| Question | Position of the first relevant chunk | hit@5 | 1/rank |
|---|---|---|---|
| q1 | 1 | 1 | 1.00 |
| q2 | 3 | 1 | 0.33 |
| q3 | not found | 0 | 0 |
| **Total** | | **0.67** | **MRR = 0.44** |

Hit rate answers the question "was it found at all", MRR answers "how high". If all 5 chunks go to the model, hit rate@5 matters more; if we plan to cut the context down to 2–3 chunks, we look at MRR and hit@3.

`unanswerable` questions are not included in the retrieval metrics (there is nothing to find there); they are counted separately by the share of correct refusals.

Separately, the code counts **archived chunks in the context** (`archived: true`, `returns-2025.md`): this is a pipeline error, and the counter must be zero. We move the functions into `eval/metrics.py`, and `eval/run_retrieval_eval.py` from week 5 imports them from there: the metrics in both scripts are computed by the same code.

```python
# eval/metrics.py
import re

def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().casefold()

def is_relevant(chunk_text: str, evidence: list[str]) -> bool:
    t = normalize(chunk_text)
    return any(normalize(e) in t for e in evidence)

def retrieval_metrics(retrieved: list[str], evidence: list[str], k: int) -> dict:
    ranks = [i + 1 for i, text in enumerate(retrieved[:k]) if is_relevant(text, evidence)]
    covered = sum(any(normalize(e) in normalize(t) for t in retrieved[:k]) for e in evidence)
    return {
        "hit": int(bool(ranks)),
        "rr": 1 / ranks[0] if ranks else 0.0,
        "recall": covered / len(evidence),
    }
```

### Answer metrics

The search brought chunks; now we check what the model made of them. There is no exact string matching here anymore, so most of the checks are done by a judge, a model that evaluates the answer by instructions ([AIL-27](AIL-27.md)).

**Correctness**: does the answer match the reference in meaning. The judge gets the question, the reference, `must_include` and the answer.

**Faithfulness (groundedness)**: is every claim of the answer supported by the retrieved chunks. The judge gets the answer and the chunks; it doesn't need the reference. This catches hallucinations even when the answer happens to be correct. Typical cases in our assistant:

- **An invented period.** The chunks contain only the section about opened tea, and the answer says: "a mug can be returned within 30 days". There is no number 30 in the chunks: FAIL.
- **Merged warranties.** The context holds `lamp-light.md` and `lamp-light-mini.md`; say Light has 12 months and Light Mini has 6. The answer "the warranty on LAMP-LIGHT-MINI is 12 months": the number is in the chunks, but for another product. A claim is a "product + period" pair, and this pair is not supported: FAIL. A judge that looks only for numbers will miss it.
- **Archived rules.** The answer quotes `returns-2025.md`. If the archived chunk was in the context, faithfulness is PASS and correctness is FAIL (the `archived` filter is broken); if it wasn't, faithfulness is FAIL.

**Relevance**: does the answer address the question. For RAG over a knowledge base it rarely breaks; it can be left out of the first version.

**A correct refusal**, for `unanswerable`: the answer must be a refusal. No judge is needed: the prompt from [AIL-23](AIL-23.md) requires the phrase "The knowledge base has no answer to this question." (`REFUSAL`), and `ask()` returns `refused`. The opposite error matters too: a **false refusal** on an answerable question.

Combinations of correctness and faithfulness say different things:

| correctness | faithfulness | What it means |
|---|---|---|
| PASS | PASS | All is well |
| PASS | FAIL | The model knew the answer "off the top of its head"; dangerous, because next time it will make something up |
| FAIL | PASS | The answer relies on what was found, but the wrong thing was found (we look at hit and archived chunks) or the reference is wrong |
| FAIL | FAIL | A hallucination |

### The judge: binary, with critique

The approach from [AIL-27](AIL-27.md): `{"critique": ..., "verdict": "PASS"|"FAIL"}`, the critique before the verdict, temperature 0 (if the provider supports it for the chosen model), structured output. A judge prompt for faithfulness (illustrative):

```python
FAITHFULNESS_PROMPT = """You check whether a support answer is supported by excerpts from the shop's knowledge base.

<excerpts>
{chunks}
</excerpts>

<answer>
{answer}
</answer>

List each factual claim in the answer (numbers, periods, prices, product names, SKUs,
promo codes, conditions). A claim includes its subject: "12 months warranty for LAMP-LIGHT-MINI"
is supported only if an excerpt states it for that product, not for a similar one.
For each claim decide if the excerpts support it. General phrasing and
"The knowledge base has no answer to this question." are not claims.

Verdict PASS only if every claim is supported. Return JSON:
{{"claims": [{{"claim": "...", "supported": true}}], "critique": "...", "verdict": "PASS" | "FAIL"}}
"""
```

For faithfulness, breaking the answer into claims inside the prompt makes the judge noticeably more accurate than the question "is the answer grounded in the context?". We build the correctness prompt from the draft written in [AIL-27](AIL-27.md): the judge gets the question, the reference, `must_include` and the answer, and gives PASS only if the answer contains every fact from `must_include` and nothing contradicts the reference.

### Checking the judge

The judge prompt is written, but it is too early to trust the correctness and faithfulness numbers. The judge is a model, so we check it first and trust the numbers after:

1. We run the dataset and take 20 answers (preferably a mix where the judge gave both PASS and FAIL).
2. **Without looking at the judge's verdict**, we label them ourselves: PASS/FAIL + a reason.
3. We build an agreement table:

```
                 we: PASS   we: FAIL
 judge: PASS        11          2      ← the judge missed 2 bad answers
 judge: FAIL         1          6      ← the judge rejected 1 good answer
```

4. We compute: overall agreement (17/20 = 85%), the share of bad answers caught (6/8 = 75%, this is TNR, true negative rate, in Hamel's terms), the share of good answers correctly accepted (11/12 ≈ 92%, TPR, true positive rate).
5. We read every disagreement. Usually the cause is visible: the judge doesn't match the number to the product, doesn't know that "14 days" and "two weeks" are the same thing. We fix the prompt, add a few-shot example, run again.

On 20 examples these shares are very rough (more on noise in [AIL-62](AIL-62.md)), but the disagreements will show the judge's obvious defects. Once there are more labels, it is worth splitting them: on one part we tune the judge prompt, on the other we check it, otherwise we fit the judge to our own 20 examples.

### Cost and latency

Quality is not the only thing that changes from config to config: a stronger model or a reranker costs money and time. So we count them too in every run. The API response returns the number of input and output tokens (`usage`). Cost:

```
cost = input_tokens × price_in / 1e6 + output_tokens × price_out / 1e6
```

Prices change; we keep them in `eval/prices.json`, not in code. We count separately the cost of the **system** (what the shop will pay for answers to customers) and the cost of the **evaluation** (the judge). The report gets the system cost per 100 questions; it will come in handy in [AIL-33](AIL-33.md). We also account for prompt caching: cached tokens have their own price.

Latency is the time from question to answer (retrieval + generation); `ask()` already measures it with `time.perf_counter()` and puts it in `latency_ms`. We look at the median and p90, not just the mean: one stuck request spoils the mean.

### Saving runs

All these numbers need to be stored somewhere so that a week later we can compare runs with each other. Each run is a separate folder:

```
eval/runs/2026-12-24T14-05_index_hybrid_k5/
  config.json      # full config + git commit + dataset hash + timestamp
  results.jsonl    # per question: retrieved urls, ranks, answer, verdicts, critiques, tokens, latency
  summary.json     # aggregates
  report.md        # human-readable table
```

Without `results.jsonl` we can't analyze errors ([AIL-34](AIL-34.md)); without `config.json` a week later nobody remembers what that run was. The summary row of each run is appended to `eval/RESULTS.md`, the same table as in weeks 4–5. `eval/runs/` goes into git, or at least `summary.json` and `config.json`: the runs contain only made-up questions and answers over a public knowledge base, and the run history is material for the README.

### Practical details of the script

Before putting the script together, a few decisions that separate a working tool from a draft:

- **Parallelism.** 80 questions with 3 calls each, sequentially, take minutes. `concurrent.futures.ThreadPoolExecutor(max_workers=4–8)` speeds it up several times; we keep an eye on the provider's rate limits.
- **Retries.** An API error on one question must not bring down the run: a retry with a pause, and after N failures the question is marked `error` and counted separately.
- **Cache.** We cache the judge's answers by a hash (judge prompt + input). Rerunning the same answer costs nothing.
- **Slices.** We aggregate metrics not only overall but also by `type`, `category`, `origin`. The overall number hides failures, for example on warranty questions.
- **`--split dev` by default.** Holdout only with an explicit flag.
- **Privacy.** Before calling a cloud judge, the script checks the question with `contains_personal_data()`: the rule "personal data doesn't go to the cloud" is enforced by code. For example, the made-up "where is my order 1042?": its refusal is checked by code, without a judge.

### The `eval/run.py` skeleton

The skeleton brings together everything listed above: `eval_item` evaluates one question (retrieval, refusal, judges with a privacy check), `main` reads the config and the dataset, runs the questions in parallel and writes the run metadata.

```python
# eval/run.py  (illustrative skeleton, not a full solution)
import argparse, hashlib, json, subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from rag.pipeline import ask                 # Project 2 pipeline, now config-driven
from rag.privacy import contains_personal_data
from judges import judge_correctness, judge_faithfulness
from metrics import retrieval_metrics

def eval_item(item: dict, cfg: dict) -> dict:
    ans = ask(item["q"], cfg)          # Answer(text, sources, refused, latency_ms, chunks, usage)
    res = {"id": item["id"], "type": item["type"], "category": item["category"],
           "latency_ms": ans.latency_ms, "refused": ans.refused,
           "retrieved": [c["url"] for c in ans.chunks],
           "archived_in_context": sum(bool(c.get("archived")) for c in ans.chunks),
           "answer": ans.text, "usage": ans.usage}
    if item["type"] == "unanswerable":
        res["refusal_ok"] = ans.refused       # fixed REFUSAL phrase, checked by code
    else:
        res |= retrieval_metrics([c["text"] for c in ans.chunks], item["evidence"], cfg["k"])
    if contains_personal_data(item["q"]):
        res["judges"] = "skipped_private"     # never send it to a cloud judge
        return res
    if item["type"] != "unanswerable":
        res["correctness"] = judge_correctness(item, ans.text, cfg)   # {"verdict", "critique"}
    res["faithfulness"] = judge_faithfulness(ans.text, ans.chunks, cfg)
    return res

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--split", default="dev")
    args = ap.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    raw = Path("eval/golden.jsonl").read_bytes()
    items = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    items = [i for i in items if i["split"] == args.split]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda it: eval_item(it, cfg), items))
    meta = {"config": cfg, "split": args.split, "started": datetime.now().isoformat(),
            "dataset_sha": hashlib.sha256(raw).hexdigest()[:12],
            "git": subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                  capture_output=True, text=True).stdout.strip()}
    ...  # aggregate (overall + per type/category), cost from prices.json, write run folder,
         # append one line to eval/RESULTS.md, print table

if __name__ == "__main__":
    main()
```

Expected terminal output:

```
run 2026-12-24T14-05 | index.db hybrid k=5 | dataset 3f2a9c1e0b77 | dev n=56
hit@5 0.82  MRR 0.64  recall@5 0.77  archived_in_context 0
correctness 0.71  faithfulness 0.86  refusal_ok 7/8  false_refusals 2
system cost $0.41 per 100 q  | judge cost $0.95  | latency p50 2.1s p90 4.8s
by type: factual 0.80 | comparative 0.50 | multi_hop 0.58 | unanswerable 0.88
```

The numbers are made up to show the format.

### Ragas: why look at it and why not right away

[Ragas](https://docs.ragas.io) is a library of ready-made RAG metrics (faithfulness, context precision/recall, answer correctness and others); inside are the same LLM judges. Our own script comes first so that we understand what exactly is being measured: Ragas has its own judge prompts, its own aggregation and its own defaults, and without that understanding we can't explain why faithfulness is 0.73. Once our own script works, we can run Ragas on the same data and compare whether the conclusions match.

## DeepSeek and Ollama: how we do it

The whole script carries over to our stack: the answering model is `deepseek-flash` (or a local model for comparison), the judge is `deepseek-v4-pro`, a second opinion comes from Claude or OpenAI on a subsample, and Ollama provides the local answering model and embeddings. Below is what changes in the judge code, in cost accounting and in parallelism. The facts were checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com); we check model ids and prices before a run.

**Why the judge can be in the cloud.** The judge sees the dataset questions, the references, the answers and the `kb/` chunks. The knowledge base is public, the questions and references are made up, there is no personal data, so they can be sent to DeepSeek (its servers are in China). The course rule doesn't change: customers' personal data, work code and anything that must not be shown to outsiders never go to cloud models; answers to real customer messages are judged only by the local model.

### A judge on DeepSeek

```python
# eval/judges.py — DeepSeek judge (illustrative)
import json, os
from openai import OpenAI

ds = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")

def judge_deepseek(prompt: str, model: str = "deepseek-v4-pro", retries: int = 3) -> dict:
    for attempt in range(retries):
        r = ds.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},      # prompt must say "JSON" and show the structure
            temperature=0,
            max_tokens=1000,
            extra_body={"thinking": {"type": "disabled"}},  # temperature is ignored in thinking mode
        )
        text = (r.choices[0].message.content or "").strip()
        if not text:
            continue  # JSON mode may return blank content; retry
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        if data.get("verdict") in ("PASS", "FAIL"):
            return {**data, "judge_model": r.model, "usage": r.usage.model_dump()}
    return {"verdict": "ERROR", "critique": f"no valid JSON after {retries} attempts"}
```

Three things that Claude/OpenAI don't have or that work differently there:

1. **Thinking is on by default**, and in it `temperature` silently has no effect. For the judge we turn reasoning off by default: verdicts are more stable, cheaper and faster that way. The reasoning mode is a separate judge candidate: we turn it on and compare its agreement with our labels; if agreement is noticeably higher, we take it and measure the spread with repeated runs (chapter [8.1 · Eval statistics: noise and sample size](AIL-62.md)).
2. **JSON mode without a schema.** So the `verdict in ("PASS", "FAIL")` check in code is mandatory, and the judge prompt must contain a JSON example (`FAITHFULNESS_PROMPT` above has one). An `ERROR` answer is counted separately, not as FAIL.
3. **`seed` is not documented by DeepSeek.** The judge's repeatability comes only from temperature 0 without thinking plus our verdict cache.

### Why not a judge on Ollama

A local model is limited by memory: 8 GB RAM means 4B-class models (`qwen3:4b`), 16 GB means 7–8B, 32 GB and more means 14B and larger, and all of this runs alongside `bge-m3` and the reranker. Even a 14B is weaker than the `deepseek-v4-pro` judge, and a 4B is weaker than the `deepseek-flash` answering model: a judge that makes mistakes more often than the system it evaluates measures nothing. So a local judge here is a learning illustration (the code below) and a way to see how much worse its agreement with the labels is.

```python
# illustrative; native API gives schema-constrained output and per-request num_ctx
import ollama
from typing import Literal
from pydantic import BaseModel

class Verdict(BaseModel):
    critique: str                      # field order matters: critique before verdict
    verdict: Literal["PASS", "FAIL"]

def judge_ollama(prompt: str, model: str = "qwen3:4b") -> Verdict:
    r = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        format=Verdict.model_json_schema(),
        options={"temperature": 0, "seed": 42, "num_ctx": 8192},  # 5 chunks + prompt need room; context costs RAM
    )
    return Verdict.model_validate_json(r.message.content)
```

A local judge and a local **answering model** share one trap: the **context**. By default Ollama gives 4k tokens if less than 24 GB of video memory is available (on a Mac, unified memory). Five chunks of 600 tokens plus the prompt and the answer are already about 4k: the tail of the context is cut off without an error, and the judge gives FAIL for an "unsupported" claim whose support simply never arrived. In the native API we set `num_ctx` in `options`; through the OpenAI-compatible endpoint the context size can't be set (it takes `OLLAMA_CONTEXT_LENGTH` when starting the server or a Modelfile with `PARAMETER num_ctx`). We check `ollama ps`: the CONTEXT column and that the model is entirely on the GPU (PROCESSOR). With 8 GB we raise the context carefully, up to 8k: it takes memory too. If it doesn't fit, we reduce k or the chunk size for the local variant and record that in the config.

### Which judge is the main one

| Judge candidate | Pros | Cons | Role |
|---|---|---|---|
| `deepseek-v4-pro`, thinking off | stronger than Flash, stable, cents per run | same family as the `deepseek-flash` answering model | the main judge |
| `deepseek-v4-pro`, thinking on | usually more accurate on hard cases | temperature has no effect, more noise, reasoning is billed as output tokens | a candidate if agreement is higher |
| `deepseek-flash` | two to four times cheaper | judges itself, weaker | only for cheap preliminary checks |
| Claude / OpenAI | strong judges, other families, catch DeepSeek's self-preference | more expensive, need separate keys | a second opinion: a run on our 20 labeled answers |
| a local model in Ollama (4–14B depending on memory) | free, private | weaker than the system being evaluated, needs a large context | not a judge; a learning comparison of agreement, or a judge for private data with a caveat |

The choice is made not by the table but by agreement with our labels: we run 2–3 candidates on the same 20 answers and take the one with the highest TNR (the share of bad answers caught) at an acceptable TPR.

### Cost with cache and peak hours

DeepSeek has three token prices, and two of them depend on the time of day. As of November 2026 (USD per 1M tokens):

| Model | input, cache hit | input, cache miss | output |
|---|---|---|---|
| `deepseek-flash`, peak | 0.006 | 0.30 | 1.20 |
| `deepseek-flash`, off-peak | 0.003 | 0.15 | 0.60 |
| `deepseek-v4-pro`, peak | 0.044 | 1.32 | 3.96 |
| `deepseek-v4-pro`, off-peak | 0.022 | 0.66 | 1.98 |

Peak is Monday to Friday 01:00–04:00 and 06:00–10:00 UTC (except Chinese public holidays); the rest of the time and weekends are off-peak. Caching is automatic: `usage` contains `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. In RAG, what hits the cache is mostly the shared prefix (the assistant's system prompt or the judge prompt); the `kb/` chunks are different for each question.

```python
# eval/cost.py (illustrative); prices.json: {"deepseek-flash": {"peak": {"in_hit":..,"in_miss":..,"out":..}, "offpeak": {...}}, "updated": "2026-11-.."}
from datetime import datetime, timezone

def is_peak(ts: datetime) -> bool:
    # DeepSeek peak hours per pricing page: Mon-Fri 01:00-04:00 and 06:00-10:00 UTC
    t = ts.astimezone(timezone.utc)
    return t.weekday() < 5 and (1 <= t.hour < 4 or 6 <= t.hour < 10)

def deepseek_cost(usage: dict, price: dict, ts: datetime) -> float:
    p = price["peak" if is_peak(ts) else "offpeak"]
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("prompt_cache_hit_tokens", 0)) or 0
    miss = usage.get("prompt_cache_miss_tokens", usage["prompt_tokens"] - hit)
    return (hit * p["in_hit"] + miss * p["in_miss"] + usage["completion_tokens"] * p["out"]) / 1e6
```

The API reference describes the cache fields inside `prompt_tokens_details`, while the response example puts them directly in `usage`, so the code looks in both places. Ollama costs $0 per token: in the report we write "$0 API" for it and the latency on our own hardware.

**The order of magnitude of a run's cost** (an estimate, not a measurement): say each question takes an answer of ~3,500 input + 300 output tokens and two judge calls totaling ~4,400 input + 700 output.

| Configuration | per question, peak | 60 questions, peak | 60 questions, off-peak |
|---|---|---|---|
| Flash answer + Pro judge (no thinking) | ≈ $0.010 | ≈ $0.60 | ≈ $0.30 |
| Flash answer + Flash judge | ≈ $0.0036 | ≈ $0.21 | ≈ $0.11 |
| Ollama answer + Pro judge | ≈ $0.0086 | ≈ $0.51 | ≈ $0.26 |

A judge with reasoning adds output tokens (in `usage.completion_tokens_details.reasoning_tokens`) and can become several times more expensive. We check the estimate against the actual first run. Claude and OpenAI for comparison are costed from their pricing pages with the same code and a different `prices.json`.

### Parallelism and limits

- **DeepSeek** limits not requests per minute but concurrent requests per account (as of November 2026: 2,500 for Flash and 500 for Pro); above the limit it returns HTTP 429. Our `max_workers=6` is far from the limit; retries on 429 are still needed. Until inference starts, the server keeps the connection alive with empty lines (keep-alive) and closes it after 10 minutes, so the client needs a reasonable timeout.
- **Ollama** by default processes requests to one model one at a time (`OLLAMA_NUM_PARALLEL`, default 1); the rest wait in a queue. A `ThreadPoolExecutor` with 6 threads won't speed up a local run but will distort latency: the queue wait gets into it. We run the local model sequentially; raising parallelism with 8–16 GB isn't worth it: memory grows in proportion to parallelism × context.

### Comparing providers for this chapter

| What the script needs | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| A stable judge (`temperature=0`) | yes, with caveats for some newer models | yes, except reasoning models | only with `thinking: disabled` | yes, plus `seed` |
| A verdict by schema | structured outputs / tool use | JSON schema | `json_object` + a check in code | `format` with a JSON schema |
| Tokens in `usage` | input/output + cache tokens | prompt/completion + `cached_tokens` | prompt/completion + `prompt_cache_hit/miss_tokens` | `prompt_eval_count` / `eval_count` in the native API |
| Prompt cache | explicit `cache_control` markers | automatic | automatic | not needed, tokens are free |
| Price depends on time of day | no | no (there are separate batch modes, see the docs) | yes, peak and off-peak | no |
| Limits | RPM/TPM by account tier | RPM/TPM by tier | concurrent requests per account | machine memory and `OLLAMA_NUM_PARALLEL` |
| `logprobs` | no | available for some models | the parameter exists | not through the OpenAI-compatible API |

## Learning path

1. We open [Hamel: Creating a LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) → reread the sections on measuring agreement with an expert and iterating on the prompt (≈20 min). This is the manual for the "check the judge" step.
2. We open [Eugene Yan: Evaluating the Effectiveness of LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/) → the sections on agreement metrics and on evaluating faithfulness/factual consistency (≈30 min). We note how poorly judges do without breaking the answer into claims.
3. We open [Ragas docs](https://docs.ragas.io) → the metrics section; we read the descriptions of faithfulness, context precision, context recall (≈25 min). We compare them with how we defined the metrics above: what they compute differently.
4. We open [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) → the section on graders (code-based, LLM-based) (≈15 min).
5. We open the provider's documentation: how to get `usage` from the response, and the pricing page (≈10 min). We move the prices into `eval/prices.json`.
6. Python reference as needed: [concurrent.futures](https://docs.python.org/3/library/concurrent.futures.html), [argparse](https://docs.python.org/3/library/argparse.html).
7. We open [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode), [JSON Output](https://api-docs.deepseek.com/guides/json_mode), [Context Caching](https://api-docs.deepseek.com/guides/kv_cache), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) (≈30 min). We write down: how to turn thinking off via `extra_body`, the cache fields in `usage`, the peak hours, the concurrent request limit. We move the prices into `eval/prices.json` with a date.
8. We open [Ollama: Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) (the sections on context, parallel requests, keep_alive) and [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈20 min). The main point: the default context depends on memory and can silently cut off chunks.

## What to watch out for

- **A judge without a check is not a metric.** Until the comparison on 20 answers is done, the correctness number means nothing.
- **The same model call for the answer and for the judge** (the same model, the same prompt style) amplifies self-preference. If possible, a judge from a different model, or at least one checked against the labels.
- **A chunk cuts a quote**: hit = 0 even though the answer was found. We look at retrieval misses by hand before drawing conclusions.
- **Does faithfulness penalize a refusal?** The answer "The knowledge base has no answer to this question." contains no claims and must get PASS. We check that the judge does that.
- **The judge matches numbers without the product** ("12 months" is there, but for Light, not Light Mini), and **an archived chunk in the context** gives faithfulness PASS for a wrong answer. The first is caught by manual labeling, the second by the `archived_in_context` counter.
- **Mean latency lies** because of outliers: we look at p50/p90.
- **Prices in code go stale.** A separate price file with an update date.
- **API errors counted as FAIL** distort quality. We count them separately (`errors: 2`) and rerun.
- **Holdout accidentally in the run**: `--split dev` by default.
- **Key leaks**: keys only from the environment/`.env` in `.gitignore`. The run's `config.json` must not contain keys; it is important not to serialize the whole client object.
- **A DeepSeek judge "with temperature 0" in thinking mode**: temperature has no effect, the verdicts are noisy. We turn reasoning off explicitly and record the mode in `config.json`.
- **A judge `ERROR` counted as FAIL.** Empty `content` in DeepSeek's JSON mode and invalid JSON are infrastructure errors, not a bad answer from the system.
- **A local judge with a truncated context** gives faithfulness FAIL to correct answers. We check `num_ctx`/`OLLAMA_CONTEXT_LENGTH` and compare `prompt_eval_count` in Ollama's response with the expected number of tokens.
- **Local model latency with a queue.** With `OLLAMA_NUM_PARALLEL=1` and 6 threads, we measure the queue wait. Plus, the first request after idle time loads the model into memory (by default a model is unloaded after 5 minutes without requests): a warm-up request is needed, and it is not counted.
- **Cost without peak hours and cache** is off by several times. We store the call time and the cache fields in `results.jsonl`.

## Practice

Code: `projects/02-support-kb-rag/eval/` and changes in `rag/pipeline.py`.

- [ ] We make the pipeline configurable: `ask(question, cfg=None)`, with `chunks` (with `text`, `url`, `category`, `archived`) and `usage` in `Answer`. The base config is `eval/configs/baseline.json`; `app.py`, `bot.py`, `ask.py` don't change.
- [ ] `eval/metrics.py`: `normalize`, `is_relevant`, `retrieval_metrics`; we switch `eval/run_retrieval_eval.py` to them. We write 3–4 unit tests (pytest or plain `assert`s): the example with the table from the theory must give hit 0.67 and MRR 0.44; a chunk "Tea  By Weight" contains the quote "tea by weight" (case, whitespace).
- [ ] `eval/judges.py`: `judge_correctness` (question, reference, `must_include`, answer) and `judge_faithfulness` (answer, chunks). A binary verdict, critique before the verdict, JSON, a retry on invalid JSON.
- [ ] Handling `unanswerable`: a correct refusal via `Answer.refused` / a false refusal on answerable questions.
- [ ] `eval/run.py`: a run, aggregates overall and by `type` and `category`, the `archived_in_context` counter, the system cost per 100 questions, the judge cost, p50/p90 latency, saving the run folder and a row in `eval/RESULTS.md`.
- [ ] We run the baseline on dev.
- [ ] Checking the judge: we pick 20 answers (among them 2–3 about the Light / Light Mini lamps) and label them ourselves in `eval/judge_labels.jsonl` (id, our verdict, reason) without looking at the judge's verdict. We write `eval/judge_agreement.py`, which prints the 2×2 table, agreement, TPR, TNR and the list of disagreements.
- [ ] We fix the judge prompt based on the disagreements, rerun, and record the agreement before and after in `notes/evals.md`.
- [ ] Traps for the judge: we swap in 3 answers (a return period of "30 days", the Light warranty given for Light Mini, a rule from `returns-2025.md` without the archived chunk in the context). All three must get faithfulness FAIL.
- [ ] (Optional) We run Ragas faithfulness on the same answers and compare it with our judge.
- [ ] The answering model in the baseline config is `deepseek-flash` (`"answer_model": "deepseek-flash"`, `"answer_thinking": false`), the judge is `deepseek-v4-pro` with thinking off; the modes are recorded in `config.json`.
- [ ] `eval/cost.py`: the price accounting for cache hits and peak hours; Ollama is `$0 API`. We check the total of the first run against the billing in the DeepSeek console.
- [ ] A second opinion: a judge on Claude or OpenAI on the same 20 labeled answers (the knowledge base and the dataset are public and made up). In `judge_agreement.py` we print the agreement of both judges with us and with each other.
- [ ] We compare `deepseek-v4-pro` with and without thinking on the 20 labeled answers: agreement, cost, time. We record the choice.
- [ ] (Optional, for learning) We run `judge_ollama` with the largest model that fits in memory on the same 20 answers and see how much worse the agreement is. This is the argument for why a small local model is not a judge.

## Done when

- `python eval/run.py --config eval/configs/baseline.json` with one command prints hit rate, MRR, correctness, faithfulness, the share of correct refusals, cost and latency, saves the run folder with the config, date, dataset version and git commit, and appends a row to `eval/RESULTS.md`.
- The judge is checked against 20 manual labels, the agreement is recorded, the disagreements are analyzed; the three swapped answers (an invented period, merged warranties, an archived rule) get FAIL.
- Metrics are computed by slices (`type`, `category`); `archived_in_context` is zero.
- For the chosen judge, the model, the thinking mode, the agreement with the labels and the run cost from actual `usage` are recorded.

## Self-check quiz

1. Question q: the relevant chunk is at position 4 of 5. What are hit@5, hit@3 and the reciprocal rank?
2. Why is recall@k more useful than hit rate for comparative questions?
3. correctness = PASS, faithfulness = FAIL. What does this mean and why is it a problem?
4. Why doesn't the faithfulness judge need a reference answer?
5. 20 answers are labeled. The judge: 14 PASS, 6 FAIL. Manual labels: 10 PASS, 10 FAIL. The judge agreed with the labels on all of its FAILs. How many bad answers did the judge miss, and what is its share of bad answers caught?
6. Why save `results.jsonl` if there is `summary.json`?
7. Why should model prices be kept in a separate file rather than in code?
8. What is wrong with this code?
   ```python
   def judge(answer, reference):
       r = client.messages.create(model=JUDGE, max_tokens=5,
           messages=[{"role": "user", "content": f"Score 1-10: {answer} vs {reference}"}])
       return int(r.content[0].text)
   ```
9. Why are `unanswerable` questions excluded from hit rate?
10. Why does the report need p50 and p90 latency, not just the mean?
    a) it's customary; b) the mean is sensitive to outliers; c) p90 is cheaper to compute; d) the provider returns only percentiles.
11. Why write our own script first instead of taking Ragas?
12. Why is the `deepseek-v4-pro` judge called with `extra_body={"thinking": {"type": "disabled"}}`? What happens if this is not done but `temperature=0` is kept?
13. A local model on Ollama (an answering model or a learning judge) is much worse on long questions than on short ones. What is the most likely cause, and how do we check it?
14. A DeepSeek run on Tuesday at 07:30 UTC cost twice as much as the same run on Saturday. Is there a bug in `cost.py`?
15. Why does `ThreadPoolExecutor(max_workers=6)` barely speed up a local model run and spoil the latency metric?
16. The answer: "The warranty on LAMP-LIGHT-MINI is 12 months". The context has both lamp pages; 12 months is stated only for Light. The judge gave faithfulness PASS. What is wrong?
17. Why is a judge on `deepseek-v4-pro` acceptable for this dataset even though DeepSeek's servers are in China?

## Answers

1. hit@5 = 1, hit@3 = 0, RR = 1/4 = 0.25.
2. A comparative question needs chunks from two pages (for example, `lamp-light.md` and `lamp-light-mini.md`); hit rate counts a success after finding one, while recall shows that only half was found.
3. The answer is correct but not supported by the retrieved chunks: the model took it from its own knowledge. Next time it will just as confidently make up a wrong fact (for example, the return period), and the source citations will be false.
4. Faithfulness checks the consistency of the answer with the retrieved chunks, not with the truth; for that only the answer and the context are needed.
5. The labels have 10 FAILs; the judge caught 6 of them (all of its FAILs are correct) and missed 4. The share of bad answers caught = 6/10 = 60%.
6. For analyzing errors on specific questions, comparing runs question by question (which questions got better/worse) and checking the judge. Aggregates don't allow this.
7. Prices change and differ between models; a separate file with a date is easy to update, and it shows which prices a run was costed at.
8. A 1–10 scale instead of a binary verdict; no critique (and `max_tokens=5` doesn't allow one); no question and no context; `int()` fails on any extra text; no instruction on what counts as an error; no retries and no structured output.
9. They have no correct chunk, there is nothing to find; their quality is measured by the share of correct refusals.
10. **b.** One stuck request shifts the mean a lot, while percentiles show the typical and the "bad" time.
11. To understand what each metric measures and how the judges work, and to be able to explain the numbers. Ragas is useful later as a cross-check.
12. In thinking mode (it is the default), DeepSeek doesn't apply temperature, and there is no error. Without turning it off, the verdicts will be noisier, plus reasoning is billed as output tokens and slows the run down.
13. A truncated context: by default Ollama gives 4k tokens if there is less than 24 GB of video memory, some chunks are silently dropped, and the model "doesn't see" the needed chunk. Check `ollama ps` (CONTEXT) and `prompt_eval_count` in the response, set `num_ctx` or `OLLAMA_CONTEXT_LENGTH` (carefully when memory is low) or reduce k.
14. No: weekdays 06:00–10:00 UTC are peak hours, with prices twice as high as off-peak (weekends). Long runs are cheaper to schedule off-peak.
15. By default Ollama processes requests to a model one at a time (`OLLAMA_NUM_PARALLEL=1`), the rest wait in a queue; the queue wait ends up in the measured latency.
16. The judge matched the number but not the product: the "LAMP-LIGHT-MINI + 12 months" pair is not in the chunks, the right verdict is FAIL. We fix the judge prompt (a claim includes its subject) and add such cases to the labels.
17. The judge sees only the dataset questions, the references, the answers and the `kb/` chunks: the knowledge base is public, the questions and references are made up, there is no personal data. Answers to real customer messages would be judged only by the local model.

## What's next

In [AIL-30 · LLM observability: Langfuse and promptfoo](AIL-30.md) we make traces and runs visible in a UI, and in [AIL-62](AIL-62.md) we learn to tell which differences in this script's numbers are real.
