-- ============================================================================
-- 002_vector.sql  -  pgvector tables (semantic side of the system, same PostgreSQL instance)
-- Owner: Person B.  Embedding dimension is FROZEN at 384 (all-MiniLM-L6-v2 / multilingual-e5-small).
-- If you ever change the model, change the dimension here, in .env.example and re-embed everything.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per (worker, kind of text). 'skill' = composed from trade + categories + skills list,
-- 'bio' = the worker's free-text bio. Matching takes the BEST similarity per worker.
CREATE TABLE worker_embedding_vector (
    embedding_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id    integer     NOT NULL REFERENCES worker(worker_id) ON DELETE CASCADE,
    source_type  text        NOT NULL CHECK (source_type IN ('skill','bio')),
    source_text  text        NOT NULL,
    embedding    vector(384) NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (worker_id, source_type)
);

-- One embedding per service request (created together with the request).
CREATE TABLE request_embedding_vector (
    request_id  integer     PRIMARY KEY REFERENCES service_request(request_id) ON DELETE CASCADE,
    embedding   vector(384) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Approximate-nearest-neighbour indexes (cosine distance operator <=>).
-- Query with:  ORDER BY embedding <=> $1  LIMIT k   (the operator must match the opclass or the index is ignored)
CREATE INDEX ix_worker_embedding_hnsw
    ON worker_embedding_vector USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX ix_request_embedding_hnsw
    ON request_embedding_vector USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
