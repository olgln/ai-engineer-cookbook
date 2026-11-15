# 4.3 · Chunking: comparing 3 strategies  (AIL-19)

> **Week 4** · RAG · ⏱ ~4 h · Practice

<!-- description: Chunking for RAG: fixed size, overlap and splitting by headings. We compare the strategies on our own knowledge base by hit rate@k. -->
<!-- source-sha256: a542c10d3ca5 -->

## Why an AI engineer needs this

Bad chunking is the number one reason RAG finds the wrong thing. It is the first thing an experienced engineer checks when "RAG answers nonsense", and a common interview question: "how would you chunk PDF contracts / a support knowledge base / tickets?" There is no correct answer like "512 tokens"; what exists is the skill of comparing strategies on our own data, and that is what we learn here. Along the way, this chapter brings in the first pages of the Shelf shop's knowledge base, the corpus the whole second project runs on.

## Theory

### What a chunk is and why its size is a trade-off

In the RAG pipeline from AIL-59, chunking sits between loading documents and computing embeddings: before searching, a knowledge base page has to be cut into pieces. A chunk is a piece of a document that is embedded separately, searched separately and put into the prompt separately. Chunk size pulls in two directions:

| Small chunk (100–200 tokens) | Large chunk (1000–2000 tokens) |
|---|---|
| The embedding is precise, about one idea | The embedding is "blurred" across several topics |
| Context is lost: "the period is 14 days" — the period of what? | The context is in place |
| Little extra text gets into the prompt | A lot of noise gets into the prompt, more expensive |
| More pieces are needed to assemble an answer | One piece often contains the whole answer |

For reference texts and documentation, a reasonable starting point is 300–800 tokens, but we find the exact number by experiment. It is important to remember the embedding model's input limit (AIL-18): a chunk longer than that is silently truncated.

Tokens ≠ characters. For English text, roughly 1 token ≈ 4 characters; for non-English text (e.g. Russian) and code it differs. For the experiment, counting in characters is enough (that is how we set sizes in the practice), but the model's limit is more accurately checked with a tokenizer (for example, `tiktoken` for OpenAI models; the tokenizers of our models are covered below, in the section on DeepSeek and Ollama).

Next come the three strategies we compare in the practice, from the simplest to the "smartest"; each one fixes the main weakness of the previous one.

### Strategy 1: fixed size

We cut every N characters (or tokens). Simple, fast, predictable.

```python
def fixed_chunks(text: str, size: int = 1500) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)]
```

The problem: the cut lands anywhere — in the middle of a sentence, in the middle of a rate table, in the middle of a code block. A fact cut in half is found by neither half. The first idea that comes to mind is to make neighboring pieces overlap.

### Strategy 2: fixed size with overlap

A window of size N moves by a step of N − overlap. Each piece captures the tail of the previous one, so a fact on the boundary ends up whole in at least one chunk.

```
text:    |----------------------------------------------|
chunk 1: |==========|
chunk 2:       |==========|
chunk 3:             |==========|
               ^^^^^ overlap
```

A typical overlap is 10–20% of the size. The price is more chunks (more embeddings, more storage) and duplicates in the results: two neighboring chunks with a shared piece both get into the top 3 and push out something useful. An improvement: cut not strictly by characters but at the nearest paragraph or sentence boundary (that is how `RecursiveCharacterTextSplitter` in LangChain works: it first tries `\n\n`, then `\n`, then a space). Even so, the strategy doesn't know where a section or a table ends. The document's author knows that, and left a hint in the headings.

### Strategy 3: by structure (headings)

Documentation and a knowledge base are already marked up by the author: the headings `#`, `##`, `###` separate topics. We cut along them, and each section becomes a chunk. If a section is too long, we split it further by subheadings or paragraphs; if it is too short, we merge it with a neighbor.

The main bonus is the **heading path** (breadcrumbs) as metadata and as a text prefix:

```
Delivery > Courier within the US > Rates by weight and zone

| Weight, kg | Zone 1 | Zone 2 | Zone 3 |
| up to 1    | $2.90  | $3.90  | $4.90  |
| 1–3        | $3.50  | $4.70  | $5.90  |
```

The first line is the heading path of the section the table sits in. Without it, the table is just numbers; with it, it is the shop's courier delivery rates by weight and zone. In the same way, the path `Light Mini Lamp > Warranty` keeps the section from being confused with the warranty on the similar Light Lamp. This is a cheap version of the Contextual Retrieval idea from AIL-59: context is attached to the chunk without any LLM.

A sketch:

```python
import re

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")

def heading_chunks(md: str, url: str) -> list[dict]:
    chunks, path, buf = [], [], []

    def flush():
        body = "\n".join(buf).strip()
        if body:
            chunks.append({"text": " > ".join(path) + "\n\n" + body,
                           "section": " > ".join(path), "url": url})
        buf.clear()

    for line in md.splitlines():
        m = HEADING.match(line)
        if m:                                 # TODO: ignore '#' lines inside ``` code blocks
            flush()
            level = len(m.group(1))
            path[:] = path[:level - 1] + [m.group(2).strip()]
        else:
            buf.append(line)
    flush()
    return chunks
```

Note the `TODO`: inside code blocks (bash, Python), lines starting with `#` are comments, not headings. We need to track whether we are inside ` ``` `. There are few code blocks in `kb/`, but the splitting must work on any Markdown: in API documentation and READMEs they are everywhere. The second detail is front matter at the start of the file (`---` … `---`, the page's metadata block): it is not text for search, so we cut it off before splitting and put it into the metadata. The third is an explicit anchor at the end of a heading (`## Returning opened tea {#opened-tea-returns}`; we put such anchors on the `kb/` pages in the practice): it is not part of the heading path, so we cut it off and keep it for linking to the section.

### Other strategies (worth knowing they exist)

The three strategies above cover most cases; the rest are worth knowing by name.

- **Semantic chunking** — cut where the embeddings of neighboring sentences diverge sharply. Expensive and not always better than structure, especially when the structure is already there.
- **Parent-child (small-to-big)** — search over small chunks but put their large parent section into the prompt. Combines precise search with full context.
- **Contextual enrichment** — an LLM writes an explanation for the chunk (Contextual Retrieval, AIL-22).
- **Document-specific** — code is cut by functions, tables by rows with the table header repeated, FAQs by question-answer pairs.

### Tables and code are a special case

Whatever strategy we choose, there are pieces of text that must not be cut. In the shop's knowledge base the most valuable parts are the delivery rate tables and warranty period tables, the lists of return conditions and the FAQ; in technical documentation, parameter tables, error codes and code examples. The rules:

1. **Never cut a code block or a table in the middle.** We treat them as "atoms": a strategy may move the boundary before or after them.
2. If a table is huge (rates for a hundred cities, a list of 300 error codes), we cut it by rows, **repeating the table's header row** and the section path in every piece.
3. A long example (a JSON response in API documentation, the full text of the terms of sale) can be shortened or moved out: it bloats the chunk, and people usually search by the description.

### Chunk metadata

Along with the text, each strategy returns metadata, which is later used to filter search and build links. The minimum we need from here on (`chunk_key`, `doc_hash` and `loaded_at` from the table in AIL-59 are added together with the index in AIL-20):

| Field | Example | Why |
|---|---|---|
| `category` | `returns` | Filtering (AIL-20, AIL-60) |
| `url` | `kb/returns.md#opened-tea-returns` (file + section anchor) | Citations in the answer (AIL-23) |
| `section` | `Returns > Returning opened tea` | Context, debugging, display |
| `archived` | `false` | Archived pages are excluded from search by default (AIL-20) |
| `chunk_index` | `12` | Order, neighboring chunks |
| `strategy` | `headings` | For this task's experiment |

### How to compare strategies: hit rate@k

What remains is deciding how to tell which strategy is better. The metric for this task is **hit rate@3**: for each question in the golden set (a set of questions with known answers; we started its draft in `notes/rag.md` in AIL-59), check whether the piece with the correct answer got into the top 3 of the search. How do we define the "correct piece" if the strategies produce different chunks? Not by chunk id but by the **key strings of the answer**: for each question we record substrings that must be in the right piece (for example, `"opened"` + `"not accepted"`, or `"1–3"` + `"$4.70"`). A hit = at least one of the top 3 contains all the key substrings. It is crude, but honest and the same for all strategies.

```python
def hit(top_texts: list[str], must_contain: list[str]) -> bool:
    return any(all(s.lower() in t.lower() for s in must_contain) for t in top_texts)
```

Important: the larger the chunk, the easier it is for it to "contain" the key string, so large chunks get a head start. That is why, next to hit rate, we print the average chunk size and the number of chunks, and compare strategies at comparable sizes.

## DeepSeek and Ollama: how we do it

Chunking is pure Python; the provider hardly matters here. Three small things change.

**1. Embeddings for the experiment are local.** We use the backend chosen in chapter 4.1 · Embeddings by hand with numpy (AIL-18): Ollama `bge-m3` or a Sentence Transformers model. DeepSeek is not needed for search: it has no embeddings. It is useful only for drafts of `kb/` (the texts are fictional and public, so showing them to a cloud model is fine). Running three strategies over 10–20 pages means several thousand embeddings, and locally they are free. A disk cache is still needed, for speed.

**2. Silent truncation.** In Ollama's `/api/embed`, the `truncate` parameter defaults to `true`: a chunk longer than the model's window is truncated without an error, and the tail of the chunk (often exactly the rate table) takes no part in the search. Models have different windows: `bge-m3` has 8192 tokens, `embeddinggemma` 2K (according to the model pages in the Ollama library, November 2026). For this chapter we turn on strict mode:

```python
# Illustrative: fail loudly instead of silently cutting a long chunk
import ollama

def embed_strict(texts: list[str], model: str = "bge-m3") -> tuple[list[list[float]], int]:
    res = ollama.embed(model=model, input=texts, truncate=False)  # error if a text is too long
    return res["embeddings"], res["prompt_eval_count"]            # vectors + tokens processed
```

**3. We count tokens with our model's tokenizer.** `tiktoken` counts tokens for OpenAI models. DeepSeek, `bge-m3` and other models have their own tokenizers, so the numbers will differ. Options: the `prompt_eval_count` field in Ollama's response (how many tokens the model actually processed) or the model's tokenizer in Sentence Transformers (`len(model.tokenizer(text)["input_ids"])`). Characters are enough for comparing strategies, but we check the model's limit in tokens.

| What matters for chunking | Claude | OpenAI | DeepSeek | Ollama / Sentence Transformers |
|---|---|---|---|---|
| Embeddings for the experiment | None of its own | `text-embedding-3-*` | No | Yes, locally |
| Token counting | Token counting endpoint (see the docs) | `tiktoken` | Its own tokenizer; actual tokens in the response's `usage` | `prompt_eval_count` in Ollama; `model.tokenizer` in ST |
| Input too long | — | Request error | — | Ollama silently truncates by default (`truncate=true`) |

For the practice, the main path is Ollama or Sentence Transformers. A cloud embedding model (OpenAI) is only "for comparison", if we want to see whether it changes the winner among the strategies.

## Learning path

1. Open [Pinecone: Chunking strategies](https://www.pinecone.io/learn/chunking-strategies/) → read it in full (≈35 min). Pay attention to: which factors affect the choice of size (content type, embedding model, query length), fixed-size vs content-aware, Markdown splitting, and the section on choosing the size by experiment.
2. Reread the "Contextual Retrieval" section in chapter [AIL-59](AIL-59.md) and the introduction of the [Anthropic article](https://www.anthropic.com/news/contextual-retrieval) — an example of the "chunk without context" problem (≈10 min). Compare it with the breadcrumbs idea.
3. Open the help center of any online shop or delivery service: the delivery, returns and warranty policies, a product page with a FAQ (≈15 min). Look at how the pages are built: headings, rate tables, lists of conditions, questions and answers. Write down what will be "atoms"; this is also useful for the `kb/` brief.
4. (Optional) Look at the source of a popular splitter — for example, `RecursiveCharacterTextSplitter` or `MarkdownHeaderTextSplitter` in the LangChain documentation — to see how they solve the same problems (≈15 min). We don't add the library; we write our own.
5. Open the [Ollama `/api/embed` reference](https://docs.ollama.com/api/embed) → the `truncate` parameter and the `prompt_eval_count` field (≈5 min), then the context window of the chosen model on its page in the [Ollama library](https://ollama.com/search?c=embedding) (≈5 min). Write down the maximum chunk size in tokens that the model sees in full.

## What to watch out for

- **`#` in code blocks** breaks heading-based splitting — a classic bug.
- **Cut tables**: half of a rate table without the column headers (weight, zone) is useless.
- **Navigation and junk**: if a page from a website gets into the corpus (an optional step in AIL-20) and after the HTML → Markdown conversion every chunk contains the site menu, all chunks become similar to each other and search degrades. First we check by eye that the text is clean.
- **Empty and micro chunks** ("## Questions and answers" with nothing under it) clutter the results. Short sections are merged with a neighbor or thrown away.
- **Duplicates from overlap** in the top 3: neighboring pieces push out other candidates. The results can be deduplicated by adjacency.
- **Repeated blocks** on every page (a "Still have questions? Contact support" paragraph under every product, examples in five programming languages under every endpoint in API docs) bloat chunks and make them alike. We keep one copy or move them out.
- **Corpus traps**: an archived return policy and similar products give a confident but wrong answer. Without `archived` and breadcrumbs with the product name, they can't be told apart.
- **An unfair comparison**: different chunk sizes across strategies → the large ones win simply by size. We bring them to comparable sizes.
- **A golden set tailored to one strategy.** We write the questions before looking at the results and phrase them the way a customer would, not as a copy of a heading.

## Practice

We work in `projects/02-support-kb-rag/experiments/chunking/`. We use the embeddings and search from AIL-18 (numpy, no database). The embedding backend is local (Ollama or Sentence Transformers); a cloud model is needed only for the `kb/` drafts.

- [ ] **Data: the first `kb/` pages.** We write a short brief, `projects/02-support-kb-rag/kb-brief.md`: the Shelf shop, delivery services and zones, rates by weight and zone, the free delivery threshold, payment methods, return rules (14 days; opened tea and coffee are not accepted), warranty by category, 4–6 products. From the brief, a model generates drafts (the texts are fictional, so DeepSeek will do), and we edit them by hand: the numbers match the brief, the headings are meaningful, no filler. We put 10–20 pages into `projects/02-support-kb-rag/kb/`: `delivery.md`, `payment.md`, `returns.md`, `warranty.md`, `orders.md`, `promo.md` and a few pages in `products/`. Each file starts with front matter:
  ```markdown
  ---
  title: Returns
  category: returns
  updated: 2026-09-01
  ---

  # Returns

  ## Returning opened tea {#opened-tea-returns}
  ```
  We give section headings explicit `{#...}` anchors in Latin characters right away: answers will link to a specific section through them (`kb/returns.md#opened-tea-returns`), and they don't change when a heading is reworded. Built-in difficulties (the next chapters rely on them, so we don't simplify): in `delivery.md`, a table of rates by weight and zone; in `warranty.md`, a table of warranty periods; `returns-2025.md`, an old version of the return rules with different conditions and `archived: true`; `products/lamp-light.md` and `products/lamp-light-mini.md`, similar lamps with different warranties. The remaining pages and traps (up to 30–50 pages) are added in AIL-20.
- [ ] **Golden set.** `golden.jsonl`, 10 lines: we take the questions from the draft in `notes/rag.md` (AIL-59) and add key strings to each one. The format:
  ```json
  {"q": "can I return tea if the pack has already been opened", "must_contain": ["opened", "not accepted"], "category": "returns"}
  ```
  The questions are in our own words, written the way a customer would write them. The key strings come from our own `kb/` text. Among the questions there is at least one about the rate table, one about the Light Mini warranty and one that the archived page can "answer".
- [ ] **Three strategies** in `strategies.py`:
  1. `fixed(text, size=1500)`;
  2. `overlap(text, size=1500, overlap=250)` aligned to paragraph boundaries;
  3. `headings(md, url)` with breadcrumbs, handling of code blocks and front matter, and merging of sections shorter than ~200 characters; if a section is longer than ~3000 characters, we split it by paragraphs without breaking tables and code.
- [ ] **The run.** `run.py`: for each strategy, we chunk `kb/`, embed (caching the embeddings on disk by the hash of the text + the model name), run the 10 questions, and compute hit@3 and hit@1. We also print the number of chunks and the average size.
- [ ] **Length check.** If we embed through Ollama, we call it with `truncate=False` and save `prompt_eval_count`. We print how many chunks of each strategy hit the model's limit (there should be none for `fixed 1500`; for `headings` without splitting long sections, there may be some).
- [ ] **(For comparison, optional)** We rerun the best and the worst strategy with a cloud embedding model (OpenAI). Does the order of the strategies change?
- [ ] **Results table** in `RESULTS.md`:

  | Strategy | Chunks | Avg. size, chars | hit@3 (out of 10) | hit@1 |
  |---|---|---|---|---|
  | fixed 1500 | | | | |
  | overlap 1500/250 | | | | |
  | headings | | | | |

- [ ] **Miss analysis.** For each miss of the best strategy, we write one line: why (the piece was cut, no context, junk, a colloquially phrased question, the archived page or a similar product was found). This is the task list for AIL-60 and AIL-22.
- [ ] (Optional) We repeat with sizes 800 and 2500 for fixed, and the size/accuracy trade-off becomes visible in the numbers.

Expected result: structural chunking with breadcrumbs usually wins on a structured knowledge base, and overlap is slightly better than plain fixed. If it turns out otherwise, that is not a mistake but a finding: we figure out why and write it down.

## Done when

- `kb/` has 10–20 pages with front matter, including the rate table, the archived return policy and a pair of similar products.
- There is a `RESULTS.md` with a table: strategy → how many of the 10 questions found the correct piece in the top 3, plus the number and average size of chunks.
- There is a miss analysis and a conclusion: which strategy we take into the AIL-20 index and with which parameters.
- No table and no code block is cut in half by the `headings` strategy (spot-checked by eye on 5 chunks).

## Self-check quiz

1. What is the downside of chunks that are too small, and of chunks that are too large?
2. What is overlap for, and what does it cost?
3. What are a chunk's breadcrumbs, and how do they help search?
4. Why must a rate table not be cut in half, and what should be done with a very long table?
5. What is wrong with this heading-splitting code?
   ```python
   for line in md.splitlines():
       if line.startswith("#"):
           flush()
           path = [line.lstrip("# ")]
       else:
           buf.append(line)
   ```
6. The hit@3 metric is: a) the share of questions where the correct piece is in first place b) the share of questions where the correct piece is in the first three c) the average similarity of the top 3 d) the share of correct LLM answers
7. When comparing strategies, why look at the average chunk size and not only at hit rate?
8. What is parent-child (small-to-big) chunking?
9. Why does site navigation junk in every chunk make search worse?
10. All three strategies got hit@3 = 10/10. What is most likely wrong with the experiment?
11. Chunk size is counted with `tiktoken`, and embeddings are computed with Ollama `bge-m3`. What is wrong with these numbers, and how can the real number of tokens be found?
12. The `headings` strategy produced chunks of 4000 tokens; embeddings are computed with `embeddinggemma` through Ollama with default parameters. There are no errors, but the rate tables at the ends of sections are not found. Why?

## Answers

1. Small chunks lose context ("the period is 14 days" — the period of what?); large ones give a blurred embedding and a lot of noise in the prompt.
2. So that a fact on a cut boundary ends up whole in at least one chunk. The cost is more chunks (embeddings, storage) and duplicate neighboring pieces in the results.
3. The section's heading path (`Delivery > Courier within the US > Rates by weight and zone`), attached to the text and to the metadata. It gives the chunk back its context: the page, the topic, the product, and both the embedding and BM25 start to take it into account.
4. Half a table without the column headers and the section name is meaningless: the row "1–3 | $3.50 | $4.70" doesn't say that these are kilograms, zones and courier delivery. A long table is cut by rows, repeating the table's header row and the section path in every piece.
5. Three problems: `#` lines inside code blocks (comments) are taken for headings; the heading level is ignored, so the path always has a single element and the hierarchy is lost; `lstrip("# ")` strips both the hashes and the spaces from the start, which is tolerable, but the level has to be counted before that.
6. **b.**
7. A large chunk "contains" the key string more easily and wins by size rather than by the quality of the splitting; it is also more expensive in the prompt. The comparison is fair only at comparable sizes.
8. Search runs over small, precise chunks, while their whole parent section goes into the prompt: search precision plus full context for the answer.
9. The same text in every chunk makes their embeddings similar to each other and shifts them toward the "menu topic", so the differences between sections are smoothed out.
10. The golden set is too easy (the questions almost copy the headings, or the key strings are too generic), or the `must_contain` check is too lenient; we need questions phrased the way a user would phrase them and more specific key strings.
11. `tiktoken` is the tokenizer of OpenAI models; `bge-m3` has its own tokenizer, and the number of tokens will be different. The real number is `prompt_eval_count` in the `/api/embed` response or the model's tokenizer (`model.tokenizer` in Sentence Transformers).
12. `embeddinggemma` has a 2K-token window, and `/api/embed` by default (`truncate=true`) silently truncates long input: the tail of the section with the table never made it into the embedding. The fix is splitting long sections, a model with a larger window (`bge-m3` has 8192) and `truncate=False`, so that such cases fail with an error.

## What's next

The chosen strategy goes into a real index: [AIL-20 · A vector database + loading the knowledge base](AIL-20.md) — the whole `kb/` knowledge base (30–50 pages, hundreds of chunks), metadata and filters.
