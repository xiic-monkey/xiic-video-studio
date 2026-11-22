CREATE TABLE IF NOT EXISTS project_entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_entities_by_project ON project_entities(project_id, kind, archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_assets (
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  display_name TEXT,
  added_at TEXT NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS project_assets_by_project ON project_assets(project_id, added_at DESC, asset_id DESC);

CREATE TABLE IF NOT EXISTS asset_origins (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_ref TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS asset_origins_by_asset ON asset_origins(project_id, asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_id TEXT,
  asset_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_tasks_by_project ON media_tasks(project_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS media_tasks_request ON media_tasks(project_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS media_grants (
  token TEXT PRIMARY KEY,
  window_label TEXT NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  rendition TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_grants_by_expiry ON media_grants(expires_at);

CREATE TABLE IF NOT EXISTS subject_versions (
  subject_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, ordinal)
);
CREATE TABLE IF NOT EXISTS shot_adoptions (
  adoption_id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  payload TEXT NOT NULL,
  adopted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_reviews (
  review_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS script_revisions (
  script_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (script_id, revision)
);
CREATE TABLE IF NOT EXISTS breakdown_drafts (
  draft_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  script_id TEXT NOT NULL,
  script_revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  applied_change_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_changes (
  change_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_exports (
  export_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  timeline_id TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_previews (
  preview_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_previews_by_expiry
  ON run_previews(expires_at, consumed_at);

ALTER TABLE boards ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
