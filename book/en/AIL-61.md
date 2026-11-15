# 6.2 · Synthetic data for evals  (AIL-61)

> **Week 6** · Evals · ⏱ ~4 h · Practice

<!-- description: Synthetic data for evals: a model drafts questions over the knowledge base, a human reviews them. Diversity dimensions, dedup and too-easy filters. -->
<!-- source-sha256: 15a67af74579 -->

## Why an AI engineer needs this

Coming up with 100 good questions about the shop's knowledge base by hand is a day of tedious work, and the questions come out one-sided: we ask about what we ourselves remember, in the words the knowledge base is written in. Customers write differently: with typos, two questions at once, an order number in the middle of a complaint. A model generates a draft in minutes, and we, as the authors of the knowledge base, review and clean it. Synthetic data generation is a standard industry technique and a frequent interview topic ("how did you build a test set when there were no users yet?").

## Theory

### The idea: the model writes a draft, a human makes the decision

Right now we have 20 questions in `eval/golden.jsonl` from week 5 and five questions from [AIL-27](AIL-27.md) on which the assistant makes mistakes. In the next chapter, 6.3, the set grows to 50–100 questions, and the model writes some of the missing ones.

A synthetic set is questions and reference answers that a model generated from our own data, here from the `kb/` pages. A reference answer (the reference) is the answer we consider correct and later compare the assistant's answer against. The scheme for RAG:

```
 random kb/ chunk ──► generator model ──► candidate {question, answer, quote}
                                                   │
                                                   ▼
                                         automatic filters
                                  (duplicates, copy-paste, "unanswerable")
                                                   │
                                                   ▼
                                          manual review (us)
                                                   │
                                                   ▼
                                           eval/golden.jsonl
```

The key word is **draft**. Not a single synthetic question gets into the set without our "yes". The model doesn't know which questions customers actually ask, and it regularly gets the reference wrong.

### Why a "random chunk", and why that is not enough

Starting from a random chunk is convenient: the answer is guaranteed to be in it, and the candidate comes with a link to its source right away. For retrieval metrics (hit rate from [AIL-27](AIL-27.md)) this is exactly what we need: we know which chunk the search must find. But the approach has three known biases:

1. **Copied wording.** The model takes a phrase from the chunk and turns it into a question: "Are opened tea and coffee accepted for return?" Vector search, and BM25 even more so, finds such a chunk almost every time, and hit rate is inflated. A real customer writes: "opened a pack of sencha, didnt like the taste, can i send it back?".
2. **One chunk, one question.** Comparative questions ("how is the warranty on the Light different from the Light Mini") and multi-step ones don't come out this way, and they are the hardest.
3. **No questions "outside the knowledge base".** A good assistant must be able to say "the knowledge base has no answer" and pass the question to a human operator. A special case is "where is my order 1042?": there is no answer in `kb/`, and there can't be. This needs checking too.

That is why the generator is built around **diversity dimensions**, not only around the chunk.

### Diversity dimensions

A dimension is an axis along which questions should differ: type, difficulty, who asks, how they write. In his articles Hamel Husain suggests defining several such axes with concrete values and generating questions from their combinations. For the Shelf shop's support assistant:

| Dimension | Values |
|---|---|
| Question type | factual, comparative, multi_hop, unanswerable |
| Difficulty | easy (the answer is in one sentence), medium (must be assembled from a paragraph or a table), hard (several places, conditions) |
| Persona | first-time buyer, regular customer, choosing a gift, asking about their own order |
| Style | neat, conversational, with typos and no punctuation, very short |
| Message form | one question, two questions at once, a question inside a story |
| Category | delivery, payment, returns, warranty, promo, orders, products |

We pick a combination (for example, `comparative / hard / choosing a gift / conversational / one question / products`), select suitable chunks and ask the model to generate a question for that combination. This way we set the distribution of questions, not the model.

The rule for any style: **the question contains no category words or knowledge-base headings**. A customer doesn't write "please clarify the return policy" but "how much 2 ship 3 kilo to chicago". Such questions are also what tests the query rewriting from [AIL-60](AIL-60.md).

### How to get each type

The four types from the first row of the table differ in how many places in the knowledge base the answer needs: **factual** is one fact from one chunk; **comparative** compares facts from two pages; **multi_hop** builds the answer from several related facts; **unanswerable** has no answer in `kb/`, and the correct behavior is a refusal. Each type needs its own generation method:

- **factual**: one random chunk → a question it answers.
- **comparative**: two similar products (Light and Light Mini with different warranties) or one topic on two pages (the free delivery threshold differs between `delivery.md` and `promo.md`) → one chunk for each → a question that needs both. For pages that disagree, the reference names both numbers, as the prompt from [AIL-23](AIL-23.md) requires.
- **multi_hop**: two chunks where the answer requires connecting facts ("unopened tea can be returned, but who pays for the return shipping?"). The "two questions at once" form goes here too: "does TEA15 work w/ the sale? and how long to seattle" — the reference covers both.
- **unanswerable**: easiest to write by hand. Synthetically: we give the model a chunk and ask for a question about a *neighboring* topic that isn't in the chunk ("warranty on coffee machines": Shelf doesn't sell them), then check with a search over the whole index that the answer really isn't anywhere. Otherwise an "unanswerable" question turns out to be answerable. The reference is the refusal phrase `REFUSAL` and a handoff to a human operator.
- **unanswerable from the "asking about their own order" persona**: "order 1187 has been in transit for a week, where is it??", "charged twice". The generator **invents** the numbers, names and phones; we don't take them from the database snapshot. The type is `unanswerable`, `reference_answer` is `REFUSAL`, and the `handoff` field (the reason the code hands the question to a human operator; details in the next chapter, [AIL-28](AIL-28.md)) sets the route: with a number, `"personal_data"` (`contains_personal_data` fires before the cloud call); without a number ("where is my order???"), `"refused"`.

Chunks of the archived `returns-2025.md` don't go into the generator: the reference would follow outdated rules.

### Paraphrasing versus copy-paste

We have a candidate; now, following the scheme from the start of the chapter, the automatic filters are waiting for it. There are three, against copy-paste, duplicates and "too easy" questions, plus a check of the reference itself. We start with copy-paste, the first bias from the list above. There are two defenses against it, and it is better to use both:

1. **In the generator prompt**: "Phrase the question the way a customer who has never seen the help center would write it in a support chat. Don't use headings, terms or phrases from the text."
2. **An overlap filter**: we count what share of the question's words appear in the chunk, or the length of the longest common substring. Overlap that is too high goes to paraphrasing (a second model call) or to the trash.

A simple overlap filter:

```python
import re

def tokens(text: str) -> set[str]:
    # lowercase words of 3+ chars; the first 5 letters are a crude stem,
    # so "return" and "returns" count as the same word
    return {t[:5] for t in re.findall(r"\w{3,}", text.lower())}

def overlap_ratio(question: str, chunk: str) -> float:
    q = tokens(question)
    if not q:
        return 0.0
    return len(q & tokens(chunk)) / len(q)

# rule of thumb, tune by looking at examples:
# > 0.7 means the question mostly copies the chunk
```

We don't pull the threshold out of thin air: we look at 20 candidates with different `overlap_ratio` values and decide where copy-paste begins.

### The duplicate filter

The model likes to repeat itself: out of 50 candidates about returns, 10 turn out to be the same question. Duplicates are caught with embeddings, which we have had since week 4 ([AIL-18](AIL-18.md)): if the cosine similarity of two questions is above a threshold (we start with 0.9 and check by eye), we keep one.

```python
import numpy as np

def dedup(questions: list[str], vectors: np.ndarray, threshold: float = 0.9) -> list[int]:
    # vectors are L2-normalized, so dot product == cosine similarity
    kept: list[int] = []
    for i in range(len(questions)):
        if all(float(vectors[i] @ vectors[j]) < threshold for j in kept):
            kept.append(i)
    return kept
```

### The "too easy" filter

"Too easy" means one of two things:
- **Trivial for search**: the question almost literally matches the chunk's heading ("Warranty on the Light Lamp"). Caught by the overlap filter.
- **Doesn't need the knowledge base**: the model answers correctly without context ("What is a promo code?"). Such a question tests the model's knowledge, not our RAG. A couple can stay for coverage, but not half the set. The closed-book check: we ask the model the question without knowledge-base chunks and let the judge from [AIL-27](AIL-27.md) compare the answer with the reference.

### Checking the reference

The generator's answer can be wrong too: the model made something up, rounded, mixed up the price per 100 g with the price per pack. The defense:
- The generator must return **quotes** (`evidence`): a list of verbatim phrases from the text, one for each fact in the answer. The code checks that each quote really is in the chunk (after normalization). If even one is missing, the candidate is rejected. `unanswerable` has no quotes.
- During manual review we check the answer against the quote and, when in doubt, open the `kb/` page from the link.

### The candidate structure

All the requirements above come together in one record. We generate right away in the schema that `eval/golden.jsonl` gets in the next chapter ([AIL-28](AIL-28.md)), so that nothing has to be renamed when merging. The main fields: `q` is the customer's question, `reference_answer` the reference, `must_include` 1–3 facts the **answer** must contain, `evidence` quotes from `kb/`, `source_urls` and `source_chunk_keys` where the chunk came from, plus labels by dimension (`type`, `difficulty`, `category`, `tags`) and provenance (`origin`, `reviewed`, `generator`). The `must_contain` field from week 5 (what the retrieved chunk contains) is optional for synthetic data: a retrieval hit is counted by `evidence`. The `split` field (dev or holdout) is filled in by the script from AIL-28:

```json
{"id": "syn-0042", "q": "opened the sencha pack, didnt like the taste, can i send it back?",
 "reference_answer": "No: opened tea and coffee are not accepted for return.",
 "must_include": ["opened tea can't be returned"],
 "evidence": ["Opened tea and coffee are not accepted for return."],
 "source_chunk_keys": ["3f9a…"], "source_urls": ["kb/returns.md#opened-tea-returns"],
 "category": "returns", "type": "factual", "handoff": null, "difficulty": "easy",
 "tags": ["colloquial"], "origin": "synthetic", "reviewed": false,
 "generator": {"model": "...", "prompt_version": "gen-v1"}}
```

The `evidence` field matters more than it seems: in [AIL-32](AIL-32.md) we will change the chunking, the `chunk_key` values (a hash of the link, the section and the text) will change, but the quote stays, and it can be used to find the right chunk in the new index.

### The generator prompt

The prompt turns this chapter's rules into instructions for the model: a combination of dimensions, a ban on copying the text, invented personal data, a quote for every fact and an answer in JSON. An example (illustrative; for the SDK call see chapter [2.2 · Structured output: Pydantic + Instructor](AIL-8.md) and the provider's current documentation):

```python
GEN_PROMPT = """You create test questions for the customer support assistant of the online shop Shelf
(home goods and gifts). The assistant answers from the shop's help center.

Below is a fragment of the help center (category: {category}, source: {url}, section: {section}).
<chunk>
{chunk}
</chunk>

Write ONE customer message in English of type "{qtype}" and difficulty "{difficulty}".
The customer: {persona}. Style: {style}. Message form: {form}.

Rules:
- The message must be answerable from the fragment alone.
- Write it the way a real customer types into a support chat, without having read the help center:
  no headings, policy terms or category words. Typos are fine if the style asks.
- The message must make sense without seeing the fragment (no "in this section").
- Never include real personal data. If a name, phone or order number is needed, invent one.
- The answer must be short and contain the key facts (numbers, units, SKUs, promo codes) exactly as written.
- "must_include": 1-3 key facts the answer must contain.
- "evidence": a list of EXACT quotes from the fragment, one per key fact.

Return JSON only:
{{"q": "...", "reference_answer": "...", "must_include": ["..."], "evidence": ["..."]}}
"""
```

A strong model is the right choice for generation: an error in the reference costs more than a few extra cents. We look up specific models and prices in the provider's documentation at the time of work.

### The script skeleton

The script ties everything together: it takes chunks from the index, calls the generator for each combination of dimensions and immediately rejects candidates with made-up quotes; the overlap and duplicate filters then run over the whole list.

```python
# eval/generate.py  (illustrative skeleton)
import json, os, random
from anthropic import Anthropic  # or openai, whichever you use in Project 2

client = Anthropic()  # reads ANTHROPIC_API_KEY from env, never hardcode keys
MODEL = os.environ["GEN_MODEL"]  # pick a current model from the docs

def normalize(text: str) -> str:
    return " ".join(text.split()).casefold()

def load_chunks() -> list[dict]:
    ...  # read chunks from index.db: chunk_key, text, url, section, category; skip archived

def generate(chunk: dict, combo: dict) -> dict | None:
    # combo: qtype, difficulty, persona, style, form
    msg = client.messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": GEN_PROMPT.format(
            category=chunk["category"], url=chunk["url"], section=chunk["section"],
            chunk=chunk["text"], **combo)}],
    )
    try:
        data = json.loads(msg.content[0].text)
    except json.JSONDecodeError:
        return None
    evidence = data.get("evidence") or []
    if not evidence or not all(normalize(e) in normalize(chunk["text"]) for e in evidence):
        return None  # hallucinated evidence
    return data

def main(n: int = 60, seed: int = 42):
    random.seed(seed)  # reproducible sampling
    ...  # sample combinations, generate, filter overlap, dedup, write candidates
```

For `comparative` and `multi_hop`, two chunks go into `chunk` one after the other, and `evidence` is checked against the concatenated text (at least one quote from each page); `unanswerable`, including questions about the customer's own order, is generated with a separate prompt without quotes. We pin the `seed`, the model and the prompt version: a month from now we will want to know where a question came from.

### Manual review

The filters weed out obvious defects but don't decide whether a question is good. This is the last step of the scheme, and it is ours. For each candidate we answer four questions:
1. Would a real customer write this? If not, we rewrite it or throw it out.
2. Is the reference correct and complete? We check it against the quote and the `kb/` page; in a message with two questions, both are covered.
3. Is the question unambiguous? "What's the warranty on the lamp?" without saying whether it is the Light or the Light Mini is a bad question.
4. Are the type, difficulty and category labeled correctly?

It is convenient to review in a terminal loop (`y` / `n` / `e` to edit) or in a spreadsheet via CSV. We record how many candidates passed: the reject rate is useful in itself (if 60% are rejected, the generator prompt is bad).

## DeepSeek and Ollama: how we do it

The skeleton above is written with the Anthropic SDK; we keep it as the "for comparison" option. Our main generator is DeepSeek via the OpenAI SDK, and the embeddings for the duplicate filter come from Ollama, locally and for free. The `kb/` knowledge base is public, so its chunks may be sent to DeepSeek; customers' personal data may not. Facts checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com).

### A DeepSeek generator

```python
# eval/generate.py — DeepSeek variant (illustrative; check current model ids in the docs)
import json, os
from openai import OpenAI

client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"],  # from env / .env file in .gitignore
                base_url="https://api.deepseek.com")
MODEL = os.environ.get("GEN_MODEL", "deepseek-v4-pro")

def generate(chunk: dict, combo: dict, retries: int = 3) -> dict | None:
    prompt = GEN_PROMPT.format(category=chunk["category"], url=chunk["url"],
                               section=chunk["section"], chunk=chunk["text"], **combo)
    for _ in range(retries):
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},  # prompt must contain the word "json" and an example
            max_tokens=4000,  # generous: in thinking mode reasoning also spends output tokens
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            continue  # JSON mode may return blank content; retry
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        evidence = data.get("evidence") or []
        if not evidence or not all(normalize(e) in normalize(chunk["text"]) for e in evidence):
            return None  # hallucinated evidence
        data["generator"] = {"model": resp.model, "prompt_version": "gen-v1"}  # model actually served
        return data
    return None
```

What matters here specifically for DeepSeek:

- **JSON mode is `json_object`, not a schema.** The model must return valid JSON, but nobody checks the fields. That is why `GEN_PROMPT` already contains an example of the structure and the word "JSON" (without them DeepSeek's JSON mode doesn't work properly), and we check that the fields are present ourselves (Pydantic from chapter [1.3 · Python: uv, async, Pydantic](AIL-2.md)). The documentation warns that `content` sometimes comes back empty, hence the retry.
- **Thinking mode is on by default.** For generation this is more of a plus: the model "thinks" before picking a quote, and the reference is more accurate. But temperature has no effect in this mode, so diversity comes from the dimensions (type, persona, style, message form), not from temperature. To control temperature, we turn reasoning off: `extra_body={"thinking": {"type": "disabled"}}`.
- **Which model.** An error in the reference costs more than a few extra cents, so the generator is `deepseek-v4-pro`, and the "cheap" steps (paraphrasing, the "answers without context" check) run on `deepseek-flash`. The order of prices as of November 2026: 60 candidates at ~1,500 input and ~1,000 output tokens (with reasoning) on Pro cost under $0.50 at peak hours and half that off-peak. We recalculate using the [pricing page](https://api-docs.deepseek.com/quick_start/pricing).
- **We record `resp.model`.** DeepSeek reassigns names: `deepseek-flash` is currently served by version V4.1-Flash-1017, and old names are redirected to new models. Without this record, a month from now there is no way to tell which model generated a question.

### An Ollama generator: free, but we check the reject rate

A local model works as a free generator, and `format` with a JSON schema in Ollama's native API constrains the response to the schema more reliably than DeepSeek's `json_object`:

```python
# illustrative; pull the model first: ollama pull <tag> (official library at ollama.com)
import ollama
from pydantic import BaseModel

class Candidate(BaseModel):
    q: str
    reference_answer: str
    must_include: list[str]
    evidence: list[str]

resp = ollama.chat(
    model="qwen3:4b",  # 4B class for 8 GB RAM; 7-8B for 16 GB; 14B+ for 32 GB
    messages=[{"role": "user", "content": prompt}],
    format=Candidate.model_json_schema(),
    options={"temperature": 0.8, "seed": 42},  # temperature and seed are honored here
)
cand = Candidate.model_validate_json(resp.message.content)
```

The schema guarantees the shape, not the truth. The model size depends on memory (see the comment in the code; `qwen3:4b` is the course default). A 4B model gets the reference wrong noticeably more often, copies wording and writes too polished, so a local generator for a public knowledge base is a learning comparison, not the main path. The accepted share of the two generators on 20 candidates shows whether the savings are worth it. About context: with less than 24 GB of memory, Ollama gives the model 4k tokens by default; a long chunk (the rate table in `delivery.md`) plus the prompt can be silently truncated. We check `ollama ps` (the CONTEXT column); raising `OLLAMA_CONTEXT_LENGTH` on 8 GB should be done only carefully, since context also eats memory (more in chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md)).

### Embeddings for the duplicate filter: local only

We found no embeddings endpoint in DeepSeek's official documentation (November 2026); Anthropic has no embeddings of its own either. So embeddings go through Ollama (or sentence-transformers, if the week 4 index was built that way):

```python
import numpy as np
import ollama

def embed(texts: list[str], model: str = "bge-m3") -> np.ndarray:
    # /api/embed returns L2-normalized vectors, so dot product == cosine similarity
    resp = ollama.embed(model=model, input=texts)
    return np.array(resp["embeddings"])

vectors = embed([c["q"] for c in candidates])
kept = dedup([c["q"] for c in candidates], vectors, threshold=0.9)
```

Customer questions can be in a non-English language (e.g. Russian), with typos and Latin-script SKUs mixed in (`LAMP-LIGHT-MINI`, `TEA15`), so we need a multilingual embedding model: `bge-m3` from the Ollama library (567M parameters, the course default, fits even in 8 GB). If the Project 2 index was built with a different model, that is not a problem for finding duplicates, but we tune the threshold again on examples.

### Comparing providers for this chapter

| What we need | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| JSON with a guaranteed schema | structured outputs (JSON schema) / tool use | `response_format` with a JSON schema | no: only `json_object`, we check the fields ourselves; workaround: strict mode of tool calling (beta, `base_url="https://api.deepseek.com/beta"`) | yes: `format` with a JSON schema |
| Diversity via temperature | yes (with limitations on some models) | yes, except reasoning models | only with thinking turned off | yes, plus `seed` |
| Own embeddings endpoint | no | yes | not found in the documentation | yes, `/api/embed` |
| Reference quality | high, more expensive | high, more expensive | high on Pro, cents per set | lower, more rejects; free |
| Where `kb/` chunks go | Anthropic's cloud | OpenAI's cloud | servers in China | nowhere |

Bottom line for the practice: the generator is `deepseek-v4-pro`, paraphrasing and the closed-book check (the question without knowledge-base chunks) run on `deepseek-flash`, duplicates on Ollama embeddings. Claude or OpenAI are optional, for comparing the reject rate on the same 20 combinations.

## Learning path

1. We reread the section on model-generated test cases in [Hamel Husain: Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) (≈15 min). We pay attention to how he defines scenarios and personas instead of asking to "come up with questions".
2. We open [Hamel: A Field Guide to Rapidly Improving AI Products](https://hamel.dev/blog/posts/field-guide/) → the section on synthetic data and dimensions (≈25 min). From here we take the idea of "dimension × value" tuples.
3. In [Hamel: AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) we find the questions about synthetic data (search the page for "synthetic") (≈20 min). They cover when synthetic data does harm and how to check it.
4. We open [Ragas docs](https://docs.ragas.io) → the section on testset generation (≈20 min). Not as a replacement for our own script: we look at which question types it produces (single-hop, multi-hop) and how it builds a knowledge graph from documents.
5. We return to the Project 2 code and find how to get all chunks with metadata out of `index.db`: `chunk_key`, text, `url`, `section`, `category`, `archived` (≈15 min). This is the generator's input.
6. We open [DeepSeek: JSON Output](https://api-docs.deepseek.com/guides/json_mode) and [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) (≈15 min). We pay attention to the three requirements of JSON mode (the word "json", an example, enough `max_tokens`) and to the empty `content`.
7. We open [Ollama: Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) and [Ollama: Embeddings](https://docs.ollama.com/capabilities/embeddings) (≈15 min): `format` with a Pydantic schema and `ollama.embed`. We install the `ollama` Python library with a pinned version.

## What to watch out for

- **Copy-paste inflates retrieval metrics**, BM25 especially. If hit rate on synthetic questions is noticeably higher than on manual ones, this is probably why. We compute metrics separately by `origin`.
- **The generator mixes up similar products**: in a chunk about the Light Mini it "remembers" the Light's warranty. The quote check catches this.
- **Customers who write too well.** All candidates start with "Hello, could you please tell me" → we specify the style more concretely, with invented examples in the prompt.
- **Junk chunks** (tables of contents, navigation, a table with no heading or caption) produce meaningless questions. We filter them out before generation: too short, no sentences, links only.
- **Skew toward large sections.** `products/` has dozens of pages, and `payment.md` is one: with uniform chunk sampling the set skews toward products. We sample by category first, then by chunk.
- **The knowledge base changes.** `kb/` pages get edited (`updated` in the front matter). Using `source_urls`, we find the questions about a changed page and recheck the reference; otherwise it "suddenly becomes wrong".
- **Nothing but the public knowledge base goes to the cloud.** DeepSeek's servers are in China; the rule is the same for any cloud provider. Real customer messages, `outputs/handoff.jsonl`, logs with questions and the `data/shop.db` snapshot don't go into the generator. The order numbers, names and phones in questions about one's own order are invented.
- **Synthetic data doesn't replace real questions.** The manual questions from [AIL-28](AIL-28.md) and `eval/golden.jsonl` remain the foundation; synthetic data supplements them.
- **An empty response in DeepSeek's JSON mode** with `finish_reason="stop"` is documented behavior, not a bug in our code. We retry, and we don't count such cases as "generator rejects".
- **A truncated chunk in Ollama.** With the default 4k context, a long chunk gets truncated without an error, the model generates a question from a piece of the chunk, and the `evidence` check rejects good candidates. We check `ollama ps`.

## Practice

Code and data: `projects/02-support-kb-rag/eval/`.

- [ ] We create `eval/generate.py` from the skeleton above. The API key comes from an environment variable or from `.env`, which is in `.gitignore`.
- [ ] The `load_chunks()` function: reads chunks from the Project 2 `index.db` (`chunk_key`, text, `url`, `section`, `category`) and skips archived ones. We filter out chunks shorter than 200 characters and those consisting mostly of links.
- [ ] We define the dimensions: type (factual, multi_hop, unanswerable; comparative is optional, via a pair of chunks), difficulty, persona (including "asking about their own order"), style, message form, category. We sample combinations so that no type takes more than 40%, and `unanswerable` no less than 15%.
- [ ] We implement the "every `evidence` quote is in the chunk" check and the rejection.
- [ ] We implement `overlap_ratio` and look at the distribution on the first 20 candidates; we choose a threshold. Candidates above the threshold are sent to paraphrasing with a second call (prompt: "rewrite the question in the words of a customer in a support chat without changing its meaning").
- [ ] We implement `dedup` on embeddings.
- [ ] (Optional) The "answers without context" check: we ask the model the question without documents and mark candidates where the answer matched the reference with the flag `closed_book_ok: true`.
- [ ] We generate ~60 candidates → `eval/synthetic_candidates.jsonl`.
- [ ] We write `eval/review.py`: it shows a candidate (question, reference, quote, `url`), accepts `y/n/e` and writes the accepted ones to `eval/synthetic_reviewed.jsonl` with `reviewed: true`.
- [ ] We review at least 30 by hand. We record in `notes/evals.md` how many were accepted, how many rejected and for what reasons (copy-paste, wrong reference, ambiguous, meaningless, "doesn't sound like a customer").
- [ ] We run the accepted questions about one's own order through `ask()`: none with a number reached the cloud, and the reason in `outputs/handoff.jsonl` matches the `handoff` field (`personal_data` or `refused`).

- [ ] The main generator is DeepSeek: an OpenAI SDK client with `base_url="https://api.deepseek.com"`, the `DEEPSEEK_API_KEY` key from the environment, JSON mode, a retry on empty `content`, `resp.model` recorded in the `generator` field.
- [ ] Embeddings for `dedup` via Ollama (`ollama pull bge-m3` or another multilingual model from the official library); we pin the version of the `ollama` library in `pyproject.toml`.
- [ ] (Optional) We generate the same 20 combinations with a local model via `format=Candidate.model_json_schema()` and compare the reject rate with DeepSeek. We record it in `notes/evals.md`.
- [ ] (Optional, for comparison) We run the original skeleton on the Anthropic SDK or OpenAI on the same 20 combinations: reject rate and price versus DeepSeek.

Expected: out of 60 candidates, ~40–50 remain after the filters and ~25–35 after manual review. If fewer than half are accepted, we improve the generator prompt and repeat on 20 candidates.

## Done when

- `eval/generate.py` generates candidates in the `eval/golden.jsonl` schema (type, difficulty, category, `must_include`, `evidence` quotes, source `kb/<file>.md#<anchor>`), reproducibly (seed, model and prompt version are recorded).
- The filters work: quote, overlap, duplicates; archived chunks don't get into the generator.
- The set has conversational questions, messages with two questions, questions about a specific order and questions with no answer in the knowledge base.
- At least 30 candidates are reviewed by hand; the accepted ones are in `eval/synthetic_reviewed.jsonl`, ready to be merged into `eval/golden.jsonl`.
- The notes have the reject rate and its reasons.

## Self-check quiz

1. Why is a synthetic question that almost literally repeats a knowledge-base chunk harmful for evals?
2. Why does the generator return an `evidence` field with verbatim quotes? What are the two reasons?
3. What are "dimensions" in synthetic data generation, and what are they for?
4. Which type of question comes out worst from a single random chunk?
   a) factual; b) comparative; c) easy; d) with a typo.
5. An "unanswerable" question was generated from a `warranty.md` chunk. What must be checked before accepting it?
6. How can duplicates be found among 60 questions without reading every pair?
7. Hit rate on synthetic questions is 0.95, on manual ones 0.70. What is the most likely cause?
8. What is wrong with this prompt?
   ```
   Here is a section of the shop help center: {chunk}
   Generate 20 diverse questions with answers.
   ```
9. Why pin the `seed`, the model and the version of the generator prompt?
10. Why are chunks sampled by category first, and then within the category?
11. A model without context answers a synthetic question correctly. What does that say about the question?
12. DeepSeek in JSON mode returned `finish_reason="stop"` and an empty `content`. What happened, and what should be done?
13. How does DeepSeek's `response_format={"type": "json_object"}` differ from `format=<JSON schema>` in Ollama, and what follows from this for the generator code?
14. What should compute the embeddings for the duplicate filter if the main provider is DeepSeek, and why?
15. A synthetic question: "order 1187 has been in transit for a week, where is it??". What are its `type`, reference and `handoff` in the set, and what does it test?

## Answers

1. Search (lexical search especially) finds such a chunk almost every time, so hit rate is inflated and doesn't reflect real customers, who write differently.
2. To check that the reference isn't made up (the quote must really be in the chunk), and to survive a change of chunking: `chunk_key` values change after rechunking, but the quote can be used to find the right chunk in the new index.
3. Axes of diversity (type, difficulty, persona, style, etc.) whose combinations are used to generate questions. They set the distribution of the set deliberately, instead of letting the model generate questions that are all alike.
4. **b.** A comparative question needs two chunks: two similar products (Light and Light Mini) or two pages on one topic.
5. That the answer really isn't anywhere in the index (by search and by eye); otherwise the question turns out to be answerable and the refusal reference is wrong.
6. Compute embeddings of the questions and drop those whose cosine similarity to an already accepted one is above a threshold (the threshold is tuned on examples).
7. Synthetic questions copy the chunks' wording, so search finds them easily. Metrics are computed separately by `origin`, and copy-paste is paraphrased in the customer's words.
8. 20 questions at once lead to repeats and degradation toward the end; there is no type, difficulty, persona or customer style; no requirement for the format (JSON) or a quote; no ban on copying the text and headings; "diverse" without dimensions guarantees nothing.
9. For reproducibility and analysis: to understand where a question came from, and to regenerate the set the same way or compare prompt versions.
10. Otherwise a category with many pages (`products/`, a page per product) takes up most of the set, and the metric mostly describes that category.
11. It tests the model's knowledge (typical shop rules), not search over the knowledge base. A couple of such questions are acceptable, but they say nothing about RAG quality.
12. Documented JSON mode behavior: if the model couldn't produce valid JSON, the API may return empty content. Retry (and check that the prompt contains the word "json" and an example, and that `max_tokens` is enough).
13. `json_object` guarantees only valid JSON, not the required fields; a JSON schema in Ollama constrains the response to the schema. So with DeepSeek, the presence and types of fields are checked in code (Pydantic), and an example of the structure goes into the prompt.
14. A local embedding model in Ollama (or sentence-transformers): DeepSeek's documentation has no embeddings endpoint, and locally it is free and private. For non-English questions (e.g. Russian) with typos and Latin-script SKUs, a multilingual model (`bge-m3`).
15. `type: "unanswerable"`, `reference_answer` is the `REFUSAL` phrase, `handoff: "personal_data"`: `kb/` has no order status, it must not be made up, and `contains_personal_data` catches the number before the cloud call. The question tests the routing of personal data and the refusal; the number is invented, so it is fine to generate it with a cloud model.

## What's next

In [AIL-28 · Golden dataset: 50–100 questions with reference answers](AIL-28.md) we add the reviewed synthetic questions to the manual ones in `eval/golden.jsonl`, which becomes the basis of all experiments.
