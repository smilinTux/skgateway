-- semantic_cache.sql — SC stage 2 schema (skmem-pg pgvector).
-- Apply on skmem-pg (.158:5432, db skmem-pg) before wiring the pgvector store.
-- Stage 1 (the engine) uses the in-memory store and does NOT need this.
--
--   psql "postgresql://<user>@192.168.0.158:5432/skmem-pg" -f sql/semantic_cache.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS skgateway_semantic_cache (
  id              BIGSERIAL PRIMARY KEY,
  ns              TEXT        NOT NULL,          -- "<agent>:<category>" namespace
  query_text      TEXT        NOT NULL,
  query_embedding vector(1024) NOT NULL,         -- mxbai-embed-large dim
  response_json   JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,                   -- NULL = no expiry
  hit_count       INT         NOT NULL DEFAULT 0,
  last_hit_at     TIMESTAMPTZ
);

-- namespace filter (per-agent + category isolation)
CREATE INDEX IF NOT EXISTS skgw_semcache_ns_idx
  ON skgateway_semantic_cache (ns);

-- expiry sweeps
CREATE INDEX IF NOT EXISTS skgw_semcache_exp_idx
  ON skgateway_semantic_cache (expires_at);

-- ANN cosine search (HNSW). Query pattern:
--   SELECT response_json, 1 - (query_embedding <=> $1) AS sim
--   FROM skgateway_semantic_cache
--   WHERE ns = $2 AND (expires_at IS NULL OR expires_at > now())
--   ORDER BY query_embedding <=> $1 LIMIT 1;
CREATE INDEX IF NOT EXISTS skgw_semcache_vec_idx
  ON skgateway_semantic_cache
  USING hnsw (query_embedding vector_cosine_ops);
