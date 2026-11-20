-- ============================================================================
-- report_vector.sql  -  pgvector commands used in the project report.
-- Run:  psql "$POSTGRES_URL" -f db/postgres/queries/report_vector.sql
-- Changes are made inside a transaction that ends in ROLLBACK.
-- ============================================================================
\pset border 2
\pset null '-'

\echo '=== V1. Extension, column type and HNSW index definitions ==='
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'btree_gist');
\x on
SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE 'ix_%embedding_hnsw';
\x off

\echo '=== V2. READ: the customer request we search with, and how many vectors exist ==='
SELECT request_id, description FROM service_request WHERE request_id = 189;
SELECT (SELECT count(*) FROM worker_embedding_vector) AS worker_vectors,
       (SELECT count(*) FROM request_embedding_vector) AS request_vectors,
       (SELECT vector_dims(embedding) FROM worker_embedding_vector LIMIT 1) AS dimensions;

\echo '=== V3. READ: nearest worker texts by cosine distance (<=>) to request 189 ==='
SELECT v.worker_id, w.name, v.source_type,
       round((1 - (v.embedding <=> q.embedding))::numeric, 3) AS similarity,
       left(v.source_text, 38) AS embedded_text
FROM worker_embedding_vector v
JOIN worker w ON w.worker_id = v.worker_id
CROSS JOIN (SELECT embedding FROM request_embedding_vector WHERE request_id = 189) q
ORDER BY v.embedding <=> q.embedding
LIMIT 6;

\echo '=== V4. READ: full matching function (ANN + filters + rating blend) ==='
SELECT m.worker_id, w.name, w.locality, round(m.similarity::numeric, 3) AS similarity,
       m.trust_score, round(m.final_score::numeric, 3) AS final_score,
       to_char(m.next_slot_start AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS next_slot_ist
FROM fn_match_workers(189, 5) m JOIN worker w USING (worker_id)
ORDER BY m.final_score DESC;

\echo '=== V5. READ: reverse matching - open requests that fit worker 6 (a plumber) ==='
SELECT r.request_id, round(m.similarity::numeric, 3) AS similarity, left(r.description, 60) AS description
FROM fn_match_requests_for_worker(6, 3) m JOIN service_request r USING (request_id);

\echo '=== V6. The HNSW index is used for nearest-neighbour search (EXPLAIN) ==='
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT worker_id FROM worker_embedding_vector
ORDER BY embedding <=> (SELECT embedding FROM request_embedding_vector WHERE request_id = 189) LIMIT 10;
RESET enable_seqscan;

\echo '=== V7. UPDATE and DELETE on vectors (rolled back) ==='
BEGIN;
\echo '--- re-embed: worker 1 (electrician) bio now carries the vector of worker 2 (a different worker)'
UPDATE worker_embedding_vector
SET embedding   = (SELECT embedding FROM worker_embedding_vector WHERE worker_id = 2 AND source_type = 'bio'),
    source_text = 'DEMO: re-embedded text', updated_at = now()
WHERE worker_id = 1 AND source_type = 'bio'
RETURNING worker_id, source_type, source_text;

\echo '--- DELETE: remove every vector of worker 1; the worker disappears from semantic search'
DELETE FROM worker_embedding_vector WHERE worker_id = 1 RETURNING worker_id, source_type;
SELECT count(*) AS worker1_vectors_left FROM worker_embedding_vector WHERE worker_id = 1;
ROLLBACK;
SELECT count(*) AS worker1_vectors_after_rollback FROM worker_embedding_vector WHERE worker_id = 1;
