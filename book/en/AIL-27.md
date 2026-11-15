# 6.1 · LLM evals: the key articles and LLM-as-judge  (AIL-27)

> **Week 6** · Evals · ⏱ ~4 h · Theory

<!-- description: Evals for LLM products: three levels of evaluation, the improvement loop, kinds of checks and an LLM-as-judge worth trusting. Project 3 begins. -->
<!-- source-sha256: 21721aac7bb9 -->

## Why an AI engineer needs this

Evals (quality evaluations) are what separate an LLM product from a demo that "seems to work". Without them there is no telling whether things got better after a change of prompt, model or chunking, and the system can't be changed safely. In interviews the question "how do you evaluate the quality of your system?" comes up almost every time, and the answer "I eyeballed it" gives away a beginner at once. This chapter starts Project 3: evals for the Shelf shop's support assistant from project 2.

## Theory

### Why "checked by hand on 5 examples" is not an evaluation

In project 2 we evaluated the assistant's answers by hand on 13 questions. To see what such a check is missing, let's start with ordinary code without an LLM. Say we changed the `order_total` formula in the shop's code (discount, promo code, delivery) and checked it on five orders. All five matched. Does that mean the formula is correct? No:

1. **The sample is small.** Five examples don't cover the edge cases: tea by weight (`unit = 'g'`, price per 100 g), the `TEA15` promo code together with a discount, a cancelled or returned order.
2. **The sample is biased.** The check gets the examples that came to mind, and those are usually the "typical" cases where everything works anyway.
3. **There is no repeatability.** A week later, after the next edit, nobody will run the same five examples the same way and compare.
4. **There is no number.** "Seems better" can't be compared with another version's "seems better".

With an LLM it is even worse: the model is non-deterministic, the answer depends on the wording, and an improvement on one type of question often breaks another. An eval is a **repeatable run over a fixed set of examples with automatic computation of metrics**. In essence it is a test suite (`pytest`, JUnit, `npm test`) for a non-deterministic system: instead of `assert x == y`, checks that give the share of successful answers.

### Three levels of evals (after Hamel Husain)

How to set up such a run in practice is explained in detail by Hamel Husain, an ML engineer and consultant on LLM products. In the article "Your AI Product Needs Evals" (the first item of the learning path) he describes three levels, from cheap to expensive:

| Level | What it is | When to run | Example for the Shelf shop's support assistant |
|---|---|---|---|
| 1. Unit tests / assertions | Deterministic checks in code | On every change, in CI | The answer contains a `[1]` citation; a refusal starts with the `REFUSAL` phrase; the sources don't include `kb/returns-2025.md` |
| 2. Human evaluation and LLM-as-judge | A person or a judge model rates the answer | Regularly, before a release | "Is the answer correct and based on the retrieved chunks?" |
| 3. A/B tests | Comparison on live users | When the product is mature | Not needed for a study project: there are no live customers |

The main idea of the article: **start with the first level and with looking at the data**. Levels 2–3 are built on top of it, not instead of it.

### The improvement loop

The levels answer the question "what do we check with", and the loop answers "where do the checks come from":

```
   ┌───────────────┐
   │  look at the  │◄──────────────────────┐
   │  data         │                       │
   └──────┬────────┘                       │
          ▼                                │
   ┌───────────────┐   ┌──────────────┐    │
   │ find error    │──►│ write evals  │    │
   │ types         │   │ for them     │    │
   └───────────────┘   └──────┬───────┘    │
                              ▼            │
                       ┌──────────────┐    │
                       │ change the   │    │
                       │ system       │────┘
                       └──────────────┘
```

Evals are not invented out of thin air: they are derived from real errors. First we read traces (question → what was retrieved → what the model answered), notice recurring problems and write a check for each one. We will do this technique (error analysis) by hand in [AIL-34](AIL-34.md).

### Kinds of evals by what is evaluated

Some of these metrics we already computed in weeks 4–5 (hit@k, MRR) or checked by hand (correctness, citations, refusals). Now we put them into one system. For a RAG system (our support assistant over `kb/` from project 2), **retrieval and generation must be evaluated separately**, otherwise there is no telling where it broke.

**Retrieval metrics:**
- **hit rate@k**: the share of questions for which the needed chunk made it into the top-k retrieved.
- **MRR (Mean Reciprocal Rank)**: the average of `1/position` of the first correct chunk; it rewards the correct chunk for being higher.
- **recall@k / precision@k**: when there are several correct chunks (a question about the free delivery threshold relies on both `delivery.md` and `promo.md`).

**Answer (generation) metrics:**
- **correctness**: the answer matches the reference in meaning.
- **faithfulness / groundedness**: every claim in the answer is supported by the retrieved chunks (no hallucinations).
- **relevance**: the answer addresses the question asked, not a neighboring one.
- **refusal where it belongs**: to a question outside the knowledge base ("where is my order 1042?", "warranty on coffee machines") the system honestly answers with the refusal phrase and offers a human operator.

Plus **operational metrics**: the cost of a run, latency, the share of API errors. Metrics and how to compute them are covered in detail in [AIL-29](AIL-29.md).

### Kinds of evals by how the check is done

A metric says what to measure, but not how. The same correctness can be checked in different ways, from a regular expression to a person:

| Method | Pros | Cons |
|---|---|---|
| Exact match / regexes | Fast, free, deterministic | Only fits short or structured answers |
| Word-overlap metrics (BLEU, ROUGE) | Cheap | Correlate poorly with the quality of free text; Eugene Yan explains why in detail |
| Embedding similarity (BERTScore, etc.) | Catches paraphrases | "Similar" doesn't mean "correct": "return within 14 days" and "return within 7 days" are almost identical in embeddings |
| LLM-as-judge | Understands meaning, scales | Costs money, has its own biases, needs to be checked |
| A person | The most accurate | Slow and expensive, doesn't scale |

### LLM-as-judge: how to build a judge worth trusting

The table shows that for free text only an LLM judge really scales, but the judge itself needs to be checked. How to do that is explained in Hamel's second article ("Creating a LLM-as-a-Judge"), which is essentially a manual. The key ideas:

1. **One expert sets the standard.** In our case the expert is us (in a real shop, the owner or a senior support employee): we wrote `kb/` and know which answer about returning opened tea is correct.
2. **A binary pass/fail rating plus a critique**, not a 1–10 scale. Neither a person nor a model can explain the difference between a "6" and a "7"; but "wrong, because it gives a 30-day return period instead of 14" is clear and verifiable.
3. **Few-shot examples with critiques** in the judge's prompt: we show the judge our own labeled cases.
4. **We measure the judge's agreement with us.** We label 20–50 answers by hand, run the judge and count where it matched. We look separately at the two types of errors: the judge let a bad answer through / the judge rejected a good one.
5. **We iterate on the judge's prompt** until the agreement is acceptable.

Known biases of judges (both Eugene Yan and applied-llms.org write about them):

- **Position**: in a pairwise comparison the judge more often picks the first (or the second) option. Fixed by swapping the order and running twice.
- **Verbosity**: a long answer seems better.
- **Self-preference**: a model tends to rate texts from its own family higher.
- **Criteria drift**: Shreya Shankar and co-authors showed that people themselves refine their criteria while labeling answers. That is why the judge's criteria are written after looking at the data, not before.

An example of a judge prompt (illustrative):

```python
JUDGE_PROMPT = """You are grading an answer from the customer support assistant of an online shop.
The assistant answers from the shop's knowledge base.

Question: {question}
Reference answer: {reference}
Assistant answer: {answer}

Is the assistant answer factually consistent with the reference answer?
Minor wording differences are fine. Wrong numbers, wrong product, outdated rules,
or missing the key fact is a FAIL.

Reply in JSON: {{"critique": "<one or two sentences>", "verdict": "PASS" | "FAIL"}}
"""
```

Important: the critique comes **before** the verdict. The model reasons first and then decides; the reverse order produces a verdict with an explanation fitted to it.

### What else to take from the other articles

Hamel's articles are the basis of the chapter; the others in the learning path confirm the same ideas from other angles:

- **applied-llms.org** ("What We Learned from a Year of Building with LLMs"): practical lessons: start with prompting and simple assertion tests, look at the data every day, prefer pairwise comparisons and binary ratings, don't trust a judge without checking it; "vibe checks" don't replace evals, but doing entirely without them doesn't work either.
- **Eugene Yan, "Patterns for Building LLM-based Systems"**: evals come first of the seven patterns, and not by chance. It also covers the classic metrics (BLEU, ROUGE, BERTScore) and why they work poorly for open-ended answers, and the idea that each task needs its own set.
- **Chip Huyen, "Building LLM applications for production"**: evals as part of the engineering discipline: the ambiguity of natural language, the difficulty of evaluation, cost and latency as full-fledged metrics, prompt versioning.

### A minimal glossary

| Term | Meaning |
|---|---|
| Golden dataset | A human-verified set of questions with reference answers (ours is `eval/golden.jsonl`) |
| Reference | The correct answer that the output is compared with |
| Trace | The full record of one request: input, retrieval, prompt, answer, tokens, time |
| Offline eval | A run on a fixed set before a release |
| Online eval | Evaluation on live traffic (monitoring) |
| Regression | A metric getting worse after a change |

## DeepSeek and Ollama: how we do it

The articles of this chapter don't depend on the provider: the levels of evals, a binary judge with a critique, the judge's agreement with our labels are the same for Claude, OpenAI, DeepSeek and a local model in Ollama. What changes is the practical side: who will be the judge, how much a run costs and which judge parameters actually work. The judge code for DeepSeek and Ollama is covered in chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md) (AIL-29); here we make the decisions.

The facts below were checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com). DeepSeek's models and prices change often, so it is worth checking the current ones before starting.

### Who judges when the budget is DeepSeek and Ollama

The rule from the articles by Hamel and Eugene Yan: the judge is not weaker than the model being evaluated (better if stronger), and its agreement with a human has been measured. On our stack it looks like this:

| Role | Main option | Why | For comparison |
|---|---|---|---|
| The system being evaluated (the RAG answerer, `ask()`) | `deepseek-flash` or a local model in Ollama | cheap or free; project 2 is built on them | Claude / OpenAI on the same set |
| Judge | `deepseek-v4-pro` with reasoning turned off and `temperature=0` | stronger than Flash, more stable at temperature 0, a run costs cents | a strong Claude or OpenAI model on a subsample |
| Second opinion | our manual labels and a Claude or OpenAI judge on a subsample (`kb/` is public, the questions are made up) | a different family; catches the "DeepSeek judges DeepSeek" skew | — |
| Personal data (real customer messages, the database snapshot in project 4) | a cloud judge only on made-up questions and the demo database; real cases we label ourselves | personal data doesn't go to the cloud, and a local model on an ordinary laptop is too weak to be a judge | — |

Self-preference is real here: Flash and Pro are the same family. That is not a reason to give up Pro as the judge, but a reason to always measure its agreement with our labels and to run a subsample through a judge from another family from time to time. A local judge runs into memory limits: with 8 GB of RAM, 4B-class models are realistic (`qwen3:4b`, the course default), with 16 GB 7–8B, and only with 32 GB+ 14B and larger. 4B and 7–8B models are too weak to be judges: the judge must be stronger than the answerer, and they are weaker even than `deepseek-flash`. A 14B model on 32 GB is at best fit for a preliminary filter with measured agreement. So the judge is `deepseek-v4-pro` (or a stronger cloud model) on public data, and Ollama is our local answerer for questions with personal data and for comparison, plus embeddings and offline experiments.

### How providers differ for eval tasks

| What the judge needs | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Repeatability (`temperature=0`) | available; some newer models restrict sampling parameters, check the model's docs | available for regular models; reasoning models don't accept sampling parameters | works only with reasoning turned off: thinking mode is on by default, and in it temperature is silently ignored | available, plus a `seed` parameter |
| Structured verdict | structured outputs (JSON schema) or tool use | `response_format` with a JSON schema | only `json_object`: the JSON is valid, but the schema is not enforced; the prompt needs the word "json" and an example of the structure | `format` with a JSON schema in the native API |
| Cost of a run on ~60 questions | per Anthropic's pricing page | per OpenAI's pricing page | on the order of tens of cents (calculated in chapter 6.4) | $0 for the API; we pay with the computer's time and memory |
| Where the data goes | Anthropic's cloud | OpenAI's cloud | DeepSeek's servers in China | nowhere, everything is local |

### Security

Project 3 evaluates the assistant over the **public** knowledge base `kb/`, and the golden set questions are made up without personal data, so chunks, questions and answers can be sent to DeepSeek. Real customer messages (phones, emails, order numbers), `outputs/handoff.jsonl`, the shop's database snapshot and keys are never sent to DeepSeek or to free cloud tiers (which may train on the input data): for them, only Ollama or made-up data. The rule applies to any cloud provider, not just DeepSeek. This will matter in chapter [10.3 · Project 4: agent evals on 20 cases](AIL-42.md) (AIL-42), where the judge will read investigations of problem orders based on the database snapshot.

## Learning path

1. We open [Hamel Husain: Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) → read it in full (≈60 min). A required article. We pay attention to the three levels of evals, the section on looking at the data and the example of the real estate assistant (Rechat): how specific tests are born from errors. We write down which assertions could be written for our support assistant.
2. We open [Hamel Husain: Creating a LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) → read it in full (≈50 min). The main points: why a binary rating with a critique, how to measure the judge's agreement with the expert, why the criteria emerge during labeling.
3. We open [What We Learned from a Year of Building with LLMs](https://applied-llms.org) → in the tactical part, read the sections on evaluation and monitoring (≈40 min). The rest we skim by headings. From here we take the list of LLM-as-judge pitfalls and the advice on pairwise comparisons.
4. We open [Eugene Yan: Patterns for Building LLM-based Systems](https://eugeneyan.com/writing/llm-patterns/) → the "Evals" section (≈30 min). We already read the RAG section in [AIL-59](AIL-59.md). We pay attention to the table of classic metrics and the critique of BLEU/ROUGE.
5. We open [Chip Huyen: Building LLM applications for production](https://huyenchip.com/2023/04/11/llm-engineering.html) → part 1, on production problems: evaluation, cost, latency, prompt versioning (≈30 min). The article is from 2023: the prices and models are outdated, the principles are not.
6. (Optional, to go deeper) [Hamel: A Field Guide to Rapidly Improving AI Products](https://hamel.dev/blog/posts/field-guide/) and [Eugene Yan: Evaluating the Effectiveness of LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/). The second is a review of research on how well judges agree with people. A reference for the future: [Hamel: AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/), long, read question by question when we get stuck.
7. (Optional) [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): how the official documentation formulates success criteria and the types of graders.
8. We open [DeepSeek API Docs](https://api-docs.deepseek.com) → Quick Start, the Models & Pricing page and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (≈15 min). We write down: the current model ids, that thinking is on by default and that temperature has no effect in it. This directly affects the judge's stability.
9. We open [Ollama: Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈10 min): how `format` with a JSON schema sets the shape of a local judge's verdict. If Ollama is not installed yet: only from ollama.com; on macOS, before the app's first launch, we check `codesign -dv` and `spctl -a -vv`; for other systems, follow the official instructions on the site.

## What to watch out for

- **A metric without looking at the data is misleading.** 85% correctness says nothing until we see what is in the remaining 15%: maybe all of them are questions from one category, for example returns, where the archived `returns-2025.md` gets in the way.
- **Generic "out of the box" metrics (helpfulness, coherence) are rarely useful.** Metrics should follow from the system's real errors, not from a list in a library.
- **The judge is a model too, and it makes mistakes.** Without measured agreement with a human, the judge's rating is just one more opinion.
- **A 1–10 scale creates an illusion of precision.** An average score of "7.3 versus 7.1" says nothing.
- **We don't mix retrieval and generation into one number.** If correctness dropped, we need to know: the model didn't find the chunk, or found it but answered incorrectly.
- **A set the system has been tuned on for a long time stops being honest.** Overfitting to the set is covered in detail in [AIL-62](AIL-62.md).
- **The 2023 articles are outdated in the details** (model names, prices, specific tools), but not in the principles. We check specifics in the current documentation.
- **"temperature 0" on DeepSeek may do nothing.** Thinking mode is on by default, and in it temperature is ignored without an error. For a judge we turn reasoning off explicitly or knowingly accept more noise.
- **A judge from the same family as the answerer.** DeepSeek judging DeepSeek is a classic self-preference risk. Fixed by measured agreement with our labels and a second judge from another family.

## Practice

- [ ] We create `notes/evals.md` in the study repository.
- [ ] A "Kinds of evals" section: a table of Hamel's three levels; for each, 2 examples of checks for the support assistant (for example, "an answer about `LAMP-LIGHT-MINI` does not cite `kb/products/lamp-light.md`").
- [ ] A "Metrics" section: definitions of hit rate@k, MRR, correctness, faithfulness, relevance in our own words, with one example each.
- [ ] An "LLM-as-judge: pitfalls" section: at least 5 items (biases + how to fix them).
- [ ] A "Why 5 examples is not an evaluation" section: an explanation in 5–7 sentences, as an answer in an interview.
- [ ] We sketch a draft judge prompt for our assistant's correctness (binary, critique before the verdict). We don't run it yet; it will come in handy in [AIL-29](AIL-29.md).
- [ ] We write down 5 questions to the assistant from project 2 that, from what we have observed, it gets wrong (candidates: old return rules, the free delivery threshold, similar lamps, a question spanning two pages). They add to the 20 questions of `eval/golden.jsonl` for [AIL-28](AIL-28.md).
- [ ] We add a "Judges on our stack" section to `notes/evals.md`: who is the answerer, who is the judge, who gives the second opinion and why; we retell the Claude / OpenAI / DeepSeek / Ollama table from the theory in our own words.
- [ ] In the draft judge prompt we account for DeepSeek's JSON mode: the word "JSON" and an example of the structure right in the prompt (the `JUDGE_PROMPT` example above already has them).

## Done when

- `notes/evals.md` exists and contains all five sections.
- We can explain out loud in 2 minutes why "checked by hand on 5 examples" is not an evaluation, and how hit rate differs from faithfulness.
- There is a draft judge prompt.

## Self-check quiz

1. Which level of evals does Hamel advise building first?
   a) A/B tests; b) LLM-as-judge; c) unit tests/assertions and looking at the data; d) human labeling of all answers.
2. How does hit rate@k differ from MRR?
3. The model answered correctly, but the fact came "from its head" rather than from the retrieved chunks. Which metric catches this: correctness or faithfulness?
4. Why is a binary pass/fail rating usually more reliable than a 1–10 scale?
5. What is a judge's position bias, and how can it be reduced?
6. Why is embedding similarity a poor fit for checking the answer "An unopened tea package can be returned within 14 days"?
7. Where should the criteria for evals come from?
   a) from a list of metrics in a library; b) from analyzing the system's real errors; c) from benchmarks like MMLU; d) from the model's documentation.
8. What is wrong with this judge prompt?
   ```
   Rate the answer from 1 to 10. First give the score, then explain why.
   Question: {question}
   Answer: {answer}
   ```
9. Why separate retrieval metrics and answer metrics when evaluating RAG?
10. How can we check that an LLM judge can be trusted?
11. Correctness rose from 80% to 84% after a prompt change. Is that enough to say "it got better"? What else needs to be looked at?
12. A judge on `deepseek-v4-pro` was given `temperature=0` and nothing else was changed, yet its verdicts on the same answers still flip. Why?
13. Why does `deepseek-v4-pro` as the judge of `deepseek-flash` answers need special checking, and how is it done?
14. The assistant answers real customer messages that contain phone numbers and order numbers. How should these answers be evaluated?
    a) send the messages to a `deepseek-v4-pro` judge, it is stronger; b) with any free cloud model; c) with a cloud judge only on made-up questions, labeling real cases by hand; d) with a local 4B model as the only judge.

## Answers

1. **c.** First cheap deterministic checks and reading traces; judges and A/B tests are built on top.
2. Hit rate@k only looks at whether the correct chunk made it into the top-k (yes/no). MRR takes the position into account: the correct chunk in 1st place gives 1, in 3rd place 1/3.
3. **Faithfulness.** Correctness will say "correct", but the system didn't rely on what was retrieved, and next time its "head" may be wrong, for example by naming the return period "usual" for online shops instead of the Shelf shop's rule.
4. Neither a person nor a model can explain the difference between neighboring scores, so the ratings are noisy. A binary decision with a critique is verifiable and easy to compare with the expert's labels.
5. A tendency to pick the option in a certain position in a pairwise comparison. Fixed by running in both orders and counting only consistent decisions.
6. The embeddings of "14 days" and "7 days" almost coincide: the meaning of the phrase is the same, only one number differs. Facts with numbers need an exact check or a judge instructed to verify the numbers.
7. **b.** Criteria are derived from looking at the data and the errors; generic metrics often measure the wrong thing.
8. A 1–10 scale instead of a binary rating; the score before the explanation, so the explanation is fitted to the number; no reference or context to compare against; nothing says which errors count as critical.
9. To understand the cause: if the needed chunk wasn't found, changing the prompt is pointless and retrieval needs fixing, and vice versa.
10. Label 20–50 answers by hand, run the judge, compute the agreement and, separately, both types of errors (bad answers let through, good ones rejected), and iterate on the judge's prompt.
11. No. We need to know the spread between runs and the size of the set (4 percentage points on 50 questions is 2 questions, quite possibly noise), look at which questions changed, and whether other metrics broke (faithfulness, the share of appropriate refusals, cost). This is covered in [AIL-62](AIL-62.md).
12. DeepSeek has thinking mode on by default, and in it temperature has no effect (and there is no error). Reasoning needs to be turned off (`thinking: disabled`), or the noise accepted and the spread measured with repeated runs.
13. Both models are from the same family, and the judge may rate "its own" answers higher. The check: the judge's agreement with our manual labels and a run of a subsample through a judge from another family (Claude or OpenAI; the knowledge base is public, the questions are made up, so they can be sent).
14. **c.** The judge sees the same data as the answerer, so customers' personal data does not go to the cloud (let alone to servers in China). And a model that fits in the memory of an ordinary laptop (4B on 8 GB, 7–8B on 16 GB) is too weak to be trusted as a judge: at most a preliminary filter, with the decision left to manual labels.

## What's next

Next we build the set itself: first we learn to generate a draft of the questions with a model in [AIL-61 · Synthetic data for evals](AIL-61.md), then we grow `eval/golden.jsonl` from 20 questions into a verified set in [AIL-28 · Golden dataset: 50–100 questions with reference answers](AIL-28.md).
