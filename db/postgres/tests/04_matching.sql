-- fn_match_workers / fn_match_requests_for_worker with hand-made vectors, so the
-- expected ranking is obvious and no ML model is needed.
BEGIN;

DELETE FROM worker_embedding_vector;      -- start from a controlled vector space (rolled back at the end)

UPDATE worker SET verification_status = 'pending', verified_by = NULL WHERE email = 'manjunath.g@example.com';  -- state this test needs (rolled back)

CREATE TEMP TABLE t AS
SELECT pg_temp.wid('ravi.kumar@example.com')   AS ravi,     -- Electrician, Indiranagar
       pg_temp.wid('suresh.babu@example.com')  AS suresh,   -- Electrician, Koramangala
       pg_temp.wid('anil.sharma@example.com')  AS anil,     -- Plumber
       pg_temp.wid('manjunath.g@example.com')  AS pending,  -- Electrician, PENDING
       pg_temp.cid('aarav.patel@example.com')  AS c;

CREATE TEMP TABLE ctx AS SELECT pg_temp.mk_req(pg_temp.tv('c'), 'vector test') AS request_id;
INSERT INTO request_embedding_vector (request_id, embedding) SELECT request_id, pg_temp.unit(1) FROM ctx;

-- Ravi similarity 1.0, Suresh ~0.894, Anil 0 (orthogonal), pending worker 1.0
INSERT INTO worker_embedding_vector (worker_id, source_type, source_text, embedding) VALUES
  (pg_temp.tv('ravi'),    'skill', 't', pg_temp.unit(1)),
  (pg_temp.tv('suresh'),  'skill', 't', pg_temp.unit(1, 2, 0.5)),
  (pg_temp.tv('anil'),    'skill', 't', pg_temp.unit(2)),
  (pg_temp.tv('pending'), 'skill', 't', pg_temp.unit(1));
INSERT INTO availability_slot (worker_id, start_time, end_time)
VALUES (pg_temp.tv('pending'), now() + interval '2 days', now() + interval '2 days 2 hours');

SELECT pg_temp.ok(
    (SELECT array_agg(worker_id ORDER BY final_score DESC) FROM fn_match_workers((SELECT request_id FROM ctx)))
      = ARRAY[pg_temp.tv('ravi'), pg_temp.tv('suresh')],
    'M1 ranked by similarity; orthogonal worker dropped by threshold; pending worker excluded');

SELECT pg_temp.ok(
    (SELECT array_agg(worker_id) FROM fn_match_workers((SELECT request_id FROM ctx), 10, 'Koramangala'))
      = ARRAY[pg_temp.tv('suresh')],
    'M2 locality filter');

SELECT pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM fn_match_workers((SELECT request_id FROM ctx), 10, NULL,
                (SELECT category_id FROM service_category WHERE name = 'Plumber'))),
    'M3 category filter (no plumber is similar enough)');

SELECT pg_temp.ok(
    (SELECT next_slot_start FROM fn_match_workers((SELECT request_id FROM ctx)) WHERE worker_id = pg_temp.tv('ravi'))
      = (SELECT min(start_time) FROM availability_slot WHERE worker_id = pg_temp.tv('ravi') AND status = 'open' AND start_time > now()),
    'M4 returns the earliest open future slot');

-- M5 no open slot -> not shown
DO $$ BEGIN
    UPDATE availability_slot SET status = 'blocked' WHERE worker_id = pg_temp.tv('ravi') AND status = 'open';
    PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM fn_match_workers((SELECT request_id FROM ctx)) WHERE worker_id = pg_temp.tv('ravi')),
                       'M5 a worker with no open future slot is not matched');
    UPDATE availability_slot SET status = 'open' WHERE worker_id = pg_temp.tv('ravi') AND status = 'blocked';
END $$;

-- M6 trust breaks a similarity tie
DO $$ BEGIN
    UPDATE worker_embedding_vector SET embedding = pg_temp.unit(1) WHERE worker_id = pg_temp.tv('suresh');
    UPDATE worker SET avg_rating = 4.9, rating_count = 50 WHERE worker_id = pg_temp.tv('suresh');
    UPDATE worker SET avg_rating = 2.0, rating_count = 50 WHERE worker_id = pg_temp.tv('ravi');
    PERFORM pg_temp.ok((SELECT worker_id FROM fn_match_workers((SELECT request_id FROM ctx)) LIMIT 1) = pg_temp.tv('suresh'),
                       'M6 equal similarity -> higher Bayesian rating ranks first');
END $$;

-- M7 the ANN stage can use the HNSW index
DO $$
DECLARE v_plan text := ''; r record;
BEGIN
    SET LOCAL enable_seqscan = off;
    FOR r IN EXECUTE 'EXPLAIN SELECT worker_id FROM worker_embedding_vector ORDER BY embedding <=> (SELECT embedding FROM request_embedding_vector LIMIT 1) LIMIT 10' LOOP
        v_plan := v_plan || r."QUERY PLAN" || E'\n';
    END LOOP;
    PERFORM pg_temp.ok(v_plan LIKE '%ix_worker_embedding_hnsw%', 'M7 ORDER BY embedding <=> q LIMIT k uses the HNSW index');
END $$;

-- M8 reverse matching: open requests for a worker
SELECT pg_temp.ok(
    (SELECT request_id FROM fn_match_requests_for_worker(pg_temp.tv('ravi')) LIMIT 1) = (SELECT request_id FROM ctx),
    'M8 reverse matching finds the open request that fits the worker');

ROLLBACK;
