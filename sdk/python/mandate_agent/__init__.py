"""mandate-agent: a spending mandate for your AI agent.

    from mandate_agent import Mandate

    m = Mandate("mnd_...", base_url="https://mandate-ashen.vercel.app")
    with m.hold(1299, "OpenAI", purpose="API credits", idempotency_key="order-1") as h:
        pay()
        h.capture(1199)

Amounts are integers in the mandate's minor unit (cents, paise). No
dependencies beyond the standard library.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

__all__ = ["Mandate", "Hold", "Decision", "Remedy", "MandateError", "MandateDeclined", "MandatePending", "MandateAuthError"]
__version__ = "0.6.0"

DEFAULT_BASE_URL = "https://mandate-ashen.vercel.app"


class MandateError(Exception):
    """Base class: the request could not be made or was refused outright."""

    def __init__(self, message: str, status: Optional[int] = None, body: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status = status
        self.body = body or {}


class MandateAuthError(MandateError):
    """The token is missing, unknown, or revoked."""


@dataclass
class Remedy:
    """What the agent can do about a decision that was not 'approved'."""

    message: str = ""
    retry_at: Optional[str] = None
    max_amount_now: Optional[int] = None
    approval_required: bool = False
    allowed_merchants: Optional[list] = None

    @staticmethod
    def from_dict(d: Optional[Dict[str, Any]]) -> Optional["Remedy"]:
        if not d:
            return None
        return Remedy(message=d.get("message", ""), retry_at=d.get("retryAt"), max_amount_now=d.get("maxAmountNow"),
                      approval_required=bool(d.get("approvalRequired")), allowed_merchants=d.get("allowedMerchants"))


@dataclass
class Decision:
    decision: str  # approved | declined | pending
    reason: str
    rule: str
    transaction_id: str
    approval_id: Optional[str] = None
    settlement: Optional[str] = None  # held | captured | voided | released
    hold_expires_at: Optional[str] = None
    remedy: Optional[Remedy] = None
    remaining: Dict[str, Any] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def approved(self) -> bool:
        return self.decision == "approved"

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Decision":
        return Decision(decision=d.get("decision", ""), reason=d.get("reason", ""), rule=d.get("rule", ""), transaction_id=d.get("transactionId", ""),
                        approval_id=d.get("approvalId"), settlement=d.get("settlement"), hold_expires_at=d.get("holdExpiresAt"),
                        remedy=Remedy.from_dict(d.get("remedy")), remaining=d.get("remaining") or {}, raw=d)


class MandateDeclined(MandateError):
    """The purchase was declined. `.decision.remedy` says what would pass and when."""

    def __init__(self, decision: Decision):
        super().__init__(f"declined ({decision.rule}): {decision.reason}" + (f" {decision.remedy.message}" if decision.remedy else ""))
        self.decision = decision

    @property
    def remedy(self) -> Optional[Remedy]:
        return self.decision.remedy


class MandatePending(MandateError):
    """The owner must approve. Retry the identical request (same idempotency key) after they do."""

    def __init__(self, decision: Decision):
        super().__init__(f"pending approval: {decision.reason}")
        self.decision = decision


class Mandate:
    """A client bound to one mandate token."""

    def __init__(self, token: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 15.0, user_agent: str = f"mandate-agent-python/{__version__}"):
        if not token or not token.startswith("mnd_"):
            raise MandateAuthError("A mandate token (mnd_...) is required.")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent

    # ---- HTTP ----

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> tuple[int, Dict[str, Any], Dict[str, str]]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self.token}")
        req.add_header("user-agent", self.user_agent)
        req.add_header("accept", "application/json")
        if data is not None:
            req.add_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.status, _parse(res.read()), {k.lower(): v for k, v in res.headers.items()}
        except urllib.error.HTTPError as e:
            payload = _parse(e.read())
            if e.code in (401,):
                raise MandateAuthError(payload.get("error", "Unauthorised"), e.code, payload) from None
            if e.code == 429:
                raise MandateError(payload.get("error", "Rate limited"), e.code, payload) from None
            return e.code, payload, {k.lower(): v for k, v in e.headers.items()}
        except urllib.error.URLError as e:
            raise MandateError(f"Mandate unreachable at {self.base_url}: {e.reason}") from None

    # ---- Decisions ----

    def authorize(self, amount: int, merchant: str, purpose: Optional[str] = None, category: Optional[str] = None,
                  idempotency_key: Optional[str] = None, wait_for: float = 0, poll_every: float = 5.0) -> Decision:
        """Ask before paying. Returns the Decision (approved = a hold). With wait_for > 0, a
        pending answer is polled (same idempotency key) until the owner decides or time runs out."""
        if not isinstance(amount, int) or amount <= 0:
            raise ValueError("amount must be a positive integer in minor units (1299 for 12.99)")
        body: Dict[str, Any] = {"amount": amount, "merchant": merchant}
        if purpose:
            body["purpose"] = purpose
        if category:
            body["category"] = category
        headers = {"idempotency-key": idempotency_key} if idempotency_key else {}
        deadline = time.monotonic() + wait_for
        while True:
            status, payload, _ = self._request("POST", "/api/agent/authorize", body, headers)
            if status in (200, 202, 403):
                d = Decision.from_dict(payload)
                if d.decision != "pending" or wait_for <= 0 or time.monotonic() >= deadline:
                    return d
                time.sleep(min(poll_every, max(0.0, deadline - time.monotonic())))
                continue
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)

    def capture(self, transaction_id: str, amount: Optional[int] = None, note: Optional[str] = None) -> Dict[str, Any]:
        """Record what was actually paid (defaults to the full authorised amount)."""
        body: Dict[str, Any] = {"transactionId": transaction_id}
        if amount is not None:
            body["amount"] = amount
        if note:
            body["note"] = note
        status, payload, _ = self._request("POST", "/api/agent/capture", body)
        if status != 200:
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        return payload

    def void(self, transaction_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        """Nothing was paid: release the hold."""
        body: Dict[str, Any] = {"transactionId": transaction_id}
        if reason:
            body["reason"] = reason
        status, payload, _ = self._request("POST", "/api/agent/void", body)
        if status != 200:
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        return payload

    def get(self, transaction_id: str) -> Dict[str, Any]:
        status, payload, _ = self._request("GET", f"/api/agent/transactions/{transaction_id}")
        if status != 200:
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        return payload

    def mandate(self) -> Dict[str, Any]:
        """Limits, what is left, open holds — so the agent can plan."""
        status, payload, _ = self._request("GET", "/api/agent/mandate")
        if status != 200:
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        return payload

    def propose_plan(self, title: str, items: list, wait_for: float = 0, poll_every: float = 10.0) -> Dict[str, Any]:
        """Propose a list of intended purchases for one-time approval. items: [{"merchant", "amount", "purpose"?}].
        With wait_for > 0, polls until the owner decides (status leaves 'proposed') or time runs out."""
        status, payload, _ = self._request("POST", "/api/agent/plans", {"title": title, "items": items})
        if status not in (200, 202):
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        deadline = time.monotonic() + wait_for
        while wait_for > 0 and payload.get("status") == "proposed" and time.monotonic() < deadline:
            time.sleep(min(poll_every, max(0.0, deadline - time.monotonic())))
            payload = self.get_plan(payload["planId"])
        return payload

    def get_plan(self, plan_id: str) -> Dict[str, Any]:
        status, payload, _ = self._request("GET", f"/api/agent/plans/{plan_id}")
        if status != 200:
            raise MandateError(payload.get("error", f"HTTP {status}"), status, payload)
        return payload

    def hold(self, amount: int, merchant: str, **kwargs: Any) -> "Hold":
        """Context manager: authorise on entry, capture inside, void on exit if nothing was captured."""
        return Hold(self, amount, merchant, **kwargs)


class Hold:
    def __init__(self, client: Mandate, amount: int, merchant: str, **kwargs: Any):
        self.client = client
        self.amount = amount
        self.merchant = merchant
        self.kwargs = kwargs
        self.decision: Optional[Decision] = None
        self.settled: Optional[Dict[str, Any]] = None

    def __enter__(self) -> "Hold":
        d = self.client.authorize(self.amount, self.merchant, **self.kwargs)
        self.decision = d
        if d.decision == "declined":
            raise MandateDeclined(d)
        if d.decision == "pending":
            raise MandatePending(d)
        return self

    @property
    def transaction_id(self) -> str:
        return self.decision.transaction_id if self.decision else ""

    @property
    def remedy(self) -> Optional[Remedy]:
        return self.decision.remedy if self.decision else None

    def capture(self, amount: Optional[int] = None, note: Optional[str] = None) -> Dict[str, Any]:
        self.settled = self.client.capture(self.transaction_id, amount, note)
        return self.settled

    def void(self, reason: Optional[str] = None) -> Dict[str, Any]:
        self.settled = self.client.void(self.transaction_id, reason)
        return self.settled

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self.decision and self.decision.approved and self.settled is None:
            try:
                self.void("left unsettled" if exc_type is None else f"error: {exc_type.__name__}")
            except MandateError:
                pass
        return False


def _parse(raw: bytes) -> Dict[str, Any]:
    try:
        v = json.loads(raw.decode() or "{}")
        return v if isinstance(v, dict) else {"value": v}
    except ValueError:
        return {"error": raw.decode(errors="replace")[:200]}
