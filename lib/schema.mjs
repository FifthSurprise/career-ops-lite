import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const applications = sqliteTable('applications', {
  id:          integer('id').primaryKey(),
  num:         integer('num').notNull(),
  date:        text('date').notNull(),
  company:     text('company').notNull(),
  role:        text('role').notNull(),
  cycle_id:    integer('cycle_id').notNull().default(1),
  status:      text('status').notNull(),
  score:       real('score'),
  pdf:         integer('pdf').notNull().default(0),
  report_path: text('report_path'),
  url:         text('url'),
  legitimacy:  text('legitimacy'),
  notes:       text('notes'),
}, t => [unique().on(t.company, t.role, t.cycle_id)]);

export const pipelineEntries = sqliteTable('pipeline_entries', {
  id:             integer('id').primaryKey(),
  url:            text('url').notNull().unique(),
  source:         text('source'),
  state:          text('state').notNull().default('pending'),
  title:          text('title'),
  company:        text('company'),
  local_jd:       text('local_jd'),
  discovered_at:  text('discovered_at').notNull(),
  application_id: integer('application_id').references(() => applications.id),
});

export const llmContent = sqliteTable('llm_content', {
  id:         integer('id').primaryKey(),
  owner_type: text('owner_type').notNull(),
  owner_id:   integer('owner_id').notNull(),
  tag:        text('tag').notNull(),
  body:       text('body').notNull(),
  created_at: text('created_at').notNull(),
}, t => [unique().on(t.owner_type, t.owner_id, t.tag)]);

export const scanHistory = sqliteTable('scan_history', {
  url:        text('url').notNull().primaryKey(),
  first_seen: text('first_seen').notNull(),
  portal:     text('portal'),
  title:      text('title'),
  company:    text('company'),
  status:     text('status').notNull().default('added'),
});

export const jdCache = sqliteTable('jd_cache', {
  url:        text('url').notNull().primaryKey(),
  title:      text('title'),
  company:    text('company'),
  body_md:    text('body_md').notNull(),
  fetched_at: text('fetched_at').notNull(),
});

export const cvChunks = sqliteTable('cv_chunks', {
  id:         integer('id').primaryKey(),
  section:    text('section').notNull(),
  text:       text('text').notNull(),
  tags:       text('tags').notNull().default(''),
  source:     text('source').notNull().default('cv'),
  created_at: text('created_at').notNull(),
}, t => [unique().on(t.section, t.source)]);

// ── Relations ─────────────────────────────────────────────────────────────────

export const applicationsRelations = relations(applications, ({ many }) => ({
  pipelineEntries: many(pipelineEntries),
}));

export const pipelineEntriesRelations = relations(pipelineEntries, ({ one }) => ({
  application: one(applications, {
    fields: [pipelineEntries.application_id],
    references: [applications.id],
  }),
}));
