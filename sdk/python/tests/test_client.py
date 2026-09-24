import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from mandate_agent import Mandate, MandateDeclined, MandatePending, MandateAuthError
from mandate_agent.tools import dispatch, openai_tools


class Stub(BaseHTTPRequestHandler):
    calls = []
    pending_left = 0

    def log_message(self, *a):  # quiet
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Stub.calls.append(("GET", self.path, None, {k.lower(): v for k, v in self.headers.items()}))
        if self.headers.get("authorization") != "Bearer mnd_test":
            return self._send(401, {"error": "Unknown mandate token."})
        if self.path == "/api/agent/mandate":
            return self._send(200, {"mandate": "M", "remaining": {"today": 5000}})
        return self._send(200, {"transactionId": self.path.rsplit("/", 1)[-1], "settlement": "captured"})

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        Stub.calls.append(("POST", self.path, body, {k.lower(): v for k, v in self.headers.items()}))
        if self.headers.get("authorization") != "Bearer mnd_test":
            return self._send(401, {"error": "Unknown mandate token."})
        if self.path == "/api/agent/authorize":
            if body["amount"] > 5000:
                return self._send(403, {"decision": "declined", "rule": "per_txn", "reason": "too big", "transactionId": "t1", "remedy": {"message": "Split it.", "maxAmountNow": 5000}})
            if body["merchant"] == "Slow":
                if Stub.pending_left > 0:
                    Stub.pending_left -= 1
                    return self._send(202, {"decision": "pending", "rule": "approval", "reason": "ask", "transactionId": "t2", "approvalId": "a1", "remedy": {"approvalRequired": True, "message": "wait"}})
                return self._send(200, {"decision": "approved", "rule": "allowance", "reason": "ok", "transactionId": "t2", "settlement": "held"})
            return self._send(200, {"decision": "approved", "rule": "limits", "reason": "ok", "transactionId": "t3", "settlement": "held", "holdExpiresAt": "2026-01-01T00:00:00Z"})
        if self.path == "/api/agent/capture":
            return self._send(200, {"transactionId": body["transactionId"], "settlement": "captured", "capturedAmount": body.get("amount", 1000), "released": 0})
        if self.path == "/api/agent/void":
            return self._send(200, {"transactionId": body["transactionId"], "settlement": "voided"})
        return self._send(404, {"error": "no"})


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Stub.calls = []
        Stub.pending_left = 0
        self.m = Mandate("mnd_test", base_url=self.base)

    def test_token_required(self):
        with self.assertRaises(MandateAuthError):
            Mandate("nope")
        with self.assertRaises(MandateAuthError):
            Mandate("mnd_wrong", base_url=self.base).mandate()

    def test_authorize_and_capture(self):
        d = self.m.authorize(1299, "OpenAI", purpose="credits", idempotency_key="k1")
        self.assertTrue(d.approved)
        self.assertEqual(d.settlement, "held")
        self.assertEqual(Stub.calls[-1][3]["idempotency-key"], "k1")
        r = self.m.capture(d.transaction_id, 1199, note="order 1")
        self.assertEqual(r["capturedAmount"], 1199)

    def test_declined_has_remedy(self):
        d = self.m.authorize(9000, "OpenAI")
        self.assertEqual(d.decision, "declined")
        self.assertEqual(d.remedy.max_amount_now, 5000)
        with self.assertRaises(MandateDeclined) as cm:
            with self.m.hold(9000, "OpenAI"):
                pass
        self.assertEqual(cm.exception.remedy.max_amount_now, 5000)

    def test_hold_voids_when_left_unsettled_or_on_error(self):
        with self.m.hold(100, "OpenAI") as h:
            pass
        self.assertEqual(Stub.calls[-1][1], "/api/agent/void")
        self.assertEqual(Stub.calls[-1][2]["reason"], "left unsettled")
        with self.assertRaises(RuntimeError):
            with self.m.hold(100, "OpenAI") as h:
                raise RuntimeError("checkout failed")
        self.assertEqual(Stub.calls[-1][1], "/api/agent/void")
        with self.m.hold(100, "OpenAI") as h:
            h.capture(90)
        self.assertEqual(Stub.calls[-1][1], "/api/agent/capture")

    def test_pending_waits_then_approves(self):
        Stub.pending_left = 2
        d = self.m.authorize(100, "Slow", idempotency_key="k2", wait_for=5, poll_every=0.01)
        self.assertTrue(d.approved)
        self.assertEqual(len([c for c in Stub.calls if c[1] == "/api/agent/authorize"]), 3)
        Stub.pending_left = 100
        with self.assertRaises(MandatePending):
            with self.m.hold(100, "Slow"):
                pass

    def test_tools(self):
        names = [t["function"]["name"] for t in openai_tools()]
        self.assertEqual(names, ["check_mandate", "request_purchase", "capture_purchase", "void_purchase"])
        r = dispatch(self.m, "request_purchase", json.dumps({"amount": 100, "merchant": "OpenAI"}))
        self.assertEqual(r["decision"], "approved")
        self.assertEqual(dispatch(self.m, "check_mandate", "{}")["mandate"], "M")


if __name__ == "__main__":
    unittest.main()
