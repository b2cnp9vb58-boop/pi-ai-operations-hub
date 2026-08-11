"""Loopback-only adapter from the authenticated portal to the shared control core."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen


class PiControlError(RuntimeError):
    pass


class PortalRequestError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class _UrllibTransport:
    def request(self, method, url, headers, body=None, timeout=None):
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                parsed = json.loads(error.read().decode("utf-8"))
            except Exception:
                parsed = {"error": {"code": "core_http_error"}}
            return error.code, parsed
        except (URLError, TimeoutError, OSError) as error:
            raise PiControlError("control core is unavailable") from error


class PiControlClient:
    @classmethod
    def from_environment(cls, env=None, transport=None, timeout=10):
        values = os.environ if env is None else env
        filename = values.get("PI_CONTROL_WEB_ENV", "/etc/pi-control/web-client.env")
        parsed = {}
        for line in Path(filename).read_text(encoding="utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            if not separator or name not in {"PI_CONTROL_CORE_URL", "PI_CONTROL_WEB_KEY"} or name in parsed:
                raise ValueError("invalid web client environment file")
            parsed[name] = value
        if set(parsed) != {"PI_CONTROL_CORE_URL", "PI_CONTROL_WEB_KEY"}:
            raise ValueError("incomplete web client environment file")
        return cls(parsed["PI_CONTROL_CORE_URL"], parsed["PI_CONTROL_WEB_KEY"], transport=transport, timeout=timeout)

    def __init__(self, core_url, web_client_key, transport=None, timeout=10):
        parsed = urlparse(core_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != 4330 or parsed.path not in ("", "/"):
            raise ValueError("control core must be fixed loopback http://127.0.0.1:4330")
        if not isinstance(web_client_key, str) or len(web_client_key) < 32:
            raise ValueError("web client key is invalid")
        self.core_url = "http://127.0.0.1:4330"
        self._key = web_client_key
        self._transport = transport or _UrllibTransport()
        self._timeout = timeout

    def _request(self, method, path, body=None, expected=(200,)):
        headers = {"Accept": "application/json", "X-Pi-Control-Key": self._key}
        if body is not None:
            headers["Content-Type"] = "application/json"
        status, payload = self._transport.request(method, self.core_url + path, headers, body=body, timeout=self._timeout)
        if status not in expected or not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
            code = payload.get("error", {}).get("code", "invalid_core_response") if isinstance(payload, dict) else "invalid_core_response"
            raise PiControlError(f"control core rejected request: {code}")
        return payload["data"]

    def submit_message(self, *, request_id, username, text, attachments=None):
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            raise ValueError("invalid request id")
        if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", username):
            raise ValueError("invalid portal actor")
        if not isinstance(text, str) or not text:
            raise ValueError("message text is required")
        return self._request("POST", "/v1/messages", {
            "requestId": f"portal:{username}:{request_id}", "channel": "web", "text": text,
            "attachments": [] if attachments is None else attachments,
        }, expected=(202,))

    def poll_task(self, task_id):
        return self._request("GET", f"/v1/tasks/{quote(self._task_id(task_id), safe='')}")

    def list_events(self, *, after=0, limit=100):
        if not isinstance(after, int) or after < 0 or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("invalid history cursor")
        return self._request("GET", "/v1/events?" + urlencode({"after": after, "limit": limit}))

    def cancel_task(self, task_id):
        return self._request("POST", f"/v1/tasks/{quote(self._task_id(task_id), safe='')}/cancel", {}, expected=(202,))

    @staticmethod
    def _task_id(task_id):
        if not isinstance(task_id, str) or not task_id or len(task_id) > 128:
            raise ValueError("invalid task id")
        return task_id


class PortalChatApi:
    """Framework-neutral `/chat-api` contract; the existing server keeps session/origin checks."""

    def __init__(self, client):
        self.client = client
        self._tasks = {}

    @staticmethod
    def _actor(session):
        if not isinstance(session, dict) or session.get("authenticated") is not True or session.get("is_admin") is not True:
            raise PortalRequestError(401, "administrator session required")
        username = session.get("username")
        if not isinstance(username, str) or not username:
            raise PortalRequestError(401, "administrator session required")
        return username

    @staticmethod
    def _same_origin(ok):
        if ok is not True:
            raise PortalRequestError(403, "invalid request origin")

    @staticmethod
    def _csrf(ok):
        if ok is not True:
            raise PortalRequestError(403, "invalid CSRF token")

    def submit(self, *, session, same_origin, csrf_valid, payload):
        username = self._actor(session)
        self._same_origin(same_origin)
        self._csrf(csrf_valid)
        if not isinstance(payload, dict) or set(payload) != {"rid", "text"}:
            raise PortalRequestError(400, "invalid chat payload")
        key = (username, payload["rid"])
        existed = key in self._tasks
        result = self.client.submit_message(request_id=payload["rid"], username=username, text=payload["text"])
        self._tasks[(username, payload["rid"])] = result["taskId"]
        return {"status": "existing" if existed else "accepted", "rid": payload["rid"], "taskId": result["taskId"]}

    def poll(self, *, session, same_origin, rid):
        username = self._actor(session)
        self._same_origin(same_origin)
        task_id = self._tasks.get((username, rid))
        if not task_id:
            raise PortalRequestError(404, "unknown request id")
        return {"rid": rid, **self.client.poll_task(task_id)}

    def history(self, *, session, same_origin, after=0):
        self._actor(session)
        self._same_origin(same_origin)
        return self.client.list_events(after=after)

    def cancel(self, *, session, same_origin, csrf_valid, rid):
        username = self._actor(session)
        self._same_origin(same_origin)
        self._csrf(csrf_valid)
        task_id = self._tasks.get((username, rid))
        if not task_id:
            raise PortalRequestError(404, "unknown request id")
        return {"rid": rid, **self.client.cancel_task(task_id)}
