# 2.5 · The first eval: extracting JSON from 20 texts  (AIL-9)

> **Week 2** · LLM basics · ⏱ ~4 h · Practice

<!-- description: A first LLM eval: extracting JSON from 20 texts, labeling a gold set, computing per-field metrics and finding systematic model errors. -->
<!-- source-sha256: ccf97e28a4d9 -->

## Why an AI engineer needs this

The difference between a hobby project and an LLM product fits in one sentence: "correct in 17 out of 20, the errors are mostly in the date field." This is the first real quality evaluation (eval) in the course. Building a gold set, computing per-field metrics and finding systematic errors is a core AI engineering skill; in interviews, the question "how did you know it got better?" expects exactly this kind of answer.

## Theory

### What an eval is in its simplest form

```
dataset (inputs)  +  gold set (correct answers, gold)
        │
        ▼
   our system (prompt + model + schema)  →  predictions
        │
        ▼
   comparing predictions with the gold set  →  metrics + list of errors
```

This is exactly what we did in chapter 2.1 for review labels, except that now the answer is a structure of several fields, and the comparison has to be done field by field. An analogy from regular development: the gold set is the expected values in unit tests, and an eval is a test run, except that instead of "green/red" we get a percentage, because an LLM system is probabilistic and 100% doesn't happen.

### The dataset: which texts to take

The task of the exercise is the same as in chapter 2.2: from a supplier's email to the Shelf shop, extract the product event (new arrival, discontinuation, price change), the product, the supplier and the date; we add the new price to them. The system is already written: the `extract()` function and the `ProductUpdate` model; now we need texts to test it on. 20 texts are too few for statistics but enough to see the typical errors. Variety matters more than quantity:

| Type | How many | Why |
|---|---|---|
| Regular emails about a new arrival or a price change | 6–8 | The "happy path" |
| Discontinuation | 3–4 | The model may confuse it with an arrival |
| Several products in one email | 2 | A schema check (a list or a single record?) |
| No date / a date without a year / a relative date ("starting next Monday") | 2–3 | A check for made-up values and normalization |
| Product descriptions, ad copy (not announcements) | 2 | Should give "no event" |
| Customer messages from support (anonymized, see below) | 2–3 | Noisy inputs unlike supplier emails: they show up in the real stream too, and the system must not find an "arrival" or a "new price" in them |

**Where to get the texts.** There is no ready source: supplier newsletters arrive in the shop's mailbox and aren't publicly available. There are two ways. The first is to write the texts by hand, modeled on real newsletters: "new arrival" emails, new price list notices, messages about an item being discontinued (many wholesalers have such "News" sections on their sites). The second is to generate drafts with a model and edit each one by hand. Model drafts are usually too "clean", so we put the difficulties back on purpose: dates without a year ("from December 1"), several products in one email, different spellings of the supplier (`Tea Yard LLC`, `TEA YARD`, `teayard.com`), a price per kilogram instead of per 100 g. The `source` field records how the text came about (`handwritten`, `generated+edited`). Anyone who has real supplier emails of their own and the right to use them can take those.

**Data safety.** Customer messages are personal data: name, phone, address, order number. Ours are made up, but we treat them as real: this habit will be needed at work. The rules:
- we work only with a **copy** (if we take anything from the shop database, only via `VACUUM INTO` into a separate file, read-only);
- customer messages go **only to the local model (Ollama)**; they cannot go to DeepSeek or other cloud APIs even anonymized (see the "DeepSeek and Ollama" section below); and we still **anonymize** them, since the dataset lives in the repository: we remove names, phones, emails, addresses, order numbers and tracking numbers; it is better to rewrite the message by hand, keeping its structure;
- no exports from mailboxes or supplier accounts via tokens: the texts are public, written for the course or copied by hand;
- if in doubt whether a text can be sent outside, we don't send it and make up a similar one.

### The gold set: labeling is decisions, not mechanics

The texts are collected; now for each one we need to write down the correct answer, the gold label. Labeling by hand forces us to settle questions that would otherwise be left to the model:

- How to write the supplier: `Tea Yard LLC`, `TEA YARD`, `teayard.com`? → a **canonical form** (for example, lowercase, without the legal form, quotes or domain: `tea yard`).
- Which date, if the text says "new prices take effect on December 1, 2026; orders at the old prices are accepted until November 28"? → a **rule**: the effective date.
- Is an email about the warehouse being closed for the holidays `update_type = null` or a separate value? → the **schema**: an explicit `other` may be better: `update_type: Literal["new_arrival", "discontinued", "price_change", "other"]`.
- "$24/kg" for tea means `new_price = 2.4` (as on the product page, per 100 g). The model from chapter 2.2 has no `new_price` field, so we add it.

We write these decisions down in `annotation_guide.md`, which is also the spec for the prompt. A good practice: the labeling rules move almost word for word into the field descriptions and the prompt's `<rules>`.

The gold set format is JSONL, one line per example:

```json
{"id": "t07", "text": "...", "gold": {"update_type": "price_change", "product": "milk oolong", "supplier": "tea yard", "effective_date": "2026-12-01", "new_price": 2.4}}
```

### Per-field comparison

With a gold set in place, what is left is to compare the model's answers with it. A naive `pred == gold` on the whole object gives a single number and explains nothing. We compare **each field separately** and with **normalization**:

```python
def norm_supplier(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip().lower().strip("«»\" ").removesuffix(" llc")
    aliases = {"teayard.com": "tea yard", "teayard": "tea yard"}   # from the annotation guide
    return aliases.get(v, v)

NORMALIZERS = {
    "product": lambda v: v.strip().lower().strip("«»\"") if v else None,
    "supplier": norm_supplier,
    "effective_date": lambda v: str(v) if v else None,     # ISO string or None
    "new_price": lambda v: round(float(v), 2) if v is not None else None,
    "update_type": lambda v: v,
}
```

Normalizers bring equivalent spellings to one form before the comparison. After that each field has four possible outcomes: correct, wrong, missed, invented (telling them apart matters for fields that can be `null`):

| gold | pred | Outcome |
|---|---|---|
| a value | the same value | ✅ correct |
| a value | a different value | ❌ wrong |
| a value | `null` | ❌ missed (the model "didn't find it") |
| `null` | a value | ❌ **invented** (a hallucination), the most dangerous one |
| `null` | `null` | ✅ correct |

Missed and invented are different diseases with different cures: a miss is cured with hints about where to look; an invention with an explicit rule "if it's not in the text, null". We count them separately.

### Metrics

The per-field outcomes add up to a few numbers:

- **Per-field accuracy** = correct / total examples (for the field). The main number of this exercise.
- **Exact match** = the share of examples where *all* fields are correct. A strict "the whole record is correct" metric.
- **The number of inventions** per field, separately.
- **Format errors**: how many times the answer didn't parse at all (with structured outputs it should be 0).

For one or two things, like "were all products found in an email with several products", precision/recall are needed; that is a topic for the evals stage, and for now it is enough to mark such examples by hand.

### Error analysis matters more than the number

Numbers tell *how* bad it is, not *why*. After a run we print a table of errors: id, field, gold, pred, a piece of the text. Then we group them by eye: "5 of the 7 errors are dates like 'from December 1' without a year", "the supplier is taken from the shipping company's signature at the bottom of the email, not from the header". Each group gets one hypothesis and one change (prompt, field description, schema, normalization). This is the same loop as in AIL-7.

Sometimes the **labels** are to blame: we made a mistake ourselves or the rule was ambiguous. That's normal: we fix the gold set and write down why.

### Overfitting on 20 examples

The "error → hypothesis → change" loop has a downside. If we improve the prompt while looking at the same 20 texts, sooner or later the prompt starts getting "fitted" to specific examples. The minimal protection, even on such a small set: **set aside 5 texts** (holdout) and don't look at the errors on them until the final run. If accuracy went up on the 15 "working" texts but not on the 5 held-out ones, the prompt has been fitted to the data.

### Noise

The second trap when comparing versions is the randomness of the answers themselves. We repeat each run 2–3 times: even with the same prompt the answers differ slightly. If "before" = 82% ± 3% and "after" = 84% ± 3%, nothing is proven. A difference worth discussing on 20 examples is several texts, not one.

## DeepSeek and Ollama: how we do it

The eval itself doesn't depend on the provider: the dataset, the gold set, the per-field comparison, the holdout are all the same. Two things change: **which texts can be sent to which model** and **how to make a run reproducible**.

### Privacy routing: in code, not in our heads

The dataset will contain customer messages. Even anonymized, this is people's correspondence with the shop: **we don't send it to DeepSeek (servers in China) or other cloud models**. Supplier emails and public announcements are fine. We turn this into a rule that the code checks:

```python
# every dataset item has "private": true/false
CLOUD_PROVIDERS = {"deepseek", "openrouter", "anthropic", "openai"}

def guard(item: dict, provider: str) -> None:
    if item.get("private") and provider in CLOUD_PROVIDERS:
        raise PermissionError(f"{item['id']}: private text must stay local (ollama), got {provider}")
```

Hence two runs:

| Run | Provider | Which texts |
|---|---|---|
| A | DeepSeek `deepseek-flash` | all public ones (`private: false`), 17–18 of them |
| B | Ollama `qwen3:4b` (the course's default model; 8 GB of RAM is enough) | all 20, including customer messages |

There is also a third option: instead of anonymized customer messages, make up similar (fake) ones and mark them `private: false`. This is fine and even the right thing for a public repository; but then quality is measured on fakes, and that is worth noting in `summary.md`.

### Reproducibility

- **DeepSeek:** we turn thinking off (`thinking: disabled`) and set a low `temperature`; in thinking mode it is silently ignored (chapter 1.7). We record the `model` field from the response in `results/`: the version behind the name `deepseek-flash` may change, and then the v2 → v3 "improvement" turns out to be a model change.
- **Ollama:** `options={"temperature": 0, "seed": 42}` and the model ID from `ollama list` in the run config. We use a strict schema via `format` (chapter 2.2): there should be 0 format errors.
- **For all of them:** the run config = provider, model, prompt version, schema, parameters, date, time (for DeepSeek, peak/off-peak affects the cost).

### How the providers differ in this exercise

| | Claude / OpenAI | DeepSeek | Ollama (`qwen3:4b`, local) |
|---|---|---|---|
| Strict schema for `extract()` | `parse` | only a strict tool (beta) or JSON mode + retry | `format` with a schema |
| Customer messages can be sent | no (cloud; the course rule) | **no** | yes |
| Reproducibility | almost no sampling knobs (none on newer Claude models) | `temperature` without thinking; the version behind the alias may change | `temperature=0` + `seed`, the version is under our control |
| Cost of 20 texts × 3 runs | cents | fractions of a cent | $0, but minutes of time |
| What to expect in quality | a reference for comparison | high | lower, especially on dates and multiple products |

### What to use for the practice

The main run is DeepSeek on the public texts (fast and cheap, a good "bar"); the second is Ollama on all 20 texts. The public part can also be run through the OpenRouter models from chapter 2.4 (`guard` already treats it as cloud), so the model table from chapter 2.3 gets its first quality numbers of our own. The accuracy gap on the same public texts shows how much quality is lost when the data stays local; this will come in handy when we decide how to build a bot over the shop database with customers' personal data (chapter 3.1 · Project 1: LLM bot architecture and a database copy). Claude/OpenAI are optional, for comparison.

## Learning path

1. We reread our `extract()` function and the `ProductUpdate` model from [AIL-8](AIL-8.md) (≈15 min): we decide what changes in the schema after the labeling decisions (for example, an `other` value in `update_type`, the `new_price` field, a list of products).
2. Anthropic documentation → the section on building tests and success criteria in Prompt engineering / Test & evaluate (≈30 min). The starting point is the [Prompt engineering overview](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview), which links to the "define success criteria" and "develop tests" pages. What we take from it: success criteria must be specific and measurable; test sets must include edge cases.
3. [Anthropic Courses](https://github.com/anthropics/courses) → the Prompt evaluations course: we read the first 1–2 lessons (≈30 min), on why evals are needed and how a simple code-graded eval works. The rest is for the evals stage.
4. Hamel Husain's article "Your AI Product Needs Evals" ([hamel.dev/blog/posts/evals](https://hamel.dev/blog/posts/evals/)) (≈30 min): a practical take on evals and error analysis from someone who consults a lot of product teams. What we take: "look at the data", levels of checks, the iterative loop.
5. We reread the "DeepSeek and Ollama" section in chapter 2.2 and the Ollama [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) page (≈10 min): which strict-schema method we use for each provider. In the [Ollama Chat API](https://docs.ollama.com/api/chat) we find `options.seed` and `options.temperature`.
6. Practice (≈2.5 h).

## What to watch out for

- **Without an annotation guide the gold set "drifts"**: example 3 is labeled one way, example 15 another. The model can't be more accurate than an ambiguous gold set.
- **Normalization can hide errors** or, on the contrary, create them. We normalize only what is equivalent for the task (case, quotes, "LLC") and log the original values.
- **Dates.** Relative dates ("from Monday") and dates without a year can't be resolved without the email's date in the context. If they need to be extracted, we pass the email's date in the prompt.
- **Fitting to the test.** Few-shot examples must not come from these 20 texts, and the holdout stays untouched until the end.
- **A single number lies.** "90% exact match" may mean "everything is great", or it may mean "everything is great except for inventions in 2 ad texts with no event at all", which is critical for the product: the shop will take a product off sale or reprice it when the supplier wrote nothing about it. We look at per-field metrics and inventions separately.
- **Leaking personal data** through customer messages is a real beginner mistake. Only anonymized copies.
- **The code is worth keeping tidy**: `eval_extract.py` will become the foundation of our evals in weeks 6–8. We don't write it as a throwaway in a notebook.

## Practice

Structure:

```
exercises/week-02/extract_eval/
  annotation_guide.md
  dataset.jsonl          # 20 texts with gold labels
  eval_extract.py
  results/               # one JSON per run: config + per-item predictions + metrics
```

- [ ] **1. Collect 20 texts** following the table in the theory: supplier emails (arrivals, discontinuations, price changes), product descriptions, 2–3 **anonymized** customer messages from support. We write the texts by hand or generate drafts with a model and edit them (see "Where to get the texts"). The source of each text goes into the `source` field, and customer messages get `"private": true` (the rest, `false`). Before every call the script calls `guard(item, provider)` from the "DeepSeek and Ollama" section.
- [ ] **2. Annotation guide.** `annotation_guide.md`: canonical names of suppliers and products, which event belongs to which type, which date is taken, which units the price is in, what to do with several products, when to use `null`.
- [ ] **3. Label the gold set** in `dataset.jsonl`. We mark 5 texts `"split": "holdout"` and the rest `"split": "dev"`.
- [ ] **4. Script.** `eval_extract.py` puts together everything from the theory: `NORMALIZERS` from the "Per-field comparison" section, `guard()` from the "DeepSeek and Ollama" section, per-field comparison and outcome counting. Command-line arguments: `--split`, `--version`, `--provider`. A skeleton:

```python
import json, sys
from collections import defaultdict
from pathlib import Path

FIELDS = ["update_type", "product", "supplier", "effective_date", "new_price"]

def compare(gold: dict, pred: dict | None) -> dict[str, str]:
    """Return outcome per field: ok / wrong / missed / invented / format_error."""
    if pred is None:
        return {f: "format_error" for f in FIELDS}
    out = {}
    for f in FIELDS:
        g, p = NORMALIZERS[f](gold.get(f)), NORMALIZERS[f](pred.get(f))
        if g == p:
            out[f] = "ok"
        elif g is None:
            out[f] = "invented"
        elif p is None:
            out[f] = "missed"
        else:
            out[f] = "wrong"
    return out

def run(split: str, version: str) -> None:
    items = [json.loads(l) for l in Path("dataset.jsonl").read_text().splitlines() if l.strip()]
    items = [i for i in items if i["split"] == split]
    per_field = defaultdict(lambda: defaultdict(int))
    rows = []
    for item in items:
        pred = safe_extract(item["text"])          # TODO: call guard(), then extract() from AIL-8; model_dump(mode="json") or None on failure
        outcome = compare(item["gold"], pred)
        for f, o in outcome.items():
            per_field[f][o] += 1
        rows.append({"id": item["id"], "pred": pred, "outcome": outcome})
    # TODO: print accuracy per field, invented count, exact match;
    #       print a table of errors; save everything to results/{version}_{split}.json
```

  The expected output looks roughly like this:
  ```
  version=v1 split=dev n=15
  field           acc     invented  missed  wrong
  update_type     93.3%   0         0       1
  product         86.7%   0         1       1
  supplier        80.0%   1         0       2
  effective_date  66.7%   2         1       2
  new_price       86.7%   1         0       1
  exact match:    53.3%
  ```
- [ ] **5. The "before" run** on `dev`, 2–3 times: run A (DeepSeek, public texts; the script itself selects `private: false`) and run B (Ollama `qwen3:4b`, all texts). The flag is `--provider deepseek|ollama`; the provider and model are part of the result file name. We save the results.
- [ ] **5b. Guard check.** We run `--provider deepseek` without the public-text filter: the script must fail with `PermissionError` before the first network request. We keep this as a test.
- [ ] **6. Error analysis.** We write the error groups with hypotheses into `results/analysis_v1.md` (for example: "dates like 'from December 1' → the model picks the wrong year → give the email's date in the context"). Labeling errors we find are fixed in the gold set with a comment.
- [ ] **7. Improvement.** One change per iteration (field description, a rule in the prompt, an `other` value in `update_type`, the email's date in the context, normalization), with a run after each. 2–4 iterations.
- [ ] **8. Final run on the holdout.** We run the first and the last versions on the 5 held-out texts. We compare the gain on `dev` and on `holdout`.
- [ ] **9. Report.** In `results/summary.md`: a table "provider → version → per-field accuracy → exact match → inventions → cost/time of the run" (via `estimate_cost` from chapter 1.7) and 3–5 sentences of conclusions, including how far the local 4B model lags behind DeepSeek on the same public texts and the fact that the texts were written or generated for the course.

## Done when

- The script prints per-field accuracy in percent for the "before" and "after" versions, as well as exact match and the number of inventions.
- There is an error analysis with groups and hypotheses, and a final comparison on the holdout.
- The code and the dataset are saved in the repo and run with a single command (`python eval_extract.py --split dev --version v3`).
- Not a single message with real personal data got into the dataset (it is worth checking once more by eye), and texts with `private: true` technically cannot go to a cloud provider (`guard` + a test).

## Self-check quiz

1. What is a gold set (gold), and why is it labeled by hand?
2. Why is an "invention" (gold = null, pred = a value) worse than a "miss" (gold = a value, pred = null) for a system that automatically updates product pages from supplier emails?
3. Why normalize values before comparing them? When is normalization harmful?
4. Exact match = 50%, while the accuracy of every field is ≥ 85%. How is that possible?
5. What is a holdout, and why is it needed even with 20 examples?
6. What is wrong with this comparison?
   ```python
   correct = sum(1 for g, p in zip(golds, preds) if g == p)
   print("accuracy", correct / len(golds))
   ```
7. Version v2 scored 84%, v1 82%, one run each on 15 texts. Which conclusion is correct?
   a) v2 is better; b) v1 is better; c) the difference is within the noise, repeats and more data are needed; d) both are bad
8. Why does the annotation guide end up in the prompt almost word for word?
9. A customer message from support needs to be added to the dataset: `Hello, this is Emily Johnson, order 10482, phone +1 (555) 013-4567. The North Mug arrived cracked, and it's no longer on the site. Will you send a replacement?` What has to be done before that?
10. Which of these is an example of a systematic error rather than a random one?
    a) the model once mixed up the suppliers; b) the model always uses the current year for dates without a year; c) one answer didn't parse because of a network drop; d) the annotator made a typo in one product name
11. Why is it important to save in `results/` not only the metrics but also the predictions for each example and the run configuration?
12. A customer message has been anonymized: no name, no phone, no order number. Can it now be sent to DeepSeek?
    a) yes, anonymized is fine; b) no: by the course rule, real customer messages go only to the local model, and only made-up similar ones go to the cloud; c) yes, if thinking is turned off; d) only through OpenRouter
13. On DeepSeek we got v2 = 88%, and a week later v3 = 92%. Which two provider-specific things need to be checked before celebrating?
14. Why must the accuracy of Ollama and DeepSeek be compared on the same public texts rather than "Ollama on all 20 vs DeepSeek on 17"?

## Answers

1. The correct answers for each input, which the predictions are compared with. By hand, because that is the very definition of "correct"; labeling is where decisions about edge cases are made.
2. An invention triggers an action on an event that doesn't exist (a product is taken off sale or repriced although the supplier wrote nothing of the kind), while a miss is only a missed update. For automatic reactions, false positives usually cost more.
3. So that values equivalent for the task (`Tea Yard LLC`/`tea yard`, `"North Mug"`/`North Mug`) aren't counted as errors. It is harmful when it merges different things: for example, normalizing `Tea Yard Wholesale` → `tea yard` in a task where these are different suppliers with different prices.
4. The errors in different fields fall on different examples: in each example some single field is wrong, so there are few records where everything is correct.
5. A held-out part of the data that isn't looked at during improvements. It checks that an improvement generalizes rather than being fitted to specific examples.
6. Whole objects are compared without normalization: one single number, with no way to see which fields break; case and date formats produce false errors; inventions, misses and format errors aren't told apart.
7. **c.** A 2 percentage point difference on 15 texts is less than one example, within the noise.
8. The labeling rules are the task specification; if the model isn't told them, it will settle edge cases its own way and "make mistakes" relative to the gold set.
9. Work with a copy; anonymize or rewrite the message: remove the name, phone, order number and any other customer data, keeping the structure and the product; mark it `"private": true`. If in doubt, make up a similar message.
10. **b.** A repeating error with a common cause; it is cured with a single change (for example, giving the email's date).
11. To do error analysis, compare versions on specific examples and reproduce a run (model, prompt, schema, date): this is the foundation of future evals.
12. **b.** Anonymization doesn't change the fact that this is a customer's correspondence with the shop, and it is not shown to outsiders, including a cloud provider (DeepSeek's servers are in China); real messages go only to Ollama, and fake look-alikes go to the cloud.
13. That the model version behind the `deepseek-flash` alias didn't change (the `model` field in the run logs), and that thinking mode/`temperature` are the same in both runs (in thinking mode `temperature` is ignored). Plus the usual: noise and repeats.
14. The sets differ: customer messages are harder and noisier than supplier emails, and the difference in the numbers would mix "the model is worse" with "the texts are different". A fair comparison is on the intersection (the public texts), with the private ones as a separate row.

## What's next

In [2.6 · Tool calling: the model calls 3 functions (AIL-10)](AIL-10.md) the model will not only return data but also ask our code to perform actions. And `eval_extract.py` will come back at the evals stage as the foundation of a full test suite.
