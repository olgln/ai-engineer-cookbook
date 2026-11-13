# 6.4 · Скрипт оценки: retrieval + faithfulness  (AIL-29)

> **Неделя 6** · Evals · ⏱ ~4–5 ч · Проект

## Зачем это AI-инженеру

Набор без скрипта — просто файл. Скрипт оценки превращает каждое изменение (чанкинг, модель, промпт, реранкер) в таблицу цифр за одну команду, как `npm test` превращает правку в зелёные или красные тесты. Это основной рабочий инструмент Проекта 3: все эксперименты недели 8 будут запусками этого скрипта. На собеседованиях часто просят описать eval-пайплайн для RAG: какие метрики, как устроен судья, как ты проверил, что судье можно верить.

## Теория

### Архитектура прогона

```
 dataset.jsonl ──► для каждого вопроса:
                      │
                      ├─ retrieve(question, k) ──► top-k чанков ──► метрики поиска
                      │                                            (hit@k, MRR)
                      ├─ answer(question, chunks) ──► ответ + usage + latency
                      │
                      ├─ judge_correctness(question, reference, answer)  ─┐
                      └─ judge_faithfulness(answer, chunks)               ─┴► метрики ответа
                                                                              
 ──► results.jsonl (по вопросу)  +  summary.json (агрегаты)  +  config.json
```

Важное архитектурное решение: **RAG-пайплайн должен принимать конфигурацию**, а не жёстко зашитые параметры. Тогда эксперимент — это другой конфиг, а не правка кода:

```python
config = {
    "index": "headings-v1",        # which chunking / index to use
    "retriever": "hybrid",         # vector | bm25 | hybrid
    "k": 5,
    "reranker": None,              # or a cross-encoder model name
    "answer_model": "<model id>",  # see provider docs for current ids
    "answer_prompt": "answer-v3",
    "judge_model": "<model id>",
    "judge_prompt": "judge-v2",
}
```

### Метрики поиска

**Релевантный чанк.** Как решили в [AIL-28](AIL-28.md), чанк релевантен, если содержит цитату `evidence`. Для вопроса с несколькими цитатами релевантных чанков несколько.

**hit rate@k** — доля вопросов, где хотя бы один релевантный чанк есть в топ-k.

**recall@k** — для вопросов с несколькими цитатами: доля цитат, покрытых топ-k. Для сравнительных вопросов это честнее hit rate: найти Bybit, но не найти OKX — половина работы.

**MRR (Mean Reciprocal Rank)** — среднее по вопросам от `1/rank` первого релевантного чанка (0, если в топ-k его нет).

Пример на трёх вопросах, k = 5:

| Вопрос | Позиция первого релевантного | hit@5 | 1/rank |
|---|---|---|---|
| q1 | 1 | 1 | 1,00 |
| q2 | 3 | 1 | 0,33 |
| q3 | не найден | 0 | 0 |
| **Итого** | | **0,67** | **MRR = 0,44** |

Hit rate отвечает на вопрос «найдено ли вообще», MRR — «насколько высоко». Если ты передаёшь в модель все 5 чанков, hit rate@5 важнее; если планируешь сокращать контекст до 2–3 чанков, смотри на MRR и hit@3.

Вопросы `unanswerable` в метрики поиска не входят (там нечего находить), их считают отдельно по доле правильных отказов.

```python
def is_relevant(chunk_text: str, evidence: list[str]) -> bool:
    t = normalize(chunk_text)
    return any(normalize(e) in t for e in evidence)

def retrieval_metrics(retrieved: list[str], evidence: list[str], k: int) -> dict:
    ranks = [i + 1 for i, text in enumerate(retrieved[:k]) if is_relevant(text, evidence)]
    covered = sum(any(normalize(e) in normalize(t) for t in retrieved[:k]) for e in evidence)
    return {
        "hit": int(bool(ranks)),
        "rr": 1 / ranks[0] if ranks else 0.0,
        "recall": covered / len(evidence),
    }
```

### Метрики ответа

**Correctness** — совпадает ли ответ по смыслу с эталоном. Судья получает вопрос, эталон, `must_include` и ответ.

**Faithfulness (groundedness)** — подтверждается ли каждое утверждение ответа найденными чанками. Судья получает ответ и чанки, эталон ему не нужен. Это ловит галлюцинации, даже если ответ случайно верный.

**Relevance** — отвечает ли ответ на вопрос. Для RAG по докам обычно редко ломается; можно не реализовывать в первой версии.

**Правильный отказ** — для `unanswerable`: ответ должен быть отказом. Проверяется судьёй или простым правилом, если твой промпт из [AIL-23](AIL-23.md) требует фиксированную фразу («в документации не нашёл»). Обратная ошибка тоже важна: **ложный отказ** на отвечаемый вопрос.

Комбинации correctness и faithfulness говорят о разном:

| correctness | faithfulness | Что это значит |
|---|---|---|
| PASS | PASS | Всё хорошо |
| PASS | FAIL | Модель знала ответ «из головы»; опасно, потому что в другой раз выдумает |
| FAIL | PASS | Ответ опирается на найденное, но найдено не то (смотри hit) или эталон неверен |
| FAIL | FAIL | Галлюцинация |

### Судья: бинарный, с критикой

Подход из [AIL-27](AIL-27.md): `{"critique": ..., "verdict": "PASS"|"FAIL"}`, критика перед вердиктом, temperature 0 (если провайдер её поддерживает для выбранной модели), структурированный вывод. Промпт судьи для faithfulness (иллюстративно):

```python
FAITHFULNESS_PROMPT = """You check whether an answer is supported by the provided documentation excerpts.

<excerpts>
{chunks}
</excerpts>

<answer>
{answer}
</answer>

List each factual claim in the answer (numbers, names, endpoints, conditions).
For each claim decide if the excerpts support it. General phrasing and
"I could not find this in the docs" are not claims.

Verdict PASS only if every claim is supported. Return JSON:
{{"claims": [{{"claim": "...", "supported": true}}], "critique": "...", "verdict": "PASS" | "FAIL"}}
"""
```

Для faithfulness разбор на утверждения внутри промпта делает судью заметно точнее, чем вопрос «ответ опирается на контекст?».

### Проверка судьи

Судья — модель, поэтому сначала проверяешь его, потом веришь цифрам:

1. Прогони набор, возьми 20 ответов (лучше смесь, где судья ставил и PASS, и FAIL).
2. **Не глядя на вердикт судьи**, разметь их сам: PASS/FAIL + причина.
3. Построй таблицу согласия:

```
                 ты: PASS   ты: FAIL
 судья: PASS        11          2      ← 2 плохих ответа судья пропустил
 судья: FAIL         1          6      ← 1 хороший ответ судья забраковал
```

4. Посчитай: общее согласие (17/20 = 85%), долю пойманных плохих ответов (6/8 = 75%, это TNR в терминах Hamel), долю правильно принятых хороших (11/12 ≈ 92%, TPR).
5. Прочитай все расхождения. Обычно причина видна: судья не сверяет числа, не знает, что «8h» и «каждые 8 часов» одно и то же, и т.п. Поправь промпт, добавь few-shot пример, прогони снова.

На 20 примерах эти доли очень грубые (подробнее о шуме в [AIL-62](AIL-62.md)), но расхождения покажут явные дефекты судьи. Когда разметки станет больше, раздели её: на одной части правишь промпт судьи, на другой проверяешь, иначе подгонишь судью под свои 20 примеров.

### Стоимость и латентность

Каждый ответ API возвращает число входных и выходных токенов (`usage`). Стоимость:

```
cost = input_tokens × price_in / 1e6 + output_tokens × price_out / 1e6
```

Цены зависят от модели и меняются; держи их в `evals/prices.json` и обновляй по странице цен провайдера, не хардкодь в коде. Считай отдельно стоимость **системы** (то, что будет платить продукт) и стоимость **оценки** (судья). В отчёт идёт стоимость системы на 100 вопросов, она пригодится в [AIL-33](AIL-33.md). Учти также кеширование промптов, если используешь его: у кешированных токенов своя цена.

Латентность — время от вопроса до ответа (поиск + генерация), меряется `time.perf_counter()`. Смотри медиану и p90, а не только среднее: один зависший запрос портит среднее.

### Сохранение прогонов

Каждый прогон — отдельная папка:

```
evals/runs/2026-12-24T14-05_headings-v1_hybrid_k5/
  config.json      # full config + git commit + dataset hash + timestamp
  results.jsonl    # per question: retrieved ids, ranks, answer, verdicts, critiques, tokens, latency
  summary.json     # aggregates
  report.md        # human-readable table
```

Без `results.jsonl` ты не сможешь разобрать ошибки ([AIL-34](AIL-34.md)), без `config.json` через неделю не вспомнишь, что это был за прогон. Добавь `evals/runs/` в git или хотя бы `summary.json` и `config.json`: история прогонов — материал для README.

### Практические детали скрипта

- **Параллельность.** 80 вопросов по 3 вызова последовательно — минуты. `concurrent.futures.ThreadPoolExecutor(max_workers=4–8)` ускоряет в разы; следи за rate limits провайдера.
- **Ретраи.** Ошибка API на одном вопросе не должна валить прогон: ретрай с паузой, после N неудач вопрос помечается `error` и считается отдельно.
- **Кеш.** Кешируй ответы судьи по хешу (промпт судьи + вход). Повторный прогон того же ответа не стоит денег.
- **Срезы.** Агрегируй метрики не только целиком, но и по `type`, `exchanges`, `origin`. Общая цифра прячет провалы.
- **`--split dev` по умолчанию.** Holdout только явным флагом.

### Скелет `evals/run.py`

```python
# evals/run.py  (illustrative skeleton, not a full solution)
import argparse, hashlib, json, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from rag import retrieve, answer           # your Project 2 pipeline, config-driven
from judges import judge_correctness, judge_faithfulness

def eval_item(item: dict, cfg: dict) -> dict:
    t0 = time.perf_counter()
    chunks = retrieve(item["question"], cfg)          # list of {"id", "text", "url"}
    reply = answer(item["question"], chunks, cfg)     # {"text", "usage"}
    latency = time.perf_counter() - t0
    res = {"id": item["id"], "type": item["type"], "latency": latency,
           "retrieved": [c["id"] for c in chunks], "answer": reply["text"],
           "usage": reply["usage"]}
    if item["type"] != "unanswerable":
        res |= retrieval_metrics([c["text"] for c in chunks], item["evidence"], cfg["k"])
    res["correctness"] = judge_correctness(item, reply["text"], cfg)    # {"verdict", "critique"}
    res["faithfulness"] = judge_faithfulness(reply["text"], chunks, cfg)
    return res

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--split", default="dev")
    args = ap.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    raw = Path("evals/dataset.jsonl").read_bytes()
    items = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    items = [i for i in items if i["split"] == args.split]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda it: eval_item(it, cfg), items))
    meta = {"config": cfg, "split": args.split, "started": datetime.now().isoformat(),
            "dataset_sha": hashlib.sha256(raw).hexdigest()[:12],
            "git": subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                  capture_output=True, text=True).stdout.strip()}
    ...  # aggregate (overall + per type), compute cost from prices.json, write run folder, print table

if __name__ == "__main__":
    main()
```

Ожидаемый вывод в терминале:

```
run 2026-12-24T14-05 | headings-v1 hybrid k=5 | dataset 3f2a9c1e0b77 | dev n=56
hit@5 0.82  MRR 0.64  recall@5 0.77
correctness 0.71  faithfulness 0.86  refusal_ok 7/8  false_refusals 2
system cost $0.41 per 100 q  | judge cost $0.95  | latency p50 2.1s p90 4.8s
by type: factual 0.80 | comparative 0.50 | multi_hop 0.58 | unanswerable 0.88
```

Цифры выдуманы для примера формата.

### Ragas: зачем смотреть и почему не сразу

[Ragas](https://docs.ragas.io) — библиотека готовых RAG-метрик (faithfulness, context precision/recall, answer correctness и др.), внутри — те же LLM-судьи. Свой скрипт сначала нужен затем, чтобы понимать, что именно меряется: у Ragas свои промпты судей, своя агрегация и свои значения по умолчанию, и без понимания ты не объяснишь, почему faithfulness 0,73. Когда свой скрипт работает, можно прогнать Ragas на тех же данных и сравнить: совпадают ли выводы.

## DeepSeek и Ollama: как это сделать у нас

Скрипт целиком переносится на наш стек: ответчик — `deepseek-flash` (или локальная модель для сравнения), судья — `deepseek-v4-pro`, второе мнение — Claude или OpenAI на подвыборке, Ollama — локальный ответчик и эмбеддинги. Ниже то, что меняется в коде судей, в подсчёте стоимости и в параллельности. Факты сверены в ноябре 2026 по [api-docs.deepseek.com](https://api-docs.deepseek.com) и [docs.ollama.com](https://docs.ollama.com); id моделей и цены проверяй перед прогоном.

### Судья на DeepSeek

```python
# evals/judges.py — DeepSeek judge (illustrative)
import json, os
from openai import OpenAI

ds = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")

def judge_deepseek(prompt: str, model: str = "deepseek-v4-pro", retries: int = 3) -> dict:
    for attempt in range(retries):
        r = ds.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},      # prompt must say "JSON" and show the structure
            temperature=0,
            max_tokens=1000,
            extra_body={"thinking": {"type": "disabled"}},  # temperature is ignored in thinking mode
        )
        text = (r.choices[0].message.content or "").strip()
        if not text:
            continue  # JSON mode may return blank content; retry
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        if data.get("verdict") in ("PASS", "FAIL"):
            return {**data, "judge_model": r.model, "usage": r.usage.model_dump()}
    return {"verdict": "ERROR", "critique": f"no valid JSON after {retries} attempts"}
```

Три вещи, которых нет у Claude/OpenAI или которые там устроены иначе:

1. **Thinking включён по умолчанию**, и в нём `temperature` молча не действует. Для судьи по умолчанию выключай рассуждения: так вердикты стабильнее, дешевле и быстрее. Режим с рассуждениями — отдельный кандидат в судьи: включи его и сравни согласие с твоей разметкой; если согласие заметно выше, бери его и мерь разброс повторными прогонами (глава [8.1 · Статистика evals: шум и размер выборки](AIL-62.md)).
2. **JSON mode без схемы.** Поэтому проверка `verdict in ("PASS", "FAIL")` в коде обязательна, а промпт судьи должен содержать пример JSON (в `FAITHFULNESS_PROMPT` выше он есть). Ответ `ERROR` считай отдельно, а не как FAIL.
3. **`seed` в документации DeepSeek не описан.** Повторяемость судьи даёт только temperature 0 без thinking плюс твой кеш вердиктов.

### Почему не судья на Ollama

У тебя Apple M2 с 8 ГБ памяти, и на нём же работает арбитражное приложение. Реально это модели класса 4B (например, `qwen3:4b`); 7–8B — только закрыв всё остальное и не держа автоторговлю включённой; 14B и больше не помещаются. Модель такого размера слабее и ответчика `deepseek-flash`, и тем более судьи `deepseek-v4-pro`: судья, который ошибается чаще оцениваемой системы, не измеряет ничего. Поэтому локальный судья в этой главе — только учебная иллюстрация (код ниже) и, при желании, способ один раз увидеть, насколько у него хуже согласие с твоей разметкой.

```python
# illustrative; native API gives schema-constrained output and per-request num_ctx
import ollama
from typing import Literal
from pydantic import BaseModel

class Verdict(BaseModel):
    critique: str                      # field order matters: critique before verdict
    verdict: Literal["PASS", "FAIL"]

def judge_ollama(prompt: str, model: str = "qwen3:4b") -> Verdict:
    r = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        format=Verdict.model_json_schema(),
        options={"temperature": 0, "seed": 42, "num_ctx": 8192},  # 5 chunks + prompt need room; mind 8 GB RAM
    )
    return Verdict.model_validate_json(r.message.content)
```

Та же ловушка касается и локального **ответчика**: **контекст**. По умолчанию Ollama даёт 4k токенов, если у Mac меньше 24 ГБ доступной GPU-памяти (у тебя 8 ГБ, значит 4k). Пять чанков по 600 токенов плюс промпт и ответ уже около 4k: хвост контекста обрежется без ошибки, и судья поставит FAIL за «неподтверждённое» утверждение, подтверждение которого просто не дошло. В нативном API задавай `num_ctx` в `options`, через OpenAI-совместимый эндпоинт размер контекста задать нельзя (нужен `OLLAMA_CONTEXT_LENGTH` при запуске сервера или Modelfile с `PARAMETER num_ctx`). Проверяй `ollama ps`: колонка CONTEXT и то, что модель целиком на GPU (PROCESSOR). На 8 ГБ контекст поднимай осторожно, до 8k: он тоже занимает память, а рядом работает арбитражное приложение. Если не влезает — уменьши k или размер кусков для локального варианта и запиши это в конфиг.

### Какой судья главный

| Кандидат в судьи | Плюсы | Минусы | Роль |
|---|---|---|---|
| `deepseek-v4-pro`, thinking выключен | сильнее Flash, стабилен, центы за прогон | одно семейство с ответчиком `deepseek-flash` | главный судья |
| `deepseek-v4-pro`, thinking включён | обычно точнее на сложных случаях | temperature не действует, больше шум, рассуждения стоят как выходные токены | кандидат, если согласие выше |
| `deepseek-flash` | вдвое-вчетверо дешевле | судит сам себя, слабее | только для дешёвых предварительных проверок |
| Claude / OpenAI | сильные судьи, другие семейства, ловят самопредпочтение DeepSeek | дороже, нужны отдельные ключи | второе мнение: прогон на твоих 20 размеченных ответах |
| локальная модель в Ollama (4B на твоём Mac) | бесплатно, приватно | слабее оцениваемой системы, нужен большой контекст | не судья; максимум учебное сравнение согласия |

Выбор делается не по таблице, а по согласию с твоей разметкой: прогоняешь 2–3 кандидатов на тех же 20 ответах и берёшь того, у кого выше TNR (доля пойманных плохих ответов) при приемлемом TPR.

### Стоимость с кешем и часами пик

У DeepSeek три цены за токены, и две из них зависят от времени суток. На ноябрь 2026 (USD за 1M токенов):

| Модель | вход, кеш-попадание | вход, кеш-промах | выход |
|---|---|---|---|
| `deepseek-flash`, пик | 0,006 | 0,30 | 1,20 |
| `deepseek-flash`, вне пика | 0,003 | 0,15 | 0,60 |
| `deepseek-v4-pro`, пик | 0,044 | 1,32 | 3,96 |
| `deepseek-v4-pro`, вне пика | 0,022 | 0,66 | 1,98 |

Пик — с понедельника по пятницу 01:00–04:00 и 06:00–10:00 UTC (кроме праздников Китая), остальное время и выходные — вне пика. Кеширование автоматическое: в `usage` приходят `prompt_cache_hit_tokens` и `prompt_cache_miss_tokens`. В RAG попадает в кеш в основном общий префикс (системный промпт), куски контекста у каждого вопроса свои.

```python
# evals/cost.py (illustrative); prices.json: {"deepseek-flash": {"peak": {"in_hit":..,"in_miss":..,"out":..}, "offpeak": {...}}, "updated": "2026-11-.."}
from datetime import datetime, timezone

def is_peak(ts: datetime) -> bool:
    # DeepSeek peak hours per pricing page: Mon-Fri 01:00-04:00 and 06:00-10:00 UTC
    t = ts.astimezone(timezone.utc)
    return t.weekday() < 5 and (1 <= t.hour < 4 or 6 <= t.hour < 10)

def deepseek_cost(usage: dict, price: dict, ts: datetime) -> float:
    p = price["peak" if is_peak(ts) else "offpeak"]
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("prompt_cache_hit_tokens", 0)) or 0
    miss = usage.get("prompt_cache_miss_tokens", usage["prompt_tokens"] - hit)
    return (hit * p["in_hit"] + miss * p["in_miss"] + usage["completion_tokens"] * p["out"]) / 1e6
```

Поля кеша в справочнике API описаны внутри `prompt_tokens_details`, а в примере ответа лежат прямо в `usage`, поэтому код смотрит в оба места. Ollama стоит $0 за токены: в отчёт для неё пиши «$0 API» и латентность на твоём железе.

**Порядок стоимости прогона** (оценка, не измерение): допустим, на вопрос приходится ответ ~3500 входных + 300 выходных токенов и два вызова судьи суммарно ~4400 входных + 700 выходных.

| Конфигурация | на вопрос, пик | 60 вопросов, пик | 60 вопросов, вне пика |
|---|---|---|---|
| ответ Flash + судья Pro (без thinking) | ≈ $0,010 | ≈ $0,60 | ≈ $0,30 |
| ответ Flash + судья Flash | ≈ $0,0036 | ≈ $0,21 | ≈ $0,11 |
| ответ Ollama + судья Pro | ≈ $0,0086 | ≈ $0,51 | ≈ $0,26 |

Судья с рассуждениями добавит выходные токены (в `usage.completion_tokens_details.reasoning_tokens`) и может подорожать в разы. Сверь оценку с фактом первого прогона. Claude и OpenAI для сравнения посчитай по их страницам цен тем же кодом с другим `prices.json`.

### Параллельность и лимиты

- **DeepSeek** ограничивает не запросы в минуту, а одновременные запросы на аккаунт (на ноябрь 2026: 2500 для Flash и 500 для Pro), сверх лимита — HTTP 429. Твои `max_workers=6` далеко от лимита; ретраи на 429 всё равно нужны. Пока инференс не начался, сервер держит соединение пустыми строками (keep-alive) и закрывает его через 10 минут, поэтому ставь клиенту разумный timeout.
- **Ollama** по умолчанию обрабатывает запросы к одной модели по одному (`OLLAMA_NUM_PARALLEL`, по умолчанию 1), остальные ждут в очереди. `ThreadPoolExecutor` с 6 потоками локальный прогон не ускорит, а латентность исказит: в неё попадёт ожидание в очереди. Для локальной модели гоняй последовательно; поднимать параллельность на 8 ГБ не стоит: память растёт пропорционально параллельность × контекст.

### Сравнение провайдеров для этой главы

| Что нужно скрипту | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Стабильный судья (`temperature=0`) | да, с оговорками у части новых моделей | да, кроме reasoning-моделей | только с `thinking: disabled` | да, плюс `seed` |
| Вердикт по схеме | structured outputs / tool use | JSON-схема | `json_object` + проверка в коде | `format` с JSON-схемой |
| Токены в `usage` | input/output + токены кеша | prompt/completion + `cached_tokens` | prompt/completion + `prompt_cache_hit/miss_tokens` | `prompt_eval_count` / `eval_count` в нативном API |
| Кеш промпта | явные пометки `cache_control` | автоматический | автоматический | не нужен, токены бесплатны |
| Цена зависит от времени суток | нет | нет (есть отдельные пакетные режимы, см. доку) | да, пик и вне пика | нет |
| Лимиты | RPM/TPM по уровню аккаунта | RPM/TPM по уровню | одновременные запросы на аккаунт | память Mac и `OLLAMA_NUM_PARALLEL` |
| `logprobs` | нет | есть у части моделей | параметр есть | через OpenAI-совместимый API нет |

## Маршрут изучения

1. Открой [Hamel: Creating a LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) → перечитай разделы про измерение согласия с экспертом и итерацию промпта (≈20 мин). Это методичка для шага «проверить судью».
2. Открой [Eugene Yan: Evaluating the Effectiveness of LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/) → разделы про метрики согласия и про оценку faithfulness/фактической согласованности (≈30 мин). Обрати внимание, как плохо судьи справляются без разбора на утверждения.
3. Открой [Ragas docs](https://docs.ragas.io) → раздел с метриками (metrics), прочитай описания faithfulness, context precision, context recall (≈25 мин). Сравни с тем, как ты определил метрики выше: что они считают иначе.
4. Открой [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) → раздел про грейдеры (code-based, LLM-based) (≈15 мин).
5. Открой документацию своего провайдера: как достать `usage` из ответа и страницу цен (≈10 мин). Цены перенеси в `evals/prices.json`.
6. Python-справка по мере надобности: [concurrent.futures](https://docs.python.org/3/library/concurrent.futures.html), [argparse](https://docs.python.org/3/library/argparse.html).
7. Открой [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode), [JSON Output](https://api-docs.deepseek.com/guides/json_mode), [Context Caching](https://api-docs.deepseek.com/guides/kv_cache), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) и [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) (≈30 мин). Выпиши: как выключить thinking через `extra_body`, поля кеша в `usage`, часы пик, лимит одновременных запросов. Цены перенеси в `evals/prices.json` с датой.
8. Открой [Ollama: Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) (разделы про контекст, параллельные запросы, keep_alive) и [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈20 мин). Главное: контекст по умолчанию зависит от памяти и может молча обрезать чанки.

## На что обратить внимание

- **Судья без проверки — не метрика.** Пока не сделана сверка на 20 ответах, цифра correctness ничего не значит.
- **Один и тот же модельный вызов для ответа и для судьи** (та же модель, тот же промпт-стиль) усиливает самопредпочтение. Если возможно, судья другой модели или хотя бы проверен на разметке.
- **Чанк режет цитату** — hit = 0, хотя ответ найден. Смотри на промахи поиска руками перед выводами.
- **Faithfulness штрафует отказ?** Отказ «не нашёл в документации» не содержит утверждений и должен получать PASS. Проверь, что судья так и делает.
- **Средняя латентность врёт** из-за выбросов: смотри p50/p90.
- **Цены в коде устаревают.** Отдельный файл цен с датой обновления.
- **Ошибки API считаются как FAIL** — это искажает качество. Считай их отдельно (`errors: 2`) и перезапускай.
- **Holdout случайно в прогоне** — `--split dev` по умолчанию.
- **Утечка ключей**: ключи только из окружения/`.env` в `.gitignore`. В `config.json` прогона ключей быть не должно; проверь, что ты не сериализуешь объект клиента целиком.
- **Судья DeepSeek «с temperature 0» в режиме thinking** — temperature не действует, вердикты шумят. Выключай рассуждения явно и записывай режим в `config.json`.
- **`ERROR` судьи учтён как FAIL.** Пустой `content` в JSON mode DeepSeek и невалидный JSON — инфраструктурная ошибка, а не плохой ответ системы.
- **Локальный судья с обрезанным контекстом** ставит FAIL faithfulness верным ответам. Проверь `num_ctx`/`OLLAMA_CONTEXT_LENGTH` и сравни `prompt_eval_count` в ответе Ollama с ожидаемым числом токенов.
- **Латентность локальной модели с очередью.** При `OLLAMA_NUM_PARALLEL=1` и 6 потоках ты меряешь ожидание в очереди. Плюс первый запрос после простоя загружает модель в память (по умолчанию модель выгружается через 5 минут без запросов): сделай прогревочный запрос и не учитывай его.
- **Стоимость без учёта часов пик и кеша** ошибается в разы. Храни время вызова и поля кеша в `results.jsonl`.

## Практика

- [ ] Сделай RAG-пайплайн Проекта 2 конфигурируемым: `retrieve(question, cfg)` и `answer(question, chunks, cfg)` с возвратом `usage`. Положи базовый конфиг в `evals/configs/baseline.json`.
- [ ] `evals/metrics.py`: `normalize`, `is_relevant`, `retrieval_metrics`. Напиши 3–4 юнит-теста на них (pytest или простые `assert`): пример с таблицей из теории должен дать hit 0,67 и MRR 0,44.
- [ ] `evals/judges.py`: `judge_correctness` (вопрос, эталон, `must_include`, ответ) и `judge_faithfulness` (ответ, чанки). Бинарный вердикт, критика перед вердиктом, JSON, ретрай при невалидном JSON.
- [ ] Обработка `unanswerable`: правильный отказ / ложный отказ на отвечаемых.
- [ ] `evals/run.py`: прогон, агрегаты общие и по `type`, стоимость системы на 100 вопросов, стоимость судьи, p50/p90 латентности, сохранение папки прогона.
- [ ] Прогони baseline на dev.
- [ ] Проверка судьи: выбери 20 ответов, разметь сам в `evals/judge_labels.jsonl` (id, твой вердикт, причина), не глядя на вердикт судьи. Напиши `evals/judge_agreement.py`, печатающий таблицу 2×2, согласие, TPR, TNR и список расхождений.
- [ ] Исправь промпт судьи по расхождениям, перепрогони, запиши в `notes/evals.md` согласие до и после.
- [ ] (Опционально) Прогони Ragas faithfulness на тех же ответах и сравни с твоим судьёй.
- [ ] Ответчик в baseline-конфиге — `deepseek-flash` (`"answer_model": "deepseek-flash"`, `"answer_thinking": false`), судья — `deepseek-v4-pro` с выключенным thinking; режимы записываются в `config.json`.
- [ ] `evals/cost.py`: цена с учётом кеш-попаданий и часов пик; Ollama — `$0 API`. Сверь итог первого прогона с биллингом в кабинете DeepSeek.
- [ ] Второе мнение: судья на Claude или OpenAI на тех же 20 размеченных ответах (данные публичные). В `judge_agreement.py` выведи согласие обоих судей с тобой и друг с другом.
- [ ] Сравни `deepseek-v4-pro` с thinking и без на 20 размеченных ответах: согласие, стоимость, время. Запиши выбор.
- [ ] (Опционально, учебно) Прогони `judge_ollama` на `qwen3:4b` на тех же 20 ответах (с закрытыми лишними программами и выключенной автоторговлей) и посмотри, насколько хуже согласие. Это аргумент, почему локальная модель на 8 ГБ не судья.

## Готово, когда

- `python evals/run.py --config evals/configs/baseline.json` одной командой печатает hit rate, MRR, correctness, faithfulness, стоимость и латентность и сохраняет папку прогона с конфигом, датой, версией набора и git-коммитом.
- Судья проверен на 20 ручных оценках, согласие записано, расхождения разобраны.
- Метрики считаются по срезам (`type`).
- Для выбранного судьи (DeepSeek или Ollama) записаны модель, режим thinking, согласие с разметкой и стоимость прогона по фактическому `usage`.

## Тест для самопроверки

1. Вопрос q: релевантный чанк на позиции 4 из 5. Чему равны hit@5, hit@3 и reciprocal rank?
2. Чем recall@k полезнее hit rate для сравнительных вопросов?
3. correctness = PASS, faithfulness = FAIL. Что это значит и почему это проблема?
4. Почему судье faithfulness не нужен эталонный ответ?
5. Ты разметил 20 ответов. Судья: 14 PASS, 6 FAIL. Ты: 10 PASS, 10 FAIL. Судья совпал с тобой на всех своих FAIL. Сколько плохих ответов судья пропустил и какова его доля пойманных плохих ответов?
6. Зачем сохранять `results.jsonl`, если есть `summary.json`?
7. Почему цены моделей нужно держать в отдельном файле, а не в коде?
8. Что не так в этом коде?
   ```python
   def judge(answer, reference):
       r = client.messages.create(model=JUDGE, max_tokens=5,
           messages=[{"role": "user", "content": f"Score 1-10: {answer} vs {reference}"}])
       return int(r.content[0].text)
   ```
9. Почему вопросы `unanswerable` исключают из hit rate?
10. Почему в отчёте нужны p50 и p90 латентности, а не только среднее?
    a) так принято; b) среднее чувствительно к выбросам; c) p90 дешевле считать; d) провайдер возвращает только перцентили.
11. Зачем сначала писать свой скрипт, а не взять Ragas?
12. Почему судья на `deepseek-v4-pro` вызывается с `extra_body={"thinking": {"type": "disabled"}}`? Что будет, если этого не сделать, но оставить `temperature=0`?
13. Локальная модель на Ollama (ответчик или учебный судья) резко хуже на длинных вопросах, чем на коротких. Самая вероятная причина и как проверить?
14. Прогон на DeepSeek во вторник в 07:30 UTC стоил вдвое больше, чем такой же прогон в субботу. Ошибка в `cost.py`?
15. Почему `ThreadPoolExecutor(max_workers=6)` почти не ускоряет прогон локальной модели и портит метрику латентности?

## Ответы

1. hit@5 = 1, hit@3 = 0, RR = 1/4 = 0,25.
2. Сравнительному вопросу нужны куски с двух бирж; hit rate засчитает успех, найдя один, а recall покажет, что найдена только половина.
3. Ответ верный, но не подтверждается найденными кусками: модель взяла его из своих знаний. В другой раз она так же уверенно выдумает неверный факт, и ссылки на источник будут ложными.
4. Faithfulness проверяет согласованность ответа с найденными кусками, а не с истиной; для этого нужны только ответ и контекст.
5. Ты: 10 FAIL; судья поймал 6 из них (все его FAIL верные) и пропустил 4. Доля пойманных плохих = 6/10 = 60%.
6. Для разбора ошибок по конкретным вопросам, сравнения прогонов по вопросам (какие вопросы стали лучше/хуже) и проверки судьи. Агрегаты этого не позволяют.
7. Цены меняются и разные у разных моделей; отдельный файл с датой легко обновить и видно, по каким ценам считан прогон.
8. Шкала 1–10 вместо бинарного вердикта; нет критики (и `max_tokens=5` её не позволяет); нет вопроса и контекста; `int()` упадёт на любом лишнем тексте; нет инструкции, что считать ошибкой; нет ретраев и структурированного вывода.
9. В них нет правильного куска, искать нечего; их качество меряется долей правильных отказов.
10. **b.** Один зависший запрос сильно сдвигает среднее, а перцентили показывают типичное и «плохое» время.
11. Чтобы понимать, что меряет каждая метрика и как устроены судьи, и уметь объяснить цифры. Ragas потом полезен как сверка.
12. В режиме thinking (он по умолчанию) DeepSeek не применяет temperature, ошибки при этом нет. Без отключения вердикты будут шуметь сильнее, плюс рассуждения стоят как выходные токены и замедляют прогон.
13. Обрезанный контекст: по умолчанию Ollama даёт 4k токенов на Mac с небольшой памятью, часть чанков отбрасывается молча, и модель «не видит» нужный кусок. Проверить `ollama ps` (CONTEXT) и `prompt_eval_count` в ответе, задать `num_ctx` или `OLLAMA_CONTEXT_LENGTH` (на 8 ГБ — осторожно) либо уменьшить k.
14. Нет: будни 06:00–10:00 UTC — часы пик, цены вдвое выше, чем вне пика (выходные). Длинные прогоны выгодно ставить вне пика.
15. Ollama по умолчанию обрабатывает запросы к модели по одному (`OLLAMA_NUM_PARALLEL=1`), остальные стоят в очереди; в измеренную латентность попадает ожидание очереди.

## Что дальше

В [AIL-30 · Подключить Langfuse или promptfoo](AIL-30.md) ты сделаешь трейсы и прогоны видимыми в UI, а в [AIL-62](AIL-62.md) научишься понимать, какая разница в цифрах этого скрипта настоящая.
