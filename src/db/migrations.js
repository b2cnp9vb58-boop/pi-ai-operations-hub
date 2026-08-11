export const MIGRATION_1 = `
PRAGMA foreign_keys=ON;
CREATE TABLE messages(id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK(channel IN ('telegram','web','system')),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  body TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY, source TEXT NOT NULL, request_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_confirmation','cancelling','completed','failed','interrupted')),
  claude_session_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_summary TEXT);
CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE telegram_updates(update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL);
CREATE TABLE approvals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','granted','consumed','expired','cancelled')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE attachments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);
CREATE TABLE owner_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL, paired_at TEXT NOT NULL);
CREATE TABLE pairing_requests(code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE memory_snapshots(id TEXT PRIMARY KEY, source_file TEXT NOT NULL, sha256 TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
PRAGMA user_version=1;`;

export const MIGRATION_2 = `
CREATE TABLE conversation_summaries(
  id TEXT PRIMARY KEY,
  through_sequence INTEGER NOT NULL UNIQUE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
INSERT INTO messages_fts(rowid, body) SELECT rowid, body FROM messages;
PRAGMA user_version=2;`;

export const MIGRATION_3 = `
CREATE TABLE approvals_v3(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','granted','consumed','expired','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
INSERT INTO approvals_v3(id, task_id, owner_id, operation_hash, state, expires_at, created_at, consumed_at)
SELECT id, task_id, '', operation_hash,
  CASE WHEN state IN ('pending', 'granted') THEN 'cancelled' ELSE state END,
  expires_at, created_at, consumed_at
FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_v3 RENAME TO approvals;
CREATE TABLE approval_security(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  locked_until TEXT
);
INSERT INTO approval_security(singleton, failed_attempts, locked_until) VALUES (1, 0, NULL);
PRAGMA user_version=3;`;

export const MIGRATION_4 = `
CREATE TABLE deferred_tool_calls(
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting_action','waiting_password','approved','consumed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, tool_use_id)
);
PRAGMA user_version=4;`;

export const MIGRATION_5 = `
CREATE TABLE tool_batches(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  tool_count INTEGER NOT NULL CHECK(tool_count >= 1),
  service_instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('registered','invalid')),
  created_at TEXT NOT NULL,
  UNIQUE(task_id, session_id, generation)
);
CREATE TABLE tool_batch_items(
  batch_id TEXT NOT NULL REFERENCES tool_batches(id),
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  PRIMARY KEY(batch_id, tool_use_id)
);
PRAGMA user_version=5;`;

export const MIGRATION_6 = `
ALTER TABLE tasks ADD COLUMN worker_id TEXT;
ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT;
ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT;
ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
CREATE INDEX tasks_active_lease ON tasks(state, lease_expires_at);
PRAGMA user_version=6;`;

export const MIGRATION_7 = `
CREATE TABLE weixin_updates(
  update_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE weixin_owner_binding(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  user_id TEXT NOT NULL,
  paired_at TEXT NOT NULL
);
CREATE TABLE weixin_pairing_requests(
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version=7;`;

export const MIGRATION_8 = `
DROP TRIGGER IF EXISTS messages_fts_insert;
DROP TRIGGER IF EXISTS messages_fts_delete;
DROP TRIGGER IF EXISTS messages_fts_update;
DROP TABLE IF EXISTS messages_fts;
CREATE TABLE messages_v8(id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK(channel IN ('telegram','web','system','weixin')),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  body TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL);
INSERT INTO messages_v8(id, sequence, channel, role, body, task_id, created_at)
  SELECT id, sequence, channel, role, body, task_id, created_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_v8 RENAME TO messages;
CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
INSERT INTO messages_fts(rowid, body) SELECT rowid, body FROM messages;
PRAGMA user_version=8;`;
