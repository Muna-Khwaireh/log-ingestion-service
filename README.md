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

Returns HTTP 200 once the service is ready.

```bash
curl -i http://localhost:8080/health
```

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

### Timestamp + ID

```text
idx_logs_timestamp_id
```

Supports:

* time-range queries
* descending log queries
* cursor pagination
* deterministic ordering

### Service + Timestamp + ID

```text
idx_logs_service_timestamp_id
```

Supports queries filtering by service while maintaining efficient timestamp ordering.

### Level + Timestamp + ID

```text
idx_logs_level_timestamp_id
```

Supports queries filtering by level while maintaining efficient timestamp ordering.

### JSONB GIN

```text
idx_logs_attributes
```

A GIN index is used for JSONB attribute containment queries.

Attribute filtering uses PostgreSQL JSONB containment:

```sql
attributes @> '{"user_id":"42"}'::jsonb
```

This allows attribute queries to use the JSONB GIN index.

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

Final benchmark results will be added after the official load-generator test.

## Retention

The service implements automatic retention of expired logs.

The retention service:

1. Calculates a cutoff timestamp based on the retention period.
2. Selects expired logs ordered by timestamp.
3. Deletes expired logs in batches.
4. Reports the number of deleted records.

Batch deletion prevents a single large delete operation from unnecessarily affecting the database.

The retention functionality was tested with a log older than the configured retention period and successfully deleted the expired record.

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

## Testing

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

### Benchmark Environment

The official benchmark results will be recorded here after the load-generator test.

```text
Dataset size:
Batch size:
Ingestion rate:
Query rate:
p50 latency:
p95 latency:
p99 latency:
Application CPU:
Application memory:
PostgreSQL CPU:
PostgreSQL memory:
```

### Bottlenecks and Optimizations

Key optimizations currently implemented:

* batched PostgreSQL inserts
* timestamp-based indexes
* composite indexes for service and level filtering
* deterministic cursor pagination
* JSONB GIN indexing
* PostgreSQL `date_bin` aggregation
* batched retention deletion
* database-side filtering and aggregation

## Known Limitations

* Message substring searches using `ILIKE '%query%'` are not backed by a specialized trigram index.
* JSONB attributes provide flexibility but are less restrictive than a normalized attribute table.
* Retention uses batched deletion rather than partition-based expiration.
* Final performance characteristics depend on the official benchmark environment and workload.

## Optional Features

Optional features will be documented here as they are implemented.

Each optional feature will include:

* feature description
* default state
* configuration variables
* enable/disable instructions
* compatibility with the required API contract

The default `docker compose up` configuration remains compatible with the required core API.

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
