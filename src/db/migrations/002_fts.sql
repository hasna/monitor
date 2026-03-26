-- Migration 002: FTS5 full-text search virtual tables + sync triggers

-- ─── machines_fts ────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS machines_fts USING fts5(
  id UNINDEXED,
  name,
  type,
  host,
  tags,
  content='machines',
  content_rowid='rowid'
);

-- Populate from existing rows
INSERT INTO machines_fts (rowid, id, name, type, host, tags)
SELECT rowid, id, name, type, COALESCE(host,''), COALESCE(tags,'')
FROM machines;

CREATE TRIGGER IF NOT EXISTS machines_fts_ai
AFTER INSERT ON machines BEGIN
  INSERT INTO machines_fts (rowid, id, name, type, host, tags)
  VALUES (new.rowid, new.id, new.name, new.type, COALESCE(new.host,''), COALESCE(new.tags,''));
END;

CREATE TRIGGER IF NOT EXISTS machines_fts_au
AFTER UPDATE ON machines BEGIN
  INSERT INTO machines_fts (machines_fts, rowid, id, name, type, host, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.type, COALESCE(old.host,''), COALESCE(old.tags,''));
  INSERT INTO machines_fts (rowid, id, name, type, host, tags)
  VALUES (new.rowid, new.id, new.name, new.type, COALESCE(new.host,''), COALESCE(new.tags,''));
END;

CREATE TRIGGER IF NOT EXISTS machines_fts_ad
AFTER DELETE ON machines BEGIN
  INSERT INTO machines_fts (machines_fts, rowid, id, name, type, host, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.type, COALESCE(old.host,''), COALESCE(old.tags,''));
END;

-- ─── alerts_fts ──────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS alerts_fts USING fts5(
  id UNINDEXED,
  machine_id,
  severity,
  check_name,
  message,
  content='alerts',
  content_rowid='id'
);

-- Populate from existing rows
INSERT INTO alerts_fts (rowid, id, machine_id, severity, check_name, message)
SELECT id, id, machine_id, severity, check_name, message FROM alerts;

CREATE TRIGGER IF NOT EXISTS alerts_fts_ai
AFTER INSERT ON alerts BEGIN
  INSERT INTO alerts_fts (rowid, id, machine_id, severity, check_name, message)
  VALUES (new.id, new.id, new.machine_id, new.severity, new.check_name, new.message);
END;

CREATE TRIGGER IF NOT EXISTS alerts_fts_au
AFTER UPDATE ON alerts BEGIN
  INSERT INTO alerts_fts (alerts_fts, rowid, id, machine_id, severity, check_name, message)
  VALUES ('delete', old.id, old.id, old.machine_id, old.severity, old.check_name, old.message);
  INSERT INTO alerts_fts (rowid, id, machine_id, severity, check_name, message)
  VALUES (new.id, new.id, new.machine_id, new.severity, new.check_name, new.message);
END;

CREATE TRIGGER IF NOT EXISTS alerts_fts_ad
AFTER DELETE ON alerts BEGIN
  INSERT INTO alerts_fts (alerts_fts, rowid, id, machine_id, severity, check_name, message)
  VALUES ('delete', old.id, old.id, old.machine_id, old.severity, old.check_name, old.message);
END;

-- ─── processes_fts ───────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS processes_fts USING fts5(
  id UNINDEXED,
  machine_id,
  name,
  cmd,
  user,
  status,
  content='processes',
  content_rowid='id'
);

-- Populate from existing rows
INSERT INTO processes_fts (rowid, id, machine_id, name, cmd, user, status)
SELECT id, id, machine_id, name, COALESCE(cmd,''), COALESCE(user,''), COALESCE(status,'')
FROM processes;

CREATE TRIGGER IF NOT EXISTS processes_fts_ai
AFTER INSERT ON processes BEGIN
  INSERT INTO processes_fts (rowid, id, machine_id, name, cmd, user, status)
  VALUES (new.id, new.id, new.machine_id, new.name, COALESCE(new.cmd,''), COALESCE(new.user,''), COALESCE(new.status,''));
END;

CREATE TRIGGER IF NOT EXISTS processes_fts_au
AFTER UPDATE ON processes BEGIN
  INSERT INTO processes_fts (processes_fts, rowid, id, machine_id, name, cmd, user, status)
  VALUES ('delete', old.id, old.id, old.machine_id, old.name, COALESCE(old.cmd,''), COALESCE(old.user,''), COALESCE(old.status,''));
  INSERT INTO processes_fts (rowid, id, machine_id, name, cmd, user, status)
  VALUES (new.id, new.id, new.machine_id, new.name, COALESCE(new.cmd,''), COALESCE(new.user,''), COALESCE(new.status,''));
END;

CREATE TRIGGER IF NOT EXISTS processes_fts_ad
AFTER DELETE ON processes BEGIN
  INSERT INTO processes_fts (processes_fts, rowid, id, machine_id, name, cmd, user, status)
  VALUES ('delete', old.id, old.id, old.machine_id, old.name, COALESCE(old.cmd,''), COALESCE(old.user,''), COALESCE(old.status,''));
END;
