# 5.1 · Query rewriting in RAG: multi-query, HyDE, filters  (AIL-60)

> **Week 5** · RAG · ⏱ ~4 h · Practice

<!-- description: Query understanding in RAG: query rewriting, multi-query, HyDE and extracting metadata filters from the question. Better retrieval without touching the index. -->
<!-- source-sha256: 2ad81cc297d9 -->

## Why an AI engineer needs this

Customers don't ask questions the way the knowledge base is written: they write casually, with typos, without naming the section, sometimes with three questions in one message. The knowledge base, meanwhile, is written in the language of the shop's rules: "return", "opened packaging", "rate by zone". The index from AIL-20 searches well when the question resembles the text of the knowledge base, and the miss analysis in AIL-19 and the sanity check in AIL-20 show that this is not always the case. Query rewriting and automatic filters are the cheapest ways to improve retrieval quality without touching the index. In interviews this is the standard "query understanding" topic: multi-query, HyDE, self-query (extracting filters from the question).

## Theory

### The gap between the question and the document

Let's compare:

- Question: "so can I return opened tea? opened the pack, didn't like the taste"
- Document: "## Returning opened tea. Opened tea and coffee are not accepted for return; they cannot be exchanged either."

The question's embedding carries "noise": emotions, casual words ("send back", "didn't like"), typos, extra details. The document's embedding is the dry text of rules. They are close, but not as close as they could be. The job of the query understanding stage is to **turn a person's question into a query that resembles the document** and to **extract structural conditions from the question** (the page category, whether the archive is needed) to narrow the search.

```
question ─► LLM: {categories: ["returns"], include_archived: false,
                  queries: ["returning opened tea",
                            "which products can't be returned"]}
         ─► search for each query with the filter category=returns, archived=0
         ─► merge the results ─► top-k
```

### Technique 1: Query rewriting

The first three techniques change the query itself, the fourth adds a filter to it; an LLM takes part in all four one way or another.

The LLM rewrites the question into one clean search query: in the knowledge base's words, with its terms, without noise. This is the simplest option, and it often already gives a noticeable gain when the question and the knowledge base are written in different words (a casual question → the official text of the rules).

Pros: cheap (a short prompt, a small model). Cons: one query means one interpretation; if the model misunderstood the question, the search goes the wrong way.

### Technique 2: Multi-query

The weak spot of rewriting is the single interpretation. Multi-query closes it: the LLM generates 2–3 **different** queries: paraphrases, different aspects, sub-questions. A search is run for each, and the results are merged. This is insurance against an unlucky wording and a way to cover a compound question ("can I return a lamp if it doesn't suit me, and who pays for shipping it back?" → two sub-queries).

Merging the results:

- **Simple:** collect all the chunks found, deduplicate by id, take the best score for each, sort. This works when the scores are comparable (one embedding model, one metric).
- **Reciprocal Rank Fusion (RRF):** instead of the scores, add up `1 / (60 + rank)` from each result list. Robust to different scales. Covered in detail in AIL-22, where RRF is needed for the hybrid; here we can start with the simple merge and switch later.

It is important that **the original question also takes part** in the search as one of the queries: rewriting sometimes makes things worse.

### Technique 3: HyDE (Hypothetical Document Embeddings)

Rewriting and multi-query make the question cleaner, but it stays a short question. HyDE comes at it from the other side. The idea: ask the LLM to **write a hypothetical answer**, a fragment that resembles a help center page, and search by the embedding of that fragment instead of the question. The embedding of a "made-up document" lies closer to real documents than the embedding of a short question (recall AIL-18: questions and passages live in slightly different regions of the space).

```
question: "how much it gonna cost to send 3 kilos to another city"
HyDE:     "Delivery rates. Zone 2: other cities. Parcel 1–3 kg: $4.70,
           3–5 business days. Free delivery for orders over ..."
search by the embedding of the HyDE text
```

An important subtlety: the hypothetical document **may contain made-up facts** (wrong prices and delivery times). This is not a problem: it is used only for search and is **never shown to the customer** and never goes into the answer's context. Cons: more expensive and slower (generating 100–200 tokens), and on topics the model knows nothing about (rules peculiar to our shop specifically) the invention can lead the search astray.

### Technique 4: extracting filters (self-query)

So far we have changed the text of the query. The second half of the task from the diagram above is the structural conditions. A structured condition on the metadata is extracted from the question: the page category (`category`: delivery, payment, returns, warranty, promo, orders, products) and whether the archive is needed (`archived`). Then the filter is applied to the search (AIL-20). The question "so can I return opened tea?" is clearly about returns, and without a filter the top 5 will include semantically similar pieces of the `products/tea-sencha.md` page about an opened pack.

A two-stage approach, rules first, then the LLM:

```python
import re

ALIASES = {
    "returns":  ["return", "send back", "refund", "exchange"],
    "delivery": ["deliver", "courier", "pickup point", "shipping"],
    "payment":  ["payment", "pay by", "checkout"],  # not "card": it is inside "cardboard", "discard"
    "warranty": ["warrant", "broke", "defect"],
    "promo":    ["promo", "coupon", "discount"],
    "orders":   ["where is my order", "order status", "cancel my order"],
}

def detect_category_rules(q: str) -> str | None:
    ql = q.lower()
    hits = {cat for cat, words in ALIASES.items() if any(w in ql for w in words)}
    return hits.pop() if len(hits) == 1 else None  # 0 or 2+ matches: undecided
```

We don't catch the `products` category with rules: the LLM recognizes a product by its name. Rules are cheap, predictable and testable. The LLM steps in when the rules haven't decided, and together with rewriting: one call returns the queries, the categories and the archive decision.

Filtering rules:

- **Category not determined → no filter.** A wrong filter is worse than none: it is guaranteed to exclude the correct answer.
- **Two categories are needed** ("what order total gets free delivery if I pay with a promo code?": the answer is in `delivery.md` and in `promo.md`, and the thresholds there differ) → either two searches with different filters or a `category IN (...)` filter. Chunks of both pages must get into the context. The same goes for a product's warranty: it is both in `warranty.md` and in `products/lamp-light.md`.
- **The filter value is validated against the list** of allowed ones (`delivery|payment|returns|warranty|promo|orders|products`). The LLM may return `"Returns"`, `"return"` or `"refund"`; such values are either normalized or discarded.
- **The archive only on explicit request** ("last year's return rules"). A wrongly included archive is worse than a missed one: the bot will confidently quote canceled deadlines.

### One LLM call with a structured response

Rewriting, multi-query and filters are convenient to get in one call: the model returns JSON with the queries, the categories and the archive decision. We covered structured output (JSON by a schema) in chapter 2.2 · Structured output: Pydantic + Instructor (AIL-8), and we apply it here. First, the reference version on an API that can guarantee the schema (an illustrative call in the style of the official Anthropic SDK); how to do the same on DeepSeek and Ollama, where guarantees are harder, is in the next section. The Pydantic model `QueryPlan` and the `SYSTEM` prompt are shared by all the variants:

```python
# Illustrative: model name comes from .env; check the current Anthropic docs
import json, os
from anthropic import Anthropic
from pydantic import BaseModel, field_validator

CATEGORIES = {"delivery", "payment", "returns", "warranty", "promo", "orders", "products"}

class QueryPlan(BaseModel):
    categories: list[str]         # empty = unknown
    include_archived: bool = False
    queries: list[str]            # 2-3 search queries

    @field_validator("categories")
    @classmethod
    def only_known(cls, v):
        return [c.lower() for c in v if c.lower() in CATEGORIES]

SYSTEM = """You turn a customer's question to an online shop's support into search queries
for the shop's help center. Page categories:
delivery, payment, returns, warranty, promo, orders, products.
Return JSON only: {"categories": [...], "include_archived": false, "queries": [...]}.
- categories: only those the question clearly refers to; [] if unsure.
- include_archived: true only if the customer explicitly asks about old or previous rules.
- queries: 2-3 different queries in the help center's wording (returns, delivery
  rates, warranty terms). Keep exact identifiers from the question unchanged:
  product names, SKUs, weights, amounts, dates."""

client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment

def plan_query(question: str) -> QueryPlan:
    msg = client.messages.create(
        model=os.environ["REWRITE_MODEL"],
        max_tokens=300,
        system=SYSTEM,
        messages=[{"role": "user", "content": question}],
    )
    return QueryPlan.model_validate_json(msg.content[0].text)
```

A small, fast model is enough for rewriting: the task is simple, and the call sits on the hot path of every question. We always handle the parsing error: the fallback is the original question without a filter.

### Other techniques (know the names)

The four techniques above are what we build in the practice. A few more come up in articles and interviews:

- **Step-back prompting**: first ask a more general question ("how do product returns work in the shop"), then the specific one.
- **Decomposition**: split a compound question into sub-questions and assemble the answer from the parts (the beginnings of agentic RAG).
- **Query routing**: decide whether a search is needed at all ("hi" doesn't need one) and which source to go to ("where is my order 1042?" is a question for the orders database, not the help center; we hand it off to a human).
- **Conversational rewriting**: in a chat, rewrite "and on the Light Mini?" into a standalone question that takes the history into account ("what is the warranty on the Light Mini Lamp?"). Needed if we build a bot with a dialogue.

### How to measure

Each technique adds an LLM call and complexity, so we keep only what the numbers confirm. The metric is the same as in AIL-19: **hit rate@k** on the golden set. We extend it to **20 questions** of different types (the list is in "Practice"). We compare the variants:

| Variant | What it does |
|---|---|
| baseline | the original question, no category filter (archive excluded, as in AIL-20) |
| + filter | the original question + a category filter and the archive decision |
| + rewrite | multi-query, no filter |
| + rewrite + filter | multi-query + filter |
| + HyDE (opt.) | a hypothetical document (+ filter) |

This shows the contribution of each technique separately, not "it got better overall". Besides hit rate, we record **latency** and **cost** per question: rewriting adds an LLM call to the hot path.

We keep noise in mind: on 20 questions a difference of 1 question is 5 percentage points, and it may be random (for example, the LLM rewrote differently on a rerun). We look for a difference of 3+ questions and go through the specific changes: which questions got fixed and which broke.

## DeepSeek and Ollama: how we do it

Rewriting needs one short LLM call with JSON as output. Here the providers differ noticeably: **DeepSeek has a JSON mode but no JSON by schema**, while with Ollama the schema can be passed right in the request. On top of that, DeepSeek has reasoning on by default, and that hurts latency and reproducibility.

What is new compared with indexing is privacy: a real **customer question** may contain a name, a phone number, an order number. Customers' personal data never goes to cloud models (DeepSeek's servers are in China, but the rule applies to any cloud provider). The golden set is made up, so DeepSeek is acceptable in the practice; in the production bot, Ollama rewrites the real messages.

### DeepSeek: JSON mode + reasoning turned off

Facts as of November 2026 (from [JSON Output](https://api-docs.deepseek.com/guides/json_mode), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) and the [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion)):

- `response_format={"type": "json_object"}` guarantees only "valid JSON", not our schema. The documentation doesn't describe a `json_schema` option. The prompt must contain the word "json" and an example of the required structure, and `max_tokens` must have headroom.
- If the model fails to produce valid JSON, the API replaces the content with whitespace: `content` can be **empty** with `finish_reason == "stop"`. This has to be handled: a retry or a fallback.
- Reasoning (thinking) is on by default. In reasoning mode `temperature` **has no effect** (there is no error, the value is simply ignored). Rewriting doesn't need reasoning: we turn it off with `extra_body={"thinking": {"type": "disabled"}}`. Then the call is faster, and `temperature=0` works again, which matters for reproducible evals.

```python
# Illustrative: DeepSeek via the OpenAI SDK; key and model name come from .env
import json, os
from openai import OpenAI

ds = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")

SYSTEM_JSON = SYSTEM + """
Output json only, exactly like this example:
{"categories": ["returns"], "include_archived": false, "queries": ["returning opened tea", "which products can't be returned"]}"""

def plan_query_deepseek(question: str) -> QueryPlan | None:
    resp = ds.chat.completions.create(
        model=os.environ["REWRITE_MODEL"],              # e.g. deepseek-flash
        messages=[{"role": "system", "content": SYSTEM_JSON},
                  {"role": "user", "content": question}],
        response_format={"type": "json_object"},
        temperature=0,                                  # has effect only with thinking disabled
        max_tokens=400,
        extra_body={"thinking": {"type": "disabled"}},  # DeepSeek-specific switch
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:                                        # documented: may come back blank
        return None                                     # caller falls back to the raw question
    try:
        return QueryPlan.model_validate_json(text)      # schema is enforced HERE, not by the API
    except ValueError:
        return None
```

### Ollama: the schema right in the request

Ollama's native `format` parameter accepts a JSON Schema, and the model's output is constrained to that schema ([Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)). Pydantic gives the schema in one line:

```python
# Illustrative: small local model, e.g. qwen3:4b (~2.5 GB; tools and thinking per the Ollama library)
import ollama

def plan_query_ollama(question: str) -> QueryPlan:
    resp = ollama.chat(
        model=os.environ["REWRITE_MODEL_LOCAL"],
        messages=[{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": question}],
        format=QueryPlan.model_json_schema(),   # output is constrained to this schema
        options={"temperature": 0},
        think=False,                            # thinking models: no reasoning for a rewrite task
    )
    return QueryPlan.model_validate_json(resp.message.content)
```

Pydantic validation is still needed: the schema guarantees the shape, not the meaning (`"categories": ["refund"]` passes a schema with a list of strings, but not our validator). On `think`: according to the [Ollama documentation](https://docs.ollama.com/capabilities/thinking), `false` asks the model not to reason, and a model that can't turn reasoning off uses the minimal level.

**Memory.** The `bge-m3` embedding model (AIL-20) is already held in memory alongside. RAM: 8 GB means 4B, `qwen3:4b` (a ~2.5 GB download, per the Ollama library page); 16 GB means 7–8B, for example `qwen3:8b` (~5.2 GB); 32 GB and more means 14B and larger. A model takes roughly its size in memory plus the context; we estimate the total size of the loaded models in advance (`ollama ps`). A 4B model is usually enough for rewriting, but we check this with numbers on the golden set. If it makes mistakes in the JSON or in the category, for made-up questions that is an argument for DeepSeek, and for real messages, for a larger local model if memory allows. We install the model in advance with `ollama pull`.

### Comparing providers for this chapter

| What we need | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON output | Structured outputs / tool use (check the current docs) | `response_format` with `json_schema` (structured output by a schema) | Only `json_object`: valid JSON without a schema | `format` = JSON Schema (native API) |
| Schema guarantee | Yes, in structured outputs mode | Yes, in strict mode | **No** → Pydantic + retry/fallback | The shape is constrained by the schema; Pydantic checks the meaning |
| Empty response | — | — | Possible (documented) → handle it | — |
| Reasoning by default | Depends on the model and parameters | Depends on the model | **On**; turned off with `thinking: disabled` | In thinking models; `think=False` |
| `temperature` | Newer models have restrictions (check the docs) | Depends on the model | Ignored in reasoning mode | Works via `options` |
| Rewrite latency | Network | Network | Network + reasoning if not turned off | No network, but depends on the machine |
| Real customer messages | Not allowed (cloud) | Not allowed (cloud) | Not allowed (cloud) | Allowed: the data doesn't leave the machine |

### What to use in the practice

- **Main path:** DeepSeek `deepseek-flash` with reasoning turned off. The data is the made-up golden-set questions and the public knowledge base, so it can be sent. The questions must contain nothing from real customer requests (names, phone numbers, order numbers).
- **Local option:** Ollama with `format` = the schema; we compare hit rate and latency with DeepSeek on the same 20 questions. This is also the option for the production bot with real messages.
- **For comparison (optional):** Claude or OpenAI with structured outputs, the original code from "Theory".
- **HyDE**: any of the generators; the hypothetical document doesn't go anywhere except the search anyway.

## Learning path

1. We reread the "Query processing" stage in [AIL-59](AIL-59.md), our own miss analysis from [AIL-19](AIL-19.md) and the sanity check from [AIL-20](AIL-20.md) (≈10 min). We write down which misses were caused by the wording of the question: those are the ones we fix.
2. We find and read the paper that introduced HyDE: "Precise Zero-Shot Dense Retrieval without Relevance Labels" (Gao et al., 2022, arXiv): the abstract, the introduction and the figure with the overall scheme (≈25 min). Takeaways: why a hypothetical document rather than the question, and why factual errors in it don't hurt the search.
3. We open [Eugene Yan: Patterns for Building LLM-based Systems](https://eugeneyan.com/writing/llm-patterns/) → in the RAG section we find the part about HyDE and about combining search with filters (≈15 min).
4. We open [DeepSeek: JSON Output](https://api-docs.deepseek.com/guides/json_mode) and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (≈20 min). Takeaways: `json_object` without a schema, the requirement for the word "json" and an example in the prompt, an empty `content` as a documented case, how to turn reasoning off and which parameters have no effect in reasoning mode.
5. We open [Ollama: Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs) and [Thinking](https://docs.ollama.com/capabilities/thinking) (≈15 min). Takeaways: `format=Model.model_json_schema()`, `model_validate_json` on the output, the `think` parameter.
6. For comparison, the structured outputs documentation from [Anthropic](https://docs.anthropic.com) or [OpenAI](https://platform.openai.com/docs) (≈15 min). We write down how "JSON by a schema with a guarantee" differs from DeepSeek's JSON mode.
7. The sqlite-vec documentation (AIL-20) on filtering: we refresh how a filter on `category` and `archived` goes inside a KNN query (≈10 min).

## What to watch out for

- **Rewriting loses exact identifiers.** The LLM "improves" Light Mini into "desk lamp", `TEA-SENCHA` into "green tea", and throws out "3 kg" as an unnecessary detail, and the search finds the warranty of the wrong lamp or the wrong row of the rate table. The prompt says explicitly: "keep product names, SKUs, weights and amounts unchanged". The problem is fully solved by hybrid search (AIL-22).
- **A false filter.** The model "guessed" that the question "what if I don't like it?" is about returns, although the customer was asking about the warranty: the `returns` filter excludes the correct answer. Better no filter than a wrong one.
- **A false archive.** "Wasn't it 30 days before?" is not a request to show the old rules: the customer needs the current period. We include the archive only on explicit request.
- **Substring aliases give false positives**: `"card"` is found in "cardboard box" and "discard", `"deliver"` in "who pays for return delivery" (a question about returns). In production code we search on word boundaries (`re.search(r"\bcards?\b", ...)`) and cover this with a test.
- **We don't throw the original question out** of multi-query: rewritten queries are sometimes worse.
- **The HyDE text doesn't go into the answer.** It may be made up; it is for search only.
- **Latency.** +1 LLM call per question: 300–1500 ms. Tolerable for a support chat, not for autocomplete in site search. A small model, a short `max_tokens`, a cache of identical questions.
- **Invalid JSON / unknown category.** Always validation (Pydantic) and a fallback to the original question.
- **Nondeterminism.** The same question may be rewritten differently between runs. For the eval we keep the temperature low and/or cache query plans to disk so that comparisons are reproducible.
- **Golden-set leakage into the prompt.** We don't put examples from the golden set into the rewriting prompt: we would get inflated numbers. Few-shot examples come from other questions.

## Practice

We work in `projects/02-support-kb-rag/rag/query.py` and `projects/02-support-kb-rag/eval/`.

- [ ] **A golden set of 20 questions**: we move the questions from `notes/rag.md` (AIL-59) and `golden.jsonl` from AIL-19 into `eval/golden.jsonl` and extend it to 20 lines across all categories. Format: `{"q": ..., "category": "returns" | null, "must_contain": [...]}` (`null` means the question doesn't determine a category). Minimum: 5 casual questions or questions with typos, 4 without an explicit category, 4 with an exact identifier (the name of a similar product, a SKU, a weight, an amount), 2 spanning two categories, 1 about the old return rules (key strings from `returns-2025.md`). We make up the questions ourselves.
- [ ] **`detect_category_rules`** with aliases. Offline tests in `tests/test_query.py`: "can I return opened tea?" → `returns`; "who pays for delivery if I return the lamp?" → `None` (two categories: the LLM or a multi-category filter decides); "which mug makes a better gift" → `None`; "is the North Mug sold in a cardboard box?" → not `payment`.
- [ ] **`plan_query(question) -> QueryPlan`**: one LLM call, JSON (`categories`, `include_archived`, `queries`), Pydantic validation, fallback. Rules take priority over the LLM when they are unambiguous. The main option is DeepSeek (`json_object`, reasoning turned off, handling an empty `content`); the second is Ollama with `format=QueryPlan.model_json_schema()`. The provider is chosen by an environment variable, `DEEPSEEK_API_KEY` lives only in `.env`.
- [ ] **An offline fallback test**: a fake client returns an empty string and invalid JSON, and `plan_query` returns the original question without a filter (and without the archive) and doesn't crash.
- [ ] **Multi-query search**: `search_multi(question, k=5)`: the original question + 2–3 rewritten queries, a search for each via `search(qvec, k, category=..., include_archived=...)` from AIL-20 (for two categories, a separate search for each), merging with deduplication by chunk id (best score or RRF).
- [ ] **A plan cache**: `eval/cache/plans.json` (question → plan), so that reruns are free and reproducible.
- [ ] **An eval script** `eval/run_query_eval.py`: the variants baseline / +filter / +rewrite / +rewrite+filter (opt. +HyDE), for each hit@3 and hit@5, mean latency. A table in `eval/RESULTS.md`:

  | Variant | hit@3 | hit@5 | latency, ms |
  |---|---|---|---|
  | baseline | /20 | /20 | |
  | + filter | | | |
  | + rewrite | | | |
  | + rewrite + filter | | | |

- [ ] **Analysis**: a list of the questions that got fixed and the ones that broke compared with baseline, with a one-line reason. Separately we mark the questions with exact identifiers: they will be useful in AIL-22; we check that the archive came up only on the question about the old rules.
- [ ] **(Optional) HyDE**: a function `hyde(question) -> str` (a short fragment "in the style of the help center"), a search by its embedding; we add a row to the table.
- [ ] **Providers**: we run the "+ rewrite + filter" row twice, with DeepSeek and with Ollama. We record hit@3, latency and the share of fallbacks (empty or invalid JSON) for each. For DeepSeek we also record the cost from `usage`.
- [ ] **(For comparison, optional)** The same on Claude or OpenAI with structured outputs: were there fewer fallbacks?

## Done when

- `eval/RESULTS.md` has a number: how much hit rate@3 and @5 changed from baseline to the best variant, on the same golden set of 20 questions.
- The contributions of the filter and of rewriting are visible separately; there is an analysis of the questions that got fixed and the ones that broke.
- Category detection is covered by offline tests; LLM errors (invalid JSON, unknown category) don't break the search; the archive gets into the results only on explicit request.
- We can explain which model rewrites real customer messages and why.

## Self-check quiz

1. Why can the embedding of a customer's question match the embedding of the needed knowledge-base chunk poorly? What are the two main reasons?
2. How does multi-query differ from simple query rewriting, and what does it insure against?
3. What is HyDE? Why are errors in the hypothetical document not so dangerous?
4. The question doesn't name a category, and the LLM returned `"categories": ["delivery"]` "at random". What is better to do? a) apply the filter: the model is smart b) set no filter c) search only by `returns` d) refuse to answer
5. Why is it worth keeping the original question among the queries in multi-query?
6. What is wrong with this rewriting prompt?
   ```
   Rewrite the customer question into a clean, general search query.
   Remove details like product names, SKUs and numbers.
   ```
7. Which comparison shows the contribution of the filter separately from the contribution of rewriting? What set of runs is needed?
8. Why is a small, fast model usually chosen for query rewriting?
9. On 20 questions hit@3 grew from 13 to 14. Can we say that rewriting helps?
10. How should the question "what order total gets free delivery if I pay with a promo code" be handled?
11. What is golden-set leakage into the prompt, and why is it dangerous?
12. DeepSeek is called with `response_format={"type": "json_object"}` and `temperature=0`, with nothing else changed. What two problems does this create for the eval?
13. What is wrong with this code?
    ```python
    resp = ds.chat.completions.create(model=MODEL, messages=msgs,
                                      response_format={"type": "json_object"})
    plan = json.loads(resp.choices[0].message.content)
    category = plan["categories"][0]
    ```
14. How does Ollama's `format` differ from DeepSeek's `json_object`? a) no difference b) Ollama constrains the output to the given JSON schema, DeepSeek guarantees only valid JSON c) DeepSeek is stricter d) `format` works only in the OpenAI-compatible API
15. A support bot receives real customer messages. Which model should rewrite the queries? a) DeepSeek, since it is cheaper b) any cloud model, if reasoning is turned off c) a local model via Ollama d) a cloud model, but with the word "order" removed from the message

## Answers

1. Casual words, typos and extra details in the question versus the official wording of the rules ("send back" versus "return"); a short question and a long passage are texts of different shapes and lie in different regions of the embedding space.
2. Rewriting gives one "clean" query, multi-query gives several different ones; a search is run for each and the results are merged. It insures against an unlucky interpretation and covers compound questions.
3. The LLM writes a hypothetical answer fragment in the style of the help center, and the search goes by its embedding. It is used only for search: what matters is that it "resembles" the needed document in topic and terms, and inaccurate prices and delivery times never reach the customer's answer.
4. **b.** A wrong filter is guaranteed to exclude the correct answer; without a filter the needed chunk may still be found.
5. Rewritten queries are sometimes worse than the original (they lost a detail or misread the meaning); the original question is insurance.
6. It asks to remove product names, SKUs and numbers, and these are the most precise signals for searching the knowledge base (`TEA-SENCHA`, Light Mini versus Light, "3 kg" for the rate table). It should be the opposite: keep them unchanged. Also, the output format is not specified and the filters (category, archive) are not taken into account.
7. Four runs on the same golden set: baseline, filter only, rewriting only, rewriting + filter. The differences baseline→filter and baseline→rewrite show the contribution of each separately.
8. The task is simple, and the call sits on the hot path of every question: latency and cost matter more than maximum quality.
9. No: a difference of one question out of 20 is within the noise (including because of LLM nondeterminism). A larger difference, repeated runs and an analysis of the specific questions that changed are needed.
10. Recognize two categories (`delivery` and `promo`), run two searches (with a filter for each) or a `category IN (delivery, promo)` filter, and make sure chunks of both pages get into the final context: the free delivery threshold differs between them, and the answer has to take that into account.
11. When examples from the test set get into the prompt (few-shot), the model "has seen the answers", and the metrics are inflated without reflecting the quality on new questions.
12. First: reasoning is on by default, so `temperature=0` is ignored (the rewriting is nondeterministic), and the call is slower and more expensive. `extra_body={"thinking": {"type": "disabled"}}` is needed. Second: JSON mode doesn't check the schema; the word "json" and an example in the prompt, Pydantic validation and handling of an empty response are needed.
13. The prompt may lack the word "json" and an example (a DeepSeek requirement); `content` can be empty, and `json.loads` will fail; the schema isn't checked (the `categories` key may be missing); `[0]` fails on an empty list, an unknown category isn't discarded, and a second category is lost. `QueryPlan.model_validate_json`, an emptiness check and a fallback to the original question are needed.
14. **b.** Ollama constrains generation to the given schema, while DeepSeek's JSON mode promises only syntactically valid JSON (and sometimes an empty response). In both cases our validator checks the meaning of the values.
15. **c.** A customer's message may contain a name, a phone number, an order number, and customers' personal data never goes to any cloud provider. The cloud is only for the made-up golden-set questions.

## What's next

Rewriting doesn't fully save exact identifiers: SKUs, names of similar products, numbers from tables. That is the job of [AIL-22 · Hybrid search (BM25) and reranking](AIL-22.md), where we add lexical search, RRF and a cross-encoder on top of the same golden set.
