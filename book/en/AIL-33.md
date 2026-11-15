# 8.3 · An experiment: choosing the model and a reranker for RAG  (AIL-33)

> **Week 8** · Evals · ⏱ ~4–5 h · Project

<!-- description: Choosing an LLM by the numbers: a 2×2 experiment with a reranker, quality vs cost and latency, reading leaderboards, avoiding judge self-preference. -->
<!-- source-sha256: 715aec16db87 -->

## Why an AI engineer needs this

Choosing a model is a decision an engineer makes all the time, and the answer is almost never "the strongest one". The task is to find a configuration that is good enough at an acceptable cost and latency. The interview question "how did you choose the model?" expects an answer with numbers: "a small model with a reranker gives the same correctness within the noise, 5 times cheaper and twice as fast".

## Theory

### Three axes: quality, cost, speed

In [AIL-32](AIL-32.md) we changed how the assistant searches. Now we fix the winning index and change two things around it: the model that writes the answer and the reranker between retrieval and the model. Comparing configurations by quality alone is not enough here: each one has three numbers:

- **quality**: correctness, faithfulness, hit@k on our set `eval/golden.jsonl`;
- **cost**: the cost of 100 questions (the system only, without the judge);
- **speed**: p50 and p90 latency from the question to the finished answer.

They usually pull in different directions. The task is not to maximize one of them but to find the **Pareto front**: the configurations where one axis can't be improved without making another worse. Anything worse than some other configuration on every axis is discarded right away.

```
 quality
   ▲
   │                 ● large + reranker
   │         ● small + reranker
   │                        ● large
   │   ● small
   │                                  ✕ large, long prompt (worse and more expensive)
   └──────────────────────────────────────► cost
```

### Requirements first, then the choice

The Pareto front usually holds several points, and only requirements can choose among them. Without requirements there is no choice: the "best" configuration depends on what matters. We write them down before the experiment, as product requirements for the support assistant of the Shelf shop:

- **quality threshold**: correctness no lower than the baseline minus the spread; faithfulness ≥ 0.9 (a support assistant must not invent return periods, delivery rates or warranties); `archived_in_context` = 0;
- **budget**: for example, no more than $X per 1000 questions;
- **latency**: p90 no more than N seconds (a Telegram bot, the customer is waiting).

The selection rule: **the cheapest (or fastest) configuration that passes the quality threshold**. This turns the argument "which model is better" into a check of conditions.

### How to read external leaderboards

The requirements are written down; now we need candidates. Running the full eval on a dozen models is expensive, so we build the shortlist from external leaderboards.

**[Artificial Analysis](https://artificialanalysis.ai)** compares models by aggregated quality benchmarks, price per token and speed (time to first token, tokens per second) across providers. Useful for **a shortlist of candidates** and for the order of magnitude of prices and speed.

**[LMArena](https://lmarena.ai)** is a leaderboard built from pairwise blind votes by people in a chat. It reflects which answers people like in a general conversation; style, length and formatting affect it.

Neither answers our question: how the model performs **on our task** (answering from the retrieved chunks of the `kb/` knowledge base, with citations, with a refusal when there is no answer). A model that leads a leaderboard may follow the instruction "answer only from the knowledge base" worse and invent things more often. Leaderboards are for choosing candidates; our own eval is for the decision.

### What cost is made of

Leaderboards give cost and speed only as orders of magnitude: per token and on someone else's hardware. For the decision we measure both axes ourselves, on our own pipeline, and for that we need to understand what they are made of.

```
cost per question = Σ over calls: input_tokens × price_in + output_tokens × price_out
```

In RAG the main contribution comes from **input tokens**: the system prompt plus k context chunks. Therefore:
- k=10 versus k=5 almost doubles the cost of an answer;
- a reranker that cuts 20 candidates down to the best 4 can **reduce** the cost of generation, even if it costs money itself;
- prompt caching reduces the cost of the repeated part (the system prompt), but not of the chunks, which differ for each question;
- query rewriting from [AIL-60](AIL-60.md) is one more model call, and it counts too.

We take prices from the providers' pricing pages on the date of the experiment (they change, and models from the same provider differ several times over) and record the date in the log. We name models by their exact identifiers from the documentation.

### What latency is made of

```
latency = rewrite + retrieve + rerank + (time to first token + output_tokens / tokens_per_sec)
```

- Small models are usually faster both in time to first token and in generation speed.
- A cross-encoder reranker on a CPU can take noticeable time for 20 pairs; an API reranker adds a network call.
- A long answer is slower: output tokens are expensive both in price and in time.
- API latency is noisy depending on the time of day. We measure the variants interleaved, not "A in the morning, B in the evening".

If the product streams the answer (as chats usually do), the time to first token matters more to the customer; for batch scenarios, the total time does.

### The reranker: what it changes

The second factor of the experiment affects all three axes at once. How a reranker works (cross-encoder versus bi-encoder) is covered in [AIL-22](AIL-22.md): retrieval picks many candidates, the reranker model scores each "question–chunk" pair and keeps the best ones. What matters here is what it changes in experimental terms:

- **Retrieval**: a wide selection (top 20/30 by hybrid search), then the reranker picks the top k. MRR and hit@3/hit@5 grow with the same final context length.
- **Generation**: the model gets a more precise context with fewer distracting chunks (for example, the Light Lamp warranty instead of the needed Light Mini Lamp one). This usually helps a small model more than a large one, because it is worse at ignoring junk in the context. This is a hypothesis, and it is what we test.
- **Cost/speed**: a local reranker costs nothing in money but costs time; an API reranker is the other way round.

A local cross-encoder via Sentence Transformers (illustrative):

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("BAAI/bge-reranker-v2-m3")  # multilingual; English ms-marco models are smaller but fail on Russian

def rerank(question: str, chunks: list[dict], top_k: int) -> list[dict]:
    ranked = reranker.rank(question, [c["text"] for c in chunks])  # sorted by score
    return [chunks[r["corpus_id"]] for r in ranked[:top_k]]
```

We take language into account: many popular cross-encoders (`cross-encoder/ms-marco-*`) are trained on English, while customers also ask in other languages (e.g. Russian). We check the slice by the `ru`/`en` tags of the set.

### Experiment design: 2×2

What remains is to combine both factors in one experiment. Two factors (the answer model, the reranker) give four configurations:

| | without reranker | with reranker |
|---|---|---|
| small model | S | S+R |
| large model | L | L+R |

This is better than two separate pairs because it shows the **interaction**: for example, the large model barely needs the reranker, but it helps the small one a lot. Then S+R may end up on the Pareto front.

Fixed in all four: the index (the best one from [AIL-32](AIL-32.md)), the answer prompt, the judge, the set, k at the model's input.

**The judge doesn't change.** If the judge is from the same family as one of the candidate models, we account for self-preference (from [AIL-27](AIL-27.md)): we check against our own labels whether there is a bias.

**The answer prompt** may suit different models differently. The fair option is one prompt for all; if the small model clearly breaks the format (for example, doesn't put links to `kb/`), that is a result, not a reason to quietly tweak the prompt for it alone. Tuning the prompt per model is a separate experiment.

### Counting and presentation

The `eval/run.py` script from [AIL-29](AIL-29.md) already records `usage` and latency per question, and aggregates in `summary.json`. The experiment needs a summary table:

| Config | hit@5 | correctness | faithfulness | $ / 100 questions | p50, s | p90, s |
|---|---|---|---|---|---|---|
| S | | (spread) | | | | |
| S+R | | | | | | |
| L | | | | | | |
| L+R | | | | | | |

Plus paired comparisons of the key pairs (L versus S+R, S versus S+R) by the significance rule from [AIL-62](AIL-62.md). A useful chart is a scatter plot of "quality versus cost" with labeled points: the Pareto front is visible on it at once.

### The recommendation

The table and the chart are material, not the answer: whoever makes the decision expects one configuration and its cost. The final product of the task is a recommendation of 5–8 sentences, for example in this form:

> For production we take S+R: correctness 0.8x (spread ±0.02), within the noise of L+R (disagreements 5/4, p ≈ 1), faithfulness 0.9x, N times cheaper ($a versus $b per 100 questions), p90 latency x s versus y s. The reranker gave the small model +Z pp correctness (disagreements 10/2), the large one within the noise. Limitations: a dev set of 56 questions, small differences can't be told apart; on comparative questions (n=8) L+R looks better, to be checked on an extended set. The final number on the holdout: …

"Disagreements 5/4" means, as in [AIL-32](AIL-32.md): 5 questions where one configuration won and 4 where the other did. Here we also run the final chosen configuration on the **holdout** for the first time (once): that is the honest number that goes into the README.

## DeepSeek and Ollama: how we do it

On our stack this experiment becomes the most interesting one in Project 3: **a local model versus DeepSeek**, with and without a reranker. The question is not academic. The set and `kb/` are public and fictional, so they can go to the cloud; but real customer messages with a phone number, email or order number are sent by `contains_personal_data` from [AIL-23](AIL-23.md) only to the local model (or to an operator). The experiment shows how much quality this privacy costs: whether the local model answers such messages well enough or it is more honest to hand them to a human right away. Checked in November 2026 against [api-docs.deepseek.com](https://api-docs.deepseek.com), [docs.ollama.com](https://docs.ollama.com) and [ollama.com/library](https://ollama.com/library); we verify model IDs, prices and tags before the experiment.

### Candidates by memory size

The "small" model is defined by the memory of the machine where the local answerer will run, together with `bge-m3` and the reranker:

| Role in the 2×2 design | Model | Comment |
|---|---|---|
| S (small) | a local 4B-class model in Ollama, the course default `qwen3:4b` (weights ≈2.5 GB per the model page, November 2026) | fits even in 8 GB next to the embeddings and the reranker; free; customer messages never leave the machine. We write the tag explicitly: plain `qwen3` is `qwen3:8b` (≈5.2 GB) |
| L (large) | `deepseek-flash`, thinking off | cheap, 1M context, faster on long context than a local model on an ordinary laptop |
| (optional) L+ | `deepseek-v4-pro` or `deepseek-flash` with thinking | what an even stronger model or reasoning gives and what it costs |
| (for comparison) | one Claude and/or OpenAI model | on the same public questions: where DeepSeek sits on the Pareto front relative to the market |

By memory: 8 GB means 3–4B models, and S stays `qwen3:4b`; 16 GB means 7–8B, and `qwen3:8b` can be added as a separate point S′; 32 GB and more means 14B and larger. The main S is `qwen3:4b` on any machine, so that the result is reproducible; a larger local model is a separate run, and its latency is not mixed with the rest. **Before local runs we close everything unnecessary** (a browser with dozens of tabs, an IDE that is indexing, Docker): the model, the reranker and other programs share memory, and when it runs short we get a latency that measures swapping, not the model.

The configs for `eval/run.py --config eval/configs/<name>.json` differ only in the model and the reranker (`retrieve_k` is a new key: how many hybrid search candidates go to the reranker):

```json
{"index": "index_headings.db", "rewrite": true, "retriever": "hybrid", "retrieve_k": 20, "k": 5,
 "reranker": "BAAI/bge-reranker-v2-m3", "answer_model": "qwen3:4b", "answer_thinking": false,
 "answer_prompt": "answer_v2", "judge_model": "deepseek-v4-pro", "judge_prompt": "judge_v2"}
```

This is `eval/configs/s_rerank.json`; `s.json` is the same with `"reranker": null`, and `l.json` and `l_rerank.json` have `"answer_model": "deepseek-flash"`. The index, the prompt and `k` come from the winner of [AIL-32](AIL-32.md). The run folder name `eval/runs/<timestamp>_<index>_<retriever>_k<k>/` doesn't contain the model, so we tell S and L apart by `config.json`.

### The judge doesn't change, and this is exactly where self-preference is dangerous

The judge in all configurations is `deepseek-v4-pro` without thinking (chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md)). A local 4B model can't be the judge: it is weaker than both answerers. But a judge from the DeepSeek family comparing a DeepSeek answer with a qwen answer is exactly the case where self-preference distorts the "S versus L" conclusion. Therefore:

- the questions where S and L disagreed (usually 10–20) we label ourselves, without looking at the judge's verdicts, and compute the judge's agreement on these questions separately;
- (optional) we run a judge from another family, Claude or OpenAI, on the same questions (the data is public).

If the judge systematically rates DeepSeek higher than our labels do, that is a result: it goes into the log rather than being hidden.

### A fair comparison: context, warm-up, queue

A cloud model and a local one have different traps, and each can "hand" the victory to the wrong side:

1. **Context.** With less than 24 GB of VRAM (unified memory on a Mac), Ollama gives a model a 4k-token context by default. The system prompt + 5 chunks of 600–800 tokens + the question don't fit there, the tail is silently cut off, and S loses not because of its intelligence but because of the truncation. We raise the context (`OLLAMA_CONTEXT_LENGTH` when starting the server or `num_ctx` in the native API; the context size can't be set through the OpenAI-compatible endpoint) to what is needed, but carefully at 8–16 GB, for example to 8k, and check `ollama ps`: CONTEXT and that the model is fully on the GPU (PROCESSOR). If it doesn't fit, that is a result too: "on 8 GB, S only works with k=3".
2. **Warm-up.** Ollama unloads a model after 5 minutes without requests (`keep_alive`), and the first request includes loading the model into memory. We send a warm-up request and don't count it in the latency.
3. **Queue.** By default Ollama handles requests to a model one at a time; a parallel run measures waiting in the queue. We run the local configuration sequentially.
4. **Network and DeepSeek peak hours.** DeepSeek's latency includes the network to servers in China and the load; the price depends on the peak/off-peak window. We run the configurations interleaved and within one price window.
5. **Quantization.** Ollama's default tags are quantized weights. We record the exact tag (`qwen3:4b`, not "qwen 4B"): a different tag is a different model.
6. **Reasoning mode.** `qwen3` is marked as a thinking model in the Ollama library. We compare S and L in the same mode (both without reasoning, `"answer_thinking": false`) or make the mode a separate factor; how to turn reasoning off for a specific model in Ollama is in its documentation (the `think` / `reasoning_effort` parameter; support depends on the model).

### Cost: what to write for a local model

Ollama costs $0 per token, but "free" doesn't mean "no cost". In the table we write "$0 API" for S plus the latency on our own hardware, with the memory size and the note "model on the shop's machine". On the "quality versus cost" chart, S will sit at zero cost; we add a second chart, "quality versus p90 latency", where the picture is more honest. For DeepSeek we compute with `eval/cost.py` from chapter 6.4 (cache hits, peak/off-peak). The order of magnitude for L without thinking: an answer of ~3500 input + 300 output tokens comes to about $1.4 per 1000 questions at peak and half that off-peak (an estimate from the prices in 6.4, without cache hits; we check it against the actual numbers).

### The reranker and memory

The reranker stays a local cross-encoder from sentence-transformers, as in [AIL-22](AIL-22.md): `BAAI/bge-reranker-v2-m3` (`RERANK_MODEL`). The English `cross-encoder/ms-marco-MiniLM-L6-v2` takes little memory but doesn't suit non-English questions; multilingual cross-encoders are noticeably larger. On 8 GB, next to Ollama and `bge-m3`, we check that everything fits and measure the reranker's time separately. We download models only from official organizations on Hugging Face and pin the revision.

### Comparing providers for this chapter

| Axis | Claude | OpenAI | DeepSeek | Ollama (`qwen3:4b`) |
|---|---|---|---|---|
| Quality on RAG over `kb/` | strong models, we check on our own set | same | Flash/Pro, we check on our own set | noticeably weaker; breaks the format and refusals more often |
| Cost | per the pricing page | per the pricing page | cents per hundred questions; peak and off-peak | $0 API, we pay with memory and time |
| Latency | network + load | network + load | network to China + load | our own machine: warm-up, context, queue, swap |
| Context | large | large | 1M tokens | 4k by default with less than 24 GB of memory, raise carefully |
| Privacy | cloud | cloud | servers in China | everything local |
| Most likely place on the Pareto front | quality | quality | cost/quality | only "private and offline" |

The last row is a hypothesis, not a conclusion: the experiment is exactly what checks whether the local 4B model has a place on the front for public questions about the shop's rules, or whether its niche is only messages with customers' personal data and offline work.

## Learning path

1. We open [Artificial Analysis](https://artificialanalysis.ai) → the model comparison page (≈20 min). We find 2–3 candidates: one strong model and one or two small/cheap ones from the provider we use. We write down the price per 1M input/output tokens, the time to first token, tokens per second. We check the prices against the provider's own pricing page.
2. We open [LMArena](https://lmarena.ai) → the leaderboard (≈10 min). We see where our candidates are. We write down why a ranking by people in a chat ≠ the quality of answers from a knowledge base.
3. We open [Sentence Transformers: Cross Encoder usage](https://sbert.net/docs/cross_encoder/usage/usage.html) (≈15 min). The `rank` method, the order of the results, the note on the scale of scores. We look at the list of pretrained cross-encoders on sbert.net to see whether there are multilingual ones.
4. We reread the section on reranking in [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) (≈10 min): what effect was achieved there and at what latency cost.
5. In [What We Learned from a Year of Building with LLMs](https://applied-llms.org) we find the advice on choosing a model and on small models (≈15 min).
6. Our provider's pricing documentation: the pricing page and the section on prompt caching (≈10 min).
7. We open [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (≈10 min): Flash and Pro prices with a cache hit and a miss, the peak/off-peak windows. We copy them into `eval/prices.json` with the date.
8. We open [ollama.com/library/qwen3](https://ollama.com/library/qwen3) and [Ollama: Context length](https://docs.ollama.com/context-length) (≈15 min): the model's sizes and tags, how much it takes, how the context depends on memory. We choose a tag by our machine's memory (8 GB: 4B, 16 GB: 7–8B, 32 GB+: 14B and larger) with headroom for `bge-m3` and the reranker.
9. We open [Ollama: FAQ](https://docs.ollama.com/faq) → the sections on `keep_alive` and parallel requests (≈10 min): this is where the warm-up and the sequential run come from.

## What to watch out for

- **"Let's take the strongest model"** without measuring: expensive and not necessarily better on our task.
- **Comparing models with different prompts** compares prompts, not models.
- **A price from memory or from an old article.** Only from the pricing page, with the date.
- **Mean latency instead of p90**: a customer in a Telegram bot remembers slow answers.
- **Latency measured at different times of day**: API noise is passed off as a difference between models.
- **An English reranker** for non-English questions can make the results worse; we look at the slice by language.
- **The small model breaks the format** (no `[1]` links, no `REFUSAL` phrase on unanswerable questions, extra promises of a refund). This is part of quality; we check the assertions from [AIL-27](AIL-27.md) (links are present) and `refusal_ok`/`false_refusals` as separate metrics.
- **Rate limits.** A parallel run of 4 configurations can hit the limits; retries distort latency. We record the number of retries and exclude the waiting time from latency, or run more sequentially.
- **Holdout only once**, only for the final configuration.
- **The local model lost because of a truncated context**, not because of quality. We check `ollama ps` and `prompt_eval_count` before writing the conclusion.
- **Ollama's cold start and queue in the latency.** Warm-up, a sequential run, the first request not counted.
- **A local run short of memory** (heavy programs open, a model larger than the RAM allows): swapping and garbage latency. Only with unnecessary programs closed and a model matching our memory size.
- **A DeepSeek judge compares DeepSeek with qwen.** Self-preference distorts exactly the "S versus L" conclusion; we check agreement on the questions where they disagreed.
- **"$0" for the local model on the cost chart** looks like an unconditional win. We add the latency axis and quality.
- **The conclusion "the local model is worse, so everything goes to the cloud"** breaks the privacy rule: messages with customers' personal data still don't go to the cloud. The choice for them is the local model or an operator (`handoff`), not DeepSeek.

## Practice

- [ ] In `experiments/EXP-02-models-reranker.md` we write down the requirements (quality threshold, budget, p90) and hypotheses (for example: "the reranker will give the small model more than the large one").
- [ ] We build a shortlist from Artificial Analysis and make the 2×2 design concrete on our stack: S = `qwen3:4b` (the exact tag in the config), L = `deepseek-flash` without thinking; the reasoning mode is the same for S and L. We record the exact IDs and prices with the date in `eval/prices.json`.
- [ ] We add `reranker`, `retrieve_k` (how many candidates to select before reranking, e.g. 20) and `k` (how many to give the model, e.g. 5) to the config.
- [ ] We run retrieval only, with and without the reranker: hit@5, MRR. We look at the slice by the question's language (`ru`/`en`).
- [ ] Before the local runs: unnecessary programs are closed, `ollama ps` shows the needed context and the model fully on the GPU; a warm-up request.
- [ ] We make 4 configs (`eval/configs/s.json`, `s_rerank.json`, `l.json`, `l_rerank.json`) and run the full eval on dev: local configurations sequentially, DeepSeek configurations within one price window; for candidate pairs, repeated runs or a comparison against a known spread.
- [ ] We compute $ per 100 questions (the system only), p50/p90 latency, and the reranker's time separately.
- [ ] `eval/compare.py` for the pairs: S vs S+R, L vs L+R, S+R vs L+R.
- [ ] We build two scatter plots (matplotlib): "correctness versus $ per 100 questions" (`experiments/pareto.png`, with the Pareto front marked) and "correctness versus p90 latency".
- [ ] We read the questions where S and L disagreed (usually 10–20): where is the small model worse (format, reasoning, ignoring the instruction, archived return rules)? We label them ourselves without looking at the verdicts and compute the agreement of the `deepseek-v4-pro` judge on them separately.
- [ ] We choose a configuration by our requirements, run it **once** on the holdout, and record the number.
- [ ] We write the recommendation (5–8 sentences, with numbers and limitations) into the experiment log, with a separate line for messages with personal data: the local model or an operator.
- [ ] (Optional, 16 GB+) S′ = `qwen3:8b` (or 14B with 32 GB+) as a separate run: how much quality a larger local model adds.
- [ ] (Optional) L+ = `deepseek-v4-pro` or `deepseek-flash` with thinking: what they give in quality and what they cost.
- [ ] (Optional, for comparison) One Claude and/or OpenAI model on the same questions (the data is public); we mark them on the chart.

## Done when

- There is a table of 4 configurations: quality (with the spread), the cost of 100 questions, p50/p90 latency.
- There is a recommendation with numbers: which configuration goes to production and why, with limitations.
- The final configuration is checked on the holdout.

## Self-check quiz

1. What is the Pareto front in the context of choosing a configuration?
2. Why doesn't a model's high LMArena rating guarantee the best result in our RAG?
3. Which part of the tokens usually dominates the cost of a RAG answer, and why?
   a) output, the answers are long; b) input, because of the context chunks; c) embedding tokens; d) judge tokens.
4. How can a reranker reduce the cost of generation, even though it adds a step itself?
5. Why a 2×2 design rather than two separate pairs of comparisons?
6. The small model is 3 percentage points worse than the large one in correctness (disagreements 6/4) and 6 times cheaper; the requirement is correctness no lower than baseline − spread. Which one to choose, and what needs to be checked?
7. What is wrong with this comparison?
   ```
   L: answer_prompt v3, k=5, judge = L
   S: answer_prompt v3-short (S got confused by the long one), k=8, judge = L
   Result: L is better by 6 pp
   ```
8. Why is it better to measure the latency of different configurations interleaved?
9. Why is the decision made by requirements formulated before the experiment?
10. Why is the final configuration run on the holdout, and why only once?
11. The local `qwen3:4b` lost to `deepseek-flash` by 25 pp in correctness, and almost all the failures are on questions with long chunks (delivery rate tables). What should be checked before writing the conclusion?
12. Why does the `deepseek-v4-pro` judge need an extra check specifically in the "local model versus `deepseek-flash`" comparison?
13. Why is it a mistake to measure the latency of a local model on an 8 GB machine via `ThreadPoolExecutor(max_workers=6)` right after it has been idle? Name two reasons.

## Answers

1. The set of configurations where one axis (quality, cost, speed) can't be improved without making another worse; everything dominated is discarded.
2. LMArena reflects people's preferences in a general chat (influenced by style and length), not following the instruction "answer only from the knowledge base" or factual accuracy in our domain.
3. **b.** Each question carries the system prompt and k knowledge-base chunks: thousands of tokens against hundreds on the output.
4. It lets the model get fewer but more precise chunks (for example, 4 instead of 8) with the same or better quality, so there are fewer input tokens.
5. It shows the interaction of the factors: the reranker's effect may depend on the model (it helps the small one a lot and barely helps the large one).
6. Most likely the small one: 6/4 is noise, the difference is not established, and the requirements are probably met. To check: the quality threshold with the spread taken into account, faithfulness and format (links, refusals), slices (whether some type of question fails), latency, and confirmation on the holdout.
7. Several variables are changed: different prompts and k, so it is not the models being compared. The judge is from the same family as L: possible self-preference. There is no spread and no paired comparison.
8. API latency fluctuates with the time of day and the load; if A runs in the morning and B in the evening, the difference in the network is attributed to the models.
9. Otherwise the requirements get fitted to the result one liked; thresholds set in advance turn the choice into a check of conditions.
10. Dev was used for the choice, so its number is optimistic; the holdout gives an honest estimate. Repeated runs with tuning would turn the holdout into a second dev set.
11. Whether the context was truncated: with less than 24 GB of memory Ollama gives 4k tokens by default, and long chunks are silently dropped. Look at `ollama ps` (CONTEXT) and `prompt_eval_count`, raise the context (carefully) or reduce k, and rerun.
12. A judge from the DeepSeek family may rate answers from its own family higher, and this distorts exactly the pair being compared. We need our own labels for the questions where the answers disagreed (and, optionally, a judge from another family on them).
13. By default Ollama handles requests to a model one at a time, so parallel requests measure waiting in the queue; after 5 minutes of idling the model is unloaded, and the first request includes loading it. On top of that, on 8 GB parallelism increases memory use and can cause swapping.

## What's next

The numbers showed how many errors are left. In [AIL-34 · Error analysis: reviewing the errors of an LLM system by hand](AIL-34.md) we find out why they happen and fix the most frequent cause with a measured effect.
