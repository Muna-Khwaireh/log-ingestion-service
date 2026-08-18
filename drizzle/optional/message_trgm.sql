
--
-- Trade-off, measured at 200k rows:
--   * rare-term "q=" search: ~89ms -> ~9ms
--   * ingestion throughput:  roughly a 3x reduction
--
-- Common-term searches do not benefit: with ORDER BY timestamp DESC LIMIT n
-- the planner walks idx_logs_timestamp_id and filters instead of using this
-- index at all. Enable it only if selective substring search matters more than
-- the ingestion target.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_logs_message_trgm"
ON "logs"
USING gin ("message" gin_trgm_ops);
