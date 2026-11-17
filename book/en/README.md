# AI Engineer Cookbook

Chapters in reading order: number = week.order.

## Week 1 · Python + the first API

- [1.1 · Python for developers who already code](AIL-1.md)
- [1.2 · A study repository: git, notes/, structure](AIL-56.md)
- [1.3 · Python: uv, async, Pydantic](AIL-2.md)
- [1.4 · Jupyter notebooks in VS Code](AIL-57.md)
- [1.5 · How LLMs work: Karpathy's lecture and API keys](AIL-3.md)
- [1.6 · The raw API: first requests to Claude and OpenAI](AIL-4.md)
- [1.7 · Tokens, temperature and the cost of an LLM request](AIL-5.md)

## Week 2 · Prompting and tool calling

- [2.1 · Prompting: roles, few-shot, structure](AIL-7.md)
- [2.2 · Structured output: Pydantic + Instructor](AIL-8.md)
- [2.3 · How to choose an LLM: models and providers](AIL-58.md)
- [2.4 · OpenRouter: one API for many models](AIL-69.md)
- [2.5 · The first eval: extracting JSON from 20 texts](AIL-9.md)
- [2.6 · Tool calling: the model calls 3 functions](AIL-10.md)
- [2.7 · Streaming, retries, rate limits, prompt caching](AIL-11.md)

## Week 3 · Project 1: a bot

- [3.1 · Project 1: LLM bot architecture and a database copy](AIL-13.md)
- [3.2 · Project 1: read-only tools for the LLM](AIL-14.md)
- [3.3 · Project 1: tool calling + Telegram](AIL-15.md)
- [3.4 · Project 1: cost logging, README, GitHub](AIL-16.md)

## Week 4 · Embeddings and a vector database

- [4.1 · Embeddings by hand with numpy](AIL-18.md)
- [4.2 · How RAG works: an architecture overview](AIL-59.md)
- [4.3 · Chunking: comparing 3 strategies](AIL-19.md)
- [4.4 · A vector database + loading the knowledge base](AIL-20.md)

## Week 5 · Project 2: RAG

- [5.1 · Query rewriting in RAG: multi-query, HyDE, filters](AIL-60.md)
- [5.2 · Hybrid search (BM25) and reranking](AIL-22.md)
- [5.3 · Project 2: RAG answers with source citations](AIL-23.md)
- [5.4 · Project 2: a LlamaIndex version, a comparison](AIL-24.md)
- [5.5 · Project 2: a README of the RAG assistant for GitHub](AIL-25.md)

## Week 6 · Evals: a dataset and a script

- [6.1 · LLM evals: the key articles and LLM-as-judge](AIL-27.md)
- [6.2 · Synthetic data for evals](AIL-61.md)
- [6.3 · Golden dataset: 50–100 questions with reference answers](AIL-28.md)
- [6.4 · A RAG evaluation script: retrieval and faithfulness](AIL-29.md)
- [6.5 · LLM observability: Langfuse and promptfoo](AIL-30.md)

## Week 7 · Project 3: experiments

- [7.1 · Eval statistics: noise and sample size](AIL-62.md)
- [7.2 · A chunking experiment in RAG: A vs B](AIL-32.md)
- [7.3 · An experiment: choosing the model and a reranker for RAG](AIL-33.md)
- [7.4 · Error analysis: reviewing the errors of an LLM system by hand](AIL-34.md)
- [7.5 · Project 3: an experiments table in the README](AIL-35.md)

## Week 8 · Agents and MCP

- [8.1 · AI agents: Building effective agents and the OWASP LLM Top 10](AIL-37.md)
- [8.2 · Workflow patterns: chaining, routing, parallelization](AIL-63.md)
- [8.3 · An AI agent loop by hand, without a framework](AIL-38.md)
- [8.4 · Prompt injection: attacking our own agent](AIL-64.md)
- [8.5 · An MCP server for the shop database (read-only)](AIL-39.md)

## Week 9 · Project 4: an agent

- [9.1 · Memory and context of an AI agent](AIL-65.md)
- [9.2 · Project 4: an AI agent that investigates orders](AIL-41.md)
- [9.3 · Project 4: agent evals on 20 cases](AIL-42.md)
- [9.4 · Project 4: a README of the AI agent for GitHub](AIL-43.md)

## Week 10 · Production

- [10.1 · Docker: packaging an LLM project](AIL-66.md)
- [10.2 · Prompt caching, budgets, fallbacks](AIL-45.md)
- [10.3 · Tracing an LLM application and the cost of an answer](AIL-46.md)
- [10.4 · A local LLM with Ollama: a comparison on our own evals](AIL-47.md)
- [10.5 · Fine-tuning: a basic LoRA example](AIL-48.md)
