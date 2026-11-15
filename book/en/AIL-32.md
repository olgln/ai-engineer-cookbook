# 8.2 · A chunking experiment in RAG: A vs B  (AIL-32)

> **Week 8** · Evals · ⏱ ~4 h · Project

<!-- description: The first RAG experiment: a hypothesis, one change, an eval run. We fairly compare two chunking strategies and analyze the result question by question. -->
<!-- source-sha256: fcd380398cc5 -->

## Why an AI engineer needs this

This is the first complete experiment of Project 3: hypothesis → one change → eval run → conclusion with numbers. This loop is the daily work of an AI engineer, not "we tried it and it seems better". Chunking is not a random choice: bad splitting is a common reason why RAG retrieves the wrong thing, and the effect is usually large enough to be visible on our set.

## Theory

### Anatomy of an experiment

```
 1. hypothesis (in writing, BEFORE the run)
       "heading-based chunks will give +X pp hit@5,
        because the answer to a question usually lies inside one section"
 2. one change                 chunking: fixed-512 → headings
 3. everything else fixed      embeddings, k, answerer, prompt, judge, dataset
 4. eval run                   baseline ×3, variant ×3 (or ≥1 + known spread)
 5. comparison                 overall metrics + paired comparison + slices
 6. analysis                   on which questions the difference is and why
 7. conclusion                 accept / reject / "trend", a row in the table
```

This is the same discipline as in an A/B test of a shop page: we change one parameter, leave the rest alone, compare on the same data and don't declare victory until the result goes beyond the noise ([AIL-62](AIL-62.md)). Below we go through the steps in order on our example: the hypothesis, the choice of two variants, the conditions for a fair comparison, the runs, the analysis and the log.

### The hypothesis: how to write it

The hypothesis is written before the first run; otherwise it is easy to fit it to the number we got. A good hypothesis has three parts: **what we change**, **which metric we expect to move and by how much**, **why** (the mechanism). An example:

> If we split `kb/` by section headings (H2/H3) with the heading path at the start of the chunk, an 800-token limit, tables as indivisible "atoms" and merging of short sections on product pages, instead of fixed 512-token chunks with an overlap of 64, then hit@5 will grow by 8–15 pp, most of all on questions tagged `table` and `similar_products`, because right now rows of the rate table end up in a chunk without the header (weight, zone), and the "Warranty" section of the `lamp-light-mini.md` page ends up in a chunk without the lamp's name. Correctness will grow less than hit@5. The cost of an answer may change along with the average chunk size.

Here hit@5 is the share of questions for which at least one relevant chunk is among the top 5 retrieved, and pp means percentage points: a rise from 0.70 to 0.80 is +10 pp. Why write down the "why": in the analysis we check not only the number but also the mechanism. If the hit rate grew, but on different questions than predicted, the hypothesis about the mechanism is wrong, even if the number matched.

### Which strategies to compare

The hypothesis names two specific ways to split `kb/`. We already implemented the strategies in [AIL-19](AIL-19.md) and picked one of them for `index.db` on 10 questions. Now we check that choice on the full set and with all the metrics. Variants worth comparing on the shop's knowledge base:

| Strategy | How it works | Expected strength | Risk |
|---|---|---|---|
| A: fixed + overlap | Chunks of N tokens with an overlap | Predictable size | Cuts rate and warranty tables; a chunk doesn't know which product it is about |
| B: by headings | A section = a chunk with the heading path ("Products > Light Mini Lamp > Warranty") at the start; long ones are split by paragraphs, short ones are merged | Semantic integrity, the lamps are told apart by the path | Chunks of different sizes |
| B': headings + LLM context | B plus 1–2 sentences of context from a model (`contextualize.py`, `index_ctx.db` from 5.2) | Search better understands what the chunk is about | Longer chunks, costs model calls |

For the experiment we pick **two**: the baseline and one alternative. The rest are for later experiments. From here on in the chapter, A is fixed-512 with an overlap of 64, and B is headings. Even if `index.db` is already built by headings, we build both variants anew into separate files: one version of `kb/`, one loading code.

### A fair comparison: the chunk size trap

The variants are chosen, but they can't be compared head-on: a chunking strategy changes not only the chunk boundaries but also their size. The most common mistake in chunking experiments: variants with large chunks win on hit@k simply because k large chunks cover more text. That is not better chunking, it is more context. At the same time the cost and latency of the answer grow, and the model is worse at finding what it needs in a long context.

In `kb/` the trap points the other way: sections are short (a product page is a few sections of a couple of paragraphs each), the average B chunk (~370 tokens) is smaller than A's (512), and at the same k it is the baseline that gets the head start.

Two ways to compare fairly:
1. **Equal context budget.** We pick k so that the average context size in tokens is close: fixed-512 at k=5 (~2560 tokens) versus headings (average chunk ~370 tokens) at k=7 (~2590 tokens).
2. **Show both**: hit@k at the same k and the average number of context tokens. Then the reader sees the trade-off.

We always add the columns "average chunk size" and "context tokens per question" to the results table.

### Recomputing relevance after a chunking change

The second thing a chunking change silently breaks is the relevance labeling itself: hit@k and MRR are computed from it. Chunk keys in the new index are different: `chunk_key = sha256(url + section + text)` changes along with the text and the heading path, so the `source_chunk_keys` from the set are no good. This is exactly why in [AIL-28](AIL-28.md) we store `evidence`: the `is_relevant` function from [AIL-29](AIL-29.md) finds relevant chunks in any index by the quote. Before the run we check:

- for every question (except `unanswerable`), the new index has at least one chunk containing the quote;
- if not, the reason is either a cut quote (fixed chunking cut a phrase or the table row `| 1–3 | $3.50 | $4.70 | $5.90 |` in half) or a difference in text loading (front matter was processed differently).

If in variant A the quote was cut for 5 questions and in B it wasn't, A gets 5 misses that are not actually search misses. We account for this: either we count a partial match (most of the quote is inside the chunk) or we flag such cases in the analysis.

### Indexes side by side, not instead

Checking quotes, comparing at different k and repeating runs are convenient only if both variants are available at the same time. So we don't rebuild the single index: we keep both variants at once, as separate sqlite-vec files, with the name in the config:

```
projects/02-support-kb-rag/
  index.db                  # week-4 index, untouched
  index_fixed512.db         # A: fixed 512 tokens, overlap 64
  index_headings.db         # B: headings + breadcrumbs, max 800 tokens
  eval/configs/
    chunk_fixed512.json     {"index": "index_fixed512.db", "k": 5, ...}
    chunk_headings.json     {"index": "index_headings.db", "k": 5, ...}
    chunk_headings_k7.json  {"index": "index_headings.db", "k": 7, ...}   # equal context budget
```

This way any run is reproducible, and a week later we can go back to the baseline without rebuilding. Run folders are named after the index: `eval/runs/2027-01-05T10-12_index_headings_hybrid_k5/`. Embeddings are local and cost no money, but rebuilding takes time: we count the number of chunks and tokens in each variant in advance.

### Retrieval metrics vs answer metrics

The indexes and configs are ready; what remains is to decide what exactly to run. Chunking directly affects search, so the main metric of the experiment is hit@k/MRR/recall. But we always look at correctness and faithfulness too: it happens that the hit rate grew and correctness didn't, because the model drowns in long chunks or the answer is already bottlenecked by generation. The honest conclusion then is: "search got better, but the bottleneck is generation". We also check the `archived_in_context` counter: without the `archived` metadata, `returns-2025.md` will come back into the context.

Retrieval metrics are deterministic and cheap: they can be run without generation and the judge (the `--retrieval-only` flag of `eval/run.py`), so we can quickly try several sizes and launch a full run only for the finalists.

### Per-question analysis

The runs give two overall numbers, but their difference is not yet a conclusion. The overall number says "how much"; the per-question analysis says "where" and "why". After the run we build a transition table: for each question we look at whether variant A found it and whether variant B found it. An example: a dev set of 56 questions, minus 8 `unanswerable`, is 48:

```
                 B: hit     B: miss
  A: hit           34          3      ← regressions: what did B break?
  A: miss          9           2      ← improvements: what did B fix?
```

hit@5: A is 37/48 = 0.77, B is 43/48 = 0.90, a difference of +12.5 pp. Then we look by eye:
- **9 improvements**: do they confirm the mechanism of the hypothesis (the rate table is now in one chunk with its header, the Light Mini warranty is in a chunk with the lamp's name)?
- **3 regressions**: why did the new variant lose them (a large section diluted the embedding, a product micro-section was left without context)?
- **2 "both missed"**: the problem is not chunking. This is material for [AIL-34](AIL-34.md).
- **Slices by `type`, `category` and `tags`**: maybe headings help `delivery.md` and `warranty.md` with their tables and hurt the `products/` pages, where sections are two lines long.

Right here we apply the sign test from [AIL-62](AIL-62.md) to the disagreements (9 versus 3): questions where the variants agree say nothing about the difference; only those where they disagree count. Here p ≈ 0.15, so by the significance rule this is still a "trend".

### The experiment log

Everything above — the hypothesis, the conditions, the runs, the numbers, the analysis — must stay in one place; otherwise a week later we can't reconstruct what was compared. We write up each experiment briefly and in the same format, in `experiments/EXP-01-chunking.md`:

```markdown
# EXP-01: chunking fixed512-o64 vs headings (index_fixed512.db vs index_headings.db)
Date: 2027-01-05 | dataset <sha> (dev, n=56) | git abc1234

## Hypothesis
...

## Setup
Changed: chunking. Fixed: embeddings bge-m3, hybrid search, k=5, answer prompt answer_v2, judge judge_v2.
Runs: eval/runs/2027-01-05T...

## Results
| config | hit@5 | MRR | correctness | faithfulness | ctx tokens | cost/100q | p50 latency |
|---|---|---|---|---|---|---|---|

Paired hit@5: improved 9 / regressed 3, sign test p=0.15

## Analysis
Where it helped / hurt, examples (question ids), by type, by category, by tags (table, similar_products).

## Conclusion
Accept / reject / trend. Next step.
```

These logs later make up the table in the README ([AIL-35](AIL-35.md)).

## DeepSeek and Ollama: how we do it

The theory didn't depend on the provider; on our stack it has two practical sides: what to build the two indexes with, and how chunk size affects the answerer and its cost. Chunking is an experiment about search, and the main provider here is not DeepSeek but the **embedding model**. Checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com) and [docs.ollama.com](https://docs.ollama.com).

### Embeddings for both indexes: local

The official DeepSeek documentation has no embeddings endpoint, so both indexes are built locally: with Ollama (`/api/embed`) or Sentence Transformers, the same backend as the week-4 index (`EMBED_BACKEND`, `EMBED_MODEL`). It costs no money, only time, and that is good for an experiment: we can rebuild the index with a different chunk size as many times as we like. The knowledge base is public, but the project rule stays the same: real customer messages don't go to the cloud.

```python
# illustrative: build index B with the same embedding model as index A
import ollama

EMBED_MODEL = "bge-m3"   # fixed in config for both indexes; never change it together with chunking

def embed_batch(texts: list[str]) -> list[list[float]]:
    # /api/embed returns L2-normalized vectors
    return ollama.embed(model=EMBED_MODEL, input=texts)["embeddings"]
```

**A trap that cloud embeddings don't have: the embedding model's window.** Every embedding model has a limited context: `bge-m3` has 8192 tokens, `embeddinggemma` 2K, and small models sometimes only a few hundred tokens. If a chunk is longer, its tail may be dropped when the embedding is computed, and this breaks the comparison: the "by headings" variant, where the rate table is an indivisible atom at the end of a section, will be searchable only by the beginning of the chunk. Before building the index:

- we look up the model's context: `ollama show <model>` or the model page on [ollama.com/library](https://ollama.com/library);
- we count how many chunks of each index are longer than that window;
- we keep `truncate` in mind: according to the [Ollama API reference](https://docs.ollama.com/api/embed), it defaults to `true` for `/api/embed`, meaning input longer than the window is **silently truncated** (the reference doesn't say which part is dropped). With `truncate: false` we get an error, which is better for an experiment: this way we learn about every chunk that is too long. promptfoo, for example, deliberately sends `truncate: false`.

If variant B has many chunks longer than the window, that is not "heading-based chunking is worse" but "the embedding model doesn't see the end of the chunk". Either we limit the chunk size to the model's window, or we take a model with a larger window for **both** indexes.

### Generation and the judge

The answerer and the judge don't change (`deepseek-flash` and `deepseek-v4-pro` without thinking, as in chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md)). Chunk size has two effects:

- **DeepSeek's cost grows with context tokens**, and the cache barely helps: the cache covers the shared prefix (the system prompt), while each question has its own chunks. We compute "$ / 100 q" with `eval/cost.py`, using the cache fields and peak/off-peak time; we run A and B in the same price window, otherwise the difference in cost will be about the time of day.
- **If the answerer is local**, large chunks may not fit into the Ollama server's context (4k tokens by default if there is less than 24 GB of video memory): the variant with the longer context loses because of truncation, not because of chunking. We check `ollama ps`; raising `OLLAMA_CONTEXT_LENGTH` on an 8 GB machine should be done only with care, so for this experiment it is better to keep `deepseek-flash` as the answerer.

### Provider comparison for this chapter

| What the experiment needs | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Embeddings for the indexes | none of its own | embeddings endpoint, paid | not in the documentation | `/api/embed`, free, local |
| Cost of rebuilding an index | — | per token | — | $0, only time |
| Risk of truncating a long chunk | — | check the model limit in the documentation | — | the embedding model's window; we check how `truncate` behaves |
| Generation on large chunks | we pay for input | we pay for input | we pay for input, the cache barely helps | free, but needs enough server context |

The practice of this chapter is done without design changes: both indexes on the same local embedding model, generation and the judge on DeepSeek. As a separate experiment later we can also compare embedding models (for example, two models from the Ollama library), but not together with chunking.

## Learning path

1. We reread our own results from [AIL-19](AIL-19.md) in `experiments/chunking/RESULTS.md` (≈10 min): which strategy won on 10 questions and why. This is the starting point for the hypothesis.
2. We open [Pinecone: Chunking strategies](https://www.pinecone.io/learn/chunking-strategies/) → the sections on structural (document-specific) chunking and choosing the size (≈20 min). We note the idea that the size depends on the length of the queries and on what is done with the retrieved results afterwards.
3. We open [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) → the section where adding context to a chunk is compared with the plain approach (≈15 min). This is the rationale for variant B' and an example of how to present a comparison with numbers.
4. We open [Hamel: A Field Guide to Rapidly Improving AI Products](https://hamel.dev/blog/posts/field-guide/) → the section on experiments and the order of work (≈20 min): why error analysis comes first, then the change, then the measurement.
5. We reread the significance rule from [AIL-62](AIL-62.md) (≈5 min) and keep it in front of us when drawing the conclusion.
6. We open [Ollama: Embeddings](https://docs.ollama.com/capabilities/embeddings) and the [Ollama API: /api/embed](https://docs.ollama.com/api/embed) reference (≈15 min). We find the `truncate` parameter (`true` by default) and the `prompt_eval_count` field; we write down the context of our embedding model (`ollama show <model>`).

## What to watch out for

- **Changing two things at once** (chunking and k, or chunking and the prompt) makes a conclusion impossible: it is unclear what worked.
- **Large chunks win hit@k "for free".** We compare at an equal context budget or show the tokens. In `kb/` it is usually the fixed chunks that are larger, not the heading ones.
- **A quote cut by a chunk boundary** is a false search miss; we check before the run.
- **Rate and warranty period tables**: if the chunker cuts a markdown table, the chunk "| 1–3 | $3.50 | $4.70 |" without the header and section path is useless. We check a few chunks of the new index by eye before running evals.
- **Similar products**: the chunk "Warranty: 6 months" without a name is equally close to Light and Light Mini; the heading path tells them apart.
- **Micro-sections of product pages** ("## Care" of two lines) clutter the results; we merge them with a neighbor.
- **Changing text loading** together with chunking (front matter processed differently, the repeated "Still have questions?" block cut out) is a second change. `rag/load.py` must be the same.
- **Changing the embedding model together with chunking** is a second change. `embed_model` in the config is the same for both indexes.
- **The embedding model doesn't see the end of a long chunk.** The local embedding model's window may be shorter than variant B's chunks. We count in advance how many chunks are longer than the window.
- **Lost metadata**: without `archived` on the new chunks, `archived_in_context` stops being zero.
- **A run on holdout** is not needed in this experiment: holdout is only for the final configuration.
- **A report of "4 pp better" without the spread** breaks our own rule from [AIL-62](AIL-62.md).
- **Runs A and B in different DeepSeek price windows**: the "cost" starts to depend on the time of day. We run them back to back or recompute at a single price.

## Practice

- [ ] We create `experiments/EXP-01-chunking.md` and, **before any runs**, write down the hypothesis: what we change, which metric, the expected size of the effect, the mechanism.
- [ ] We write down the context of our embedding model (`ollama show <model>`) and add `"embed_model"` (the exact Ollama tag) to the run configs; we check that it is the same in `chunk_fixed512.json` and `chunk_headings.json`.
- [ ] We build both indexes next to `index.db`: `index_fixed512.db` and `index_headings.db` (`ingest.py` with the strategy and index file parameters); the same `kb/` loading, the same embeddings, `truncate: false`, so that a chunk that is too long fails with an error instead of being silently truncated. We read 10 chunks of each by eye, including `delivery.md`, `warranty.md` and the lamps.
- [ ] For both indexes we count: the number of chunks, the average and maximum size in tokens, how many tables are cut and how many chunks are longer than the embedding model's window. We record this in the experiment log.
- [ ] Quote check: for each question we find the relevant chunks in both indexes by `evidence`; we list the questions where the quote is not found in any chunk.
- [ ] We add the `--retrieval-only` flag and the `ctx_tokens` field (context tokens per question) to `eval/run.py`.
- [ ] We run retrieval only for: fixed k=5, headings k=5, headings with k for an equal context budget.
- [ ] A full run (with generation and the judge) for the baseline and the best variant; if we already have 3 baseline runs from [AIL-62](AIL-62.md), we make 3 runs of the variant as well (or at least 1 and compare against the spread). We do both full runs in the same DeepSeek price window (peak or off-peak) and compute the cost with `eval/cost.py` using the cache fields.
- [ ] `eval/compare.py`: a paired comparison of hit@5 and correctness, the sign test, slices by `type`, `category` and tags (`table`, `similar_products`).
- [ ] A hit/miss transition table; we read all improvements and regressions and write down 2–3 typical examples of each (question id + explanation).
- [ ] We fill in the Results, Analysis and Conclusion sections. We state the conclusion by our own rule: accepted / rejected / trend.
- [ ] We add a row to the experiments table (`experiments/README.md` or the future project README).

## Done when

- The hypothesis is written down before the run, with the mechanism and the expected size of the effect.
- There is a row in the experiments table: hit@5, MRR, correctness, faithfulness, context tokens, cost, latency, spread, disagreements +/−, conclusion.
- The log lists the specific questions where the difference is, with an explanation of why.
- `archived_in_context` is 0 in the runs of both variants.

## Self-check quiz

1. Which three parts are required in a good hypothesis?
2. Why can't chunking and k be changed at the same time?
3. A variant with 1500-token chunks gave a higher hit@5 than one with 500-token chunks. Why doesn't this yet mean it is better?
4. Which two ways allow chunking strategies to be compared fairly?
5. Why does a chunking experiment need `evidence` quotes rather than `source_chunk_keys`?
6. Transition table: A hit → B miss = 3, A miss → B hit = 9. What should be done with these numbers?
   a) just compute the difference of 6 and declare an improvement; b) a sign test and reading all 12 questions; c) ignore them and look only at the overall number; d) run on holdout.
7. Hit@5 grew by 12 pp, correctness didn't change. How should this be interpreted?
8. What is wrong with this experiment log?
   ```
   EXP-01. Switched chunking to headings, fixed text loading and raised k to 8.
   hit@8 = 0.91 (was hit@5 = 0.78). Better, keeping it.
   ```
9. Why keep both indexes at the same time?
10. How can several chunk sizes be tried quickly and cheaply?
11. The "by headings" variant with tables as atoms unexpectedly lost on hit@5 on questions about rates, even though the chunks look better by eye. Which cause is specific to local embeddings, and how can it be checked?
12. Why does DeepSeek's automatic cache barely reduce the cost of answers in this experiment?

## Answers

1. What changes; which metric should move and by how much; the mechanism (why).
2. It will be impossible to tell which change produced the effect; an experiment must change one variable.
3. At the same k, large chunks cover more text: that is more context, not better search; cost and latency grow, and the model is worse at finding what it needs in a long context.
4. Compare at an equal context budget (pick k by tokens) or show hit@k together with the average number of context tokens.
5. `chunk_key = sha256(url + section + text)` changes with new splitting, so the keys from the set don't exist in the new index; a quote makes it possible to find relevant chunks in any index.
6. **b.** 9:3 may be noise (p ≈ 0.15); it has to be checked with a sign test, and the questions have to be read to understand the mechanism of the improvements and the causes of the regressions.
7. Search improved, but the bottleneck is in generation (the model doesn't use what was retrieved, drowns in a long context) or in the dataset/judge. The next experiment is about generation; error analysis is needed.
8. Three changes at once (chunking, text loading, k); the metrics are not comparable (hit@8 versus hit@5); there is no hypothesis, spread, paired comparison, correctness, cost, context tokens or per-question analysis.
9. For reproducibility and quick comparisons: any run can be repeated, and we can go back to the baseline without rebuilding.
10. A retrieval-only run (`--retrieval-only`): it is deterministic and needs no generation or judge; a full run is only for the finalists.
11. The embedding model's window is shorter than the chunk: by default `/api/embed` silently truncates long input (`truncate: true`), the embedding is computed from the beginning of the chunk, and the rate table at the end of the section takes no part in search. Check the model's context (`ollama show`), the share of chunks longer than the window and how `truncate` behaves; if needed, limit the chunk size (split a long table by rows, repeating the header) or take a model with a larger window for both indexes.
12. The cache works on a matching prefix of requests, and that is mostly the system prompt; the context chunks differ for each question and are billed at the cache-miss price.

## What's next

The next experiment changes not search but the models: in [AIL-33 · An experiment: choosing the model and a reranker for RAG](AIL-33.md) we compare a large and a small model and a variant with a reranker on quality, cost and speed.
