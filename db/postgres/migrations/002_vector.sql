-- ============================================================================
-- 002_vector.sql  -  pgvector tables (semantic side, same PostgreSQL instance)
-- Embedding dimension is 384 (all-MiniLM-L6-v2). If you change the model, change
-- vector(384) here and EMBEDDING_DIM in .env, then run: npm run db:embed -- --force
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per (worker, kind of text):
--   'skill' = trade + categories + skills list (from MongoDB), 'bio' = the free-text bio.
-- Matching takes the BEST similarity of the two rows per worker.
CREATE TABLE worker_embedding_vector (
    embedding_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id    integer     NOT NULL REFERENCES worker(worker_id) ON DELETE CASCADE,
    source_type  text        NOT NULL CHECK (source_type IN ('skill','bio')),
    source_text  text        NOT NULL,                 -- what was embedded (for debugging + change detection)
    embedding    vector(384) NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (worker_id, source_type)
);

-- One embedding per service request (written in the same transaction as the request).
CREATE TABLE request_embedding_vector (
    request_id  integer     PRIMARY KEY REFERENCES service_request(request_id) ON DELETE CASCADE,
    embedding   vector(384) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Approximate nearest neighbour indexes. Cosine distance operator is <=>;
-- a query must use  ORDER BY embedding <=> $q LIMIT k  for the index to be used.
CREATE INDEX ix_worker_embedding_hnsw
    ON worker_embedding_vector USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX ix_request_embedding_hnsw
    ON request_embedding_vector USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
