CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "idx_logs_message_trgm"
ON "logs"
USING gin ("message" gin_trgm_ops);