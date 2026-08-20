import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const hanyoungReteFiles = sqliteTable("hanyoung_rete_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  kind: text("kind", { enum: ["question", "answer"] }).notNull(),
  filename: text("filename").notNull(),
  objectKey: text("object_key").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("hanyoung_rete_period_kind").on(table.year, table.month, table.kind)]);
