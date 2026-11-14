# 6.4 · Скрипт оценки: retrieval + faithfulness  (AIL-29)

> **Неделя 6** · Evals · ⏱ ~4–5 ч · Проект

<!-- description: Скрипт оценки RAG: метрики поиска и ответа, faithfulness, бинарный LLM-судья с критикой и его проверка, стоимость прогона и сохранение результатов. -->

## Зачем это AI-инженеру

Набор без скрипта — просто файл. Скрипт оценки превращает каждое изменение (чанкинг, модель, промпт, реранкер) в таблицу цифр за одну команду, как `npm test` превращает правку в зелёные или красные тесты. Это основной рабочий инструмент Проекта 3: все эксперименты недели 8 будут запусками этого скрипта. На собеседованиях часто просят описать eval-пайплайн для RAG: какие метрики, как устроен судья, как проверили, что судье можно верить.

## Теория

### Архитектура прогона

В [AIL-28](AIL-28.md) у каждого вопроса появились эталон, `must_include` и цитаты `evidence`. Скрипт оценки прогоняет все вопросы через ассистента и сравнивает результат с этими полями на двух уровнях: что нашёл поиск и что ответила модель.

```
 eval/golden.jsonl ──► для каждого вопроса:
                      │
                      ├─ ask(question, cfg) ──► Answer: текст, отказ, куски из промпта,
                      │                          usage, latency_ms
                      │
                      ├─ куски из промпта + evidence ──► метрики поиска (hit@k, MRR, recall)
                      │
                      ├─ judge_correctness(question, reference, answer)  ─┐
                      └─ judge_faithfulness(answer, chunks)               ─┴► метрики ответа

 ──► results.jsonl (по вопросу)  +  summary.json (агрегаты)  +  config.json  +  строка в RESULTS.md
```

Скрипт вызывает ту же `ask()` из `rag/pipeline.py` ([AIL-23](AIL-23.md)), что и `app.py` и `bot.py`: оценивается ровно то, что увидит клиент. `Answer` получает два поля со значениями по умолчанию: `chunks` (куски из промпта с метаданными) и `usage` (токены из ответа API).

Важное архитектурное решение: **RAG-пайплайн должен принимать конфигурацию**, а не жёстко зашитые параметры. Тогда эксперимент — это другой конфиг, а не правка кода. `ask(question, cfg=None)`: без `cfg` параметры берутся из `.env`, как раньше. Конфиги лежат JSON-файлами в `eval/configs/` (базовый — `eval/configs/baseline.json`), а после `json.loads` это обычный словарь:

```python
config = {
    "index": "index.db",           # or index_ctx.db from 5.2
    "rewrite": True,               # plan_query from 5.1
    "retriever": "hybrid",         # vector | bm25 | hybrid
    "k": 5,
    "reranker": None,              # or a cross-encoder model name (RERANK_MODEL)
    "answer_model": "<model id>",  # see provider docs for current ids
    "answer_thinking": False,      # reasoning mode of the answer model, if the provider has one
    "answer_prompt": "answer_v1",  # prompts/answer_v1.txt
    "judge_model": "<model id>",
    "judge_prompt": "judge_v1",
}
```

### Метрики поиска

Начинаем с поиска: если нужного куска нет в контексте, модель не сможет ответить правильно, и метрики ответа будут объяснять не то.

**Релевантный чанк.** Как решили в [AIL-28](AIL-28.md), чанк релевантен, если содержит цитату `evidence` — дословную фразу из `kb/` (развитие `must_contain` из golden set недели 5). Для вопроса с несколькими цитатами релевантных чанков несколько.

**hit rate@k** — доля вопросов, где хотя бы один релевантный чанк есть в топ-k.

**recall@k** — для вопросов с несколькими цитатами: доля цитат, покрытых топ-k. Для сравнительных вопросов это честнее hit rate: в вопросе про гарантию «Свет» и «Свет мини» найти только `lamp-light.md` — половина работы.

**MRR (Mean Reciprocal Rank)** — среднее по вопросам от `1/rank` первого релевантного чанка (0, если в топ-k его нет). В [AIL-22](AIL-22.md) мы уже считали его в `eval/run_retrieval_eval.py`.

Пример, k = 5:

| Вопрос | Позиция первого релевантного | hit@5 | 1/rank |
|---|---|---|---|
| q1 | 1 | 1 | 1,00 |
| q2 | 3 | 1 | 0,33 |
| q3 | не найден | 0 | 0 |
| **Итого** | | **0,67** | **MRR = 0,44** |

Hit rate отвечает на вопрос «найдено ли вообще», MRR — «насколько высоко». Если в модель уходят все 5 чанков, hit rate@5 важнее; если планируется сокращать контекст до 2–3 чанков, смотрим на MRR и hit@3.

Вопросы `unanswerable` в метрики поиска не входят (там нечего находить), их считают отдельно по доле правильных отказов.

Отдельно код считает **архивные куски в контексте** (`archived: true`, `returns-2025.md`): это ошибка пайплайна, счётчик должен быть нулём. Функции выносим в `eval/metrics.py`, и `eval/run_retrieval_eval.py` из недели 5 импортирует их оттуда: метрики в обоих скриптах считаются одним кодом.

```python
# eval/metrics.py
import re

def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("ё", "е")).strip().casefold()

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

Поиск принёс куски; теперь проверяем, что модель из них сделала. Здесь точного совпадения строк уже нет, поэтому большую часть проверок делает судья — модель, оценивающая ответ по инструкции ([AIL-27](AIL-27.md)).

**Correctness** — совпадает ли ответ по смыслу с эталоном. Судья получает вопрос, эталон, `must_include` и ответ.

**Faithfulness (groundedness)** — подтверждается ли каждое утверждение ответа найденными чанками. Судья получает ответ и чанки, эталон ему не нужен. Это ловит галлюцинации, даже если ответ случайно верный. Типичные случаи в нашем ассистенте:

- **Выдуманный срок.** В кусках только раздел про вскрытый чай, а ответ: «кружку можно вернуть в течение 30 дней». Числа 30 в кусках нет — FAIL.
- **Склеенные гарантии.** В контексте `lamp-light.md` и `lamp-light-mini.md`; допустим, у «Свет» 12 месяцев, у «Свет мини» 6. Ответ «гарантия на LAMP-LIGHT-MINI — 12 месяцев»: число в кусках есть, но у другого товара. Утверждение — пара «товар + срок», она не подтверждена — FAIL. Судья, который ищет только числа, это пропустит.
- **Архивные правила.** Ответ цитирует `returns-2025.md`. Архивный кусок был в контексте — faithfulness PASS, correctness FAIL (сломан фильтр `archived`); не был — FAIL faithfulness.

**Relevance** — отвечает ли ответ на вопрос. Для RAG по базе знаний ломается редко; в первой версии можно не реализовывать.

**Правильный отказ** — для `unanswerable`: ответ должен быть отказом. Судья не нужен: промпт из [AIL-23](AIL-23.md) требует фразу «В базе знаний нет ответа на этот вопрос.» (`REFUSAL`), и `ask()` возвращает `refused`. Обратная ошибка тоже важна: **ложный отказ** на отвечаемый вопрос.

Комбинации correctness и faithfulness говорят о разном:

| correctness | faithfulness | Что это значит |
|---|---|---|
| PASS | PASS | Всё хорошо |
| PASS | FAIL | Модель знала ответ «из головы»; опасно, потому что в другой раз выдумает |
| FAIL | PASS | Ответ опирается на найденное, но найдено не то (смотрим hit и архивные куски) или эталон неверен |
| FAIL | FAIL | Галлюцинация |

### Судья: бинарный, с критикой

Подход из [AIL-27](AIL-27.md): `{"critique": ..., "verdict": "PASS"|"FAIL"}`, критика перед вердиктом, temperature 0 (если провайдер её поддерживает для выбранной модели), структурированный вывод. Промпт судьи для faithfulness (иллюстративно):

```python
FAITHFULNESS_PROMPT = """You check whether a support answer is supported by excerpts from the shop's knowledge base.

<excerpts>
{chunks}
</excerpts>

<answer>
{answer}
</answer>

List each factual claim in the answer (numbers, periods, prices, product names, SKUs,
promo codes, conditions). A claim includes its subject: "12 months warranty for LAMP-LIGHT-MINI"
is supported only if an excerpt states it for that product, not for a similar one.
For each claim decide if the excerpts support it. General phrasing and
"В базе знаний нет ответа на этот вопрос." are not claims.

Verdict PASS only if every claim is supported. Return JSON:
{{"claims": [{{"claim": "...", "supported": true}}], "critique": "...", "verdict": "PASS" | "FAIL"}}
"""
```

Для faithfulness разбор на утверждения внутри промпта делает судью заметно точнее, чем вопрос «ответ опирается на контекст?». Промпт correctness собираем из черновика, написанного в [AIL-27](AIL-27.md): судья получает вопрос, эталон, `must_include` и ответ и ставит PASS, только если в ответе есть каждый факт из `must_include` и ничто не противоречит эталону.

### Проверка судьи

Промпт судьи написан, но цифрам correctness и faithfulness пока верить рано. Судья — модель, поэтому сначала проверяем его, потом верим цифрам:

1. Прогоняем набор, берём 20 ответов (лучше смесь, где судья ставил и PASS, и FAIL).
2. **Не глядя на вердикт судьи**, размечаем их сами: PASS/FAIL + причина.
3. Строим таблицу согласия:

```
                 мы: PASS   мы: FAIL
 судья: PASS        11          2      ← 2 плохих ответа судья пропустил
 судья: FAIL         1          6      ← 1 хороший ответ судья забраковал
```

4. Считаем: общее согласие (17/20 = 85%), долю пойманных плохих ответов (6/8 = 75%, это TNR, true negative rate, в терминах Hamel), долю правильно принятых хороших (11/12 ≈ 92%, TPR, true positive rate).
5. Читаем все расхождения. Обычно причина видна: судья не сверяет число с товаром, не знает, что «14 дней» и «две недели» одно и то же. Правим промпт, добавляем few-shot пример, прогоняем снова.

На 20 примерах эти доли очень грубые (подробнее о шуме в [AIL-62](AIL-62.md)), но расхождения покажут явные дефекты судьи. Когда разметки станет больше, её стоит разделить: на одной части правим промпт судьи, на другой проверяем, иначе подгоним судью под свои 20 примеров.

### Стоимость и латентность

Качество — не единственное, что меняется от конфига к конфигу: более сильная модель или реранкер стоят денег и времени. Поэтому в каждом прогоне считаем и их. Ответ API возвращает число входных и выходных токенов (`usage`). Стоимость:

```
cost = input_tokens × price_in / 1e6 + output_tokens × price_out / 1e6
```

Цены меняются; держим их в `eval/prices.json`, а не в коде. Считаем отдельно стоимость **системы** (то, что будет платить магазин за ответы клиентам) и стоимость **оценки** (судья). В отчёт идёт стоимость системы на 100 вопросов, она пригодится в [AIL-33](AIL-33.md). Учитываем и кеширование промптов: у кешированных токенов своя цена.

Латентность — время от вопроса до ответа (поиск + генерация); `ask()` уже меряет его через `time.perf_counter()` и кладёт в `latency_ms`. Смотрим медиану и p90, а не только среднее: один зависший запрос портит среднее.

### Сохранение прогонов

Все эти цифры нужно где-то хранить, чтобы через неделю сравнить прогоны между собой. Каждый прогон — отдельная папка:

```
eval/runs/2026-12-24T14-05_index_hybrid_k5/
  config.json      # full config + git commit + dataset hash + timestamp
  results.jsonl    # per question: retrieved urls, ranks, answer, verdicts, critiques, tokens, latency
  summary.json     # aggregates
  report.md        # human-readable table
```

Без `results.jsonl` не получится разобрать ошибки ([AIL-34](AIL-34.md)), без `config.json` через неделю не вспомнить, что это был за прогон. Строка итогов каждого прогона дописывается в `eval/RESULTS.md` — ту же таблицу, что в неделях 4–5. В git идут `eval/runs/` или хотя бы `summary.json` и `config.json`: в прогонах только выдуманные вопросы и ответы по публичной базе, а история прогонов — материал для README.

### Практические детали скрипта

Перед тем как собрать скрипт, несколько решений, которые отличают рабочий инструмент от черновика:

- **Параллельность.** 80 вопросов по 3 вызова последовательно — минуты. `concurrent.futures.ThreadPoolExecutor(max_workers=4–8)` ускоряет в разы; следим за rate limits провайдера.
- **Ретраи.** Ошибка API на одном вопросе не должна валить прогон: ретрай с паузой, после N неудач вопрос помечается `error` и считается отдельно.
- **Кеш.** Кешируем ответы судьи по хешу (промпт судьи + вход). Повторный прогон того же ответа не стоит денег.
- **Срезы.** Агрегируем метрики не только целиком, но и по `type`, `category`, `origin`. Общая цифра прячет провалы, например на вопросах про гарантию.
- **`--split dev` по умолчанию.** Holdout только явным флагом.
- **Приватность.** Перед вызовом облачного судьи скрипт проверяет вопрос через `contains_personal_data()`: правило «личные данные не уходят в облако» держит код. Например, выдуманный «где мой заказ 1042?»: его отказ проверяется кодом, без судьи.

### Скелет `eval/run.py`

Скелет собирает всё перечисленное: `eval_item` оценивает один вопрос (поиск, отказ, судьи с проверкой приватности), `main` читает конфиг и набор, гоняет вопросы параллельно и записывает метаданные прогона.

```python
# eval/run.py  (illustrative skeleton, not a full solution)
import argparse, hashlib, json, subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from rag.pipeline import ask                 # Project 2 pipeline, now config-driven
from rag.privacy import contains_personal_data
from judges import judge_correctness, judge_faithfulness
from metrics import retrieval_metrics

def eval_item(item: dict, cfg: dict) -> dict:
    ans = ask(item["q"], cfg)          # Answer(text, sources, refused, latency_ms, chunks, usage)
    res = {"id": item["id"], "type": item["type"], "category": item["category"],
           "latency_ms": ans.latency_ms, "refused": ans.refused,
           "retrieved": [c["url"] for c in ans.chunks],
           "archived_in_context": sum(bool(c.get("archived")) for c in ans.chunks),
           "answer": ans.text, "usage": ans.usage}
    if item["type"] == "unanswerable":
        res["refusal_ok"] = ans.refused       # fixed REFUSAL phrase, checked by code
    else:
        res |= retrieval_metrics([c["text"] for c in ans.chunks], item["evidence"], cfg["k"])
    if contains_personal_data(item["q"]):
        res["judges"] = "skipped_private"     # never send it to a cloud judge
        return res
    if item["type"] != "unanswerable":
        res["correctness"] = judge_correctness(item, ans.text, cfg)   # {"verdict", "critique"}
    res["faithfulness"] = judge_faithfulness(ans.text, ans.chunks, cfg)
    return res

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--split", default="dev")
    args = ap.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    raw = Path("eval/golden.jsonl").read_bytes()
    items = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    items = [i for i in items if i["split"] == args.split]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda it: eval_item(it, cfg), items))
    meta = {"config": cfg, "split": args.split, "started": datetime.now().isoformat(),
            "dataset_sha": hashlib.sha256(raw).hexdigest()[:12],
            "git": subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                  capture_output=True, text=True).stdout.strip()}
    ...  # aggregate (overall + per type/category), cost from prices.json, write run folder,
         # append one line to eval/RESULTS.md, print table

if __name__ == "__main__":
    main()
```

Ожидаемый вывод в терминале:

```
run 2026-12-24T14-05 | index.db hybrid k=5 | dataset 3f2a9c1e0b77 | dev n=56
hit@5 0.82  MRR 0.64  recall@5 0.77  archived_in_context 0
correctness 0.71  faithfulness 0.86  refusal_ok 7/8  false_refusals 2
system cost $0.41 per 100 q  | judge cost $0.95  | latency p50 2.1s p90 4.8s
by type: factual 0.80 | comparative 0.50 | multi_hop 0.58 | unanswerable 0.88
```

Цифры выдуманы для примера формата.

### Ragas: зачем смотреть и почему не сразу

[Ragas](https://docs.ragas.io) — библиотека готовых RAG-метрик (faithfulness, context precision/recall, answer correctness и др.), внутри — те же LLM-судьи. Свой скрипт сначала нужен затем, чтобы понимать, что именно меряется: у Ragas свои промпты судей, своя агрегация и свои значения по умолчанию, и без этого понимания не объяснить, почему faithfulness 0,73. Когда свой скрипт работает, можно прогнать Ragas на тех же данных и сравнить: совпадают ли выводы.

## DeepSeek и Ollama: как это сделать у нас

Скрипт целиком переносится на наш стек: ответчик — `deepseek-flash` (или локальная модель для сравнения), судья — `deepseek-v4-pro`, второе мнение — Claude или OpenAI на подвыборке, Ollama — локальный ответчик и эмбеддинги. Ниже то, что меняется в коде судей, в подсчёте стоимости и в параллельности. Факты сверены в ноябре 2026 по [api-docs.deepseek.com](https://api-docs.deepseek.com) и [docs.ollama.com](https://docs.ollama.com); id моделей и цены проверяем перед прогоном.

**Почему судья может быть облачным.** Судья видит вопросы набора, эталоны, ответы и куски `kb/`. База знаний публичная, вопросы и эталоны выдуманы, личных данных нет — их можно отправлять в DeepSeek (серверы в Китае). Правило курса не меняется: личные данные клиентов, рабочий код и всё, что нельзя показывать посторонним, в облако не уходят; ответы на настоящие сообщения клиентов судит только локальная модель.

### Судья на DeepSeek

```python
# eval/judges.py — DeepSeek judge (illustrative)
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

1. **Thinking включён по умолчанию**, и в нём `temperature` молча не действует. Для судьи по умолчанию рассуждения выключаем: так вердикты стабильнее, дешевле и быстрее. Режим с рассуждениями — отдельный кандидат в судьи: включаем его и сравниваем согласие с нашей разметкой; если согласие заметно выше, берём его и меряем разброс повторными прогонами (глава [8.1 · Статистика evals: шум и размер выборки](AIL-62.md)).
2. **JSON mode без схемы.** Поэтому проверка `verdict in ("PASS", "FAIL")` в коде обязательна, а промпт судьи должен содержать пример JSON (в `FAITHFULNESS_PROMPT` выше он есть). Ответ `ERROR` считаем отдельно, а не как FAIL.
3. **`seed` в документации DeepSeek не описан.** Повторяемость судьи даёт только temperature 0 без thinking плюс наш кеш вердиктов.

### Почему не судья на Ollama

Локальная модель ограничена памятью: 8 ГБ RAM — модели класса 4B (`qwen3:4b`), 16 ГБ — 7–8B, 32 ГБ и больше — 14B и крупнее, и всё это рядом с `bge-m3` и реранкером. Даже 14B слабее судьи `deepseek-v4-pro`, а 4B слабее и ответчика `deepseek-flash`: судья, который ошибается чаще оцениваемой системы, не измеряет ничего. Поэтому локальный судья здесь — учебная иллюстрация (код ниже) и способ увидеть, насколько у него хуже согласие с разметкой.

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
        options={"temperature": 0, "seed": 42, "num_ctx": 8192},  # 5 chunks + prompt need room; context costs RAM
    )
    return Verdict.model_validate_json(r.message.content)
```

У локального судьи и локального **ответчика** есть общая ловушка — **контекст**. По умолчанию Ollama даёт 4k токенов, если доступной видеопамяти меньше 24 ГБ (на Mac — общей памяти). Пять чанков по 600 токенов плюс промпт и ответ уже около 4k: хвост контекста обрежется без ошибки, и судья поставит FAIL за «неподтверждённое» утверждение, подтверждение которого просто не дошло. В нативном API задаём `num_ctx` в `options`; через OpenAI-совместимый эндпоинт размер контекста задать нельзя (нужен `OLLAMA_CONTEXT_LENGTH` при запуске сервера или Modelfile с `PARAMETER num_ctx`). Проверяем `ollama ps`: колонка CONTEXT и то, что модель целиком на GPU (PROCESSOR). При 8 ГБ контекст поднимаем осторожно, до 8k: он тоже занимает память. Если не влезает — уменьшаем k или размер кусков для локального варианта и записываем это в конфиг.

### Какой судья главный

| Кандидат в судьи | Плюсы | Минусы | Роль |
|---|---|---|---|
| `deepseek-v4-pro`, thinking выключен | сильнее Flash, стабилен, центы за прогон | одно семейство с ответчиком `deepseek-flash` | главный судья |
| `deepseek-v4-pro`, thinking включён | обычно точнее на сложных случаях | temperature не действует, больше шум, рассуждения стоят как выходные токены | кандидат, если согласие выше |
| `deepseek-flash` | вдвое-вчетверо дешевле | судит сам себя, слабее | только для дешёвых предварительных проверок |
| Claude / OpenAI | сильные судьи, другие семейства, ловят самопредпочтение DeepSeek | дороже, нужны отдельные ключи | второе мнение: прогон на наших 20 размеченных ответах |
| локальная модель в Ollama (4–14B по памяти) | бесплатно, приватно | слабее оцениваемой системы, нужен большой контекст | не судья; учебное сравнение согласия или судья для приватных данных с оговоркой |

Выбор делается не по таблице, а по согласию с нашей разметкой: прогоняем 2–3 кандидатов на тех же 20 ответах и берём того, у кого выше TNR (доля пойманных плохих ответов) при приемлемом TPR.

### Стоимость с кешем и часами пик

У DeepSeek три цены за токены, и две из них зависят от времени суток. На ноябрь 2026 (USD за 1M токенов):

| Модель | вход, кеш-попадание | вход, кеш-промах | выход |
|---|---|---|---|
| `deepseek-flash`, пик | 0,006 | 0,30 | 1,20 |
| `deepseek-flash`, вне пика | 0,003 | 0,15 | 0,60 |
| `deepseek-v4-pro`, пик | 0,044 | 1,32 | 3,96 |
| `deepseek-v4-pro`, вне пика | 0,022 | 0,66 | 1,98 |

Пик — с понедельника по пятницу 01:00–04:00 и 06:00–10:00 UTC (кроме праздников Китая), остальное время и выходные — вне пика. Кеширование автоматическое: в `usage` приходят `prompt_cache_hit_tokens` и `prompt_cache_miss_tokens`. В RAG в кеш попадает в основном общий префикс (системный промпт ассистента или промпт судьи), куски `kb/` у каждого вопроса свои.

```python
# eval/cost.py (illustrative); prices.json: {"deepseek-flash": {"peak": {"in_hit":..,"in_miss":..,"out":..}, "offpeak": {...}}, "updated": "2026-11-.."}
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

Поля кеша в справочнике API описаны внутри `prompt_tokens_details`, а в примере ответа лежат прямо в `usage`, поэтому код смотрит в оба места. Ollama стоит $0 за токены: в отчёт для неё пишем «$0 API» и латентность на своём железе.

**Порядок стоимости прогона** (оценка, не измерение): допустим, на вопрос приходится ответ ~3500 входных + 300 выходных токенов и два вызова судьи суммарно ~4400 входных + 700 выходных.

| Конфигурация | на вопрос, пик | 60 вопросов, пик | 60 вопросов, вне пика |
|---|---|---|---|
| ответ Flash + судья Pro (без thinking) | ≈ $0,010 | ≈ $0,60 | ≈ $0,30 |
| ответ Flash + судья Flash | ≈ $0,0036 | ≈ $0,21 | ≈ $0,11 |
| ответ Ollama + судья Pro | ≈ $0,0086 | ≈ $0,51 | ≈ $0,26 |

Судья с рассуждениями добавит выходные токены (в `usage.completion_tokens_details.reasoning_tokens`) и может подорожать в разы. Оценку сверяем с фактом первого прогона. Claude и OpenAI для сравнения считаем по их страницам цен тем же кодом с другим `prices.json`.

### Параллельность и лимиты

- **DeepSeek** ограничивает не запросы в минуту, а одновременные запросы на аккаунт (на ноябрь 2026: 2500 для Flash и 500 для Pro), сверх лимита — HTTP 429. Наши `max_workers=6` далеко от лимита; ретраи на 429 всё равно нужны. Пока инференс не начался, сервер держит соединение пустыми строками (keep-alive) и закрывает его через 10 минут, поэтому клиенту нужен разумный timeout.
- **Ollama** по умолчанию обрабатывает запросы к одной модели по одному (`OLLAMA_NUM_PARALLEL`, по умолчанию 1), остальные ждут в очереди. `ThreadPoolExecutor` с 6 потоками локальный прогон не ускорит, а латентность исказит: в неё попадёт ожидание в очереди. Локальную модель гоняем последовательно; поднимать параллельность при 8–16 ГБ не стоит: память растёт пропорционально параллельность × контекст.

### Сравнение провайдеров для этой главы

| Что нужно скрипту | Claude | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|
| Стабильный судья (`temperature=0`) | да, с оговорками у части новых моделей | да, кроме reasoning-моделей | только с `thinking: disabled` | да, плюс `seed` |
| Вердикт по схеме | structured outputs / tool use | JSON-схема | `json_object` + проверка в коде | `format` с JSON-схемой |
| Токены в `usage` | input/output + токены кеша | prompt/completion + `cached_tokens` | prompt/completion + `prompt_cache_hit/miss_tokens` | `prompt_eval_count` / `eval_count` в нативном API |
| Кеш промпта | явные пометки `cache_control` | автоматический | автоматический | не нужен, токены бесплатны |
| Цена зависит от времени суток | нет | нет (есть отдельные пакетные режимы, см. доку) | да, пик и вне пика | нет |
| Лимиты | RPM/TPM по уровню аккаунта | RPM/TPM по уровню | одновременные запросы на аккаунт | память машины и `OLLAMA_NUM_PARALLEL` |
| `logprobs` | нет | есть у части моделей | параметр есть | через OpenAI-совместимый API нет |

## Маршрут изучения

1. Открываем [Hamel: Creating a LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) → перечитываем разделы про измерение согласия с экспертом и итерацию промпта (≈20 мин). Это методичка для шага «проверить судью».
2. Открываем [Eugene Yan: Evaluating the Effectiveness of LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/) → разделы про метрики согласия и про оценку faithfulness/фактической согласованности (≈30 мин). Обращаем внимание, как плохо судьи справляются без разбора на утверждения.
3. Открываем [Ragas docs](https://docs.ragas.io) → раздел с метриками (metrics), читаем описания faithfulness, context precision, context recall (≈25 мин). Сравниваем с тем, как мы определили метрики выше: что они считают иначе.
4. Открываем [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) → раздел про грейдеры (code-based, LLM-based) (≈15 мин).
5. Открываем документацию провайдера: как достать `usage` из ответа и страницу цен (≈10 мин). Цены переносим в `eval/prices.json`.
6. Python-справка по мере надобности: [concurrent.futures](https://docs.python.org/3/library/concurrent.futures.html), [argparse](https://docs.python.org/3/library/argparse.html).
7. Открываем [DeepSeek: Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode), [JSON Output](https://api-docs.deepseek.com/guides/json_mode), [Context Caching](https://api-docs.deepseek.com/guides/kv_cache), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) и [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) (≈30 мин). Выписываем: как выключить thinking через `extra_body`, поля кеша в `usage`, часы пик, лимит одновременных запросов. Цены переносим в `eval/prices.json` с датой.
8. Открываем [Ollama: Context length](https://docs.ollama.com/context-length), [FAQ](https://docs.ollama.com/faq) (разделы про контекст, параллельные запросы, keep_alive) и [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) (≈20 мин). Главное: контекст по умолчанию зависит от памяти и может молча обрезать чанки.

## На что обратить внимание

- **Судья без проверки — не метрика.** Пока не сделана сверка на 20 ответах, цифра correctness ничего не значит.
- **Один и тот же модельный вызов для ответа и для судьи** (та же модель, тот же промпт-стиль) усиливает самопредпочтение. Если возможно, судья другой модели или хотя бы проверен на разметке.
- **Чанк режет цитату** — hit = 0, хотя ответ найден. Промахи поиска смотрим руками перед выводами.
- **Faithfulness штрафует отказ?** Ответ «В базе знаний нет ответа на этот вопрос.» не содержит утверждений и должен получать PASS. Проверяем, что судья так и делает.
- **Судья сверяет числа без товара** («12 месяцев» есть, но у «Свет», а не у «Свет мини»), а **архивный кусок в контексте** даёт faithfulness PASS при неверном ответе. Первое ловит ручная разметка, второе — счётчик `archived_in_context`.
- **Средняя латентность врёт** из-за выбросов: смотрим p50/p90.
- **Цены в коде устаревают.** Отдельный файл цен с датой обновления.
- **Ошибки API считаются как FAIL** — это искажает качество. Считаем их отдельно (`errors: 2`) и перезапускаем.
- **Holdout случайно в прогоне** — `--split dev` по умолчанию.
- **Утечка ключей**: ключи только из окружения/`.env` в `.gitignore`. В `config.json` прогона ключей быть не должно; важно не сериализовать объект клиента целиком.
- **Судья DeepSeek «с temperature 0» в режиме thinking** — temperature не действует, вердикты шумят. Рассуждения выключаем явно и записываем режим в `config.json`.
- **`ERROR` судьи учтён как FAIL.** Пустой `content` в JSON mode DeepSeek и невалидный JSON — инфраструктурная ошибка, а не плохой ответ системы.
- **Локальный судья с обрезанным контекстом** ставит FAIL faithfulness верным ответам. Проверяем `num_ctx`/`OLLAMA_CONTEXT_LENGTH` и сравниваем `prompt_eval_count` в ответе Ollama с ожидаемым числом токенов.
- **Латентность локальной модели с очередью.** При `OLLAMA_NUM_PARALLEL=1` и 6 потоках меряется ожидание в очереди. Плюс первый запрос после простоя загружает модель в память (по умолчанию модель выгружается через 5 минут без запросов): нужен прогревочный запрос, который не учитывается.
- **Стоимость без учёта часов пик и кеша** ошибается в разы. Время вызова и поля кеша храним в `results.jsonl`.

## Практика

Код: `projects/02-support-kb-rag/eval/` и правки в `rag/pipeline.py`.

- [ ] Делаем пайплайн конфигурируемым: `ask(question, cfg=None)`, в `Answer` — `chunks` (с `text`, `url`, `category`, `archived`) и `usage`. Базовый конфиг — `eval/configs/baseline.json`; `app.py`, `bot.py`, `ask.py` не меняются.
- [ ] `eval/metrics.py`: `normalize`, `is_relevant`, `retrieval_metrics`; `eval/run_retrieval_eval.py` переводим на них. Пишем 3–4 юнит-теста (pytest или простые `assert`): пример с таблицей из теории должен дать hit 0,67 и MRR 0,44; «Чай на развес» находит цитату «чай на развес» (регистр, `ё`, пробелы).
- [ ] `eval/judges.py`: `judge_correctness` (вопрос, эталон, `must_include`, ответ) и `judge_faithfulness` (ответ, чанки). Бинарный вердикт, критика перед вердиктом, JSON, ретрай при невалидном JSON.
- [ ] Обработка `unanswerable`: правильный отказ по `Answer.refused` / ложный отказ на отвечаемых.
- [ ] `eval/run.py`: прогон, агрегаты общие и по `type` и `category`, счётчик `archived_in_context`, стоимость системы на 100 вопросов, стоимость судьи, p50/p90 латентности, сохранение папки прогона и строка в `eval/RESULTS.md`.
- [ ] Прогоняем baseline на dev.
- [ ] Проверка судьи: выбираем 20 ответов (среди них 2–3 про лампы «Свет» / «Свет мини»), размечаем сами в `eval/judge_labels.jsonl` (id, наш вердикт, причина), не глядя на вердикт судьи. Пишем `eval/judge_agreement.py`, печатающий таблицу 2×2, согласие, TPR, TNR и список расхождений.
- [ ] Правим промпт судьи по расхождениям, перепрогоняем, записываем в `notes/evals.md` согласие до и после.
- [ ] Ловушки для судьи: подменяем 3 ответа (срок возврата «30 дней», гарантия «Свет» у «Свет мини», правило из `returns-2025.md` без архива в контексте). Все три должны получить FAIL faithfulness.
- [ ] (Опционально) Прогоняем Ragas faithfulness на тех же ответах и сравниваем с нашим судьёй.
- [ ] Ответчик в baseline-конфиге — `deepseek-flash` (`"answer_model": "deepseek-flash"`, `"answer_thinking": false`), судья — `deepseek-v4-pro` с выключенным thinking; режимы записываются в `config.json`.
- [ ] `eval/cost.py`: цена с учётом кеш-попаданий и часов пик; Ollama — `$0 API`. Итог первого прогона сверяем с биллингом в кабинете DeepSeek.
- [ ] Второе мнение: судья на Claude или OpenAI на тех же 20 размеченных ответах (база знаний и набор публичные и выдуманные). В `judge_agreement.py` выводим согласие обоих судей с нами и друг с другом.
- [ ] Сравниваем `deepseek-v4-pro` с thinking и без на 20 размеченных ответах: согласие, стоимость, время. Записываем выбор.
- [ ] (Опционально, учебно) Прогоняем `judge_ollama` на самой крупной модели, которая помещается в память, на тех же 20 ответах и смотрим, насколько хуже согласие. Это аргумент, почему маленькая локальная модель не судья.

## Готово, когда

- `python eval/run.py --config eval/configs/baseline.json` одной командой печатает hit rate, MRR, correctness, faithfulness, долю правильных отказов, стоимость и латентность, сохраняет папку прогона с конфигом, датой, версией набора и git-коммитом и дописывает строку в `eval/RESULTS.md`.
- Судья проверен на 20 ручных оценках, согласие записано, расхождения разобраны; три подменённых ответа (выдуманный срок, склеенные гарантии, архивное правило) получают FAIL.
- Метрики считаются по срезам (`type`, `category`); `archived_in_context` равен нулю.
- Для выбранного судьи записаны модель, режим thinking, согласие с разметкой и стоимость прогона по фактическому `usage`.

## Тест для самопроверки

1. Вопрос q: релевантный чанк на позиции 4 из 5. Чему равны hit@5, hit@3 и reciprocal rank?
2. Чем recall@k полезнее hit rate для сравнительных вопросов?
3. correctness = PASS, faithfulness = FAIL. Что это значит и почему это проблема?
4. Почему судье faithfulness не нужен эталонный ответ?
5. Размечено 20 ответов. Судья: 14 PASS, 6 FAIL. Ручная разметка: 10 PASS, 10 FAIL. Судья совпал с разметкой на всех своих FAIL. Сколько плохих ответов судья пропустил и какова его доля пойманных плохих ответов?
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
16. Ответ: «Гарантия на LAMP-LIGHT-MINI — 12 месяцев». В контексте обе страницы ламп, 12 месяцев указано только у «Свет». Судья поставил faithfulness PASS. Что не так?
17. Почему судья на `deepseek-v4-pro` допустим для этого набора, хотя серверы DeepSeek в Китае?

## Ответы

1. hit@5 = 1, hit@3 = 0, RR = 1/4 = 0,25.
2. Сравнительному вопросу нужны куски с двух страниц (например, `lamp-light.md` и `lamp-light-mini.md`); hit rate засчитает успех, найдя одну, а recall покажет, что найдена только половина.
3. Ответ верный, но не подтверждается найденными кусками: модель взяла его из своих знаний. В другой раз она так же уверенно выдумает неверный факт (например, срок возврата), и ссылки на источник будут ложными.
4. Faithfulness проверяет согласованность ответа с найденными кусками, а не с истиной; для этого нужны только ответ и контекст.
5. В разметке 10 FAIL; судья поймал 6 из них (все его FAIL верные) и пропустил 4. Доля пойманных плохих = 6/10 = 60%.
6. Для разбора ошибок по конкретным вопросам, сравнения прогонов по вопросам (какие вопросы стали лучше/хуже) и проверки судьи. Агрегаты этого не позволяют.
7. Цены меняются и разные у разных моделей; отдельный файл с датой легко обновить и видно, по каким ценам считан прогон.
8. Шкала 1–10 вместо бинарного вердикта; нет критики (и `max_tokens=5` её не позволяет); нет вопроса и контекста; `int()` упадёт на любом лишнем тексте; нет инструкции, что считать ошибкой; нет ретраев и структурированного вывода.
9. В них нет правильного куска, искать нечего; их качество меряется долей правильных отказов.
10. **b.** Один зависший запрос сильно сдвигает среднее, а перцентили показывают типичное и «плохое» время.
11. Чтобы понимать, что меряет каждая метрика и как устроены судьи, и уметь объяснить цифры. Ragas потом полезен как сверка.
12. В режиме thinking (он по умолчанию) DeepSeek не применяет temperature, ошибки при этом нет. Без отключения вердикты будут шуметь сильнее, плюс рассуждения стоят как выходные токены и замедляют прогон.
13. Обрезанный контекст: по умолчанию Ollama даёт 4k токенов, если видеопамяти меньше 24 ГБ, часть чанков отбрасывается молча, и модель «не видит» нужный кусок. Проверить `ollama ps` (CONTEXT) и `prompt_eval_count` в ответе, задать `num_ctx` или `OLLAMA_CONTEXT_LENGTH` (при малой памяти — осторожно) либо уменьшить k.
14. Нет: будни 06:00–10:00 UTC — часы пик, цены вдвое выше, чем вне пика (выходные). Длинные прогоны выгодно ставить вне пика.
15. Ollama по умолчанию обрабатывает запросы к модели по одному (`OLLAMA_NUM_PARALLEL=1`), остальные стоят в очереди; в измеренную латентность попадает ожидание очереди.
16. Судья сверил число, но не товар: пары «LAMP-LIGHT-MINI + 12 месяцев» в кусках нет, правильно — FAIL. Чиним промпт судьи (утверждение включает свой предмет) и добавляем такие случаи в разметку.
17. Судья видит только вопросы набора, эталоны, ответы и куски `kb/`: база знаний публичная, вопросы и эталоны выдуманы, личных данных нет. Ответы на настоящие сообщения клиентов судила бы только локальная модель.

## Что дальше

В [AIL-30 · Подключить Langfuse или promptfoo](AIL-30.md) делаем трейсы и прогоны видимыми в UI, а в [AIL-62](AIL-62.md) учимся понимать, какая разница в цифрах этого скрипта настоящая.
