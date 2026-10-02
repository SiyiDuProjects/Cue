import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable('probe_jobs', {
  id: text('id').primaryKey(), scope: text('scope').notNull(), kind: text('kind').notNull(),
  status: text('status').notNull(), created: integer('created').notNull(), updated: integer('updated').notNull(),
  count: integer('count').notNull().default(0), cancelled: integer('cancelled').notNull().default(0),
});
export const events = sqliteTable('probe_events', {
  scope: text('scope').notNull(), id: text('id').notNull(), seq: integer('seq').notNull(),
  revision: integer('revision').notNull(), kind: text('kind').notNull(), speaker: text('speaker'),
  body: text('body').notNull(), created: integer('created').notNull(),
}, t => [primaryKey({columns:[t.scope,t.id]})]);
export const files = sqliteTable('probe_files', {
  scope: text('scope').notNull(), id: text('id').notNull(), hash: text('hash').notNull(),
  size: integer('size').notNull(), mime: text('mime').notNull(), sent: integer('sent').notNull().default(0),
  removed: integer('removed').notNull().default(0),
}, t => [primaryKey({columns:[t.scope,t.id]})]);
