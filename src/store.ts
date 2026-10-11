import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DemoSession, Proposal, Scenario } from './contracts.ts';
import { fixtures, validateDataset } from './fixtures.ts';

export class Failure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export class Store {
  db: DatabaseSync; secret: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, document TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('secret', randomBytes(32).toString('hex'));
    this.secret = (this.db.prepare('SELECT value FROM settings WHERE key=?').get('secret') as { value: string }).value;
  }
  token(id: string) { return createHmac('sha256', this.secret).update(id).digest('hex'); }
  authorize(id: string, cookie: string) {
    const expected = `${id}.${this.token(id)}`;
    const a = Buffer.from(cookie); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Failure(404, 'NOT_FOUND', 'Session not found or unavailable to this browser.');
  }
  create(description: unknown, scenario: unknown, operation: string): DemoSession {
    if (typeof description !== 'string' || !description.trim() || description.length > 4000 || !['recovered', 'exhausted'].includes(String(scenario)) || !/^[a-zA-Z0-9-]{16,80}$/.test(operation)) throw new Failure(422, 'INVALID_SESSION', 'Enter a fictional project description (1–4000 characters), supported fixture and valid operation ID.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT document FROM sessions WHERE operation=?').get(operation) as {document:string} | undefined;
      if (existing) {
        const s: DemoSession = JSON.parse(existing.document);
        if (s.description !== description.trim() || s.dataset.activeScenario !== scenario) throw new Failure(409, 'OPERATION_CONFLICT', 'This creation operation already has different input.');
        this.db.exec('COMMIT'); return s;
      }
      const id = randomUUID();
      const s: DemoSession = { id, description: description.trim(), createdAt: new Date().toISOString(), version: 1, dataset: fixtures(id, scenario as Scenario) };
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(id, operation, JSON.stringify(s));
      this.db.exec('COMMIT'); return s;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  read(id: string): DemoSession {
    const row = this.db.prepare('SELECT document FROM sessions WHERE id=?').get(id) as {document:string} | undefined;
    if (!row) throw new Failure(404, 'NOT_FOUND', 'Session not found.');
    return JSON.parse(row.document);
  }
  list(): DemoSession[] { return (this.db.prepare('SELECT document FROM sessions ORDER BY rowid DESC').all() as {document:string}[]).map(r=>JSON.parse(r.document)); }
  publish(id: string, proposal: Proposal): DemoSession {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.read(id);
      if (!proposal || proposal.expectedVersion !== previous.version) throw new Failure(409, 'STALE_VERSION', 'Version changed. Read the current session before proposing again.');
      if (!validateDataset(id, proposal.dataset)) throw new Failure(422, 'INVALID_DATASET', 'Proposal violates the deterministic fixture contract. Previous version retained.');
      const next = { ...previous, version: previous.version + 1, dataset: proposal.dataset };
      this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT'); return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
