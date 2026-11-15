# 6.5 · LLM observability: Langfuse and promptfoo  (AIL-30)

> **Week 6** · Evals · ⏱ ~4 h · Practice

<!-- description: LLM observability: traces, spans and datasets in Langfuse, declarative prompt comparison in promptfoo, cloud or self-hosted. -->
<!-- source-sha256: e4c43adf8553 -->

## Why an AI engineer needs this

Our script from [AIL-29](AIL-29.md) computes the numbers, but looking at individual requests in it is awkward: JSONL in a terminal is not the best interface. Observability tools show each request as a tree of steps with the prompt, the answer, tokens, cost and time, and they store datasets and run results. Langfuse, LangSmith, Braintrust, promptfoo and the like come up in AI engineer job postings all the time; understanding which problem they solve matters more than knowing a particular one.

## Theory

### Two different problems: tracing and prompt comparison

| | Langfuse | promptfoo |
|---|---|---|
| What it is | An observability platform: traces, datasets, experiments, scores, prompts | A CLI for comparing prompts, models and configurations on a set of tests |
| Where it lives | A server (cloud or self-hosted in Docker) + an SDK in our code | Locally, a Node.js tool + a YAML config |
| Strength | Seeing what happens in production and in every run | Quickly comparing "prompt A vs B" in a table |
| Familiar analogy | Web server logs + a monitoring dashboard, only structured | A test runner with a matrix of variants (parametrized tests in pytest, table-driven tests in Go) |

They are not competitors but neighbors: Langfuse for "what is happening in the system", promptfoo for "which variant is better". In the practice we try both. We start with Langfuse: first its core concepts, then how it plugs into the code, datasets and the question of where to store traces; then promptfoo.

### Trace, span, generation

Tracing comes from ordinary backend development: the path of one request through the system is recorded as a tree of steps with the time of each. A **trace** is one whole user request. Inside it are nested **observations** (spans): search, reranking, prompt assembly, the model call. A model call is a special type of observation, a **generation**: it has a model, input, output, tokens and cost.

```
trace: "Can I return opened tea?"             2.3s   $0.004
 ├─ span: plan_query                          0.4s
 │   └─ generation: <small model>             0.4s   $0.0003
 ├─ span: retrieve (hybrid, k=5)              0.2s
 ├─ span: rerank                              0.3s
 └─ generation: answer <main model>           1.4s   $0.0037
       input: system + 5 chunks + question
       output: "No: opened tea is not accepted for return [1]..."
       usage: in 3120 / out 140
```

Such a tree shows at once what eats time and money and exactly what the model received as input: for example, whether a chunk from the archived `returns-2025.md` got into the context. For error analysis in [AIL-34](AIL-34.md) this is far more convenient than `results.jsonl`.

### How Langfuse gets into the code

For such a tree to appear, the code has to report its steps to Langfuse. There are three levels of integration (the exact function names are worth checking against the current SDK documentation; they have changed between versions):

1. **The `@observe()` decorator** on our own functions: each wrapped function becomes a span, and nesting is determined by the call stack. It is similar to middleware that wraps a handler.
2. **Ready-made integrations**: for the OpenAI SDK there is an import replacement (`from langfuse.openai import OpenAI`), and model calls are logged automatically, tokens included. For other SDKs, a manual wrapper or OpenTelemetry instrumentation.
3. **Manual generations** (`as_type="generation"`) with `model`, `usage_details` and the output.

An illustrative example based on the Langfuse Python SDK documentation: the configurable pipeline from [AIL-29](AIL-29.md) with decorators:

```python
# rag/pipeline.py  (illustrative; check the current Langfuse SDK docs)
from langfuse import observe, get_client

langfuse = get_client()  # reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from env

@observe()
def retrieve(question: str, cfg: dict) -> list[dict]:
    ...  # vector / hybrid search over kb/; inputs and outputs are captured automatically

@observe(as_type="generation", name="answer")
def generate(question: str, chunks: list[dict], cfg: dict) -> dict:
    resp = llm_call(question, chunks, cfg)   # your DeepSeek / Ollama / Claude call
    langfuse.update_current_generation(
        model=cfg["answer_model"],
        usage_details={"input_tokens": resp.in_tokens, "output_tokens": resp.out_tokens},
    )
    return {"text": resp.text}

@observe()
def ask(question: str, cfg: dict | None = None) -> dict:   # simplified; the real ask() returns Answer (5.3)
    chunks = retrieve(question, cfg)
    return generate(question, chunks, cfg)

# in short-lived scripts, flush before exit, otherwise events may be lost
langfuse.flush()
```

Langfuse computes cost from the model and tokens if the model is in its price table; for the rest we can set the price ourselves (see the section on models and prices in the documentation). Its figure is worth checking against the one our script computes.

### Datasets and experiments in Langfuse

Traces show individual requests. To run the whole set, as our `eval/run.py` does, Langfuse has datasets. A dataset in Langfuse has the same items as `eval/golden.jsonl`: `input` (the customer's question), `expected_output` (the reference), `metadata` (type, category, `must_include`, citations). An **experiment** (dataset run) is a run of our function over all items of the dataset; each item is linked to its trace, and scores are attached to the traces. In the UI two runs can be compared side by side, question by question.

The current Python SDK has an "experiment runner" for this: we pass a task (`task`) and evaluator functions (`evaluators`), and it runs them, links the traces and records the scores. The outline (illustrative, based on the documentation on experiments via the SDK):

```python
from langfuse import Evaluation, get_client

langfuse = get_client()
dataset = langfuse.get_dataset("support-kb-dev-v1")

def task(*, item, **kwargs):
    return ask(item.input, CFG)["text"]

def correctness(*, input, output, expected_output, metadata, **kwargs):
    item = {"q": input, "reference_answer": expected_output,
            "must_include": metadata["must_include"]}
    verdict = judge_correctness(item, output, CFG)["verdict"]  # our judge from AIL-29
    return Evaluation(name="correctness", value=1.0 if verdict == "PASS" else 0.0)

result = dataset.run_experiment(name="baseline", task=task, evaluators=[correctness])
print(result.format())
```

The source of truth is still `eval/golden.jsonl` in git. We upload a copy to Langfuse with the version in its name (`support-kb-dev-v1`) so that versions don't get mixed up.

### Cloud or self-hosted

Langfuse records the inputs and outputs of our functions in traces, so before the first run we decide whose server they will end up on.

- **Langfuse Cloud**: quicker to start, there is a free tier (terms on the website). Traces go to someone else's server. For questions about the public knowledge base `kb/` and the made-up questions from the set, this is acceptable.
- **Self-hosted via Docker Compose**: everything is local, suitable when the data must not leave. It needs Docker and several containers (Postgres, ClickHouse and others); for study on a single machine it is feasible if there is enough memory (see below).

The rule: **no customers' personal data in cloud traces**. Langfuse records the full input and output of functions under `@observe`, that is, the customer's whole question, with the phone number, email and order number. While made-up questions from the set go through the pipeline, Langfuse Cloud is fine. As soon as real customer messages get into tracing (the support bot from [AIL-23](AIL-23.md), the week 9–10 agent with the shop's database snapshot), it is either self-hosted or masking before sending: the Langfuse SDK has a function for masking input and output (the masking section of the documentation), and the same check as `contains_personal_data()` from `rag/privacy.py` can be plugged into it. API keys must not get into traces either.

### promptfoo: declarative comparison

Now the second problem from the table at the start of the chapter: comparing variants. promptfoo is a Node.js CLI. In `promptfooconfig.yaml` we describe prompts, providers (models or our own code) and tests with checks (assertions), run `promptfoo eval` and look at the results matrix in `promptfoo view`. In essence it is a test runner with parametrized tests, except that the variants are prompts and models, and the checks are on the answer text.

The example compares two versions of the answer prompt: `answer_v1.txt` from [AIL-23](AIL-23.md) and `answer_v2.txt`, the same instruction with a stricter citation requirement.

```yaml
# promptfoo/promptfooconfig.yaml  (illustrative)
description: Answer prompt v1 vs v2 on shop support questions

prompts:
  - file://../prompts/answer_v1.txt
  - file://../prompts/answer_v2.txt

providers:
  - id: file://provider.py        # your Python wrapper: retrieve + call the model
    label: rag-baseline

defaultTest:
  assert:
    - type: llm-rubric
      value: The answer only states facts present in the provided excerpts and cites them like [1].
    - type: latency
      threshold: 8000

tests:
  - vars:
      question: "Can I return opened tea?"
    assert:
      - type: icontains
        value: "not accepted"
      - type: llm-rubric
        value: Says that opened tea cannot be returned and unopened packs can be returned within 14 days.
  - vars:
      question: "What is the warranty on coffee machines?"
    assert:
      - type: llm-rubric
        value: Refuses or says the knowledge base does not contain this.
```

Check types that come in handy: `contains`/`icontains`, `regex`, `javascript` and `python` (our own function), `llm-rubric` (a judge with a criterion), `cost`, `latency`. There are also RAG-specific checks against the context (we look for `context-faithfulness` in the assertions documentation). A Python provider is a file with a function that receives the prompt and variables and returns `{"output": ...}`; the exact signature is in the Python provider section.

Tests don't have to be written in YAML by hand; they can be loaded from a file (CSV and other formats, see the documentation on test cases); a converter script from `golden.jsonl` takes 20 lines.

### Installation safety

Before installing any of this, the course rule for third-party code applies. Both tools are third-party code that will work with our API keys. Before installing:
- we check the exact package name (`langfuse` on PyPI, `promptfoo` on npm) and that the link comes from the official documentation;
- we pin the version: `uv add "langfuse==<version>"` (the version goes into `pyproject.toml` and `uv.lock`), `npx promptfoo@<version>` instead of `@latest`, a specific tag for the Langfuse Docker images rather than `latest`;
- we don't install a first-day release without a need;
- the Langfuse and provider keys go into `.env`, which is in `.gitignore`.

## DeepSeek and Ollama: how we do it

Both tools work with DeepSeek and Ollama, but with caveats that OpenAI doesn't have. Checked in November 2026 against [Langfuse: DeepSeek](https://langfuse.com/integrations/model-providers/deepseek), [Langfuse: Ollama](https://langfuse.com/integrations/model-providers/ollama), [promptfoo: DeepSeek](https://www.promptfoo.dev/docs/providers/deepseek/), [promptfoo: Ollama](https://www.promptfoo.dev/docs/providers/ollama/) and [promptfoo: model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/).

### Langfuse + DeepSeek and Ollama

Both providers are OpenAI-compatible, so the same import replacement as for OpenAI works:

```python
# illustrative; keys come from env, never from code
import os
from langfuse.openai import OpenAI   # drop-in wrapper instead of "from openai import OpenAI"

deepseek = OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])
local = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # key is required by the client, ignored by Ollama

r = deepseek.chat.completions.create(
    model="deepseek-flash",   # the Langfuse docs example still shows the older "deepseek-chat"; use current ids
    messages=[{"role": "user", "content": "..."}],
    extra_body={"thinking": {"type": "disabled"}},
)
```

What to keep in mind:

- **Langfuse won't compute DeepSeek's cost correctly on its own.** The model may be missing from its price table (then $0), and DeepSeek's `usage` contains extra cache fields (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`). According to the Langfuse documentation, if `usage` has keys outside the OpenAI schema, it stores them "flat", without splitting input tokens into cached and regular ones, and cached tokens can be counted twice. The reliable path: compute the cost with our own `eval/cost.py` from chapter [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md) and pass it to the generation via `cost_details` (then Langfuse takes our figure instead of inferring its own). The alternative is a custom model in Project Settings → Models with a `match_pattern` and prices, but DeepSeek's peak hours can't be expressed there.
- **The built-in LLM-as-a-judge in the Langfuse UI requires structured output by JSON schema from the model**: when an evaluator is saved, Langfuse makes a test request, and if the provider doesn't accept `response_format` with a schema, saving fails. DeepSeek's documentation lists only `json_object`, so it most likely won't work (this hasn't been tested live; it is worth checking ourselves). Ollama on our machine (`localhost`) can't be reached from Langfuse Cloud at all. Conclusion: we run the judge in our own code (as in chapter 6.4) and attach the verdicts to traces as scores via the SDK, which is what we planned to do anyway.
- **Where to store traces and whether there is enough memory.** For the public knowledge base and the made-up question set we take Langfuse Cloud (free tier, terms on the website) or promptfoo; they barely load the machine. Self-hosted Langfuse is several containers (web, worker, Postgres, ClickHouse, Redis, S3-compatible storage), and Docker Desktop reserves memory by itself. A RAM guideline: on 8 GB next to Ollama (a 3–4B model) it is heavy, so self-hosted only if there is no way around it and with other programs closed; on 16 GB (7–8B models) it works if not everything is kept open at once; on 32 GB+ it comfortably coexists even with 14B models. For real customer messages and the Project 4 database snapshot without self-hosting, it is simpler to do without a UI at all: a local `results.jsonl` and promptfoo with its local viewer.

### promptfoo + DeepSeek and Ollama

promptfoo has ready-made providers for both. The main thing is to **set the judge explicitly**: promptfoo picks a default judge based on the keys it finds in the environment (OpenAI, Anthropic and others), and without them `llm-rubric` either fails or calls the wrong model.

```yaml
# promptfoo/promptfooconfig.yaml — DeepSeek vs local model, DeepSeek Pro as the judge (illustrative)
description: Answer prompt v2 — deepseek-flash vs local model

prompts:
  - file://../prompts/answer_v2.txt

providers:
  - id: deepseek:deepseek-flash          # needs DEEPSEEK_API_KEY in env
    label: ds-flash
    config:
      temperature: 0
      max_tokens: 1000
      passthrough:
        thinking: { type: disabled }
  - id: ollama:chat:qwen3:4b             # 8 GB RAM: 3-4B models; 16 GB: 7-8B; check context with `ollama ps`
    label: local
    config:
      temperature: 0

defaultTest:
  options:
    provider:                             # the judge for llm-rubric and the embedder for "similar"
      text:
        id: deepseek:deepseek-v4-pro
        config:
          temperature: 0
          passthrough:
            thinking: { type: disabled }
      embedding:
        id: ollama:embeddings:bge-m3
  assert:
    - type: llm-rubric
      value: The answer only states facts present in the provided excerpts and cites them like [1].

tests: file://tests_from_dataset.yaml     # generated from eval/golden.jsonl by your converter
```

- **We don't put the answering model in `defaultTest.provider`.** According to the promptfoo documentation, this field is used as a fallback judge when no judge is set explicitly, and then the model ends up grading itself. Answering models go in `providers`, the judge in `defaultTest.options.provider`.
- **A judge with reasoning.** If thinking is enabled for the judge, `showThinking: false` is needed: only the final `content` should be graded, not the reasoning.
- **`context-faithfulness`** (promptfoo's RAG check) is a judge that splits the answer into claims and computes the share supported by the context; it needs the `query` and `context` variables. For it, too, we set `provider: deepseek:deepseek-v4-pro` explicitly. It is worth comparing with our faithfulness judge from chapter 6.4; this is the same comparison as with Ragas.
- **Embeddings for `similar`** go through Ollama; DeepSeek's documentation has no embeddings endpoint. Small embedding models have a short window; promptfoo sends `truncate: false`, and text that is too long returns an error instead of being silently truncated.
- **Old ids.** `deepseek-chat` and `deepseek-reasoner` are marked as retired in the promptfoo documentation; they still show up in older articles and examples.

### Provider comparison for this chapter

| What we need | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Auto-tracing in Langfuse | via OpenTelemetry/our own wrapper or an integration from the Langfuse docs | the `langfuse.openai` import replacement | the same import replacement + `base_url` | the same import replacement + the local server's `base_url` |
| Price in Langfuse | usually in the table | usually in the table | unreliable: we pass `cost_details` ourselves | $0, set manually |
| Built-in Langfuse judge in the UI | yes | yes | most likely not (needs a JSON schema) | not for Cloud (localhost is unreachable) |
| promptfoo provider | `anthropic:...` | `openai:...` | `deepseek:<model>` | `ollama:chat:<model>`, `ollama:embeddings:<model>` |
| Default promptfoo judge | may be picked automatically from the key | may be picked automatically from the key | no, we set it explicitly | no, we set it explicitly |
| Where trace data lives | Langfuse Cloud or self-hosted | same | same | same; for customer messages, only self-hosted or with masking |

What we take for the practice: Langfuse Cloud + DeepSeek for Project 3 (the knowledge base is public, the set's questions are made up, self-hosting isn't needed), promptfoo with two providers (`deepseek-flash` and the local `qwen3:4b`) and `deepseek-v4-pro` as the judge. Claude/OpenAI in promptfoo are optional, as a third provider for comparison.

## Learning path

1. [Langfuse docs](https://langfuse.com/docs) → the overview and the observability/tracing section, then [Python SDK overview](https://langfuse.com/docs/observability/sdk/python/overview) and [Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation) (≈40 min). Important: `@observe`, generations with `usage_details` and `flush()` in scripts.
2. We decide: cloud or self-hosted. For self-hosted: [Self-host Langfuse](https://langfuse.com/self-hosting) → the Docker Compose option for local use (≈20 min of reading + time to get it running). In the same section of the documentation it is worth finding data masking in traces.
3. [Langfuse: Evaluation overview](https://langfuse.com/docs/evaluation/overview), then [Datasets](https://langfuse.com/docs/evaluation/experiments/datasets) and [Experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) (≈40 min). The main thing: how a dataset is linked to a run and how scores get onto traces.
4. (For reference) [Langfuse: LLM-as-a-Judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge): the built-in judges in the UI. They are not worth replacing our own validated judge with, but it is useful to see how they work (≈15 min).
5. [promptfoo docs](https://www.promptfoo.dev/docs/intro/) → Intro, then [Getting started](https://www.promptfoo.dev/docs/getting-started/) (≈30 min). We pay attention to the structure of `promptfooconfig.yaml`: prompts × providers × tests.
6. In the promptfoo documentation we find the sections on assertions (expected outputs) and on the Python provider (≈20 min).
7. [Langfuse: DeepSeek](https://langfuse.com/integrations/model-providers/deepseek) and [Langfuse: Ollama](https://langfuse.com/integrations/model-providers/ollama) (≈10 min), then [Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) (≈15 min): `cost_details`, custom models with `match_pattern` and the warning about non-standard `usage` fields.
8. [promptfoo: DeepSeek](https://www.promptfoo.dev/docs/providers/deepseek/), [promptfoo: Ollama](https://www.promptfoo.dev/docs/providers/ollama/) and [Model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/) (≈25 min). We pay attention to `passthrough` for thinking, to `defaultTest.options.provider` with the `text`/`embedding` split and to the `defaultTest.provider` trap.

## What to watch out for

- **A forgotten `flush()`**: in a short script the traces never arrive, and it looks as if the integration doesn't work.
- **Double counting**: both the OpenAI import replacement and a manual generation on the same call produce two observations and double the cost.
- **The cost in Langfuse doesn't match ours**: the model wasn't recognized, or the price table has a different price. We check on a single request.
- **The dataset in Langfuse drifted from git.** A reference was fixed in the UI, and `eval/golden.jsonl` still has the old one. Edits only in git; in Langfuse, a new version of the dataset.
- **Secrets in traces.** Anything passed to a function under `@observe` can end up in the UI. We don't pass objects holding keys there.
- **promptfoo and cost.** A matrix of 2 prompts × 2 models × 80 tests × `llm-rubric` = hundreds of calls. We start with 10 tests.
- **`llm-rubric` is an unvalidated judge.** Serious conclusions need our own judge, validated in [AIL-29](AIL-29.md), through a `python` assertion.
- **Don't drown in the tool.** The goal of the task is to see the requests and get the first number, not to configure every feature of the platform.
- **$0 for DeepSeek in Langfuse**, or a doubled cost because of the cache fields. We check against `eval/cost.py` and pass `cost_details` ourselves.
- **The built-in Langfuse judge won't save** with DeepSeek: it needs a JSON schema, and DeepSeek documents only `json_object`. This isn't our bug; the judge lives in our code.
- **promptfoo without an explicit judge**, with only `DEEPSEEK_API_KEY`, doesn't know whom to call for `llm-rubric`. Always set `defaultTest.options.provider`.
- **An answering model in `defaultTest.provider`** silently becomes its own judge.
- **Customer messages in cloud traces.** The set's made-up questions can go to Langfuse Cloud; real customer messages (phone, email, order number) and anything where the shop's database snapshot appears get no Langfuse Cloud without masking. Options: self-hosted Langfuse (if there is enough memory), masking before sending, or local files and promptfoo.
- **Self-hosted Langfuse on 8 GB** pushes Ollama and other programs out of memory. Public data doesn't need it.

## Practice

- [ ] Choose a Langfuse option (cloud or Docker Compose) and write the choice and the reason in `notes/evals.md`. For self-hosted: pin the image tags.
- [ ] Add `langfuse` with a pinned version to `pyproject.toml` (`uv add "langfuse==<version>"`), keys go into `.env` (check that `.env` is in `.gitignore`).
- [ ] Wrap the RAG pipeline: `ask` → `retrieve` → (`rerank`) → `generate`, with `usage_details` and the model on the generation.
- [ ] Ask 5 questions from the set (for example, "can I return opened tea?", "what is the warranty on LAMP-LIGHT-MINI?") and open the UI: the tree of steps, the prompt, the retrieved chunks with a `url` like `kb/<file>.md#<anchor>`, tokens, cost and time are visible. Check the cost of one request against our script's calculation.
- [ ] A script `eval/to_langfuse.py`: uploads the dev part of `eval/golden.jsonl` as the dataset `support-kb-dev-v<N>` (input = question, expected_output = reference, metadata = type, category, `must_include`, citations).
- [ ] Run an experiment over the dataset with the correctness evaluator (our judge) and look at the result in the UI. Write down the first quality number and the total cost of the run.
- [ ] Install promptfoo with a pinned version (`npx promptfoo@<version> init` in the project's `promptfoo/` folder).
- [ ] Write `promptfoo/provider.py`, which calls our RAG with the prompt from promptfoo.
- [ ] Take 10–15 questions from dev and compare two answer prompts (for example, `answer_v1.txt` and `answer_v2.txt` with a stricter citation requirement). Assertions: `icontains` on the key fact from `must_include`, `llm-rubric` on citations, `latency`.
- [ ] `promptfoo view`: look at the matrix; write in `notes/evals.md` which prompt is better and how the tool is more or less convenient than our script.
- [ ] RAG tracing on DeepSeek: a `langfuse.openai.OpenAI` client with `base_url="https://api.deepseek.com"`; pass `cost_details` from `eval/cost.py` to the generation. Check the cost in the UI against DeepSeek billing on one request.
- [ ] Add a second provider to promptfoo: a local model `ollama:chat:<tag>` sized to the RAM (8 GB: 3–4B, 16 GB: 7–8B, 32 GB+: 14B), set `deepseek-v4-pro` as the judge in `defaultTest.options.provider` (`text`), and `ollama:embeddings:<tag>` as the embeddings for `similar`. Before running, check `ollama ps`: the context fits 5 chunks.
- [ ] Look at the "DeepSeek vs local model" matrix in `promptfoo view` on 10–15 questions; write down where the local model fails (format, links, refusal, facts).
- [ ] (Optional, for comparison) A third provider, `anthropic:...` or `openai:...`, on the same 10–15 questions.

## Done when

- The Langfuse UI shows every assistant request as a tree of steps with cost and time.
- The set is uploaded as a dataset, an experiment has been run over it, and there is a first quality number.
- promptfoo has compared two prompts, and the conclusion is written down.

## Self-check quiz

1. How does a trace differ from a generation in Langfuse?
2. Which problem does promptfoo solve, and which does Langfuse?
3. The script finished, but the Langfuse UI is empty. What is the most common cause?
4. Why does `eval/golden.jsonl` in git remain the source of truth for the set, rather than the dataset in Langfuse?
5. Langfuse shows a request cost of $0, although the tokens are recorded. What should be checked?
6. What is wrong with this snippet?
   ```python
   from langfuse.openai import OpenAI
   client = OpenAI(api_key="sk-proj-abc123...")

   @observe(as_type="generation")
   def generate(q):
       r = client.chat.completions.create(model=M, messages=[...])
       langfuse.update_current_generation(usage_details={...})
       return r
   ```
7. Why pin the version with `npx promptfoo@<version>` instead of `@latest`?
8. Which promptfoo assertion option fits for checking an answer with our own already validated judge?
   a) `contains`; b) `llm-rubric`; c) `python`; d) `latency`.
9. When is self-hosted Langfuse preferable to the cloud?
10. Why can a promptfoo matrix turn out unexpectedly expensive?
11. Langfuse shows the cost of `deepseek-flash` requests as $0 (or suspiciously high). Why, and how to do it right?
12. Why might the built-in LLM-as-a-judge in the Langfuse UI fail to save with DeepSeek as the judge model, and what to do instead?
13. What is wrong with this promptfoo config?
    ```yaml
    defaultTest:
      provider: deepseek:deepseek-flash
      assert:
        - type: llm-rubric
          value: Answer is grounded in the excerpts.
    ```

## Answers

1. A trace is the whole user request; a generation is one observation inside it, a model call with the model, tokens and cost.
2. promptfoo is offline comparison of variants (prompts, models) on a set of tests from the CLI. Langfuse is observability: traces of every request, datasets, runs and scores in a UI.
3. `flush()` wasn't called before a short script exited (or the keys/host aren't set in the environment).
4. Git gives versions, review of changes and a link to the code; edits in the UI are easy to lose, and they don't get into the experiment history.
5. Whether the model is recognized in the Langfuse price table (the model name must match) and whether a price is set for it; if needed, set the price manually.
6. The key is hardcoded in the code (it should be in the environment); double counting: the wrapped client already logs the generation, and the manual generation via the decorator duplicates it; `langfuse` and `observe` are not imported; the raw response object is returned and will end up in the trace in full.
7. So as not to suddenly get a new version with different behavior or a compromised release; reproducibility and security.
8. **c.** A Python assertion calls our judge function; `llm-rubric` is promptfoo's judge, which we haven't validated.
9. When data must not be sent to a third party (real customer messages with personal data, the shop's database snapshot, company requirements) and masking is not enough, or full control is needed; at the cost of maintaining infrastructure and the machine's memory.
10. The number of calls = prompts × providers × tests, plus judge calls for every `llm-rubric`; it grows quickly.
11. The model may be missing from the Langfuse price table ($0), and the non-standard cache fields in DeepSeek's `usage` prevent Langfuse from splitting out cached tokens correctly (double counting is possible). Compute the cost in our own code, accounting for the cache and peak hours, and pass `cost_details`, or create a custom model with prices.
12. When saving an evaluator, Langfuse checks that the model returns structured output by JSON schema; DeepSeek documents only `json_object`. Run our own judge in code and attach the verdicts as scores via the SDK.
13. The answering model is set in `defaultTest.provider`, and no judge for `llm-rubric` is set explicitly: according to the promptfoo documentation, this provider becomes the fallback judge, and `deepseek-flash` will grade itself. The answering model goes in `providers`, the judge (for example, `deepseek:deepseek-v4-pro` without thinking) in `defaultTest.options.provider`.

## What's next

Week 7 is a buffer, and in week 8 Project 3 moves on to experiments, starting with [AIL-62 · Eval statistics: noise and sample size](AIL-62.md): how to tell a real improvement from noise before running experiments.
