import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const logs = pgTable(
  "logs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    timestamp: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),

    level: text("level").notNull(),

    service: text("service").notNull(),

    message: text("message").notNull(),

    attributes: jsonb("attributes")
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),
  },
  (table) => [
    index("idx_logs_timestamp_id").on(
      table.timestamp.desc(),
      table.id.desc(),
    ),

    index("idx_logs_service_timestamp_id").on(
      table.service,
      table.timestamp.desc(),
      table.id.desc(),
    ),

    index("idx_logs_level_timestamp_id").on(
      table.level,
      table.timestamp.desc(),
      table.id.desc(),
    ),

    index("idx_logs_attributes").using(
      "gin",
      table.attributes,
    ),
  ],
);