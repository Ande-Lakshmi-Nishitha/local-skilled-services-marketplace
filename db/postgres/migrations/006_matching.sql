-- ============================================================================
-- 006_matching.sql  -  semantic matching in both directions
--
-- fn_match_workers: request -> ranked workers
--   stage 1  ANN: nearest K worker-embedding rows by cosine distance (HNSW index)
--   stage 2  best similarity per worker (each worker has a 'skill' and a 'bio' row)
--   stage 3  filters: verified, similarity >= threshold, optional locality/category,
--            and at least one OPEN future slot (earliest one is returned)
--   stage 4  final = alpha * similarity + (1 - alpha) * bayesian_rating / 5
--
-- Known trade-off: filters run AFTER the ANN stage, so very selective filters can
-- return fewer than p_limit rows. Mitigation: a larger p_ann_k (candidate pool).
-- ============================================================================

CREATE FUNCTION fn_match_workers(
    p_request_id  integer,
    p_limit       integer DEFAULT 10,
    p_locality    text    DEFAULT NULL,
    p_category_id integer DEFAULT NULL,
    p_alpha       numeric DEFAULT 0.7,
    p_min_sim     numeric DEFAULT 0.25,
    p_ann_k       integer DEFAULT 100
) RETURNS TABLE (
    worker_id       integer,
    similarity      double precision,
    trust_score     numeric,
    final_score     double precision,
    next_slot_id    integer,
    next_slot_start timestamptz,
    next_slot_end   timestamptz
) LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
    IF p_limit < 1 OR p_ann_k < 1 OR p_alpha < 0 OR p_alpha > 1 THEN
        RAISE EXCEPTION 'fn_match_workers: invalid arguments (limit=%, ann_k=%, alpha=%)', p_limit, p_ann_k, p_alpha
            USING ERRCODE = '22023';
    END IF;

    -- An HNSW scan returns at most hnsw.ef_search rows (default 40). Raise it to the
    -- candidate count for this transaction only (third argument true = local).
    PERFORM set_config('hnsw.ef_search', least(greatest(p_ann_k, 40), 1000)::text, true);

    RETURN QUERY
    WITH q AS (
        SELECT e.embedding FROM request_embedding_vector e WHERE e.request_id = p_request_id
    ),
    ann AS (
        SELECT v.worker_id, 1 - (v.embedding <=> q.embedding) AS sim
        FROM worker_embedding_vector v, q
        ORDER BY v.embedding <=> q.embedding
        LIMIT p_ann_k
    ),
    best AS (
        SELECT a.worker_id, max(a.sim) AS similarity FROM ann a GROUP BY a.worker_id
    ),
    eligible AS (
        SELECT w.worker_id, b.similarity, w.avg_rating, w.rating_count
        FROM best b
        JOIN worker w ON w.worker_id = b.worker_id
        WHERE w.verification_status = 'verified'
          AND b.similarity >= p_min_sim
          AND (p_locality IS NULL OR w.locality = p_locality)
          AND (p_category_id IS NULL OR EXISTS (
                SELECT 1 FROM worker_category wc
                WHERE wc.worker_id = w.worker_id AND wc.category_id = p_category_id))
    ),
    with_slot AS (
        SELECT el.*, s.slot_id, s.start_time, s.end_time
        FROM eligible el
        JOIN LATERAL (
            SELECT sl.slot_id, sl.start_time, sl.end_time
            FROM availability_slot sl
            WHERE sl.worker_id = el.worker_id AND sl.status = 'open' AND sl.start_time > now()
            ORDER BY sl.start_time
            LIMIT 1
        ) s ON true
    )
    SELECT ws.worker_id,
           ws.similarity::double precision,
           fn_bayesian_rating(ws.avg_rating, ws.rating_count),
           (p_alpha * ws.similarity
              + (1 - p_alpha) * fn_bayesian_rating(ws.avg_rating, ws.rating_count) / 5)::double precision,
           ws.slot_id, ws.start_time, ws.end_time
    FROM with_slot ws
    ORDER BY 4 DESC, 1
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reverse matching: open requests (not yet booked) that fit a worker's skills.
-- Each of the worker's embedding rows does its own ANN search over request
-- embeddings (HNSW on request_embedding_vector); best similarity per request wins.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_match_requests_for_worker(
    p_worker_id integer,
    p_limit     integer DEFAULT 10,
    p_min_sim   numeric DEFAULT 0.25,
    p_ann_k     integer DEFAULT 100
) RETURNS TABLE (request_id integer, similarity double precision)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
    PERFORM set_config('hnsw.ef_search', least(greatest(p_ann_k, 40), 1000)::text, true);
    RETURN QUERY
    SELECT c.request_id, max(c.sim)::double precision AS similarity
    FROM worker_embedding_vector w
    CROSS JOIN LATERAL (
        SELECT r.request_id, 1 - (r.embedding <=> w.embedding) AS sim
        FROM request_embedding_vector r
        ORDER BY r.embedding <=> w.embedding
        LIMIT p_ann_k
    ) c
    JOIN service_request sr ON sr.request_id = c.request_id
    WHERE w.worker_id = p_worker_id
      AND sr.status = 'open'
      AND c.sim >= p_min_sim
    GROUP BY c.request_id
    ORDER BY 2 DESC, 1
    LIMIT p_limit;
END;
$$;
