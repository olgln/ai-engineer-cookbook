# 5.2 · Hybrid search (BM25) and reranking  (AIL-22)

> **Week 5** · RAG · ⏱ ~5 h · Theory, Practice

<!-- description: Hybrid search in RAG: BM25 plus embeddings, merging result lists with RRF and cross-encoder reranking. Why vector search misses SKUs and exact terms. -->
<!-- source-sha256: a5ff316a12b9 -->

## Why an AI engineer needs this

Vector search understands meaning well but is bad at finding exact terms: SKUs, promo codes, carrier names, zone and rate numbers, system order statuses. For shop support this is critical: a question about `TEA15` or `LAMP-LIGHT-MINI` must find exactly that chunk, not the neighboring one about `TEA10` or the Light Lamp. Hybrid search (BM25 + embeddings) plus a reranker is the standard "production configuration" of RAG; people expect to see it in a project and ask about it in interviews: "how do you merge two result lists", "how does a bi-encoder differ from a cross-encoder", "how many candidates do you give the reranker".

## Theory

### Why embeddings miss exact terms

An embedding encodes meaning "as a whole". To the model, the SKUs `LAMP-LIGHT` and `LAMP-LIGHT-MINI` are almost the same thing ("something about the Light lamp"), and so are the promo codes `TEA10` and `TEA15` ("a tea discount"). The model may never have seen a rare identifier during training and splits it into meaningless pieces of tokens. Yet a customer who types an exact promo code or SKU wants **exactly that one**: the lamps have different warranties, the promo codes have different terms.

Classic lexical search works the other way round: it understands nothing about meaning, but it values an exact match of a rare word very highly.

| | Embeddings (dense) | BM25 (sparse, lexical) |
|---|---|---|
| Synonyms, paraphrases ("unsealed pack" ↔ "opened tea") | Good | Poor |
| Word forms (return, returns, returning) | Good | Poor without stemming |
| Different languages and scripts (a non-English query ↔ `LAMP-LIGHT-MINI`) | Tolerable (multilingual model) | None |
| Exact identifiers: SKUs, promo codes, numbers | Poor | Excellent |
| Typos | Tolerable | Poor |
| Needs a model / GPU | Yes | No |

They fail on **different** questions — which is exactly why they are combined.

### BM25 in 5 minutes

The lexical search that sits next to embeddings in almost every RAG system is BM25. It is an evolution of TF-IDF and the standard of full-text search (Elasticsearch, Lucene, SQLite FTS5). For each word of the query, its contribution to the document's score is computed:

- **TF (term frequency)** — how many times the word occurs in the document. But with saturation: 10 mentions are not 10 times better than one (the `k1` parameter).
- **IDF (inverse document frequency)** — how rare the word is in the whole collection. "order", "delivery", "product" are almost everywhere, so their weight is small; `TEA15` or `LAMP-LIGHT-MINI` appear in a couple of chunks, so their weight is huge.
- **Document length normalization** (the `b` parameter) — a long document shouldn't win just because it has more words.

The final score is the sum of the contributions of the query words. No vectors and no models — only word statistics, so BM25 is fast and fully explainable.

```python
from rank_bm25 import BM25Okapi

corpus_tokens = [tokenize(c["text"]) for c in chunks]
bm25 = BM25Okapi(corpus_tokens)
scores = bm25.get_scores(tokenize("promo code TEA15 didn't work"))   # one score per chunk
```

### Tokenization decides everything

The code above leaves the `tokenize` function undefined, and that is no detail. BM25 compares tokens, not meaning: if `TEA15` in the question and `TEA15` in the knowledge base turned into different tokens, there is no match, and all the power of lexical search is gone. `text.split()` is a poor tokenizer for the shop's knowledge base. `TEA15,` with a comma and `"Light"` in quotes won't match `TEA15` and `light`; `Promo` and `promo` become different words; the SKU `LAMP-LIGHT-MINI` stays one token and isn't found by the word `mini`. A better option for our case:

```python
import re
import unicodedata

TOKEN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

def tokenize(text: str) -> list[str]:
    tokens = []
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))  # café -> cafe
    for t in TOKEN.findall(text):
        tokens.append(t)                      # whole token: lamp-light-mini, tea15, 3
        if "-" in t:
            tokens.extend(t.split("-"))       # parts: lamp, light, mini
        # TODO: stemming: returns, returning -> return
    return tokens
```

The principles: lowercase and accents folded (`café` → `cafe`); a promo code with digits (`TEA15`) is one token; a SKU with hyphens is both whole and in parts (the query `LAMP-LIGHT` as a whole matches only its own lamp, and `LAMP-LIGHT-MINI` only in parts); numbers (weight, zone number) are separate tokens. Words change their endings: "return", "returns", "returning" are three different words for BM25. Stemming partly fixes this (a Snowball stemmer, for example from the `snowballstemmer` package), but nothing fixes synonyms ("unsealed pack" ↔ "opened tea") except embeddings and query rewriting (AIL-60). A good combination: BM25 runs over the **rewritten queries** from `plan_query`, which are closer to the wording of `kb/`, plus over the original question — it keeps the customer's identifiers verbatim.

An alternative to the in-memory `rank_bm25` is **SQLite FTS5** (a built-in full-text index with a `bm25()` function): it lives in the same `index.db` as the vectors. The `unicode61` tokenizer lowercases non-Latin letters too, while the built-in `porter` stemmer handles English only. Either option works for the project; `rank_bm25` is simpler for an experiment.

### Reciprocal Rank Fusion (RRF)

Now for each question we have two result lists: vector and BM25. How do we merge them into one? The scores aren't comparable: cosine is ~0.3–0.9, BM25 goes from 0 to dozens and depends on the query. They can be normalized (min-max), but that is fragile. RRF ignores the score values and uses only the **ranks**:

```
RRF(d) = Σ over all rankings  1 / (k + rank_i(d))       k is usually 60
```

A document ranked high in both lists gets the most; a document found by only one system can also break through if that system ranks it first.

```python
def rrf(rankings: list[list[int]], k: int = 60, top: int = 50) -> list[int]:
    scores: dict[int, float] = {}
    for ranking in rankings:                 # each ranking: chunk ids, best first
        for rank, cid in enumerate(ranking, start=1):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
    return sorted(scores, key=scores.get, reverse=True)[:top]
```

Example: chunk A is 1st in the vector list and 3rd in BM25: 1/61 + 1/63 ≈ 0.0323. Chunk B is 1st only in BM25: 1/61 ≈ 0.0164. Chunk C is 2nd and 2nd: 2/62 ≈ 0.0323. A and C are almost equal, B is lower. Weights per list can be introduced (`w_i / (k + rank)`), but it is worth starting without them.

RRF also works for the multi-query from AIL-60: each result list for each query is one more `ranking`.

### Reranking: bi-encoder vs cross-encoder

RRF assembles a good list of candidates, but the order inside it is rough: both systems judged how a question relates to a chunk indirectly — through vectors or through word matches. Only the top 5 chunks go into the prompt, and it matters that the right one is among them. So the top of the list is re-scored by a more precise and slower model — a reranker.

Embeddings are a **bi-encoder**: the question and the document are encoded **independently**, then the vectors are compared. This is fast (the document vectors are computed in advance), but the model never sees the question and the document together.

A **cross-encoder** gets the "question + document" pair whole, in a single input, and outputs one number — relevance. It sees how the words of the question relate to the words of the document (attention between them), so it is noticeably more precise: for example, it notices that the question is about the Light Mini while the chunk is about the warranty on the plain Light. The price: nothing can be computed in advance — for each question the model has to run over each candidate. Over the whole knowledge base that is too slow; over 20–50 candidates it is fine.

```
              ┌───────────────┐  top-50   ┌────────────────┐  top-5   ┌────────┐
 question ──► │ vector + BM25 │ ────────► │ cross-encoder  │ ───────► │ prompt │
              │ + RRF         │           │                │          └────────┘
              │ (fast, rough) │           │(slow, precise) │
              └───────────────┘           └────────────────┘
```

This is the classic two-stage retrieve-then-rerank: a broad, cheap search provides recall, an expensive reranker provides precision.

```python
# Illustrative: choose a reranker on sbert.net / Hugging Face; multilingual for non-English questions
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("BAAI/bge-reranker-v2-m3")
pairs = [(question, chunks[cid]["text"]) for cid in candidate_ids]
scores = reranker.predict(pairs, batch_size=16)
reranked = [cid for _, cid in sorted(zip(scores, candidate_ids), reverse=True)][:5]
```

Reranker options: local cross-encoders from Sentence Transformers (the English `cross-encoder/ms-marco-*` models are small and fast; multilingual ones are heavier), API rerankers (Cohere, Voyage and others), or an LLM as a reranker (expensive but flexible). Our knowledge base is in English, but customers may ask in other languages, so an English-only reranker doesn't fit: we need a multilingual one.

The speed of a local cross-encoder on a CPU or Apple Silicon ranges from tens of milliseconds to several seconds for 20–50 pairs, depending on the model size, chunk length and the machine. We measure.

### Contextual Retrieval: what exactly Anthropic proposes

Everything covered above — BM25 next to embeddings, merging result lists, a reranker on top of the candidates — is combined into a single recipe in Anthropic's article "Contextual Retrieval", the main reading of this chapter (the first item of the learning path). The article adds one more step to it and measures the contribution of each.

"Contextual" means: before indexing, a short explanation generated by an LLM from the whole document is prepended to each chunk ("This fragment is from the product page 'Light Mini Lamp' (SKU LAMP-LIGHT-MINI), section 'Warranty'; it describes the warranty period and how to file a claim"), and the **augmented** text goes into both the embeddings and BM25. To avoid paying for the whole document on every chunk, prompt caching is used: the document is cached, only the chunk changes. Our breadcrumbs from AIL-19 (`Products > Light Mini Lamp > Warranty`) are a free partial equivalent; the LLM explanation adds meaning that the headings don't have.

The article's results on its benchmarks (the metric is the failure rate in the top 20, i.e. 1 − recall@20):

| Configuration | Reduction in failure rate |
|---|---|
| Contextual Embeddings | −35% |
| Contextual Embeddings + Contextual BM25 | −49% |
| + reranking | −67% |

The article's figures are on their data. On our knowledge base they will be different: that is exactly why we build our own table.

### Metrics for this task

To see the contribution of the hybrid and the reranker, the one familiar metric is not enough.

- **hit@k** — the share of questions where the right chunk made it into the first k (as in AIL-19 and AIL-60).
- **MRR (Mean Reciprocal Rank)** — the mean of `1 / rank` of the first right chunk (0 if not found). A reranker often barely changes hit@20 (the candidates are the same) but lifts the right chunk from 7th place to 1st — this shows in MRR and hit@3, and what matters for the answer is whether it gets into the prompt's 5 chunks.

```python
def reciprocal_rank(ranked_texts: list[str], must_contain: list[str]) -> float:
    for i, t in enumerate(ranked_texts, start=1):
        if all(s.lower() in t.lower() for s in must_contain):
            return 1.0 / i
    return 0.0
```

## DeepSeek and Ollama: how we do it

BM25 and RRF are pure Python; the provider doesn't matter. The differences are in two places: the **reranker** and **Contextual Retrieval**.

### Reranker: only a local cross-encoder

As of November 2026, neither DeepSeek (its [API Reference](https://api-docs.deepseek.com/api/create-chat-completion) has none) nor Ollama has a reranking endpoint: the Ollama documentation has none, and the feature request for it in the Ollama repository is still open. The main path is `CrossEncoder` from Sentence Transformers, as in "Theory", with a multilingual model (`BAAI/bge-reranker-v2-m3` is from the same family as `bge-m3`). The model is local and free, and the text goes nowhere.

The alternative is an **LLM as a reranker**: we give DeepSeek the question and 20 numbered candidates and ask it to return JSON with a list of numbers ordered by relevance. This works, but: +1 call on the hot path, a long input (20 chunks), a non-deterministic result, and DeepSeek's JSON mode doesn't check the schema — see 5.1 · Query rewriting in RAG: multi-query, HyDE, filters (AIL-60). It is an experiment, not the main option.

### Contextual Retrieval on DeepSeek: the cache works by itself

In Anthropic's article, prompt caching is what makes it cheap: the document is cached once, and for each chunk we pay mostly for the chunk itself. How this looks with different providers:

- **Claude** — the cache is explicit: the block with the document is marked with `cache_control`, and there is a minimum length for a cacheable block (we check the documentation).
- **DeepSeek** — the cache is **automatic** and always on ([Context Caching](https://api-docs.deepseek.com/guides/kv_cache)). A repeated **prefix** of the request is served from disk. Hence the rule: the unchanging part first (instruction + the whole page), the chunk at the very end. Then the prefix is the same for all chunks of one page. Hits show up in `usage`: `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. The cache is best-effort: 100% hits are not promised, and `cache_control` is ignored in DeepSeek's Anthropic-compatible endpoint.
- **Ollama** — costs no money, but even for the 400–500 chunks of our knowledge base, generating explanations with a local model on a laptop can take hours: each call reads the whole page again. We first measure the speed on 20 chunks.

The order of cost on DeepSeek (`deepseek-flash` prices as of November 13, 2026, off-peak: input with a cache hit $0.003 per 1M tokens, with a miss $0.15, output $0.60; twice as expensive during peak hours). Let's take a `kb/` page of 3K tokens, 10 chunks of ~300 tokens and an explanation of ~100 tokens per chunk. If all repeats hit the cache: 9 × 3K = 27K tokens at the hit price + ~6K at the miss price (the first page and the chunks themselves) + ~1K of output ≈ $0.0016 per page, i.e. less than ten cents for the whole knowledge base of 50 pages. This is an estimate, not a promise: before running on the whole index, we run 20 pages and compute the actual cost from `usage`.

```python
# Illustrative: keep the page as a stable prefix, put the chunk last
def contextualize(ds, model: str, page_md: str, chunk: str) -> tuple[str, dict]:
    resp = ds.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": CONTEXT_PROMPT},                # same for all calls
            {"role": "user", "content": f"<document>\n{page_md}\n</document>\n\n"
                                        f"<chunk>\n{chunk}\n</chunk>"},    # chunk at the very end
        ],
        max_tokens=150,
        extra_body={"thinking": {"type": "disabled"}},
    )
    u = resp.usage
    stats = {"hit": getattr(u, "prompt_cache_hit_tokens", None),
             "miss": getattr(u, "prompt_cache_miss_tokens", None)}
    return resp.choices[0].message.content.strip(), stats
```

Security: in this project both the page and the chunk are the shop's public knowledge base, so DeepSeek is fine here. The course rule doesn't change: customers' personal data and real customer messages never go to cloud models, only to the local one; we make up the questions for the golden set.

### Comparing providers for this chapter

| What we need | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Reranking endpoint | No (partners: Voyage and others) | No | **No** | **No** (as of November 2026) |
| Workaround | Local cross-encoder or a partner's API | Local cross-encoder | Local cross-encoder; LLM reranking via JSON | Local cross-encoder via Sentence Transformers |
| Cache for Contextual Retrieval | Explicit `cache_control` | Automatic for long prefixes (we check the guide) | Automatic by prefix; `prompt_cache_hit_tokens` in `usage` | Not needed (free), but slow |
| Order of prompt parts | The document goes in the cacheable block | The unchanging part goes first | The unchanging part goes first, the chunk last | Doesn't matter for money |

### What to use in the practice

- The reranker is a local `CrossEncoder` (the main and only "free" path).
- **Memory.** There are now up to three local models on the hot path: the embedding model in Ollama (`bge-m3` ~1.2 GB), the cross-encoder in the Python process (a multilingual reranker is a model of the same order of size; we check the model card) and, in offline mode, the generator. So by default generation goes to DeepSeek: the knowledge base is public, and it takes no memory. Fully offline mode by RAM: 8 GB — only a 3–4B-class generator (`qwen3:4b`, ~2.5 GB) and only with heavy applications closed; 16 GB — up to 7–8B; 32 GB+ — 14B and more. Before launching, we estimate the total from `ollama ps`.
- Contextual chunking (optional) — DeepSeek `deepseek-flash` with reasoning turned off, the page in the prefix. Ollama — if a fully offline option is needed and there is time to wait: a model sized to the RAM, and the page plus the chunk require a large enough `num_ctx`, which means more memory. We measure on 5 pages before deciding. The Claude option with `cache_control` is "for comparison".
- If an LLM judge rates the quality of the explanations, we take a model stronger than the one that wrote them (for example, `deepseek-v4-pro` or Claude for explanations from `deepseek-flash`).

## Learning path

1. Open [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) → read it in full, required (≈45 min). What to pay attention to: why BM25 is added to embeddings, how the chunk context is generated (the prompt in the article), the role of prompt caching in the cost, how reranking on top of the candidates works, what the conclusions at the end are (what to combine, how many chunks to pass). We compare their metric with our hit@k.
2. Open [rank_bm25](https://github.com/dorianbrown/rank_bm25) → the README (≈10 min). What we take from it: `BM25Okapi`, tokenization is our responsibility, `get_scores` / `get_top_n`.
3. Find a description of BM25 (the "Okapi BM25" article on Wikipedia will do) → the formula and the meaning of `k1` and `b` (≈15 min). We don't memorize the formula — what matters is understanding the three components: TF with saturation, IDF, length normalization.
4. Read about Reciprocal Rank Fusion: the original paper by Cormack, Clarke, Büttcher, 2009, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods" — the abstract and the formula are enough (≈10 min).
5. Open [Sentence Transformers](https://sbert.net) → the Cross-Encoder sections: Usage and Pretrained Models / Retrieve & Re-Rank (≈30 min). What we take from it: the difference between a bi-encoder and a cross-encoder, `CrossEncoder.predict`, the recommended reranking models and their speed, the retrieve & re-rank scheme.
6. (Optional) The SQLite FTS5 documentation on sqlite.org — the `bm25()` function and the tokenizers (`unicode61`, `porter`), if BM25 is going to live in the same database (≈15 min).
7. Open a reranker's model card on Hugging Face (for example, `BAAI/bge-reranker-v2-m3` in the BAAI organization) (≈10 min). What we take from it: the languages (whether the ones our customers write in are covered), the input length limit, how to call it through `CrossEncoder`, the license.
8. Open [DeepSeek: Context Caching](https://api-docs.deepseek.com/guides/kv_cache) and [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (≈15 min). What we take from it: how the "units" of the cacheable prefix are built, the `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` fields, the hit and miss prices, the peak hours. We compare this with how Anthropic caches in the Contextual Retrieval article.

## What to watch out for

- **BM25 tokenization** is the main source of bugs. We check on 3 queries that `TEA15`, `LAMP-LIGHT-MINI` and "Returns" really turn into tokens that exist in the index (`tea15`; `lamp-light-mini`, `lamp`, `light`, `mini`; `returns` or its stem after stemming).
- **One `tokenize()` for the corpus and the query.** Different functions (or stemming on one side only) — and there will be no matches even on identical words.
- **BM25 doesn't know about the filters** from AIL-20 — the category filter is applied to the BM25 list too (we filter before ranking or keep a separate BM25 per category).
- **The archive in BM25.** The old return rules (`returns-2025.md`) almost match the current ones word for word, and BM25 will happily lift them to the top. We exclude `archived` from the lexical index by default, just as from the vector one.
- **Out-of-sync indexes.** The in-memory BM25 is built from the same `chunks` table as the vectors; after `ingest.py` we rebuild it. The identifiers in both lists are the same `chunks.id`.
- **Adding up the raw scores** of BM25 and cosine is a mistake: different scales, BM25 dominates. That is what RRF is for.
- **A reranker over the whole knowledge base** is unacceptably slow. Only the top 20…50.
- **Too few candidates for the reranker.** If the right chunk isn't in the top 20, the reranker won't return it. First the hit@20 of the first stage, then the reranker's precision.
- **The reranker's input length** is limited (often 512 tokens) — long chunks get truncated, and the relevant part (for example, a row of the rate table at the end of a section) may not make it in. We know the model's limit.
- **The reranker's language**: an English cross-encoder works poorly on a non-English question. We need a multilingual model.
- **The first call is slow** — the model is loading. We load it once at startup, not on every request; when measuring latency, we separate the warm-up.

## Practice

The code goes in `projects/02-support-kb-rag/rag/hybrid.py` and `rag/rerank.py`, the eval in `eval/`. The golden set is the same 20 questions of `eval/golden.jsonl` from AIL-60. The identifiers must be in the knowledge base itself: in `kb/products/` a "SKU: …" line (`MUG-NORTH`, `TEA-SENCHA`, `LAMP-LIGHT`, `LAMP-LIGHT-MINI`), in `promo.md` the promo codes (`TEA10`, `TEA15`), in `delivery.md` the carriers and zone numbers, in `orders.md` the order statuses (`paid`, `shipped`, `delivered`). Whatever is missing, we add and rerun `ingest.py`.

- [ ] **BM25.** `rag/hybrid.py`: `tokenize()` with support for SKUs with hyphens, promo codes with digits, lowercasing and accent folding (stemming is optional; we measure whether it helps); `build_bm25(category=None, include_archived=False)` over the `chunks` table; `bm25_search(query, k, category=None, include_archived=False) -> list[int]` (chunk ids). Offline test: on 5 fake chunks the query `TEA15` finds the chunk with `TEA15` first, not the one with `TEA10`; the query `LAMP-LIGHT` ranks the Light page above the Light Mini page.
- [ ] **RRF.** `rrf(rankings, k=60, top=50)`. A test on the hand-made example from the theory (A, B, C).
- [ ] **Hybrid.** `hybrid_search(question, k)`: for each query from `plan_query` (AIL-60), a vector list and a BM25 list (BM25 over the rewritten queries and over the original question), all into RRF; the category filter and the archive exclusion are applied to both lists.
- [ ] **Reranker.** `rag/rerank.py`: the model loads once; `rerank(question, candidate_ids, top=5)`. We give the reranker either the customer's original question or the rewritten query — we try both on 5 questions and choose.
- [ ] **(Optional) Contextual chunking.** A `contextualize.py` script: for each chunk, an LLM writes 1–2 sentences of context from the whole page, prepends them to the text and reindexes into a separate `index_ctx.db`. The main option is DeepSeek: the page in the unchanging prefix, the chunk at the end, reasoning turned off. We log `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` and compute the hit rate. First we run 20 pages, compute the actual cost and only then run it on everything. The offline option is Ollama (we measure the speed first). "For comparison": Claude with an explicit `cache_control`.
- [ ] **(Optional) LLM reranker.** `rerank_llm(question, candidate_ids)` on DeepSeek (JSON with a list of numbers, validation, a fallback to the RRF order). We add a row to the eval table and compare it with the cross-encoder by MRR, latency and cost.
- [ ] **Eval.** `eval/run_retrieval_eval.py` computes hit@3, hit@5, hit@20, MRR and p50 latency for each variant:

  | Variant | hit@3 | hit@5 | hit@20 | MRR | p50, ms |
  |---|---|---|---|---|---|
  | vector | /20 | /20 | /20 | | |
  | hybrid (vector + BM25, RRF) | | | | | |
  | hybrid + reranker | | | | | |
  | (opt.) + contextual | | | | | |

- [ ] **Breakdown by question type**: we separately compute hit@3 on 4 questions with exact identifiers ("does TEA15 apply to coffee?", "what is the warranty on LAMP-LIGHT-MINI?", "what does the shipped status mean?", "how much does SwiftCourier cost to zone 3 for a 2 kg parcel?") — that is where BM25 should give the main gain.
- [ ] **Decision**: in `eval/RESULTS.md`, which configuration we take into the answering pipeline of AIL-23 and why (quality vs latency).

Expected result: the hybrid lifts the questions with identifiers, the reranker lifts hit@3 and MRR with almost the same hit@20. If the reranker made things worse, we check the model's language and the truncation of long chunks.

## Done when

- `eval/RESULTS.md` has a table with numbers for three variants: vector / hybrid / hybrid + reranker (hit@3, hit@5, MRR, latency) on the same golden set of 20 questions.
- There is a separate number for the questions with exact identifiers and a chosen configuration with a justification.
- The tokenizer and RRF are covered by offline tests; with `include_archived=False`, archived pages get into neither the vector nor the BM25 list.

## Self-check quiz

1. Why does vector search do a poor job of finding `TEA15` or `LAMP-LIGHT-MINI`?
2. The three components of BM25 — name them and explain each in one sentence.
3. Why can't the cosine and the BM25 score simply be added up?
4. What is the RRF (k=60) of a chunk that is 2nd in the vector list and absent from the BM25 list? a) 1/2 b) 1/62 c) 2/60 d) 1/61 + 1/62
5. How does a cross-encoder differ from a bi-encoder? Why can't a cross-encoder be applied to the whole knowledge base?
6. The reranker didn't change hit@20 but raised hit@3 from 11 to 15. Is that good? Why didn't hit@20 change?
7. What is wrong with this code?
   ```python
   bm25 = BM25Okapi([c["text"].split() for c in chunks])
   top = bm25.get_top_n(question.split(), texts, n=5)
   ```
   (the question: "Promo code TEA15, didn't work on the Light Mini lamp, why?")
8. What is Contextual Retrieval, and what does prompt caching have to do with it?
9. Which metric shows the benefit of a reranker better: hit@20 or MRR? Why?
10. A customer asks "can I send back an unsealed pack of tea?", while the section in `kb/returns.md` is called "Returning opened tea". Why is BM25 almost useless here, and how does our pipeline cover this?
11. The right chunk isn't in the top 50 of the hybrid list. Will a stronger reranker help?
12. Where do we get a reranker if generation is on DeepSeek and embeddings are in Ollama? a) DeepSeek's `/rerank` endpoint b) Ollama's reranking endpoint c) a local cross-encoder via Sentence Transformers (or LLM reranking as an experiment) d) a reranker isn't needed
13. Contextual Retrieval on DeepSeek, with the prompt assembled like this: `f"<chunk>{chunk}</chunk>\n<document>{page}</document>"`. There are almost no `prompt_cache_hit_tokens` in `usage`. Why, and how is it fixed?
14. Why won't moving the Contextual Retrieval code from Claude to DeepSeek's Anthropic-compatible endpoint break, even though `cache_control` isn't supported there?

## Answers

1. An embedding encodes the overall meaning: similar identifiers (`TEA10` and `TEA15`, `LAMP-LIGHT` and `LAMP-LIGHT-MINI`) are almost the same to it, and the model may not have seen rare tokens during training. An embedding doesn't guarantee an exact string match.
2. TF with saturation — the more often a word occurs in a document, the higher the score, but with diminishing returns; IDF — words rare in the collection weigh more; length normalization — a long document doesn't win by sheer volume.
3. The scales aren't comparable and depend on the query: BM25 can be 0–30, cosine 0.3–0.9; the sum effectively equals one of the lists. RRF uses ranks, not values.
4. **b.** 1/(60+2) = 1/62; the list the chunk is absent from contributes nothing.
5. A bi-encoder encodes the question and the document separately, and the document vectors are computed in advance; a cross-encoder sees the pair whole and outputs relevance — more precise, but it requires a model run for each pair for each question, which is too slow over the whole knowledge base.
6. Good: 3–5 chunks go into the prompt, and the right one is now there more often. hit@20 didn't change because the reranker only re-sorts the same candidates and adds no new ones.
7. `split()` on whitespace keeps punctuation and case (`TEA15,`, `Promo`, `"Light"`), doesn't split SKUs into parts and knows nothing about word forms; the tokenization of the question and of the corpus must be one function. On top of that, there is no category filter and no archive exclusion. What's needed is a shared `tokenize()` for both sides and the same filters as in vector search.
8. Before indexing, an LLM prepends to each chunk a short context based on the whole document, and this text goes into the embeddings and BM25. Prompt caching makes it cheap: the whole document is cached once, and for each chunk we pay mostly for the chunk itself and a short answer.
9. MRR (and hit@3): the reranker changes the order of the candidates, while hit@20 only looks at whether the chunk is in the top twenty.
10. BM25 counts word matches, and "send back/returning" and "unsealed/opened" are different words (synonyms and word forms); the only shared word is "tea", and it occurs in many chunks about tea. The workaround: embeddings cover the meaning, and the rewritten queries from `plan_query` (AIL-60) bring the wording closer to the text of `kb/`; BM25 is still needed for exact identifiers, which are kept both in the original question and in the rewritten queries.
11. No: the reranker sees only the candidates from the first stage. What needs fixing is the first stage's recall — chunking, rewriting, filters, BM25, a larger k.
12. **c.** As of November 2026, neither DeepSeek nor Ollama has a reranking endpoint. The cross-encoder runs locally via Sentence Transformers; LLM reranking through DeepSeek is possible but more expensive, slower and non-deterministic.
13. DeepSeek's cache works on a matching prefix, and here the prompt starts with the chunk, which is different every time, so there is no matching prefix. The unchanging part (the instruction and the page) has to go at the beginning, and the chunk at the very end.
14. According to DeepSeek's compatibility table, `cache_control` is ignored rather than causing an error, and DeepSeek caches prefixes automatically. All that matters is that the document is at the beginning of the prompt; we check the hits in `usage`.

## What's next

The search is ready and measured. Now we turn the chunks it finds into an answer that can be trusted: [AIL-23 · Project 2: RAG answers with source citations](AIL-23.md).
