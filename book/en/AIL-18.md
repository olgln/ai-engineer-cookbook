# 4.1 · Embeddings by hand with numpy  (AIL-18)

> **Week 4** · RAG · ⏱ ~4 h · Theory, Practice

<!-- description: Embeddings by hand: vectors, cosine similarity and semantic search in numpy. Choosing a model with MTEB, embeddings in Ollama and Sentence Transformers. -->
<!-- source-sha256: 18f69f9b3c10 -->

## Why an AI engineer needs this

This chapter starts the second project: a support assistant that answers Shelf customers from the shop's knowledge base. Searching by words is not enough to find the right piece of the knowledge base: "can I send back tea I've already opened?" and "unsealed packages are not accepted" share almost no words but say the same thing. Search "by meaning" like this is built on embeddings.

Embeddings sit under everything that searches "by meaning": RAG (retrieval-augmented generation — the model answers from retrieved pieces of documents; the whole pipeline is in the next chapter), semantic search, deduplication, clustering support requests, recommendations. An interview is almost guaranteed to ask "what is an embedding", "why cosine and not Euclidean distance" and "how to choose an embedding model". Once we compute similarity by hand in numpy, a vector database stops being magic: it is just a fast way to do the same thing over a million rows.

## Theory

### What an embedding is

An embedding is an array of numbers of fixed length (for example, 384, 768, 1536 or 3072 numbers) that a model outputs for a piece of text. The model is trained so that texts with similar meaning get close vectors and texts with different meaning get distant ones. "I want my money back for this item" and "how to request a refund" end up next to each other, although they have no words in common. "Cash on delivery" and the Spanish "pago contra reembolso" end up close too, if the model is multilingual.

An analogy from the shop: imagine that every product has a "profile" of a hundred metrics (price, weight, seasonality, who buys it and together with what…). Two products with similar profiles sell in a similar way. An embedding is the same kind of profile, only for the meaning of a text, and the metrics have no names: the model learned them itself, and individual coordinates can't be interpreted.

Important properties:

- **The vector length is fixed** for a model and doesn't depend on the length of the text. A three-word phrase and a paragraph give vectors of the same dimension.
- **Vectors from different models are not comparable.** We can't put vectors from model A into an index and search them with a vector from model B — even with the same dimension. Changed the model — re-index everything.
- **A model has an input limit** (in tokens). Text longer than the limit is truncated or causes an error — one of the reasons we need chunking, splitting documents into pieces (AIL-19).
- **An embedding compresses.** A long text about five topics turns into an "average" of those topics and is hard to find by any one of them. Hence the rule: a chunk is about one idea.

### A little linear algebra (exactly as much as we need)

"Close vectors" have to be measurable as a number: then search comes down to computing how close the question is to each text and taking the best ones. Three formulas are enough for that.

A vector `a = [a1, a2, ..., an]`.

**Dot product:** `a·b = a1*b1 + a2*b2 + ... + an*bn`. Large and positive — the vectors "point" the same way.

**Norm (length):** `||a|| = sqrt(a·a)`.

**Cosine similarity:** `cos(a, b) = (a·b) / (||a|| * ||b||)`. It is the cosine of the angle between the vectors, from −1 to 1. It doesn't depend on the length of the vectors, only on their direction. In practice, values for text embeddings usually lie in a narrow range (for example, 0.2–0.9), and the absolute number means little: what matters is the **order** (who is closer), not "0.8 is good".

**Why normalized vectors are convenient.** If we divide each vector by its norm in advance (its length becomes 1), then `cos(a, b) = a·b`. The cosine turns into a single dot product, and search over the whole base into a single matrix multiplication:

```
scores = M @ q      # M: (N, d) matrix of normalized docs, q: (d,) normalized query
```

Many APIs already return normalized vectors (OpenAI says so in its embeddings guide), and Sentence Transformers has the flag `normalize_embeddings=True`. It is still worth checking: `np.linalg.norm(v)` should be ≈ 1.0.

One more consequence: for normalized vectors, Euclidean distance and cosine give **the same order** (`||a−b||² = 2 − 2·cos`). So for normalized vectors the choice of metric in a vector database changes almost nothing — but the index metric must match the one the model was trained for (see the model card).

### numpy in 5 minutes

These formulas can be computed with a loop over each vector, but slowly. Python has numpy for this kind of arithmetic. numpy is typed arrays (like `Float32Array` in JavaScript or `float[]` in Java) on which operations run as a whole, without Python loops. A `for` loop over 100,000 vectors in Python is slow; `M @ q` is fast because it runs in C.

```python
import numpy as np

a = np.array([1.0, 2.0, 3.0], dtype=np.float32)
M = np.random.rand(5, 3).astype(np.float32)   # 5 vectors of dim 3

M.shape                 # (5, 3) — rows x columns
a @ a                   # dot product -> scalar
np.linalg.norm(a)       # vector length
M @ a                   # (5,) — dot of every row with a
norms = np.linalg.norm(M, axis=1, keepdims=True)  # (5, 1)
M_normed = M / norms    # broadcasting: each row divided by its own norm
scores = M_normed @ (a / np.linalg.norm(a))  # cosine of every row with a
np.argsort(-scores)[:5] # indices of top-5 largest scores
```

Key concepts: `shape` (dimensions), `axis` (along which axis to compute), broadcasting (automatic "stretching" of arrays of different shapes in arithmetic), `argsort` (sort indices). If the shapes get confusing, we print `.shape` after each line, like printing a type for debugging in a familiar language.

### Two ways to get embeddings

We have the math and the tool; what remains is to get the vectors themselves. An embedding model outputs them, and it can be run in two ways.

**1. Through an API** (OpenAI, Voyage, Cohere, Google and others). Pros: high quality, nothing to install. Cons: paid per token, data leaves our machine, network, rate limits. An illustrative call in the style of the official SDK:

```python
# Illustrative: check model names and params in the current OpenAI docs
from openai import OpenAI

client = OpenAI()  # reads OPENAI_API_KEY from the environment
resp = client.embeddings.create(
    model="text-embedding-3-small",
    input=["can I return opened tea", "warranty for the Light desk lamp"],  # batch of texts
)
vectors = [item.embedding for item in resp.data]
```

We send **batches** (a list of strings in one request), not one string at a time — faster and less likely to hit a rate limit. The `text-embedding-3-*` models have a `dimensions` parameter that shortens the vector: less space, slightly lower quality. Anthropic has no embedding model of its own — its documentation recommends the partner Voyage AI; that's normal, generation and embeddings often come from different providers.

**2. Locally with Sentence Transformers.** The model is downloaded from Hugging Face once and runs on our machine (CPU, an NVIDIA GPU via `cuda` or Apple Silicon via `mps`). Free, offline, the data goes nowhere.

```python
# Illustrative: pick a concrete model from sbert.net / MTEB
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
vecs = model.encode(texts, normalize_embeddings=True, batch_size=32)  # numpy array (N, d)
```

A nuance: some models (the E5, BGE families and others) require **prefixes** — for example, `"query: ..."` for a query and `"passage: ..."` for a document. Without them quality drops noticeably. We always read the model card on Hugging Face.

### How to choose a model: MTEB

There are dozens of embedding models, and both ways raise the question of which one to take. A public benchmark is the common reference point.

MTEB (Massive Text Embedding Benchmark) is a ranking of models across dozens of tasks: retrieval, classification, clustering, in different languages. How to read it:

| What to look at | Why |
|---|---|
| The **Retrieval** column, not the overall average | We need search, not classification |
| Language (multilingual / the customers' language) | Customers may ask in a language other than English, while manufacturers' product instructions are often in English — cross-lingual search is needed |
| Model size and dimension | A 7B model won't run fast on a laptop; 3072 dimensions = more space |
| Max tokens | How much text the model "sees" |
| License | Unimportant for a portfolio, important for a product |

The leaderboard is a reference point, not the truth: models can be "tuned" to the benchmark. The final decision comes only from our own mini-eval on our own data (which we will do in the practice).

### Semantic search without a database is simple

Let's put it all together: the model turns the texts and the question into vectors, normalization reduces the cosine to a dot product, numpy computes it for all texts at once.

```
texts    ──embed──► matrix M (N×d), normalized
question ──embed──► vector q (d), normalized
scores = M @ q  ──► argsort ──► top-k texts
```

This is "exact search" (brute force, flat index). For 100 or even 100,000 vectors it takes milliseconds. Vector databases (AIL-20) are needed for storage, metadata, filters, updates and approximate search (ANN: finds nearly nearest neighbors without comparing the query with every vector) over millions.

## DeepSeek and Ollama: how we do it

This is the chapter where the difference between providers matters most: **DeepSeek has no embeddings endpoint.** As of November 2026 (checked on November 13, 2026 against the [DeepSeek API Reference](https://api-docs.deepseek.com/api/create-chat-completion)), the API Reference section has Chat Completions, Responses, Messages (Anthropic format), FIM Completion, the model list, balance, files and built-in tools (search, URL reading, OCR, speech), but no embeddings. So `OpenAI(base_url="https://api.deepseek.com").embeddings.create(...)` won't work — we take generation from DeepSeek and do embeddings **locally**. This is a common situation: generation and embeddings often come from different vendors (Anthropic, as we have already seen, has no embedding model of its own either).

The main path in this book is two local options, both free and private:

1. **Ollama** — a local model server at `http://localhost:11434`. Embeddings are served by the native endpoint `POST /api/embed` and the OpenAI-compatible `POST /v1/embeddings`.
2. **Sentence Transformers** — the model is loaded straight into our Python process (what is already described above in "Theory").

### Installation (following the security rules)

- We install Ollama only from the official site [ollama.com/download](https://ollama.com/download) (instructions for Linux and Windows are there too). According to the [macOS documentation](https://docs.ollama.com/macos), it needs macOS 14 Sonoma or newer; on Apple Silicon both CPU and GPU work, models live in `~/.ollama` and take gigabytes. On macOS, before the app's first launch, we check the signature: `codesign -dv /Applications/Ollama.app` (who signed it) and `spctl -a -vv /Applications/Ollama.app` (Apple notarization).
- We take models from the official library (`ollama pull <name>`), and Sentence Transformers models only from official organizations on Hugging Face (`BAAI/...`, `sentence-transformers/...`, `intfloat/...` and so on).
- We pin library versions. At the time of checking, PyPI had `ollama==0.6.3` (released September 29, 2026) and `sentence-transformers==6.3.0`. We install a specific version, not "the latest", and don't take a release on the day it comes out.

### Which model to take

The [Ollama embedding models](https://ollama.com/search?c=embedding) page lists, among others, `bge-m3`, `embeddinggemma`, `qwen3-embedding`, `nomic-embed-text`, `mxbai-embed-large`, `snowflake-arctic-embed2`, `paraphrase-multilingual`. For questions in another language (e.g., Russian) against English texts (manufacturers' instructions), a multilingual model is needed. A sensible start is **`bge-m3`**:

| | `bge-m3` |
|---|---|
| Where | [ollama.com/library/bge-m3](https://ollama.com/library/bge-m3) (~1.2 GB download) and [huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) |
| Dimension | 1024 (per the Hugging Face card) |
| Input limit | 8192 tokens |
| Languages | 100+ |
| `query:`/`passage:` prefixes | Not needed (the card says plainly that query instructions are no longer required) |
| License | MIT |

Alternatives for comparison: `embeddinggemma` (300M parameters, ~622 MB download, 100+ languages, but a window of only 2K tokens, needs Ollama ≥ 0.11.10) and `qwen3-embedding:0.6b` (~639 MB, a 32K window, configurable dimension). Before using a model we read its card: prefixes and instructions differ between families.

### Code: Ollama (native library)

```python
# Illustrative: pip install ollama==0.6.3 ; ollama pull bge-m3
import numpy as np
import ollama

texts = ["can I return opened tea", "warranty for the Light desk lamp"]
res = ollama.embed(model="bge-m3", input=texts)   # a list -> one vector per text
M = np.array(res["embeddings"], dtype=np.float32) # shape (2, 1024)
print(M.shape, np.linalg.norm(M, axis=1))          # norms should be ~1.0
```

What matters about `/api/embed` (per the [API reference](https://docs.ollama.com/api/embed)):

- `input` takes a string or a list of strings — a batch in one request.
- Vectors come back **already L2-normalized** (each has length 1) ([embeddings page](https://docs.ollama.com/capabilities/embeddings)). We check the norms anyway.
- `truncate` defaults to `true`: text longer than the model's window is **silently truncated**. With `truncate=False` we get an error instead of silent truncation — exactly what we want for debugging chunking (chapter 4.3).
- `dimensions` shortens the vector (if the model supports it), `keep_alive` sets how long to keep the model in memory between requests.
- The response has `prompt_eval_count` (how many tokens were processed) and `load_duration` (how long loading the model took — the first call is slow).

### Code: Ollama through the OpenAI SDK

The same client as for OpenAI, only with a different `base_url`. Handy when we want to switch providers with one environment variable.

```python
# Illustrative: Ollama's OpenAI-compatible endpoint; the api_key is required by the SDK but ignored
from openai import OpenAI

local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
resp = local.embeddings.create(model="bge-m3", input=texts)
vectors = [item.embedding for item in resp.data]
```

According to the [OpenAI compatibility page](https://docs.ollama.com/api/openai-compatibility), `/v1/embeddings` supports `model`, `input` (strings and lists of strings, but not token arrays), `encoding_format` and `dimensions`; the `user` field is not supported.

### Code: the same model through Sentence Transformers

```python
# Illustrative: model card https://huggingface.co/BAAI/bge-m3
from sentence_transformers import SentenceTransformer

st = SentenceTransformer("BAAI/bge-m3")             # downloads once from Hugging Face
V = st.encode(texts, normalize_embeddings=True)    # numpy (N, 1024)
```

The same "bge-m3" in Ollama and in Sentence Transformers is different builds and different runtimes (Ollama packages the model in its own format). We don't treat their vectors as interchangeable until we check: we compute the cosine between vectors of the same phrase from both backends. The "one index, one model" rule extends to the backend too: in the metadata we store not only the model name but also where it came from (`ollama:bge-m3` or `st:BAAI/bge-m3`).

### Provider comparison for this chapter

| Capability | Claude (Anthropic) | OpenAI | DeepSeek | Ollama (local) |
|---|---|---|---|---|
| Embeddings endpoint | No; the documentation recommends the partner Voyage AI | Yes, `/v1/embeddings`, `text-embedding-3-*` models | **No** (as of November 2026) | Yes: `/api/embed` and `/v1/embeddings` |
| Shorten the vector | — | `dimensions` | — | `dimensions` (depends on the model) |
| Normalization | — | Vectors are normalized (per the OpenAI guide) | — | `/api/embed` returns L2-normalized ones |
| Cost | A separate bill from Voyage | Per token | — | Free, our machine does the work |
| Where texts go | To the Voyage cloud | To the OpenAI cloud | — | Nowhere, everything is local |
| Workaround | Ollama / Sentence Transformers | — | Ollama / Sentence Transformers | — |

For completeness: OpenRouter (chapter 2.4 · OpenRouter: one API for many models (AIL-69)) also provides embeddings via `POST https://openrouter.ai/api/v1/embeddings` (the documentation has examples with `openai/text-embedding-3-small` and others) — an option for "cloud embeddings without a separate OpenAI account". Free models there may train on input data, so they are suitable only for made-up or public texts.

### What to use in this chapter's practice

- **Main path:** Ollama (`bge-m3`) and Sentence Transformers — two local backends that we compare with each other. No API key needed at all.
- **For comparison (optional):** OpenAI `text-embedding-3-small`, if we already have a key — we'll see what a paid cloud model gives on our phrases.
- **Memory.** Embedding models are small, and even a machine with 8 GB of RAM has no trouble with them: `bge-m3` ~1.2 GB, `embeddinggemma` ~622 MB, `qwen3-embedding:0.6b` ~639 MB (download sizes from the Ollama library; in memory roughly the same plus a working buffer). But in the backend comparison one model lives in Ollama and the other in our Python process (Sentence Transformers), and together they take twice as much. We run the backends one at a time, and after a run we unload the Ollama model: `ollama ps` shows loaded models, `ollama stop <model>` unloads one. Large embedding models (`qwen3-embedding:4b`/`8b`) are not for 8 GB of RAM; with 16 GB or more they are worth a try.
- **DeepSeek doesn't take part in this chapter** — it has no embeddings. It will appear as the answer generator in chapters 5.1 and 5.3.
- **Security:** the phrases in this chapter are made up, and the shop's knowledge base is public. When it comes to customer data (support messages, names, phone numbers, order numbers, the shop database), embeddings and generation for it run only on Ollama, locally: these texts go neither to DeepSeek (servers in China) nor to other clouds.

## Learning path

1. Open the [NumPy quickstart](https://numpy.org/doc/stable/user/quickstart.html) → the sections "The Basics", "Basic Operations", "Indexing, Slicing and Iterating", "Broadcasting rules" (≈40 min). Pay attention to `shape`, `axis` and to the fact that `*` is element-wise multiplication and `@` is matrix multiplication. We type the examples by hand in the REPL.
2. [OpenAI: Embeddings guide](https://platform.openai.com/docs/guides/embeddings) → read it in full (≈25 min). Takeaways: which models exist now, their dimension and price (they change — check the page), the `dimensions` parameter, the note on vector normalization, the FAQ section on choosing a metric.
3. [Sentence Transformers](https://sbert.net) → Quickstart and the Semantic Search section; skim the Pretrained Models list (≈30 min). Takeaways: `model.encode(...)`, `normalize_embeddings`, the `util.cos_sim` utility, the difference between a bi-encoder (embeddings) and a cross-encoder (needed in AIL-22).
4. [MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard) → filter by the Retrieval task and multilinguality (≈20 min). Write down 2–3 small candidates (up to ~600M parameters) that have a card with instructions on prefixes. Open the card of the chosen model and read how to call it correctly.
5. Go over the linear algebra from "Theory" on paper: compute the cosine for `[1,0]` and `[1,1]` by hand (≈10 min). Answer: ≈0.707.
6. [Ollama: Embeddings](https://docs.ollama.com/capabilities/embeddings) and the [`/api/embed` reference](https://docs.ollama.com/api/embed) (≈20 min). Takeaways: a batch via a list in `input`, normalization, `truncate` (defaults to `true` — silent truncation), `dimensions`, `keep_alive`, the response fields `prompt_eval_count` and `load_duration`.
7. [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) → the `/v1/embeddings` section (≈10 min). Takeaway: which fields are supported — so that the same OpenAI SDK code talks to both OpenAI and Ollama.
8. The cards [ollama.com/library/bge-m3](https://ollama.com/library/bge-m3) and [huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) (≈15 min). Takeaways: dimension, input limit, whether prefixes are needed, license. Compare with 1–2 candidates from our MTEB list.
9. [DeepSeek API Reference](https://api-docs.deepseek.com/api/create-chat-completion) → run through the list of endpoints in the sidebar (≈5 min). We see for ourselves that there is no embeddings endpoint (as of November 2026) — and remember how to check such things: by the list of endpoints in the official reference, not by other people's articles.

## What to watch out for

- **Mixing models.** The index is built with one model, the query is embedded with another — search returns garbage without any errors. We store the model name next to the vectors.
- **Forgotten prefixes** for E5/BGE-like models — a silent loss of quality.
- **Unnormalized vectors + dot product** = search that prefers "long" vectors rather than similar ones. We normalize ourselves and check the norms.
- **Absolute similarity thresholds** ("if cos > 0.8, it's relevant") transfer poorly between models. We tune the threshold on our own data or use top-k.
- **float64 vs float32.** numpy creates float64 by default — twice the memory. float32 is enough for embeddings.
- **API cost and limits.** We don't embed the same thing twice: we cache the result on disk (`np.save`), keyed by a hash of the text + the model name.
- **Keys.** `OPENAI_API_KEY` comes only from the environment or `.env`, and `.env` is in `.gitignore`.
- **Short phrases vs long documents.** The embedding of a customer's question and the embedding of a knowledge-base paragraph live in slightly different "regions". That's normal and is partly solved in AIL-60 (HyDE).

## Practice

The project for weeks 4–5 is the `projects/02-support-kb-rag/` folder: a support assistant that answers customers from the shop's knowledge base. The knowledge base itself doesn't exist yet (its pages appear in AIL-19), so here we practice on a hundred short phrases in `projects/02-support-kb-rag/playground/`: we get embeddings with two local backends, write search in numpy and compare models.

- [ ] **Environment.** `uv init` (uv from chapter 1.3), then `uv add` installs (`uv.lock` pins the versions) `numpy`, `ollama`, `sentence-transformers`, `python-dotenv`, (optionally) `openai`, `scikit-learn`, `matplotlib`. Right away we add `.env` and `.venv/` to `.gitignore`. If we do the "for comparison" step with OpenAI, the `OPENAI_API_KEY` key goes only in `.env`.
- [ ] **Ollama.** Install the app from ollama.com (on macOS, check with `codesign -dv` and `spctl -a -vv` before the first launch), then `ollama pull bge-m3`. Check: `ollama list` shows the model, and `python -c "import ollama; print(len(ollama.embed(model='bge-m3', input='test')['embeddings'][0]))"` prints the dimension.
- [ ] **Data.** A `phrases.txt` file: 100 phrases about the shop, one per line, a mix of English and a second language — customer questions and lines from the knowledge base and product instructions. Groups by meaning (8–12 phrases each): delivery, returns, warranty, payment, promo codes, order status, product care and instructions, noise (empty reviews, greetings). Examples: "how long does a parcel take to Chicago", "opened tea and coffee cannot be returned", "¿dónde está mi pedido? el seguimiento no se actualiza", "do not use the lamp without the shade". These are made-up phrases — no real customer messages.
- [ ] **Embeddings through Ollama (main path).** `embed_ollama.py`: reads the phrases, embeds them in one or two batches via `ollama.embed(model="bge-m3", input=[...])`, saves `emb_ollama.npy` and `meta.json` (backend, model, dimension, date). A repeated run doesn't recompute if the file exists. The `load_duration` of the first call is printed separately from the rest of the time.
- [ ] **Embeddings through Sentence Transformers.** `embed_local.py`: the same with another multilingual model from our MTEB list (or with `BAAI/bge-m3`, to compare the backends), `normalize_embeddings=True` → `emb_local.npy`. Prefixes if the model requires them.
- [ ] **(For comparison, optional) Embeddings through a cloud API.** `embed_api.py`: OpenAI `text-embedding-3-small` → `emb_api.npy`. A repeated run doesn't call the API if the file exists.
- [ ] **DeepSeek check.** In one line in `compare.md` we record what we found in the DeepSeek API Reference about embeddings and why this provider is missing from the comparison table. No DeepSeek key is needed for this — we make no requests, the documentation is enough.
- [ ] **Search by hand.** `search.py`, ≤ 50 lines, without a vector database and without `util.cos_sim`:

```python
import numpy as np

def normalize(M: np.ndarray) -> np.ndarray:
    # TODO: divide each row by its L2 norm (use axis=1, keepdims=True)
    ...

def top_k(M: np.ndarray, q: np.ndarray, k: int = 5) -> list[tuple[int, float]]:
    # TODO: scores = M @ q, return k (index, score) pairs sorted by score desc
    ...
```

  We check that `np.allclose(np.linalg.norm(normalize(M), axis=1), 1.0)`. Run: `python search.py --backend ollama "can I return opened tea"` prints 5 phrases with scores (`--backend local` is Sentence Transformers, `--backend api` is the cloud model, if we connected it). The query is embedded with **the same** backend and model as the phrases.
- [ ] **Model comparison.** 10 queries; for each, we write down in advance which phrases are "correct". A table in `compare.md`: query → how many correct ones are in the top 5 for the Ollama model, for Sentence Transformers and (if connected) for the cloud API model, plus the time to embed 100 phrases (for Ollama, separately with and without model loading). We must include 2–3 queries in the second language against English phrases (a customer's question to a manufacturer's instructions) and the other way round.
- [ ] **(Optional) A 2D picture.** PCA from `sklearn.decomposition` down to 2 dimensions, a scatter plot, color = group. Expected: the groups form clouds, but they overlap — PCA loses a lot of information; this is an illustration, not a metric.

Expected result: all models find the "obvious" neighbors; differences show up on cross-lingual queries and on jargon ("COD", "pickup pt", "tracking #").

## Done when

- `search.py` in ≤ 50 lines searches by meaning with numpy, without a vector database.
- There are `emb_ollama.npy`, `emb_local.npy` (and, optionally, `emb_api.npy`) and a comparison table on 10 queries with a 2–3 sentence conclusion: which model and which backend we take for the project and why.
- We can explain why embeddings in this project are done locally and not at DeepSeek.
- We can explain why, for normalized vectors, cosine equals the dot product.
- The key didn't end up in git (`git status` doesn't show `.env`).

## Self-check quiz

1. What is an embedding, in one sentence?
2. Given vectors `a = [3, 4]` and `b = [6, 8]`, what is the cosine similarity? a) 0.5 b) 1.0 c) 0 d) 10
3. Why does search with normalized vectors come down to `M @ q`?
4. Can we search with a vector from the `text-embedding-3-small` model over an index built with a Sentence Transformers model of the same dimension? a) yes, if the dimension matches b) yes, after normalization c) no d) only with cosine
5. When do Euclidean distance and cosine give the same order of results?
6. What matters most to look at in MTEB for a RAG task over the shop's knowledge base, and why?
7. What is wrong with this code?
   ```python
   M = np.load("emb.npy")              # raw vectors from a local model
   q = model.encode("return policy")
   best = np.argsort(M @ q)[:5]
   ```
8. Why do some models need `query:` / `passage:` prefixes?
9. The embedding model was changed. What needs to be done with the index already built?
10. Why is a long text about five different topics hard to find by any one of them?
11. Which numpy data type is sensible for storing embeddings, and why? a) int8 always b) float64 c) float32 d) object
12. The code says `OpenAI(base_url="https://api.deepseek.com", api_key=...).embeddings.create(model=..., input=texts)`. What happens, and what is the right way to get embeddings in the "DeepSeek + Ollama" stack?
13. What does Ollama do by default with text longer than the model's window when `/api/embed` is called, and how do we turn this into an explicit error? a) returns an error b) silently truncates; `truncate=False` c) splits into chunks and averages d) switches to a model with a larger window
14. The index was built with Sentence Transformers (`BAAI/bge-m3`), and the queries are to be embedded through Ollama (`bge-m3`) — "it's the same model, after all". What needs to be done first?

## Answers

1. A fixed-length vector that a model outputs for a text so that texts similar in meaning get close vectors.
2. **b.** 1.0. `b = 2a`, the vectors point the same way; cosine doesn't depend on length.
3. Because `cos(a,b) = a·b / (||a||·||b||)`, and with unit norms the denominator equals 1; multiplying a matrix by a vector computes the dot product with all rows at once.
4. **c.** No. The spaces of different models are unrelated: a matching dimension is a coincidence, and closeness in them means nothing.
5. When the vectors are normalized: `||a−b||² = 2 − 2·cos(a,b)`, so the distance decreases monotonically as the cosine grows.
6. The Retrieval metrics and support for the needed languages (a customer's question in one language → a manufacturer's instructions in English), plus model size and token limit. The overall average mixes in tasks that aren't needed here.
7. Three errors: the vectors aren't normalized (dot product ≠ cosine); `argsort` sorts in ascending order, so `[:5]` gives the five **worst**, it should be `np.argsort(-scores)[:5]`; it isn't checked whether the model needs a prefix for the query.
8. The model was trained with different prefixes for questions and documents to better match short queries with long passages; without the prefixes the input doesn't look like the training data and quality drops.
9. Re-embed all documents with the new model and rebuild the index; store the model name next to the vectors so that such mismatches get caught.
10. An embedding is a single "compressed" representation of the whole text; it averages the topics, and the vector ends up between them, close to none.
11. **c.** float32: half the memory of float64, with no noticeable loss of search quality; int8 is already quantization, a separate lossy optimization.
12. An error: DeepSeek has no embeddings endpoint (as of November 2026 it isn't in the API Reference). DeepSeek is used for generation, and embeddings are done locally — `ollama.embed(...)`, Ollama's `/v1/embeddings` or Sentence Transformers.
13. **b.** By default `truncate=true`, and the excess is silently cut off — a piece of the text simply doesn't take part in search. With `truncate=False` too long an input causes an error, and we learn about the chunking problem right away.
14. Check that the vectors match (the cosine between vectors of the same phrases from both backends is close to 1), or, more reliably, embed the index and the queries with one backend. The builds and runtimes differ, so the metadata stores both the model and the backend.

## What's next

In [AIL-59 · How RAG works: an architecture overview](AIL-59.md) we will see where this search fits in the full RAG pipeline, and in [AIL-19 · Chunking](AIL-19.md) how to split the shop's knowledge base so that embeddings work.
