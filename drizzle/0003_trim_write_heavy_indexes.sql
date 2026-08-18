
--
-- The level index is dropped because it earns almost nothing: level has four
-- distinct values, so idx_logs_timestamp_id plus a filter serves the same
-- queries at effectively the same speed.
DROP INDEX IF EXISTS "idx_logs_message_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_logs_level_timestamp_id";
