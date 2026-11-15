# 6.3 · Golden dataset: 50–100 questions with reference answers  (AIL-28)

> **Week 6** · Evals · ⏱ ~4 h · Project

<!-- description: A golden dataset for RAG: 50–100 questions with reference answers, four question types, a coverage matrix, source grounding, dev/holdout, versions. -->
<!-- source-sha256: 430c73ca5ec2 -->

## Why an AI engineer needs this

The test set (golden dataset) is the foundation of every experiment in project 3. Every claim like "the reranker helped" or "chunks by heading are better" will rest on this file, and if the set is skewed, every conclusion is skewed too. An interviewer will ask "how did you build your eval set, and why do you trust the reference answers?", and the answer "70 questions, each checked by hand, four types, every knowledge-base trap, with source grounding" sounds professional.

## Theory

### What a golden dataset is

It is a fixed, versioned list of examples: the input (a question), the expected result (a reference answer) and what is needed for an automated check (where in the knowledge base the answer lives). The analogy from ordinary development: the fixtures in `tests/` that the tests run against. The difference is that the expected result is not an exact value but a meaning, checked by metrics and a judge.

We already have a start: `eval/golden.jsonl` from [5.1 · Query rewriting in RAG: multi-query, HyDE, filters](AIL-60.md), 20 lines of `{"q", "category", "must_contain"}`. These lines check only retrieval: whether a chunk with the right words was found. Now we grow the set to 50–100 questions and add a reference answer to each, so that we can check the assistant's answer itself as well. First we work out which questions are needed (types and coverage), then where to get them, how to write a reference answer and the source grounding, and at the end we put it all together into a record schema with a validator.

The quality of the set matters more than its size. 60 precise, varied, unambiguous questions are more useful than 300 generated in a hurry: a noisy reference gives a noisy metric, and an improvement can no longer be told apart from chance.

### Four question types

Questions differ in how many places in the knowledge base an answer needs and whether the answer is there at all. We already met these four types in [AIL-61](AIL-61.md), when we generated synthetic data.

**Factual (`factual`).** The answer is one fact from one section. "How many days do I have to return unopened tea?", "how much is delivery of 3 kg to another city?" (one cell of the rates table). The simplest, but they are the majority in real life.

**Comparative (`comparative`).** They need facts from two pages. "How does the warranty on the Light Lamp differ from the Light Mini Lamp?", "From what amount is delivery free?" (different numbers in `delivery.md` and `promo.md`). This is hard for retrieval: two chunks have to be found, and vector search often brings both from the same page.

**Multi-hop (`multi_hop`).** The answer is assembled from several facts on one or several pages. "My Light Mini Lamp stopped turning on after a month: is it a return or a warranty case, and how do I file a claim?"

**No answer in the knowledge base (`unanswerable`).** `kb/` has no answer: off-topic ("which delivery service is the most reliable?"), about a specific order ("where is my order 1042?"), about something the shop doesn't sell ("warranty on coffee machines"). The reference: the refusal phrase "The knowledge base has no answer to this question." and a handoff to a human operator. Without such questions there is no way to know whether the model hallucinates when retrieval brought back something irrelevant.

### Coverage: the matrix of the set

Once the types are clear, we decide how many questions of each type are needed. The set has to cover what customers really ask and where the system breaks. We build a "type × category" matrix (the categories come from the `kb/` front matter) and track how it fills up:

| Type \ Category | delivery | payment | returns | warranty | promo | orders | products | Total |
|---|---|---|---|---|---|---|---|---|
| factual | 4 | 3 | 4 | 3 | 3 | 3 | 4 | 24 |
| comparative | — | — | — | — | — | — | — | 12 (page pairs) |
| multi_hop | 2 | 1 | 2 | 2 | 1 | 1 | 3 | 12 |
| unanswerable | — | — | — | — | — | — | — | 10 |
| **Total** | | | | | | | | ~58 + synthetic |

The numbers are a guideline, not a law. What matters is that no cell is empty and no type dominates.

The second axis is the **knowledge-base traps** we built into `kb/` in [AIL-19](AIL-19.md) and [AIL-20](AIL-20.md). We tag them and count them too. The reference for a trap describes behavior, not just a fact:

| Tag | Reference | Minimum |
|---|---|---|
| `archived` | based on `returns.md`, not `returns-2025.md`; if the customer asks about the old rules themselves, based on the archive with the note "these are the old rules" | 3 |
| `table` | one cell of the delivery rates table or the warranty periods table | 5 |
| `similar_products` | the fact for exactly that product: Light or Light Mini, `MUG-NORTH` or `MUG-SOUTH` | 4 |
| `conflict` | the free delivery threshold: both numbers, `delivery.md` and `promo.md` in the quotes | 2 |
| `action_request` | "process my return", "give me a promo code": the rule from the knowledge base, no promises of actions | 3 |

Besides traps, it is useful to tag additional "slices": the language of the question (e.g. en/ru), conversational style and typos, an exact identifier (`LAMP-LIGHT-MINI`, `TEA15`) or only the meaning, numbers (rates, periods, amounts). Later, in [AIL-34](AIL-34.md), we will see that errors cluster along such slices.

### Where to get questions

The matrices say how many questions are needed; we fill them from four sources:

- **The knowledge base itself and the brief.** We read the `kb/` pages and `kb-brief.md` through a customer's eyes and write in the customer's words, not in page headings.
- **Project 2 logs.** Questions we ourselves asked the assistant through `ask.py`, `app.py` or the bot.
- **Errors.** Questions project 2 answered badly (the list from [AIL-27](AIL-27.md), the `eval/ANSWERS.md` rows marked "no"). We always include them: a set on which the system gets everything right is useless.
- **Synthetic data**, reviewed by hand in [AIL-61](AIL-61.md). It is already generated in this set's schema (see "Record schema" below), so when merging, only `split` is left to fill in.

Real customer questions (if we have our own data) go in only rewritten as a general question, without personal data.

### The reference answer: how to write it

For each question we write a reference: the judge in [AIL-29](AIL-29.md) will compare the assistant's answer against it. The reference must be **checkable**. Bad: "Delivery to another city is inexpensive and depends on the weight." Good: "By courier to zone 2, a 1–3 kg parcel costs $4.70 [kb/delivery.md#rates-by-weight-and-zone]." The rules:

1. Short: 1–3 sentences with the key fact.
2. Numbers with units ($, kg, days), SKUs, promo codes and delivery service names exactly as in `kb/`.
3. If the answer depends on conditions (weight, zone, payment method, whether the package is opened), we state the condition.
4. We add a `must_include` field: 1–3 key facts without which the answer is wrong. The judge in [AIL-29](AIL-29.md) will check exactly these, which makes it stricter and more stable.

Not to be confused: `must_contain` is what the **retrieved chunk** contains (retrieval), `must_include` is what the **answer** contains (generation).

### Source grounding that survives rechunking

The reference checks the answer; what is left is to record where in the knowledge base that answer lives. Retrieval metrics need to know which chunk is the right one. The naive option is to store the chunk key `chunk_key`. The problem: it is computed as `sha256(url + section + text)`, and in [AIL-32](AIL-32.md), when the chunking strategy changes, all the keys will change. So we store:

- `source_urls`: knowledge-base sections in the same form as a chunk's `url`: `kb/<file>.md#<anchor>`;
- `evidence`: a list of verbatim quotes from `kb/` (one per required fact; a comparative question has at least one from each page);
- `source_chunk_keys`: the keys in the current `index.db`, as a convenience.

A chunk counts as relevant if it **contains the quote** (after normalizing whitespace and case). Then, with any chunking, the right chunks are recomputed automatically. `must_contain` can't do this: it requires all strings in one chunk, and a question across two pages has two chunks. A caveat: if a chunk boundary cuts a quote, no chunk contains all of it. We keep quotes short (one sentence with the fact) and count as a hit a chunk that contains most of the quote, for example 80% of its characters in a row. For tables, the quote is the whole table row: "| 1–3 | $3.50 | $4.70 | $5.90 |".

### Record schema

Now we gather everything above into one record. `eval/golden.jsonl`, one line is one JSON object. The week 5 fields stay so that its scripts keep working; the rest are added:

```json
{
  "id": "q-017",
  "q": "how much 2 send 3 kilos to another city by courier?",
  "category": "delivery",
  "must_contain": ["1–3", "$4.70"],
  "reference_answer": "Courier delivery to zone 2 (other cities) for a 1–3 kg parcel costs $4.70.",
  "must_include": ["$4.70", "zone 2"],
  "evidence": ["| 1–3 | $3.50 | $4.70 | $5.90 |"],
  "source_urls": ["kb/delivery.md#rates-by-weight-and-zone"],
  "source_chunk_keys": ["3f9a…"],
  "type": "factual",
  "handoff": null,
  "difficulty": "medium",
  "tags": ["table", "colloquial", "numbers", "en"],
  "origin": "manual",
  "reviewed": true,
  "split": "dev",
  "notes": ""
}
```

Important: the reference in the example illustrates the format. Everyone has their own rates, thresholds and anchors; we write references from our own `kb/`.

For `unanswerable`: `reference_answer` is exactly the refusal phrase `REFUSAL`; `evidence`, `source_*` and `must_contain` are empty. The new `handoff` field is the reason the code hands the question to a human operator: `"refused"` (the model refused) or `"personal_data"` (`contains_personal_data` fired and the cloud model was not called, as with "where is my order 1042?"). Answerable questions have `handoff: null`.

### dev and holdout

We split the set into two parts:
- **dev** (~70%): here we look at errors, tweak prompts and choose a configuration.
- **holdout** (~30%): we don't look at it at all; we run it only at the end, for the final number in the README.

Why: if we tune the configuration ten times in a row on the same 60 questions, the system fits itself to them, and the number becomes optimistic. Holdout shows the honest number. More on this in [AIL-62](AIL-62.md). We split in a stratified way: both parts must contain all types and traps. The 13 questions on which we checked answers in [AIL-23](AIL-23.md) (`eval/ANSWERS.md`) we have already seen many times, so they go to dev.

### Versioning

The set lives in git next to the code. The rules:
- The set changes only through a commit with a clear message ("golden v3: fixed reference for q-031, +8 comparative").
- Every run's report records the version of the set (a file hash or a git commit). Metrics on different versions of the set are not compared directly.
- If we find a wrong reference in [AIL-34](AIL-34.md), we fix it, bump the version and rerun the baseline configuration.

### Validating the file

JSONL is easy to break by hand. We write a validator and run it before every run (it is a level-one assertion from [AIL-27](AIL-27.md), only for data):

```python
# eval/validate_golden.py  (sketch)
import sys
from typing import Literal
from pydantic import BaseModel, field_validator

from rag.answer import REFUSAL
from rag.privacy import contains_personal_data

Category = Literal["delivery", "payment", "returns", "warranty", "promo", "orders", "products"]

class Item(BaseModel):
    id: str
    q: str
    category: Category | None
    must_contain: list[str] = []
    reference_answer: str
    must_include: list[str] = []
    evidence: list[str] = []
    source_urls: list[str] = []
    source_chunk_keys: list[str] = []
    type: Literal["factual", "comparative", "multi_hop", "unanswerable"]
    handoff: Literal["refused", "personal_data"] | None = None
    difficulty: Literal["easy", "medium", "hard"]
    tags: list[str] = []
    origin: Literal["manual", "synthetic"]
    reviewed: bool
    split: Literal["dev", "holdout"]
    notes: str = ""

    @field_validator("reviewed")
    @classmethod
    def must_be_reviewed(cls, v: bool) -> bool:
        if not v:
            raise ValueError("every item must be reviewed by a human")
        return v

def main(path: str = "eval/golden.jsonl") -> None:
    seen: set[str] = set()
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        item = Item.model_validate_json(line)
        assert item.id not in seen, f"line {n}: duplicate id {item.id}"
        seen.add(item.id)
        if item.type == "unanswerable":
            assert item.reference_answer == REFUSAL, f"{item.id}: reference must be REFUSAL"
            assert item.handoff, f"{item.id}: unanswerable needs a handoff reason"
        else:
            assert item.evidence and item.source_urls, f"{item.id}: no evidence/source"
        # invented personal data is allowed only where we test the routing
        assert contains_personal_data(item.q) == (item.handoff == "personal_data"), \
            f"{item.id}: personal data check disagrees with handoff"
    print(f"OK: {len(seen)} items")

if __name__ == "__main__":
    main(*sys.argv[1:])
```

We extend it with a check that every `evidence` quote is found in some chunk of the current `index.db` (otherwise the quote has a typo or the `kb/` page has changed) and does not come from the archive (except for questions tagged `archived`), and with printing both coverage matrices.

## DeepSeek and Ollama: how we do it

The set doesn't depend on the provider: `golden.jsonl`, the schema, the validator and the split are the same for Claude, OpenAI, DeepSeek and Ollama. That is exactly why it can later be used to compare providers fairly. Little changes (checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com)):

- **We record which model produced the synthetic data**, and not just the name from the config but `resp.model` and the date (the `generator` field from chapter [6.2 · Synthetic data for evals](AIL-61.md)). DeepSeek reassigns names: `deepseek-flash` is currently served by V4.1-Flash-1017, and old names are redirected to new models.
- **An ambiguity helper.** `deepseek-flash` with reasoning turned off can cheaply (cents for the whole set) list the possible interpretations of each question: "warranty on which lamp, Light or Light Mini?". This is a hint, not a judge: the decision and the reference are still ours. The questions are invented and about a public knowledge base, so they can be sent.
- **Every question in the set will go to DeepSeek on every run.** So the set has no real customer requests, only general questions. DeepSeek's servers are in China, but the rule applies to any cloud provider. Questions with `handoff: "personal_data"` contain invented data and test the routing: in `ask()`, `contains_personal_data` intercepts them before the cloud, and the helper scripts skip them.
- **Checking quotes against the index** works with whatever index we have; embeddings are computed by Ollama (`bge-m3`), so everything is local and free.

| | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Affects the set's format | no | no | no | no |
| How it helps while building | ambiguity check (for comparison) | the same | cheap ambiguity check, synthetic data generation | embeddings for checking quotes and duplicates; drafts from real customer requests |
| What must not be sent | customer data | customer data | customer data; servers in China | anything goes, data never leaves the computer |

## Learning path

1. We reread our notes `notes/evals.md` from [AIL-27](AIL-27.md) and `eval/ANSWERS.md` from [AIL-23](AIL-23.md) (≈10 min): which kinds of errors we expect from project 2.
2. We open [Hamel: AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) → the questions about the size of the set and how to build it (search for "dataset") (≈20 min). Worth noting: starting with a small set and growing it as errors are found is normal.
3. We open [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) → the sections on building test cases and edge cases (≈20 min). From here we take the list of edge-case kinds (ambiguous input, irrelevant input, long input).
4. We open [Pydantic: Models](https://docs.pydantic.dev/latest/concepts/models/) → `model_validate_json` and `Literal` fields (≈15 min), if we haven't worked with them in weeks 1–2.
5. Then hands-on work: building the set itself takes most of the task's time.
6. We open [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and the news section on [api-docs.deepseek.com](https://api-docs.deepseek.com) (≈10 min): we look at how models get renamed and reassigned. This is where the rule of recording `resp.model` and the date comes from.

## What to watch out for

- **An ambiguous question is a source of endless noise.** "How much is delivery?": by which service, what weight, which zone? "What is the warranty on the lamp?": Light or Light Mini? The judge will give random scores. We rewrite or delete such questions.
- **A reference from memory, not from the knowledge base.** We wrote our `kb/` ourselves, but pages change: a rate gets updated, a threshold moves. We check every reference against the current page and record the quote.
- **A set of only easy questions** gives 95% and the feeling that everything is done. We add comparative questions, traps and questions with no answer in the knowledge base.
- **Category imbalance.** If 40 of 60 questions are about delivery, the overall number describes delivery.
- **Holdout leakage.** We looked at the errors on holdout and fixed the prompt: holdout is no longer holdout. Then we honestly move those questions to dev and build a new holdout.
- **Customer data doesn't belong here.** Nothing from `data/shop.db`, `outputs/handoff.jsonl` or real customer requests; invented phone numbers and order numbers only in questions with `handoff: "personal_data"`.
- **Never "fix" a reference to match the system's answer** when the system is wrong. We fix a reference only when it is wrong itself, and write down why in `notes`.

## Practice

We work in `projects/02-support-kb-rag/eval/`.

- [ ] We draw the coverage matrix (type × category) and the traps table in `notes/evals.md` with target numbers.
- [ ] We convert the 20 lines from [AIL-60](AIL-60.md) to the new schema and add 3 questions with no answer in the knowledge base from [AIL-23](AIL-23.md) (two with `handoff: "refused"`, "where is my order 1042?" with `"personal_data"`).
- [ ] We write more by hand, up to 30–50 questions: first the ones project 2 got wrong, then we fill both matrices. At least 8 comparative and 8 unanswerable, traps at least at the minimum from the table.
- [ ] For each one: we find the answer in `kb/`, write down `reference_answer`, `must_include`, verbatim `evidence` quotes and `source_urls` with anchors.
- [ ] We add 20–50 reviewed synthetic questions from `eval/synthetic_reviewed.jsonl` ([AIL-61](AIL-61.md)), bringing them to the common schema.
- [ ] We write `eval/validate_golden.py` (schema, unique IDs, quotes present in `index.db` and not from the archive, `handoff` consistent with `contains_personal_data`, printing both matrices).
- [ ] An `eval/split.py` script: stratified by `type`, it fills in `split` (dev ~70%, holdout ~30%) with a fixed seed. After that we don't open holdout.
- [ ] We run the validator and `run_retrieval_eval.py` from week 5 and fix the errors.
- [ ] We commit `eval/golden.jsonl` (version v1) and record its composition in `notes/evals.md`: how many questions by type, category, trap, origin.
- [ ] The next day we reread 10 random questions with fresh eyes: are they unambiguous?

- [ ] (Optional) An `eval/ambiguity_check.py` script: `deepseek-flash` (thinking off, JSON mode) returns `{"ambiguous": bool, "interpretations": [...]}` for each question. It skips questions with `handoff: "personal_data"`. We review every `ambiguous: true` and decide ourselves whether to rewrite the question.
- [ ] We check that the questions and references contain no real customer data: the whole set will go to a cloud model on every run.

Expected result: a file of 50–100 lines; the validator prints `OK` and matrices without empty cells.

## Done when

- `eval/golden.jsonl` contains 50–100 questions, each with `reviewed: true`, a reference, `must_include`, quotes and `kb/<file>.md#<anchor>` links (except `unanswerable`, whose reference is the refusal phrase and which have `handoff` set).
- All four types, all seven categories and all five traps are represented; there is a dev/holdout split.
- The validator passes, the week 5 scripts work on the new file, and the set is committed with a version.

## Self-check quiz

1. Why does the quality of the set matter more than its size?
2. Why does the set need questions with no answer in the knowledge base, and what is their reference?
3. Why shouldn't `chunk_key` be the only pointer to the right chunk?
4. What is holdout for, if there is dev?
   a) to make the set bigger; b) to get an honest estimate not fitted to the set; c) to check the judge; d) for synthetic questions.
5. What is `must_include`, how does it differ from `must_contain`, and how does it help the judge?
6. What is wrong with this record?
   ```json
   {"id": "q-5", "q": "What is the warranty on the lamp?", "reference_answer": "Depends on the lamp",
    "type": "factual", "category": null, "reviewed": false}
   ```
7. The references of 5 questions were fixed. Can the new metrics be compared directly with the old runs?
8. Which question type is especially hard for vector search, and why?
9. How should the validator behave if a rate on the `kb/delivery.md` page changed and a quote is no longer found?
10. The errors on holdout were reviewed 10 times while the prompt was being improved. What should be done?
11. Why is it worth including questions the system already gets wrong?
12. Why should the record of a synthetic question store `resp.model`, not just `"deepseek-flash"` from the config?
13. We want to add a real request to the set: "I'm Sarah Miller, +1 (555) 013-…, I paid $23.40 by card for order 1187, returned the lamp, where's my money?". What is wrong, and how should it be rewritten?

## Answers

1. Noisy or wrong references give a noisy metric: an improvement can't be told apart from chance, and reference errors pass for system errors.
2. To check that the system doesn't hallucinate when there is no answer. The reference is the exact refusal phrase "The knowledge base has no answer to this question.", and the `handoff` field sets the reason for the handoff to a human operator (`refused` or `personal_data`).
3. `chunk_key` is computed from the chunk's text and section and changes when the chunking changes. An `evidence` quote makes it possible to recompute the right chunks for any index.
4. **b.** Holdout takes no part in choosing the configuration, so its number is not fitted.
5. A list of key facts without which the answer is wrong. `must_contain` describes the retrieved chunk (retrieval), `must_include` describes the answer (generation). The judge checks specific items rather than "does it look similar overall", so it is stricter and more stable.
6. The question is ambiguous (Light or Light Mini), the reference can't be checked, the type is wrong (comparing two lamps is comparative), `category` is empty although the question is clearly about warranty, there are no quotes or links, `reviewed: false`, and `must_contain`, `must_include`, `handoff`, `difficulty`, `origin`, `split` are missing.
7. No. A different version of the set is a different task. The baseline configuration has to be rerun on the new version, and comparisons are made against that.
8. Comparative: they need chunks from two pages, and vector search on a single query often brings similar chunks from one page (especially with similar lamps). Multi-hop too: the second chunk may not look like the question.
9. It should fail or warn: the quote is outdated, so the reference has to be updated from the new page and the set's version bumped (or the index rebuilt, if `index.db` is outdated).
10. Holdout is compromised. Move those questions to dev and build a new holdout from new questions that haven't been looked at.
11. A set on which everything passes measures nothing: no improvement will be visible. Known errors are the main thing we want to fix and track as regressions.
12. A DeepSeek model name can point to different versions over time (`deepseek-flash` is currently V4.1-Flash-1017, old names are redirected). `resp.model` and the date show what actually produced the question and explain changes on regeneration.
13. This is a real customer's personal data: the set lives in git, and the questions go to a cloud model (DeepSeek, servers in China) on every run, while the regex-based `contains_personal_data` doesn't catch everything (it won't notice the name "Sarah Miller"). Besides, such a question tests one case, not the knowledge base. Rewrite it as a general question to the knowledge base: "How many days does it take to get the money back for a returned item if the order was paid by card?"

## What's next

In [AIL-29 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md) we write `eval/run.py`, which runs this set through `ask()` and computes hit rate, MRR, correctness and cost with one command.
