import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatStatus, ChatTurn, Dataset, DemoSession, FixtureScenario, Span, Story, Trace, TraceList, TraceQuery } from './contracts.ts';
import {
  LIMITS, systemClock,
  type Clock, type PublishResult, type ReadbackEvidence, type ScenarioProposal, type SessionSnapshot, type TurnResponse,
} from './agent-contract.ts';
import { fixtures } from './fixtures.ts';
import { datasetProblems, validateProposal } from './validator.ts';

export class Failure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
/** Thrown inside a transaction when a lifecycle deletion must be committed before the failure surfaces. */
class CommitThenThrow extends Error {
  failure: Failure;
  constructor(failure: Failure) { super(failure.message); this.failure = failure; }
}

/** Ended-session tombstones keep End demo idempotent, then are swept. */
export const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const CHAT_STATUSES: readonly ChatStatus[] = ['pending', 'applied', 'failed', 'uncertain', 'question', 'note'];

export interface StoreFaults { failSave?: () => boolean; failReadback?: () => boolean }
export interface StoreOptions { clock?: Clock; faults?: StoreFaults }
export interface StoredTurn { clientTurnId: string; response: TurnResponse }
export type NewTurn = Omit<ChatTurn, 'id' | 'at'>;
export interface AppendOptions {
  expectedConversationVersion?: number;
  story?: Story | null;
  /** Update the status of an earlier turn (the pending buyer turn) in the same transaction. */
  settle?: { id: string; status: ChatStatus };
  /** Builds the idempotent turn record from the committed state; stored atomically with the append. */
  respond?: (appended: ChatTurn[], next: DemoSession) => StoredTurn;
}
interface Row { id: string; document: string; state: string; last_active_at: number; expires_at: number; last_turn: string | null }

const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new Failure(404, 'NOT_FOUND', 'Session not found or unavailable to this browser.');
export const isGone = (e: unknown) => e instanceof Failure && (e.status === 410 || e.status === 404);

export class Store {
  db: DatabaseSync; reader: DatabaseSync; secret: string; clock: Clock; faults: StoreFaults;
  private inTxn = false;
  constructor(path: string, options: StoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.faults = options.faults ?? {};
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, document TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('secret', randomBytes(32).toString('hex'));
    this.secret = (this.db.prepare('SELECT value FROM settings WHERE key=?').get('secret') as { value: string }).value;
    this.migrate();
    // Independent connection for post-commit readback; it only sees committed data.
    this.reader = path === ':memory:' ? this.db : new DatabaseSync(path, { readOnly: true });
    if (this.reader !== this.db) this.reader.exec('PRAGMA busy_timeout=5000');
    this.sweep();
  }
  private migrate() {
    const columns = (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    const add = (name: string, definition: string) => { if (!columns.includes(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`); };
    add('state', "TEXT NOT NULL DEFAULT 'active'");
    add('last_active_at', 'INTEGER');
    add('expires_at', 'INTEGER');
    add('last_turn', 'TEXT');
    const legacy = this.db.prepare('SELECT id, document FROM sessions WHERE last_active_at IS NULL OR expires_at IS NULL').all() as { id: string; document: string }[];
    const update = this.db.prepare('UPDATE sessions SET last_active_at=?, expires_at=? WHERE id=?');
    for (const row of legacy) {
      let created = 0;
      try { created = Date.parse((JSON.parse(row.document) as DemoSession).createdAt) || 0; } catch { created = 0; }
      update.run(created, created + LIMITS.lifetimeMs, row.id);
    }
  }

  token(id: string) { return createHmac('sha256', this.secret).update(id).digest('hex'); }
  authorize(id: string, cookie: string) {
    const expected = `${id}.${this.token(id)}`;
    const a = Buffer.from(cookie); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw notFound();
  }

  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTxn = true;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      if (e instanceof CommitThenThrow) { this.db.exec('COMMIT'); throw e.failure; }
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally { this.inTxn = false; }
  }
  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT id, document, state, last_active_at, expires_at, last_turn FROM sessions WHERE id=?').get(id) as Row | undefined;
  }
  private expired(row: Row, now = this.clock.now()) { return now - row.last_active_at > LIMITS.idleMs || now >= row.expires_at; }
  /** Server-clock lifecycle gate. Expired rows are deleted on access; ended rows are tombstones. */
  private live(id: string): Row {
    const row = this.row(id);
    if (!row) throw notFound();
    const now = this.clock.now();
    const deleteAnd = (failure: Failure): never => {
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      throw this.inTxn ? new CommitThenThrow(failure) : failure;
    };
    if (row.state === 'ended') {
      if (now - row.last_active_at > TOMBSTONE_TTL_MS) deleteAnd(notFound());
      throw new Failure(410, 'SESSION_ENDED', 'This demo was ended. Its conversation and demo data were deleted.');
    }
    if (row.state !== 'active' || this.expired(row, now)) deleteAnd(new Failure(410, 'SESSION_EXPIRED', 'This demo expired. Its conversation and demo data were deleted.'));
    return row;
  }
  private project(row: Pick<Row, 'document' | 'state' | 'last_active_at' | 'expires_at'>): DemoSession {
    const session = JSON.parse(row.document) as DemoSession;
    session.conversation ??= [];
    session.conversationVersion ??= 1;
    session.conversationTruncated ??= false;
    session.story ??= null;
    session.lastClientTurnId ??= null;
    session.state = row.state as DemoSession['state'];
    session.lastActiveAt = iso(row.last_active_at);
    session.expiresAt = iso(row.expires_at);
    return session;
  }

  create(description: unknown, scenario: unknown, operation: string, conversation?: unknown): DemoSession {
    const fixture: FixtureScenario = scenario === undefined || scenario === null ? 'recovered' : scenario as FixtureScenario;
    if (typeof description !== 'string' || !description.trim() || description.length > 4000 || !['recovered', 'exhausted'].includes(fixture) || !/^[a-zA-Z0-9-]{16,80}$/.test(operation)) throw new Failure(422, 'INVALID_SESSION', 'Enter a fictional project description (1–4000 characters), an optional supported starting fixture and a valid operation ID.');
    const turns = conversationOf(conversation);
    return this.txn(() => {
      const existing = this.db.prepare('SELECT id FROM sessions WHERE operation=?').get(operation) as { id: string } | undefined;
      if (existing) {
        const s = this.project(this.live(existing.id));
        if (s.description !== description.trim() || (s.version === 1 && s.dataset.activeScenario !== fixture)) throw new Failure(409, 'OPERATION_CONFLICT', 'This creation operation already has different input.');
        return s;
      }
      const id = randomUUID();
      const now = this.clock.now();
      const s: DemoSession = {
        id, description: description.trim(), createdAt: iso(now), version: 1, dataset: fixtures(id, fixture), conversation: turns,
        conversationVersion: 1, conversationTruncated: false, story: null, state: 'active',
        lastActiveAt: iso(now), expiresAt: iso(now + LIMITS.lifetimeMs), lastClientTurnId: null,
      };
      this.db.prepare("INSERT INTO sessions (id, operation, document, state, last_active_at, expires_at, last_turn) VALUES (?,?,?,'active',?,?,NULL)").run(id, operation, JSON.stringify(s), now, now + LIMITS.lifetimeMs);
      return s;
    });
  }
  /** Lifecycle check + refresh lastActiveAt. Used on authorised reads and turns. */
  touch(id: string): void {
    this.txn(() => {
      this.live(id);
      this.db.prepare('UPDATE sessions SET last_active_at=? WHERE id=?').run(this.clock.now(), id);
    });
  }
  read(id: string): DemoSession { return this.project(this.live(id)); }
  snapshot(id: string): SessionSnapshot {
    const s = this.read(id);
    return { id: s.id, version: s.version, conversationVersion: s.conversationVersion, story: s.story, dataset: s.dataset, conversation: s.conversation, state: s.state, expiresAt: s.expiresAt };
  }
  lastTurn(id: string): StoredTurn | null {
    const row = this.live(id);
    return row.last_turn ? JSON.parse(row.last_turn) as StoredTurn : null;
  }
  /** Developer inspection only: live sessions (tombstones and expired rows excluded). */
  list(): DemoSession[] {
    const now = this.clock.now();
    return (this.db.prepare("SELECT id, document, state, last_active_at, expires_at, last_turn FROM sessions WHERE state='active' ORDER BY rowid DESC").all() as unknown as Row[])
      .filter(r => !this.expired(r, now)).map(r => this.project(r));
  }

  appendTurns(id: string, turns: NewTurn[], opts: AppendOptions = {}): { session: DemoSession; appended: ChatTurn[] } {
    const clean = turns.map(checkTurn);
    if (clean.length > LIMITS.maxConversationTurns) throw new Failure(413, 'CONVERSATION_FULL', `A single append may hold at most ${LIMITS.maxConversationTurns} turns.`);
    return this.txn(() => {
      const row = this.live(id);
      const s = this.project(row);
      if (opts.expectedConversationVersion !== undefined && opts.expectedConversationVersion !== s.conversationVersion) throw new Failure(409, 'CONVERSATION_CONFLICT', 'The conversation changed. Reload it before sending again.');
      const now = this.clock.now();
      const appended: ChatTurn[] = clean.map(t => ({ ...t, id: randomUUID(), at: iso(now) }));
      let conversation = s.conversation.map(t => opts.settle && t.id === opts.settle.id ? { ...t, status: opts.settle.status } : t).concat(appended);
      let conversationTruncated = s.conversationTruncated;
      if (conversation.length > LIMITS.maxConversationTurns) { conversation = conversation.slice(-LIMITS.maxConversationTurns); conversationTruncated = true; }
      const next: DemoSession = { ...s, conversation, conversationTruncated, conversationVersion: s.conversationVersion + 1, lastActiveAt: iso(now) };
      if (opts.story !== undefined) next.story = opts.story;
      let lastTurn = row.last_turn;
      if (opts.respond) {
        const stored = opts.respond(appended, next);
        next.lastClientTurnId = stored.clientTurnId;
        lastTurn = JSON.stringify(stored);
      }
      this.db.prepare('UPDATE sessions SET document=?, last_active_at=?, last_turn=? WHERE id=?').run(JSON.stringify(next), now, lastTurn, id);
      return { session: next, appended };
    });
  }

  /** Validate → BEGIN IMMEDIATE → re-check state/version → UPDATE → COMMIT → independent readback. */
  publish(id: string, proposal: ScenarioProposal): PublishResult {
    let before: DemoSession;
    try { before = this.read(id); } catch (e) { if (isGone(e)) return { state: 'expired' }; throw e; }
    const verdict = validateProposal(id, before.dataset, proposal, this.clock);
    if (!verdict.ok) {
      const version = this.freshVersion(id);
      return version === null ? { state: 'expired' } : { state: 'rejected', problems: verdict.problems, version };
    }
    const expectedVersion = proposal.expectedVersion;
    type Outcome = { kind: 'expired' } | { kind: 'conflict'; current: number } | { kind: 'rejected'; result: PublishResult } | { kind: 'saved'; version: number; previous: number };
    let outcome: Outcome;
    try {
      outcome = this.txn((): Outcome => {
        const row = this.row(id);
        if (!row || row.state !== 'active') return { kind: 'expired' };
        if (this.expired(row)) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); return { kind: 'expired' }; }
        const s = this.project(row);
        if (s.version !== expectedVersion) return { kind: 'conflict', current: s.version };
        let dataset = verdict.dataset;
        if (s.version !== before.version) {
          const again = validateProposal(id, s.dataset, proposal, this.clock);
          if (!again.ok) return { kind: 'rejected', result: { state: 'rejected', problems: again.problems, version: s.version } };
          dataset = again.dataset;
        }
        if (this.faults.failSave?.()) throw new Error('Injected save failure.');
        const next: DemoSession = { ...s, version: s.version + 1, dataset };
        this.db.prepare("UPDATE sessions SET document=? WHERE id=? AND state='active'").run(JSON.stringify(next), id);
        return { kind: 'saved', version: next.version, previous: s.version };
      });
    } catch {
      const version = this.freshVersion(id);
      return version === null ? { state: 'expired' } : { state: 'save_failed', version, reason: 'The save transaction failed and was rolled back; the previous version is still live.' };
    }
    if (outcome.kind === 'expired') return { state: 'expired' };
    if (outcome.kind === 'conflict') return { state: 'conflict', currentVersion: outcome.current };
    if (outcome.kind === 'rejected') return outcome.result;
    try {
      if (this.faults.failReadback?.()) throw new Error('Injected readback failure.');
      const readback = this.readback(id, outcome.version);
      return { state: 'committed', version: readback.version, readback };
    } catch {
      return { state: 'readback_uncertain', attemptedVersion: outcome.version, lastKnownVersion: outcome.previous, reason: 'The save may have committed but could not be read back.' };
    }
  }
  /** Authoritative version through the independent reader; null when the session is gone or not active. */
  private freshVersion(id: string): number | null {
    const row = this.reader.prepare('SELECT document, state, last_active_at, expires_at FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row || row.state !== 'active') return null;
    return this.project(row).version;
  }
  /** Fresh SELECT on the independent connection, projected through the same list/detail functions as HTTP GET. */
  readback(id: string, expectedVersion: number): ReadbackEvidence {
    const row = this.reader.prepare('SELECT document, state, last_active_at, expires_at FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row || row.state !== 'active') throw new Error('Session not readable.');
    const session = this.project(row);
    if (session.version !== expectedVersion) throw new Error('Readback version mismatch.');
    const list = traceList(session, {});
    const details = list.traces.map(t => {
      const detail = findTrace(session, t.id);
      if (!detail) throw new Error('Trace detail missing on readback.');
      return detail;
    });
    return {
      version: list.version,
      activeScenario: list.activeScenario,
      traceIds: details.map(t => t.id),
      spanIds: details.flatMap(t => t.spans.map(s => s.id)),
      traces: details.map(t => ({
        id: t.id, key: t.scenario, label: t.label, outcome: t.outcome, outcomeKind: t.outcomeKind, spanCount: t.spans.length,
        rootDurationMs: rootOf(t).durationMs, errorSpanIds: t.spans.filter(s => s.status === 'ERROR').map(s => s.id),
      })),
    };
  }

  /** NIT-265 regression path: switch between the two canonical fixtures. */
  applyScenario(id: string, scenario: unknown, expectedVersion: unknown): DemoSession {
    if (scenario !== 'recovered' && scenario !== 'exhausted') throw new Failure(422, 'INVALID_SCENARIO', 'Choose the recovered or exhausted synthetic fixture.');
    if (typeof expectedVersion !== 'number') throw new Failure(422, 'INVALID_SCENARIO', 'Send the session version you read.');
    return this.txn(() => {
      const previous = this.project(this.live(id));
      if (expectedVersion !== previous.version) throw new Failure(409, 'STALE_VERSION', 'Version changed. The previous fixture is still saved.');
      const dataset = fixtures(id, scenario);
      if (datasetProblems(id, dataset).length) throw new Failure(422, 'INVALID_DATASET', 'Fixture rejected. Previous version retained.');
      const next = { ...previous, version: previous.version + 1, dataset };
      this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    });
  }
  /** Developer raw dataset path, validated by the same structural/coherence validator. */
  publishDataset(id: string, proposal: unknown): DemoSession {
    const p = proposal as { expectedVersion?: unknown; dataset?: unknown } | null;
    if (!p || typeof p !== 'object' || typeof p.expectedVersion !== 'number') throw new Failure(422, 'INVALID_DATASET', 'Send {expectedVersion, dataset}.');
    const problems = datasetProblems(id, p.dataset);
    return this.txn(() => {
      const previous = this.project(this.live(id));
      if (p.expectedVersion !== previous.version) throw new Failure(409, 'STALE_VERSION', 'Version changed. Read the current session before proposing again.');
      if (problems.length) throw new Failure(422, 'INVALID_DATASET', `Dataset rejected (${problems.slice(0, 3).map(x => `${x.code} at ${x.path || 'root'}`).join('; ')}). Previous version retained.`);
      const next = { ...previous, version: previous.version + 1, dataset: p.dataset as Dataset };
      this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    });
  }

  /** Idempotent End demo: conversation and dataset are deleted now; a content-free tombstone answers 410. */
  end(id: string): { ended: true } {
    this.txn(() => {
      const row = this.row(id);
      if (!row || row.state === 'ended') return;
      const now = this.clock.now();
      this.db.prepare("UPDATE sessions SET state='ended', document='{}', last_turn=NULL, last_active_at=?, expires_at=? WHERE id=?").run(now, now, id);
    });
    return { ended: true };
  }
  /** Deletes expired sessions and old tombstones without a revisit. */
  sweep(now = this.clock.now()): { expired: number; tombstones: number } {
    const expired = this.db.prepare("DELETE FROM sessions WHERE state != 'ended' AND (? - last_active_at > ? OR ? >= expires_at)").run(now, LIMITS.idleMs, now).changes;
    const tombstones = this.db.prepare("DELETE FROM sessions WHERE state = 'ended' AND ? - last_active_at > ?").run(now, TOMBSTONE_TTL_MS).changes;
    return { expired: Number(expired), tombstones: Number(tombstones) };
  }
  close() {
    if (this.reader !== this.db) this.reader.close();
    this.db.close();
  }
}

function checkTurn(turn: NewTurn): NewTurn {
  if (!turn || (turn.role !== 'buyer' && turn.role !== 'tailor') || !CHAT_STATUSES.includes(turn.status)) throw new Failure(422, 'INVALID_TURN', 'Each turn needs a buyer or tailor role and a known status.');
  if (typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > LIMITS.maxTurnTextChars) throw new Failure(422, 'TURN_TEXT_INVALID', `Each turn needs 1–${LIMITS.maxTurnTextChars} characters.`);
  const clean: NewTurn = { role: turn.role, text: turn.text.trim(), status: turn.status };
  if (turn.clarification) clean.clarification = turn.clarification;
  if (turn.evidence) clean.evidence = turn.evidence;
  return clean;
}

/** Validated initial transcript supplied at creation (legacy NIT-265 rows map role "adapter" to "tailor"). */
export function conversationOf(value: unknown): ChatTurn[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.maxConversationTurns) throw new Failure(422, 'INVALID_CONVERSATION', `A conversation can hold at most ${LIMITS.maxConversationTurns} messages.`);
  return value.map(turn => {
    const status = turn?.status;
    const role = turn?.role === 'adapter' ? 'tailor' : turn?.role;
    if (!turn || (role !== 'buyer' && role !== 'tailor') || !CHAT_STATUSES.includes(status)) throw new Failure(422, 'INVALID_CONVERSATION', 'Each message needs a buyer or tailor role and a known status.');
    if (typeof turn.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(turn.id) || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > LIMITS.maxTurnTextChars || typeof turn.at !== 'string' || Number.isNaN(Date.parse(turn.at))) throw new Failure(422, 'INVALID_CONVERSATION', `Each message needs an id, a time, and 1–${LIMITS.maxTurnTextChars} characters.`);
    return { id: turn.id, role, text: turn.text.trim(), status, at: turn.at };
  });
}

// ---------------------------------------------------------------------------
// Projections shared by HTTP GET routes, SessionTools and publish readback.
// ---------------------------------------------------------------------------
const QUERY_KEYS = ['q', 'scenario', 'detection', 'tag', 'minMs', 'maxMs'] as const;
export const rootOf = (t: Trace): Span => t.spans.find(s => s.parentId === null) ?? t.spans[0]!;

/** Validates raw filter input (URL strings or typed values) against the dataset's scenario keys. */
export function traceQuery(raw: Record<string, unknown>, scenarios: readonly string[]): TraceQuery {
  if (Object.keys(raw).some(k => !(QUERY_KEYS as readonly string[]).includes(k))) throw new Failure(400, 'UNSUPPORTED_FILTER', 'This filter is not supported.');
  const text = (key: string, max: number): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > max) throw new Failure(400, 'INVALID_FILTER', 'Unsupported filter value.');
    return v;
  };
  const num = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) throw new Failure(400, 'INVALID_FILTER', 'Latency bounds must be nonnegative and ordered.');
    return n;
  };
  const q: TraceQuery = {};
  const query = text('q', 200); if (query !== undefined) q.q = query;
  const scenario = text('scenario', 40);
  if (scenario !== undefined) { if (!scenarios.includes(scenario)) throw new Failure(400, 'INVALID_FILTER', 'Unsupported filter value.'); q.scenario = scenario; }
  const detection = text('detection', 3);
  if (detection !== undefined) { if (detection !== 'yes' && detection !== 'no') throw new Failure(400, 'INVALID_FILTER', 'Unsupported filter value.'); q.detection = detection; }
  const tag = text('tag', LIMITS.maxTagChars); if (tag !== undefined) q.tag = tag;
  const minMs = num('minMs'); if (minMs !== undefined) q.minMs = minMs;
  const maxMs = num('maxMs'); if (maxMs !== undefined) q.maxMs = maxMs;
  if (minMs !== undefined && maxMs !== undefined && maxMs < minMs) throw new Failure(400, 'INVALID_FILTER', 'Latency bounds must be nonnegative and ordered.');
  return q;
}
export function filterTraces(dataset: Dataset, q: TraceQuery): Trace[] {
  const needle = (q.q ?? '').toLowerCase();
  const min = q.minMs ?? 0; const max = q.maxMs ?? Infinity;
  return dataset.traces.filter(t => {
    const ms = rootOf(t).durationMs;
    return JSON.stringify(t).toLowerCase().includes(needle)
      && (!q.scenario || t.scenario === q.scenario)
      && (!q.tag || t.tags.includes(q.tag))
      && (!q.detection || t.spans.some(s => s.detection) === (q.detection === 'yes'))
      && ms >= min && ms <= max;
  });
}
export function traceList(session: DemoSession, q: TraceQuery = {}): TraceList {
  const traces = filterTraces(session.dataset, q);
  return { version: session.version, activeScenario: session.dataset.activeScenario, total: session.dataset.traces.length, filtered: traces.length, traces };
}
export const findTrace = (session: DemoSession, traceId: string): Trace | undefined => session.dataset.traces.find(t => t.id === traceId);
export const findSpan = (trace: Trace, spanId: string): Span | undefined => trace.spans.find(s => s.id === spanId);
