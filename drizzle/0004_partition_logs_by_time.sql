


ALTER TABLE "logs" RENAME TO "logs_old";
--> statement-breakpoint
ALTER TABLE "logs_old" RENAME CONSTRAINT "logs_pkey" TO "logs_old_pkey";
--> statement-breakpoint
ALTER SEQUENCE "logs_id_seq" RENAME TO "logs_old_id_seq";
--> statement-breakpoint
ALTER INDEX "idx_logs_timestamp_id" RENAME TO "idx_logs_old_timestamp_id";
--> statement-breakpoint
ALTER INDEX "idx_logs_service_timestamp_id" RENAME TO "idx_logs_old_service_timestamp_id";
--> statement-breakpoint
ALTER INDEX "idx_logs_attributes" RENAME TO "idx_logs_old_attributes";
--> statement-breakpoint

CREATE TABLE "logs" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"timestamp" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "logs_pkey" PRIMARY KEY ("timestamp", "id")
) PARTITION BY RANGE ("timestamp");
--> statement-breakpoint

--
-- The default partition is a safety net, not a working partition. Timestamps
-- are validated to at most five minutes in the future but have no lower bound,
-- so a client may legitimately send a log far outside the retention window.
-- Without a default partition that single row would abort the entire COPY batch
-- and the whole request would fail with 503. With one, it is stored and swept
-- by the cutoff delete instead.
--
CREATE TABLE "logs_default" PARTITION OF "logs" DEFAULT;
--> statement-breakpoint

--
-- Cover whatever range the pre-existing rows occupy, using the same daily
-- boundaries and the same names the application's partition maintenance
-- generates, so it adopts these partitions instead of colliding with them.
--
DO $$
DECLARE
  lo timestamptz;
  hi timestamptz;
  b  timestamptz;
BEGIN
  SELECT date_bin('24 hours', min("timestamp"), TIMESTAMPTZ 'epoch'),
         date_bin('24 hours', max("timestamp"), TIMESTAMPTZ 'epoch')
    INTO lo, hi
    FROM "logs_old";

  IF lo IS NULL THEN
    RETURN;
  END IF;

  b := lo;

  WHILE b <= hi LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "logs" FOR VALUES FROM (%L) TO (%L)',
      'logs_p' || to_char(b AT TIME ZONE 'UTC', 'YYYYMMDD"t"HH24'),
      b,
      b + INTERVAL '24 hours'
    );

    b := b + INTERVAL '24 hours';
  END LOOP;
END $$;
--> statement-breakpoint

INSERT INTO "logs" ("id", "timestamp", "level", "service", "message", "attributes")
OVERRIDING SYSTEM VALUE
SELECT "id", "timestamp", "level", "service", "message", "attributes" FROM "logs_old";
--> statement-breakpoint

SELECT setval(
  pg_get_serial_sequence('logs', 'id'),
  GREATEST((SELECT max("id") FROM "logs"), 1)
);
--> statement-breakpoint

--
-- Indexes are created after the copy so the rows are indexed once in bulk
-- rather than maintained row by row. Creating them on the parent installs them
-- on every existing partition and on every partition created later.
--
CREATE INDEX "idx_logs_service_timestamp_id" ON "logs" USING btree ("service","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_logs_attributes" ON "logs" USING gin ("attributes");
--> statement-breakpoint

DROP TABLE "logs_old";
