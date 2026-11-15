# 1.1 · Python for developers who already code  (AIL-1)

> **Week 1** · Preparation · ⏱ ~4 h · Theory, Practice

<!-- description: Python for developers coming from another language: what differs in syntax, numbers, collections, functions, classes, exceptions, modules, type hints. -->
<!-- source-sha256: e72a2fa9899d -->

## Why an AI engineer needs this

Almost the entire AI stack — the Anthropic and OpenAI SDKs, Pydantic, LangGraph, LlamaIndex, eval frameworks, documentation examples — is written in Python. A model will often generate code for us, but we are the ones responsible for it: we need to spot a mutable default, a swallowed exception or a `float` where money belongs at first glance. Live coding in AI engineer interviews is almost always in Python. The goal of this chapter is not to learn the language from scratch but to carry over what we already know from another language (JavaScript, Java, Go, C# — it doesn't matter) and cover only what makes Python different.

The course's running example is a training online shop, Shelf: mugs, lamps, tea by weight; orders, products, payments. The code examples in this chapter and all four projects later on are built on it.

The chapter goes from general to specific: first a table of Python's main differences from other languages, then, in order, syntax, numbers, collections, functions, classes, exceptions, modules and types. It is worth trying each topic right away in the interactive console: `python3` with no arguments opens a REPL, where an expression runs as soon as we press Enter.

## Theory

### 1. Mental model: how Python differs from other languages

| | In many languages | Python |
|---|---|---|
| Running | compile or build before running | `python file.py` — an interpreter, no build step |
| Types | checked by the compiler | type hints are **not checked at all** at runtime; mypy/pyright/the IDE check them |
| Blocks | `{ }` | indentation (4 spaces), a colon at the end of the header |
| Empty value | `null`, sometimes `undefined` as well | a single `None` |
| Concurrency | threads or a built-in event loop | synchronous by default; the event loop is explicit, via `asyncio` (chapter AIL-2) |
| Packages | npm, Maven, Go modules, etc. | uv/pip, `pyproject.toml`, the `.venv` virtual environment (AIL-2) |
| Numbers | fixed-size integers + double | arbitrary-length `int` + `float` (double) + `Decimal` |

The main consequence of the second row: the annotation `def f(x: int)` is documentation and a hint for the IDE. `f("abc")` runs without an error until something inside breaks. Runtime data validation is done by Pydantic — the topic of AIL-2. The other rows of the table are covered below, in order.

### 2. Syntax: indentation, `None`, truthy/falsy

A code block is defined not by braces but by indentation: an `if`, `for` or `def` header ends with a colon, and everything indented by 4 spaces under it is the block's body. A function that returns a product's status based on the stock level:

```python
def stock_status(quantity: int) -> str:
    if quantity > 20:
        return "in_stock"
    elif quantity < 1:      # elif, not "else if"
        return "sold_out"
    else:
        return "low"
```

Logical operators are words: `and`, `or`, `not`. The ternary operator reads the other way round: `x if cond else y` (in C-like languages, `cond ? x : y`). There is no "default only for an empty value" operator (like `??` in JavaScript and C#); `a or b` triggers on any falsy value, including `0`.

Besides `True` and `False`, any value can be tested in a condition: each one counts as either "true" (truthy) or "false" (falsy). **Falsy in Python:** `None`, `False`, `0`, `0.0`, `""`, `[]`, `{}`, `set()`, `()`. An important detail: **an empty list and an empty dict are falsy** (in JavaScript, for example, `[]` and `{}` are truthy). So the idiom `if not orders:` means "the list is empty".

**`==` vs `is`.** `==` compares values; for lists and dicts it compares element by element: `[1, 2] == [1, 2]` → `True` (in many languages such a comparison checks references and gives `false`). `is` compares object identity. We use `is` only with `None`: `if x is None:`. Comparing strings or numbers with `is` sometimes "works" because of interpreter caching and one day stops working — a classic bug.

### 3. Numbers

Almost everything in a shop is numbers: quantities, prices, discounts. Here Python behaves differently from many languages:

- `int` doesn't overflow: `2**100` is an exact number.
- `/` **always** gives a `float`: `7 / 2 == 3.5`, `4 / 2 == 2.0`.
- `//` is floor division (toward minus infinity!): `7 // 2 == 3`, but `-7 // 2 == -4`.
- `**` is exponentiation, `%` is the remainder (its sign follows the divisor: `-7 % 2 == 1`).
- For money and anything where precision matters, use `decimal.Decimal("0.1")` (from a string, not a float). `0.1 + 0.2 == 0.30000000000000004` here just as in any language with doubles.

### 4. Collections

Lists of orders, "product → price" dicts, sets of categories are the main working shape of data in any script. There are four built-in collections:

| Common name | Python | Notes |
|---|---|---|
| array, list | `list[T]`: `[1, 2, 3]` | mutable |
| tuple | `tuple`: `(1, "a")` | immutable, can be a dict key |
| dictionary, map, hash table | `dict[K, V]`: `{"mug": 1}` | insertion order is preserved |
| set | `set[T]`: `{1, 2}` | the empty one is only `set()`; `{}` is an empty dict |

Access:

```python
prices = {"mug": 5.90, "notebook": 3.20}
prices["mug"]            # KeyError if missing — not a silent empty value
prices.get("pen")        # None
prices.get("pen", 0.0)   # default value
"mug" in prices          # key membership
for product, price in prices.items():
    print(product, price)
```

**Slices:** `a[start:stop:step]`; `stop` is excluded, negative indices count from the end.

```python
xs = [10, 20, 30, 40, 50]
xs[1:3]    # [20, 30]
xs[-1]     # 50
xs[:2]     # [10, 20]
xs[::-1]   # reversed copy
```

**Comprehensions** replace `map`/`filter` chains: a list, dict or set is built in one expression, "what to take — from where — under what condition". In the example, `orders` is a list of order dicts like `{"id": 1, "category": "mugs", "quantity": 2}`:

```python
# "keep the positive ones and double them" in one expression
doubled = [x * 2 for x in xs if x > 0]
by_id = {o["id"]: o for o in orders}                  # dict comprehension
categories = {o["category"] for o in orders}          # set comprehension
total = sum(o["quantity"] for o in orders)            # generator, no list built
```

**Unpacking** is what other languages call destructuring: `a, b = b, a`; `first, *rest = xs`; in a loop, `for i, x in enumerate(xs):`. `zip(a, b)` walks two lists in pairs.

**Strings:** f-strings insert values right into the text — `f"{product}: {discount:.1f}%"`. Strings are immutable; joining a list of strings is `"".join(parts)`, the method is called on the separator.

### 5. Functions

```python
def order_preview(product: str, quantity: int, *, delivery: str = "pickup", **extra) -> dict:
    return {"product": product, "quantity": quantity, "delivery": delivery, **extra}

order_preview("mug", 2, delivery="courier", note="gift")
```

- Positional and **keyword** arguments: `f(1, delivery="courier")`. This is not an options object but a real part of the language.
- `*` in a signature: everything after it is keyword-only. SDKs use this all the time: `client.messages.create(model=..., max_tokens=..., messages=...)`.
- `*args` collects extra positional arguments into a tuple, `**kwargs` collects extra keyword arguments into a dict (in the example above this is `**extra`: `note="gift"` ends up in `extra`). In a call, `f(*xs, **opts)` unpacks a list and a dict into arguments; inside a literal, `{..., **extra}` unpacks a dict into a new dict.
- `lambda x: x * 2` holds only a single expression.

**The mutable default trap.** A default value is evaluated **once**, when the function is defined:

```python
def add_item(item, cart=[]):      # BUG: one list shared by all calls
    cart.append(item)
    return cart

add_item("mug")       # ["mug"]
add_item("notebook")  # ["mug", "notebook"]  <- surprise

def add_item(item, cart=None):    # correct
    if cart is None:
        cart = []
    cart.append(item)
    return cart
```

**Scopes.** Assignment inside a function creates a local variable. To change a variable of the enclosing function, use `nonlocal`; of the module, `global` (almost never needed). `if`/`for` blocks **don't create** a scope: a loop variable lives on after the loop.

### 6. Classes and dataclass

Classes work as expected — a constructor, attributes, methods — but with an explicit `self`. An example is a payment provider that charges a fee on the payment amount:

```python
class PaymentProvider:
    fee_rate: float = 0.025             # class attribute

    def __init__(self, name: str):      # constructor
        self.name = name                # instance attribute, "this" is explicit

    def fee(self, amount: float) -> float:
        return amount * self.fee_rate

    def __repr__(self) -> str:          # like toString() for debugging
        return f"PaymentProvider({self.name!r})"
```

`self` is passed explicitly as the first parameter of every method. There is no privacy: `_name` is a convention for "don't touch from outside", `__name` is name mangling, not protection. Inheritance: `class CardProvider(PaymentProvider):`, calling the parent is `super().__init__(name)`.

For "just data" we use `@dataclass` — it generates `__init__`, `__repr__`, `__eq__`. A line with `@` above a class or function is a **decorator**: a function that takes the definition and returns a modified version of it (here, a class with ready-made methods). Decorators show up constantly: `@field_validator` in Pydantic, `@pytest.mark.parametrize` in tests.

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)          # frozen = immutable, like a readonly type
class OrderItem:
    product: str
    quantity: int
    price: float
    tags: list[str] = field(default_factory=list)  # never "= []"
```

Dunder methods (from double underscore: `__init__`, `__len__`, `__eq__`, `__enter__`) are "protocols": Python calls them itself when we write `len(x)`, `a == b`, `with x:` (more on `with` in the next section).

### 7. Exceptions

Errors in Python are exceptions, as in Java or C#. For our own code we set up a hierarchy: a base error class for the data layer and specific subclasses, and wrap other code's exceptions in our own when needed:

```python
class ShopError(Exception):
    """Base error for the shop data layer."""

class OutOfStock(ShopError):
    pass

try:
    data = load(path)
except FileNotFoundError:
    data = []
except (ValueError, KeyError) as e:
    raise ShopError(f"bad file {path}") from e   # keeps the cause
else:
    print("loaded")        # runs only if no exception
finally:
    print("done")
```

Exceptions are caught by **type** (`except ValueError`), and the order of the branches matters: the first matching one wins. `except Exception:` without a re-`raise` is almost always a swallowed error. A bare `except:` catches even Ctrl+C — we don't write that.

The `with` **context manager** guarantees a resource is released (what other languages do with `try/finally`, `using` or `defer`):

```python
with open("orders.csv", encoding="utf-8") as f:
    text = f.read()
# file is closed here even on exception
```

### 8. Modules and imports

As soon as the code grows beyond one file, the question is how files see each other. A file = a module, a folder of files = a package. `import json`, `from pathlib import Path`, `from .utils import order_total` (a relative import inside a package). Importing a module means running its top level once. Hence the idiom:

```python
def main() -> None:
    ...

if __name__ == "__main__":   # true only when run as a script, not when imported
    main()
```

This lets tests and notebooks import the functions without running the script.

### 9. Type hints

Type annotations have appeared in every example above; let's gather their forms in one place. A reminder: the runtime doesn't check them, but they are read by IDEs, linters, Pydantic and SDKs, which build data schemas from them.

```python
from typing import Optional, Literal, Any
from collections.abc import Iterable

def average(a: float, b: float) -> float: ...
def find(product: str) -> dict[str, float] | None: ...    # modern form (3.10+)
def find_old(product: str) -> Optional[dict[str, float]]: ...  # same thing
Status = Literal["new", "paid", "shipped"]                # only these three strings are allowed
def total(xs: Iterable[float]) -> float: ...
```

`Optional[X]` means "X or None", not "an optional argument". `list[str]`, `dict[str, int]` are written in lowercase (since Python 3.9); `List`, `Dict` from `typing` are the old style that shows up in other people's code. `Any` turns off type checking for a value.

### 10. The standard library worth recognizing on sight

`pathlib` (paths), `json`, `csv`, `datetime`, `collections` (`Counter`, `defaultdict`), `statistics` (`mean`, `median`, `stdev`), `itertools`, `logging`, `os.environ`. No need to memorize them — it is enough to know they exist and ask a model or the docs.

## DeepSeek and Ollama: how we do it

For this chapter the provider hardly matters: Python is the same. The course's main models are DeepSeek (cloud, cheap) and a local Ollama (models on our own computer), with Claude and OpenAI kept for comparison (details in chapter 1.5 · How LLMs work: Karpathy's lecture and API keys (AIL-3)). Both DeepSeek and Ollama accept requests in the OpenAI format, so both connect through the same `openai` library — only the server address changes. The API key (the password for access to a cloud model) comes from an environment variable via `os.environ` and is not written in the code. We start calling models in chapter 1.5, but it is already useful to read such code and spot this chapter's topics in it:

```python
# illustrative: one SDK, two providers — only keyword arguments differ
import os
from openai import OpenAI

deepseek = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")
local = OpenAI(api_key="ollama", base_url="http://localhost:11434/v1")   # Ollama ignores the key
```

- **Keyword arguments** (`base_url=...`, section 5) are what all the compatibility rests on: there is no need to subclass or rewrite the client, passing a different address is enough. In SDKs almost everything is keyword-only (`*` in the signature).
- **`os.environ["X"]` vs `os.environ.get("X")`.** The first raises `KeyError` if the variable is missing (a loud error right away); the second returns `None`, and a confusing authorization error shows up later. DeepSeek's official example uses `.get`; in our own code we prefer `[]`.
- **What may be sent to the cloud.** Asking a model to generate a study script is fine with any provider: there is nothing personal in the request. Work code, customer data and anything that must not be shown to outsiders are not sent to cloud models — that is what the local model in Ollama is for. This rule holds for the whole course.

## Learning path

1. We open [Learn X in Y minutes: Python](https://learnxinyminutes.com/docs/python/) → go through the whole page, **running** each block in the `python3` REPL or in a file (≈90 min). We note everything that behaves differently from our usual language — raw material for the cheat sheet.
2. We open the [official tutorial](https://docs.python.org/3/tutorial/) → chapters 3–9 (≈90 min, skimming). In detail: 4.8 "More on Defining Functions" (arguments, the default trap), 5 "Data Structures" (comprehensions, dicts), 8 "Errors and Exceptions", 9 "Classes" up to section 9.8. Chapters 6 (modules) and 7 (input and output, f-strings) — a quick skim.
3. We open the [dataclasses documentation](https://docs.python.org/3/library/dataclasses.html) → the first examples and `field(default_factory=...)` (≈10 min).
4. We open the [csv module](https://docs.python.org/3/library/csv.html) → `csv.DictReader` (≈10 min) — it comes in handy in the practice.
5. [PEP 8](https://peps.python.org/pep-0008/) → the Naming Conventions section (≈10 min): `snake_case` for functions and variables, `PascalCase` for classes, `UPPER_CASE` for constants. The Ruff formatter takes care of the rest (AIL-2).
6. [Real Python](https://realpython.com) — not read cover to cover but searched as questions come up ("python args kwargs", "python decorators"). One article — one question.
7. (≈5 min, a reading exercise) We open [DeepSeek Quick Start](https://api-docs.deepseek.com) → the Python example. We read it as Python code: which arguments are keyword arguments, where the key comes from, what `response.choices[0].message.content` returns. No need to run it yet — the key arrives in chapter 1.5.

## What to watch out for

- **Mutable default** (`def f(x=[])`, `x={}`) — the most common bug in generated code. In a dataclass, use `field(default_factory=list)`.
- **`float` for money.** A total over 1000 orders in float will drift from the payment system's report by cents. Either `Decimal` from strings or deliberate rounding on output.
- **`except Exception: pass`** silently hides a failure. AI code often "handles" API errors this way; in review we require logging or a re-`raise`.
- **Indentation.** Mixing tabs and spaces gives a `TabError`; an extra indent on a `return` inside a loop makes the function exit after the first iteration.
- **Copying.** `b = a` for a list is the same reference, not a copy. A copy is `a.copy()` or `list(a)`; a deep one is `copy.deepcopy(a)`.
- **`dict[key]` raises `KeyError`** instead of returning an empty value. For data from an API, use `.get()`.
- **A loop variable lives on after the loop**, and lambdas in a loop capture the variable, not its value: all of them see its last value.
- **Type hints don't protect.** If a function is declared `-> float` but returns `None`, the runtime stays silent.
- **`/` in indices.** `xs[len(xs) / 2]` fails: an index must be an `int`, so `//` is needed.

## Practice

We set up the `ai-engineering-journey` study repository in the next chapter, 1.2 (AIL-56); for now we create an ordinary folder with its future structure — `mkdir -p ~/ai-engineering-journey/exercises/week-01 ~/ai-engineering-journey/notes` — and in 1.2 turn it into a git repository. Until uv is set up (that's AIL-2), the system `python3` is enough (`python3 --version` — 3.10+ is required, for `X | None`).

- [ ] **Learn X in Y minutes, running it.** We create `exercises/week-01/learn_x_in_y.py` and retype (not copy) the blocks that surprised us. At least 10 "surprises".
- [ ] **Three pure functions for the shop.** In `exercises/week-01/pricing.py` we write functions without I/O: an order total with a discount, a markup in percent, a percent change in price. Skeleton:

  ```python
  def order_total(unit_price: float, quantity: int, discount_pct: float = 0.0) -> float:
      """Order amount after a percent discount."""
      ...

  def markup_pct(price: float, cost: float) -> float:
      """How much the price exceeds the cost, in percent of the cost."""
      ...

  if __name__ == "__main__":
      print(order_total(1.0, 3, discount_pct=10))  # expected: 2.7
      print(markup_pct(1.5, 1.0))                  # expected: 50.0
  ```

  If we have our own project in another language at hand, we can port 2–3 pure functions from it instead: that shows Python's differences best of all.
- [ ] **CSV by hand, without AI.** We create a fictional `exercises/week-01/orders.csv` (20 rows, one row per order; columns `created_at,category,status,quantity,unit_price,discount`; statuses `paid`, `refunded`, `cancelled`; `discount` is a discount in dollars, order total = `quantity × unit_price − discount`). We write `stats.py`, which:
  1. reads the file with `csv.DictReader`;
  2. converts `quantity`, `unit_price`, `discount` to numbers (what to do with a row that doesn't parse? — skip it with a warning);
  3. drops cancelled orders;
  4. computes per category (with `collections.defaultdict` or `Counter`): the number of orders `n` (paid and refunded), revenue — the sum of paid orders only, because refunded money went back to the customer, the average order value — revenue per paid order, the share of refunds among `n`;
  5. prints a table sorted by revenue (`sorted(..., key=lambda r: r["revenue"], reverse=True)`).

  Expected result: a few lines like `mugs  n=7  revenue=84.20  avg=14.03  refunded=14%` (7 orders: 6 paid for $84.20 and 1 refund).
- [ ] **Cheat sheet.** `notes/python-cheatsheet.md` — a "what I'm used to → how it's done in Python" table, at least 25 rows: empty value, comparison, ternary, `map/filter` → comprehensions, destructuring → unpacking, error handling, classes and `self`, data structures → `dataclass`/Pydantic, imports, parsing JSON → `json.loads`, iterating over a dict → `.items()`, length → `len(x)`, etc. We fill in the left column in our main language.
- [ ] **Reading someone else's code.** We ask a model (any chat: DeepSeek, Claude, ChatGPT — there is nothing personal in the request) to generate "a 100-line script that analyzes a web server log file" and explain each function out loud (or in writing in `notes/`) without running it. Then we run it and check ourselves.

## Done when

- We can read an unfamiliar 100-line Python script and explain what it does, including comprehensions, `*args/**kwargs`, `with` and exception handling.
- `pricing.py` and `stats.py` work; `stats.py` is written without AI.
- `notes/python-cheatsheet.md` is written; in chapter 1.2 it becomes part of the first commit.

## Self-check quiz

1. What does `print(7 / 2, 7 // 2, -7 // 2)` print?
   a) `3 3 -3` b) `3.5 3 -4` c) `3.5 3 -3` d) `3.5 3.5 -3.5`
2. Which of these values are falsy: `[]`, `"0"`, `0.0`, `{}`, `" "`, `None`?
3. How does `Optional[int]` differ from "an optional argument"?
4. What is wrong with this code?
   ```python
   def collect(category, seen=set()):
       seen.add(category)
       return len(seen)
   ```
5. When is it correct to use `is` rather than `==`?
6. What does `if __name__ == "__main__":` do, and why is it needed if tests will import the file?
7. What does `{r["sku"]: r["price"] for r in [{"sku": "MUG-NORTH", "price": 5.90}, {"sku": "MUG-NORTH", "price": 6.50}]}` return?
   a) `{"MUG-NORTH": 5.90}` b) `{"MUG-NORTH": 6.50}` c) `{"MUG-NORTH": [5.90, 6.50]}` d) an error
8. A function is declared `def average(a: float, b: float) -> float`. What happens on the call `average("1", "2")` if the body is `return (a + b) / 2`?
9. What is wrong with this error handling?
   ```python
   try:
       price = float(row["price"])
   except Exception:
       pass
   total += price
   ```
10. What is `*` in the signature `def create(*, model, max_tokens)`?
11. How do we copy a list `a` so that changes to the copy don't change `a`, if the list holds dicts?
12. Why can't `{}` be used to create an empty set?
13. How do `OpenAI()` and `OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])` differ from Python's point of view and from the point of view of where the data goes?
14. What is wrong with this code if the variable in `.env` is named `DEEPSEEK_API_KEY`?
    ```python
    key = os.environ.get("DEEPSEK_API_KEY")
    client = OpenAI(api_key=key, base_url="https://api.deepseek.com")
    ```

## Answers

1. **b.** `/` is always a float, `//` rounds down, toward minus infinity, so `-7 // 2 == -4`.
2. `[]`, `0.0`, `{}`, `None`. The strings `"0"` and `" "` are non-empty, so they are truthy.
3. `Optional[int]` is the type "`int` or `None`" (the same as `int | None`). What makes an argument optional is a default value (`= None`), not the annotation.
4. A mutable default: one set is created when the function is defined and accumulates across calls. It should be `seen=None` and `if seen is None: seen = set()`.
5. Only for singletons; in practice, `x is None` / `x is not None`. For values (strings, numbers, lists), `==`.
6. The block runs only when the file is run as a script. On `import` from tests or a notebook, `__name__` equals the module name, and `main()` doesn't run.
7. **b.** Dict keys are unique; the last assignment wins.
8. Annotations aren't checked: `"1" + "2"` gives the string `"12"`, and dividing a string by 2 raises `TypeError`. Only a static analyzer or the IDE shows the error.
9. The exception is swallowed: on a parse error `price` keeps its value from the previous iteration (or there is a `NameError` on the first one), and the total becomes wrong without any signal. The row should be skipped explicitly (`continue`) with a log, or the error re-raised.
10. Everything after `*` is passed by name only: `create(model="m", max_tokens=100)`; `create("m", 100)` gives `TypeError`. SDKs are built this way so that the order of arguments can change without breaking anything.
11. `copy.deepcopy(a)`. `a.copy()` and `list(a)` make a shallow copy: the dicts inside are shared.
12. `{}` is the empty dict literal (for historical reasons). An empty set is `set()`.
13. For Python it is the same class; the only difference is the keyword arguments. For the data the difference is fundamental: the first client sends requests to OpenAI (the key comes from `OPENAI_API_KEY`), the second to DeepSeek. In both cases the data goes to someone else's servers, so work and personal data are not sent there.
14. A typo in the variable name: `.get` silently returns `None`, and the error shows up later and is confusing (the SDK complains about a missing key or the server returns 401). `os.environ["DEEPSEEK_API_KEY"]` would fail right away with a `KeyError` and the correct name in the message.

## What's next

Next is chapter 1.2 · A study repository: git, notes/, structure (AIL-56): we set up the repository for the cheat sheet and exercises. Then chapter 1.3 · Python: uv, async, Pydantic (AIL-2) — a real project environment, async requests and data validation, which no LLM project does without.
