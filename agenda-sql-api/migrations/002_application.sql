-- Application data is separate from the immutable, typed migration archive.
CREATE TABLE IF NOT EXISTS tech2d.app_documents (
  path text PRIMARY KEY,
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data) = 'object'),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_documents_collection ON tech2d.app_documents(collection,id);
CREATE INDEX IF NOT EXISTS app_documents_class ON tech2d.app_documents(collection,(data->>'turmaId'));
CREATE INDEX IF NOT EXISTS app_documents_author ON tech2d.app_documents(collection,(data->>'createdBy'));
CREATE TABLE IF NOT EXISTS tech2d.app_commits (
  id text PRIMARY KEY,
  actor text NOT NULL,
  digest text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tech2d.app_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  path text NOT NULL,
  operation text NOT NULL,
  previous_data jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tech2d.migration_state (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  application_seeded boolean NOT NULL DEFAULT false,
  production_enabled boolean NOT NULL DEFAULT false,
  source_exported_at timestamptz
);
INSERT INTO tech2d.migration_state(id) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO tech2d.schema_migrations(version) VALUES('002_application') ON CONFLICT DO NOTHING;
