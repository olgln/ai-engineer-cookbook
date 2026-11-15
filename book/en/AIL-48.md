# 10.5 · Fine-tuning: a basic LoRA example  (AIL-48)

> **Week 10** · Production · ⏱ ~4 h · Theory, Practice

<!-- description: Fine-tuning in practice: when it beats a prompt and RAG, LoRA and QLoRA on a free GPU, training data and evaluating the result. -->
<!-- source-sha256: 54b8886dbed9 -->

## Why an AI engineer needs this

An AI engineer rarely fine-tunes models, but the question "why not fine-tune?" comes up in every other interview and every other conversation with a client. A strong answer is not "fine-tuning is cool" but "here is when it pays off, here is why this case calls for RAG and that one only needs a prompt, and here is how to run it and evaluate it." This chapter gives us both the arguments and a real LoRA run by our own hands: first a ready-made training notebook to go through the whole cycle, then (optionally) our own task from the Shelf shop: deciding which knowledge base section a customer's question belongs to.

## Theory

### Where fine-tuning sits in a model's life cycle

```
pretraining           →  SFT (instruction tuning)  →  preference tuning     →  our fine-tuning
trillions of tokens       "question → answer"           DPO / RLHF:               hundreds to thousands
of text, the model        examples, the model learns    "this answer is better    of examples of our task
learns to continue text   to follow instructions and    than that one"            (usually SFT + LoRA)
                          the chat format
done by labs              done by labs                  done by labs              something we can do
```

Karpathy's video from AIL-3 covered the first stages. **Supervised fine-tuning (SFT)** is the same "predict the next token" training, only on our own "input → desired output" examples. The model shifts its weights so that similar inputs produce similar outputs.

The key point: fine-tuning changes **behavior** (style, format, solving a narrow task); it does not reliably add **knowledge**. A model fine-tuned on 500 "customer question → support answer" examples will not "memorize the knowledge base" `kb/`. It will learn to answer *in the style* of those examples and will confidently make up return windows and warranties in that style.

### Prompt vs RAG vs fine-tuning: when to use which

| Task | What to use | Why |
|---|---|---|
| The model must know the shop's rules from the knowledge base `kb/` | **RAG** | Rules change; we need source citations (AIL-23); an update means reindexing, not retraining |
| We need a specific format/tone that a prompt holds only unreliably | **Fine-tuning** (if prompt + few-shot + structured output did not help) | The behavior is "baked" into the weights, the prompt gets shorter |
| Narrow classification at high traffic (knowledge base section for a question, review sentiment, request type) | **Fine-tuning a small model** | A small fine-tuned model often catches up with a large one on a narrow task, at a fraction of the cost and latency |
| An expensive large model solves the task well, we need it cheaper | **Distillation**: large model's answers → training set → fine-tuning a small one | Lower cost while keeping quality on the narrow task |
| A new task, few examples, requirements change every week | **Prompt** | Iteration in minutes, not hours; nothing to "retrain" |
| The model must know the shop's orders and stock | **Tool calling / SQL** (Project 1) | The data changes every minute and must be exact |

The decision ladder worth saying out loud in an interview:

```
1. Prompt (+ few-shot, + structured output)   — hours, almost free
2. RAG / tools                                 — if knowledge or data is missing
3. A stronger model                            — if "brains" are missing
4. Fine-tuning                                 — if we need a stable format/style,
                                                 a narrow task at scale, or lower cost
   ...and only with evals to prove that things got better
```

The cost of fine-tuning is not just the GPU. It is collecting and cleaning data (the most expensive part), evals, storing and serving our own weights, and **retraining every time the base model changes**. Cloud models get updated; our adapter for the old base does not.

Some providers offer managed fine-tuning through the API (we upload JSONL and get the id of a fine-tuned model). Which models support it and on what terms changes over time, so we check the provider's current documentation.

### Full fine-tuning vs PEFT

If the ladder does lead us to fine-tuning, the next question is which weights to change: all of them or a small add-on to them. Full fine-tuning updates **all** weights. For an 8B model that means keeping in memory the weights, the gradients and the optimizer state (Adam keeps two more numbers per parameter): tens of gigabytes of GPU memory and a separate copy of the model for every task.

**PEFT** (parameter-efficient fine-tuning) is a family of methods that freeze the original weights and train a small number of new ones. The most popular one is **LoRA**.

### LoRA: the idea in one formula

Take one weight matrix `W` of size `d × k` (for example, 4096 × 4096 in an attention layer). Full fine-tuning looks for a correction `ΔW` of the same size. The LoRA hypothesis: the correction needed for adaptation has **low rank**, meaning it can be represented as the product of two narrow matrices:

```
W' = W + ΔW = W + (alpha / r) · B · A

W:  d × k   (frozen)
B:  d × r   (trained, initialized with zeros → at the start W' = W)
A:  r × k   (trained)
r:  rank, usually 8–64

parameters in ΔW for full fine-tuning: 4096 × 4096 = 16 777 216
parameters in LoRA at r = 16:          4096 × 16 + 16 × 4096 = 131 072  (≈0.8%)
```

An analogy from everyday development: instead of storing a new copy of the whole repository, we store a small patch (a diff) applied on top. The patch (the adapter) weighs megabytes, there is one base model, and we can have as many adapters for different tasks as we like.

Parameters we meet in `LoraConfig`:

| Parameter | What it means | Typical starting point |
|---|---|---|
| `r` | rank: the adapter's "capacity" | 8–16; higher means more parameters and a risk of overfitting |
| `lora_alpha` | scale of the correction (divided by `r`) | often equal to `r` or `2r` |
| `target_modules` | which matrices get an adapter | attention projections (`q_proj`, `k_proj`, `v_proj`, `o_proj`), often MLP too (`gate_proj`, `up_proj`, `down_proj`); names depend on the architecture |
| `lora_dropout` | regularization | 0–0.1 |

An illustrative example with Hugging Face PEFT (check it against the current version of the docs):

```python
from transformers import AutoModelForCausalLM
from peft import LoraConfig, get_peft_model

base = AutoModelForCausalLM.from_pretrained("<org>/<small-instruct-model>")
config = LoraConfig(
    r=16,
    lora_alpha=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_dropout=0.05,
    task_type="CAUSAL_LM",
)
model = get_peft_model(base, config)
model.print_trainable_parameters()  # expect well under 1% trainable
```

After training, the adapter is either loaded on top of the base (`PeftModel.from_pretrained`) or merged into the weights (`merge_and_unload()` returns a new model; it is not an in-place operation). In the latter case it is an ordinary model with no extra latency, which we can convert, for example, to GGUF and run in Ollama (AIL-47).

### QLoRA: LoRA on a free GPU

**QLoRA** = the base model is loaded **quantized to 4 bits** (frozen), and the LoRA adapter is trained in 16 bits on top of it. Memory for the base drops by ~4x, and a model with a few billion parameters trains on a single small GPU, for example a free cloud T4. The link to AIL-47: this is the same quantization, only applied during training.

Where to train: **Google Colab**, Jupyter notebooks in the browser (as in chapter 1.4 · Jupyter notebooks in VS Code, AIL-57, only on someone else's machine) with a free NVIDIA T4 GPU for a limited time; or our own machine with an NVIDIA GPU (8 GB of VRAM is enough for QLoRA on a 3–4B model). On Apple Silicon and CPU training is noticeably slower; we check support in the tool's documentation. Running the result is easier: a 4B model in `q4_k_m` runs in Ollama on a machine with 8 GB of RAM, just like `qwen3:4b`.

What to train with: **Unsloth**, an open-source library on top of Hugging Face PEFT and TRL (the Hugging Face library for SFT training) that speeds up LoRA/QLoRA and saves memory; it has ready-made free Colab notebooks for popular small models, and those are what we use in the Practice. Unsloth recommends starting with QLoRA and training/serving at the same precision. Starting hyperparameters from their guide: learning rate `2e-4`, `max_steps=60` for a quick check, 1–3 epochs for a full run (more risks overfitting).

### Data: format and quality

The method and the tool are chosen; next comes the data, which the result depends on most. For a chat model, an example is a dialogue in the messages format. Our task is customer question → knowledge base section, using the same `category` values as in the front matter of the `kb/` pages, plus `other` for questions that are not about the shop:

```json
{"messages": [
  {"role": "system", "content": "Determine the shop's knowledge base section for the customer's question. Answer with one word: delivery, payment, returns, warranty, promo, orders, products or other."},
  {"role": "user", "content": "can I return opened tea?"},
  {"role": "assistant", "content": "returns"}
]}
```

Before training, each such dialogue is turned into a string through the model's **chat template**: special tokens that mark the roles. The template at training time and at inference time must match: if a model is trained with one and run with another (for example, a different template in Ollama), it behaves strangely. Usually the loss is computed **only on the assistant's answer**, not on the prompt.

Data quality matters more than quantity: 300 clean, varied, consistently labeled examples beat 3000 contradictory ones. As in chapter 2.5, we write down the labeling rules before labeling: a question gets the section of the page that answers it; "does TEA15 stack with a discount?" is `promo`, not `payment`; a question that needs two sections gets the main one. For a narrow classifier we need hundreds of examples per class; for style, hundreds to thousands of dialogues. The data can be generated with a strong model (synthetic data from AIL-61 is the same technique), but then manually checking a sample is mandatory.

### How to tell that things got better

Training has finished and the loss went down, but that does not yet mean the model solves the task better. As with everything in this book, we check only through evals:

- **A held-out set** (test split, for example 20%) the model has not seen. Questions from `eval/golden.jsonl` with a filled-in `category` go only into test: they are a ready-made reference and have no place in train.
- **Three comparison rows:** the base model with a good prompt and few-shot; the fine-tuned model; a strong cloud model. If base + few-shot ≈ fine-tuned, we do not need fine-tuning.
- **Noise:** on 60 test questions (20% of 300 examples), 0.90 vs 0.85 is three questions; whether it is "proven" or "a trend" is decided by `eval/stats.py` from chapter 7.1.
- **Signs of overfitting:** train loss goes down while quality on test does not rise or falls; the model repeats training answers word for word.
- **Catastrophic forgetting:** the model got good at classification but forgot how to answer everything else properly. For a narrow task that is acceptable; for a general assistant it is not.

### Security and data

- Colab is Google's cloud. **No customer data in a training set for Colab**: only public or made-up texts, such as the `kb/` pages, synthetic data from them and the demo database. Real customer messages (ours are made up, but we treat them as real) do not go to Colab even anonymized; a set containing them is trained only locally, on our own machine with a GPU.
- A Colab notebook is executable code. We take notebooks from official sources (the Unsloth repository/documentation, Hugging Face) and look through the cells before running them, especially `pip install` and anything that downloads something from a URL.
- A Hugging Face token (if needed for a gated model or for uploading the result) goes through Colab Secrets, not as a string in a cell; a read-only token if the model is not uploaded anywhere.

## DeepSeek and Ollama: how we do it

The fine-tuning itself runs in Colab (Unsloth/PEFT) and does not depend on the API provider. Providers matter in three places: where to get the data, where to run the result and what to compare it with. Checked against the DeepSeek and Ollama documentation in November 2026.

| What | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Managed fine-tuning through the API | check the current Anthropic docs | yes (JSONL upload, training job); terms and models in the docs | **no**: as of November 2026 the API Reference has only chat/responses/messages, FIM, models, balance, files and tools | does not train |
| Open weights for our own LoRA | no | see the docs (some open-weight models) | available in the `deepseek-ai` organization on Hugging Face, but the flagship models are too large for a Colab T4 and an ordinary laptop; check the sizes in the model cards | — |
| Run our own result | no | the fine-tuned model lives at OpenAI | no | **yes**: GGUF → `Modelfile` → `ollama create` |
| Role in this chapter | for comparison | for comparison | "teacher" for synthetic data from public data; a strong comparison row | running the adapted model, the baseline |

**Data.** Synthetic data for the classifier (the optional task) is cheapest to generate on DeepSeek (`deepseek-flash`; `deepseek-v4-pro` if the examples come out worse), but **only from the public** `kb/` pages (the shop's knowledge base is public and made up, so it is fine to show it to the cloud), without the archived pages, as in chapter 6.2. Before training a model on another model's answers, we read the provider's terms of use about using outputs to train models: this changes and differs between providers. Customer messages and snapshots of the `data/shop.db` database go neither to DeepSeek nor to Colab.

The practical point of the task: real customer questions are handled only by a local model. If a small fine-tuned model picks the section as well as DeepSeek does, it can choose the `categories` in `plan_query` (5.1), locally and cheaply.

**Running the result in Ollama.** The reliable path, described in [Importing a Model](https://docs.ollama.com/import): merge the adapter (`merge_and_unload()`), export to GGUF (Unsloth has an export function in the notebook) and create the model:

```
# Modelfile
FROM ./classifier-q4_k_m.gguf
PARAMETER temperature 0
```

`ollama create category-clf -f Modelfile`. Ollama does not quantize a GGUF on import, so we quantize beforehand (llama.cpp `llama-quantize` or the Unsloth export). The chat template must match the one the model was trained with (see "What to watch out for"): we check it with `ollama show --modelfile category-clf`. The `ADAPTER` instruction (attaching LoRA on top of the base without merging) was not found on the current Modelfile page; if the installed version has it, that is an option, but the merge path is the tested one.

**The classifier's answer comes strictly from the list.** Ollama's `format` with a JSON schema ([Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)) constrains the answer to the schema, including `enum`:

```python
# illustrative: classifier output constrained to the label set
from typing import Literal
from pydantic import BaseModel
import ollama

class QuestionCategory(BaseModel):
    category: Literal["delivery", "payment", "returns", "warranty",
                      "promo", "orders", "products", "other"]

r = ollama.chat(model="category-clf", messages=[{"role": "user", "content": question}],
                format=QuestionCategory.model_json_schema(), options={"temperature": 0})
label = QuestionCategory.model_validate_json(r.message.content).category
```

**The three comparison rows** from the theory, on our providers: the small base model in Ollama (the same one we fine-tuned, for example `qwen3:4b`) with a good prompt and few-shot; the same model after LoRA in Ollama; a strong cloud model, `deepseek-v4-pro`, on the same public questions (Claude/OpenAI for comparison, if we have a key). Row zero is the `detect_category_rules` rules from 5.1: the model has to beat them. If the fine-tuned local model catches up with DeepSeek on classification, that is exactly the "cheaper and private" argument for an interview.

## Learning path

1. Open the [Hugging Face LLM Course](https://huggingface.co/learn/llm-course) → chapter 11 (fine-tuning): Chat Templates, Supervised Fine-Tuning, LoRA, Evaluation (≈75 min). Pay attention to chat templates and to how the SFT trainer (TRL) takes a dataset.
2. Open [Hugging Face PEFT](https://huggingface.co/docs/peft) → Quicktour, then the LoRA guide (developer guides) (≈30 min). Find: `LoraConfig`, `get_peft_model`, `print_trainable_parameters`, `merge_and_unload`, and what the QLoRA loading variant is.
3. Open [Unsloth](https://github.com/unslothai/unsloth) → README: the list of supported models and the table of free notebooks (≈15 min). Then the [Fine-tuning LLMs Guide](https://unsloth.ai/docs/get-started/fine-tuning-llms-guide) in their documentation → the sections on choosing a model, LoRA vs QLoRA, the dataset, hyperparameters (≈30 min). The same docs have a page with a LoRA hyperparameters guide; read about `r` and `lora_alpha`.
4. (Recommended) The original paper "LoRA: Low-Rank Adaptation of Large Language Models" (Hu et al., 2021, arXiv): only the abstract, the introduction and Figure 1 (≈20 min). That is enough to explain the idea in our own words.
5. Open [Ollama: Importing a Model](https://docs.ollama.com/import) and the [Modelfile Reference](https://docs.ollama.com/modelfile) → GGUF import, `FROM`, `PARAMETER`, the template (≈15 min).
6. Open [DeepSeek: Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) and look at the API Reference: confirm for ourselves that there is no fine-tuning endpoint, and estimate the cost of generating 300 synthetic questions (≈10 min).
7. Run the notebook (see the Practice) (≈60–90 min including the wait for training).

## What to watch out for

- **Fine-tuning for knowledge** is the most common mistake. New facts and frequently changing data (return rules, shipping rates, stock) call for RAG or tools.
- **No baseline.** Without a comparison against "base model + good prompt," no improvement is proven.
- **Test leaking into train:** duplicates and near-duplicates in both sets give nice and false numbers. Deduplicate before splitting; questions from `eval/golden.jsonl` go only into test.
- **Chat template mismatch** between training and running.
- **Too many epochs / too high a learning rate**: the model memorizes the examples.
- **Inconsistent labeling:** if the same situation is labeled differently in the data (a promo code question is sometimes `promo`, sometimes `payment`), the model learns noise.
- **The Colab session drops**: save the adapter (it is small) to Google Drive or download it right after training.
- **Third-party code in the notebook**: read the cells before running.
- **"Let's fine-tune DeepSeek"**: not possible through its API; the flagships' open weights will not fit in Colab. We fine-tune a small open-weight model.
- **An unquantized GGUF** in Ollama: the import does not quantize, so the model takes as much memory as FP16.
- **Synthetic data from real data** through a cloud model is a leak; we generate only from the public `kb/` pages.

## Practice

- [ ] Open a free Unsloth Colab notebook for a small instruct model (from the table in the Unsloth README or from the notebooks page in their documentation). The main track is the notebook as is, on its own training dataset: the goal is to go through the whole cycle from loading the model to the adapter; the Shelf shop classifier is the optional task below. Choose a runtime with a GPU (T4).
- [ ] Before running, read all the cells. Find and write down: which base model, whether it is loaded in 4 bits (QLoRA), the values of `r`, `lora_alpha`, `target_modules`, learning rate, `max_steps`/epochs, which dataset and how the chat template is applied to it.
- [ ] Before training, ask the model 3 questions in the spirit of the notebook's dataset and save the answers (the baseline).
- [ ] Run the training as is. Write down: the number of trainable parameters and their share (`print_trainable_parameters` or the notebook's output), the training time, how the loss changed.
- [ ] After training, ask the same 3 questions. What changed in style/format?
- [ ] Save the adapter, check its size in MB and compare it with the size of the base model.
- [ ] (Optional, +2 h) Our own mini-set in `projects/02-support-kb-rag/finetune/`: a classifier of customer questions by knowledge base section (`delivery`, `payment`, `returns`, `warranty`, `promo`, `orders`, `products`, `other`). 300 questions generated synthetically on DeepSeek (a strong "teacher" model) with the technique from chapter 6.2 · Synthetic data for evals (AIL-61) from the **public** `kb/` pages, without the archived ones; the label is the `category` of the source page, and the `other` questions we write by hand. Record the generation cost and the labeling rules, check a sample by hand; JSONL in the `messages` format (`clf_train.jsonl`, `clf_test.jsonl`), deduplication, then an 80/20 split; questions from `eval/golden.jsonl` with a filled-in `category` go only into test. Compare these rows on test: `detect_category_rules`, base model + few-shot in Ollama, fine-tuned in Ollama (with `format` and `enum`), `deepseek-v4-pro` + few-shot. A table in `finetune/RESULTS.md`: accuracy with a Wilson interval, errors per class (which sections get confused), latency, the cost of 1000 classifications.
- [ ] (Optional) Export to GGUF (quantized, for example `q4_k_m`) with the notebook's function and run it in Ollama (chapter 10.4, AIL-47) through a `Modelfile` with `FROM ./<file>.gguf`; check the template with `ollama show --modelfile`.
- [ ] Notes `notes/prompt-vs-rag-vs-finetune.md`: a "task → solution → why" table, the decision ladder, 3 examples from our own course projects (what is worth fine-tuning and what is not, and why), the cost of fine-tuning beyond the GPU.
- [ ] Rehearse out loud an answer to "When would you fine-tune a model?": 60–90 seconds, with an example.

## Done when

- The notebook has run to the end, we know which hyperparameters it uses and what they mean, and we have seen the difference in answers before/after.
- We have notes on "prompt vs RAG vs fine-tuning" with examples from our own projects.
- In an interview we can explain in a minute and a half when fine-tuning pays off, how LoRA works and how to prove that things got better.

## Self-check quiz

1. A support assistant must answer from the shop's knowledge base, whose rules change every month. Fine-tuning or RAG? Why?
2. Which statement about LoRA is true?
   a) it updates all of the model's weights, but faster
   b) it freezes the weights and trains two small low-rank matrices whose product is added to the weights
   c) it shrinks the model by removing layers
   d) it is a quantization method
3. How many parameters does LoRA train for a 4096 × 4096 matrix at r = 8?
4. How does QLoRA differ from LoRA?
5. What is wrong with this plan?
   "I want the bot to know all of the shop's orders. I'll export 2000 orders from `shop.db` to JSONL as "question → answer" examples, upload them to Colab and fine-tune the model; then we won't need SQL or tool calling."
6. What is a chat template, and why must it match at training and inference time?
7. Which two signs point to overfitting during fine-tuning?
8. Which baseline is required to prove that fine-tuning helps?
   a) none  b) the base model with a good prompt and few-shot on the same test set  c) train loss  d) users' opinions
9. When is fine-tuning a small model economically justified?
10. What does `merge_and_unload()` do, and why?
11. Which costs of fine-tuning are not related to the GPU?
12. Why is it important to deduplicate the data before the train/test split?
13. Can we fine-tune DeepSeek through its API, the way it is done with OpenAI's managed fine-tuning? What do we do instead?
14. A GGUF in FP16 of 6 GB was imported into Ollama, although 2 GB was expected. Why did this happen?
15. Training examples are generated on DeepSeek. Which data can be given to the "teacher" model, and which cannot?

## Answers

1. RAG. The rules change; they need to be updated by reindexing and backed by citations to `kb/`; fine-tuning adds facts unreliably and goes stale.
2. **b.** The original weights are frozen; a low-rank correction `B·A` is trained.
3. 4096 × 8 + 8 × 4096 = 65,536 parameters (versus 16.7 million for the full matrix).
4. In QLoRA the base model is loaded quantized to 4 bits (frozen), and the adapter is trained on top in 16 bits. This cuts memory sharply and makes it possible to train on a single small GPU.
5. Fine-tuning does not give reliable, exact knowledge of data, and orders change all the time: the model will make up plausible totals and statuses. Plus the customers' personal data ends up in Google's cloud. The right way: tools/SQL over a read-only database snapshot (Project 1).
6. A template that turns a list of messages with roles into a string with special tokens. The model is trained on a specific markup; with different markup at inference it sees an unfamiliar format and behaves unpredictably.
7. Train loss goes down while quality on test stays flat or falls; the model repeats training answers word for word; it handles paraphrased inputs worse.
8. **b.** If the base model with a good prompt gives comparable quality, fine-tuning is not needed.
9. With a narrow, stable, high-traffic task where a small fine-tuned model reaches the quality of a large one (for example, deciding the knowledge base section for a customer's question): then the savings on every request and on latency pay for collecting the data and maintenance; a local model can also process data that cannot be sent to the cloud.
10. It merges the adapter's weights into the base model and returns an ordinary model without a separate adapter: no extra latency, and it can be converted (for example, to GGUF). The operation is not in-place, so the result has to be assigned.
11. Collecting, labeling and checking data; building evals; storing and serving our own weights; monitoring; retraining when the base model changes.
12. Otherwise nearly identical examples end up in both train and test, and the model "guesses" what it memorized: the test metrics come out inflated.
13. No: as of November 2026 the DeepSeek API has no fine-tuning endpoint, and the open weights of its flagships are too large for Colab. We fine-tune a small open-weight model (LoRA/QLoRA) and use DeepSeek as a "teacher" for synthetic data and as a strong comparison row.
14. Ollama does not quantize a GGUF on import: whatever file it is given is what runs. We quantize beforehand (`llama-quantize` or the Unsloth export to `q4_k_m`).
15. Only public and made-up data: the `kb/` pages, synthetic data from them, the demo database. Customer messages, the `data/shop.db` snapshot, the event log and keys cannot: the rule is common to all cloud providers, and DeepSeek's servers are also in China; plus we check the terms of use for training on the model's outputs.

## What's next

This is the last chapter of the course. The cost, latency and model comparison numbers from this week are worth keeping: they belong in the projects' READMEs, and the "prompt vs RAG vs fine-tuning" arguments will come in handy whenever we need to explain the architecture of an LLM application.
