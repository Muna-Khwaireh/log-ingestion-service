# Log Ingestion and Query Service

A high-performance structured log ingestion and query service built with TypeScript, Node.js, PostgreSQL, and Drizzle ORM.

The service is designed to ingest large volumes of structured logs, store them efficiently, and provide filtering, cursor-based pagination, time-bucketed aggregation, and automatic data retention.

## Tech Stack

* TypeScript
* Node.js
* PostgreSQL 17
* Drizzle ORM
* Docker / Docker Compose

## Architecture

The application follows a layered architecture:

```text
HTTP Request
    |
    v
Routes
    |
    v
Handlers
    |
    v
Services
    |
    v
Repositories
    |
    v
PostgreSQL
```

Main responsibilities:

* `routes/` — maps HTTP endpoints to handlers
* `handlers/` — handles HTTP requests and responses
* `services/` — application and business logic
* `repositories/` — database queries and persistence
* `validation/` — request and log validation
* `db/` — database connection and schema
* `logs/` — log types and cursor handling
* `retention/` — automatic deletion of expired logs

## Running the Service

The complete service can be started with:

```bash
docker compose up --build
```

The API is available at:

```text
http://localhost:8080
```

Health check:

```bash
curl http://localhost:8080/health
```

Expected response:

```text
OK
```

Database migrations are automatically applied during application startup.

## API

### GET /health

Verifies database connectivity with a `SELECT 1` and reports readiness:

* `200 OK` — the database answered
* `503 Service Unavailable` — the query failed, timed out, or `DATABASE_URL` is unset

```bash
curl -i http://localhost:8080/health
```

The database check is bounded by `HEALTH_DB_TIMEOUT_MS` (default `2000`), so an
unreachable database fails the check instead of hanging the request.

---

### POST /logs

Accepts a batch of structured logs.

Example:

```bash
curl -X POST http://localhost:8080/logs \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {
        "timestamp": "2026-08-17T18:59:00.000Z",
        "level": "info",
        "service": "api",
        "message": "request completed",
        "attributes": {
          "user_id": "100",
          "region": "eu-west",
          "retries": 2
        }
      }
    ]
  }'
```

Response:

```json
{
  "accepted": 1,
  "rejected": []
}
```

Each entry is validated independently. Invalid entries do not cause valid entries in the same batch to be rejected.

Supported levels:

```text
debug
info
warn
error
```

Attributes are stored as a flat JSON object. Supported values are:

* strings
* numbers
* booleans

Nested objects and arrays are rejected.

Malformed JSON and completely invalid batches return HTTP 400.

Request bodies are capped at 16 MB. A larger POST is rejected with HTTP 413 as soon as the cap is passed, before the body is buffered or parsed, so oversized uploads cannot exhaust memory.

---

### GET /logs

Returns logs sorted by timestamp descending, with ID used as a deterministic tiebreaker.

Supported filters:

* `service`
* `level`
* `since`
* `until`
* `attr.<key>`
* `q`
* `limit`
* `cursor`

Example:

```bash
curl "http://localhost:8080/logs?service=checkout&level=error&attr.user_id=42&q=declined"
```

Attribute filtering compares values as strings.

Example:

```bash
curl "http://localhost:8080/logs?attr.user_id=42"
```

Pagination uses an opaque cursor:

```json
{
  "logs": [],
  "next_cursor": "..."
}
```

`next_cursor` is `null` when no additional results are available.

Default limit:

```text
100
```

Maximum limit:

```text
1000
```

---

### GET /logs/aggregate

Returns time-bucketed log counts.

Required parameters:

* `since`
* `until`
* `bucket`

Supported bucket sizes:

```text
1m
5m
1h
1d
```

Optional filters:

* `service`
* `level`
* `attr.<key>`
* `q`
* `group_by`

Supported grouping:

```text
service
level
```

Example:

```bash
curl "http://localhost:8080/logs/aggregate?since=2026-08-17T18:00:00Z&until=2026-08-17T20:00:00Z&bucket=1m"
```

Example response:

```json
{
  "buckets": [
    {
      "start": "2026-08-17 18:59:00+00",
      "group": null,
      "count": 1
    }
  ]
}
```

Aggregation uses PostgreSQL `date_bin` to assign logs to time buckets.

## Database Schema

The primary table is `logs`.

```text
logs
├── id
├── timestamp
├── level
├── service
├── message
└── attributes
```

### ID

The ID is a PostgreSQL generated identity column.

It is used together with `timestamp` to provide deterministic ordering and cursor pagination.

### Timestamp

Stored as PostgreSQL `timestamptz`.

The timestamp is indexed because time-range filtering is a primary query pattern.

It is also the partition key: `logs` is range partitioned by `timestamp`, one
partition per `RETENTION_PARTITION_HOURS`, which is what makes expiry a
`DROP TABLE` rather than a `DELETE`. See [Retention](#retention).

### Level

Stored as text and validated at the application layer.

Valid values:

```text
debug
info
warn
error
```

### Service

Stored as text and indexed because service filtering is a common query pattern.

### Message

Stored as text.

Case-insensitive substring search is supported through the `q` query parameter.
The value is matched literally: the `LIKE` metacharacters `%`, `_` and `\` are
escaped, so `q=order 1_` finds the underscore itself rather than treating it as
a single-character wildcard.

### Attributes

Attributes are stored in PostgreSQL `jsonb`.

Example:

```json
{
  "user_id": "42",
  "region": "eu-west",
  "retries": 3
}
```

This provides a flexible schema for arbitrary log attributes while keeping the data queryable inside PostgreSQL.

## Index Design

The following indexes are used:

### Timestamp + ID (primary key)

```text
logs_pkey
```

Supports:

* time-range queries
* descending log queries
* cursor pagination
* deterministic ordering

`logs` is partitioned by `timestamp`, and a partitioned table's unique
constraints must contain the partition key, so the primary key is
`(timestamp, id)`. PostgreSQL reads that index backwards to satisfy
`ORDER BY timestamp DESC, id DESC`, so it replaces the former
`idx_logs_timestamp_id` outright rather than being maintained alongside it, and
the number of indexes written on each insert is unchanged:

```text
Index Scan Backward using logs_p20260818t00_pkey
```

### Service + Timestamp + ID

```text
idx_logs_service_timestamp_id
```

Supports queries filtering by service while maintaining efficient timestamp ordering.

### JSONB GIN

```text
idx_logs_attributes
```

A GIN index is used for JSONB attribute queries.

Attribute values are compared as strings, so a stored number or boolean matches
the string form supplied in the query:

```sql
attributes ? 'user_id' AND attributes ->> 'user_id' = '42'
```

Containment (`@>`) is not used, because it is type-strict: a stored
`"retries": 3` would never match the string `"3"` arriving from the query
string. The key existence check is GIN-indexable, so a selective attribute key
still narrows the scan through `idx_logs_attributes` before the text
comparison runs.

### Index Budget

Every index is maintained on each insert, so the index set is bounded by the
ingestion target of 15,000 logs/second rather than by query convenience.

Measured cost of a 200,000 row bulk insert:

| index set | rows/second |
| --- | --- |
| all six original indexes | 27,700 |
| without the message trigram index | 86,949 |
| without the trigram and level indexes | 110,862 |

Two indexes were removed in `0003_trim_write_heavy_indexes`:

* `idx_logs_message_trgm` accounted for roughly 68% of insert time. With
  `ORDER BY timestamp DESC LIMIT n` the planner walks `idx_logs_timestamp_id`
  and filters, rather than using the trigram index, so common-term searches did
  not benefit from it at all. It remains available as an opt-in through
  `drizzle/optional/message_trgm.sql`.
* `idx_logs_level_timestamp_id` covered a column with four distinct values.
  Filtering by level through `idx_logs_timestamp_id` measured 0.119 ms against
  0.087 ms with the dedicated index, which does not justify its write cost.

## Query Performance

The primary aggregation query was inspected using PostgreSQL:

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

The timestamp index was used for the time-range condition:

```text
Bitmap Index Scan on idx_logs_timestamp_id
```

The local aggregation query completed in approximately 1 ms on the development dataset.

The query plan included:

```text
Bitmap Index Scan
Bitmap Heap Scan
Sort
GroupAggregate
```

The local dataset was intentionally small, so this measurement is not representative of the final one-million-row benchmark.

Measured results against a 3.6M-row dataset under the graded container limits
are in [Performance Benchmark](#performance-benchmark). Partition pruning is
confirmed there by `EXPLAIN`, which reports `Subplans Removed: 33` — only the
partition covering the requested range is scanned.

## Retention

Expired logs are removed by dropping whole partitions, not by deleting rows.

`logs` is declared `PARTITION BY RANGE ("timestamp")`, with one partition per
`RETENTION_PARTITION_HOURS` (default 24). A retention pass:

1. Creates any partition missing from the retention window, plus
   `RETENTION_PARTITIONS_AHEAD` partitions beyond now, so ingestion always has
   somewhere to write.
2. Drops every partition whose exclusive upper bound is at or below the cutoff.
   Such a partition cannot contain a single unexpired row, so no row-level work
   is required to prove it is safe to remove.
3. Sweeps rows older than the cutoff out of the default partition, looping until
   it is clear.

The cost of a pass depends on the number of expired *partitions*, not on the
number of expired *rows*, which is what allows retention to keep pace with any
ingestion rate. A pass that has nothing to do costs about 7 ms and issues no DDL
at all, because existing partitions are listed before anything is created.

### Configuration

| variable | default | meaning |
| --- | --- | --- |
| `RETENTION_DAYS` | `30` | how long a log is kept |
| `RETENTION_INTERVAL_MS` | `3600000` | how often a retention pass runs |
| `RETENTION_PARTITION_HOURS` | `24` | partition width, and so the precision of expiry |
| `RETENTION_PARTITIONS_AHEAD` | `2` | partitions kept ready ahead of now |
| `RETENTION_LOCK_TIMEOUT_MS` | `3000` | how long a partition change may wait for its lock |
| `RETENTION_BATCH_SIZE` | `10000` | batch size for the default-partition sweep |

A pass also runs once at startup, before the server accepts requests, so the
window is covered from the first batch.

### Why not DELETE

The same 200,000 rows, with the same three indexes, removed both ways:

| | `DELETE` | `DROP TABLE` partition |
| --- | --- | --- |
| time | 112 ms | 10.7 ms |
| dead tuples produced | 200,000 | 0 |
| `VACUUM` afterwards | required, 72 ms | none |
| space released | 57 MB to 18 MB, still allocated to the table | 57 MB to 0 bytes |

`DELETE` also scales with the row count while `DROP TABLE` does not: dropping
30 partitions holding 200,004 rows took 279 ms in total and left zero dead
tuples behind.

The deeper problem is that a delete-based policy must sustain the ingestion rate
forever. At 15,000 logs/second, steady state requires deleting 15,000 rows per
second indefinitely, every one of them producing a dead tuple that autovacuum
must later reclaim from the same pages and the same CPU that ingestion is using.
Dropping a partition competes with nothing.

### Locking

Creating or dropping a partition takes a brief `ACCESS EXCLUSIVE` lock on the
parent table. It is only a catalog change, but it still has to wait for
in-flight statements, so every maintenance statement runs inside a transaction
with a `lock_timeout` of `RETENTION_LOCK_TIMEOUT_MS`. If the lock is not
available quickly the statement is abandoned and retried on the next pass,
rather than queueing in front of live ingestion.

### Retention precision

Because expiry drops whole partitions, a log can outlive its cutoff by up to one
partition width before the partition containing it becomes fully expired.
Reducing `RETENTION_PARTITION_HOURS` tightens that bound, at the cost of one more
partition for the planner to consider per day retained.

### The default partition

Timestamps are validated to at most five minutes in the future, but have no
lower bound, so a client may legitimately send a log far outside the retention
window. A `DEFAULT` partition catches those rows. Without it a single such row
would abort the entire `COPY` batch and fail the whole request with 503.

In normal operation the default partition stays empty: partitions already exist
for the whole retention window, so the only rows that can miss a range are
already older than the cutoff, and step 3 removes them. Rows kept there remain
queryable in the meantime, which is why a failure to create a partition degrades
throughput rather than correctness.

## Reliability and Validation

The service handles:

* malformed JSON
* invalid log levels
* invalid timestamps
* timestamps too far in the future
* invalid limits
* invalid cursors
* invalid aggregation parameters
* invalid attribute structures
* partially invalid ingestion batches
* empty result sets

For ingestion batches, valid entries are accepted even when other entries are rejected.

Example:

```json
{
  "accepted": 2,
  "rejected": [
    {
      "index": 1,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

## Docker

The application listens on port:

```text
8080
```

Docker Compose exposes:

```text
localhost:8080
```

The PostgreSQL database is started alongside the application.

The application automatically runs Drizzle migrations before starting the HTTP server.

The service can therefore be started with:

```bash
docker compose up
```

without requiring manual database setup.

### Graceful shutdown

On `SIGTERM` (sent by `docker compose down` / `docker stop`) or `SIGINT`
(Ctrl+C), the service shuts down cleanly instead of dropping work in flight: it
stops scheduling retention, stops accepting new connections and lets in-flight
requests finish, waits for any running retention pass, then closes the database
connection pool and exits `0`. If draining does not complete within
`SHUTDOWN_TIMEOUT_MS` (default `10000`), it forces the exit so the container
still stops promptly.

### PostgreSQL configuration

Both services declare `deploy.resources.limits` in `docker-compose.yml` (the app
at 0.5 CPU / 256 MB, PostgreSQL at 1.0 CPU / 1 GB) so they cannot starve each
other. Out of the box, though, PostgreSQL sizes itself for a tiny machine —
`shared_buffers=128MB`, `work_mem=4MB`, `max_wal_size=1GB` — which ignores that
1 GB budget and, under sustained writes, forces a checkpoint roughly every 85
seconds. The `command:` block in `docker-compose.yml` overrides these with `-c`
flags, kept inline so the whole configuration is visible in review:

| Parameter | Default | Set to | Why |
|---|---|---|---|
| `shared_buffers` | 128 MB | 256 MB | A quarter of the container's 1 GB for the buffer pool. Under sustained load the pool holds ~156 MB of hot pages — more than the entire old ceiling — at a 98% cache-hit ratio. |
| `effective_cache_size` | 4 GB | 768 MB | A planner hint, not an allocation. The 4 GB default describes a machine that does not exist here and biases plan costs; 768 MB reflects the real budget. |
| `work_mem` | 4 MB | 16 MB | Room for the aggregation query's hash/sort before it spills to disk. |
| `maintenance_work_mem` | 64 MB | 128 MB | Faster index builds (the partition migration) and vacuum. |
| `max_wal_size` | 1 GB | 4 GB | WAL is generated at ~12 MB/s at 15k logs/s, so 1 GB fills in ~85 s and forces a checkpoint well inside the 300 s `checkpoint_timeout`. At 4 GB the timer binds instead, so checkpoints are timed and smoothed rather than pressure-driven storms. |
| `min_wal_size` | 80 MB | 1 GB | Recycle WAL segments instead of churning them. |
| `checkpoint_completion_target` | 0.9 | 0.9 | Already the PostgreSQL 17 default; set explicitly to document that a checkpoint's writes are spread across 90% of the interval. |
| `wal_compression` | off | lz4 | Compresses full-page images in WAL; measured a 15% reduction (74 MB to 63 MB per 100k logs) at negligible CPU cost on one core. |

Measured under the 1 CPU / 1 GB cap: ingestion holds at ~15,500 logs/s
(unchanged from the untuned server), WAL per 100k-log run drops from 74 MB to
63 MB, and PostgreSQL peaks at ~211 MB with no OOM — memory the old 128 MB pool
had no way to use.

## Testing

### Automated tests

The suite runs on Node's built-in test runner and covers validation, cursor
encoding, retention, and full HTTP integration tests for every endpoint. The
integration and retention tests talk to a real PostgreSQL, so `DATABASE_URL`
must point at a reachable database:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/logs npm test
```

`npm test` builds first, so a type error also fails the run.

### Smoke test

`npm run smoke` boots the built server and checks that all four required
endpoints answer with the expected status (`GET /health`, `POST /logs`,
`GET /logs`, `GET /logs/aggregate`). It exits non-zero the moment any endpoint
is unreachable or returns an unexpected status, so a broken route is caught
rather than shipped.

```bash
npm run build
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/logs npm run smoke
```

The listen port is configurable with `SMOKE_PORT`. To probe a server that is
already running instead of spawning one, set `SMOKE_BASE_URL` (for example
`SMOKE_BASE_URL=http://localhost:8080 npm run smoke` against `docker compose`).

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`. It
starts a PostgreSQL service container, then builds, applies migrations, runs the
full test suite, and finishes with the smoke test — so a change that breaks any
endpoint turns the pipeline red instead of merging green.

### Manual checks

TypeScript compilation:

```bash
npm run build
```

Docker startup:

```bash
docker compose up --build
```

Health check:

```bash
curl -i http://localhost:8080/health
```

Example ingestion:

```bash
curl -s -X POST http://localhost:8080/logs \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {
        "timestamp": "2026-08-17T18:59:00.000Z",
        "level": "info",
        "service": "api",
        "message": "load test",
        "attributes": {
          "user_id": "100"
        }
      }
    ]
  }'
```

Example query:

```bash
curl -s "http://localhost:8080/logs?service=api&level=info&attr.user_id=100"
```

Example aggregation:

```bash
curl -s "http://localhost:8080/logs/aggregate?since=2026-08-17T18:00:00Z&until=2026-08-17T20:00:00Z&bucket=1m"
```

## Performance Benchmark

The project is designed to support:

* approximately 1,000,000 stored logs
* high-volume batched ingestion
* sustained ingestion of at least 15,000 logs/second
* aggregation during ingestion
* queryability of newly ingested logs within the required time window

### Load-Test Methodology

All figures below come from `scripts/bench.mjs`, run from the host against the
service in Docker with the graded container limits applied.

**Load model.** The harness is *closed-loop*: it starts `--concurrency` workers,
and each worker sends one batch, waits for the response, then immediately sends
the next. It therefore measures **maximum sustainable throughput** at a given
concurrency rather than holding a fixed target rate. This differs from the
grading load generator, which is open-loop and drives a fixed offered rate
(15,000 logs/s); a closed-loop harness cannot overload the service the same way,
so overload behaviour is exercised by raising concurrency instead.

**Parameters** (defaults as implemented in `scripts/bench.mjs`):

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://localhost:8080` | Base URL of the service under test. |
| `--duration` | `30` | Seconds to generate load. Workers finish their in-flight request afterwards, so actual elapsed time can exceed this; throughput is computed against **actual** elapsed time. |
| `--batch` | `500` | Log entries per `POST /logs` request. |
| `--concurrency` | `32` | Concurrent writers. |
| `--no-aggregate` | *(off)* | Disables the concurrent aggregation probe. |

**Generated data.** Each entry cycles deterministically so the dataset has
realistic cardinality: 10 services (`service-0` … `service-9`), all 4 levels,
and attributes `user_id` (1000 distinct string values), `region` (3 values) and
`retries` (a number, 0–3) — exercising both string and numeric attribute
storage. All entries within one batch share a single timestamp taken when the
batch is built.

**Concurrent query load.** Unless disabled, one `GET /logs/aggregate` is issued
per second for the whole run — matching the brief's *"one aggregation request
per second during the ingestion test"*. The probe queries the **last hour** with
`bucket=1m&group_by=service`, and its latency is reported separately from
ingestion.

**Metrics.** Throughput is `accepted logs ÷ actual elapsed seconds`, counting
only entries the service reported as accepted. Latency percentiles are computed
by nearest rank over every recorded request latency. Requests that return a
non-200 status or throw are counted as failures and reported in the status mix,
so shed (`503`) requests are visible rather than hidden.

### Reproducing the benchmark

```bash
docker compose up -d --build
curl -i http://localhost:8080/health          # wait for 200 before starting
node scripts/bench.mjs --duration=30 --batch=500 --concurrency=32
```

The recorded overload comparison used a heavier profile:

```bash
node scripts/bench.mjs --duration=25 --batch=1000 --concurrency=128
```

Resource usage and dataset size were sampled with:

```bash
docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"
docker compose exec postgres psql -U postgres -d logs -c "SELECT count(*) FROM logs;"
```

Container limits were confirmed actually applied, rather than assumed, with:

```bash
docker inspect log-ingestion-service-app-1 --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
```

`scripts/load-test.mjs` is a simpler fixed-volume script (100,000 logs, batch
500, concurrency 10) kept for quick sanity checks; it reports only total rate,
not latency percentiles.

### Limitations of this methodology

* The harness runs on the **same host** as the containers, so it competes for
  host CPU. This biases results *downward* relative to an isolated generator.
* Closed-loop load cannot reproduce the grading generator's open-loop overload
  exactly; concurrency is used as a proxy.
* The dataset **grew across successive runs** rather than being reset, so later
  runs carry more index-maintenance cost per insert. Figures are reported with
  the row count they were measured at.

### Benchmark Environment

Measured with `node scripts/bench.mjs` as described in
[Load-Test Methodology](#load-test-methodology): a fixed pool of concurrent
writers driving `POST /logs`, with one `GET /logs/aggregate` per second
alongside. Container limits were confirmed applied (`docker inspect`: app
`NanoCpus=500000000`, `Memory=268435456`; PostgreSQL `NanoCpus=1000000000`,
`Memory=1073741824`).

```text
Host:              Docker Desktop (WSL2), Windows 11
Application:       0.5 CPU / 256 MB   (enforced)
PostgreSQL:        1.0 CPU / 1 GB     (enforced, postgres:17-alpine)
Dataset size:      ~3.6M rows (3.6x the ~1M target)
Batch size:        500 logs per request
Concurrency:       32 concurrent writers
Ingestion rate:    22,974 logs/s sustained (39,156 logs/s at 1.95M rows)
Success rate:      100.00%  (0 failed requests, status mix 200=1214)
Query rate:        1 aggregate/s concurrent with ingestion
p50 latency:       557 ms
p95 latency:       1.33 s
p99 latency:       1.57 s
Application CPU:   48-49% of its 0.5-core limit (saturated)
Application memory: 106 MB peak / 256 MB
PostgreSQL CPU:    29-90% of 1 core (~55% average)
PostgreSQL memory: 483-562 MB / 1 GB
```

Ingestion throughput is **1.5x the 15,000 logs/s target at 3.6x the target
dataset size**, with no dropped requests and no restarts. The reported figure is
deliberately conservative: it was measured against a table that had already
grown to 3.6M rows across repeated runs, so index maintenance costs more per row
than it would on the ~1M-row dataset the target assumes.

### Bottlenecks and Optimizations

**Bottleneck 1 — one commit per HTTP request (the dominant cost).**
Ingestion originally issued one `COPY`, one transaction and one fsync per
request, so the fixed per-commit cost was paid per request rather than per row.
Under load, requests queued behind the connection pool while *both* containers
sat almost idle — the signature of waiting, not computing. Replaced with a
group-commit buffer (`src/services/ingest.buffer.ts`): requests hand their rows
to a shared buffer and a flush loop drains whatever accumulated into a single
`COPY`. Batch size is self-tuning — small and low-latency when traffic is light,
large and high-throughput under load. Each request's promise still settles only
after the `COPY` carrying its rows completes, so a 200 continues to mean
"durably stored". Verified: a run reporting 1,236,000 accepted logs increased
`count(*)` by exactly 1,236,000.

**Bottleneck 2 — the connection pool.**
postgres.js defaults to 10 connections and this was never configured. Requests
that could not get one simply waited, which is what produced tens-of-seconds p95
latency at idle CPU. Now `DATABASE_POOL_MAX` (default 24) with a
`connect_timeout`, so a request fails fast instead of holding a socket open.

**Bottleneck 3 — memory during large flushes.**
`insertLogs` built the whole CSV payload with `rows.join("")`, a second full copy
of the batch in a 256 MB container. Now serialised in 500-row chunks honouring
stream backpressure.

**Measured anti-optimization — buffer depth.** Making the ingestion buffer
*deeper* is actively harmful. Under identical overload (128 concurrent writers,
1000-row batches), raising `INGEST_MAX_PENDING_ROWS` from 50k to 100k dropped
throughput from 18,089 to 5,017 logs/s and pushed p95 from 7.6 s to 70 s —
textbook bufferbloat, since a deeper queue only adds waiting once the writer is
already saturated. The default is tuned to roughly one second of drain at
measured throughput; beyond that the service sheds with 503 + `Retry-After`,
which is both faster for the client and safer than buffering into an OOM kill.

**Current ceiling.** The application container is now the bottleneck: Node is
single-threaded and pinned at ~49% of its 0.5-core limit while PostgreSQL still
has headroom. Further gains would come from reducing per-log CPU work in the
application (JSON parsing, validation, CSV serialisation), not from the database.

Key optimizations currently implemented:

* group-commit write buffering with backpressure (503 + `Retry-After`)

* batched PostgreSQL inserts
* timestamp-based indexes
* composite indexes for service and level filtering
* deterministic cursor pagination
* JSONB GIN indexing
* partition pruning on time-range queries
* PostgreSQL `date_bin` aggregation
* retention by dropping expired partitions
* PostgreSQL server tuned to the container (buffer pool, WAL, checkpoints)
* database-side filtering and aggregation

## Known Limitations

* Message substring searches using `ILIKE '%query%'` are not backed by a
  trigram index by default, because it dominated ingestion cost. It can be
  enabled with `drizzle/optional/message_trgm.sql`. At 200,000 rows a
  rare-term search measured approximately 89 ms without it against 9 ms with
  it; common-term searches are unaffected either way.
* JSONB attributes provide flexibility but are less restrictive than a normalized attribute table.
* Retention drops whole partitions, so a log can outlive its cutoff by up to one
  partition width (24 hours by default). `RETENTION_PARTITION_HOURS` trades that
  precision against the number of partitions the planner considers.
* Partitioning adds planning work to queries that cannot be pruned to a single
  partition. With 33 partitions an unfiltered page costs about 0.6 ms against
  0.3 ms unpartitioned once the plan is cached, and about 15 ms on the first
  execution of a statement before caching. Queries carrying `since` prune to the
  partitions they need and are faster than they were before partitioning.
* Raising `max_wal_size` to 4 GB ends the checkpoint storms but lets more WAL
  accumulate between checkpoints, so crash recovery can replay more and the
  `pg_wal` directory can grow larger on disk — an acceptable trade for a logs
  service, and tunable back down if disk is tight.
* Final performance characteristics depend on the official benchmark environment and workload.

## Optional Features

One optional feature is implemented: **backpressure support**. Authentication,
API keys, multi-tenancy and rate limiting are **not** implemented, so the service
has no credential handling and no per-client quotas of any kind.

### Backpressure support

Ingestion buffers rows and writes them in grouped `COPY` batches (see
[Performance Benchmark](#performance-benchmark)). If producers outrun the
writer, the buffer would grow until the 256 MB container is OOM-killed — which
is exactly what happened before this existed: the application container died
mid-run and, with no restart policy, stayed down.

Instead, once more than `INGEST_MAX_PENDING_ROWS` rows are waiting, `POST /logs`
answers:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 1
Content-Type: application/json

{"error": "ingestion is overloaded, retry shortly"}
```

**Default state: active, and not configurable off by design.** It is a safety
valve rather than a policy — the alternative to shedding is crashing.

**This is not a rate limit or a quota.** There is no per-client accounting, no
request ceiling, and no fixed logs/second cap. It engages only when the write
path is genuinely saturated, and at the required throughput it never engages at
all: the benchmark sustained **22,974 logs/s with 0 shed requests and a 100%
success rate**. The project brief sanctions this explicitly — *"shedding load
with 429 or 503 plus Retry-After is better than crashing"* — while also noting
that shed requests count as not ingested. That trade-off is accepted knowingly:
a shed request costs throughput, a crashed container costs everything after it.

| Variable | Default | Meaning |
|---|---|---|
| `INGEST_MAX_PENDING_ROWS` | `25000` | Rows allowed to wait before shedding with 503. Roughly one second of drain at measured throughput. |
| `INGEST_MAX_FLUSH_ROWS` | `10000` | Upper bound on rows in a single `COPY`. |
| `INGEST_FLUSH_CONCURRENCY` | `2` | Concurrent flushes in flight. |

Raising `INGEST_MAX_PENDING_ROWS` widens the buffer before shedding begins, but
**measurement showed this is counter-productive**. Under identical overload
(128 concurrent writers, 1000-row batches):

| `INGEST_MAX_PENDING_ROWS` | Throughput | p95 latency |
|---|---|---|
| `50000` | 18,089 logs/s | 7.6 s |
| `100000` | 5,017 logs/s | 70 s |

A deeper queue only adds waiting once the writer is already saturated, so the
default is tuned to roughly one second of drain rather than to the largest
buffer that fits in memory.

**Compatibility with the required API contract.** The feature is additive and
satisfies the Golden Rule: it adds no endpoint, removes none, changes no
response shape, and introduces no required request parameter or header. The
`503` is a documented status on an existing endpoint under saturation, not a new
failure mode for requests that would otherwise have succeeded.

### Default posture: zero configuration

A plain `docker compose up`, with no environment file, no arguments and no
manual setup, yields the plain core service:

* `GET /health`, `POST /logs`, `GET /logs` and `GET /logs/aggregate` behave
  exactly as specified
* all four accept unauthenticated requests — there is no auth code path to enable
* no rate limit, quota, or tenancy restriction is applied
* migrations run automatically at startup

Every variable below is optional and has a working default. `DATABASE_URL` is
the only required one, and `docker-compose.yml` already sets it.

### Environment variable reference

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (set by compose) | PostgreSQL connection string. |
| `PORT` | `8080` | HTTP listen port. |
| `DATABASE_POOL_MAX` | `24` | Maximum pooled PostgreSQL connections. |
| `DATABASE_CONNECT_TIMEOUT_S` | `10` | Seconds to wait for a connection before failing. |
| `INGEST_MAX_PENDING_ROWS` | `25000` | Backpressure threshold (above). |
| `INGEST_MAX_FLUSH_ROWS` | `10000` | Rows per `COPY` (above). |
| `INGEST_FLUSH_CONCURRENCY` | `2` | Concurrent flushes (above). |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before a shutdown is forced. |
| `HEALTH_DB_TIMEOUT_MS` | `2000` | Timeout for the `GET /health` database check. |
| `RETENTION_DAYS` | `30` | Age at which logs expire. |
| `RETENTION_INTERVAL_MS` | `3600000` | Interval between retention passes. |
| `RETENTION_PARTITION_HOURS` | `24` | Width of each time partition. |
| `RETENTION_PARTITIONS_AHEAD` | `2` | Partitions pre-created ahead of now. |
| `RETENTION_BATCH_SIZE` | `10000` | Rows per delete batch in the default-partition sweep. |
| `RETENTION_LOCK_TIMEOUT_MS` | `3000` | Lock timeout for partition maintenance. |

## Project Structure

```text
src/
├── db/
│   ├── index.ts
│   └── schema.ts
├── handlers/
│   ├── health.handler.ts
│   └── logs.handler.ts
├── logs/
│   ├── log.cursor.ts
│   └── log.types.ts
├── repositories/
│   └── logs.repository.ts
├── retention/
│   ├── partitions.ts
│   └── retention.service.ts
├── routes/
│   ├── health.routes.ts
│   ├── index.ts
│   └── logs.routes.ts
├── services/
│   └── logs.service.ts
├── validation/
│   └── logs.validation.ts
└── index.ts
```

## Security

All database operations use parameterized queries through Drizzle ORM.

Dynamic query construction is restricted to validated application inputs and predefined aggregation intervals.

User-provided attribute keys and values are passed as query parameters rather than concatenated directly into SQL.

## Submission

GitHub repository:

https://github.com/Muna-Khwaireh/log-ingestion-service

The service is intended to start with:

```bash
docker compose up
```

and expose the required API at:

```text
http://localhost:8080
```
