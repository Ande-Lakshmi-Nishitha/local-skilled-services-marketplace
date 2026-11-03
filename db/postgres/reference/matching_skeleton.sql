-- ============================================================================
-- REFERENCE ONLY (not in migrations/ on purpose) - starting point for Person B's
-- 100_matching.sql.  Shape of the query is the point; tune, extend and test it yourself.
--
-- Three stages:   1. ANN over embedding rows (HNSW)  ->  2. best row per worker
--                 3. relational filters (verified, locality, category, has an open future slot)
--                 4. blend similarity with a Bayesian-smoothed rating
-- Known limitation: filters run AFTER the ANN stage, so over-fetch (p_ann_k) and/or enable
-- pgvector's iterative index scans if your pgvector version has them (check: SELECT extversion ...).
-- Person A's fn_bayesian_rating() (migration 003) replaces the inline trust expression once it exists.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_match_workers_ref(
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
) LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT embedding FROM request_embedding_vector WHERE request_id = p_request_id
    ),
    ann AS (                                         -- stage 1: uses ix_worker_embedding_hnsw
        SELECT e.worker_id, 1 - (e.embedding <=> q.embedding) AS sim
        FROM worker_embedding_vector e, q
        ORDER BY e.embedding <=> q.embedding
        LIMIT p_ann_k
    ),
    best AS (                                        -- stage 2: best of skill/bio per worker
        SELECT a.worker_id, max(a.sim) AS similarity FROM ann a GROUP BY a.worker_id
    ),
    eligible AS (                                    -- stage 3: relational filters
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
    with_slot AS (                                   -- only workers who can actually be booked
        SELECT el.*, s.slot_id, s.start_time, s.end_time
        FROM eligible el
        JOIN LATERAL (
            SELECT slot_id, start_time, end_time
            FROM availability_slot
            WHERE availability_slot.worker_id = el.worker_id
              AND status = 'open' AND start_time > now()
            ORDER BY start_time
            LIMIT 1
        ) s ON true
    ),
    scored AS (                                      -- stage 4: Bayesian trust (prior mean 3.5, weight 5)
        SELECT ws.*,
               ((ws.rating_count * coalesce(ws.avg_rating, 0)) + 5 * 3.5) / (ws.rating_count + 5) AS trust
        FROM with_slot ws
    )
    SELECT sc.worker_id,
           sc.similarity::double precision,
           round(sc.trust, 3),
           (p_alpha * sc.similarity + (1 - p_alpha) * (sc.trust / 5))::double precision AS final_score,
           sc.slot_id, sc.start_time, sc.end_time
    FROM scored sc
    ORDER BY final_score DESC
    LIMIT p_limit;
$$;
