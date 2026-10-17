-- Keep pre-reconciliation source versions, including deletions; never erase the only backup.
CREATE TABLE IF NOT EXISTS tech2d.source_revisions (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL,
  path text NOT NULL,
  fields jsonb NOT NULL,
  source_updated_at text,
  reason text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON tech2d.source_revisions FROM PUBLIC;
INSERT INTO tech2d.schema_migrations(version) VALUES('003_source_revisions') ON CONFLICT DO NOTHING;
