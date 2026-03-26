-- Migration 003: Agents table for agent coordination support

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  metadata    TEXT    NOT NULL DEFAULT '{}',   -- JSON object
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  focus       TEXT,                             -- machine_id or check name agent is focused on
  registered_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen DESC);
