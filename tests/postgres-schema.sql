-- Assertions for migrations/001_initial_persistence.sql.
--
-- Run by tests/postgres-schema.test.ts inside a transaction that has just
-- applied the migration and is rolled back afterwards. Every failure raises an
-- error, which stops psql (ON_ERROR_STOP) with a nonzero exit status.
-- Rejection cases run in PL/pgSQL exception blocks, whose implicit savepoints
-- undo each rejected statement.

-- Schema isolation: exactly the three tables and the one explicit index, plus
-- the indexes backing primary keys and the sequence unique constraint.
DO $$
DECLARE
  objects text;
BEGIN
  SELECT string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname) INTO objects
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'realmlib';
  IF objects IS DISTINCT FROM
    'runtime_state:r,runtime_state_pkey:i,state_records:r,state_records_pkey:i,'
    'work_items:r,work_items_pending_order_idx:i,work_items_pkey:i,work_items_sequence_key:i'
  THEN
    RAISE EXCEPTION 'unexpected realmlib objects: %', objects;
  END IF;
  IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'realmlib')
    OR EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'realmlib' AND t.typrelid = 0 AND t.typelem = 0)
    OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n
               ON n.oid = c.relnamespace WHERE n.nspname = 'realmlib'))
  THEN
    RAISE EXCEPTION 'migration created functions, types, or triggers';
  END IF;
  IF pg_get_indexdef('realmlib.work_items_pending_order_idx'::regclass) <>
    'CREATE INDEX work_items_pending_order_idx ON realmlib.work_items USING btree (at_ms, sequence) WHERE (status = ''pending''::text)'
  THEN
    RAISE EXCEPTION 'unexpected queue index: %', pg_get_indexdef('realmlib.work_items_pending_order_idx'::regclass);
  END IF;
END $$;

-- Each case must fail with the given SQLSTATE and, when given, constraint name.
-- 23502 not_null_violation, 23505 unique_violation, 23514 check_violation.
-- An unsupported status also fails work_items_completion_check, and PostgreSQL
-- reports whichever check it evaluates first, so those cases omit the name.
DO $$
DECLARE
  c record;
  actual_constraint text;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    -- runtime_state
    ('runtime: second identity',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (2, 0, 0)$q$,
      '23514', 'runtime_state_singleton_id_check'),
    ('runtime: missing now_ms',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, next_sequence) VALUES (1, 0)$q$, '23502', NULL),
    ('runtime: missing next_sequence',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms) VALUES (1, 0)$q$, '23502', NULL),
    ('runtime: negative now_ms',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, -1, 0)$q$,
      '23514', 'runtime_state_now_ms_check'),
    ('runtime: now_ms above safe range',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, 9007199254740992, 0)$q$,
      '23514', 'runtime_state_now_ms_check'),
    ('runtime: negative next_sequence',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, 0, -1)$q$,
      '23514', 'runtime_state_next_sequence_check'),
    ('runtime: next_sequence above safe range',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, 0, 9007199254740992)$q$,
      '23514', 'runtime_state_next_sequence_check'),
    ('runtime: array snapshot',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence, random_snapshot) VALUES (1, 0, 0, '[1, 2, 3, 4]')$q$,
      '23514', 'runtime_state_random_snapshot_check'),
    ('runtime: JSON null snapshot',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence, random_snapshot) VALUES (1, 0, 0, 'null')$q$,
      '23514', 'runtime_state_random_snapshot_check'),
    ('runtime: string snapshot',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence, random_snapshot) VALUES (1, 0, 0, '"xoshiro128ss-v1"')$q$,
      '23514', 'runtime_state_random_snapshot_check'),
    ('runtime: zero format_version',
      $q$INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence, format_version) VALUES (1, 0, 0, 0)$q$,
      '23514', 'runtime_state_format_version_check'),

    -- state_records
    ('state: empty module_id',
      $q$INSERT INTO realmlib.state_records VALUES ('', 'k', '1')$q$, '23514', 'state_records_module_id_check'),
    ('state: space-only module_id',
      $q$INSERT INTO realmlib.state_records VALUES ('   ', 'k', '1')$q$, '23514', 'state_records_module_id_check'),
    ('state: empty record_key',
      $q$INSERT INTO realmlib.state_records VALUES ('m', '', '1')$q$, '23514', 'state_records_record_key_check'),
    ('state: space-only record_key',
      $q$INSERT INTO realmlib.state_records VALUES ('m', '  ', '1')$q$, '23514', 'state_records_record_key_check'),
    ('state: SQL NULL value',
      $q$INSERT INTO realmlib.state_records VALUES ('m', 'k-null', NULL)$q$, '23502', NULL),
    ('state: SQL NULL module_id',
      $q$INSERT INTO realmlib.state_records VALUES (NULL, 'k', '1')$q$, '23502', NULL),

    -- work_items
    ('work: empty work_id',
      $q$INSERT INTO realmlib.work_items VALUES ('', 0, 100, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_work_id_check'),
    ('work: space-only work_id',
      $q$INSERT INTO realmlib.work_items VALUES (' ', 0, 100, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_work_id_check'),
    ('work: blank module_id',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, ' ', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_module_id_check'),
    ('work: blank operation',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', '', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_operation_check'),
    ('work: negative at_ms',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', -1, 100, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_at_ms_check'),
    ('work: at_ms above safe range',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 9007199254740992, 100, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_at_ms_check'),
    ('work: negative sequence',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, -1, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_sequence_check'),
    ('work: sequence above safe range',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 9007199254740992, 'm', 'op', 1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_sequence_check'),
    ('work: zero payload_version',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 0, '1', 'pending', NULL)$q$,
      '23514', 'work_items_payload_version_check'),
    ('work: negative payload_version',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', -1, '1', 'pending', NULL)$q$,
      '23514', 'work_items_payload_version_check'),
    ('work: payload_version above safe range',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 9007199254740992, '1', 'pending', NULL)$q$,
      '23514', 'work_items_payload_version_check'),
    ('work: SQL NULL payload',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, NULL, 'pending', NULL)$q$, '23502', NULL),
    ('work: unsupported status',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'failed', NULL)$q$,
      '23514', NULL),
    ('work: status differs in case',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'Pending', NULL)$q$,
      '23514', NULL),
    ('work: missing status',
      $q$INSERT INTO realmlib.work_items (work_id, at_ms, sequence, module_id, operation, payload_version, payload)
         VALUES ('w-x', 0, 100, 'm', 'op', 1, '1')$q$, '23502', NULL),
    ('work: pending with completion time',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'pending', 5)$q$,
      '23514', 'work_items_completion_check'),
    ('work: completed without completion time',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'completed', NULL)$q$,
      '23514', 'work_items_completion_check'),
    ('work: negative completion time',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'completed', -1)$q$,
      '23514', 'work_items_completed_at_ms_check'),
    ('work: completion time above safe range',
      $q$INSERT INTO realmlib.work_items VALUES ('w-x', 0, 100, 'm', 'op', 1, '1', 'completed', 9007199254740992)$q$,
      '23514', 'work_items_completed_at_ms_check')
  ) AS t(label, statement, sqlstate, constraint_name) LOOP
    BEGIN
      EXECUTE c.statement;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME;
      IF SQLSTATE <> c.sqlstate OR actual_constraint IS DISTINCT FROM coalesce(c.constraint_name, actual_constraint) THEN
        RAISE EXCEPTION '%: expected % %, got % % (%)',
          c.label, c.sqlstate, c.constraint_name, SQLSTATE, actual_constraint, SQLERRM;
      END IF;
      CONTINUE;
    END;
    RAISE EXCEPTION '%: statement was accepted', c.label;
  END LOOP;
END $$;

-- Runtime singleton: no row until one is inserted explicitly; an absent RNG and
-- a snapshot object are both accepted; one row only.
DO $$
BEGIN
  IF EXISTS (SELECT FROM realmlib.runtime_state) THEN
    RAISE EXCEPTION 'migration inserted a runtime row';
  END IF;
END $$;

INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, 0, 0);

DO $$
BEGIN
  IF (SELECT random_snapshot IS NULL AND format_version = 1 FROM realmlib.runtime_state) IS NOT TRUE THEN
    RAISE EXCEPTION 'runtime row lacks absent RNG or default format_version';
  END IF;
  BEGIN
    INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence) VALUES (1, 0, 0);
    RAISE EXCEPTION 'second singleton row was accepted';
  EXCEPTION WHEN unique_violation THEN
  END;
END $$;

UPDATE realmlib.runtime_state SET
  now_ms = 9007199254740991,
  next_sequence = 9007199254740991,
  random_snapshot = '{"algorithm":"xoshiro128ss-v1","words":[1,2,3,4294967295]}';

DO $$
BEGIN
  IF (SELECT now_ms = 9007199254740991 AND next_sequence = 9007199254740991
        AND random_snapshot::text = '{"algorithm":"xoshiro128ss-v1","words":[1,2,3,4294967295]}'
      FROM realmlib.runtime_state) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'runtime row did not keep its maximum values and snapshot';
  END IF;
END $$;

-- State identity and values.
INSERT INTO realmlib.state_records (module_id, record_key, value) VALUES
  ('module-a', 'counter', '{"value": 1, "tags": ["x", {"deep": [true, null, 1.5]}]}'),
  ('module-b', 'counter', '2'),
  ('Module-A', 'counter', '3'),
  ('module-a', 'Counter', '4'),
  ('module-a', 'null-value', 'null'),
  ('module-a', 'nul-escape', '"a\u0000b"'),
  ('module-a', 'high-surrogate', '"\ud800"'),
  ('module-a', 'low-surrogate', '"x\udc00y"'),
  ('module-a', 'key-order', '{"b": 1, "a": 2}');

DO $$
BEGIN
  BEGIN
    INSERT INTO realmlib.state_records VALUES ('module-a', 'counter', '5');
    RAISE EXCEPTION 'duplicate state address was accepted';
  EXCEPTION WHEN unique_violation THEN
  END;
  IF (SELECT count(*) FROM realmlib.state_records WHERE record_key = 'counter') <> 3 THEN
    RAISE EXCEPTION 'case-distinct or cross-module state addresses were not all kept';
  END IF;
  IF (SELECT value::text FROM realmlib.state_records WHERE module_id = 'module-a' AND record_key = 'counter')
    <> '{"value": 1, "tags": ["x", {"deep": [true, null, 1.5]}]}'
  THEN
    RAISE EXCEPTION 'nested JSON value changed';
  END IF;
  IF (SELECT json_typeof(value) FROM realmlib.state_records WHERE record_key = 'null-value') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'JSON null value was not stored as a present JSON null';
  END IF;
  IF (SELECT string_agg(value::text, '|' ORDER BY record_key) FROM realmlib.state_records
      WHERE record_key IN ('high-surrogate', 'key-order', 'low-surrogate', 'nul-escape'))
    <> '"\ud800"|{"b": 1, "a": 2}|"x\udc00y"|"a\u0000b"'
  THEN
    RAISE EXCEPTION 'escaped JSON text was not retrieved unchanged';
  END IF;
END $$;

-- Queue data, order, and receipts. Equal times are ordered by sequence, not
-- by insertion into the table.
INSERT INTO realmlib.work_items
  (work_id, at_ms, sequence, module_id, operation, payload_version, payload, status, completed_at_ms)
VALUES
  ('w-late', 9007199254740991, 9007199254740991, 'module-a', 'op', 9007199254740991, '{"n": 1}', 'pending', NULL),
  ('w-tie-2', 500, 7, 'module-a', 'op', 1, 'null', 'pending', NULL),
  ('w-tie-1', 500, 3, 'module-a', 'op', 1, '"text"', 'pending', NULL),
  ('w-first', 0, 0, 'module-b', 'op', 1, '42', 'pending', NULL),
  ('W-FIRST', 100, 4, 'module-b', 'op', 2, 'false', 'pending', NULL),
  ('w-done', 50, 1, 'module-a', 'op', 1, '[1, 2]', 'completed', 60),
  ('w-done-max', 0, 2, 'module-a', 'op', 1, '{}', 'completed', 9007199254740991);

DO $$
BEGIN
  IF (SELECT string_agg(work_id, ',' ORDER BY at_ms, sequence) FROM realmlib.work_items WHERE status = 'pending')
    <> 'w-first,W-FIRST,w-tie-1,w-tie-2,w-late'
  THEN
    RAISE EXCEPTION 'pending queue order is wrong';
  END IF;
  IF (SELECT string_agg(json_typeof(payload), ',' ORDER BY sequence) FROM realmlib.work_items WHERE status = 'pending')
    <> 'number,string,boolean,null,object'
  THEN
    RAISE EXCEPTION 'scalar or null payloads were not kept';
  END IF;

  -- Completed receipts still own their work ID and sequence.
  BEGIN
    INSERT INTO realmlib.work_items VALUES ('w-done', 70, 8, 'module-a', 'op', 1, '[1, 2]', 'pending', NULL);
    RAISE EXCEPTION 'completed work ID was reused';
  EXCEPTION WHEN unique_violation THEN
  END;
  BEGIN
    INSERT INTO realmlib.work_items VALUES ('w-new', 70, 1, 'module-a', 'op', 1, '1', 'pending', NULL);
    RAISE EXCEPTION 'completed sequence was reused';
  EXCEPTION WHEN unique_violation THEN
  END;
  BEGIN
    INSERT INTO realmlib.work_items VALUES ('w-tie-1', 70, 8, 'module-a', 'op', 1, '1', 'pending', NULL);
    RAISE EXCEPTION 'pending work ID was reused';
  EXCEPTION WHEN unique_violation THEN
  END;
  BEGIN
    INSERT INTO realmlib.work_items VALUES ('w-new', 70, 3, 'module-a', 'op', 1, '1', 'pending', NULL);
    RAISE EXCEPTION 'pending sequence was reused';
  EXCEPTION WHEN unique_violation THEN
  END;

  -- Status transitions are checked on update too.
  BEGIN
    UPDATE realmlib.work_items SET status = 'completed' WHERE work_id = 'w-first';
    RAISE EXCEPTION 'completion without a time was accepted';
  EXCEPTION WHEN check_violation THEN
  END;
END $$;

UPDATE realmlib.work_items SET status = 'completed', completed_at_ms = 0 WHERE work_id = 'w-first';

DO $$
BEGIN
  IF (SELECT string_agg(work_id, ',' ORDER BY at_ms, sequence) FROM realmlib.work_items WHERE status = 'pending')
    <> 'W-FIRST,w-tie-1,w-tie-2,w-late'
  THEN
    RAISE EXCEPTION 'completed item is still in the pending order';
  END IF;
END $$;
