-- Migration 004: Feedback table

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT    NOT NULL CHECK(source IN ('agent','user')),
  rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  message    TEXT    NOT NULL,
  metadata   TEXT    NOT NULL DEFAULT '{}',  -- JSON object
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);
