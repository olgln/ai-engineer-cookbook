# 4.4 · A vector database + loading the knowledge base  (AIL-20)

> **Week 4** · RAG · ⏱ ~8 h (2 days) · Project

<!-- description: A vector database for RAG: approximate search, sqlite-vec, metadata filters and an ingestion pipeline that loads a knowledge base without duplicates. -->
<!-- source-sha256: 9dd5da6bd393 -->

## Why an AI engineer needs this

In AIL-19 we settled on a chunking strategy using 10–20 pages of `kb/`, but every run re-chunked and re-embedded everything in memory. Now the toy numpy search from AIL-18 becomes a real index: hundreds and thousands of chunks, metadata, filters, reloading without duplicates. The ingestion pipeline is 60% of the real work on RAG in companies: sources change, break and duplicate. Interviews ask "how do you update the index", "how do you filter by tenant/source", "how does pgvector differ from a dedicated vector database" — after this task we will have answers from our own experience.

## Theory

### What a vector database adds on top of numpy

A vector database is a store that keeps vectors together with text and metadata and can find the ones nearest to a query. Let's compare it with what numpy can already do:

| Task | numpy (AIL-18) | Vector database |
|---|---|---|
| Storage | `.npy` in memory | On disk, transactions |
| Text and metadata | A separate JSON next to it | In the same record |
| "Warranty only" filter | A mask, by hand | `WHERE category = 'warranty'` |
| Updating one document | Rebuild the array | `DELETE` + `INSERT` |
| Millions of vectors | Slow and doesn't fit in memory | ANN indexes (HNSW, IVF) |

At our scale (hundreds to tens of thousands of chunks), exact search (brute force) takes milliseconds. So the choice of store here is a matter of convenience and familiarity, not speed.

### ANN: approximate search, in brief

We won't need ANN, but it is exactly what sets large vector databases apart, and interviews ask about it. Exact search compares the query with every vector: O(N). With millions of vectors that is slow, so **approximate nearest neighbor (ANN) search** is used:

- **HNSW** — a multi-level graph of "neighbors"; the search goes greedily from long-range links to short ones. Fast and accurate, but memory-hungry. The standard in Qdrant, pgvector and many others.
- **IVF** — vectors are split into clusters; we search only in a few of the nearest clusters.

The price of ANN is **recall < 100%**: sometimes the true nearest neighbor isn't found. An important practical trap is **filter + ANN**: if we first find the top 10 by vector and then filter to "warranty only", 0 results may remain (post-filtering). Good databases can filter inside the search or before it (pre-filtering, partitions). At our volume with exact search this problem barely exists, but knowing it is a must.

### Three store options

At our volume the choice of store is a matter of convenience, so we compare three typical options: a SQLite extension, a Postgres extension and a separate service.

**sqlite-vec** is a SQLite extension. Vectors live in a `vec0` virtual table, search is plain SQL. One file, zero servers, a familiar tool (the shop's databases in the course are SQLite with WAL too). It does exact search (brute force), which is more than enough at our scale. The project is young: the syntax and features (metadata columns, partition keys, choice of metric) keep evolving, so we check against the README and the docs for the version we install.

**pgvector** is a PostgreSQL extension: the `vector` type, distance operators (`<->` L2, `<=>` cosine distance, `<#>` negative inner product), HNSW and IVFFlat indexes. The best choice if the project already has Postgres: vectors next to business data, transactions, JOINs.

**Qdrant** is a dedicated vector database (Rust) with a REST/gRPC API, collections, payload filters and HNSW. Handy when there are many vectors and scale and advanced filters are needed. The cost is one more service in the infrastructure.

For the project we take **sqlite-vec**; the others we read about for comparison.

### sqlite-vec: the schema

The idea: a regular table with text and metadata + a virtual table with vectors, linked by `rowid`.

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY,
  chunk_key     TEXT UNIQUE NOT NULL,   -- sha256(url + section + text)
  category      TEXT NOT NULL,          -- delivery | payment | returns | warranty | promo | orders | products
  archived      INTEGER NOT NULL DEFAULT 0,  -- 1 = old version, excluded from search by default
  doc           TEXT NOT NULL,          -- page: kb/returns.md (or the web page URL)
  url           TEXT NOT NULL,          -- citation target: kb/returns.md#opened-tea-returns
  section       TEXT,
  text          TEXT NOT NULL,
  doc_hash      TEXT NOT NULL,          -- hash of the whole page content
  embed_model   TEXT NOT NULL,
  loaded_at     TEXT NOT NULL
);

-- Check the sqlite-vec docs for the exact vec0 options of your version
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[1024]                 -- bge-m3; must equal your model's dimension
);
```

Connecting from Python (illustrative; check against the README):

```python
import sqlite3
import sqlite_vec

db = sqlite3.connect("index.db")
db.enable_load_extension(True)
sqlite_vec.load(db)
db.enable_load_extension(False)
```

If `enable_load_extension` is missing, Python was built without SQLite extension support (this happens with the system Python on macOS); we install Python via Homebrew/pyenv/uv.

Insertion and a KNN query (k nearest neighbors: find the k vectors nearest to the query). The chunk goes into `chunks`, and its vector into `vec_chunks` with the same `rowid`:

```python
from sqlite_vec import serialize_float32

cur = db.execute(
    "INSERT INTO chunks (chunk_key, category, archived, doc, url, section, text, "
    "doc_hash, embed_model, loaded_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chunk_key) DO NOTHING",
    (key, category, archived, doc, url, section, text, doc_hash, MODEL, now),
)
if cur.rowcount == 1:  # inserted, not a duplicate
    db.execute("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
               (cur.lastrowid, serialize_float32(vec)))

rows = db.execute(
    """
    SELECT c.category, c.url, c.section, c.text, v.distance
    FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
    """,
    (serialize_float32(qvec), 10),
).fetchall()
```

Note `distance`: it is a **distance** (smaller = closer), not a similarity. The default is L2; for normalized vectors the order is the same as with cosine (AIL-18).

### Metadata filters with vector search

The KNN above searches the whole database, but the assistant often needs one category: for a warranty question, only the warranty pieces. The naive option is to find the top k across the whole database, then add `WHERE c.category = 'warranty'` to the JOIN. This is **post-filtering**: with k=10 it may turn out that all 10 come from product cards (`products`, the largest group in the database), and for warranty we get zero. The options:

1. **Metadata/partition key right in `vec0`** — recent versions of sqlite-vec let us declare columns like `category text` (or `category text partition key`) and `archived integer` in the virtual table and filter on them in the same KNN query. We check the docs for our version.
2. **A separate `vec0` table per category** — crude but reliable.
3. **Large k + filter + trim** (take k=200, filter, keep 10) — a simple compromise at small volume.
4. **Exact numpy search over a subset**: pull out the vectors of the needed category and compute as in AIL-18 — also an option at our volume.

We choose 1 if it is supported; otherwise 3. The key thing is a test: "a search with the `warranty` filter always returns k results from the `warranty` category, if there are that many."

The second filter is **`archived`**. The old version of the return policy (`returns-2025.md`, `archived: true`) is almost identical in text to the current one, and without a filter the search will happily surface outdated deadlines. By default we exclude the archive (`archived = 0`, the same way as the category) and include it only with an explicit flag. We don't delete the archive from the index: later it is used to check that retrieval doesn't mix up versions.

### The ingestion pipeline

The schema and search are ready; now for how to fill the index and update it when the knowledge base changes. This is the job of the ingestion pipeline (loading):

```
sources.yaml ─► load (kb/*.md: front matter → metadata)
             └► [optional] fetch (GET, disk cache) ─► clean (HTML → Markdown)
     ─► chunk (strategy from AIL-19) ─► dedupe (chunk_key) ─► embed (in batches)
     ─► upsert into SQLite ─► report: pages, chunks new/old/deleted
```

Backend principles work the same way here:

- **Idempotency.** Rerunning without changes in the knowledge base doesn't change the index. This is achieved with a deterministic chunk key, `sha256(url + section + text)`, and `UNIQUE` in the schema.
- **Incrementality.** We store the page's `doc_hash` (the file together with its front matter: changing `archived` also reindexes the page). If the hash hasn't changed, we skip the whole page (no chunking, no embeddings). If it has changed, we delete the page's old chunks (`DELETE ... WHERE doc = ?` and the corresponding `vec_chunks` rows) and insert new ones. If a file was removed from `kb/`, its chunks are deleted too.
- **Raw cache** (for web pages). We save downloaded HTML to `raw/web/<slug>.html`. Cleaning will have to be debugged many times, and downloading again is impolite to the site. `kb/` needs no cache.
- **Embedding batches** and a cache (AIL-18).
- **Transactions.** Processing one page is one transaction: either all its chunks are updated or none are.
- **We record `embed_model`.** If the model changes, this field shows that the index has to be rebuilt.

### Loading the knowledge base

The first step of the pipeline is `load`. The project's corpus is the Shelf shop help center in the `kb/` folder: Markdown files with headings, the source of truth, like documentation in a repository. The first 10–20 pages appeared in AIL-19; here we extend the knowledge base to 30–50.

| Source | Where | Specifics |
|---|---|---|
| Shop policies | `kb/delivery.md`, `payment.md`, `returns.md`, `warranty.md`, `promo.md`, `orders.md` | Long pages with tables; a section link = file + anchor |
| Archive | `kb/returns-2025.md` (`archived: true`) | An old version of the return policy — a trap for retrieval |
| Product cards | `kb/products/*.md` | Many short pages; some are similar (`lamp-light.md` and `lamp-light-mini.md` with different warranties) |

Each file starts with front matter; this is where `load.py` gets the metadata:

```markdown
---
title: Returns
category: returns
updated: 2026-03-01
---

# Returns

## Returning opened tea {#opened-tea-returns}
```

`load.py` parses the front matter (`yaml.safe_load`), checks `category` against the allowed list and fails with the file name if the front matter is missing or broken; the front matter doesn't get into the chunk text. The list of sources is kept in `sources.yaml`, not in the code.

The texts are fictional, so a cloud model writes the drafts from a brief, and we edit them by hand. We deliberately keep the built-in difficulties, since future evals are built on them: the archived return policy; rate and warranty tables; similar products; numbers that disagree between pages (the free shipping threshold in `delivery.md` and in `promo.md`); questions whose answer requires two sections.

**A web page (optional).** Collecting public pages comes in handy at work, so we add one real help page (a carrier's delivery terms) via `fetch.py` → `clean.py` with `category: delivery`, `source: web`. Politeness to sites: a pause between requests (0.5–1 s), a clear User-Agent without personal data, respecting `robots.txt`, caching. If the page is rendered by JavaScript and the HTML is empty, we first look for sources in Markdown (for example, in the service's public GitHub repository), and only then think about a headless browser.

HTML → Markdown: first we cut out the main content (the article container; we find the CSS selector in devtools), then convert (`markdownify`, `html2text` or `trafilatura`). We check by eye: tables and lists must survive.

### A link with an anchor

The last chunk field to think through before loading is `url`. For citations (AIL-23) a chunk needs a link that leads as close to the spot as possible: `kb/returns.md#opened-tea-returns`, not just `kb/returns.md`. We give headings stable ids: an explicit `{#anchor}` (as done on the pages from AIL-19) or a deterministic slug from the heading text. An explicit id is better: it doesn't change when the heading is reworded. A web page usually has anchors in the `id` of its HTML headings; we keep them during cleaning. The section anchor goes into the chunk's `url`.

## DeepSeek and Ollama: how we do it

Indexing is the only place in the project where the model is called hundreds and thousands of times in a row, and only for embeddings. DeepSeek doesn't have them — this is covered in chapter 4.1 · Embeddings by hand with numpy (AIL-18). So all of ingestion runs **locally and for free**: Ollama or Sentence Transformers. `ingest.py` needs no cloud key at all.

### `embed.py` with a choice of backend

```python
# Illustrative: one interface, backend chosen by env vars (EMBED_BACKEND, EMBED_MODEL)
import os
import numpy as np

BACKEND = os.environ.get("EMBED_BACKEND", "ollama")   # ollama | st | openai
MODEL = os.environ["EMBED_MODEL"]                     # e.g. bge-m3 / BAAI/bge-m3

def embed(texts: list[str]) -> np.ndarray:
    if BACKEND == "ollama":
        import ollama
        res = ollama.embed(model=MODEL, input=texts, truncate=False, keep_alive="10m")
        return np.asarray(res["embeddings"], dtype=np.float32)
    if BACKEND == "st":
        from sentence_transformers import SentenceTransformer
        st = _cached_st(MODEL)                        # TODO: load once, reuse
        return st.encode(texts, normalize_embeddings=True, batch_size=32).astype(np.float32)
    raise ValueError(f"unknown backend {BACKEND}")    # 'openai' is optional, for comparison

def model_tag() -> str:
    return f"{BACKEND}:{MODEL}"                       # store this in chunks.embed_model
```

What this changes in the schema and the pipeline:

- **The `vec0` dimension = the model's dimension.** `bge-m3` has 1024 (per the BAAI/bge-m3 model card), hence `embedding float[1024]` in the schema above; another model will have a different number (for example, 384 for `paraphrase-multilingual-MiniLM-L12-v2` from AIL-18). We don't take the number from memory: we call `len(embed(["test"])[0])` and use the result.
- **`embed_model` stores the backend too**: `ollama:bge-m3` and `st:BAAI/bge-m3` are different indexes even if the model name is the same (chapter 4.1).
- **Batches.** The `input` of `/api/embed` accepts a list. We tune the batch size (16–64 chunks) to the speed of our machine: a batch that is too large doesn't speed things up and eats memory.
- **The model in memory.** The first call loads the model (the `load_duration` field in the response). The `keep_alive` parameter keeps it loaded between requests — important for `search.py`, otherwise every search starts with loading. The flip side on an 8 GB machine with a browser and an IDE open alongside: a loaded model holds memory until `keep_alive` expires. A short `keep_alive` is enough for `ingest.py`; after indexing we check `ollama ps` and unload the model (`ollama stop <model>`). We don't keep the embedding model, the generator and the reranker loaded at the same time without estimating their total size.
- **Ollama must be running.** If the server doesn't respond on `localhost:11434`, `ingest.py` should fail with a clear message ("Ollama is not running: ollama serve"), not a 40-line traceback.
- **Search latency** is now network-free: embedding a question with a local model on an ordinary laptop (for example, Apple Silicon) takes on the order of tens of milliseconds if the model is already loaded. We don't take this figure on faith; we measure it.

### Comparing providers for indexing

| What the index needs | Claude | OpenAI | DeepSeek | Ollama / Sentence Transformers |
|---|---|---|---|---|
| Embeddings for thousands of chunks | None of its own (Voyage AI) | Yes, paid per token, rate limits | **No** | Yes, free; limited by the machine's speed |
| A batch in one request | — | Yes (a list in `input`) | — | Yes (a list in `input`; `batch_size` in ST) |
| Network during search | — | An API request for every question | — | No, everything is local |
| Key in `.env` for `ingest.py` | — | `OPENAI_API_KEY` | — | Not needed |

This chapter's practice is done entirely on the local backend. OpenAI embeddings are only "for comparison" and only into a separate `index_openai.db` (vectors from different models must not be mixed in one table). Sending `kb/` to the cloud is fine: the knowledge base is public.

## Learning path

1. We open [sqlite-vec](https://github.com/asg017/sqlite-vec) → the whole README, then, via the link from the README, the docs: installation for Python, `vec0`, KNN queries, metadata/partition keys, distance metrics (≈45 min). We note down the exact syntax for our version and how to filter by a column in a KNN query in it.
2. We open [pgvector](https://github.com/pgvector/pgvector) → README: the sections on creating a `vector` column, distance operators, HNSW and IVFFlat, "Filtering" (≈30 min). Note how it describes the problem of filtering with an ANN index and the ways to solve it — the same thing as in the theory above.
3. We open [Qdrant](https://qdrant.tech) → documentation: Concepts → Collections, Points, Payload, Filtering, Indexing (≈30 min). We note down how a payload index helps filters and why Qdrant filters during the graph search rather than after it.
4. We check the `kb/` pages from AIL-19 against the layout in "Practice": front matter, explicit heading anchors, tables kept whole (≈20 min). For the optional item we open a real carrier's public delivery terms page and find the text container and heading ids in devtools (≈10 min).
5. The docs of the HTML → Markdown converter, if we do the web page (`markdownify` or `html2text` on PyPI, or `trafilatura`): options for headings, tables and lists (≈15 min).
6. We reread the [Ollama `/api/embed` reference](https://docs.ollama.com/api/embed) (≈10 min): `input` as a list, `truncate`, `keep_alive`, the `load_duration` and `prompt_eval_count` fields. We note down how to keep the model loaded during `ingest.py` and `search.py`.

## What to watch out for

- **A dimension mismatch** between `float[N]` in `vec0` and the model → an insertion error (which is good: better than failing silently).
- **`distance` ≠ similarity.** Smaller is closer. We don't sort in descending order out of habit.
- **Post-filtering** returns fewer than k results, or zero. We test the filter on a rare category.
- **The archive in the results**: forget the `archived` filter, and the bot confidently quotes a return policy that is no longer in force.
- **Duplicates** on reload: the key isn't deterministic (it includes a timestamp or a random id). The key comes from the content only.
- **Orphaned vectors**: rows deleted from `chunks`, `vec_chunks` forgotten → a row drops out of the `JOIN` results, and k is effectively smaller. We delete in one transaction.
- **Junk in chunk text** is the main enemy of quality (see AIL-19): front matter, web page navigation. We check 10 random chunks by eye.
- **Tables** get cut in half during chunking, and HTML tables with `colspan` break converters. We keep the rate table in one chunk or turn it into a list of "zone: weight, price, delivery time".
- **One link for the whole file** `kb/delivery.md` makes the citation useless. Anchors are needed.
- **Blocking and CAPTCHAs** when downloading web pages aggressively. Pauses and a cache.
- **Security:** the project doesn't touch the shop's databases; `.env` holds only the LLM provider key (DeepSeek; OpenAI/Anthropic if we do the comparison), and `.env` is in `.gitignore`. With local embeddings, indexing needs no key at all. The index (`index.db`) and `raw/` are in `.gitignore` too — they can be rebuilt by a script; `kb/`, on the contrary, is in git: it is the source. Real customer messages don't go to the cloud; we make up the test questions.

## Practice

The structure of the `projects/02-support-kb-rag/` project:

```
02-support-kb-rag/
  sources.yaml          # kb/ path + optional web pages (URL, content selector, delay)
  kb/                   # shop help center: Markdown with front matter, source of truth
  rag/
    load.py             # read kb/*.md: front matter -> metadata, keep heading anchors
    fetch.py            # optional: GET + disk cache in raw/web/
    clean.py            # optional: HTML -> Markdown, keep anchors, tables
    chunk.py            # strategy chosen in AIL-19
    embed.py            # batch embeddings + cache
    store.py            # sqlite-vec schema, upsert, search
  ingest.py             # CLI: python ingest.py [--category returns]
  search.py             # CLI: python search.py "query" --category returns -k 5
  tests/test_store.py
```

- [ ] **`kb/` up to 30–50 pages**: to the pages from AIL-19 we add the missing ones — `delivery.md` (zones, delivery times, a rate table by weight and zone), `payment.md`, `returns.md` (14 days; opened tea and coffee can't be returned; who pays for return shipping), `returns-2025.md` (`archived: true`), `warranty.md`, `promo.md`, `orders.md` and `products/` (description, care, instructions, FAQ). Every file has front matter: `title`, `category`, `updated`, and `archived: true` where needed. The built-in difficulties from "Theory" are in place.
- [ ] **`sources.yaml`**: the path to `kb/`; for a web page, the URL, the content selector, the pause, `category`, `source: web`.
- [ ] **`load.py`**: the function `load_pages("kb")` reads `kb/**/*.md`, front matter → `title`, `category`, `updated`, `archived` (`false` by default); checks `category`; fails with the file name on a file without front matter; heading anchors are kept.
- [ ] **(Optional) `fetch.py` + `clean.py`** for one public help page of a real delivery service: a GET that respects `robots.txt`, a file in `raw/web/`, not downloaded again if it is fresher than N hours (`--refresh` forces it); content by selector → Markdown with anchors. We check by eye.
- [ ] **`chunk.py`**: the winning strategy from AIL-19 (most likely by headings with breadcrumbs); every chunk has `category`, `archived`, `doc`, `url` (`kb/<file>.md#<anchor>`), `section`, `text`.
- [ ] **`embed.py`**: the backend from environment variables (`EMBED_BACKEND=ollama`, `EMBED_MODEL=bge-m3` is the main path; `st` is the alternative), batches, `truncate=False`, a cache keyed by the text hash + `model_tag()`. A clear error if Ollama isn't running.
- [ ] **`store.py`**: the schema from "Theory" (the `vec0` dimension taken from a real vector of our model), `upsert_page(doc, category, archived, doc_hash, chunks, vectors)` in one transaction (delete the page's old chunks if `doc_hash` has changed; insert the new ones), `search(qvec, k, category=None, include_archived=False)`.
- [ ] **`ingest.py`**: a pipeline run with a report at the end: `pages: 42 (unchanged 35, updated 5, new 2) | chunks: +38 −27 | total 410`.
- [ ] **Idempotency**: we run `ingest.py` twice in a row — the second time `+0 −0`, the total number of chunks is the same. We check with an SQL query: `SELECT chunk_key, COUNT(*) FROM chunks GROUP BY 1 HAVING COUNT(*) > 1` returns nothing.
- [ ] **Filter**: `python search.py "can I return opened tea" --category returns -k 5` returns 5 results, all from the `returns` category and none from the archived `returns-2025.md`. We write a test in `tests/test_store.py` on a `:memory:` database with fake vectors (no network): 50 `products` chunks, 2 `warranty` chunks, a search with the `warranty` filter returns exactly those 2; plus an archived chunk that is found only with `include_archived=True`.
- [ ] **Speed**: we measure `time.perf_counter()` around the search (query embedding + SQL); the target is < 1 s. We record separately how long the query embedding takes and how long the SQL takes, and separately the first query (with the model loading in Ollama) and the following ones.
- [ ] **(For comparison, optional)** We build `index_openai.db` on OpenAI cloud embeddings and compare indexing time, cost (from `usage`) and the sanity check result on the same 5 questions.
- [ ] **Sanity check** on 5 questions from the golden set (`golden.jsonl` from AIL-19, the draft is in `notes/rag.md`, AIL-59): is the right piece in the top 5? We record the result: it will be the baseline for AIL-60.

## Done when

- An index of the whole knowledge base (30–50 `kb/` pages, all categories) in one `index.db`, with the metadata `category`, `archived`, `url` (`kb/<file>.md#<anchor>`), `section`.
- Search with a category filter works and always returns k results of the right category; archived pages don't appear in the results by default; search responds in under a second.
- Rerunning the load doesn't create duplicates; a changed page replaces its chunks.
- The filter test passes offline; `.env`, `index.db`, `raw/` are not in git, `kb/` is in git.

## Self-check quiz

1. Why a vector database if numpy searches 5,000 vectors in milliseconds?
2. What is HNSW, and what is the price of ANN search?
3. What is the problem with post-filtering, using "find chunks only from the `warranty` category" as an example?
4. In sqlite-vec a KNN result contains `distance`. How should it be sorted so that the most similar come first? a) descending b) ascending c) it doesn't matter d) by `rowid`
5. How can loading be made idempotent?
6. What is wrong with this chunk key function?
   ```python
   def chunk_key(chunk):
       return f"{chunk['url']}-{uuid.uuid4()}"
   ```
7. Why store a page's `doc_hash` separately from `chunk_key`?
8. When is pgvector the better choice over sqlite-vec? a) always b) when the project already has Postgres and vectors are needed next to the business data c) when there are fewer than 1,000 vectors d) when there is no internet
9. Why do the chunks of the `kb/returns.md` page need a link with an anchor rather than just the file path?
10. Why must deleting the old chunks and inserting the new ones for one page happen in a single transaction?
11. What most likely takes longer in a search on our index: the KNN SQL query or embedding the question via an API?
12. After switching from cloud embeddings to Ollama `bge-m3`, the schema still says `embedding float[1536]`. What happens, and how should the dimension be chosen?
13. The first `search.py` after a break takes 3 seconds to respond, the following ones 80 ms. What is going on, and how is it fixed in Ollama?
14. Why does `ingest.py` in our stack not need a DeepSeek key? a) DeepSeek is free b) DeepSeek has no embeddings endpoint, and indexing needs only embeddings, which are local c) the key is taken from Ollama d) DeepSeek builds the index itself

## Answers

1. For on-disk storage, metadata and filters, updating individual documents, transactions and scaling (ANN), not for speed at small volume.
2. A multi-level graph of nearest neighbors that the search traverses greedily. The price is approximation: recall below 100%, plus memory for the graph and difficulties with filters.
3. If we first take the top 10 across the whole database and then filter to `warranty`, there may be no warranty chunk among the ten (the many product cards take all the slots), even though such chunks exist in the database: the result is empty or incomplete. A filter inside/before the search or a larger k is needed.
4. **b.** Ascending: it is a distance, smaller is closer.
5. A deterministic chunk key from its content (`sha256(url + section + text)`) with `UNIQUE` and `ON CONFLICT DO NOTHING`, plus skipping pages whose hash hasn't changed.
6. `uuid4()` is random: every run gives a new key, and `UNIQUE` never fires, so every run duplicates all the chunks. The key must depend only on the content.
7. To skip unchanged pages entirely (no chunking and no embeddings) and to know that a page has changed and its old chunks must be deleted.
8. **b.**
9. `returns.md` is a long page with many sections; without an anchor the link in the answer leads to the top of the file, and the claim (for example, about opened tea) can't be checked.
10. Otherwise a failure halfway through leaves the page with no chunks or with duplicates of the old and new versions, and `vec_chunks` drifts apart from `chunks` (orphaned vectors).
11. Embedding the question via an API (a network request, tens to hundreds of ms); an exact KNN over a few thousand vectors in SQLite takes milliseconds. With local Ollama there is no network, and embedding with a loaded model is usually faster than the cloud, but still, as a rule, slower than KNN — it needs to be measured.
12. The insert fails with a dimension mismatch error: `bge-m3` has 1024 dimensions. The dimension is taken from a real vector (`len(embed(["test"])[0])`), and when the model changes, the index is rebuilt from scratch.
13. Ollama unloaded the model from memory, and the first request includes loading it (visible in `load_duration`). The model is kept loaded with `keep_alive` and warmed up with one request at startup; in measurements the warm-up is reported separately.
14. **b.** Generation plays no part in `ingest.py`, and embeddings are done locally by Ollama or Sentence Transformers.

## What's next

The index is ready, and we have a quality baseline. Week 5 starts with [AIL-60 · Query rewriting in RAG: multi-query, HyDE, filters](AIL-60.md): we teach the system to understand questions the way customers ask them and to set the category filter automatically.
