/** @type {import('drizzle-kit').Config} */
export default {
  schema:      './lib/schema.mjs',
  out:         './db/migrations',
  dialect:     'sqlite',
  dbCredentials: { url: './db/career-ops.db' },
};
