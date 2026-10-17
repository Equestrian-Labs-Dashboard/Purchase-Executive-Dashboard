CREATE TABLE IF NOT EXISTS purchase_plans (
  month TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
