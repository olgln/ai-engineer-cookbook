# 10.1 · Docker: packaging an LLM project  (AIL-66)

> **Week 10** · Production · ⏱ ~4 h · Practice

<!-- description: Docker for an LLM project: a uv Dockerfile, layer cache, .dockerignore, secrets via env, docker compose with Langfuse and a one-command start. -->
<!-- source-sha256: 9dd23d402d84 -->

## Why an AI engineer needs this

A portfolio reviewer is not going to install the right versions of Python, uv, Ollama and Langfuse and build an index by following a fifteen-step README. They will copy `git clone && docker compose up` and either see a working support assistant or close the tab. In interviews the question "how do you deploy this?" comes up almost every time, and the answer "Dockerfile + compose, secrets through the environment, an image with no keys and no data inside" is the minimum expected level.

Week 9 ended with publishing the agent; week 10 is about what a project needs to work somewhere other than our own machine. We start with packaging. We take project 2, the support assistant `projects/02-support-kb-rag/` with the Streamlit interface `app.py`: it has the most moving parts (a web interface, an index, Ollama for embeddings, Langfuse), so every technique shows up on it. They carry over directly to projects 1 and 4.

## Theory

### What a container is, in familiar terms

The assistant starts with `uv run streamlit run app.py`, and it works because our machine has the right Python and uv, a `.venv` has been created, `.env` and `index.db` sit next to the code, and Ollama is already running. Move the folder to another machine and half of that is gone.

Docker solves exactly this problem: everything the launch depends on travels with the code. A container is a process that the OS kernel shows **its own file system** (with the right Python, libraries and our code), its own network and its own process tree. It is not a virtual machine: the kernel is shared, so a container starts in a fraction of a second.

| Concept | Familiar analogy | What it is |
|---|---|---|
| **Image** | the interpreter + `.venv` + the project code, packed into one archive | an immutable "snapshot" of a file system + a start command |
| **Container** | a running `streamlit run app.py` | a process started from an image; its file changes are lost when it is removed |
| **Dockerfile** | the "Installation" section of a README, only executable | a step-by-step recipe for building an image |
| **Layer** | a package manager cache (`~/.cache/uv`, `node_modules`, `~/.m2`) | each Dockerfile step is a layer; unchanged layers come from the cache |
| **Volume** | the `index.db` that sits next to the project and survives restarts | storage that lives longer than the container |
| **docker compose** | three terminals: the app in one, Langfuse in another, Ollama in the third | a file describing several services, their network, variables and volumes |

On Linux, containers run directly on the system kernel (Docker Engine). On macOS and Windows, Linux containers run inside a lightweight virtual machine: it comes from Docker Desktop (free for personal use and small companies; check the license terms) or from alternatives, such as OrbStack and colima on macOS. This is a program with system privileges: we download it from the official site, and on macOS, before the first launch, we run `codesign -dv` and `spctl -a -vv` on the `.app`.

### Layers and cache: why the order of lines in a Dockerfile matters

Before writing our own Dockerfile, let's go over one rule that decides whether a rebuild takes seconds or minutes. Docker runs a Dockerfile top to bottom and caches the result of each instruction. If a step's inputs (the files it copies, the command itself) have not changed, the step comes from the cache. As soon as one step changes, **all the following ones** are rebuilt.

Hence the main technique: first copy only the dependency files (`pyproject.toml`, `uv.lock`) and install the dependencies, then copy the code. When we edit the code, hundreds of megabytes of dependencies are not reinstalled.

```
bad                            good
---                            ----
COPY . /app          ← code    COPY pyproject.toml uv.lock  ← rarely changes
RUN uv sync          ← re-runs RUN uv sync --no-install-project
                       every   COPY . /app                  ← changes often
                       time    RUN uv sync                  ← fast: just the project
```

### A Dockerfile for a Python project with uv

In chapter 1.3 · Python: uv, async, Pydantic (AIL-2) we set up the project with uv. uv has an official Docker guide, and its pattern is exactly the "dependencies first, code second" technique from the previous section. It looks like this (we pin the uv version that is current in the guide at the time we work):

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

`CMD` does not start Streamlit directly but runs the script `scripts/start.sh`: before the interface we need to build the index from `kb/`, so there are two steps:

```sh
#!/bin/sh
set -e
# Build or update the index from kb/; unchanged pages are skipped by doc_hash
python ingest.py
# exec: streamlit replaces the shell and receives SIGTERM directly
exec streamlit run app.py --server.address=0.0.0.0 --server.port=8501
```

What matters here:

- `--locked`: the build fails if `uv.lock` does not match `pyproject.toml`. It is the equivalent of `npm ci` in Node or of lock-file checks in other package managers: the image gets exactly the versions we tested.
- `--mount=type=cache`: the uv cache lives between builds but does not end up in the image.
- `UV_NO_DEV=1`: pytest, ruff and other dev dependencies stay out of the image.
- `PYTHONUNBUFFERED=1`: otherwise `print` and logs are buffered and show up in `docker compose logs` late or not at all.
- `--server.address=0.0.0.0`: inside the container the app **must** listen on all of the container's interfaces, or port forwarding will not reach it. This is not the same as exposing the service to the internet: `ports:` in compose exposes it to the outside, and there we specify `127.0.0.1`.
- `CMD` in exec form (a JSON array) and `exec` in the script: then Streamlit receives SIGTERM on `docker compose down` and can shut down cleanly.
- The index is built by `ingest.py` at startup, not by `docker build`: Ollama computes the embeddings, and it is not available during the build. The path comes from `INDEX_PATH` (`index.db` by default; in the container, a file in the volume).

### .dockerignore is a required file

The line `COPY . /app` in our Dockerfile looks harmless, but it copies everything from the build context, the folder `docker build` is run from. Without `.dockerignore` the image gets `.env` with the keys, the `.venv` from our machine (its binaries may not be built for Linux), `.git`, `index.db`, `outputs/handoff.jsonl` with customer questions and notebooks with their output. The image is then published or handed over, and the key and the data have leaked.

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

`kb/` goes into the image on purpose: it is a made-up public knowledge base. `../shop-live/` sits outside the build context and must not get into it, neither through a symlink nor through a copy "for convenience".

### Data: generate, don't copy

`.dockerignore` keeps data out of the image, but the app still needs it. The answer is that **the image contains no database snapshot and no customer message at all**, and the data we need is created in place, at build time or at startup: in project 2 `ingest.py` builds the index; in projects 1 and 4 the demo database is generated in the Dockerfile by `RUN python scripts/make_fake_db.py --seed 42` (in project 4 also with `--incidents 20`); the data is made up and deterministic thanks to the seed. The database snapshot `data/shop.db` is local only, mounted as a `:ro` volume, into a container without a cloud key.

### Secrets: one rule

That settles the data; the second thing we must not bake into the image is keys. **Keys never go into the image.** Not through `COPY`, not through `ENV DEEPSEEK_API_KEY=...`, not through `ARG` (`ARG` values are visible in the image history: `docker history`). Keys are passed when the container is **started**:

- `env_file: .env` in compose (with `.env` in `.gitignore` and `.dockerignore`);
- or `environment:` with `${DEEPSEEK_API_KEY}` substituted from the shell environment;
- for real production, the orchestrator's secrets (Docker secrets, Kubernetes Secrets, a cloud secrets manager).

If a secret is needed at **build** time (for example, for a private package), we use `RUN --mount=type=secret,...`: it is available only to that step and is not written into a layer. The course projects should never need this.

We put `.env.example` into the repository: a list of variables without values. It is both documentation and a check: an outsider sees which keys they will need.

### docker compose: several services with one command

We already have one container, but the assistant needs neighbors: Langfuse for traces, and sometimes Ollama. Starting each one by hand in a separate terminal is inconvenient, and that is what compose is for. `compose.yaml` describes the services, and compose creates a shared network for them where **services see each other by name**. This is the main difference from running locally: inside a container, `localhost` is the container itself, not our machine and not a neighboring service.

```
             our machine (host)
  ┌──────────────────────────────────────────────┐
  │  127.0.0.1:8501 ──► rag-app:8501             │
  │  127.0.0.1:3001 ──► langfuse-web:3000        │
  │                                              │
  │   compose network:                           │
  │   rag-app ──http://langfuse-web:3000──► langfuse-web
  │   rag-app ──http://ollama:11434───────► ollama (local-llm profile)
  │   rag-app ──http://host.docker.internal:11434──► native Ollama
  └──────────────────────────────────────────────┘
```

The skeleton for the support assistant (`langfuse-web` is the Langfuse web service; where it comes from is covered in the next section):

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

A couple of details:

- `ports: "127.0.0.1:8501:8501"`: without `127.0.0.1` Docker publishes the port on all interfaces, and on a server that means "to the internet": an assistant with no authentication, answering at our expense in DeepSeek.
- `depends_on` controls the **start order**, not readiness. To wait for readiness, the dependency needs a `healthcheck`, and `depends_on` needs `condition: service_healthy`. But it is more reliable if the app itself survives Langfuse being unavailable: tracing must not break the answer to the customer (more on this in chapter 10.3).
- `volumes`: the embedding index and other data we must not lose on `docker compose down`. A named volume, not a host folder: the permissions come from the image, so `app` can write. The command `docker compose down -v` deletes named volumes; with Langfuse that means "all traces are gone".

### Langfuse next to the app

We connected Langfuse in chapter 6.5 (AIL-30), where it ran separately. Now we start it in the same compose as the assistant. Langfuse can be self-hosted. The official way is their `docker-compose.yml` from the `langfuse/langfuse` repository: it has the web service, a worker and storage (databases, MinIO for objects). All sensitive strings in it are marked `# CHANGEME`: the passwords and secrets must be replaced with long random ones (`openssl rand -hex 32`) and moved into `.env`.

Two ways to combine it with our app:

1. **`include`** in our own `compose.yaml` (supported in current versions of Compose):
   ```yaml
   include:
     - langfuse/docker-compose.yml
   services:
     rag-app: ...
   ```
2. Two files and a flag: `docker compose -f compose.yaml -f langfuse/docker-compose.yml up`.

The first option is better for the README: it stays "one command".

A conflict that shows up right away: the Langfuse web interface uses port **3000** by default, the same as many dev servers (Node, Grafana and so on). If one of them is running, compose fails with `port is already allocated`. We remap the host port (`127.0.0.1:3001:3000`) and remember to update `NEXTAUTH_URL` (or the equivalent address variable in their file) to the new address.

An alternative for a portfolio demo is Langfuse Cloud (the free tier): then compose has only our app, and the Langfuse keys go into `.env`. This works only for the made-up questions from the golden set: we do not send traces with real customer messages to Langfuse Cloud (chapter 6.5). We pick one and state in the README which one.

### A clean machine: how to check "starts with one command"

Everything is assembled, and the chapter's goal, "`git clone && docker compose up` on someone else's machine", is left to check. "Works for me" does not count. Typical reasons it does not start on someone else's machine:

- a file did not get into the image because it is in `.dockerignore` or `.gitignore` (for example, `kb/` was accidentally excluded along with the data);
- the app expects a file that exists on our machine but not in the repository (`index.db`, a database snapshot; and rightly so, which means a script must create it at startup);
- architecture: on a machine with an ARM processor (Apple Silicon, ARM laptops and servers) the image is built for `arm64`; a Linux server with `amd64` will not run it if a prebuilt image is published (building from source with `build: .` does not have this problem; otherwise use `docker buildx build --platform linux/amd64,linux/arm64`);
- an environment variable is not listed in `.env.example`.

The check: a fresh `git clone` into another folder → `cp .env.example .env` → fill in the keys → `docker compose up --build`. Stricter still: run `docker builder prune` first so the cache cannot help.

## DeepSeek and Ollama: how we do it

For Docker the provider hardly matters: the environment variables change, and the question "where does Ollama live" comes up. The facts about Ollama in Docker were checked against [docs.ollama.com/docker](https://docs.ollama.com/docker) and the [FAQ](https://docs.ollama.com/faq) in November 2026.

**Variables.** The provider is chosen by the environment, not by the code, so one image works with any of them. The set is the same as in the project README from chapter 5.5 (AIL-25):

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

Ollama computes the embeddings, so we need it even when answers come from DeepSeek.

**Native Ollama or a container depends on the OS.** In Docker Desktop on macOS the GPU is not available (there is no GPU passthrough), so the `ollama/ollama` container on macOS runs on the CPU only, many times slower than the native app, which uses Metal. The setup for macOS (and for Windows with Docker Desktop): Ollama is installed as a regular app and listens on `127.0.0.1:11434`, and the assistant container reaches it at `http://host.docker.internal:11434` (as in the diagram above). Changing `OLLAMA_HOST` to `0.0.0.0` for this is unnecessary and not allowed: Ollama does not check a password, and it would be open to the whole network (more in chapter 10.4). With colima or OrbStack, if there are problems, we read their documentation on host access instead of opening Ollama to the network. On Linux, `host.docker.internal` points to the Docker bridge, not to the host's `127.0.0.1`, so there an `ollama` service in compose is simpler.

**Ollama in a container is for the reviewer and for Linux.** So that someone without Ollama can start the project with one command, we add a service under a profile; it starts only on request:

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

`docker compose --profile local-llm up -d`, then download the models once: `docker compose exec ollama ollama pull bge-m3` and `docker compose exec ollama ollama pull qwen3:4b`. In this mode the app gets `OLLAMA_BASE_URL=http://ollama:11434/v1`. The port is not published: if we do need it from the host, only as `127.0.0.1:11435:11434` (11434 may be taken by the native Ollama). For NVIDIA GPUs on Linux the documentation gives `--gpus=all` and the NVIDIA Container Toolkit.

**Memory.** On macOS and Windows, containers get only the memory of the Docker virtual machine (a Docker Desktop setting), and Langfuse with its storage takes several gigabytes by itself. The course's rough guide: 8 GB RAM means a 3–4B model (`qwen3:4b`), with Langfuse barely fitting alongside; 16 GB means 7–8B and the whole stack; 32 GB+ means 14B and larger.

**DeepSeek in a container** is ordinary outbound HTTPS, nothing special. We keep the data in mind: the container with the shop database snapshot (`data/shop.db`, projects 1 and 4) does not get `DEEPSEEK_API_KEY` at all, so it has no way to send anything to the cloud. The assistant does have the key, and the rule is enforced by `contains_personal_data` in `ask()`; real customer messages go only with `ANSWER_PROVIDER=ollama`.

| What for this chapter | Claude / OpenAI | DeepSeek | Ollama |
|---|---|---|---|
| What to put in `.env` | the key | the key | nothing secret, only `OLLAMA_BASE_URL` and the models |
| Where it runs | cloud | cloud | macOS: natively (Metal), in Docker CPU only; Linux: a container |
| Address from the container | the public API | `https://api.deepseek.com` | `host.docker.internal:11434` (native, Docker Desktop) or `ollama:11434` (compose service) |
| What to keep in a volume | — | — | the models (`/root/.ollama`), gigabytes |

## Learning path

1. Open [Docker: Get started](https://docs.docker.com/get-started/) → the sections on concepts (what a container, an image, a registry and compose are) and the workshop up to the steps on multi-container apps and volumes (≈60 min). Pay attention to the difference between a bind mount and a named volume; we will need it for the index and the Langfuse data.
2. [Using uv in Docker](https://docs.astral.sh/uv/guides/integration/docker/) → the sections on installing uv in an image, caching and intermediate layers, `.dockerignore`, `UV_COMPILE_BYTECODE` (≈25 min). Take the current uv version for `COPY --from` from there.
3. [Docker Compose docs](https://docs.docker.com/compose/) → the sections on `services`, `ports`, `env_file`/`environment`, `depends_on`, `include`, `profiles` and the page on environment variables in Compose (≈30 min). Note the precedence: what overrides what when a variable is set in several places.
4. [Langfuse self-hosting: Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose) → which services start, which ports, where the `# CHANGEME` lines are (≈20 min). Note which port may conflict with apps that are already running.
5. [Ollama: Docker](https://docs.ollama.com/docker) → the start commands, the volume for models, the GPU option (≈10 min), and in the [Ollama FAQ](https://docs.ollama.com/faq) the paragraph on GPUs in Docker Desktop on macOS and on `OLLAMA_HOST` (≈10 min).
6. In the same Docker docs, find the section on build secrets (`--mount=type=secret`): read it only, to understand the difference between a build secret and a runtime secret (≈10 min).

## What to watch out for

- **`.env` in the image.** The most common and most expensive mistake. After the build we check: `docker run --rm <image> ls -la /app`; `.env` must not be there.
- **Data in the image.** `find /app -name '*.db*'` finds nothing in a fresh assistant image; there is no `outputs/` in the image.
- **`localhost` inside a container** is the container. A neighboring service is reached by its service name, the native Ollama by `host.docker.internal`.
- **`0.0.0.0` inside, `127.0.0.1` in `ports`.** Inside the container, listen on all interfaces; on the host, publish only on loopback until there is a reason to do otherwise.
- **Root in the container.** By default the process runs as root. If the app has a vulnerability (and an LLM app that reads other people's text is exactly that kind of place, see chapter 8.4), it has no use for extra privileges. `USER app`.
- **A huge image.** `python:3.12` (not slim) plus torch from the dependencies easily add up to 5+ GB. It is pulled in by `EMBED_BACKEND=st` and the local reranker; check which one exactly (`uv tree`).
- **Unpinned tags.** `FROM python:latest` and `uv:latest` build today and not in a month. Pin versions; for the paranoid, a digest `@sha256:...`. It is the same principle as pinning packages in a lock file.
- **Third-party images** are third-party code. We use only official ones (`python`, `ghcr.io/astral-sh/uv`, `ollama/ollama`, the Langfuse images from their repository), check who publishes them, and don't pull "convenient" builds by unknown authors.
- **Langfuse data** lives in volumes. `docker compose down -v` wipes it. So do the Ollama models and the index.
- **Ollama in a container on macOS** has no GPU. We don't draw conclusions about local model speed from such a measurement.
- **Ollama models in the image** (`RUN ollama pull` in the Dockerfile) make an image of many gigabytes; models go in a volume and are downloaded after startup.
- **A DeepSeek key in a container that sees the shop database snapshot** is an extra path for personal data to leak. We don't pass a cloud key to such a container.
- **The database snapshot and customer messages never go into the image or the repository.** The portfolio demo runs on made-up data; if the project reads a snapshot, it is mounted as a volume only locally, only read-only (`:ro`), and created with `VACUUM INTO`, not `cp`. `../shop-live/` is never mounted into containers.

## Practice

- [ ] Install Docker following the official instructions for your OS: Docker Desktop (macOS, Windows; on macOS OrbStack or colima also work) or Docker Engine (Linux). On macOS, before the first launch, run `codesign -dv` and `spctl -a -vv` on the downloaded app. `docker version` and `docker compose version` work.
- [ ] In `projects/02-support-kb-rag/` create `.dockerignore`, `.env.example` without values and `scripts/start.sh`; read the index path from `INDEX_PATH`.
- [ ] Write the `Dockerfile` following the pattern from the theory. Build it: `docker build -t rag-assistant .`. Note the time of the first build.
- [ ] Change one line in the code and rebuild. Expected result: the dependencies step is `CACHED`, and the build takes seconds. If not, the order of the steps is wrong.
- [ ] Check that the image has no secrets and no data:
  ```bash
  docker run --rm rag-assistant sh -c 'ls -la /app; find /app -name "*.db*"; env | grep -i key || true'
  docker history rag-assistant   # no keys in any layer command
  ```
- [ ] Run the container by hand with the keys from the file (the native Ollama is running, and `.env` has `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`): `docker run --rm --env-file .env -p 127.0.0.1:8501:8501 rag-assistant`. The assistant answers "can I return opened tea?" with a link to `kb/returns.md#opened-tea-returns`.
- [ ] Download the official Langfuse `docker-compose.yml` into `langfuse/` in your repository and read it in full. Replace every `# CHANGEME` with variables from `.env`, generating the values with `openssl rand -hex 32`. Remap the web port to `127.0.0.1:3001`.
- [ ] Write `compose.yaml` with an `include` of Langfuse and the `rag-app` service. `LANGFUSE_BASE_URL` for the app is `http://langfuse-web:3000` (check the exact service name in their file).
- [ ] `docker compose up --build`. Ask the assistant 3 questions from the golden set on DeepSeek (for example, "does TEA15 stack with a discount?"), open `http://127.0.0.1:3001` and find the traces.
- [ ] Switch to `ANSWER_PROVIDER=ollama`: without rebuilding the image, the assistant answers with the local model.
- [ ] Add the `ollama` service under the `local-llm` profile (an image with a pinned tag, a volume for the models, no `ports`). Start it with the profile, download `bge-m3` and `qwen3:4b` with `docker compose exec`, switch `OLLAMA_BASE_URL` to `http://ollama:11434/v1`. Compare tokens/s with the native Ollama and write in the README which option we recommend for which OS and why.
- [ ] `docker compose down` and `up` again: the traces and the index are still there. (Don't use `-v`.)
- [ ] Stop the Langfuse container: `docker compose stop langfuse-web`. The assistant must keep answering (tracing does not block the answer). If it fails, add it to the tasks for chapter 10.3.
- [ ] A "Running" section in the README:
  ```markdown
  ## Running
  1. git clone ... && cd support-kb-rag
  2. cp .env.example .env  # fill in DEEPSEEK_API_KEY etc.
  3. docker compose up --build
     # without a native Ollama or without a cloud key: docker compose --profile local-llm up --build
  4. Assistant: http://127.0.0.1:8501, Langfuse: http://127.0.0.1:3001
  ```
- [ ] A "clean machine" check: clone the repository into a temporary folder, `docker builder prune -f`, and follow the README literally, step by step. Anything we had to do beyond the README gets added to the README.

## Done when

- A fresh clone + `.env` from `.env.example` + `docker compose up --build` starts the assistant and Langfuse with no manual steps; the index is built from `kb/` at startup.
- The image has no `.env`, keys, `index.db`, database snapshots or customer messages; `docker history` is clean.
- Ports are published on `127.0.0.1`; the app runs as a non-root user.
- The README has a "Running" section of 3–4 steps and a recommendation on where to run Ollama on different OSes.

## Self-check quiz

1. Why does a Dockerfile copy `pyproject.toml`/`uv.lock` and install the dependencies first, and the code only afterward?
2. Inside the `rag-app` container the app calls Langfuse at `http://localhost:3000` and gets `Connection refused`, even though Langfuse is running. Why, and how do we fix it?
3. How does `docker compose down` differ from `docker compose down -v` for this project?
4. What is wrong with this Dockerfile?
   ```dockerfile
   FROM python:latest
   ARG DEEPSEEK_API_KEY
   ENV DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
   COPY . /app
   RUN pip install -r requirements.txt
   CMD python app.py
   ```
5. What does `depends_on` without `condition` guarantee?
   a) that the dependency is ready to accept requests
   b) only the start order of the containers
   c) that the service restarts when the dependency crashes
   d) that the services are on the same network
6. Why does the app inside the container need to listen on `0.0.0.0`, and why does that not make it reachable from the internet?
7. What does the `--locked` flag of `uv sync` do, and what is its equivalent in the npm world?
8. An image was built on a laptop with an ARM processor (for example, Apple Silicon) and pushed to a registry, and on an `amd64` server it does not start (`exec format error`). What happened?
9. How will a native Ollama on macOS be visible from a container in Docker Desktop?
   a) `http://localhost:11434`  b) `http://ollama:11434`  c) `http://host.docker.internal:11434`  d) it won't be
10. What is `PYTHONUNBUFFERED=1` for?
11. Why must tracing not block the answer to the customer, and how was this checked in the practice?
12. Why is it better to run Ollama natively on macOS rather than in the `ollama/ollama` container?
13. What Ollama address will the app in a container use in two cases: Ollama is native on the host with Docker Desktop; Ollama is the `ollama` service in the same compose?

## Answers

1. Layers are cached, and a change in one step invalidates all the following ones. Dependencies change rarely and code often; with this order, editing the code does not trigger a reinstall of the dependencies.
2. `localhost` inside a container is the container itself. A neighboring compose service is reached by its service name: `http://langfuse-web:3000` (the container port, not the host port).
3. `down` removes the containers and the network, and the volumes remain. `down -v` also removes the named volumes: the Langfuse data, the index and the Ollama models are lost.
4. `latest` is not pinned; the key passed through `ARG`/`ENV` is baked into the image and visible in `docker history`/`docker inspect`; `COPY . /app` without `.dockerignore` drags in `.env`, `.venv`, `index.db` and everything from `outputs/`; dependencies are installed after copying the code (no cache) and without a lock file; `CMD` in shell form handles signals poorly; the process runs as root.
5. **b.** For readiness the dependency needs a `healthcheck` and `condition: service_healthy`, and better still, the app should tolerate the dependency being unavailable.
6. A container port is reachable from outside only through port forwarding; if the app listens on `127.0.0.1` inside the container, forwarded traffic will not reach it. `ports:` opens the service to the outside, and there we specify `127.0.0.1:...`, that is, only for our own machine.
7. It fails if the lock file does not match `pyproject.toml`, and installs the exact versions from the lock. The equivalent is `npm ci`.
8. The image was built for `arm64`. We need a multi-architecture build with `docker buildx build --platform linux/amd64,linux/arm64` or a build from source on the server.
9. **c.** `host.docker.internal` works in Docker Desktop and most alternatives on macOS; on Linux we may have to add it with `extra_hosts: ["host.docker.internal:host-gateway"]`, and it points to the Docker bridge, not to the host's `127.0.0.1`.
10. Without it, Python's stdout is buffered, and logs show up in `docker compose logs` late or are lost on a crash.
11. Tracing is an auxiliary function; if the customer gets no answer because Langfuse is unavailable, observability has become a point of failure. The check is to stop the Langfuse container and make sure the assistant still answers.
12. Docker Desktop on macOS has no GPU passthrough, so the container runs on the CPU and is many times slower; the native Ollama uses the Apple Silicon GPU through Metal.
13. Native: `http://host.docker.internal:11434`. Compose service: `http://ollama:11434`, by service name on the shared network, without publishing the port.

## What's next

The project starts with one command; now we make it cheap and resilient: in chapter 10.2 · Prompt caching, budgets, fallbacks (AIL-45) we measure the savings from DeepSeek's cache and add Ollama as a fallback provider, and in chapter 10.3 · Tracing an LLM application and the cost of an answer (AIL-46) the Langfuse we connected here becomes a cost and latency dashboard.
