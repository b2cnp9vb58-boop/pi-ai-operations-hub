import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const patcher = path.join(root, 'deploy', 'patch-portal.py');

const LEGACY_SERVER = `#!/usr/bin/env python3
import dataclasses
import datetime
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import urllib.parse

from portal_security import (
    ChatJobStore,
    ContentLengthError,
    DUMMY_PASSWORD_RECORD,
    JobLimitError,
    LoginAttemptLimiter,
    SessionStore,
    extract_cookie,
    load_accounts,
    read_limited_length,
    valid_login_origin,
    valid_same_origin,
    verify_password,
)

CHAT_MAX_BODY = 8192
CHAT_MAX_MESSAGE = 5000
CHAT_MAX_OUTPUT = 256 * 1024

@dataclasses.dataclass(frozen=True)
class PortalConfig:
    accounts_file: str = "/etc/portal-accounts"
    chat_log_file: str = "/home/pi-control/chat.log"
    claude_command: list[str] = dataclasses.field(default_factory=lambda: [
        "/usr/local/bin/claude", "--print", "--dangerously-skip-permissions",
    ])
    claude_cwd: str = "/opt/pi-ai-operations-hub/workspace"
    claude_timeout: int = 120

class PortalHTTPServer(http.server.ThreadingHTTPServer):
    def __init__(self, address, handler, config):
        super().__init__(address, handler)
        self.config = config
        self.accounts = load_accounts(config.accounts_file)
        self.sessions = SessionStore(timeout=3600)
        self.login_limiter = LoginAttemptLimiter()
        self.chat_jobs = ChatJobStore(ttl=300, max_global=2)

class Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, status, value, headers=None):
        pass
    def _token(self):
        return "token"
    def _require_admin(self):
        return {"username": "ye", "role": "admin"}
    def _require_same_origin(self):
        return True
    def _read_body(self, maximum):
        return self.rfile.read(0)
    def _write_chat_audit(self, rid, status):
        pass

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/chat-api"):
            if not self._require_admin():
                return
            self._handle_chat_get()
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        session = self._require_admin()
        if not session:
            return
        if not self._require_same_origin():
            return
        if path.startswith("/chat-api"):
            if session["role"] != "admin":
                self._send_json(403, {"error": "admin role required"})
                return
            self._handle_chat_post()
            return
        self._send_json(404, {"error": "not found"})

    def _handle_chat_get(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        rid = query.get("rid", [None])[0]
        if not rid:
            self._send_json(200, {"reply": "ready"})
            return
        result = self.server.chat_jobs.poll(rid, self._token())
        self._send_json(200, result)

    def _claude_environment(self):
        return {key: value for key, value in os.environ.items()}

    def _handle_chat_post(self):
        raw = self._read_body(CHAT_MAX_BODY)
        value = json.loads(raw.decode("utf-8"))
        message = value["message"].strip()
        owner_token = self._token()
        rid = self.server.chat_jobs.create(owner_token)
        def run_claude():
            with tempfile.TemporaryFile() as output:
                subprocess.run(
                    [*self.server.config.claude_command, message],
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    timeout=self.server.config.claude_timeout,
                )
            self.server.chat_jobs.finish(rid, owner_token, "reply")
        threading.Thread(target=run_claude, daemon=True).start()
        self._send_json(202, {"status": "processing", "rid": rid})

    def log_message(self, _format, *_args):
        return
`;

const LEGACY_CHAT = `<!DOCTYPE html><html><body>
<input id="input"><button id="send-btn" onclick="send()">send</button><div id="chat"></div>
<script>
  async function send() {
    var input = document.getElementById('input');
    var btn = document.getElementById('send-btn');
    var msg = input.value.trim();
    if (!msg) return;
    var resp = await fetch('/chat-api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    var data = await resp.json();
    var rid = data.rid;
    for (var i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      var pollResp = await fetch('/chat-api?rid=' + rid, { method: 'GET' });
      if ((await pollResp.json()).reply) break;
    }
  }

  function addMsg(type, text) { return document.createElement('div'); }
</script></body></html>
`;

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-portal-patch-'));
  const server = path.join(directory, 'server.py');
  const chat = path.join(directory, 'chat.html');
  writeFileSync(server, LEGACY_SERVER);
  writeFileSync(chat, LEGACY_CHAT);
  return { directory, server, chat };
}

test('known live legacy portal migrates to all four core-backed routes and is byte-idempotent', () => {
  const f = fixture();
  try {
    execFileSync('python', [patcher, f.server, f.chat], { cwd: root });
    const firstServer = readFileSync(f.server, 'utf8');
    const firstChat = readFileSync(f.chat, 'utf8');
    assert.match(firstServer, /PiControlClient, PortalChatApi, PortalRequestError/);
    assert.match(firstServer, /self\.chat_api = PortalChatApi\(PiControlClient\.from_environment\(\)\)/);
    assert.match(firstServer, /self\.server\.chat_api\.submit/);
    assert.match(firstServer, /self\.server\.chat_api\.poll/);
    assert.match(firstServer, /self\.server\.chat_api\.history/);
    assert.match(firstServer, /self\.server\.chat_api\.cancel/);
    assert.doesNotMatch(firstServer, /subprocess\.run|dangerously-skip-permissions|ChatJobStore/);
    assert.match(firstChat, /<script src="\/desktop\/chat-page\.patch\.js"><\/script>/);
    assert.match(firstChat, /PiSharedChat\.createPendingMessage/);
    assert.match(firstChat, /PiSharedChat\.listPendingMessages/);
    assert.match(firstChat, /PiSharedChat\.sendMessage/);
    assert.match(firstChat, /PiSharedChat\.retryPendingMessage/);
    assert.match(firstChat, /PiSharedChat\.pollTask/);
    assert.match(firstChat, /PiSharedChat\.cancelTask/);
    assert.match(firstChat, /piResumePending/);
    assert.doesNotMatch(firstChat, /crypto\.randomUUID\(\)/);
    assert.doesNotMatch(firstChat, /JSON\.stringify\(\{ message: msg \}\)/);
    assert.match(firstServer, /PI_CONTROL_MANAGED sha256=[a-f0-9]{64}/);
    assert.match(firstChat, /PI_CONTROL_MANAGED sha256=[a-f0-9]{64}/);
    execFileSync('python', [patcher, f.server, f.chat], { cwd: root });
    assert.equal(readFileSync(f.server, 'utf8'), firstServer);
    assert.equal(readFileSync(f.chat, 'utf8'), firstChat);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

class MemorySessionStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

async function loadMigratedOutbox(chatSource, storage) {
  const match = chatSource.match(/<script src="\/desktop\/(chat-page\.patch\.js)"><\/script>/);
  assert.ok(match, 'migrated legacy chat must load the durable outbox script');
  globalThis.window = {};
  globalThis.document = { querySelector: () => ({ content: 'csrf' }) };
  globalThis.sessionStorage = storage;
  const moduleUrl = pathToFileURL(path.join(root, 'portal', match[1])).href;
  await import(`${moduleUrl}?migration=${Date.now()}-${Math.random()}`);
  return globalThis.window.PiSharedChat;
}

test('migrated legacy chat keeps one rid across lost response reload and retry', async () => {
  const f = fixture();
  try {
    execFileSync('python', [patcher, f.server, f.chat], { cwd: root });
    const migrated = readFileSync(f.chat, 'utf8');
    const storage = new MemorySessionStorage();
    const rids = [];
    let disconnected = true;
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      rids.push(payload.rid);
      if (disconnected) {
        disconnected = false;
        throw new TypeError('response disconnected');
      }
      return new Response(JSON.stringify({ status: 'accepted', rid: payload.rid, taskId: 'task-1' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      });
    };
    let chat = await loadMigratedOutbox(migrated, storage);
    const pending = chat.createPendingMessage('same logical message');
    await assert.rejects(chat.sendMessage(pending), /disconnected/);
    assert.deepEqual(chat.listPendingMessages(), [pending]);
    chat = await loadMigratedOutbox(migrated, storage);
    await chat.retryPendingMessage(pending.rid);
    assert.deepEqual(rids, [pending.rid, pending.rid]);
    assert.deepEqual(chat.listPendingMessages(), []);
    assert.notEqual(chat.createPendingMessage('next message').rid, pending.rid);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('legacy structure drift fails before either portal file changes', () => {
  const f = fixture();
  try {
    writeFileSync(f.server, LEGACY_SERVER.replace('self._handle_chat_post()', 'self._handle_chat_post_v2()'));
    const beforeServer = readFileSync(f.server, 'utf8');
    const beforeChat = readFileSync(f.chat, 'utf8');
    const result = spawnSync('python', [patcher, f.server, f.chat], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.server, 'utf8'), beforeServer);
    assert.equal(readFileSync(f.chat, 'utf8'), beforeChat);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
