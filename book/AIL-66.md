# 11.1 · Docker: упаковать проект  (AIL-66)

> **Неделя 11** · Продакшен · ⏱ ~4 ч · Практика

<!-- description: Docker для LLM-проекта: Dockerfile на uv, слои и кэш, .dockerignore, секреты через окружение, docker compose с Langfuse и запуск одной командой. -->

## Зачем это AI-инженеру

Ревьюер портфолио не будет ставить нужную версию Python, uv, Ollama, Langfuse и собирать индекс по README из пятнадцати шагов. Он скопирует `git clone && docker compose up` — и либо увидит работающий ассистент поддержки, либо закроет вкладку. На собеседованиях вопрос «как вы это деплоите?» звучит почти всегда, и ответ «Dockerfile + compose, секреты через окружение, образ без ключей и данных внутри» — минимальный ожидаемый уровень.

Неделя 10 закончилась публикацией агента; неделя 11 — про то, что нужно проекту, чтобы работать не только на нашей машине. Начинаем с упаковки. Берём проект 2 — ассистента поддержки `projects/02-support-kb-rag/` со Streamlit-интерфейсом `app.py`: у него больше всего движущихся частей (веб-интерфейс, индекс, Ollama для эмбеддингов, Langfuse), так что на нём видны все приёмы. На проекты 1 и 4 они переносятся напрямую.

## Теория

### Что такое контейнер, в знакомых терминах

Ассистент запускается через `uv run streamlit run app.py`, и работает он потому, что на нашей машине стоит нужный Python и uv, создан `.venv`, рядом лежат `.env` и `index.db`, а Ollama уже запущена. Переносим папку на другую машину — и половины этого не будет.

Docker решает именно эту проблему: всё, от чего зависит запуск, едет вместе с кодом. Контейнер — это процесс, которому ядро ОС показывает **собственную файловую систему** (с нужным Python, библиотеками и нашим кодом), собственную сеть и собственное дерево процессов. Это не виртуальная машина: ядро общее, поэтому контейнер стартует за доли секунды.

| Понятие | Привычная аналогия | Что это |
|---|---|---|
| **Image** (образ) | интерпретатор + `.venv` + код проекта, упакованные в один архив | неизменяемый «снимок» файловой системы + команда запуска |
| **Container** | запущенный `streamlit run app.py` | процесс, запущенный из образа; его изменения файлов пропадают при удалении |
| **Dockerfile** | раздел «Установка» из README, только исполняемый | рецепт сборки образа, по шагам |
| **Layer** (слой) | кэш менеджера пакетов (`~/.cache/uv`, `node_modules`, `~/.m2`) | каждый шаг Dockerfile — слой; неизменившиеся слои берутся из кэша |
| **Volume** | `index.db`, который лежит рядом с проектом и переживает перезапуски | хранилище, которое живёт дольше контейнера |
| **docker compose** | три терминала: в одном приложение, в другом Langfuse, в третьем Ollama | файл, описывающий несколько сервисов, их сеть, переменные и тома |

На Linux контейнеры работают прямо на ядре системы (Docker Engine). На macOS и Windows контейнеры Linux работают внутри лёгкой виртуальной машины: её даёт Docker Desktop (бесплатен для личного использования и небольших компаний — условия лицензии стоит проверить) или альтернативы — на macOS, например, OrbStack и colima. Это программа с правами в системе: скачиваем с официального сайта, на macOS до первого запуска — `codesign -dv` и `spctl -a -vv` на `.app`.

### Слои и кэш: почему порядок строк в Dockerfile важен

Прежде чем писать свой Dockerfile, разберём одно правило, от которого зависит, будет ли пересборка занимать секунды или минуты. Docker выполняет Dockerfile сверху вниз и кэширует результат каждой инструкции. Если входы шага (файлы, которые он копирует, сама команда) не изменились — шаг берётся из кэша. Как только один шаг изменился, **все следующие** пересобираются.

Отсюда главный приём: сначала копируем только файлы зависимостей (`pyproject.toml`, `uv.lock`) и ставим зависимости, потом копируем код. Правим код — переустановки сотен мегабайт зависимостей не происходит.

```
плохо                          хорошо
-----                          ------
COPY . /app          ← код     COPY pyproject.toml uv.lock  ← редко меняется
RUN uv sync          ← каждый  RUN uv sync --no-install-project
                       раз     COPY . /app                  ← часто меняется
                       заново  RUN uv sync                  ← быстро: только сам проект
```

### Dockerfile для Python-проекта с uv

В главе 1.3 · Python: uv, async, Pydantic (AIL-2) мы собрали проект на uv. У uv есть официальный гайд по Docker, и его паттерн — ровно приём «сначала зависимости, потом код» из предыдущего раздела. Выглядит он так (версию uv закрепляем ту, что актуальна в гайде на момент работы):

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim

# Copy the uv binary from the official image; pin the version (or a digest)
COPY --from=ghcr.io/astral-sh/uv:<VERSION> /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 1) Dependencies only: cached until uv.lock / pyproject.toml change
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

# 2) The project itself: code, prompts and the public knowledge base kb/
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# Run as an unprivileged user, not root; the index directory must be writable
RUN useradd --create-home app && mkdir -p /app/data/index && chown -R app /app
USER app

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8501
CMD ["sh", "scripts/start.sh"]
```

`CMD` запускает не Streamlit напрямую, а скрипт `scripts/start.sh`: перед интерфейсом нужно построить индекс из `kb/`, а это два шага:

```sh
#!/bin/sh
set -e
# Build or update the index from kb/; unchanged pages are skipped by doc_hash
python ingest.py
# exec: streamlit replaces the shell and receives SIGTERM directly
exec streamlit run app.py --server.address=0.0.0.0 --server.port=8501
```

Что здесь важно:

- `--locked` — сборка падает, если `uv.lock` не соответствует `pyproject.toml`. Аналог `npm ci` в Node или проверки lock-файла в других менеджерах: в образ попадают ровно те версии, что мы проверяли.
- `--mount=type=cache` — кэш uv живёт между сборками, но не попадает в образ.
- `UV_NO_DEV=1` — pytest, ruff и прочие dev-зависимости в образ не идут.
- `PYTHONUNBUFFERED=1` — иначе `print` и логи буферизуются и в `docker compose logs` появляются с задержкой или не появляются вовсе.
- `--server.address=0.0.0.0` — внутри контейнера приложение **должно** слушать все интерфейсы контейнера, иначе проброс порта не достучится. Это не то же самое, что выставить сервис в интернет: наружу его выставляет `ports:` в compose, и там указываем `127.0.0.1`.
- `CMD` в exec-форме (JSON-массив) и `exec` в скрипте — тогда Streamlit получает SIGTERM при `docker compose down` и может корректно завершиться.
- Индекс строит `ingest.py` при старте, а не `docker build`: эмбеддинги считает Ollama, а при сборке её нет. Путь — из `INDEX_PATH` (по умолчанию `index.db`, в контейнере — файл в томе).

### .dockerignore — обязательный файл

Строка `COPY . /app` в нашем Dockerfile выглядит безобидно, но копирует всё из контекста сборки — папки, из которой запущен `docker build`. Без `.dockerignore` в образ уедут `.env` с ключами, `.venv` с нашей машины (бинарники могут быть не под Linux), `.git`, `index.db`, `outputs/handoff.jsonl` с вопросами покупателей и ноутбуки с выводом. Образ потом публикуется или передаётся — и ключ с данными утекли.

```
.env
.env.*
!.env.example
.venv/
.git/
__pycache__/
*.db
*.db-wal
*.db-shm
data/
raw/
outputs/
logs/
eval/runs/
notebooks/.ipynb_checkpoints/
```

`kb/` в образ попадает намеренно: это выдуманная публичная база знаний. `../shop-live/` лежит вне контекста сборки и не должна попадать туда ни симлинком, ни копией «для удобства».

### Данные: генерируем, а не копируем

`.dockerignore` не пускает данные в образ, но приложению они всё равно нужны. Ответ — **в образе нет ни одного снимка базы и ни одного сообщения клиента**, а нужные данные создаются на месте — при сборке или старте: в проекте 2 индекс строит `ingest.py`; в проектах 1 и 4 демо-базу генерирует в Dockerfile `RUN python scripts/make_fake_db.py --seed 42` (в проекте 4 — ещё `--incidents 20`); данные выдуманы и детерминированы сидом. Снимок `data/shop.db` — только локально, томом `:ro`, в контейнер без ключа облака.

### Секреты: правило одно

С данными разобрались; второе, что нельзя запекать в образ, — ключи. **Ключи никогда не попадают в образ.** Ни через `COPY`, ни через `ENV DEEPSEEK_API_KEY=...`, ни через `ARG` (значения `ARG` видны в истории образа: `docker history`). Ключи передаются в момент **запуска** контейнера:

- `env_file: .env` в compose (а `.env` в `.gitignore` и `.dockerignore`);
- или `environment:` с подстановкой `${DEEPSEEK_API_KEY}` из окружения shell;
- для настоящего продакшена — секреты оркестратора (Docker secrets, Kubernetes Secrets, менеджер секретов облака).

Если секрет нужен на этапе **сборки** (например, приватный пакет), используется `RUN --mount=type=secret,...` — он доступен только этому шагу и в слой не записывается. В учебных проектах такой нужды быть не должно.

В репозиторий кладём `.env.example` — список переменных без значений. Это и документация, и проверка: человек со стороны видит, какие ключи ему понадобятся.

### docker compose: несколько сервисов одной командой

Один контейнер у нас уже есть, но ассистенту нужны соседи: Langfuse для трейсов, а иногда и Ollama. Запускать каждый руками в отдельном терминале неудобно — для этого есть compose. `compose.yaml` описывает сервисы, и compose сам создаёт для них общую сеть, где **сервисы видят друг друга по имени**. Это главное отличие от локального запуска: внутри контейнера `localhost` — это сам контейнер, а не наша машина и не соседний сервис.

```
             наша машина (host)
  ┌──────────────────────────────────────────────┐
  │  127.0.0.1:8501 ──► rag-app:8501             │
  │  127.0.0.1:3001 ──► langfuse-web:3000        │
  │                                              │
  │   сеть compose:                              │
  │   rag-app ──http://langfuse-web:3000──► langfuse-web
  │   rag-app ──http://ollama:11434───────► ollama (профиль local-llm)
  │   rag-app ──http://host.docker.internal:11434──► нативная Ollama
  └──────────────────────────────────────────────┘
```

Каркас для ассистента поддержки (`langfuse-web` — веб-сервис Langfuse; откуда он берётся, разберём в следующем разделе):

```yaml
services:
  rag-app:
    build: .
    env_file: .env
    environment:
      LANGFUSE_BASE_URL: http://langfuse-web:3000   # service name, not localhost
      INDEX_PATH: /app/data/index/index.db          # inside the named volume
    ports:
      - "127.0.0.1:8501:8501"                       # only reachable from this machine
    volumes:
      - index:/app/data/index                       # vector index survives restarts
    depends_on:
      langfuse-web:
        condition: service_started
    restart: unless-stopped
volumes:
  index:
```

Пара деталей:

- `ports: "127.0.0.1:8501:8501"` — без `127.0.0.1` Docker публикует порт на всех интерфейсах, и на сервере это означает «в интернет»: ассистент без авторизации, отвечающий за наш счёт в DeepSeek.
- `depends_on` управляет **порядком запуска**, а не готовностью. Чтобы ждать готовности, у зависимого сервиса нужен `healthcheck`, а в `depends_on` — `condition: service_healthy`. Но надёжнее, если приложение само переживает недоступность Langfuse: трейсинг не должен ронять ответ покупателю (подробно — в главе 11.3).
- `volumes` — индекс эмбеддингов и прочие данные, которые нельзя терять при `docker compose down`. Именованный том, а не папка хоста: права берутся из образа, и `app` может писать. Команда `docker compose down -v` удаляет именованные тома — с Langfuse это значит «все трейсы пропали».

### Langfuse рядом с приложением

Langfuse мы подключали в главе 6.5 (AIL-30), там он работал отдельно. Теперь поднимаем его в том же compose, что и ассистента. Langfuse можно запускать self-hosted. Официальный способ — их `docker-compose.yml` из репозитория `langfuse/langfuse`: там веб-сервис, воркер и хранилища (базы данных, MinIO для объектов). Все чувствительные строки в нём помечены `# CHANGEME` — пароли и секреты надо заменить на длинные случайные (`openssl rand -hex 32`) и вынести в `.env`.

Два способа объединить его со своим приложением:

1. **`include`** в своём `compose.yaml` (поддерживается в современных версиях Compose):
   ```yaml
   include:
     - langfuse/docker-compose.yml
   services:
     rag-app: ...
   ```
2. Два файла и флаг: `docker compose -f compose.yaml -f langfuse/docker-compose.yml up`.

Первый вариант лучше для README: остаётся «одна команда».

Конфликт, который встречается сразу: веб-интерфейс Langfuse по умолчанию на порту **3000** — том же, что у многих dev-серверов (Node, Grafana и т. п.). Если такой запущен, compose упадёт с `port is already allocated`. Перемапливаем хостовый порт (`127.0.0.1:3001:3000`) и не забываем обновить `NEXTAUTH_URL` (или аналогичную переменную адреса в их файле) на новый адрес.

Альтернатива для демо-версии в портфолио — Langfuse Cloud (бесплатный тариф): тогда в compose остаётся только наше приложение, а ключи Langfuse в `.env`. Годится только для выдуманных вопросов из golden set: трейсы с настоящими сообщениями покупателей в Langfuse Cloud не отправляем (глава 6.5). Выбираем одно и пишем в README, что именно.

### Чистая машина: как проверить «поднимается одной командой»

Всё собрано, и цель главы — «`git clone && docker compose up` на чужой машине» — осталось проверить. «Работает у меня» не считается. Типичные причины, почему на чужой машине не стартует:

- в образ не попал файл, потому что он в `.dockerignore` или `.gitignore` (например, `kb/` случайно исключили вместе с данными);
- приложение ждёт файл, который у нас лежит, а в репозитории его нет (`index.db`, снимок базы — и правильно, что нет; значит, его должен создать скрипт при старте);
- архитектура: на машине с ARM-процессором (Apple Silicon, ARM-ноутбуки и серверы) образ собран под `arm64`; Linux-сервер с `amd64` его не запустит, если публикуется готовый образ (сборка из исходников через `build: .` этой проблемы не имеет; иначе `docker buildx build --platform linux/amd64,linux/arm64`);
- переменная окружения не описана в `.env.example`.

Проверка: свежий `git clone` в другую папку → `cp .env.example .env` → вписать ключи → `docker compose up --build`. Ещё строже — `docker builder prune` перед этим, чтобы не помог кэш.

## DeepSeek и Ollama: как это сделать у нас

Для Docker провайдер почти не важен — меняются переменные окружения и появляется вопрос «где живёт Ollama». Факты про Ollama в Docker проверены по [docs.ollama.com/docker](https://docs.ollama.com/docker) и [FAQ](https://docs.ollama.com/faq) в ноябре 2026.

**Переменные.** Провайдер выбирается окружением, а не кодом — тогда один образ работает с любым из них. Набор — тот же, что в README проекта из главы 5.5 (AIL-25):

```
# .env.example - names only, no values
ANSWER_PROVIDER=         # deepseek | ollama
DEEPSEEK_API_KEY=
ANSWER_MODEL=            # e.g. deepseek-flash, check the pricing page for current names
OLLAMA_BASE_URL=         # http://host.docker.internal:11434/v1 (native) or http://ollama:11434/v1
ANSWER_MODEL_LOCAL=      # a tag from `ollama list`, e.g. qwen3:4b
EMBED_BACKEND=           # ollama | st
EMBED_MODEL=             # e.g. bge-m3
ANTHROPIC_API_KEY=       # optional, for the comparison runs only
```

Эмбеддинги считает Ollama, поэтому она нужна даже при ответах через DeepSeek.

**Нативная Ollama или контейнер — зависит от ОС.** В Docker Desktop на macOS GPU недоступен (нет проброса GPU), поэтому контейнер `ollama/ollama` на macOS работает только на CPU — в разы медленнее нативного приложения, которое использует Metal. Схема для macOS (и для Windows с Docker Desktop): Ollama установлена как обычное приложение и слушает `127.0.0.1:11434`, контейнер ассистента ходит к ней по `http://host.docker.internal:11434` (как на схеме выше). Менять `OLLAMA_HOST` на `0.0.0.0` ради этого не нужно и нельзя: Ollama не проверяет пароль, и так она открылась бы всей сети (подробнее — в главе 11.4). С colima или OrbStack при проблемах читаем их документацию про доступ к хосту, а не открываем Ollama в сеть. На Linux `host.docker.internal` ведёт на мост Docker, а не на `127.0.0.1` хоста, — там проще сервис `ollama` в compose.

**Ollama в контейнере — для ревьюера и Linux.** Чтобы человек без Ollama мог поднять проект одной командой, добавляем сервис под профилем — он стартует только по запросу:

```yaml
services:
  ollama:
    image: ollama/ollama:<pinned-version>     # official image; pin the tag, never latest
    profiles: ["local-llm"]                   # started only with --profile local-llm
    volumes:
      - ollama:/root/.ollama                  # models survive `down` (not `down -v`)
    # no `ports:` - only rag-app needs it, via the compose network at http://ollama:11434
volumes:
  ollama:
```

`docker compose --profile local-llm up -d`, затем один раз скачать модели: `docker compose exec ollama ollama pull bge-m3` и `docker compose exec ollama ollama pull qwen3:4b`. Приложение в этом режиме получает `OLLAMA_BASE_URL=http://ollama:11434/v1`. Порт наружу не публикуется: если всё-таки нужен с хоста — только `127.0.0.1:11435:11434` (11434 может быть занят нативной Ollama). Для GPU NVIDIA на Linux в документации — `--gpus=all` и NVIDIA Container Toolkit.

**Память.** На macOS и Windows контейнерам доступна только память виртуальной машины Docker (настройка Docker Desktop), а Langfuse с хранилищами сам берёт несколько гигабайт. Ориентиры курса: 8 GB RAM — модель 3–4B (`qwen3:4b`), Langfuse рядом поместится с трудом; 16 GB — 7–8B и весь стек; 32 GB+ — 14B и крупнее.

**DeepSeek в контейнере** — обычный исходящий HTTPS, ничего особенного. Помним про данные: контейнер со снимком базы магазина (`data/shop.db`, проекты 1 и 4) не получает `DEEPSEEK_API_KEY` вообще — уйти в облако ему нечем. У ассистента ключ есть, и правило держит `contains_personal_data` в `ask()`; настоящие сообщения покупателей — только с `ANSWER_PROVIDER=ollama`.

| Что для этой главы | Claude / OpenAI | DeepSeek | Ollama |
|---|---|---|---|
| Что положить в `.env` | ключ | ключ | ничего секретного, только `OLLAMA_BASE_URL` и модели |
| Где работает | облако | облако | macOS: нативно (Metal), в Docker — только CPU; Linux: контейнер |
| Адрес из контейнера | публичный API | `https://api.deepseek.com` | `host.docker.internal:11434` (нативная, Docker Desktop) или `ollama:11434` (сервис compose) |
| Что хранить в томе | — | — | модели (`/root/.ollama`), гигабайты |

## Маршрут изучения

1. Открываем [Docker: Get started](https://docs.docker.com/get-started/) → разделы про концепции (что такое контейнер, образ, registry, compose) и workshop до шагов про multi-container apps и volumes (≈60 мин). Обращаем внимание на разницу между bind mount и named volume — она понадобится для индекса и данных Langfuse.
2. [Using uv in Docker](https://docs.astral.sh/uv/guides/integration/docker/) → разделы про установку uv в образ, кэширование и intermediate layers, `.dockerignore`, `UV_COMPILE_BYTECODE` (≈25 мин). Берём оттуда актуальную версию uv для `COPY --from`.
3. [Docker Compose docs](https://docs.docker.com/compose/) → разделы про `services`, `ports`, `env_file`/`environment`, `depends_on`, `include`, `profiles` и страницу про переменные окружения в Compose (≈30 мин). Запоминаем приоритет: что перекрывает что, если переменная задана в нескольких местах.
4. [Langfuse self-hosting: Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose) → какие сервисы поднимаются, какие порты, где строки `# CHANGEME` (≈20 мин). Отмечаем, какой порт может конфликтовать с уже запущенными приложениями.
5. [Ollama: Docker](https://docs.ollama.com/docker) → команды запуска, том для моделей, вариант для GPU (≈10 мин), и в [Ollama FAQ](https://docs.ollama.com/faq) — абзац про GPU в Docker Desktop на macOS и про `OLLAMA_HOST` (≈10 мин).
6. В тех же docs Docker находим раздел про build secrets (`--mount=type=secret`) — только прочитать, чтобы понимать разницу между секретом сборки и секретом запуска (≈10 мин).

## На что обратить внимание

- **`.env` в образе.** Самая частая и самая дорогая ошибка. После сборки проверяем: `docker run --rm <image> ls -la /app` — `.env` там быть не должно.
- **Данные в образе.** `find /app -name '*.db*'` в свежем образе ассистента ничего не находит; `outputs/` в образе нет.
- **`localhost` внутри контейнера** — это контейнер. К соседнему сервису — по имени сервиса, к нативной Ollama — `host.docker.internal`.
- **`0.0.0.0` внутри, `127.0.0.1` в `ports`.** Внутри контейнера слушать все интерфейсы; на хосте публиковать только на loopback, пока нет причины иначе.
- **Root в контейнере.** По умолчанию процесс — root. Если в приложении уязвимость (а LLM-приложение, читающее чужой текст, — именно такое место, см. главу 9.4), лишние права ему ни к чему. `USER app`.
- **Огромный образ.** `python:3.12` (не slim) плюс torch из зависимостей легко дают 5+ ГБ. Его тянут `EMBED_BACKEND=st` и локальный реранкер; проверяем, кто именно (`uv tree`).
- **Незакреплённые теги.** `FROM python:latest` и `uv:latest` — сегодня собирается, через месяц нет. Закрепляем версии; для паранойи — digest `@sha256:...`. Это тот же принцип, что пиннинг пакетов в lock-файле.
- **Сторонние образы** — это сторонний код. Берём только официальные (`python`, `ghcr.io/astral-sh/uv`, `ollama/ollama`, образы Langfuse из их репозитория), смотрим, кто публикует, не тянем «удобные» сборки неизвестных авторов.
- **Данные Langfuse** живут в томах. `docker compose down -v` их стирает. Модели Ollama и индекс — тоже.
- **Ollama в контейнере на macOS** — без GPU. Не делаем выводы о скорости локальной модели по такому замеру.
- **Модели Ollama в образе** (`RUN ollama pull` в Dockerfile) — образ на многие гигабайты; модели — в томе, скачиваются после запуска.
- **Ключ DeepSeek в контейнере, который видит снимок базы магазина** — лишний путь для утечки персональных данных. Такому контейнеру ключ облака не передаём.
- **Снимок базы и сообщения покупателей не попадают в образ и в репозиторий.** Демо в портфолио — на выдуманных данных; если проект читает снимок, он монтируется томом только локально, только для чтения (`:ro`), и создаётся через `VACUUM INTO`, не `cp`. `../shop-live/` не монтируется в контейнеры никогда.

## Практика

- [ ] Ставим Docker по официальной инструкции для своей ОС: Docker Desktop (macOS, Windows; на macOS можно OrbStack или colima) или Docker Engine (Linux). На macOS до первого запуска — `codesign -dv` и `spctl -a -vv` для скачанного приложения. `docker version` и `docker compose version` работают.
- [ ] В `projects/02-support-kb-rag/` создаём `.dockerignore`, `.env.example` без значений и `scripts/start.sh`; путь к индексу читаем из `INDEX_PATH`.
- [ ] Пишем `Dockerfile` по паттерну из теории. Собираем: `docker build -t rag-assistant .`. Записываем время первой сборки.
- [ ] Меняем одну строку в коде и пересобираем. Ожидаемый результат: шаг с зависимостями `CACHED`, сборка за секунды. Если нет — порядок шагов неправильный.
- [ ] Проверяем, что секретов и данных в образе нет:
  ```bash
  docker run --rm rag-assistant sh -c 'ls -la /app; find /app -name "*.db*"; env | grep -i key || true'
  docker history rag-assistant   # no keys in any layer command
  ```
- [ ] Запускаем контейнер вручную с ключами из файла (нативная Ollama запущена, в `.env` — `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`): `docker run --rm --env-file .env -p 127.0.0.1:8501:8501 rag-assistant`. Ассистент отвечает на «можно ли вернуть вскрытый чай?» со ссылкой на `kb/returns.md#opened-tea-returns`.
- [ ] Скачиваем официальный `docker-compose.yml` Langfuse в `langfuse/` своего репозитория, читаем его целиком. Заменяем все `# CHANGEME` на переменные из `.env`, генерируем значения через `openssl rand -hex 32`. Перемапливаем порт веба на `127.0.0.1:3001`.
- [ ] Пишем `compose.yaml` с `include` Langfuse и сервисом `rag-app`. `LANGFUSE_BASE_URL` для приложения — `http://langfuse-web:3000` (точное имя сервиса проверяем в их файле).
- [ ] `docker compose up --build`. Задаём ассистенту 3 вопроса из golden set на DeepSeek (например, «действует ли TEA15 вместе со скидкой?»), открываем `http://127.0.0.1:3001` и находим трейсы.
- [ ] Переключаем `ANSWER_PROVIDER=ollama` — без пересборки образа ассистент отвечает локальной моделью.
- [ ] Добавляем сервис `ollama` под профилем `local-llm` (образ с закреплённым тегом, том для моделей, без `ports`). Поднимаем с профилем, скачиваем `bge-m3` и `qwen3:4b` через `docker compose exec`, переключаем `OLLAMA_BASE_URL` на `http://ollama:11434/v1`. Сравниваем tokens/s с нативной Ollama и записываем в README, какой вариант рекомендуем для какой ОС и почему.
- [ ] `docker compose down` и снова `up` — трейсы и индекс на месте. (Не делаем `-v`.)
- [ ] Останавливаем контейнер Langfuse: `docker compose stop langfuse-web`. Ассистент должен продолжать отвечать (трейсинг не блокирует ответ). Если падает — записываем в задачи главы 11.3.
- [ ] Раздел README «Запуск»:
  ```markdown
  ## Запуск
  1. git clone ... && cd support-kb-rag
  2. cp .env.example .env  # заполнить DEEPSEEK_API_KEY и т. д.
  3. docker compose up --build
     # без нативной Ollama или без ключа облака: docker compose --profile local-llm up --build
  4. Ассистент: http://127.0.0.1:8501, Langfuse: http://127.0.0.1:3001
  ```
- [ ] Проверка на «чистой машине»: клонируем репозиторий во временную папку, `docker builder prune -f`, проходим README буквально по шагам. Всё, что пришлось сделать сверх README, — дописываем в README.

## Готово, когда

- Свежий клон + `.env` из `.env.example` + `docker compose up --build` поднимает ассистента и Langfuse без ручных шагов; индекс строится из `kb/` при старте.
- В образе нет `.env`, ключей, `index.db`, снимков базы и сообщений покупателей; `docker history` чистый.
- Порты опубликованы на `127.0.0.1`; приложение работает от не-root пользователя.
- В README есть раздел «Запуск» в 3–4 шага и рекомендация, где запускать Ollama на разных ОС.

## Тест для самопроверки

1. Почему в Dockerfile сначала копируют `pyproject.toml`/`uv.lock` и ставят зависимости, а код — потом?
2. Внутри контейнера `rag-app` приложение обращается к Langfuse по `http://localhost:3000` и получает `Connection refused`, хотя Langfuse работает. Почему и как исправить?
3. Чем `docker compose down` отличается от `docker compose down -v` для этого проекта?
4. Что не так в этом Dockerfile?
   ```dockerfile
   FROM python:latest
   ARG DEEPSEEK_API_KEY
   ENV DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
   COPY . /app
   RUN pip install -r requirements.txt
   CMD python app.py
   ```
5. Что гарантирует `depends_on` без `condition`?
   a) что зависимый сервис готов принимать запросы
   b) только порядок запуска контейнеров
   c) что сервис перезапустится при падении зависимости
   d) что сервисы будут в одной сети
6. Зачем приложению внутри контейнера слушать `0.0.0.0`, и почему это не делает его доступным из интернета?
7. Что делает флаг `--locked` у `uv sync` и какой аналог у него в мире npm?
8. Образ собрали на ноутбуке с ARM-процессором (например, Apple Silicon), запушили в registry, а на сервере `amd64` он не стартует (`exec format error`). Что произошло?
9. Как нативная Ollama на macOS будет видна из контейнера в Docker Desktop?
   a) `http://localhost:11434`  b) `http://ollama:11434`  c) `http://host.docker.internal:11434`  d) никак
10. Зачем нужен `PYTHONUNBUFFERED=1`?
11. Почему трейсинг не должен блокировать ответ покупателю, и как это проверялось в практике?
12. Почему на macOS Ollama лучше запускать нативно, а не в контейнере `ollama/ollama`?
13. Какой адрес Ollama укажет приложение из контейнера в двух случаях: Ollama нативная на хосте с Docker Desktop; Ollama — сервис `ollama` в том же compose?

## Ответы

1. Слои кэшируются, и изменение одного шага инвалидирует все последующие. Зависимости меняются редко, код — часто; при таком порядке правка кода не вызывает переустановку зависимостей.
2. `localhost` внутри контейнера — это сам контейнер. К соседнему сервису compose обращаются по имени сервиса: `http://langfuse-web:3000` (порт контейнерный, не хостовый).
3. `down` удаляет контейнеры и сеть, тома остаются. `down -v` удаляет и именованные тома — пропадут данные Langfuse, индекс и модели Ollama.
4. `latest` не закреплён; ключ через `ARG`/`ENV` запекается в образ и виден в `docker history`/`docker inspect`; `COPY . /app` без `.dockerignore` тащит `.env`, `.venv`, `index.db` и всё из `outputs/`; зависимости ставятся после копирования кода (нет кэша) и без lock-файла; `CMD` в shell-форме плохо принимает сигналы; процесс работает от root.
5. **b.** Для готовности нужен `healthcheck` у зависимости и `condition: service_healthy`, а лучше — устойчивость приложения к недоступности зависимости.
6. Порт контейнера доступен снаружи только через проброс; если слушать `127.0.0.1` внутри контейнера, проброшенный трафик не дойдёт. Наружу сервис открывает `ports:`, и там указывается `127.0.0.1:...`, то есть только для своей машины.
7. Падает, если lock-файл не соответствует `pyproject.toml`, и ставит точные версии из lock. Аналог — `npm ci`.
8. Образ собран под `arm64`. Нужна мультиархитектурная сборка `docker buildx build --platform linux/amd64,linux/arm64` или сборка на сервере из исходников.
9. **c.** `host.docker.internal` работает в Docker Desktop и большинстве альтернатив на macOS; на Linux его, возможно, придётся добавить через `extra_hosts: ["host.docker.internal:host-gateway"]`, и он ведёт на мост Docker, а не на `127.0.0.1` хоста.
10. Без него stdout Python буферизуется, и логи в `docker compose logs` появляются с задержкой или теряются при падении.
11. Трейсинг — вспомогательная функция; если из-за недоступного Langfuse покупатель не получает ответ, наблюдаемость стала точкой отказа. Проверка — остановить контейнер Langfuse и убедиться, что ассистент отвечает.
12. В Docker Desktop на macOS нет проброса GPU, контейнер работает на CPU и в разы медленнее; нативная Ollama использует GPU Apple Silicon через Metal.
13. Нативная: `http://host.docker.internal:11434`. Сервис compose: `http://ollama:11434` — по имени сервиса в общей сети, без публикации порта.

## Что дальше

Проект поднимается одной командой — теперь сделаем его дешёвым и устойчивым: в главе 11.2 · Prompt caching, бюджеты, фолбэки (AIL-45) замерим экономию на кэше DeepSeek и добавим Ollama как запасного провайдера, а в главе 11.3 · Трейсинг и стоимость одного ответа (AIL-46) подключённый здесь Langfuse станет дашбордом стоимости и латентности.
