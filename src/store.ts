import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatTurn, DemoSession, FixtureScenario, Proposal } from './contracts.ts';
import { LIMITS } from './agent-contract.ts';
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
  create(description: unknown, scenario: unknown, operation: string, conversation?: unknown): DemoSession {
    if (typeof description !== 'string' || !description.trim() || description.length > 4000 || !['recovered', 'exhausted'].includes(String(scenario)) || !/^[a-zA-Z0-9-]{16,80}$/.test(operation)) throw new Failure(422, 'INVALID_SESSION', 'Enter a fictional project description (1–4000 characters), supported fixture and valid operation ID.');
    const turns = conversationOf(conversation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT document FROM sessions WHERE operation=?').get(operation) as {document:string} | undefined;
      if (existing) {
        const s = this.parse(existing.document);
        if (s.description !== description.trim() || s.dataset.activeScenario !== scenario) throw new Failure(409, 'OPERATION_CONFLICT', 'This creation operation already has different input.');
        this.db.exec('COMMIT'); return s;
      }
      const id = randomUUID();
      const now = Date.now();
      const s: DemoSession = {
        id, description: description.trim(), createdAt: new Date(now).toISOString(), version: 1, dataset: fixtures(id, scenario as FixtureScenario), conversation: turns,
        // NIT-270 contract fields; lifecycle enforcement lands in NIT-273.
        conversationVersion: 1, conversationTruncated: false, story: null, state: 'active',
        lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + LIMITS.lifetimeMs).toISOString(), lastClientTurnId: null,
      };
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(id, operation, JSON.stringify(s));
      this.db.exec('COMMIT'); return s;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  read(id: string): DemoSession {
    const row = this.db.prepare('SELECT document FROM sessions WHERE id=?').get(id) as {document:string} | undefined;
    if (!row) throw new Failure(404, 'NOT_FOUND', 'Session not found.');
    return this.parse(row.document);
  }
  parse(document: string): DemoSession {
    const session = JSON.parse(document) as DemoSession;
    session.conversation ??= [];
    session.conversationVersion ??= 1;
    session.conversationTruncated ??= false;
    session.story ??= null;
    session.state ??= 'active';
    session.lastActiveAt ??= session.createdAt;
    session.expiresAt ??= new Date(Date.parse(session.createdAt) + LIMITS.lifetimeMs).toISOString();
    session.lastClientTurnId ??= null;
    return session;
  }
  applyScenario(id: string, scenario: unknown, expectedVersion: unknown): DemoSession {
    if (scenario !== 'recovered' && scenario !== 'exhausted') throw new Failure(422, 'INVALID_SCENARIO', 'Choose the recovered or exhausted synthetic fixture.');
    if (typeof expectedVersion !== 'number') throw new Failure(422, 'INVALID_SCENARIO', 'Send the session version you read.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.read(id);
      if (expectedVersion !== previous.version) throw new Failure(409, 'STALE_VERSION', 'Version changed. The previous fixture is still saved.');
      const dataset = fixtures(id, scenario);
      if (!validateDataset(id, dataset)) throw new Failure(422, 'INVALID_DATASET', 'Fixture rejected. Previous version retained.');
      const next = { ...previous, version: previous.version + 1, dataset };
      this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT'); return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  saveConversation(id: string, conversation: unknown): DemoSession {
    const turns = conversationOf(conversation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.read(id);
      const next = { ...previous, conversation: turns };
      this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT'); return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  list(): DemoSession[] { return (this.db.prepare('SELECT document FROM sessions ORDER BY rowid DESC').all() as {document:string}[]).map(r=>this.parse(r.document)); }
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

export function conversationOf(value: unknown): ChatTurn[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Failure(422, 'INVALID_CONVERSATION', 'A conversation can hold at most 40 messages.');
  return value.map(turn => {
    const status = turn?.status;
    const role = turn?.role === 'adapter' ? 'tailor' : turn?.role; // legacy NIT-265 rows
    if (!turn || (role !== 'buyer' && role !== 'tailor') || !['pending', 'applied', 'failed', 'uncertain', 'question', 'note'].includes(status)) throw new Failure(422, 'INVALID_CONVERSATION', 'Each message needs a buyer or tailor role and a known status.');
    if (typeof turn.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(turn.id) || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 2000 || typeof turn.at !== 'string' || Number.isNaN(Date.parse(turn.at))) throw new Failure(422, 'INVALID_CONVERSATION', 'Each message needs an id, a time, and 1–2000 characters.');
    return { id: turn.id, role, text: turn.text.trim(), status, at: turn.at };
  });
}
