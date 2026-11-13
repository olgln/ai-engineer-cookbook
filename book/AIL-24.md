# 5.4 · Проект 2: версия на LlamaIndex, сравнение  (AIL-24)

> **Неделя 5** · RAG · ⏱ ~5 ч · Проект

## Зачем это AI-инженеру

В вакансиях часто встречаются LlamaIndex и LangChain, и на собеседовании спросят: «ты пользовался фреймворками? когда бы ты их не взял?». Хороший ответ — не «да, знаю», а «я собрал один и тот же RAG руками и на LlamaIndex и вот что увидел в цифрах». Фреймворк ускоряет старт и даёт готовые интеграции, но прячет детали и усложняет отладку. Цель главы — получить собственное, обоснованное мнение.

## Теория

### Что такое LlamaIndex

LlamaIndex — Python-фреймворк для приложений «LLM + твои данные». Он даёт готовые блоки для каждого этапа той самой цепочки из AIL-59 и общие интерфейсы, чтобы блоки менять местами (другая векторная БД, другая модель эмбеддингов, другая LLM — замена одной строки).

Соответствие твоей ручной версии и абстракций LlamaIndex:

| Твоя ручная версия | LlamaIndex |
|---|---|
| Markdown страницы + метаданные | `Document` (text + `metadata`, стабильный `id_`) |
| Чанк | `Node` / `TextNode` (с метаданными и связями с документом и соседями) |
| `chunk.py` (по заголовкам) | Node parser: `MarkdownNodeParser`, `SentenceSplitter` и др. |
| `ingest.py` с дедупликацией по хэшу | `IngestionPipeline` (transformations + docstore + vector store, кэш) |
| `embed.py` | Embedding model (`Settings.embed_model`), интеграции OpenAI/HuggingFace/… |
| `store.py` (sqlite-vec) | Vector store (встроенный в памяти, Qdrant, pgvector, Chroma, …) |
| `search()` с фильтром биржи | Retriever + `MetadataFilters` |
| BM25 + RRF | `BM25Retriever` + `QueryFusionRetriever` (режим reciprocal rank) |
| `rerank()` | Node postprocessor (например, `SentenceTransformerRerank`) |
| `plan_query` (multi-query) | `QueryFusionRetriever` с генерацией запросов; HyDE — `HyDEQueryTransform` |
| `answer()` с `[n]` | Response synthesizer / Query engine; `CitationQueryEngine` |
| `ask()` | `index.as_query_engine(...)` / `RetrieverQueryEngine` |

Многие интеграции живут в отдельных пакетах (`llama-index-embeddings-huggingface`, `llama-index-llms-anthropic`, `llama-index-retrievers-bm25`, `llama-index-vector-stores-qdrant` …) — ставишь только нужные. API фреймворка меняется быстрее, чем API провайдеров: **все примеры ниже иллюстративны, сверяй импорты и имена классов с текущей документацией**.

### Минимальный RAG на LlamaIndex

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
    Document(text=page.markdown, id_=page.url,
             metadata={"exchange": page.exchange, "url": page.url})
    for page in load_clean_pages()          # reuse your fetch/clean from AIL-20
]
nodes = MarkdownNodeParser().get_nodes_from_documents(docs)
index = VectorStoreIndex(nodes)

engine = index.as_query_engine(similarity_top_k=5)
resp = engine.query("Как в OKX указать сторону позиции в hedge mode?")
print(resp)                                  # answer text
for sn in resp.source_nodes:                 # retrieved chunks with scores
    print(sn.score, sn.node.metadata["url"])
```

Десяток строк — и рабочий RAG. Это и есть главный аргумент фреймворков. Обрати внимание: ты **переиспользуешь** свои `fetch`/`clean` из AIL-20 — честное сравнение касается chunking/индекса/поиска/ответа, а не скачивания.

### Ingestion pipeline и дедупликация

`IngestionPipeline` применяет цепочку преобразований (парсер → извлечение метаданных → эмбеддинги) и, если подключить docstore, при повторной загрузке пропускает документы с тем же `id_` и тем же хэшем содержимого, а изменённые — обновляет. Это аналог твоей логики `doc_hash` из AIL-20. Ключевое условие — **стабильный `id_` документа** (URL), иначе дедупликация не сработает — та же ошибка, что `uuid4()` в ключе чанка.

### Гибрид, фильтры, реранкинг

```python
# Illustrative: check the current names in docs.llamaindex.ai
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.postprocessor import SentenceTransformerRerank
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.vector_stores import MetadataFilters, ExactMatchFilter
from llama_index.retrievers.bm25 import BM25Retriever

filters = MetadataFilters(filters=[ExactMatchFilter(key="exchange", value="okx")])
vector_r = index.as_retriever(similarity_top_k=20, filters=filters)
bm25_r = BM25Retriever.from_defaults(nodes=okx_nodes, similarity_top_k=20)

fusion = QueryFusionRetriever(
    [vector_r, bm25_r],
    mode="reciprocal_rerank",   # RRF, as in AIL-22
    num_queries=3,              # LLM generates extra queries, as in AIL-60
    similarity_top_k=20,
)
rerank = SentenceTransformerRerank(model=os.environ["RERANK_MODEL"], top_n=5)
engine = RetrieverQueryEngine.from_args(fusion, node_postprocessors=[rerank])
```

Посмотри, как каждая строка соответствует главе плана: фильтр (AIL-20/60), BM25 + RRF (AIL-22), генерация запросов (AIL-60), реранкер (AIL-22). Ты понимаешь, что происходит внутри — потому что делал это руками. Человек, начавший с фреймворка, видит здесь только магические параметры.

### Цитаты

`CitationQueryEngine` нарезает найденные куски на пронумерованные источники и просит модель ставить ссылки `[n]` — похоже на твой AIL-23. Но промпт внутри — **чужой**. Чтобы добиться твоего поведения (фиксированная фраза отказа, правило про конфликт бирж, ответ на языке вопроса), придётся найти и переопределить шаблон промпта. Это типичный момент, где фреймворк начинает мешать: нужно знать, какой шаблон за что отвечает и как его подменить.

### Отладка и наблюдаемость

Главный вопрос при отладке RAG — «что именно ушло в модель?». В ручной версии это переменная, которую можно напечатать. В LlamaIndex — внутренности query engine. Инструменты:

- `resp.source_nodes` — что было найдено и с какими скорами;
- включить подробное логирование (`logging` уровня DEBUG) — увидишь шаги и промпты;
- встроенная система callbacks/instrumentation и интеграции с внешними сервисами трассировки (подробнее — в главах про наблюдаемость и production);
- `engine.get_prompts()` — посмотреть промпт-шаблоны, которые использует движок, и `update_prompts()` — подменить.

### Как сравнивать честно

Критерии из задачи и как их измерить:

| Критерий | Как измерить |
|---|---|
| Качество поиска | hit@3, hit@5, MRR на тех же 20 вопросах (`resp.source_nodes` → та же функция `must_contain`) |
| Качество ответа | та же ручная таблица из AIL-23 на 13 вопросах (корректность, цитаты, отказ) |
| Объём кода | строки своего кода без тестов (`wc -l` или `cloc`) для эквивалентной функциональности |
| Скорость | латентность p50 на вопрос; время индексации |
| Понятность при отладке | возьми 2 неудачных вопроса и засеки, сколько минут ушло, чтобы понять причину в каждой версии |
| Зависимости | число пакетов в окружении (`pip list | wc -l`), размер |

Правила честного сравнения:

- **Одни и те же входы:** тот же очищенный Markdown, та же модель эмбеддингов, та же LLM, тот же реранкер. Иначе ты сравниваешь модели, а не код.
- **Сопоставимый chunking.** `MarkdownNodeParser` режет не так, как твой `chunk.py` (breadcrumbs!). Либо добавь breadcrumbs в метаданные/текст узлов, либо явно отметь разницу в выводах. Лучше — оба варианта: «из коробки» и «настроенный».
- **Одинаковые k** на каждом этапе.
- **Одинаковый golden set** и функция оценки.

### Когда фреймворк, когда руками

| Фреймворк хорош | Ручная версия лучше |
|---|---|
| Прототип за день, нужно показать идею | Небольшой пайплайн, который надо понимать до строки |
| Много источников данных (готовые loaders) | Нестандартный chunking, особые метаданные |
| Нужно быстро перебрать векторные БД / модели | Жёсткие требования к латентности, контролю промптов |
| Команда уже на нём | Нужна простая отладка и минимум зависимостей |
| Нужны готовые продвинутые режимы (агенты, роутинг) | Обучение: понять, как всё устроено |

Частый зрелый ответ: «прототип на фреймворке, а критичный путь — на тонком собственном коде поверх SDK провайдера» — или гибрид, где из фреймворка берут только отдельные полезные куски (loaders, parsers). Твой вывод должен опираться на твои цифры, а не на эту таблицу.

## DeepSeek и Ollama: как это сделать у нас

Смена провайдера в LlamaIndex — это замена `Settings.embed_model` и `Settings.llm`. Для честного сравнения обе версии должны использовать **те же** модели, что и ручная: эмбеддинги из Ollama (или Sentence Transformers), генерацию на DeepSeek.

### Эмбеддинги: Ollama или Hugging Face

```python
# Illustrative: pip install llama-index-embeddings-ollama (pin the version)
from llama_index.embeddings.ollama import OllamaEmbedding

Settings.embed_model = OllamaEmbedding(
    model_name=os.environ["EMBED_MODEL"],     # e.g. bge-m3, same as the manual version
    base_url="http://localhost:11434",
)
```

Если в ручной версии ты эмбеддишь через Sentence Transformers, оставь `HuggingFaceEmbedding` из «Теории» с той же моделью. Бэкенд должен совпадать с ручной версией, иначе ты сравниваешь модели, а не фреймворк (глава 4.1: `ollama:bge-m3` и `st:BAAI/bge-m3` — не одно и то же).

### LLM: DeepSeek — два пути

1. **Отдельная интеграция** `llama-index-llms-deepseek` (`from llama_index.llms.deepseek import DeepSeek`; ключ из `DEEPSEEK_API_KEY`). Осторожно: на ноябрь 2026 [её страница в документации LlamaIndex](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) показывает старые имена моделей (`deepseek-chat`, `deepseek-reasoner`), а в API DeepSeek сейчас `deepseek-flash` и `deepseek-v4-pro`. Проверь, что интеграция принимает текущее имя модели и умеет передавать `thinking` (если нет — переходи ко второму пути).
2. **`OpenAILike`** из пакета `llama-index-llms-openai-like` — тонкая обёртка для любых OpenAI-совместимых API: `model`, `api_base="https://api.deepseek.com"`, `api_key`, `is_chat_model=True`, `context_window`. Она не проверяет имя модели по списку OpenAI, поэтому с новыми именами DeepSeek проблем меньше. Обычный класс `OpenAI` из LlamaIndex с `api_base` DeepSeek может падать на незнакомом имени модели.

Как выключить рассуждение DeepSeek через обёртку LlamaIndex, зависит от версии интеграции: ищи в ней параметр для дополнительного тела запроса (`extra_body` или аналог) и проверяй фактический запрос в DEBUG-логах. Это хороший пример пункта «чем мешает фреймворк» для твоей таблицы.

### LLM: Ollama

```python
# Illustrative: pip install llama-index-llms-ollama (pin the version)
from llama_index.llms.ollama import Ollama

Settings.llm = Ollama(
    model=os.environ["ANSWER_MODEL_LOCAL"],   # e.g. qwen3:4b on an 8 GB Mac
    request_timeout=120.0,                    # default is 30 s; local generation can be slower
    context_window=8000,                      # limit memory use; must fit your 5 chunks + prompt
)
```

Память на твоём M2 с 8 GB (на нём же работает арбитражное приложение): по умолчанию модель класса 4B (`qwen3:4b`, ~2.5 GB). 7–8B — только когда всё остальное закрыто и автоторговля не включена, 14B+ — никогда. `context_window` здесь влияет не только на качество, но и на память: чем больше окно, тем больше RAM. LlamaIndex-версия на Ollama-LLM держит в памяти сразу эмбеддинг-модель, генератор и реранкер. Посмотри `ollama ps` и Мониторинг системы, прежде чем запускать eval на 20 вопросах.

По [странице интеграции](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/) у `Ollama` есть ещё `thinking` (рассуждение thinking-моделей) и `json_mode`.

### Скрытые вызовы LLM стоят по-разному

`QueryFusionRetriever(num_queries=3)` и некоторые синтезаторы ответа зовут LLM неявно. На DeepSeek это деньги и сетевые задержки (и рассуждение по умолчанию, если его не выключить), на Ollama — секунды твоего Mac. Логируй число вызовов LLM на вопрос в обеих версиях — это строка в таблице сравнения.

### Сравнение провайдеров для этой главы

| Что нужно | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| LLM-интеграция LlamaIndex | `llama-index-llms-anthropic` | `llama-index-llms-openai` | `llama-index-llms-deepseek` (проверь имена моделей) или `OpenAILike` | `llama-index-llms-ollama` |
| Эмбеддинги в LlamaIndex | Нет своих | `llama-index-embeddings-openai` | **Нет** → Ollama / Hugging Face | `llama-index-embeddings-ollama` |
| Особые параметры через обёртку | — | — | `thinking` — проверь, как передать | `thinking`, `json_mode`, `request_timeout`, `context_window` |
| Дефолт фреймворка, если ничего не задать | — | LlamaIndex по умолчанию тянется к OpenAI и ищет его ключ | — | — |

### Что использовать в практике

Основной вариант — ручная и LlamaIndex-версии на одинаковых Ollama-эмбеддингах и DeepSeek-генерации. LlamaIndex на Ollama-LLM — полностью офлайн-вариант, по желанию. Claude через `llama-index-llms-anthropic` из «Теории» — «для сравнения». `Settings.llm` и `Settings.embed_model` задавай явно всегда: иначе фреймворк может пойти к дефолтному провайдеру.

## Маршрут изучения

1. Открой [LlamaIndex docs](https://docs.llamaindex.ai) → Getting Started: установка и starter tutorial (≈40 мин). Сделай starter на 3 страницах своих доков, не на их примере. Обрати внимание на структуру пакетов (core + интеграции) и `Settings`.
2. Там же → раздел High-Level Concepts / Understanding: Loading, Indexing, Querying (≈30 мин). Сопоставь каждый концепт со строкой таблицы соответствий выше.
3. Там же → Ingestion Pipeline: transformations, docstore, кэш, управление документами (дедупликация по `id_`) (≈30 мин). Вынеси, как добиться, чтобы повторная загрузка не дублировала узлы.
4. Там же → Query Engine и Retrievers: `as_query_engine`, `RetrieverQueryEngine`, metadata filters, BM25 retriever, Query Fusion (reciprocal rerank), node postprocessors / rerankers, Citation Query Engine (≈45 мин). Найди раздел про кастомизацию промптов (`get_prompts`/`update_prompts`).
5. Там же → раздел про observability / logging (≈15 мин): как увидеть промпт, который ушёл в модель.
6. Там же → интеграции: [Ollama Embeddings](https://developers.llamaindex.ai/python/framework/integrations/embeddings/ollama_embedding/), [Ollama LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/), [DeepSeek LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) и справка по `OpenAILike` в API reference (≈25 мин). Вынеси имена пакетов, классов и параметров. Сверь имена моделей в примерах с текущей [страницей моделей DeepSeek](https://api-docs.deepseek.com/quick_start/pricing).

## На что обратить внимание

- **Версии и импорты.** Половина примеров в интернете — со старыми путями импорта (до разделения на `llama_index.core` и пакеты интеграций). Доверяй только текущей документации; зафиксируй версии в `requirements.txt`.
- **Скрытые вызовы LLM.** Некоторые компоненты (генерация запросов в fusion, извлечение метаданных, некоторые синтезаторы ответа) зовут LLM неявно — это стоимость и латентность. Смотри логи.
- **Дефолтная LLM / эмбеддинги.** Если не задать `Settings.llm` и `Settings.embed_model`, фреймворк может попытаться использовать дефолтного провайдера и искать соответствующий ключ в окружении. Задавай явно.
- **Режим синтеза ответа.** Некоторые режимы делают несколько вызовов LLM на один вопрос (например, уточняют ответ кусок за куском). Выбери тот, что соответствует твоей ручной версии (один вызов со всеми кусками), иначе сравнение латентности нечестное.
- **Чужие промпты.** Поведение отказа и формат цитат по умолчанию не твои — без подмены шаблонов eval AIL-23 может упасть не из-за поиска.
- **Индекс в памяти** по умолчанию — при перезапуске всё пересчитывается. Для честного замера скорости индексации и запроса используй persist или внешний vector store.
- **Не тащи ключи** в код и не логируй полные запросы с ключами при DEBUG-логах.

## Практика

Папка `exchange-docs-rag/llamaindex_version/`, отдельный `requirements-llamaindex.txt` (чтобы не засорять основное окружение — или отдельный venv).

- [ ] **Starter.** `li_starter.py`: 3 страницы, `VectorStoreIndex`, `as_query_engine`, один вопрос. Распечатай `source_nodes`.
- [ ] **Провайдеры.** В `li_settings.py` явно задай `Settings.embed_model` (Ollama `OllamaEmbedding` или `HuggingFaceEmbedding` — тот же бэкенд и модель, что в ручной версии) и `Settings.llm` (DeepSeek через `OpenAILike` или `llama-index-llms-deepseek`). Версии пакетов — зафиксированы в `requirements-llamaindex.txt`. В DEBUG-логе проверь, что запросы уходят на `api.deepseek.com` и `localhost:11434`, а не в OpenAI.
- [ ] **Ingestion.** `li_ingest.py`: тот же очищенный Markdown 4 бирж, `Document` с `id_=url` и метаданными `exchange`, `url`, `section`; `IngestionPipeline` с парсером и эмбеддингами той же модели, что в ручной версии; persist на диск. Проверь: второй запуск не добавляет узлов.
- [ ] **Поиск.** `li_search.py`: retriever с фильтром по бирже, BM25 retriever, fusion (RRF) и реранкер — та же конфигурация, что победила в AIL-22. Подключи свою функцию определения биржи из AIL-60 (переиспользуй код).
- [ ] **Ответ.** `li_answer.py`: `CitationQueryEngine` или `RetrieverQueryEngine` с подменённым промпт-шаблоном (твой системный промпт из AIL-23, фраза отказа). Убедись через `get_prompts()`, что шаблон действительно подменён.
- [ ] **Eval тем же скриптом.** Адаптер `li_adapter.py`: функции `retrieve(question) -> list[str]` и `ask(question) -> Answer` с той же сигнатурой, что в ручной версии, — чтобы `eval/run_retrieval_eval.py` и таблица AIL-23 запускались без изменений.
- [ ] **Замеры.** Строки кода (`cloc rag/` vs `cloc llamaindex_version/`), латентность p50, время полной индексации, число пакетов в окружении.
- [ ] **Отладочный эксперимент.** Выбери 2 вопроса, где хотя бы одна версия ошиблась. В каждой версии найди причину и засеки время. Запиши, какие инструменты использовал.
- [ ] **Раздел README «Ручная версия vs LlamaIndex»**:

  | Критерий | Ручная | LlamaIndex (из коробки) | LlamaIndex (настроенный) |
  |---|---|---|---|
  | hit@3 / hit@5 / MRR | | | |
  | Ответы: корректно / с цитатами / отказы (из 13) | | | |
  | Строк кода | | | |
  | p50 латентность | | | |
  | Время индексации | | | |
  | Время на отладку 2 ошибок | | | |
  | Зависимостей | | | |
  | Вызовов LLM на вопрос | | | |

  И 5–10 предложений вывода: какую версию оставляешь основной и почему, что из фреймворка понравилось и что мешало (включая то, насколько легко было подключить DeepSeek и Ollama и передать специфичные параметры вроде выключения рассуждения).
- [ ] **(Для сравнения, по желанию)** Замени `Settings.llm` на Claude (`llama-index-llms-anthropic`) и прогони 13 вопросов: сколько строк кода поменялось и как изменились ответы?

## Готово, когда

- LlamaIndex-версия работает на тех же 4 биржах, с фильтром, гибридом и реранкером, отвечает со ссылками и отказывает «вне доков».
- Обе версии прогнаны тем же eval-скриптом на тех же 20 (поиск) и 13 (ответы) вопросах.
- В README есть раздел «Ручная версия vs LlamaIndex» с таблицей и обоснованным выводом, какую версию оставить и почему.

## Тест для самопроверки

1. Как в LlamaIndex называются аналоги твоих «страницы» и «чанка»?
2. Что делает `IngestionPipeline` с docstore при повторной загрузке, и какое условие для этого обязательно?
3. Какой компонент LlamaIndex соответствует твоему BM25 + RRF из AIL-22?
4. Почему для честного сравнения нужно использовать одну и ту же модель эмбеддингов и LLM в обеих версиях?
5. Что не так в этом коде?
   ```python
   docs = [Document(text=p.markdown, metadata={"exchange": p.exchange}) for p in pages]
   pipeline = IngestionPipeline(transformations=[parser, embed_model], docstore=docstore)
   pipeline.run(documents=docs)   # runs every night
   ```
6. Где LlamaIndex чаще всего «мешает» в задаче RAG с цитатами? a) загрузка Markdown b) кастомный промпт отказа и формат цитат c) вычисление косинуса d) установка пакетов
7. Как увидеть, какой именно промпт LlamaIndex отправил в модель?
8. Почему LlamaIndex-версия может оказаться медленнее ручной при той же конфигурации поиска? Назови две возможные причины.
9. В каких ситуациях ты выбрал бы фреймворк, а в каких — ручную версию? По одному примеру.
10. Почему в интернете много неработающих примеров LlamaIndex и как от этого защититься?
11. Ты подключил DeepSeek через класс `OpenAI` из LlamaIndex, указав `api_base="https://api.deepseek.com"` и `model="deepseek-flash"`, и получил ошибку про неизвестную модель. Что использовать вместо этого?
12. Ты не задал `Settings.embed_model`, а ключа OpenAI в окружении нет. Что, скорее всего, произойдёт, и почему для стека «DeepSeek + Ollama» это важно?
13. Почему LlamaIndex-версия должна эмбеддить через тот же бэкенд (Ollama или Sentence Transformers), что и ручная, а не просто «ту же модель bge-m3»?

## Ответы

1. `Document` (страница с метаданными и `id_`) и `Node`/`TextNode` (чанк).
2. Пропускает документы с тем же `id_` и неизменённым содержимым, обновляет изменённые. Обязательно — стабильный `id_` у документа (например, URL).
3. `QueryFusionRetriever` в режиме reciprocal rerank поверх векторного retriever'а и `BM25Retriever`.
4. Иначе разница в качестве и скорости объясняется моделями, а не кодом/фреймворком — сравнение теряет смысл.
5. У `Document` нет стабильного `id_` (он генерируется случайно), поэтому docstore не узнает документ при повторном запуске, и каждую ночь узлы будут дублироваться; также в метаданных нет `url`, нужного для цитат.
6. b). Поведение по умолчанию задают встроенные шаблоны промптов; чтобы получить свой отказ и цитаты, их надо найти и подменить.
7. Через `engine.get_prompts()` (шаблоны), подробное логирование/инструментацию (фактические вызовы) и `source_nodes` (что было в контексте).
8. Скрытые дополнительные вызовы LLM (генерация запросов, многошаговый синтез ответа); индекс в памяти без persist, пересчитываемый при старте; накладные расходы абстракций и другая конфигурация по умолчанию.
9. Фреймворк — быстрый прототип с множеством источников данных или перебор векторных БД; ручная — небольшой критичный пайплайн, где нужны полный контроль промптов, простая отладка и минимум зависимостей.
10. API фреймворка быстро меняется (например, разделение на `llama_index.core` и пакеты интеграций), старые примеры используют устаревшие импорты. Защита — только текущая документация и фиксированные версии в requirements.
11. `OpenAILike` (`llama-index-llms-openai-like`) с `api_base`, `api_key`, `is_chat_model=True` — он не проверяет имя по списку моделей OpenAI. Или интеграцию `llama-index-llms-deepseek`, если она принимает текущие имена моделей.
12. Фреймворк попробует дефолтного провайдера эмбеддингов (OpenAI) и упадёт без ключа, а с ключом молча отправит тексты в OpenAI. В нашем стеке эмбеддинги должны быть локальными (у DeepSeek их нет), поэтому `Settings.embed_model` задают явно.
13. Сборки одной и той же модели в Ollama и в Sentence Transformers — разные рантаймы, и их векторы могут отличаться. Если бэкенды разные, разница в цифрах может объясняться ими, а не фреймворком.

## Что дальше

Остался финальный шаг проекта: [AIL-25 · Проект 2: README и GitHub](AIL-25.md) — чтобы проект можно было запустить с нуля и показать на собеседовании.
