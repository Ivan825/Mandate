"""Tool definitions for agent frameworks, bound to a Mandate client.

    from mandate_agent import Mandate
    from mandate_agent.tools import openai_tools, dispatch, agents_tools, langchain_tools

    m = Mandate("mnd_...")
    tools = openai_tools()                  # OpenAI chat-completions / Responses function schemas
    result = dispatch(m, name, arguments)   # run the call the model asked for

    agent = Agent(tools=agents_tools(m))    # OpenAI Agents SDK
    llm.bind_tools(langchain_tools(m))      # LangChain
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from . import Mandate

TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "check_mandate",
        "description": "Read the spending mandate this agent holds: limits, what is left today and overall, allowed merchants, active hours, open holds. Call before planning a purchase.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "request_purchase",
        "description": "Ask for authorisation to spend BEFORE paying. amount is an integer in minor units (1299 = 12.99). Returns approved (a hold — capture after paying), declined (with a remedy: when to retry, the most that would pass now), or pending (the owner must approve; tell the user, wait, retry with the same idempotency_key).",
        "parameters": {
            "type": "object",
            "properties": {
                "amount": {"type": "integer", "description": "Minor units, e.g. 1299 for 12.99"},
                "merchant": {"type": "string", "description": "Who is being paid"},
                "purpose": {"type": "string", "description": "One line the owner will read"},
                "category": {"type": "string", "description": "Optional merchant category slug"},
                "idempotency_key": {"type": "string", "description": "Reuse on retries of the same purchase"},
            },
            "required": ["amount", "merchant"],
            "additionalProperties": False,
        },
    },
    {
        "name": "capture_purchase",
        "description": "After paying, record what was actually paid against an approved hold. amount defaults to the full authorised amount; less releases the difference.",
        "parameters": {
            "type": "object",
            "properties": {"transaction_id": {"type": "string"}, "amount": {"type": "integer"}, "note": {"type": "string"}},
            "required": ["transaction_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "propose_plan",
        "description": "Before a multi-step task, list what you intend to buy (merchant, maximum amount in minor units, purpose) as one plan. The owner approves the list once; each purchase inside it then passes request_purchase without asking. Poll get_plan until status is approved.",
        "parameters": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "items": {"type": "array", "items": {"type": "object", "properties": {"merchant": {"type": "string"}, "amount": {"type": "integer"}, "purpose": {"type": "string"}}, "required": ["merchant", "amount"]}}},
            "required": ["title", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_plan",
        "description": "Read a plan's status and which items are still available.",
        "parameters": {"type": "object", "properties": {"plan_id": {"type": "string"}}, "required": ["plan_id"], "additionalProperties": False},
    },
    {
        "name": "void_purchase",
        "description": "Nothing was paid: release the approved hold back to the limits.",
        "parameters": {"type": "object", "properties": {"transaction_id": {"type": "string"}, "reason": {"type": "string"}}, "required": ["transaction_id"], "additionalProperties": False},
    },
]


def openai_tools() -> List[Dict[str, Any]]:
    """Function-calling definitions for the OpenAI SDK (chat completions or Responses)."""
    return [{"type": "function", "function": s} for s in TOOL_SCHEMAS]


def dispatch(m: Mandate, name: str, arguments: Any) -> Dict[str, Any]:
    """Run the tool the model asked for; returns a JSON-serialisable dict."""
    args = json.loads(arguments) if isinstance(arguments, str) else dict(arguments or {})
    if name == "check_mandate":
        return m.mandate()
    if name == "request_purchase":
        d = m.authorize(int(args["amount"]), str(args["merchant"]), purpose=args.get("purpose"), category=args.get("category"), idempotency_key=args.get("idempotency_key"))
        return d.raw
    if name == "capture_purchase":
        return m.capture(str(args["transaction_id"]), args.get("amount"), args.get("note"))
    if name == "void_purchase":
        return m.void(str(args["transaction_id"]), args.get("reason"))
    if name == "propose_plan":
        return m.propose_plan(str(args["title"]), list(args["items"]))
    if name == "get_plan":
        return m.get_plan(str(args["plan_id"]))
    raise ValueError(f"Unknown tool {name}")


def agents_tools(m: Mandate) -> list:
    """Tools for the OpenAI Agents SDK (pip install openai-agents)."""
    from agents import function_tool  # type: ignore

    @function_tool
    def check_mandate() -> dict:
        """Read the agent's spending mandate: limits, what is left, open holds."""
        return m.mandate()

    @function_tool
    def request_purchase(amount: int, merchant: str, purpose: str = "", idempotency_key: str = "") -> dict:
        """Ask for authorisation to spend before paying. amount in minor units (1299 = 12.99). approved = a hold; declined carries a remedy; pending = owner must approve, retry later with the same idempotency_key."""
        return m.authorize(amount, merchant, purpose=purpose or None, idempotency_key=idempotency_key or None).raw

    @function_tool
    def capture_purchase(transaction_id: str, amount: int = 0, note: str = "") -> dict:
        """After paying, record what was actually paid (0 = the full authorised amount)."""
        return m.capture(transaction_id, amount or None, note or None)

    @function_tool
    def void_purchase(transaction_id: str, reason: str = "") -> dict:
        """Nothing was paid: release the hold."""
        return m.void(transaction_id, reason or None)

    @function_tool
    def propose_plan(title: str, items: list) -> dict:
        """List intended purchases ([{merchant, amount(minor units), purpose}]) for one-time approval; poll get_plan until approved."""
        return m.propose_plan(title, items)

    @function_tool
    def get_plan(plan_id: str) -> dict:
        """Read a plan's status and remaining items."""
        return m.get_plan(plan_id)

    return [check_mandate, request_purchase, capture_purchase, void_purchase, propose_plan, get_plan]


def langchain_tools(m: Mandate) -> list:
    """StructuredTools for LangChain / LangGraph (pip install langchain-core)."""
    from langchain_core.tools import StructuredTool  # type: ignore

    def check_mandate() -> dict:
        return m.mandate()

    def request_purchase(amount: int, merchant: str, purpose: str = "", idempotency_key: str = "") -> dict:
        return m.authorize(amount, merchant, purpose=purpose or None, idempotency_key=idempotency_key or None).raw

    def capture_purchase(transaction_id: str, amount: int = 0, note: str = "") -> dict:
        return m.capture(transaction_id, amount or None, note or None)

    def void_purchase(transaction_id: str, reason: str = "") -> dict:
        return m.void(transaction_id, reason or None)

    def propose_plan(title: str, items: list) -> dict:
        return m.propose_plan(title, items)

    def get_plan(plan_id: str) -> dict:
        return m.get_plan(plan_id)

    by_name = {s["name"]: s["description"] for s in TOOL_SCHEMAS}
    return [StructuredTool.from_function(f, name=f.__name__, description=by_name[f.__name__]) for f in (check_mandate, request_purchase, capture_purchase, void_purchase, propose_plan, get_plan)]
