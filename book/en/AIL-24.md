# 5.4 · Project 2: a LlamaIndex version, a comparison  (AIL-24)

> **Week 5** · RAG · ⏱ ~5 h · Project

<!-- description: The same RAG on LlamaIndex: ingestion, hybrid search, reranking and citations. We compare it with the hand-built version and decide when a framework pays off. -->
<!-- source-sha256: 9fe90f603bbf -->

## Why an AI engineer needs this

LlamaIndex and LangChain come up often in job postings, and an interview will ask: "have you used frameworks? when would you not use one?". A good answer is not "yes, I know them" but "I built the same RAG by hand and on LlamaIndex, and here is what I saw in the numbers". A framework speeds up the start and provides ready-made integrations, but it hides details and makes debugging harder. The goal of the chapter is to form our own, well-grounded opinion.

## Theory

### What LlamaIndex is

LlamaIndex is a Python framework for "LLM + our own data" applications. It provides ready-made blocks for every stage of the same chain from AIL-59 (loading → chunking → embeddings → storage → search → answer) and common interfaces so the blocks can be swapped (a different vector database, a different embedding model, a different LLM: a one-line change).

We have already written all of this by hand over weeks 4–5, so the easiest way to get to know the framework is through the mapping between our version and its abstractions:

| Our hand-built version | LlamaIndex |
|---|---|
| A `kb/` page + metadata from front matter | `Document` (text + `metadata`, a stable `id_`) |
| A chunk | `Node` / `TextNode` (with metadata and links to the document and neighbors) |
| `chunk.py` (by headings) | Node parser: `MarkdownNodeParser`, `SentenceSplitter`, etc. |
| `ingest.py` with hash-based deduplication | `IngestionPipeline` (transformations + docstore + vector store, cache) |
| `embed.py` | Embedding model (`Settings.embed_model`), OpenAI/HuggingFace/… integrations |
| `store.py` (sqlite-vec) | Vector store (built-in in-memory, Qdrant, pgvector, Chroma, …) |
| `search()` with a category filter and no archive | Retriever + `MetadataFilters` |
| BM25 + RRF | `BM25Retriever` + `QueryFusionRetriever` (reciprocal rank mode) |
| `rerank()` | Node postprocessor (for example, `SentenceTransformerRerank`) |
| `plan_query` (multi-query) | `QueryFusionRetriever` with query generation; HyDE: `HyDEQueryTransform` |
| `answer()` with `[n]` | Response synthesizer / Query engine; `CitationQueryEngine` |
| `ask()` | `index.as_query_engine(...)` / `RetrieverQueryEngine` |

Many integrations live in separate packages (`llama-index-embeddings-huggingface`, `llama-index-llms-anthropic`, `llama-index-retrievers-bm25`, `llama-index-vector-stores-qdrant` …); we install only the ones we need. The framework's API changes faster than the providers' APIs: **all the examples below are illustrative; we check imports and class names against the current documentation**.

### A minimal RAG on LlamaIndex

```python
# Illustrative: verify imports and class names against docs.llamaindex.ai
import os
from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.core.node_parser import MarkdownNodeParser
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.llms.anthropic import Anthropic

Settings.embed_model = HuggingFaceEmbedding(model_name=os.environ["EMBED_MODEL"])
Settings.llm = Anthropic(model=os.environ["ANSWER_MODEL"])

docs = [
    Document(text=page.text, id_=page.doc,          # doc = "kb/returns.md", stable
             metadata={"category": page.category, "archived": page.archived,
                       "doc": page.doc})
    for page in load_pages("kb")                    # reuse rag/load.py from AIL-20
]
nodes = MarkdownNodeParser().get_nodes_from_documents(docs)
index = VectorStoreIndex(nodes)

engine = index.as_query_engine(similarity_top_k=5)
resp = engine.query("Can I return opened tea?")
print(resp)                                         # answer text
for sn in resp.source_nodes:                        # retrieved chunks with scores
    print(sn.score, sn.node.metadata["doc"])
```

A dozen lines, and we have a working RAG. That is the main argument for frameworks. Note that we **reuse** our own `load.py` from AIL-20 (front matter → metadata): a fair comparison is about chunking/index/search/answer, not reading files. And the first difference shows up right away: `MarkdownNodeParser` knows nothing about our explicit anchors `{#opened-tea-returns}`, so we have to build the `kb/returns.md#...` links for citations ourselves.

### Ingestion pipeline and deduplication

`VectorStoreIndex(nodes)` in the minimal example rebuilds the index on every run. A knowledge base that gets edited and reindexed needs an equivalent of our `ingest.py`. `IngestionPipeline` applies a chain of transformations (parser → metadata extraction → embeddings) and, if a docstore is attached, on a repeat load it skips documents with the same `id_` and the same content hash and updates the changed ones. This is the equivalent of our `doc_hash` logic from AIL-20. The key condition is a **stable document `id_`** (the page path `kb/returns.md`); otherwise deduplication doesn't work: the same mistake as `uuid4()` in the chunk key from AIL-20.

### Hybrid, filters, reranking

The minimal example searches by vectors only. Let's assemble from LlamaIndex blocks the same search configuration that won in AIL-22:

```python
# Illustrative: check the current names in docs.llamaindex.ai
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.postprocessor import SentenceTransformerRerank
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.vector_stores import MetadataFilters, ExactMatchFilter
from llama_index.retrievers.bm25 import BM25Retriever

filters = MetadataFilters(filters=[
    ExactMatchFilter(key="category", value="returns"),
    ExactMatchFilter(key="archived", value=False),   # skip returns-2025.md
])
returns_nodes = [n for n in nodes
                 if n.metadata["category"] == "returns" and not n.metadata["archived"]]
vector_r = index.as_retriever(similarity_top_k=20, filters=filters)
bm25_r = BM25Retriever.from_defaults(nodes=returns_nodes, similarity_top_k=20)

fusion = QueryFusionRetriever(
    [vector_r, bm25_r],
    mode="reciprocal_rerank",   # RRF, as in AIL-22
    num_queries=3,              # LLM generates extra queries, as in AIL-60
    similarity_top_k=20,
)
rerank = SentenceTransformerRerank(model=os.environ["RERANK_MODEL"], top_n=5)
engine = RetrieverQueryEngine.from_args(fusion, node_postprocessors=[rerank])
```

Each line corresponds to a chapter of the plan: the category and archive filter (AIL-20/60), BM25 + RRF (AIL-22), query generation (AIL-60), the reranker (AIL-22). We understand what happens inside because we did it by hand. Someone who started with the framework sees only magic parameters here. Note a small detail too: the BM25 retriever knows nothing about the vector index's filters, so we filter `returns_nodes` ourselves; forget it, and the archived return rules come back into the results through BM25.

### Citations

Search is assembled from ready-made blocks with almost no loss. The answer is harder. `CitationQueryEngine` splits the retrieved pieces into numbered sources and asks the model to add `[n]` references, similar to our AIL-23. But the prompt inside is **someone else's**. To get our behavior (a fixed refusal phrase and handing the question to a human, the rule about pages that disagree, such as the free shipping threshold in `delivery.md` and `promo.md`, answering in the language of the question), we have to find and override the prompt template. This is the typical point where a framework starts to get in the way: we need to know which template is responsible for what and how to replace it.

### Debugging and observability

To replace someone else's template, we first need to see it. This is a special case of the main question in RAG debugging: "what exactly went to the model?". In the hand-built version it is a variable we can print. In LlamaIndex it is the internals of the query engine. Tools:

- `resp.source_nodes`: what was found and with what scores;
- verbose logging (`logging` at DEBUG level): the steps and prompts are visible;
- the built-in callbacks/instrumentation system and integrations with external tracing services (more in the chapters on observability and production);
- `engine.get_prompts()` to look at the prompt templates the engine uses, and `update_prompts()` to replace them.

### How to compare fairly

Now we have two pipelines for one task. For the "which one to keep" conclusion to rest on numbers rather than impressions, we plan the comparison in advance. The criteria and how to measure them:

| Criterion | How to measure |
|---|---|
| Search quality | hit@3, hit@5, MRR on the same 20 questions (`resp.source_nodes` → the same `must_contain` function) |
| Answer quality | the same manual table from AIL-23 on 13 questions (correctness, citations, refusal) |
| Code size | lines of our own code without tests (`wc -l` or `cloc`) for equivalent functionality |
| Speed | p50 latency per question; indexing time |
| Clarity when debugging | we take 2 failed questions and time how many minutes it takes to understand the cause in each version |
| Dependencies | the number of packages in the environment (`pip list | wc -l` or `uv pip list | wc -l`), size |

Rules of a fair comparison:

- **The same inputs:** the same `kb/` pages with the same metadata, the same embedding model, the same LLM, the same reranker. Otherwise we compare models, not code.
- **Comparable chunking.** `MarkdownNodeParser` splits differently from our `chunk.py` (breadcrumbs like `Products > Light Lamp > Warranty`, anchors, whole rate tables). Either we add breadcrumbs and `url` to the node metadata/text, or we explicitly note the difference in the conclusions. Better: both variants, "out of the box" and "tuned".
- **The same k** at every stage.
- **The same golden set** and scoring function.

### When a framework, when by hand

| A framework is good | The hand-built version is better |
|---|---|
| A prototype in a day, we need to show an idea | A small pipeline that has to be understood down to the line |
| Many data sources (ready-made loaders) | Non-standard chunking, special metadata (`archived`, anchors) |
| We need to try vector databases / models quickly | Strict requirements on latency and control over prompts |
| The team already uses it | Simple debugging and a minimum of dependencies are needed |
| Ready-made advanced modes are needed (agents, routing) | Learning: understanding how everything works |

A common mature answer: "a prototype on a framework, and the critical path on thin code of our own on top of the provider's SDK", or a hybrid that takes only individual useful pieces from the framework (loaders, parsers). The conclusion should rest on our own numbers, not on this table.

## DeepSeek and Ollama: how we do it

Switching providers in LlamaIndex means replacing `Settings.embed_model` and `Settings.llm`. For a fair comparison both versions must use **the same** models as the hand-built one: embeddings from Ollama (or Sentence Transformers), generation on DeepSeek. The knowledge base is public, so sending its pieces to DeepSeek is fine; real customer messages go to the cloud in neither version: the test questions are made up.

### Embeddings: Ollama or Hugging Face

```python
# Illustrative: uv add llama-index-embeddings-ollama (pin the version)
from llama_index.embeddings.ollama import OllamaEmbedding

Settings.embed_model = OllamaEmbedding(
    model_name=os.environ["EMBED_MODEL"],     # e.g. bge-m3, same as the manual version
    base_url="http://localhost:11434",
)
```

If the hand-built version embeds through Sentence Transformers, we keep `HuggingFaceEmbedding` from "Theory" with the same model. The backend must match the hand-built version; otherwise we compare models, not the framework (chapter 4.1: `ollama:bge-m3` and `st:BAAI/bge-m3` are not the same thing).

### LLM: DeepSeek, two ways

1. **A dedicated integration** `llama-index-llms-deepseek` (`from llama_index.llms.deepseek import DeepSeek`; the key from `DEEPSEEK_API_KEY`). Careful: as of November 2026, [its page in the LlamaIndex documentation](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) shows old model names (`deepseek-chat`, `deepseek-reasoner`), while the DeepSeek API now has `deepseek-flash` and `deepseek-v4-pro`. We check that the integration accepts the current model name and can pass `thinking` (if not, we move to the second way).
2. **`OpenAILike`** from the `llama-index-llms-openai-like` package, a thin wrapper for any OpenAI-compatible API: `model`, `api_base="https://api.deepseek.com"`, `api_key`, `is_chat_model=True`, `context_window`. It doesn't check the model name against OpenAI's list, so new DeepSeek names cause fewer problems. The regular LlamaIndex `OpenAI` class with DeepSeek's `api_base` may fail on an unfamiliar model name.

How to turn off DeepSeek's reasoning through the LlamaIndex wrapper depends on the integration version: we look in it for a parameter for an extra request body (`extra_body` or an equivalent) and check the actual request in the DEBUG logs. This is a good example of a "where the framework gets in the way" item for the comparison table.

### LLM: Ollama

```python
# Illustrative: uv add llama-index-llms-ollama (pin the version)
from llama_index.llms.ollama import Ollama

Settings.llm = Ollama(
    model=os.environ["ANSWER_MODEL_LOCAL"],   # e.g. qwen3:4b on an 8 GB machine
    request_timeout=120.0,                    # default is 30 s; local generation can be slower
    context_window=8000,                      # limit memory use; must fit 5 chunks + prompt
)
```

Memory: with 8 GB of RAM, a 3–4B-class model (the default is `qwen3:4b`, ~2.5 GB); with 16 GB, 7–8B; with 32 GB or more, 14B and larger. On 8 GB, 7–8B only when the browser, the IDE and everything heavy are closed. Here `context_window` affects not only quality but also memory: the bigger the window, the more RAM. The LlamaIndex version on an Ollama LLM keeps the embedding model, the generator and the reranker in memory at once. We check `ollama ps` and the system monitor before running the eval on 20 questions.

According to [the integration page](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/), `Ollama` also has `thinking` (reasoning for thinking models) and `json_mode`.

### Hidden LLM calls cost different things

`QueryFusionRetriever(num_queries=3)` and some response synthesizers call the LLM implicitly. On DeepSeek that means money and network latency (plus reasoning by default, unless it is turned off); on Ollama, seconds of our machine's time. We log the number of LLM calls per question in both versions: it is a row in the comparison table.

### Comparing providers for this chapter

| What is needed | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| LlamaIndex LLM integration | `llama-index-llms-anthropic` | `llama-index-llms-openai` | `llama-index-llms-deepseek` (check model names) or `OpenAILike` | `llama-index-llms-ollama` |
| Embeddings in LlamaIndex | None of its own | `llama-index-embeddings-openai` | **None** → Ollama / Hugging Face | `llama-index-embeddings-ollama` |
| Special parameters through the wrapper | — | — | `thinking`: check how to pass it | `thinking`, `json_mode`, `request_timeout`, `context_window` |
| Framework default if nothing is set | — | LlamaIndex reaches for OpenAI by default and looks for its key | — | — |

### What to use in the practice

The main option is the hand-built and LlamaIndex versions on the same Ollama embeddings and DeepSeek generation. LlamaIndex on an Ollama LLM is a fully offline option, optional. Claude through `llama-index-llms-anthropic` from "Theory" is "for comparison". We always set `Settings.llm` and `Settings.embed_model` explicitly: otherwise the framework may go to the default provider.

## Learning path

1. We open the [LlamaIndex docs](https://docs.llamaindex.ai) → Getting Started: installation and the starter tutorial (≈40 min). We do the starter on 3 pages of our own `kb/`, not on their example. We pay attention to the package structure (core + integrations) and `Settings`.
2. Same place → the High-Level Concepts / Understanding section: Loading, Indexing, Querying (≈30 min). We map each concept to a row of the mapping table above.
3. Same place → Ingestion Pipeline: transformations, docstore, cache, document management (deduplication by `id_`) (≈30 min). We note how to make a repeat load not duplicate nodes.
4. Same place → Query Engine and Retrievers: `as_query_engine`, `RetrieverQueryEngine`, metadata filters, BM25 retriever, Query Fusion (reciprocal rerank), node postprocessors / rerankers, Citation Query Engine (≈45 min). We find the section on customizing prompts (`get_prompts`/`update_prompts`).
5. Same place → the section on observability / logging (≈15 min): how to see the prompt that went to the model.
6. Same place → integrations: [Ollama Embeddings](https://developers.llamaindex.ai/python/framework/integrations/embeddings/ollama_embedding/), [Ollama LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/), [DeepSeek LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) and the `OpenAILike` reference in the API reference (≈25 min). We note the package, class and parameter names. We check the model names in the examples against the current [DeepSeek models page](https://api-docs.deepseek.com/quick_start/pricing).

## What to watch out for

- **Versions and imports.** Half the examples on the internet use old import paths (from before the split into `llama_index.core` and integration packages). We trust only the current documentation and pin versions in `requirements-llamaindex.txt`.
- **Hidden LLM calls.** Some components (query generation in fusion, metadata extraction, some response synthesizers) call the LLM implicitly, which costs money and latency. We check the logs.
- **The default LLM / embeddings.** If `Settings.llm` and `Settings.embed_model` are not set, the framework may try to use a default provider and look for its key in the environment. We set them explicitly.
- **The response synthesis mode.** Some modes make several LLM calls per question (for example, refining the answer chunk by chunk). We pick the one that matches the hand-built version (one call with all the chunks); otherwise the latency comparison is unfair.
- **Someone else's prompts.** The refusal behavior and citation format are not ours by default; without replacing the templates, the AIL-23 eval can fail for reasons that have nothing to do with search.
- **The archive in the results.** The `archived` filter has to be repeated everywhere nodes get into search: in the vector retriever's `MetadataFilters` and in the node list for BM25. Otherwise the outdated rules from `returns-2025.md` surface in one of the versions, and the comparison shows a difference that isn't there.
- **The in-memory index** by default: everything is recomputed on restart. For a fair measurement of indexing and query speed we use persist or an external vector store.
- **Keys stay out of the code** and out of the logs: with DEBUG logging we don't save full requests with keys.

## Practice

The folder `projects/02-support-kb-rag/llamaindex_version/`, a separate `requirements-llamaindex.txt` (so as not to clutter the main environment; or a separate venv).

- [ ] **Starter.** `li_starter.py`: 3 `kb/` pages, `VectorStoreIndex`, `as_query_engine`, one question ("can I return opened tea?"). We print `source_nodes`.
- [ ] **Providers.** In `li_settings.py` we explicitly set `Settings.embed_model` (Ollama `OllamaEmbedding` or `HuggingFaceEmbedding`: the same backend and model as in the hand-built version) and `Settings.llm` (DeepSeek through `OpenAILike` or `llama-index-llms-deepseek`). Package versions are pinned in `requirements-llamaindex.txt`. In the DEBUG log we check that requests go to `api.deepseek.com` and `localhost:11434`, not to OpenAI.
- [ ] **Ingestion.** `li_ingest.py`: the same `kb/` pages through `load.py`, `Document` with `id_=doc` and the `category`, `archived`, `doc` metadata; the nodes get `url` (`kb/<file>.md#<anchor>`) and `section`; `IngestionPipeline` with a parser and embeddings from the same model as in the hand-built version; persist to disk. We check that a second run adds no nodes.
- [ ] **Search.** `li_search.py`: a retriever with a category filter and no archive, a BM25 retriever, fusion (RRF) and a reranker: the same configuration that won in AIL-22. We plug in our own category detection rules from AIL-60 (reusing the code).
- [ ] **Answer.** `li_answer.py`: `CitationQueryEngine` or `RetrieverQueryEngine` with a replaced prompt template (our system prompt from AIL-23, the refusal phrase). Through `get_prompts()` we make sure the template really is replaced.
- [ ] **Eval with the same script.** An adapter `li_adapter.py`: functions `retrieve(question) -> list[str]` and `ask(question) -> Answer` with the same signature as in the hand-built version, so that `eval/run_retrieval_eval.py` and the AIL-23 table run without changes.
- [ ] **Measurements.** Lines of code (`cloc rag/` vs `cloc llamaindex_version/`), p50 latency, full indexing time, number of packages in the environment.
- [ ] **Debugging experiment.** We pick 2 questions where at least one version got it wrong (candidates: the cost of delivering 3 kg to another city, which is the rate table; the warranty on the Light Lamp versus the Light Mini Lamp). In each version we find the cause and time it. We write down which tools helped.
- [ ] **A README section "Hand-built version vs LlamaIndex"**:

  | Criterion | Hand-built | LlamaIndex (out of the box) | LlamaIndex (tuned) |
  |---|---|---|---|
  | hit@3 / hit@5 / MRR | | | |
  | Answers: correct / with citations / refusals (out of 13) | | | |
  | Lines of code | | | |
  | p50 latency | | | |
  | Indexing time | | | |
  | Time to debug 2 errors | | | |
  | Dependencies | | | |
  | LLM calls per question | | | |

  And 5–10 sentences of conclusion: which version we keep as the main one and why, what we liked in the framework and what got in the way (including how easy it was to plug in DeepSeek and Ollama and pass specific parameters such as turning off reasoning).
- [ ] **(For comparison, optional)** We replace `Settings.llm` with Claude (`llama-index-llms-anthropic`) and run the 13 questions: how many lines of code changed, and how did the answers change?

## Done when

- The LlamaIndex version works on the same `kb/` knowledge base, with the category filter, archive exclusion, hybrid search and the reranker; it answers with links to sections and refuses on questions outside the knowledge base.
- Both versions are run with the same eval script on the same 20 (search) and 13 (answers) questions.
- The README has a "Hand-built version vs LlamaIndex" section with a table and a well-grounded conclusion on which version to keep and why.

## Self-check quiz

1. What are the LlamaIndex equivalents of our "page" and "chunk" called?
2. What does `IngestionPipeline` with a docstore do on a repeat load, and what condition is required for it?
3. Which LlamaIndex component corresponds to our BM25 + RRF from AIL-22?
4. Why does a fair comparison require the same embedding model and LLM in both versions?
5. What is wrong with this code?
   ```python
   docs = [Document(text=p.text, metadata={"category": p.category}) for p in pages]
   pipeline = IngestionPipeline(transformations=[parser, embed_model], docstore=docstore)
   pipeline.run(documents=docs)   # runs every night
   ```
6. Where does LlamaIndex most often "get in the way" in a RAG task with citations? a) loading Markdown b) a custom refusal prompt and citation format c) computing cosine similarity d) installing packages
7. How can we see exactly which prompt LlamaIndex sent to the model?
8. Why can the LlamaIndex version turn out slower than the hand-built one with the same search configuration? Two reasons are enough.
9. In which situations is it worth choosing a framework, and in which the hand-built version? One example each.
10. Why are there so many broken LlamaIndex examples on the internet, and how do we protect ourselves from them?
11. DeepSeek was connected through the LlamaIndex `OpenAI` class with `api_base="https://api.deepseek.com"` and `model="deepseek-flash"`, and the result was an unknown-model error. What should be used instead?
12. `Settings.embed_model` is not set, and there is no OpenAI key in the environment. What will most likely happen, and why does it matter for the "DeepSeek + Ollama" stack?
13. Why must the LlamaIndex version embed through the same backend (Ollama or Sentence Transformers) as the hand-built one, and not just "the same bge-m3 model"?

## Answers

1. `Document` (a page with metadata and an `id_`) and `Node`/`TextNode` (a chunk).
2. It skips documents with the same `id_` and unchanged content and updates the changed ones. A stable document `id_` is required (for example, the page path `kb/returns.md`).
3. `QueryFusionRetriever` in reciprocal rerank mode on top of a vector retriever and `BM25Retriever`.
4. Otherwise the differences in quality and speed are explained by the models, not by the code/framework, and the comparison loses its meaning.
5. The `Document` has no stable `id_` (it is generated randomly), so the docstore won't recognize the document on a repeat run, and the nodes get duplicated every night; also the metadata lacks `archived` (archived return rules end up in search) and the `doc`/`url` needed for citations.
6. **b.** The default behavior is set by built-in prompt templates; to get our own refusal and citations, they have to be found and replaced.
7. Through `engine.get_prompts()` (the templates), verbose logging/instrumentation (the actual calls) and `source_nodes` (what was in the context).
8. Hidden extra LLM calls (query generation, multi-step response synthesis); an in-memory index without persist that is recomputed on startup; the overhead of the abstractions and a different default configuration.
9. A framework: a quick prototype with many data sources, or trying out vector databases. Hand-built: a small critical pipeline that needs full control over prompts, simple debugging and a minimum of dependencies.
10. The framework's API changes fast (for example, the split into `llama_index.core` and integration packages), and old examples use outdated imports. Protection: only the current documentation and pinned versions in requirements.
11. `OpenAILike` (`llama-index-llms-openai-like`) with `api_base`, `api_key`, `is_chat_model=True`: it doesn't check the name against OpenAI's model list. Or the `llama-index-llms-deepseek` integration, if it accepts the current model names.
12. The framework tries the default embedding provider (OpenAI) and fails without a key; with a key, it silently sends the texts to OpenAI. In our stack embeddings must be local (DeepSeek has none), so `Settings.embed_model` is set explicitly.
13. Builds of the same model in Ollama and in Sentence Transformers are different runtimes, and their vectors may differ. If the backends differ, the difference in the numbers may be due to them rather than the framework.

## What's next

The project's final step remains: [AIL-25 · Project 2: a README of the RAG assistant for GitHub](AIL-25.md), so that the project can be run from scratch and shown at an interview.
