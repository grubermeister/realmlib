-- realmlib persistence schema, version 001: durable simulation state.
--
-- Target: PostgreSQL 18. Plain DDL only, with no transaction control, so the
-- applier chooses the transaction (for example `psql --single-transaction`).
-- Nothing applies this file automatically, and it inserts no rows.
--
-- The schema range-checks values but cannot prove they are valid realmlib
-- values: JavaScript validation (including rejection of -0, which integer casts
-- and JSON.stringify() erase) must run before writing and after reading. JSON,
-- not JSONB, keeps the serialized text unchanged, including \u0000 escapes and
-- object key order. 9007199254740991 is Number.MAX_SAFE_INTEGER.

CREATE SCHEMA realmlib;

-- The one simulation managed by this schema. No defaults for the clock,
-- sequence, or random state: initialization must supply them explicitly.
CREATE TABLE realmlib.runtime_state (
  singleton_id SMALLINT NOT NULL,
  now_ms BIGINT NOT NULL,
  -- Next insertion-order number to assign to realmlib.work_items.sequence.
  next_sequence BIGINT NOT NULL,
  -- RandomSnapshot; SQL NULL means no random stream is configured.
  random_snapshot JSON,
  -- Format of the stored runtime data, not the migration number.
  format_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT runtime_state_pkey PRIMARY KEY (singleton_id),
  CONSTRAINT runtime_state_singleton_id_check CHECK (singleton_id = 1),
  CONSTRAINT runtime_state_now_ms_check CHECK (now_ms BETWEEN 0 AND 9007199254740991),
  CONSTRAINT runtime_state_next_sequence_check CHECK (next_sequence BETWEEN 0 AND 9007199254740991),
  CONSTRAINT runtime_state_random_snapshot_check CHECK (json_typeof(random_snapshot) = 'object'),
  CONSTRAINT runtime_state_format_version_check CHECK (format_version > 0)
);

-- Current committed value at each module-owned state address. JSON null is a
-- present value; an absent record has no row.
CREATE TABLE realmlib.state_records (
  module_id TEXT COLLATE "C" NOT NULL,
  record_key TEXT COLLATE "C" NOT NULL,
  value JSON NOT NULL,
  CONSTRAINT state_records_pkey PRIMARY KEY (module_id, record_key),
  CONSTRAINT state_records_module_id_check CHECK (btrim(module_id) <> ''),
  CONSTRAINT state_records_record_key_check CHECK (btrim(record_key) <> '')
);

-- Pending work and receipts of successfully completed work. Completed rows keep
-- their original request, so a work ID or sequence is never reused. A failed
-- operation leaves its item pending.
CREATE TABLE realmlib.work_items (
  work_id TEXT COLLATE "C" NOT NULL,
  at_ms BIGINT NOT NULL,
  sequence BIGINT NOT NULL,
  module_id TEXT COLLATE "C" NOT NULL,
  operation TEXT COLLATE "C" NOT NULL,
  payload_version BIGINT NOT NULL,
  payload JSON NOT NULL,
  status TEXT NOT NULL,
  completed_at_ms BIGINT,
  CONSTRAINT work_items_pkey PRIMARY KEY (work_id),
  CONSTRAINT work_items_sequence_key UNIQUE (sequence),
  CONSTRAINT work_items_work_id_check CHECK (btrim(work_id) <> ''),
  CONSTRAINT work_items_at_ms_check CHECK (at_ms BETWEEN 0 AND 9007199254740991),
  CONSTRAINT work_items_sequence_check CHECK (sequence BETWEEN 0 AND 9007199254740991),
  CONSTRAINT work_items_module_id_check CHECK (btrim(module_id) <> ''),
  CONSTRAINT work_items_operation_check CHECK (btrim(operation) <> ''),
  CONSTRAINT work_items_payload_version_check CHECK (payload_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT work_items_status_check CHECK (status IN ('pending', 'completed')),
  CONSTRAINT work_items_completed_at_ms_check CHECK (completed_at_ms BETWEEN 0 AND 9007199254740991),
  CONSTRAINT work_items_completion_check CHECK (
    (status = 'pending' AND completed_at_ms IS NULL)
    OR (status = 'completed' AND completed_at_ms IS NOT NULL)
  )
);

-- Next pending work in deterministic order: scheduled time, then insertion order.
CREATE INDEX work_items_pending_order_idx
  ON realmlib.work_items (at_ms, sequence)
  WHERE status = 'pending';
