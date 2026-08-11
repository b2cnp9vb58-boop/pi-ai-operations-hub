from pathlib import Path
import unittest
from portal.pi_control_client import PiControlError, PortalChatApi, PortalRequestError


ROOT = Path(__file__).resolve().parents[2]


class ChatContractTests(unittest.TestCase):
    def test_browser_patch_uses_portal_session_same_origin_history_cursor_and_text_only_rendering(self):
        source = (ROOT / "portal" / "chat-page.patch.js").read_text(encoding="utf-8")
        self.assertIn("credentials: 'same-origin'", source)
        self.assertIn("/chat-api/history?after=", source)
        self.assertIn("textContent", source)
        self.assertNotIn("innerHTML", source)
        self.assertNotIn("X-Pi-Control-Key", source)
        self.assertNotIn("adminClientKey", source)
        self.assertIn("encodeURIComponent", source)
        self.assertIn("setTimeout", source)

    def test_browser_patch_posts_only_to_authenticated_chat_api_with_csrf_header(self):
        source = (ROOT / "portal" / "chat-page.patch.js").read_text(encoding="utf-8")
        self.assertIn("'/chat-api'", source)
        self.assertIn("X-CSRF-Token", source)
        self.assertIn("X-Requested-With", source)
        self.assertNotIn("127.0.0.1:4330", source)

    def test_server_adapter_preserves_admin_session_origin_csrf_and_shared_task(self):
        class Core:
            def submit_message(self, **values):
                self.submitted = values
                return {"taskId": "task-1", "state": "queued"}
            def poll_task(self, task_id): return {"taskId": task_id, "state": "running"}
            def list_events(self, **_values): return {"events": [], "eventCursor": 0}
            def cancel_task(self, task_id): return {"taskId": task_id, "state": "cancelling"}
        core = Core()
        api = PortalChatApi(core)
        admin = {"authenticated": True, "is_admin": True, "username": "ye"}
        submitted = api.submit(session=admin, same_origin=True, csrf_valid=True, payload={"rid": "r1", "text": "check"})
        self.assertEqual(submitted, {"status": "accepted", "rid": "r1", "taskId": "task-1"})
        repeated = api.submit(session=admin, same_origin=True, csrf_valid=True,
                              payload={"rid": "r1", "text": "check"})
        self.assertEqual(repeated, {"status": "existing", "rid": "r1", "taskId": "task-1"})
        self.assertEqual(api.poll(session=admin, same_origin=True, rid="r1")["state"], "running")
        self.assertEqual(api.cancel(session=admin, same_origin=True, csrf_valid=True, rid="r1")["state"], "cancelling")
        for kwargs in [
            {"session": {}, "same_origin": True, "csrf_valid": True},
            {"session": admin, "same_origin": False, "csrf_valid": True},
            {"session": admin, "same_origin": True, "csrf_valid": False},
        ]:
            with self.assertRaises(PortalRequestError):
                api.submit(payload={"rid": "blocked", "text": "x"}, **kwargs)

    def test_retry_after_lost_accepted_response_reuses_request_id_and_one_core_task(self):
        class DeduplicatingCore:
            def __init__(self):
                self.tasks = {}
                self.request_ids = []
                self.lose_first_response = True

            def submit_message(self, **values):
                request_id = values["request_id"]
                self.request_ids.append(request_id)
                task_id = self.tasks.setdefault(request_id, f"task-{len(self.tasks) + 1}")
                if self.lose_first_response:
                    self.lose_first_response = False
                    raise PiControlError("response lost")
                return {"taskId": task_id, "state": "queued"}

        core = DeduplicatingCore()
        api = PortalChatApi(core)
        admin = {"authenticated": True, "is_admin": True, "username": "ye"}
        request = dict(session=admin, same_origin=True, csrf_valid=True,
                       payload={"rid": "stable-rid", "text": "check"})

        with self.assertRaises(PiControlError):
            api.submit(**request)
        accepted = api.submit(**request)

        self.assertEqual(accepted["taskId"], "task-1")
        self.assertEqual(core.request_ids, ["stable-rid", "stable-rid"])
        self.assertEqual(len(core.tasks), 1)


if __name__ == "__main__":
    unittest.main()
