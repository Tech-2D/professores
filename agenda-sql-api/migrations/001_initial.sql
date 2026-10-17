CREATE SCHEMA IF NOT EXISTS tech2d;
REVOKE ALL ON SCHEMA tech2d FROM PUBLIC;

CREATE TABLE IF NOT EXISTS tech2d.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Exact typed Firestore source, including nested collections. Never exposed by API.
CREATE TABLE IF NOT EXISTS tech2d.firestore_documents (
  project_id text NOT NULL,
  path text NOT NULL,
  fields jsonb NOT NULL,
  source_updated_at text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS tech2d.admin_profiles (
  uid text PRIMARY KEY,
  role text NOT NULL,
  turma_id text,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS tech2d.activities (
  id text PRIMARY KEY,
  turma_id text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  type text NOT NULL,
  subject text,
  date text NOT NULL,
  time text,
  created_by text,
  created_by_email text,
  recurring_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  created_at timestamptz,
  updated_at timestamptz,
  version bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS activities_class_date ON tech2d.activities(turma_id, date);
CREATE INDEX IF NOT EXISTS activities_date ON tech2d.activities(date);

-- Transition projections: preserve unknown fields privately, select public fields explicitly.
CREATE TABLE IF NOT EXISTS tech2d.catalog_documents (
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS catalog_collection_class ON tech2d.catalog_documents(collection, (data->>'turmaId'));
CREATE INDEX IF NOT EXISTS catalog_schedule_class ON tech2d.catalog_documents(collection, (data->>'className'));

CREATE TABLE IF NOT EXISTS tech2d.activity_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_id text NOT NULL,
  actor_uid text NOT NULL,
  action text NOT NULL CHECK(action IN ('create', 'update')),
  previous_data jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tech2d.schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING;
