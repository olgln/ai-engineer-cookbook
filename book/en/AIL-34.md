# 8.4 · Error analysis: reviewing the errors of an LLM system by hand  (AIL-34)

> **Week 8** · Evals · ⏱ ~4 h · Practice

<!-- description: Error analysis of an LLM system by hand: reading failure traces, open and axial coding of causes, counting frequencies, choosing what to fix first. -->
<!-- source-sha256: 92be4ecae5e4 -->

## Why an AI engineer needs this

After the experiments in [AIL-32](AIL-32.md) and [AIL-33](AIL-33.md), the chosen configuration has a number, for example "correctness 0.78" on a dev set of 56 questions. The metric says how many answers are bad, but not what to fix. Error analysis by hand answers the "why" question: it turns 12 failed questions into a list of causes with frequencies, and the list into a work priority. Hamel Husain calls this step the most underrated and the most valuable in building AI products. In an interview, the story "we read 30 failures, 40% turned out to be one cause, we fixed it and got +N percentage points" shows an engineer, not a framework operator.

## Theory

### Why look with our own eyes instead of inventing metrics

The temptation is to invent one more automatic metric. But we don't know what to measure until we see how the system fails. In [AIL-27](AIL-27.md) there was the loop "look at the data → find error types → write an eval → change the system". Now we take the first and second steps seriously.

An analogy from the shop's life: reviewing customer complaints. The overall figure "8% of requests ended in dissatisfaction" says things are bad, but there is nothing to fix until we open each complaint and see: here the operator gave the old return period, here mixed up the warranties of the two lamps, here calculated delivery from the wrong row of the rate table. The distribution of causes tells us what to fix first.

### The unit of review: the full trace

To find where the chain broke, seeing the question and the wrong answer is not enough: we need every step of the pipeline. For each failure we read in full:

1. the question, its type and trap tags (`tags`);
2. the reference answer, `must_include` and the `evidence` quotes;
3. the retrieved chunks (top-k) with positions, `url`, the `archived` flag, and where the relevant ones are among them;
4. the model's answer, the refusal flag and the handoff to a human operator;
5. the judges' verdicts and critiques.

All of this is already in `results.jsonl` from [AIL-29](AIL-29.md) or in the Langfuse trace ([AIL-30](AIL-30.md)). It is worth building a convenient viewer: reading JSON in the terminal 30 times is tiring, and details start to slip away.

### Open and axial coding

The traces are collected; now we need a way to turn 30 stories we've read into a table of causes without inventing the causes in advance. Hamel borrows two steps from qualitative research:

**Open coding.** We read a trace and write a free-form note about the **first** error in the chain: "question about Light Mini, only `lamp-light.md` in the top-3", "the chunk with the rate is in 2nd place, but the model took the price from the neighboring row of the table", "the reference answer is outdated, `kb/delivery.md` now has a different rate". At this step we don't fit anything into ready-made categories.

Why the first error: errors cascade. If retrieval didn't find the chunk and the model then made up an answer, the root is retrieval; the hallucination is a consequence.

**Axial coding.** Once there are 20–30 notes, we group them into categories. A starting list:

| Category | Sign in the trace | Where to fix |
|---|---|---|
| **R: didn't find the chunk** | No relevant chunk in the top-k | Retrieval: chunking, hybrid, query rewriting, k, reranker, filters |
| **G: found but didn't use** | A relevant chunk is in the top-k, the answer is wrong or a false refusal | Answer prompt, order/format of the context, model |
| **H: hallucination** | The answer contains a fact that is not in the chunks (faithfulness FAIL) | Prompt ("only from the chunks"), model, refusal |
| **D: bad question in the set** | Ambiguous question, wrong/outdated reference answer, wrong quote | The set ([AIL-28](AIL-28.md)) |

Subcategories and new categories will almost certainly appear. Typical ones for a support assistant (almost all match the traps from `tags`):

- **R-wrong-product**: a chunk of a similar product is retrieved: Light instead of Light Mini, `MUG-SOUTH` instead of `MUG-NORTH`;
- **R-partial**: the question needs two pages, one is found, for example the free delivery threshold only from `delivery.md` without `promo.md`;
- **R-archived**: `returns-2025.md` got into the context, and the answer quotes the old return rules (`archived_in_context` > 0);
- **G-refusal**: the chunk is found, but the model answered "The knowledge base has no answer to this question." (a false refusal);
- **G-table**: the right table is in the top-k, but the model took the wrong cell of the rates (zone, weight);
- **G-conflict**: both pages with the threshold are found, and the model gave one figure instead of two;
- **G-no-handoff**: a question with no answer in the knowledge base ("where is my order 1042?"), and the model answered with generalities about statuses instead of refusing and handing off to a human operator;
- **H-promise**: a promise of an action the assistant doesn't perform: "we'll process the return", "we'll refund the money", "here is a promo code".

Separately from the subcategories, a fifth top-level category appears: **J: judge error**: the answer is actually correct (or incorrect), and the judge got it wrong. It matters: some "failures" are failures of the judge. If there are many of them, the judge is fixed first, otherwise all further numbers are false.

### A decision tree for labeling

So that the same trace doesn't land in R one time and in H another depending on our mood, we assign categories by a fixed order of questions:

```
 failure
   │
   ├─ question/reference correct? ── no ──► D
   │
   ├─ answer actually correct? ── yes ──► J (the judge was wrong)
   │
   ├─ relevant chunk in top-k? ── no ──► R (R-wrong-product / R-partial / R-archived / ...)
   │
   ├─ answer contains facts not from the chunks? ── yes ──► H (incl. H-promise)
   │
   └─ otherwise ──────────────────────────────────► G (refusal / table / conflict / no-handoff / ...)
```

The order matters: first we check the set and the judge, then retrieval, then generation. For `unanswerable` we skip the "relevant chunk" step: there is nothing to find.

### How much to read

The goal is 30 failures. On a dev set of 56 questions with correctness 0.78 there are about 12 failures, so usually there are fewer than 30: then we review all of them and add failures from the runs of other configurations in [AIL-33](AIL-33.md) and the "flickering" questions from [AIL-62](AIL-62.md) (PASS in one run, FAIL in another). If there are more, we sample with stratification by type, so as not to review 30 comparative questions and not a single factual one.

The sign that we've read enough is **saturation**: the last 5–10 traces add no new categories.

Separately we read **5–10 successful** answers. This checks the judge from the other side: are there wrong answers among the PASSes? If there are, the judge lets errors through, and correctness is inflated. A typical example is a PASS for "12 months of warranty" in a question about Light Mini, which has 6.

### The distribution of causes

When every trace has a category, we count how many times each one occurred. After labeling it is a simple table:

| Cause | Count | Share |
|---|---|---|
| R-wrong-product | 9 | 30% |
| G-refusal | 6 | 20% |
| R-partial (delivery threshold) | 5 | 17% |
| D (reference/question) | 4 | 13% |
| H-promise | 3 | 10% |
| J | 3 | 10% |
| **Total** | **30** | |

(An illustration.) This table is the result of the review: it tells us what is worth fixing first. It is important to remember: on 30 cases the shares are rough, ±ten or so percentage points. Telling 30% from 20% isn't worth it; telling 30% from 5% is.

### Choosing the fix

We fix the most frequent cause **if** the fix is reasonable in effort. For the example above:

- **R-wrong-product (30%)**: the product is almost always named in the question. The `category` filter from [AIL-60](AIL-60.md) keeps all product cards but doesn't tell one lamp from another. It is worth checking whether the product is recognized in these questions; perhaps "small lamp", "mini light", or the lowercase SKU `lamp-light-mini` are not recognized. The fix: recognizing the product by name, SKU and colloquial variants + a filter or boost by the `doc` of its card (`kb/products/lamp-light-mini.md`).
- **D (13%)**: fixed right away and cheaply, but this is not an improvement of the system, it is an improvement of the set. We fix it, bump the set version, rerun the baseline.
- **J**: we fix the judge prompt and recheck agreement on the labels in `eval/judge_labels.jsonl`.

The order in practice: **D and J first** (otherwise we measure with a crooked ruler), then the most frequent category of the system.

### Measuring the effect

A fix without a measurement is again "we tried it, seems better". A fix is an experiment in the form of [AIL-32](AIL-32.md): a hypothesis ("product recognition with a filter by card will remove most of R-wrong-product, hit@5 +X pp"), a run, a paired comparison, a regression check. Two important questions:

1. **Did the errors of the category we fixed go away?** We recount: of the 9 R-wrong-product, how many pass now.
2. **Did something else break?** Questions that used to pass and started failing. A product filter can spoil comparative questions: "how does the warranty of Light differ from Light Mini?" now searches only one card. And a naive substring search finds Light inside Light Mini and mixes up the products the other way round.

### New evals from the review

Review by hand is expensive, and repeating it after every change won't work. So what we found with our eyes we lock in with code: each category found is a candidate for an automatic check:
- R-wrong-product → the metric "share of chunks in the top-k from the right product's card" (cheap, by `doc` and `source_urls` from the set);
- R-archived → the `archived_in_context` counter (already exists in [AIL-29](AIL-29.md), must be 0);
- G-refusal → the false refusal counter `false_refusals` (also already exists);
- G-conflict → an assertion for questions tagged `conflict`: the answer links to both `kb/delivery.md` and `kb/promo.md`;
- H-promise → an assertion "no promises of actions" ("we'll process the return", "we'll refund the money") for the `action_request` tag;
- answer format → an assertion "there is at least one link `kb/<file>.md#<anchor>`".

This way the set of metrics grows out of real errors, not out of a list in a library.

## DeepSeek and Ollama: how we do it

The review method doesn't depend on the provider. What depends on the provider is the **typical failures** that are easy to mistake for system errors, and who may be shown the traces. Checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com).

### Adding category I: infrastructure

Besides R / G / H / D / J, our stack produces failures (some of them already came up in [AIL-29](AIL-29.md) and [AIL-33](AIL-33.md)) where the culprit is not the RAG logic but the way the model is called. They are worth putting into a separate category **I**, because they are fixed with config, not with the prompt or retrieval:

| Sign in the trace | Provider | What it really is | How to check and fix |
|---|---|---|---|
| Empty `content`, verdict `ERROR` counted as FAIL | DeepSeek JSON mode | documented behavior: with invalid JSON the response may be empty | retry; count `ERROR` separately |
| Verdicts on the same answer differ between runs | DeepSeek | the judge is in thinking mode, temperature has no effect | `thinking: disabled` in the judge config |
| The answer ignores a chunk that was definitely in the top-k | Ollama | the server context is smaller than the prompt, the tail is cut silently (4k by default if there is less than 24 GB of video memory) | `prompt_eval_count` in the response against the expected number of tokens, `ollama ps` |
| Timeouts, 429, suddenly slow answers | DeepSeek / Ollama | DeepSeek's concurrent request limit; for Ollama, the queue, loading the model after idle time, swapping with 8 GB of memory | a log of retries and timings, warm-up, a sequential run |
| An answer in English to a non-English (e.g. Russian) question, a broken link format | more often the local 4B | a weak model follows the instruction worse | this is G (the model), not I; we note a slice by language (`ru`/`en`) |
| Results "drifted" between weeks with the same config | DeepSeek | a different version now sits under the model name | compare `resp.model` across runs |

The order in the decision tree extends: **I first** (infrastructure), then D (the set), J (the judge), R, H, G. A failure caused by a truncated context, labeled as G-refusal, sends us to rewrite a prompt that has nothing to do with it.

### Help from a model in the review, with caveats

We do open coding ourselves: that's the whole point. But at the axial coding step a model can help group the 30 notes into draft categories. For project 3 this can be done in `deepseek-flash`: the traces contain only made-up questions and the public knowledge base `kb/`. A rule for the future: when the review moves to the order-investigating agent (project 4), traces with the shop's database snapshot, which holds customers' personal data, are not sent to DeepSeek or other clouds. A local 3–4B model (a machine with 8 GB) is rather weak for grouping, so there we group ourselves or work on the demo database without personal data.

### A second opinion for category J

If we suspect an error of the `deepseek-v4-pro` judge, we run the disputed traces (5–10 of them) through a judge from another family, Claude or OpenAI (the data is public), and compare with our own decision. If the other judge agrees with us and DeepSeek doesn't, that's a strong argument for fixing the judge prompt. A local 3–4B model is not fit for this role: it is weaker than the system being evaluated.

| What the review needs | Claude | OpenAI | DeepSeek | Ollama (4B, 8 GB) |
|---|---|---|---|---|
| Typical failures that are "not system errors" | parameter restrictions on some models | reasoning models reject sampling parameters | empty JSON, thinking and temperature, version change under the name | context truncation, warm-up, queue, swapping |
| Help with grouping notes | yes (public data) | yes (public data) | yes (public data) | private, but weak |
| Second opinion on J | yes | yes | this is the main judge | no, too weak |
| Traces with customers' personal data | no | no | no, servers in China | yes, but low quality |

## Learning path

1. [Hamel: A Field Guide to Rapidly Improving AI Products](https://hamel.dev/blog/posts/field-guide/) → the sections on error analysis and on the data viewer (≈30 min). We pay attention to the idea that the best tool is a simple one built for our own data.
2. [Hamel: AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) → the questions on error analysis, open coding / axial coding and how many traces to read (search the page for "error analysis", "axial") (≈30 min).
3. In [Hamel: Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) we reread the section on looking at data and the tools for it (≈10 min).
4. (Optional) [Who Validates the Validators?](https://arxiv.org/abs/2404.12272) (Shankar et al.) → the introduction and conclusions (≈20 min): about criteria drift, which we will experience ourselves during labeling.
5. We open our own results: the last run of the chosen configuration from [AIL-33](AIL-33.md) (`eval/runs/<...>/results.jsonl`) or the traces in Langfuse.
6. In chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md) we reread the "DeepSeek and Ollama" section (≈10 min): empty JSON, thinking and temperature, Ollama context truncation are candidates for category I.
7. [Ollama API: /api/chat](https://docs.ollama.com/api/chat) (≈10 min): we find the `prompt_eval_count` and `eval_count` fields in the response; they show whether the whole context reached the local model.

## What to watch out for

- **Fitting into ready-made categories.** We start with open notes; the categories form afterwards.
- **Labeling the consequence, not the root.** A hallucination after a retrieval miss is R, not H.
- **Ignoring judge errors.** If 20% of "failures" are judge errors, all metrics are off by that amount.
- **Fixing the reference answer to match the system's answer.** We change a reference answer only when it is objectively wrong (checked against `kb/`), and write the reason in `notes`.
- **A one-off fix for a single question** ("if they ask about the mini lamp warranty, take section X") is fitting to the set. A fix must be a general mechanism.
- **Shares on 30 cases are rough.** We draw no conclusions from a difference between 20% and 17%.
- **Reading without writing down.** An hour later nobody remembers what was in the 7th trace. We label straight into a file.
- **Stopping at the distribution.** The goal of the chapter is one fix with a measured effect.
- **An infrastructure failure labeled as a model error.** Ollama's truncated context, DeepSeek's empty JSON, a judge in thinking mode: category I first.
- **A false refusal and a missed handoff are different errors.** G-refusal spoils answers to questions whose answer is in the knowledge base; G-no-handoff leaves the customer without an operator. A prompt edit against one easily amplifies the other: we watch both counters.
- **Personal data in a cloud "labeling assistant".** In project 3 the traces are public; in project 4 they are not.

## Practice

- [ ] We write `eval/review_failures.py`: it takes a run's `results.jsonl`, selects the failures (correctness FAIL, a wrong refusal, a missed handoff to a human operator), samples up to 30 with stratification by `type`, and shows one trace at a time in readable form: the question and `tags`, the reference answer, the quotes, the top-k with positions, `url` and a mark on the relevant and archived ones, the answer, the judges' critiques. Right away we add output of `resp.model`, the thinking mode, `usage` (for Ollama, `prompt_eval_count`) and the number of retries: without them category I can't be seen.
- [ ] For each trace we write to `eval/error_labels.jsonl`: `id`, `note` (a free-form note about the first error), later `category`, `subcategory`.
- [ ] We read all 30, notes only (open coding).
- [ ] We group the notes into categories (axial coding): we start with R / G / H / D and add J, I and subcategories as needed. I is checked first in the decision tree. We put the categories into the file.
- [ ] (Optional) We ask `deepseek-flash` to group our 30 notes into draft categories and compare with our own grouping. Only for the public traces of project 3.
- [ ] We read 5–10 successful answers; wrong PASSes we find are marked as J.
- [ ] For 5–10 disputed cases of category J we get a second opinion from a judge of another family (Claude or OpenAI) and write down which decision we agree with.
- [ ] The script prints the distribution of causes (count and share), also by `type` and by `tags`. We save the table to `experiments/EXP-03-error-analysis.md`.
- [ ] We fix D and J (the set → a new version; the judge prompt → a repeated agreement check). We rerun the baseline of the chosen configuration on the new version of the set.
- [ ] We pick the most frequent cause in the system and write down a fix hypothesis and the expected effect.
- [ ] We implement the fix (as a general mechanism, not for specific questions), run the evals and compare with `compare.py`: how many questions of the fixed category pass now, what regressions appeared, the paired test.
- [ ] We add at least one new automatic metric or assertion for a category found to `eval/run.py`.
- [ ] We add a row to the experiments table.

## Done when

- 30 failures are labeled, and there is a distribution of causes (a table with counts and shares).
- Errors of the set and the judge are fixed (if there were any), the set version is bumped.
- One fix of the most frequent cause with a measured effect: how many errors of the category went away, Δ of the metrics, regressions, the paired test.

## Self-check quiz

1. How does error analysis by hand differ from computing metrics, and why are both needed?
2. Retrieval didn't find the chunk, the model made up an answer. Which category, and why?
   a) H, because the answer has a made-up fact; b) R, because it is the first error in the chain; c) G; d) D.
3. What are open and axial coding?
4. Why are errors of the set and the judge fixed first, and those of the system after?
5. How do we know enough traces have been read?
6. Why read a few successful answers during error analysis?
7. What is wrong with this fix?
   ```python
   if "mini" in question.lower() and "warrant" in question.lower():
       chunks = [c for c in chunks if c["section"] == "Products > Light Mini Lamp > Warranty"]
   ```
8. After fixing the R-wrong-product category, hit@5 went up, but comparative questions about the two lamps started failing. What most likely happened?
9. The review gives: R 30%, G 20%, D 13%. Can we claim that R occurs one and a half times as often as G?
10. How do the results of the review turn into new evals? An example.
11. In the review, 6 of 30 failures are the local model "ignoring" a chunk that was in the top-k. Which category should they be assigned to first, and how is it checked?
12. Why can the traces of project 3 be given to `deepseek-flash` for draft grouping of notes, but the traces of the project 4 agent cannot?

## Answers

1. Metrics say "how many" errors, the review says "why"; without causes it's unclear what to fix, without metrics the effect of a fix can't be measured.
2. **b.** Errors cascade; the root is in retrieval, and the hallucination is a consequence of the missing chunk.
3. Open coding is free-form notes about the first error in each trace without ready-made categories; axial coding is grouping the notes into categories and counting their frequencies.
4. Otherwise we measure with a crooked ruler: wrong reference answers and judge errors distort both the distribution of causes and the effect of any fix.
5. By saturation: the last 5–10 traces add no new categories.
6. To find the judge's false PASSes (for example, "12 months" in an answer about Light Mini): if there are wrong answers among the successful ones, correctness is inflated and the judge needs fixing.
7. A one-off hardcode for a specific question from the set: fitting that doesn't generalize, is fragile (typos, "small lamp", the SKU `LAMP-LIGHT-MINI`, other wordings) and can break neighboring questions. A general mechanism is needed: recognizing the product in the question and filtering by that product's card.
8. The filter keeps one card, while a comparative question needs two: the filter must take all mentioned products into account (and not find Light inside Light Mini as a separate product).
9. No: on 30 cases this is 9 versus 6, a difference within the noise. We can only say that both categories are frequent.
10. Each frequent category gets an automatic check, for example R-wrong-product → the share of chunks in the top-k from the right product's card by the `doc` metadata; G-conflict → an assertion on links to both `kb/delivery.md` and `kb/promo.md`; H-promise → an assertion that there are no promises like "we'll process the return".
11. First check category I: whether Ollama's context is truncated (4k by default if there is less than 24 GB of video memory). Compare `prompt_eval_count` with the expected number of prompt tokens and look at `ollama ps`. Only if the context arrived in full is it G.
12. In project 3 the traces contain only made-up questions and the shop's public knowledge base. The project 4 agent reads the shop's database snapshot with customers' personal data, and DeepSeek processes data on servers in China; customers' personal data is not sent to the cloud, such traces are reviewed locally.

## What's next

All the experiments are done. In [AIL-35 · Project 3: an experiments table in the README](AIL-35.md) we put them together into a history of improvements in numbers for the portfolio.
