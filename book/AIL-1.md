# 1.1 · Python: отличия от TypeScript  (AIL-1)

> **Неделя 1** · Подготовка · ⏱ ~4 ч · Теория, Практика

## Зачем это AI-инженеру

Почти весь AI-стек — SDK Anthropic и OpenAI, Pydantic, LangGraph, LlamaIndex, evals-фреймворки, примеры в документации — написан на Python. Код тебе часто будет генерировать модель, но отвечаешь за него ты: надо с первого взгляда видеть изменяемый default, проглоченное исключение или `float` там, где нужны деньги. На собеседованиях live-coding для AI-инженера почти всегда на Python. Цель главы — не выучить язык с нуля, а перенести то, что ты знаешь по TypeScript, и выучить только отличия.

## Теория

### 1. Ментальная модель: чем Python отличается от TS в целом

| | TypeScript / Node | Python |
|---|---|---|
| Запуск | `node file.ts` (type stripping) или сборка | `python file.py` — интерпретатор, без сборки |
| Типы | проверяются `tsc`, в рантайме стираются | type hints **вообще не проверяются** в рантайме; проверяют mypy/pyright/IDE |
| Блоки | `{ }` | отступ (4 пробела), двоеточие в конце заголовка |
| Пустое значение | `null` и `undefined` | один `None` |
| Конкурентность | event loop всегда есть | синхронно по умолчанию; event loop — явно через `asyncio` (глава AIL-2) |
| Пакеты | npm, `package.json`, `node_modules` | uv/pip, `pyproject.toml`, виртуальное окружение `.venv` (AIL-2) |
| Числа | `number` (double) + `bigint` | `int` произвольной длины + `float` (double) + `Decimal` |

Главное следствие второй строки: аннотация `def f(x: int)` — это документация и подсказка для IDE. `f("abc")` выполнится без ошибки, пока что-то внутри не сломается. Валидацию данных в рантайме делает Pydantic — это тема AIL-2.

### 2. Синтаксис: отступы, `None`, truthy/falsy

```python
def classify(spread: float) -> str:
    if spread > 0.5:
        return "open"
    elif spread < 0.1:      # elif, not "else if"
        return "close"
    else:
        return "hold"
```

Логические операторы — словами: `and`, `or`, `not`. Тернарный оператор читается наоборот: `x if cond else y` (в TS `cond ? x : y`). Аналога `??` нет; `a or b` похож на `||` и срабатывает на любое falsy, включая `0`.

**Falsy в Python:** `None`, `False`, `0`, `0.0`, `""`, `[]`, `{}`, `set()`, `()`. Важное отличие от JS: **пустой список и пустой словарь — falsy** (в JS `[]` и `{}` truthy). Поэтому идиома `if not positions:` значит «список пуст».

**`==` против `is`.** `==` сравнивает значения (как глубокое сравнение для списков и словарей: `[1, 2] == [1, 2]` → `True`, в JS было бы `false`). `is` сравнивает идентичность объекта. Используй `is` только с `None`: `if x is None:`. Сравнение строк или чисел через `is` иногда «работает» из-за кеширования интерпретатора и однажды перестаёт — это классический баг.

### 3. Числа

- `int` не переполняется: `2**100` — точное число.
- `/` **всегда** даёт `float`: `7 / 2 == 3.5`, `4 / 2 == 2.0`.
- `//` — деление с округлением вниз (к минус бесконечности!): `7 // 2 == 3`, но `-7 // 2 == -4`.
- `**` — степень, `%` — остаток (знак как у делителя: `-7 % 2 == 1`).
- Для денег и объёмов, где важна точность, — `decimal.Decimal("0.1")` (строкой, не float). `0.1 + 0.2 == 0.30000000000000004` здесь так же, как в JS.

### 4. Коллекции

| TS | Python | Заметки |
|---|---|---|
| `Array<T>` | `list[T]`: `[1, 2, 3]` | изменяемый |
| кортеж `[a, b]` | `tuple`: `(1, "a")` | неизменяемый, может быть ключом словаря |
| `Record<K,V>` / `Map` | `dict[K, V]`: `{"btc": 1}` | порядок вставки сохраняется |
| `Set<T>` | `set[T]`: `{1, 2}` | пустой — только `set()`, `{}` это пустой dict |

Обращения:

```python
prices = {"BTC": 97000.5, "ETH": 3400.1}
prices["BTC"]            # KeyError if missing — NOT undefined
prices.get("SOL")        # None
prices.get("SOL", 0.0)   # default value
"BTC" in prices          # key membership
for symbol, price in prices.items():
    print(symbol, price)
```

**Срезы:** `a[start:stop:step]`, `stop` не включается, отрицательные индексы считают с конца.

```python
xs = [10, 20, 30, 40, 50]
xs[1:3]    # [20, 30]
xs[-1]     # 50
xs[:2]     # [10, 20]
xs[::-1]   # reversed copy
```

**Comprehensions** заменяют `map`/`filter`:

```python
# TS: xs.filter(x => x > 0).map(x => x * 2)
doubled = [x * 2 for x in xs if x > 0]
by_symbol = {t["symbol"]: t for t in trades}          # dict comprehension
symbols = {t["symbol"] for t in trades}               # set comprehension
total = sum(t["volume"] for t in trades)              # generator, no list built
```

**Распаковка** — аналог деструктуризации: `a, b = b, a`; `first, *rest = xs`; в цикле `for i, x in enumerate(xs):`. `zip(a, b)` идёт по двум спискам парами.

**Строки:** f-строки вместо template literals — `f"{symbol}: {spread:.3f}%"`. Строки неизменяемы; `"".join(parts)` вместо `parts.join("")`.

### 5. Функции

```python
def place_preview(symbol: str, volume: float, *, side: str = "buy", **extra) -> dict:
    return {"symbol": symbol, "volume": volume, "side": side, **extra}

place_preview("BTCUSDT", 0.01, side="sell", note="test")
```

- Позиционные и **именованные** аргументы: `f(1, side="sell")`. Это не объект-параметр, а настоящая часть языка.
- `*` в сигнатуре: всё после него — только по имени (keyword-only). Встретишь это в SDK постоянно: `client.messages.create(model=..., max_tokens=..., messages=...)`.
- `*args` собирает лишние позиционные в кортеж, `**kwargs` — лишние именованные в словарь. При вызове `f(*xs, **opts)` — распаковка (аналог spread).
- `lambda x: x * 2` — только одно выражение.

**Ловушка изменяемого default.** Значение по умолчанию вычисляется **один раз** при определении функции:

```python
def add_trade(trade, log=[]):     # BUG: one list shared by all calls
    log.append(trade)
    return log

add_trade(1)  # [1]
add_trade(2)  # [1, 2]  <- surprise

def add_trade(trade, log=None):   # correct
    if log is None:
        log = []
    log.append(trade)
    return log
```

**Области видимости.** Присваивание внутри функции создаёт локальную переменную. Чтобы изменить переменную внешней функции — `nonlocal`, модуля — `global` (почти никогда не нужно). Блоки `if`/`for` области видимости **не создают**: переменная из цикла живёт после цикла.

### 6. Классы и dataclass

```python
class Exchange:
    fee_rate: float = 0.0005            # class attribute

    def __init__(self, name: str):      # constructor
        self.name = name                # instance attribute, "this" is explicit

    def fee(self, notional: float) -> float:
        return notional * self.fee_rate

    def __repr__(self) -> str:          # like toString() for debugging
        return f"Exchange({self.name!r})"
```

`self` явно передаётся первым параметром каждого метода. Приватности нет: `_name` — соглашение «не трогай», `__name` — искажение имени, не защита. Наследование: `class Bybit(Exchange):`, вызов родителя — `super().__init__(name)`.

Для «просто данных» используй `@dataclass` — он генерирует `__init__`, `__repr__`, `__eq__`:

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)          # frozen = immutable, like a readonly type
class Leg:
    exchange: str
    symbol: str
    price: float
    tags: list[str] = field(default_factory=list)  # never "= []"
```

Dunder-методы (`__init__`, `__len__`, `__eq__`, `__enter__`) — это «протоколы»: Python вызывает их сам, когда ты пишешь `len(x)`, `a == b`, `with x:`.

### 7. Исключения

```python
class ExchangeError(Exception):
    """Base error for the exchange layer."""

class RateLimited(ExchangeError):
    pass

try:
    data = load(path)
except FileNotFoundError:
    data = []
except (ValueError, KeyError) as e:
    raise ExchangeError(f"bad file {path}") from e   # keeps the cause
else:
    print("loaded")        # runs only if no exception
finally:
    print("done")
```

Отличия от TS: ловишь по **типу** (`except ValueError`), а не `catch (e)` с проверкой внутри. `except Exception:` без повторного `raise` — это почти всегда проглоченная ошибка. Голый `except:` ловит даже Ctrl+C — так не пиши.

**Контекстный менеджер** `with` — гарантированное освобождение ресурса (аналог `try/finally` или `using` в новых TS):

```python
with open("trades.csv", encoding="utf-8") as f:
    text = f.read()
# file is closed here even on exception
```

### 8. Модули и импорты

Файл = модуль, папка с файлами = пакет. `import json`, `from pathlib import Path`, `from .utils import spread` (относительный импорт внутри пакета). Импортировать модуль — значит выполнить его верхний уровень один раз. Отсюда идиома:

```python
def main() -> None:
    ...

if __name__ == "__main__":   # true only when run as a script, not when imported
    main()
```

Аналог в Node — проверка `import.meta.url === pathToFileURL(process.argv[1]).href`. Тестам и ноутбукам это даёт импортировать функции, не запуская скрипт.

### 9. Type hints

```python
from typing import Optional, Literal, Any
from collections.abc import Iterable

def mid(bid: float, ask: float) -> float: ...
def find(symbol: str) -> dict[str, float] | None: ...    # modern form (3.10+)
def find_old(symbol: str) -> Optional[dict[str, float]]: ...  # same thing
Side = Literal["buy", "sell"]                             # like a TS union of literals
def total(xs: Iterable[float]) -> float: ...
```

`Optional[X]` значит «X или None», а не «необязательный аргумент». `list[str]`, `dict[str, int]` пишутся со строчной буквы (с Python 3.9); `List`, `Dict` из `typing` — старый стиль, встретишь в чужом коде. `Any` — как `any` в TS.

### 10. Стандартная библиотека, которую стоит знать в лицо

`pathlib` (пути), `json`, `csv`, `datetime`, `collections` (`Counter`, `defaultdict`), `statistics` (`mean`, `median`, `stdev`), `itertools`, `logging`, `os.environ`. Учить наизусть не надо — достаточно знать, что это есть, и спросить модель или документацию.

## DeepSeek и Ollama: как это сделать у нас

Для этой главы провайдер почти не важен: Python один и тот же. Учиться ты будешь на DeepSeek (облако, дёшево, серверы в Китае) и локальной Ollama, а Claude и OpenAI останутся для сравнения (подробно — в главе 1.5 · Видео Карпатого + ключи API (AIL-3)). Отсюда две вещи, которые полезно уметь прочитать уже сейчас:

```python
# illustrative: one SDK, two providers — only keyword arguments differ
import os
from openai import OpenAI

deepseek = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")
local = OpenAI(api_key="ollama", base_url="http://localhost:11434/v1")   # Ollama ignores the key
```

- **Именованные аргументы** (`base_url=...`, раздел 5) — то, на чём держится вся совместимость: ты не наследуешь и не переписываешь клиент, а передаёшь другой адрес. В SDK почти всё keyword-only (`*` в сигнатуре).
- **`os.environ["X"]` против `os.environ.get("X")`.** Первое бросает `KeyError`, если переменной нет (громкая ошибка сразу), второе возвращает `None`, и ты получишь непонятную ошибку авторизации позже. В официальном примере DeepSeek стоит `.get` — для своего кода предпочитай `[]`.
- **Безопасность и в упражнении «чтение чужого кода»:** просить модель сгенерировать учебный скрипт можно у любой, включая DeepSeek, — в запросе нет твоих данных. Код из своего приложения и данные сделок в DeepSeek не отправляй (серверы в Китае); для этого — локальная модель в Ollama.

## Маршрут изучения

1. Открой [Learn X in Y minutes: Python](https://learnxinyminutes.com/docs/python/) → пройди страницу целиком, **запуская** каждый блок в `python3` REPL или в файле (≈90 мин). Отмечай всё, что ведёт себя не как в TS, — это сырьё для шпаргалки.
2. Открой [официальный туториал](https://docs.python.org/3/tutorial/) → главы 3–9 (≈90 мин, бегло). Подробно: 4.8 «More on Defining Functions» (аргументы, ловушка default), 5 «Data Structures» (comprehensions, словари), 8 «Errors and Exceptions», 9 «Classes» до раздела 9.8. Главы 6 (модули) и 7 (ввод-вывод, f-строки) — по диагонали.
3. Открой [документацию dataclasses](https://docs.python.org/3/library/dataclasses.html) → первые примеры и `field(default_factory=...)` (≈10 мин).
4. Открой [модуль csv](https://docs.python.org/3/library/csv.html) → `csv.DictReader` (≈10 мин) — пригодится в практике.
5. [PEP 8](https://peps.python.org/pep-0008/) → раздел Naming Conventions (≈10 мин): `snake_case` для функций и переменных, `PascalCase` для классов, `UPPER_CASE` для констант. Остальное сделает форматтер Ruff (AIL-2).
6. [Real Python](https://realpython.com) — не читать подряд, а искать по мере вопросов («python args kwargs», «python decorators»). Одна статья — один вопрос.
7. (≈5 мин, упражнение на чтение) Открой [DeepSeek Quick Start](https://api-docs.deepseek.com) → пример на Python. Прочитай его как Python-код: какие аргументы именованные, откуда берётся ключ, что вернёт `response.choices[0].message.content`. Запускать пока не нужно — ключ появится в главе 1.5.

## На что обратить внимание

- **Изменяемый default** (`def f(x=[])`, `x={}`) — самый частый баг в сгенерированном коде. В dataclass — `field(default_factory=list)`.
- **`float` для денег.** Сумма комиссий за 1000 сделок в float разойдётся с биржей. Либо `Decimal` из строк, либо осознанное округление при выводе.
- **`except Exception: pass`** — молча скрывает сбой. В AI-коде так часто «обрабатывают» ошибки API; при ревью требуй логирование или повторный `raise`.
- **Отступы.** Смешение табов и пробелов даёт `TabError`; лишний отступ у `return` внутри цикла — функция выходит после первой итерации.
- **Копирование.** `b = a` для списка — та же ссылка, как в JS. Копия — `a.copy()` или `list(a)`; глубокая — `copy.deepcopy(a)`.
- **`dict[key]` бросает `KeyError`**, а не возвращает `undefined`. В данных от API используй `.get()`.
- **Переменная цикла живёт после цикла**, а лямбды в цикле захватывают переменную, не значение (как `var` в старом JS).
- **Type hints не защищают.** Если функция объявлена `-> float`, а возвращает `None`, рантайм промолчит.
- **`/` в индексах.** `xs[len(xs) / 2]` упадёт: индекс должен быть `int`, нужен `//`.

## Практика

Работай в папке `exercises/week-01/` репозитория из AIL-56. Пока uv не настроен (это AIL-2), хватит системного `python3` (`python3 --version` — нужен 3.10+, для `X | None`).

- [ ] **Learn X in Y minutes с запуском.** Создай `exercises/week-01/lxiym.py` и перепечатывай (не копируй) блоки, которые тебя удивили. Минимум 10 «сюрпризов».
- [ ] **Переписать функции из TS.** Возьми 2–3 чистые функции из своего арбитражного приложения (расчёт спреда между ценой шорта и лонга, перевод объёма из монет в контракты, процентное изменение) и перепиши в `exercises/week-01/spread.py`. Каркас:

  ```python
  def spread_pct(short_bid: float, long_ask: float) -> float:
      """Percent spread between selling on the short leg and buying on the long leg."""
      ...

  def coins_to_contracts(volume: float, contract_size: float) -> float:
      ...

  if __name__ == "__main__":
      print(spread_pct(101.0, 100.0))  # expected: 1.0
  ```

  Работай только с самим кодом функций; ничего не подключай к биржам и не трогай базу.
- [ ] **CSV руками, без AI.** Создай вымышленный `exercises/week-01/trades.csv` (20 строк, колонки `time,symbol,side,volume,price,pnl`; данные выдуманные). Напиши `stats.py`, который:
  1. читает файл через `csv.DictReader`;
  2. переводит `volume`, `price`, `pnl` в числа (подумай, что делать со строкой, которая не парсится, — пропустить с предупреждением);
  3. фильтрует сделки одной стороны;
  4. считает по каждому символу: количество, суммарный PnL, средний PnL, винрейт (через `collections.defaultdict` или `Counter`);
  5. печатает таблицу, отсортированную по суммарному PnL (`sorted(..., key=lambda r: r["pnl"], reverse=True)`).

  Ожидаемый результат: несколько строк вида `BTCUSDT  n=7  pnl=+12.40  avg=+1.77  win=57%`.
- [ ] **Шпаргалка.** `notes/python-vs-ts.md` — таблица «TS → Python», минимум 25 строк: `null/undefined`, `===`, `??`, тернарник, `map/filter`, деструктуризация, spread, `try/catch`, `class/this`, `interface` → `dataclass`/Pydantic, `import`, `JSON.parse` → `json.loads`, `Object.entries` → `.items()`, `arr.length` → `len(arr)` и т.д.
- [ ] **Чтение чужого кода.** Попроси модель (любой чат: DeepSeek, Claude, ChatGPT — в запросе нет твоих данных) сгенерировать «скрипт на 100 строк, который анализирует лог-файл веб-сервера» и объясни вслух (или письменно в `notes/`) каждую функцию, не запуская. Потом запусти и проверь себя.

## Готово, когда

- Можешь прочитать незнакомый Python-скрипт на 100 строк и объяснить, что он делает, включая comprehensions, `*args/**kwargs`, `with` и обработку исключений.
- `spread.py` и `stats.py` работают, `stats.py` написан без AI.
- `notes/python-vs-ts.md` лежит в репозитории и закоммичен.

## Тест для самопроверки

1. Что выведет `print(7 / 2, 7 // 2, -7 // 2)`?
   a) `3 3 -3` b) `3.5 3 -4` c) `3.5 3 -3` d) `3.5 3.5 -3.5`
2. Какие из значений falsy: `[]`, `"0"`, `0.0`, `{}`, `" "`, `None`?
3. Чем `Optional[int]` отличается от «необязательного аргумента»?
4. Что не так в этом коде?
   ```python
   def collect(symbol, seen=set()):
       seen.add(symbol)
       return len(seen)
   ```
5. Когда правильно использовать `is`, а не `==`?
6. Что делает `if __name__ == "__main__":` и зачем он нужен, если файл будут импортировать тесты?
7. Что вернёт `{t["s"]: t["p"] for t in [{"s": "A", "p": 1}, {"s": "A", "p": 2}]}`?
   a) `{"A": 1}` b) `{"A": 2}` c) `{"A": [1, 2]}` d) ошибку
8. Функция объявлена `def mid(bid: float, ask: float) -> float`. Что произойдёт при вызове `mid("1", "2")`, если внутри `return (bid + ask) / 2`?
9. Что не так в обработке ошибки?
   ```python
   try:
       price = float(row["price"])
   except Exception:
       pass
   total += price
   ```
10. Что такое `*` в сигнатуре `def create(*, model, max_tokens)`?
11. Как скопировать список `a`, чтобы изменения копии не меняли `a`, если внутри списка лежат словари?
12. Почему `{}` нельзя использовать для создания пустого множества?
13. Чем отличаются `OpenAI()` и `OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])` с точки зрения Python и с точки зрения того, куда уходят данные?
14. Что не так в этом коде, если в `.env` переменная называется `DEEPSEEK_API_KEY`?
    ```python
    key = os.environ.get("DEEPSEK_API_KEY")
    client = OpenAI(api_key=key, base_url="https://api.deepseek.com")
    ```

## Ответы

1. **b.** `/` всегда float, `//` округляет вниз, к минус бесконечности, поэтому `-7 // 2 == -4`.
2. `[]`, `0.0`, `{}`, `None`. Строки `"0"` и `" "` непустые, значит truthy.
3. `Optional[int]` — это тип «`int` или `None`» (то же, что `int | None`). Необязательным аргумент делает значение по умолчанию (`= None`), а не аннотация.
4. Изменяемый default: одно множество создаётся при определении функции и копится между вызовами. Нужно `seen=None` и `if seen is None: seen = set()`.
5. Только для синглтонов, на практике — `x is None` / `x is not None`. Для значений (строки, числа, списки) — `==`.
6. Блок выполняется только при запуске файла как скрипта. При `import` из тестов или ноутбука `__name__` равен имени модуля, и `main()` не запускается.
7. **b.** Ключи словаря уникальны, последнее присваивание побеждает.
8. Аннотации не проверяются: `"1" + "2"` даст строку `"12"`, а деление строки на 2 бросит `TypeError`. Ошибку покажет только статический анализатор или IDE.
9. Исключение проглочено: при ошибке парсинга `price` останется от предыдущей итерации (или будет `NameError` на первой), и сумма станет неверной без всякого сигнала. Нужно пропустить строку явно (`continue`) с логом или пробросить ошибку.
10. Всё после `*` передаётся только по имени: `create(model="m", max_tokens=100)`; `create("m", 100)` даст `TypeError`. Так устроены SDK, чтобы порядок аргументов можно было менять без поломок.
11. `copy.deepcopy(a)`. `a.copy()` и `list(a)` создают поверхностную копию: словари внутри будут общими.
12. `{}` — литерал пустого словаря (так исторически сложилось). Пустое множество — `set()`.
13. Для Python это один и тот же класс, разница только в именованных аргументах. Для данных — принципиальная: первый клиент шлёт запросы в OpenAI (ключ из `OPENAI_API_KEY`), второй — в DeepSeek, на серверы в Китае, куда нельзя отправлять реальные сделки и личные данные.
14. Опечатка в имени переменной: `.get` молча вернёт `None`, и ошибка проявится позже и непонятно (SDK пожалуется на отсутствие ключа или сервер вернёт 401). `os.environ["DEEPSEEK_API_KEY"]` упал бы сразу с `KeyError` и правильным именем в сообщении.

## Что дальше

Дальше глава 1.2 · Репозиторий для учёбы: git, notes/, структура (AIL-56): заведёшь репозиторий, куда положишь шпаргалку и упражнения. Затем глава 1.3 · Python: uv, async, Pydantic (AIL-2) — настоящее окружение проекта, асинхронные запросы и валидация данных, без которых не обходится ни один LLM-проект.
