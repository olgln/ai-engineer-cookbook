# 5.4 · Проект 2: версия на LlamaIndex, сравнение  (AIL-24)

> **Неделя 5** · RAG · ⏱ ~5 ч · Проект

## Зачем это AI-инженеру

В вакансиях часто встречаются LlamaIndex и LangChain, и на собеседовании спросят: «вы пользовались фреймворками? когда бы вы их не взяли?». Хороший ответ — не «да, знаю», а «я собрал один и тот же RAG руками и на LlamaIndex и вот что увидел в цифрах». Фреймворк ускоряет старт и даёт готовые интеграции, но прячет детали и усложняет отладку. Цель главы — получить собственное, обоснованное мнение.

## Теория

### Что такое LlamaIndex

LlamaIndex — Python-фреймворк для приложений «LLM + свои данные». Он даёт готовые блоки для каждого этапа той самой цепочки из AIL-59 и общие интерфейсы, чтобы блоки менять местами (другая векторная БД, другая модель эмбеддингов, другая LLM — замена одной строки).

Соответствие нашей ручной версии и абстракций LlamaIndex:

| Наша ручная версия | LlamaIndex |
|---|---|
| Страница `kb/` + метаданные из front matter | `Document` (text + `metadata`, стабильный `id_`) |
| Чанк | `Node` / `TextNode` (с метаданными и связями с документом и соседями) |
| `chunk.py` (по заголовкам) | Node parser: `MarkdownNodeParser`, `SentenceSplitter` и др. |
| `ingest.py` с дедупликацией по хэшу | `IngestionPipeline` (transformations + docstore + vector store, кэш) |
| `embed.py` | Embedding model (`Settings.embed_model`), интеграции OpenAI/HuggingFace/… |
| `store.py` (sqlite-vec) | Vector store (встроенный в памяти, Qdrant, pgvector, Chroma, …) |
| `search()` с фильтром по категории и без архива | Retriever + `MetadataFilters` |
| BM25 + RRF | `BM25Retriever` + `QueryFusionRetriever` (режим reciprocal rank) |
| `rerank()` | Node postprocessor (например, `SentenceTransformerRerank`) |
| `plan_query` (multi-query) | `QueryFusionRetriever` с генерацией запросов; HyDE — `HyDEQueryTransform` |
| `answer()` с `[n]` | Response synthesizer / Query engine; `CitationQueryEngine` |
| `ask()` | `index.as_query_engine(...)` / `RetrieverQueryEngine` |

Многие интеграции живут в отдельных пакетах (`llama-index-embeddings-huggingface`, `llama-index-llms-anthropic`, `llama-index-retrievers-bm25`, `llama-index-vector-stores-qdrant` …) — ставим только нужные. API фреймворка меняется быстрее, чем API провайдеров: **все примеры ниже иллюстративны, импорты и имена классов сверяем с текущей документацией**.

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
    Document(text=page.text, id_=page.doc,          # doc = "kb/returns.md", stable
             metadata={"category": page.category, "archived": page.archived,
                       "doc": page.doc})
    for page in load_pages("kb")                    # reuse rag/load.py from AIL-20
]
nodes = MarkdownNodeParser().get_nodes_from_documents(docs)
index = VectorStoreIndex(nodes)

engine = index.as_query_engine(similarity_top_k=5)
resp = engine.query("Можно ли вернуть вскрытый чай?")
print(resp)                                         # answer text
for sn in resp.source_nodes:                        # retrieved chunks with scores
    print(sn.score, sn.node.metadata["doc"])
```

Десяток строк — и рабочий RAG. Это и есть главный аргумент фреймворков. Обратим внимание: мы **переиспользуем** свой `load.py` из AIL-20 (front matter → метаданные) — честное сравнение касается chunking/индекса/поиска/ответа, а не чтения файлов. И сразу видна первая разница: `MarkdownNodeParser` ничего не знает о наших явных якорях `{#vozvrat-vskrytogo-chaya}`, поэтому ссылки `kb/returns.md#...` для цитат придётся достраивать самим.

### Ingestion pipeline и дедупликация

`IngestionPipeline` применяет цепочку преобразований (парсер → извлечение метаданных → эмбеддинги) и, если подключить docstore, при повторной загрузке пропускает документы с тем же `id_` и тем же хэшем содержимого, а изменённые — обновляет. Это аналог нашей логики `doc_hash` из AIL-20. Ключевое условие — **стабильный `id_` документа** (путь страницы `kb/returns.md`), иначе дедупликация не сработает — та же ошибка, что `uuid4()` в ключе чанка.

### Гибрид, фильтры, реранкинг

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

Каждая строка соответствует главе плана: фильтр по категории и архиву (AIL-20/60), BM25 + RRF (AIL-22), генерация запросов (AIL-60), реранкер (AIL-22). Мы понимаем, что происходит внутри, — потому что делали это руками. Тот, кто начал с фреймворка, видит здесь только магические параметры. Заметим и мелочь: BM25-retriever не знает о фильтрах векторного индекса, поэтому `returns_nodes` фильтруем сами — забудем, и архивные правила возврата вернутся в выдачу через BM25.

### Цитаты

`CitationQueryEngine` нарезает найденные куски на пронумерованные источники и просит модель ставить ссылки `[n]` — похоже на наш AIL-23. Но промпт внутри — **чужой**. Чтобы добиться нашего поведения (фиксированная фраза отказа и передача вопроса человеку, правило про расхождение страниц — например, порог бесплатной доставки в `delivery.md` и `promo.md`, ответ на языке вопроса), придётся найти и переопределить шаблон промпта. Это типичный момент, где фреймворк начинает мешать: нужно знать, какой шаблон за что отвечает и как его подменить.

### Отладка и наблюдаемость

Главный вопрос при отладке RAG — «что именно ушло в модель?». В ручной версии это переменная, которую можно напечатать. В LlamaIndex — внутренности query engine. Инструменты:

- `resp.source_nodes` — что было найдено и с какими скорами;
- подробное логирование (`logging` уровня DEBUG) — видны шаги и промпты;
- встроенная система callbacks/instrumentation и интеграции с внешними сервисами трассировки (подробнее — в главах про наблюдаемость и production);
- `engine.get_prompts()` — посмотреть промпт-шаблоны, которые использует движок, и `update_prompts()` — подменить.

### Как сравнивать честно

Критерии и как их измерить:

| Критерий | Как измерить |
|---|---|
| Качество поиска | hit@3, hit@5, MRR на тех же 20 вопросах (`resp.source_nodes` → та же функция `must_contain`) |
| Качество ответа | та же ручная таблица из AIL-23 на 13 вопросах (корректность, цитаты, отказ) |
| Объём кода | строки своего кода без тестов (`wc -l` или `cloc`) для эквивалентной функциональности |
| Скорость | латентность p50 на вопрос; время индексации |
| Понятность при отладке | берём 2 неудачных вопроса и засекаем, сколько минут ушло, чтобы понять причину в каждой версии |
| Зависимости | число пакетов в окружении (`pip list | wc -l` или `uv pip list | wc -l`), размер |

Правила честного сравнения:

- **Одни и те же входы:** те же страницы `kb/` с теми же метаданными, та же модель эмбеддингов, та же LLM, тот же реранкер. Иначе сравниваются модели, а не код.
- **Сопоставимый chunking.** `MarkdownNodeParser` режет не так, как наш `chunk.py` (breadcrumbs вроде `Товары > Лампа «Свет» > Гарантия`, якоря, целые таблицы тарифов). Либо добавляем breadcrumbs и `url` в метаданные/текст узлов, либо явно отмечаем разницу в выводах. Лучше — оба варианта: «из коробки» и «настроенный».
- **Одинаковые k** на каждом этапе.
- **Одинаковый golden set** и функция оценки.

### Когда фреймворк, когда руками

| Фреймворк хорош | Ручная версия лучше |
|---|---|
| Прототип за день, нужно показать идею | Небольшой пайплайн, который надо понимать до строки |
| Много источников данных (готовые loaders) | Нестандартный chunking, особые метаданные (`archived`, якоря) |
| Нужно быстро перебрать векторные БД / модели | Жёсткие требования к латентности, контролю промптов |
| Команда уже на нём | Нужна простая отладка и минимум зависимостей |
| Нужны готовые продвинутые режимы (агенты, роутинг) | Обучение: понять, как всё устроено |

Частый зрелый ответ: «прототип на фреймворке, а критичный путь — на тонком собственном коде поверх SDK провайдера» — или гибрид, где из фреймворка берут только отдельные полезные куски (loaders, parsers). Вывод должен опираться на собственные цифры, а не на эту таблицу.

## DeepSeek и Ollama: как это сделать у нас

Смена провайдера в LlamaIndex — это замена `Settings.embed_model` и `Settings.llm`. Для честного сравнения обе версии должны использовать **те же** модели, что и ручная: эмбеддинги из Ollama (или Sentence Transformers), генерацию на DeepSeek. База знаний публичная, поэтому отправлять её куски в DeepSeek можно; настоящие сообщения клиентов в облако не уходят ни в одной версии — тестовые вопросы выдуманы.

### Эмбеддинги: Ollama или Hugging Face

```python
# Illustrative: uv add llama-index-embeddings-ollama (pin the version)
from llama_index.embeddings.ollama import OllamaEmbedding

Settings.embed_model = OllamaEmbedding(
    model_name=os.environ["EMBED_MODEL"],     # e.g. bge-m3, same as the manual version
    base_url="http://localhost:11434",
)
```

Если ручная версия эмбеддит через Sentence Transformers, оставляем `HuggingFaceEmbedding` из «Теории» с той же моделью. Бэкенд должен совпадать с ручной версией, иначе сравниваются модели, а не фреймворк (глава 4.1: `ollama:bge-m3` и `st:BAAI/bge-m3` — не одно и то же).

### LLM: DeepSeek — два пути

1. **Отдельная интеграция** `llama-index-llms-deepseek` (`from llama_index.llms.deepseek import DeepSeek`; ключ из `DEEPSEEK_API_KEY`). Осторожно: на ноябрь 2026 [её страница в документации LlamaIndex](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) показывает старые имена моделей (`deepseek-chat`, `deepseek-reasoner`), а в API DeepSeek сейчас `deepseek-flash` и `deepseek-v4-pro`. Проверяем, что интеграция принимает текущее имя модели и умеет передавать `thinking` (если нет — переходим ко второму пути).
2. **`OpenAILike`** из пакета `llama-index-llms-openai-like` — тонкая обёртка для любых OpenAI-совместимых API: `model`, `api_base="https://api.deepseek.com"`, `api_key`, `is_chat_model=True`, `context_window`. Она не проверяет имя модели по списку OpenAI, поэтому с новыми именами DeepSeek проблем меньше. Обычный класс `OpenAI` из LlamaIndex с `api_base` DeepSeek может падать на незнакомом имени модели.

Как выключить рассуждение DeepSeek через обёртку LlamaIndex, зависит от версии интеграции: ищем в ней параметр для дополнительного тела запроса (`extra_body` или аналог) и проверяем фактический запрос в DEBUG-логах. Это хороший пример пункта «чем мешает фреймворк» для таблицы сравнения.

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

Память: на 8 GB RAM — модель класса 3–4B (по умолчанию `qwen3:4b`, ~2.5 GB), на 16 GB — 7–8B, на 32 GB и больше — 14B и крупнее. На 8 GB 7–8B — только когда браузер, IDE и всё тяжёлое закрыто. `context_window` здесь влияет не только на качество, но и на память: чем больше окно, тем больше RAM. LlamaIndex-версия на Ollama-LLM держит в памяти сразу эмбеддинг-модель, генератор и реранкер. Смотрим `ollama ps` и системный монитор, прежде чем запускать eval на 20 вопросах.

По [странице интеграции](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/) у `Ollama` есть ещё `thinking` (рассуждение thinking-моделей) и `json_mode`.

### Скрытые вызовы LLM стоят по-разному

`QueryFusionRetriever(num_queries=3)` и некоторые синтезаторы ответа зовут LLM неявно. На DeepSeek это деньги и сетевые задержки (и рассуждение по умолчанию, если его не выключить), на Ollama — секунды нашей машины. Логируем число вызовов LLM на вопрос в обеих версиях — это строка в таблице сравнения.

### Сравнение провайдеров для этой главы

| Что нужно | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| LLM-интеграция LlamaIndex | `llama-index-llms-anthropic` | `llama-index-llms-openai` | `llama-index-llms-deepseek` (проверить имена моделей) или `OpenAILike` | `llama-index-llms-ollama` |
| Эмбеддинги в LlamaIndex | Нет своих | `llama-index-embeddings-openai` | **Нет** → Ollama / Hugging Face | `llama-index-embeddings-ollama` |
| Особые параметры через обёртку | — | — | `thinking` — проверить, как передать | `thinking`, `json_mode`, `request_timeout`, `context_window` |
| Дефолт фреймворка, если ничего не задать | — | LlamaIndex по умолчанию тянется к OpenAI и ищет его ключ | — | — |

### Что использовать в практике

Основной вариант — ручная и LlamaIndex-версии на одинаковых Ollama-эмбеддингах и DeepSeek-генерации. LlamaIndex на Ollama-LLM — полностью офлайн-вариант, по желанию. Claude через `llama-index-llms-anthropic` из «Теории» — «для сравнения». `Settings.llm` и `Settings.embed_model` задаём явно всегда: иначе фреймворк может пойти к дефолтному провайдеру.

## Маршрут изучения

1. Открываем [LlamaIndex docs](https://docs.llamaindex.ai) → Getting Started: установка и starter tutorial (≈40 мин). Делаем starter на 3 страницах своей `kb/`, не на их примере. Обратим внимание на структуру пакетов (core + интеграции) и `Settings`.
2. Там же → раздел High-Level Concepts / Understanding: Loading, Indexing, Querying (≈30 мин). Сопоставляем каждый концепт со строкой таблицы соответствий выше.
3. Там же → Ingestion Pipeline: transformations, docstore, кэш, управление документами (дедупликация по `id_`) (≈30 мин). Выносим, как добиться, чтобы повторная загрузка не дублировала узлы.
4. Там же → Query Engine и Retrievers: `as_query_engine`, `RetrieverQueryEngine`, metadata filters, BM25 retriever, Query Fusion (reciprocal rerank), node postprocessors / rerankers, Citation Query Engine (≈45 мин). Находим раздел про кастомизацию промптов (`get_prompts`/`update_prompts`).
5. Там же → раздел про observability / logging (≈15 мин): как увидеть промпт, который ушёл в модель.
6. Там же → интеграции: [Ollama Embeddings](https://developers.llamaindex.ai/python/framework/integrations/embeddings/ollama_embedding/), [Ollama LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/ollama/), [DeepSeek LLM](https://developers.llamaindex.ai/python/framework/integrations/llm/deepseek/) и справка по `OpenAILike` в API reference (≈25 мин). Выносим имена пакетов, классов и параметров. Сверяем имена моделей в примерах с текущей [страницей моделей DeepSeek](https://api-docs.deepseek.com/quick_start/pricing).

## На что обратить внимание

- **Версии и импорты.** Половина примеров в интернете — со старыми путями импорта (до разделения на `llama_index.core` и пакеты интеграций). Доверяем только текущей документации; версии фиксируем в `requirements-llamaindex.txt`.
- **Скрытые вызовы LLM.** Некоторые компоненты (генерация запросов в fusion, извлечение метаданных, некоторые синтезаторы ответа) зовут LLM неявно — это стоимость и латентность. Смотрим логи.
- **Дефолтная LLM / эмбеддинги.** Если не задать `Settings.llm` и `Settings.embed_model`, фреймворк может попытаться использовать дефолтного провайдера и искать соответствующий ключ в окружении. Задаём явно.
- **Режим синтеза ответа.** Некоторые режимы делают несколько вызовов LLM на один вопрос (например, уточняют ответ кусок за куском). Выбираем тот, что соответствует ручной версии (один вызов со всеми кусками), иначе сравнение латентности нечестное.
- **Чужие промпты.** Поведение отказа и формат цитат по умолчанию не наши — без подмены шаблонов eval AIL-23 может упасть не из-за поиска.
- **Архив в выдаче.** Фильтр `archived` нужно повторить везде, где узлы попадают в поиск: в `MetadataFilters` векторного retriever'а и в списке узлов для BM25. Иначе отменённые правила из `returns-2025.md` всплывут в одной из версий, и сравнение покажет разницу, которой нет.
- **Индекс в памяти** по умолчанию — при перезапуске всё пересчитывается. Для честного замера скорости индексации и запроса используем persist или внешний vector store.
- **Ключи не в коде** и не в логах: при DEBUG-логах полные запросы с ключами не сохраняем.

## Практика

Папка `projects/02-support-kb-rag/llamaindex_version/`, отдельный `requirements-llamaindex.txt` (чтобы не засорять основное окружение — или отдельный venv).

- [ ] **Starter.** `li_starter.py`: 3 страницы `kb/`, `VectorStoreIndex`, `as_query_engine`, один вопрос («можно ли вернуть вскрытый чай?»). Печатаем `source_nodes`.
- [ ] **Провайдеры.** В `li_settings.py` явно задаём `Settings.embed_model` (Ollama `OllamaEmbedding` или `HuggingFaceEmbedding` — тот же бэкенд и модель, что в ручной версии) и `Settings.llm` (DeepSeek через `OpenAILike` или `llama-index-llms-deepseek`). Версии пакетов — зафиксированы в `requirements-llamaindex.txt`. В DEBUG-логе проверяем, что запросы уходят на `api.deepseek.com` и `localhost:11434`, а не в OpenAI.
- [ ] **Ingestion.** `li_ingest.py`: те же страницы `kb/` через `load.py`, `Document` с `id_=doc` и метаданными `category`, `archived`, `doc`; у узлов — `url` (`kb/<file>.md#<anchor>`) и `section`; `IngestionPipeline` с парсером и эмбеддингами той же модели, что в ручной версии; persist на диск. Проверяем: второй запуск не добавляет узлов.
- [ ] **Поиск.** `li_search.py`: retriever с фильтром по категории и без архива, BM25 retriever, fusion (RRF) и реранкер — та же конфигурация, что победила в AIL-22. Подключаем свои правила определения категории из AIL-60 (переиспользуем код).
- [ ] **Ответ.** `li_answer.py`: `CitationQueryEngine` или `RetrieverQueryEngine` с подменённым промпт-шаблоном (наш системный промпт из AIL-23, фраза отказа). Через `get_prompts()` убеждаемся, что шаблон действительно подменён.
- [ ] **Eval тем же скриптом.** Адаптер `li_adapter.py`: функции `retrieve(question) -> list[str]` и `ask(question) -> Answer` с той же сигнатурой, что в ручной версии, — чтобы `eval/run_retrieval_eval.py` и таблица AIL-23 запускались без изменений.
- [ ] **Замеры.** Строки кода (`cloc rag/` vs `cloc llamaindex_version/`), латентность p50, время полной индексации, число пакетов в окружении.
- [ ] **Отладочный эксперимент.** Выбираем 2 вопроса, где хотя бы одна версия ошиблась (кандидаты: стоимость доставки 3 кг в другой город — таблица тарифов; гарантия на лампу «Свет» против «Свет мини»). В каждой версии находим причину и засекаем время. Записываем, какие инструменты помогли.
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

  И 5–10 предложений вывода: какую версию оставляем основной и почему, что из фреймворка понравилось и что мешало (включая то, насколько легко было подключить DeepSeek и Ollama и передать специфичные параметры вроде выключения рассуждения).
- [ ] **(Для сравнения, по желанию)** Заменяем `Settings.llm` на Claude (`llama-index-llms-anthropic`) и прогоняем 13 вопросов: сколько строк кода поменялось и как изменились ответы?

## Готово, когда

- LlamaIndex-версия работает на той же базе знаний `kb/`, с фильтром по категории, исключением архива, гибридом и реранкером, отвечает со ссылками на разделы и отказывает на вопросах вне базы знаний.
- Обе версии прогнаны тем же eval-скриптом на тех же 20 (поиск) и 13 (ответы) вопросах.
- В README есть раздел «Ручная версия vs LlamaIndex» с таблицей и обоснованным выводом, какую версию оставить и почему.

## Тест для самопроверки

1. Как в LlamaIndex называются аналоги наших «страницы» и «чанка»?
2. Что делает `IngestionPipeline` с docstore при повторной загрузке, и какое условие для этого обязательно?
3. Какой компонент LlamaIndex соответствует нашему BM25 + RRF из AIL-22?
4. Почему для честного сравнения нужно использовать одну и ту же модель эмбеддингов и LLM в обеих версиях?
5. Что не так в этом коде?
   ```python
   docs = [Document(text=p.text, metadata={"category": p.category}) for p in pages]
   pipeline = IngestionPipeline(transformations=[parser, embed_model], docstore=docstore)
   pipeline.run(documents=docs)   # runs every night
   ```
6. Где LlamaIndex чаще всего «мешает» в задаче RAG с цитатами? a) загрузка Markdown b) кастомный промпт отказа и формат цитат c) вычисление косинуса d) установка пакетов
7. Как увидеть, какой именно промпт LlamaIndex отправил в модель?
8. Почему LlamaIndex-версия может оказаться медленнее ручной при той же конфигурации поиска? Достаточно двух причин.
9. В каких ситуациях стоит выбрать фреймворк, а в каких — ручную версию? По одному примеру.
10. Почему в интернете много неработающих примеров LlamaIndex и как от этого защититься?
11. DeepSeek подключили через класс `OpenAI` из LlamaIndex, указав `api_base="https://api.deepseek.com"` и `model="deepseek-flash"`, и получили ошибку про неизвестную модель. Что использовать вместо этого?
12. `Settings.embed_model` не задан, а ключа OpenAI в окружении нет. Что, скорее всего, произойдёт, и почему для стека «DeepSeek + Ollama» это важно?
13. Почему LlamaIndex-версия должна эмбеддить через тот же бэкенд (Ollama или Sentence Transformers), что и ручная, а не просто «ту же модель bge-m3»?

## Ответы

1. `Document` (страница с метаданными и `id_`) и `Node`/`TextNode` (чанк).
2. Пропускает документы с тем же `id_` и неизменённым содержимым, обновляет изменённые. Обязательно — стабильный `id_` у документа (например, путь страницы `kb/returns.md`).
3. `QueryFusionRetriever` в режиме reciprocal rerank поверх векторного retriever'а и `BM25Retriever`.
4. Иначе разница в качестве и скорости объясняется моделями, а не кодом/фреймворком — сравнение теряет смысл.
5. У `Document` нет стабильного `id_` (он генерируется случайно), поэтому docstore не узнает документ при повторном запуске, и каждую ночь узлы будут дублироваться; также в метаданных нет `archived` (архивные правила возврата попадут в поиск) и `doc`/`url`, нужных для цитат.
6. **b.** Поведение по умолчанию задают встроенные шаблоны промптов; чтобы получить свой отказ и цитаты, их надо найти и подменить.
7. Через `engine.get_prompts()` (шаблоны), подробное логирование/инструментацию (фактические вызовы) и `source_nodes` (что было в контексте).
8. Скрытые дополнительные вызовы LLM (генерация запросов, многошаговый синтез ответа); индекс в памяти без persist, пересчитываемый при старте; накладные расходы абстракций и другая конфигурация по умолчанию.
9. Фреймворк — быстрый прототип с множеством источников данных или перебор векторных БД; ручная — небольшой критичный пайплайн, где нужны полный контроль промптов, простая отладка и минимум зависимостей.
10. API фреймворка быстро меняется (например, разделение на `llama_index.core` и пакеты интеграций), старые примеры используют устаревшие импорты. Защита — только текущая документация и фиксированные версии в requirements.
11. `OpenAILike` (`llama-index-llms-openai-like`) с `api_base`, `api_key`, `is_chat_model=True` — он не проверяет имя по списку моделей OpenAI. Или интеграцию `llama-index-llms-deepseek`, если она принимает текущие имена моделей.
12. Фреймворк попробует дефолтного провайдера эмбеддингов (OpenAI) и упадёт без ключа, а с ключом молча отправит тексты в OpenAI. В нашем стеке эмбеддинги должны быть локальными (у DeepSeek их нет), поэтому `Settings.embed_model` задают явно.
13. Сборки одной и той же модели в Ollama и в Sentence Transformers — разные рантаймы, и их векторы могут отличаться. Если бэкенды разные, разница в цифрах может объясняться ими, а не фреймворком.

## Что дальше

Остался финальный шаг проекта: [AIL-25 · Проект 2: README и GitHub](AIL-25.md) — чтобы проект можно было запустить с нуля и показать на собеседовании.
