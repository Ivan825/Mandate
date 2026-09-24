# mandate-agent (Python)

Give your AI agent a spending mandate, not a card. This client talks to a [Mandate](https://github.com/Ivan825/Mandate) server with a mandate token: ask before paying, capture what was actually paid, void what wasn't. Zero dependencies (Python 3.9+).

```bash
pip install mandate-agent
```

```python
from mandate_agent import Mandate, MandateDeclined, MandatePending

m = Mandate("mnd_...", base_url="https://mandate-ashen.vercel.app")

# The safe pattern: a hold that settles itself.
with m.hold(1299, "OpenAI", purpose="API credits", idempotency_key="order-1") as h:
    pay_the_merchant()
    h.capture(1199)            # less than authorised → the difference returns to the limits
# leaving the block without capture() voids the hold; an exception voids it too

# Or step by step:
d = m.authorize(1299, "OpenAI", idempotency_key="order-1")
if d.approved:
    m.capture(d.transaction_id, 1199)
else:
    print(d.decision, d.reason, d.remedy.message)   # when to retry, the most that would pass now
```

- `authorize(amount, merchant, purpose=None, category=None, idempotency_key=None, wait_for=0, poll_every=5)` — with `wait_for` seconds, a *pending* answer is polled (same key) until the owner decides.
- `capture(transaction_id, amount=None, note=None)`, `void(transaction_id, reason=None)`, `get(transaction_id)`, `mandate()`.
- `hold(...)` raises `MandateDeclined` (with `.remedy`) or `MandatePending` instead of returning a non-approval.

Amounts are integers in the mandate's minor unit (cents, paise).

## Agent frameworks

```python
from mandate_agent.tools import openai_tools, dispatch     # OpenAI SDK function calling
from mandate_agent.tools import agents_tools               # OpenAI Agents SDK:  Agent(tools=agents_tools(m))
from mandate_agent.tools import langchain_tools            # LangChain / LangGraph: llm.bind_tools(langchain_tools(m))
```

Four tools: `check_mandate`, `request_purchase`, `capture_purchase`, `void_purchase`. The descriptions teach the model the protocol: check the budget, ask before paying, capture after, void if nothing was paid, read the remedy on a decline.

## Publishing (maintainers)

```bash
cd sdk/python && python -m pip install build twine && python -m build && twine upload dist/*
```

Licence: AGPL-3.0-only, like the server.
