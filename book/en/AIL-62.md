# 8.1 · Eval statistics: noise and sample size  (AIL-62)

> **Week 8** · Evals · ⏱ ~4 h · Theory

<!-- description: Statistics for LLM evals: confidence intervals, paired comparison of configurations, bootstrap, model nondeterminism and how many questions a conclusion needs. -->
<!-- source-sha256: 84e445a75bae -->

## Why an AI engineer needs this

In week 8 we compare configurations of the support assistant, and the numbers differ by a few percent. A difference of 72% vs 75% on 50 questions is 1–2 questions, and it easily arises from the randomness of the model and the judge alone. Without basic statistics the system "improves" by coin toss, and made-up progress ends up in the README. In interviews, the question "how did you know the improvement was real?" is a test of maturity.

## Theory

### A metric is an estimate, not the truth

The `eval/run.py` script from [AIL-29](AIL-29.md) prints one number per metric, for example correctness 0.72. It is tempting to treat it as the assistant's quality. But correctness 0.72 on 50 questions is an estimate of the assistant's "true" quality over all possible customer questions of this kind. Another 50 questions of the same kind would give, say, 0.66 or 0.78. There are three sources of noise:

1. **The question sample.** Which questions exactly ended up in the set.
2. **System nondeterminism.** The answering model with temperature > 0 answers differently each time; even at temperature 0, API responses are not guaranteed to be identical.
3. **Judge nondeterminism.** In a borderline case the judge rates the same answer PASS one time and FAIL another.

An analogy from the shop: promo code `TEA10` one week, `TEA15` the next week, 50 orders with each. The average order value with `TEA15` is 3% higher, but nobody would declare `TEA15` the winner: there are few orders, the customers are different, one week is not like the next. Evals are the same.

### A confidence interval for a proportion, in plain terms

If k out of n questions passed, the proportion is p = k/n. Its **standard error**:

```
SE = sqrt(p × (1 − p) / n)
```

A rough 95% confidence interval: **p ± 2·SE** (1.96, to be precise). In plain terms: if we collected the set many times over, such intervals would cover the true value in about 95% of cases. We measure the interval width and the difference between proportions in percentage points (pp): 0.72 → 0.75 is +3 pp, not +3%.

| n | p | SE | 95% interval (±) |
|---|---|---|---|
| 50 | 0.72 | 0.064 | ±12 pp |
| 100 | 0.75 | 0.043 | ±8.5 pp |
| 200 | 0.75 | 0.031 | ±6 pp |
| 500 | 0.75 | 0.019 | ±4 pp |

The takeaway worth remembering: **on 50 questions the interval is about ±12 pp wide.** Precision grows as the square root of n: to halve the interval, we need four times as many questions.

For small n and proportions near the edges (0.95, 0.05), the `p ± 2·SE` formula lies (it can give an interval outside [0, 1]). The **Wilson interval** is better:

```python
import math

def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    # Wilson score interval for a binomial proportion
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (center - half, center + half)

print(wilson(36, 50))  # ~ (0.58, 0.83)
```

### Comparing two configurations: the paired approach

An interval describes one configuration. In experiments we care about something else: whether B is better than A. Take two configurations on the same dev split of `eval/golden.jsonl`, 60 questions: A passed 43/60, B passed 46/60. The naive view: A's Wilson interval is [0.59; 0.81], B's is [0.65; 0.86], the intervals overlap, so there is no difference. This is too strict, because A and B were run **on the very same questions**. The "which questions ended up in the set" noise is shared between them, and it can be subtracted.

The paired approach: we look only at the questions where the results **diverged**.

```
                  B: PASS    B: FAIL
  A: PASS           39          b = 4     ← A is better on 4 questions
  A: FAIL         c = 7           10      ← B is better on 7 questions
```

A is 43/60 (71.7%), B is 46/60 (76.7%). Questions where both passed or both failed say nothing about the difference. Only the 11 discordant questions matter: 7 in favor of B, 4 in favor of A. If A and B were the same, the discordant questions would split like coin tosses, 50/50. How unusual is 7:4 for a coin?

**The sign test (exact McNemar test)**: the probability of getting a 7:4 split or an even more lopsided one with a fair coin:

```python
from math import comb

def sign_test(b: int, c: int) -> float:
    # two-sided exact binomial test on discordant pairs (exact McNemar)
    n, k = b + c, min(b, c)
    if n == 0:
        return 1.0
    tail = sum(comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)

print(sign_test(4, 7))  # ~0.55 -> easily noise
print(sign_test(1, 9))  # ~0.02 -> unlikely to be noise
```

7:4 gives p ≈ 0.55, a perfectly ordinary split for a coin. +5 pp proves nothing here. But 9:1 with the same set size (that is +13 pp) already gives p ≈ 0.02.

The 0.05 threshold is a convention, not a law of nature. The logic matters more: **the fewer discordant questions there are and the closer they are to 50/50, the less reason to believe in an improvement**.

### Bootstrap: a universal tool

For metrics that are not a simple proportion (MRR, cost per answer, latency, the MRR difference between A and B), the **bootstrap** is handy: many times over we randomly draw questions from the set with replacement, recompute the metric and watch how much it wanders.

```python
import random

def paired_bootstrap(a: list[float], b: list[float], iters: int = 5000, seed: int = 0):
    # a[i], b[i] are per-question scores of configs A and B on the same question i
    rnd = random.Random(seed)
    n = len(a)
    diffs = []
    for _ in range(iters):
        idx = [rnd.randrange(n) for _ in range(n)]
        diffs.append(sum(b[i] - a[i] for i in idx) / n)
    diffs.sort()
    return diffs[int(0.025 * iters)], diffs[int(0.975 * iters)]  # 95% interval of B - A

# if the interval contains 0, the difference is not established
```

What gets resampled is **questions, not individual answers**, with the same indices for A and B: this preserves the pairing.

### Nondeterminism: several runs

The interval above accounts only for "which questions ended up in the set". The noise of the model and the judge is measured by repeated runs of the same config:

| Run | correctness | faithfulness | hit@5 |
|---|---|---|---|
| 1 | 0.70 | 0.86 | 0.82 |
| 2 | 0.74 | 0.84 | 0.82 |
| 3 | 0.71 | 0.88 | 0.82 |
| **spread** | **0.70–0.74** | **0.84–0.88** | **0** |

(The numbers are illustrative.) An important detail: with deterministic retrieval the hit rate doesn't wander at all, while judge-based metrics do. Hence a practical rule: **a difference between configs smaller than the spread of repeated runs is not a difference**.

A useful diagnostic metric: **the share of "flickering" questions**, those that are PASS in one run and FAIL in another. If 15% of questions flicker, the answering model or the judge is unstable on borderline cases; they are worth looking at by eye. Often there is an ambiguous question ("how much is delivery?" with no weight or city, which is what `eval/ambiguity_check.py` catches) or a vague judge criterion.

How to reduce the noise:
- temperature 0 for the judge (and for the answering model during experiments, if the product allows it and the model supports the parameter);
- a cache of judge verdicts keyed by the input hash: the same answer gets the same verdict;
- for decisive comparisons, 3 runs and the per-question average;
- fixing ambiguous questions in the set;
- more questions.

### Questions are not independent

There is one more assumption we have silently made so far. All the formulas above assume the questions are independent. If 10 synthetic questions from `eval/generate.py` were generated from one chunk or concern one page (say, `kb/delivery.md` with the rate table), they behave like one "big" question: they fail and pass together. The effective size of the set is smaller than the number of rows, and the intervals are actually wider. Anthropic's article on a statistical approach to evals recommends clustered standard errors in such cases; the natural cluster in our set is the page from `source_urls`. It is enough to remember the idea: **10 variations of one question are not 10 pieces of evidence**, and the diversity of the set matters more than the number of rows.

### Overfitting to the eval

So far the noise has been random. Overfitting is a systematic error we introduce ourselves. Every time we look at a result and decide what to change next, the system gets fitted a little to these particular 60 questions. After 20 experiments on one set:
- one of the 20 configurations will turn out "better" by a few pp purely by luck (if we run 20 checks with a 0.05 threshold, on average one "fires" by chance);
- the answering prompt accumulates rules for specific questions ("if asked about LAMP-LIGHT-MINI, remind them the warranty is 6 months").

Protection:
1. **The holdout** from [AIL-28](AIL-28.md) (`split: holdout`): we check the final configuration on it once. If the gain disappears on the holdout, it was overfitting.
2. **A hypothesis before the experiment**, written down ([AIL-32](AIL-32.md)): "I expect +X in hit rate, because…". This prevents declaring any random difference a success after the fact.
3. **Few experiments, each meaningful**, rather than trying every combination.
4. **Prompt edits are general, not tailored to a specific question.**

### How many questions are needed

The inverse problem: what set do we need to detect an improvement of d pp? For independent samples, with p around 0.75 and a 5 pp difference, we need more than a thousand questions per configuration. A paired comparison on one set needs noticeably fewer (it depends on the number of discordant questions), but even with it 60 questions reliably catch only large effects (on the order of 10+ pp, or very one-sided discordant splits). A realistic conclusion for Project 3: on our set, large improvements are visible (we changed the chunking: +15 pp hit rate), while small ones (+3 pp from rephrasing the prompt) are honestly recorded as "within the noise".

### A rule for ourselves

Everything above boils down to one rule by which we will accept or reject changes in week 8. We write the rule down in advance, before the experiments. An example:

> A change counts as an improvement if all three conditions hold:
> 1. The difference is larger than the spread of three repeated runs of the baseline config.
> 2. Paired comparison: sign test p < 0.1, or the 95% bootstrap interval of the difference does not contain 0.
> 3. No other key metric (faithfulness, the share of correct refusals `refusal_ok`, `false_refusals`) got worse by more than the spread, and `archived_in_context` stayed at zero.
>
> For the final configuration, confirmation on the holdout.
> If condition 2 is not met but the effect agrees with the hypothesis, we write "a trend, not proven".

### What it looks like in the experiments table

Instead of `correctness 0.74` we write:

| Experiment | correctness | Δ vs baseline | discordant (+/−) | p |
|---|---|---|---|---|
| baseline (3 runs) | 0.72 (0.70–0.74) | — | — | — |
| headings chunking (3 runs) | 0.84 (0.82–0.85) | +12 pp | 9 / 2 | 0.07 |

The value in parentheses is the spread of repeated runs; "discordant" is the number of questions (out of 60) where the new config is better / worse. The numbers are illustrative. Even +12 pp on 60 questions gives p ≈ 0.07, that is, "probably real, but not ironclad".

## DeepSeek and Ollama: how we do it

The statistics don't depend on the provider: the Wilson interval, the sign test and the bootstrap are the same everywhere. What depends on the provider is the **sources of noise** and the means of keeping them down. Checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com).

Repeated runs don't change the privacy rule: the cloud judge sees only the set's questions, the reference answers and chunks of the public `kb/`. Customers' personal data, work code and anything that must not be shown to outsiders never go to the cloud — neither to DeepSeek (its servers are in China) nor to other providers; real customer messages are processed only by the local model.

### Where noise comes from on our stack

| Source of noise | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Answer sampling | temperature, with restrictions on some newer models | temperature; reasoning models don't have it | temperature works only with thinking off; thinking is on by default | temperature + `seed` |
| Fixed `seed` | no | available on some models, with no guarantee | not described in the API reference | yes |
| The model behind the same name changes | dated snapshots in the id | dated snapshots in the id | yes: `deepseek-flash` is currently served by V4.1-Flash-1017, old names redirect to new models | no, until we ourselves `ollama pull` the same tag |
| Service load | affects latency | affects latency | affects latency; under overload, 429 on the concurrent-request limit | our own machine: neighboring processes, model loading after idle time |
| Context truncation | no (an error when exceeded) | no (an error when exceeded) | no at our volumes | yes, silently, if the server's context is smaller than the prompt |

Hence the practical rules:

1. **The DeepSeek judge runs with thinking off and temperature 0.** Otherwise temperature has no effect, and there will be more "flickering" questions. If a reasoning judge is chosen anyway (by agreement with the labels in chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md)), the spread of three runs is mandatory.
2. **In every run we record `resp.model` and the date.** If DeepSeek updated the model behind the same name between the baseline run and the variant run, the paired comparison is already comparing two different models. If `resp.model` differs between two runs, we rerun the baseline.
3. **A local model gives the most reproducible output**: temperature 0, a fixed `seed`, a fixed tag, enough context. This doesn't guarantee bit-for-bit identical answers (the Ollama docs make no such promise), so we check with two runs. But reproducible doesn't mean correct: memory-wise this is a 4B-class model with 8 GB of RAM, 7–8B with 16 GB, 14B with 32 GB or more, and even 14B is weaker than the `deepseek-v4-pro` judge, while a small one is weaker than the system being evaluated. This property is useful for a local **answering model** in comparisons, while the judge stays `deepseek-v4-pro`.
4. **DeepSeek's prompt cache doesn't affect answers**, only the price. Our verdict cache, however, does: we turn it off when measuring the judge's spread.

### The cost of repeated runs

Three baseline runs on 60 questions, with `deepseek-flash` answering and `deepseek-v4-pro` judging without thinking, come to about $1.80 at peak hours (3 × ≈ $0.60) and half that off-peak (the estimate from chapter 6.4; peak is weekdays 01:00–04:00 and 06:00–10:00 UTC). On Ollama repeated runs are free but take time. So the "3 runs per config" advice costs almost nothing on our stack, and there is no need to save on it. For comparison, we price the same runs on strong Claude or OpenAI models using their pricing pages.

### An experiment: thinking vs thinking off for the judge

A good exercise for this chapter: three runs over the same set of answers (the answers are fixed, only the judge changes) in two judge modes. We compare the share of flickering verdicts and the agreement with our labels from `eval/judge_labels.jsonl`. The usual outcome is a trade-off, "more accurate but noisier and more expensive" vs "more stable and cheaper", and the decision is made by the numbers, not by feel.

## Learning path

1. We open [Anthropic: A statistical approach to model evaluations](https://www.anthropic.com/research/statistical-approach-to-model-evals) → read it in full (≈25 min). Five recommendations: standard error, clustering, variance reduction through repeated answers, paired comparisons, power analysis. That is exactly the plan of this chapter.
2. (Optional, deeper) The full paper on arXiv: [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) → the sections on paired differences and power (≈40 min). The formulas can be skipped; the conclusions are what matters.
3. We open [Wikipedia: Binomial proportion confidence interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval) → the sections on the normal approximation and the Wilson interval (≈20 min). We pay attention to why the normal approximation works poorly for small n.
4. We open [Wikipedia: McNemar's test](https://en.wikipedia.org/wiki/McNemar%27s_test) → the definition and the example (≈15 min). The goal is to understand why only the discordant pairs matter.
5. In [Hamel: AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) we look for the questions about set size and statistical significance (≈15 min): the practitioners' position is "look at the data"; statistics don't replace error analysis.
6. We open [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) and [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) (≈15 min): which parameters have no effect in thinking mode and which parameters exist at all (we make sure there is no `seed` in the reference).
7. We open [Ollama: FAQ](https://docs.ollama.com/faq) and [Context length](https://docs.ollama.com/context-length) (≈15 min): the default context, `keep_alive`, `OLLAMA_NUM_PARALLEL`. These are sources of local-model "noise" that are actually not noise but settings.

## What to watch out for

- **"An improvement of 2 pp" on 50 questions is one question.** We always convert percentages back into a number of questions.
- **Comparing the intervals of two configs "by eye" is wrong** when the questions are shared: a paired comparison is needed.
- **One run per config** with a nondeterministic judge is a lottery. At least the baseline needs three runs to find out the spread.
- **Changing the set version** breaks comparability: a paired comparison is only possible on identical questions (`dataset_sha` in the run's `config.json` must match).
- **A p-value is not an effect size.** p = 0.03 for +1 question on a huge set may be practically unimportant, while +15 pp at p = 0.12 on 40 questions may be an interesting trend worth checking on a larger set.
- **Slices are small.** Correctness for `comparative` or for `category: warranty` on 10 questions has an interval of about ±30 pp. Conclusions from slices are only hints for error analysis.
- **Picking the best of many.** The best of 10 configs on dev has an optimistic dev number. The honest number comes from the holdout.
- **"temperature 0" for the DeepSeek judge without turning thinking off**: the parameter is silently ignored, and the judge's spread is larger than it seems.
- **A silent model change at DeepSeek.** A month-old baseline and a new run may have been made by different models under one name. We compare `resp.model` in `results.jsonl`.
- **Context truncation in Ollama looks like instability.** If a local answering model or judge flickers on long questions (comparing Light and Light Mini, the rate table) and is stable on short ones, we check the context first (`ollama ps`, `prompt_eval_count`), and only then compute statistics.

## Practice

Code: `projects/02-support-kb-rag/eval/`.

- [ ] We create `eval/stats.py` with the functions `wilson(k, n)`, `sign_test(b, c)`, `paired_bootstrap(a, b)`. We check them on the examples from the theory: `wilson(36, 50)` ≈ (0.58; 0.83), `sign_test(4, 7)` ≈ 0.55, `sign_test(1, 9)` ≈ 0.02.
- [ ] We run `eval/run.py --config eval/configs/baseline.json` on dev **3 times** (the judge cache is off for this, otherwise the judge's spread isn't visible).
- [ ] A script `eval/compare.py RUN_A RUN_B`: takes two folders from `eval/runs/`, reads their `results.jsonl`, matches them by `id`, and for each metric prints: the values, Δ, the b/c discordant counts, the sign test p, the bootstrap interval of the difference.
- [ ] For the three baseline runs we compute: the spread of correctness/faithfulness, the share of "flickering" questions. We list the flickering questions and look at 5 of them: what causes the instability (the question, the reference, the judge)?
- [ ] We run `compare.py` on two runs of the same baseline. Expected result: a large p, an interval containing 0. This is a check of the tool: if it "finds" a difference between identical configs, something is wrong.
- [ ] We write the significance rule into `notes/evals.md` and into the header of the future experiments table.
- [ ] We compute the Wilson interval for correctness per `type` and per `category`. It shows clearly how wide the intervals on slices are.
- [ ] In each run's `results.jsonl` we save the `resp.model` of the answering model and of the judge, and the call time; `compare.py` warns if the models or the `dataset_sha` differ between two runs.
- [ ] We measure the share of flickering verdicts for the `deepseek-v4-pro` judge in two modes (thinking off / on) over three runs of the same answers. We record in `notes/evals.md` which mode is more stable and which is closer to our labels.
- [ ] For a local answering model (`qwen3:4b`, or larger if memory allows; temperature 0, `seed`) we do two runs and count how many answers differ. We compare this with the share of differences for `deepseek-flash` without thinking.
- [ ] (Optional, for comparison) The same for a Claude or OpenAI judge on a subsample of 20 answers.

## Done when

- In the experiments table, the baseline shows the spread of three runs.
- `eval/stats.py` and `eval/compare.py` exist, checked on the examples and on comparing the baseline with itself.
- The rule "which difference is significant" is written down before the experiments start.

## Self-check quiz

1. Correctness 0.70 on 50 questions. Roughly how wide is the 95% interval?
   a) ±1 pp; b) ±4 pp; c) ±13 pp; d) ±30 pp
2. By what factor must the set grow to halve the interval?
3. Why, when comparing two configurations on one set, do only the questions where the results diverged matter?
4. A and B on 60 questions: B is better on 6 questions and worse on 5. What can be said?
5. Three runs of one config gave correctness 0.70, 0.74, 0.71. A new config gave 0.73 in a single run. Is it an improvement?
6. Why does the hit rate with deterministic retrieval not change between runs, while correctness does?
7. What is wrong with this conclusion: "We tried 15 prompt variants, the best gave 0.81 vs 0.74 for the baseline on the dev set, that's +7 pp, shipping it to production"?
8. Why do 10 synthetic questions generated from one chunk give less information than 10 questions from different places?
9. What does the bootstrap do, and why must the question indices be the same for A and B when comparing them?
10. `compare.py` shows p = 0.01 when comparing two runs of the same config. What does that mean?
11. Why write down the significance rule before the experiments?
12. Three baseline runs with the `deepseek-v4-pro` judge and `temperature=0` gave a correctness spread of 0.66–0.78. What should be checked first?
13. The baseline was run 2 weeks ago, the variant today, both with `answer_model: deepseek-flash`. Why might the paired comparison be invalid, and how can this be detected?
14. Which answering model, all else being equal, gives the most reproducible result, and why? Does that make it suitable as a judge?
    a) DeepSeek with thinking; b) DeepSeek without thinking, temperature 0; c) Ollama, temperature 0, fixed `seed` and model tag; d) all the same.

## Answers

1. **c.** SE = sqrt(0.7·0.3/50) ≈ 0.065, ±2·SE ≈ ±13 pp.
2. By 4 times: the interval width is proportional to 1/√n.
3. On questions where both passed or both failed, the configs are identical; the difference between them is determined entirely by the discordant questions, and the shared sampling noise is subtracted.
4. 6:5 is an ordinary split for a coin (p ≈ 1); no difference is established.
5. No: 0.73 is within the baseline spread (0.70–0.74); it is indistinguishable from noise.
6. Retrieval over a fixed index is deterministic, while the model's answer and the judge's verdict contain randomness.
7. Picking the best of 15 on the same set is overfitting: one of many attempts will almost certainly turn out "better" by luck. There is no spread, no paired test, no check on the holdout.
8. They are correlated: success or failure depends on one chunk, so they behave almost like one question; the effective size of the set is smaller.
9. It repeatedly resamples the questions with replacement and recomputes the metric, obtaining its distribution. The same indices preserve the pairing: A and B are compared on the very same questions, and the shared noise is subtracted.
10. Most likely a bug in the tool (ids not matched, run folders mixed up) or a very unstable judge/answering model producing systematically different results; this has to be investigated before trusting any comparison.
11. So as not to adjust the criterion to the desired result after the fact and not to declare a random difference a success.
12. Whether thinking is turned off for the judge: it is on by default, and in that mode temperature has no effect. Then, whether `ERROR` results were counted as FAIL, and whether there are flickering questions with ambiguous wording.
13. In the meantime DeepSeek may have pointed the name to a new model version, and two different models are being compared. It is detected by `resp.model` in `results.jsonl`; if it differs, rerun the baseline.
14. **c.** The local model has a fixed tag, `seed` and temperature, and nobody updates the model without our `ollama pull`; DeepSeek has no documented `seed`, and the model behind a name can change. Bit-for-bit repeatability is still worth checking with two runs. It is not suitable as a judge: the available memory fits a 4–14B model, weaker than the `deepseek-v4-pro` judge (and a small one is weaker than the system being evaluated), and a stable error is still an error.

## What's next

Now we can set up the first real experiment: [AIL-32 · A chunking experiment in RAG: A vs B](AIL-32.md) — a hypothesis, two runs, a paired comparison and a row in the experiments table.
