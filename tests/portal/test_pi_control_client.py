import json
from pathlib import Path
import tempfile
import unittest

from portal.pi_control_client import PiControlClient, PiControlError


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.responses = []

    def queue(self, status, payload):
        self.responses.append((status, payload))

    def request(self, method, url, headers, body=None, timeout=None):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body, "timeout": timeout})
        return self.responses.pop(0)


class PiControlClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.client = PiControlClient("http://127.0.0.1:4330", "w" * 32, transport=self.transport)

    def test_submit_uses_web_key_preserves_actor_and_is_idempotent(self):
        self.transport.queue(202, {"data": {"taskId": "task-1", "state": "queued", "eventCursor": 1}})
        result = self.client.submit_message(request_id="r1", username="ye", text="check")
        call = self.transport.calls[-1]
        self.assertEqual(call["headers"]["X-Pi-Control-Key"], "w" * 32)
        self.assertEqual(call["body"]["channel"], "web")
        self.assertEqual(call["body"]["requestId"], "portal:ye:r1")
        self.assertEqual(result["taskId"], "task-1")

    def test_poll_history_and_cancel_use_stable_core_contracts(self):
        self.transport.queue(200, {"data": {"taskId": "task-1", "state": "running", "cancelRequested": False}})
        self.assertEqual(self.client.poll_task("task-1")["state"], "running")
        self.transport.queue(200, {"data": {"events": [{"sequence": 3, "body": "ok"}], "eventCursor": 3}})
        history = self.client.list_events(after=2, limit=10)
        self.assertEqual(history["eventCursor"], 3)
        self.transport.queue(202, {"data": {"taskId": "task-1", "state": "cancelling", "runnerCancellation": "signalled"}})
        self.assertEqual(self.client.cancel_task("task-1")["state"], "cancelling")
        self.assertEqual([call["method"] for call in self.transport.calls], ["GET", "GET", "POST"])

    def test_non_loopback_core_and_wrong_response_fail_closed_without_leaking_key(self):
        with self.assertRaises(ValueError):
            PiControlClient("https://example.com", "w" * 32, transport=self.transport)
        self.transport.queue(401, {"error": {"code": "unauthorized"}})
        with self.assertRaises(PiControlError) as caught:
            self.client.submit_message(request_id="r2", username="ye", text="x")
        self.assertNotIn("w" * 32, str(caught.exception))

    def test_environment_factory_reads_only_the_fixed_loopback_web_adapter_file(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "web-client.env"
            filename.write_text(
                "PI_CONTROL_CORE_URL=http://127.0.0.1:4330\n"
                f"PI_CONTROL_WEB_KEY={'k' * 32}\n",
                encoding="utf-8",
            )
            client = PiControlClient.from_environment(
                {"PI_CONTROL_WEB_ENV": str(filename)}, transport=self.transport
            )
            self.assertEqual(client.core_url, "http://127.0.0.1:4330")
            self.assertEqual(client._key, "k" * 32)


if __name__ == "__main__":
    unittest.main()
