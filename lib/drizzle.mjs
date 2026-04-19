import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import * as schema from './schema.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dir, '..', 'db', 'career-ops.db');

export function openDrizzle(dbPath = DEFAULT_PATH) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

export { schema };
export * from './schema.mjs';
