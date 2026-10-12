import { createEvidenceObserver, type EvidenceManifestSnapshot } from '../tailor/evidence.ts';
import { DEMO_SWITCH_CHOICES, type BrowserSession, type DemoSwitchChoice, type DemoSwitchConfirmation } from '../tailor/demo-contract.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatStatus, ChatTurn, Dataset, DemoSession, FixtureScenario, Span, Story, Trace, TraceList, TraceQuery } from '../clients/neatlogs/contracts.ts';
import {
  LIMITS, systemClock,
  type Clock, type ExecutionLabel, type PublishResult, type ReadbackEvidence, type ScenarioProposal, type SessionSnapshot, type TurnOutcome, type TurnResponse,
} from '../clients/neatlogs/agent-contract.ts';
import { fixtures } from '../clients/neatlogs/fixtures.ts';
import { CHAT_STATUSES, TOMBSTONE_TTL_MS, TURN_DEADLINE_MS, TURN_RUNS_PER_SESSION, isSessionExpired } from '../tailor/lifecycle.ts';
import { datasetProblems, storyProblems, validateProposal } from '../clients/neatlogs/validator.ts';

export class Failure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
/** Thrown inside a transaction when a lifecycle deletion must be committed before the failure surfaces. */
class CommitThenThrow extends Error {
  failure: Failure;
  constructor(failure: Failure) { super(failure.message); this.failure = failure; }
}

export { TOMBSTONE_TTL_MS, TURN_DEADLINE_MS, TURN_RUNS_PER_SESSION };

export interface PublishObserver { readback(read: () => ReadbackEvidence): ReadbackEvidence }
export interface StoreFaults { failSave?: () => boolean; failReadback?: () => boolean }
export interface StoreOptions { clock?: Clock; faults?: StoreFaults }
export interface StoredTurn { clientTurnId: string; response: TurnResponse }
/** Durable per-turn record: running (buyer turn stored) → published (dataset saved) → settled (response stored). */
export interface TurnRun {
  sessionId: string; clientTurnId: string;
  /** Empty for records imported from the legacy single `last_turn` column (no hash was kept). */
  requestHash: string;
  state: 'running' | 'published' | 'settled';
  turnId: string; buyerTurnId: string;
  startedVersion: number; startedConversationVersion: number; publishedVersion: number | null; startedAt: number;
  execution: ExecutionLabel; response: TurnResponse | null;
}
export interface BeginTurn { clientTurnId: string; requestHash: string; text: string; turnId: string; execution: ExecutionLabel }
interface RunRow {
  session_id: string; client_turn_id: string; request_hash: string; state: TurnRun['state']; turn_id: string; buyer_turn_id: string;
  started_version: number; started_conversation_version: number; published_version: number | null; started_at: number; execution: string; response: string | null;
}
const runOf = (r: RunRow): TurnRun => ({
  sessionId: r.session_id, clientTurnId: r.client_turn_id, requestHash: r.request_hash, state: r.state, turnId: r.turn_id, buyerTurnId: r.buyer_turn_id,
  startedVersion: r.started_version, startedConversationVersion: r.started_conversation_version, publishedVersion: r.published_version, startedAt: r.started_at,
  execution: JSON.parse(r.execution) as ExecutionLabel, response: r.response ? JSON.parse(r.response) as TurnResponse : null,
});
export type NewTurn = Omit<ChatTurn, 'id' | 'at'>;
export interface AppendOptions {
  expectedConversationVersion?: number;
  story?: Story | null;
  /** Update the status of an earlier turn (the pending buyer turn) in the same transaction. */
  settle?: { id: string; status: ChatStatus };
  /** Builds the idempotent turn record from the committed state; stored atomically with the append. */
  respond?: (appended: ChatTurn[], next: DemoSession) => StoredTurn;
}
interface BrowserRow { id: string; created_at: number; last_active_at: number; expires_at: number; version: number; active_demo_id: string | null }
interface PendingSwitchRow { id: string; demo_id: string; source_version: number; source_conversation_version: number; proposal: string; requested_text: string; consumed_by: string | null; resolved_demo_id: string | null; owner_version: number }
interface Row { owner_id: string | null; id: string; document: string; state: string; last_active_at: number; expires_at: number; last_turn: string | null }

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
    // secure_delete zeroes freed content; ended/expired content leaves the WAL at the checkpoint after deletion.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, document TEXT NOT NULL)');
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
    add('owner_id', 'TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL, active_demo_id TEXT);
      CREATE TABLE IF NOT EXISTS demo_switches (id TEXT PRIMARY KEY, demo_id TEXT NOT NULL, source_version INTEGER NOT NULL, source_conversation_version INTEGER NOT NULL, proposal TEXT NOT NULL, requested_text TEXT NOT NULL, consumed_by TEXT, resolved_demo_id TEXT, owner_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS demo_artifacts (demo_id TEXT NOT NULL, namespace TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(demo_id, namespace, artifact_id));`);
    add('state', "TEXT NOT NULL DEFAULT 'active'");
    add('last_active_at', 'INTEGER');
    add('expires_at', 'INTEGER');
    add('last_turn', 'TEXT');
    const switchColumns = (this.db.prepare('PRAGMA table_info(demo_switches)').all() as {name:string}[]).map(c => c.name);
    if (!switchColumns.includes('resolved_demo_id')) this.db.exec('ALTER TABLE demo_switches ADD COLUMN resolved_demo_id TEXT');
    if (!switchColumns.includes('owner_version')) this.db.exec('ALTER TABLE demo_switches ADD COLUMN owner_version INTEGER NOT NULL DEFAULT 1');
    const legacy = this.db.prepare('SELECT id, document FROM sessions WHERE last_active_at IS NULL OR expires_at IS NULL').all() as { id: string; document: string }[];
    const update = this.db.prepare('UPDATE sessions SET last_active_at=?, expires_at=? WHERE id=?');
    for (const row of legacy) {
      let created = 0;
      try { created = Date.parse((JSON.parse(row.document) as DemoSession).createdAt) || 0; } catch { created = 0; }
      update.run(created, created + LIMITS.lifetimeMs, row.id);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_runs (
      session_id TEXT NOT NULL, client_turn_id TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL,
      turn_id TEXT NOT NULL, buyer_turn_id TEXT NOT NULL, started_version INTEGER NOT NULL, started_conversation_version INTEGER NOT NULL,
      published_version INTEGER, started_at INTEGER NOT NULL, execution TEXT NOT NULL, response TEXT,
      PRIMARY KEY (session_id, client_turn_id))`);
    // Pre-turn_runs databases kept one settled record per session in sessions.last_turn: import it once, then clear it.
    const lastTurns = this.db.prepare('SELECT id, last_turn, last_active_at FROM sessions WHERE last_turn IS NOT NULL').all() as { id: string; last_turn: string; last_active_at: number }[];
    const importRun = this.db.prepare("INSERT OR IGNORE INTO turn_runs VALUES (?, ?, '', 'settled', ?, '', ?, ?, ?, ?, ?, ?)");
    for (const row of lastTurns) {
      try {
        const stored = JSON.parse(row.last_turn) as StoredTurn;
        const r = stored.response;
        importRun.run(row.id, stored.clientTurnId, r.turnId, r.version, r.conversationVersion, r.version, row.last_active_at, JSON.stringify(r.execution), JSON.stringify(r));
      } catch { /* unreadable legacy record: nothing to replay */ }
    }
    this.db.exec('UPDATE sessions SET last_turn=NULL WHERE last_turn IS NOT NULL');
  }
  private purgeRuns(id: string) {
    this.db.prepare('DELETE FROM turn_runs WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM demo_switches WHERE demo_id=?').run(id);
    this.db.prepare('DELETE FROM demo_artifacts WHERE demo_id=?').run(id);
    this.db.prepare('UPDATE browser_sessions SET active_demo_id=NULL, version=version+1 WHERE active_demo_id=?').run(id);
  }
  /** Moves committed pages into the main file and truncates the WAL, so deleted content is not left in the log. */
  private checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the next checkpoint completes it */ } }

  token(id: string) { return createHmac('sha256', this.secret).update(id).digest('hex'); }
  browserCookie(id: string) { return `browser.${id}.${this.token(`browser:${id}`)}`; }
  private sameCookie(actual: string, expected: string) {
    const a = Buffer.from(actual); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  /** Returns the owner id (legacy callers use the demo id); never trusts a caller-supplied demo list. */
  authorize(id: string, cookie: string): string {
    if (cookie.startsWith('browser.')) {
      const ownerId = cookie.split('.')[1] ?? '';
      if (!this.sameCookie(cookie, this.browserCookie(ownerId))) throw notFound();
      this.browserRow(ownerId);
      const row = this.row(id);
      if (!row || row.owner_id !== ownerId) throw notFound();
      return ownerId;
    }
    if (!this.sameCookie(cookie, `${id}.${this.token(id)}`)) throw notFound();
    const ownerId = this.row(id)?.owner_id;
    if (ownerId) this.browserRow(ownerId);
    return ownerId ?? id;
  }
  ownerOf(id: string): string | null { return this.row(id)?.owner_id ?? null; }
  private browserRow(id: string): BrowserRow {
    const row = this.db.prepare('SELECT * FROM browser_sessions WHERE id=?').get(id) as BrowserRow | undefined;
    if (!row) throw notFound();
    if (isSessionExpired(row.last_active_at, row.expires_at, this.clock.now())) {
      const remove = () => {
        const demos = this.db.prepare('SELECT id FROM sessions WHERE owner_id=?').all(id) as {id:string}[];
        for (const demo of demos) this.purgeRuns(demo.id);
        this.db.prepare('DELETE FROM sessions WHERE owner_id=?').run(id);
        this.db.prepare('DELETE FROM browser_sessions WHERE id=?').run(id);
      };
      if (this.inTxn) remove(); else this.txn(remove);
      if (this.inTxn) throw new CommitThenThrow(new Failure(410, 'SESSION_EXPIRED', 'This browser session expired. Its demo data was deleted.'));
      this.checkpoint();
      throw new Failure(410, 'SESSION_EXPIRED', 'This browser session expired. Its demo data was deleted.');
    }
    return row;
  }
  /** Upgrade only a verified legacy cookie; invalid/nonempty cookies never silently create an owner. */
  browserForCookie(cookie: string, upgradeLegacy = false): string | null {
    if (!cookie) return null;
    if (cookie.startsWith('browser.')) {
      const id = cookie.split('.')[1] ?? '';
      if (!this.sameCookie(cookie, this.browserCookie(id))) throw notFound();
      this.browserRow(id); return id;
    }
    const demoId = cookie.split('.')[0] ?? '';
    this.authorize(demoId, cookie); this.live(demoId);
    const known = this.ownerOf(demoId);
    if (known || !upgradeLegacy) return known;
    return this.txn(() => {
      const row = this.live(demoId);
      if (row.owner_id) return row.owner_id;
      const id = randomUUID(); const now = this.clock.now();
      const created = Date.parse(this.project(row).createdAt);
      this.db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?,1,?)').run(id, created, now, row.expires_at, demoId);
      this.db.prepare('UPDATE sessions SET owner_id=? WHERE id=?').run(id, demoId);
      return id;
    });
  }
  private newBrowser(): string {
    const id = randomUUID(); const now = this.clock.now();
    this.db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?,1,NULL)').run(id, now, now, now + LIMITS.lifetimeMs);
    return id;
  }
  browserSession(id: string): BrowserSession {
    const row = this.browserRow(id);
    const demos = (this.db.prepare("SELECT id, owner_id, document, state, last_active_at, expires_at, last_turn FROM sessions WHERE owner_id=? AND state='active' ORDER BY rowid").all(id) as unknown as Row[])
      .filter(d => !this.expired(d)).map(d => this.project(d));
    return { id, state: 'active', createdAt: iso(row.created_at), lastActiveAt: iso(row.last_active_at), expiresAt: iso(row.expires_at), version: row.version,
      activeDemoId: demos.some(d => d.id === row.active_demo_id) ? row.active_demo_id : null,
      demos: demos.map(d => ({ id: d.id, productId: 'neatlogs', label: (d.story?.domain ?? d.description).slice(0, 120), version: d.version, conversationVersion: d.conversationVersion, createdAt: d.createdAt, lastActiveAt: d.lastActiveAt })) };
  }
  touchBrowser(id: string): void {
    this.txn(() => { this.browserRow(id); this.db.prepare('UPDATE browser_sessions SET last_active_at=? WHERE id=?').run(this.clock.now(), id); });
  }
  createOwned(ownerId: string | null, description: unknown, scenario: unknown, operation: string, conversation?: unknown): { session: DemoSession; ownerId: string } {
    if (ownerId) this.browserRow(ownerId);
    const existing = this.db.prepare('SELECT id, owner_id FROM sessions WHERE operation=?').get(operation) as { id:string;owner_id:string|null } | undefined;
    if (existing && existing.owner_id !== ownerId) throw new Failure(409, 'OPERATION_CONFLICT', 'This creation operation belongs to another browser session.');
    if (ownerId && this.browserSession(ownerId).demos.length >= 8 && !existing) throw new Failure(422, 'DEMO_LIMIT', 'This browser already has eight demos. End one before creating another.');
    const session = this.create(description, scenario, operation, conversation);
    const owner = this.atomic(() => {
      const id = ownerId ?? this.newBrowser(); const row = this.browserRow(id);
      if (this.ownerOf(session.id) && this.ownerOf(session.id) !== id) throw notFound();
      this.db.prepare('UPDATE sessions SET owner_id=?, expires_at=MIN(expires_at,?) WHERE id=?').run(id, row.expires_at, session.id);
      if (row.active_demo_id !== session.id) this.db.prepare('UPDATE browser_sessions SET active_demo_id=?, version=version+1, last_active_at=? WHERE id=?').run(session.id, this.clock.now(), id);
      return id;
    });
    return { session: this.read(session.id), ownerId: owner };
  }
  selectDemo(ownerId: string, demoId: unknown, expectedVersion: unknown): BrowserSession {
    this.txn(() => {
      const row = this.browserRow(ownerId);
      if (expectedVersion !== row.version) throw new Failure(409, 'STALE_VERSION', 'The browser selection changed. Reload before switching demos.');
      if (typeof demoId !== 'string' || this.ownerOf(demoId) !== ownerId) throw notFound();
      this.live(demoId);
      if (row.active_demo_id !== demoId) this.db.prepare('UPDATE browser_sessions SET active_demo_id=?, version=version+1, last_active_at=? WHERE id=?').run(demoId, this.clock.now(), ownerId);
    });
    return this.browserSession(ownerId);
  }


  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTxn = true;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      if (e instanceof CommitThenThrow) { this.db.exec('COMMIT'); this.inTxn = false; this.checkpoint(); throw e.failure; }
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally { this.inTxn = false; }
  }
  private atomic<T>(fn: () => T): T { return this.inTxn ? fn() : this.txn(fn); }
  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT id, owner_id, document, state, last_active_at, expires_at, last_turn FROM sessions WHERE id=?').get(id) as Row | undefined;
  }
  private expired(row: Row, now = this.clock.now()) { return isSessionExpired(row.last_active_at, row.expires_at, now); }
  /** Server-clock lifecycle gate. Expired rows are deleted on access; ended rows are tombstones. */
  private live(id: string): Row {
    const row = this.row(id);
    if (!row) throw notFound();
    const now = this.clock.now();
    const deleteAnd = (failure: Failure): never => {
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      this.purgeRuns(id);
      if (this.inTxn) throw new CommitThenThrow(failure);
      this.checkpoint();
      throw failure;
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
    return this.atomic(() => {
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
  /** Most recent settled turn (kept for callers of the pre-turn_runs API). */
  lastTurn(id: string): StoredTurn | null {
    this.live(id);
    const r = this.db.prepare("SELECT * FROM turn_runs WHERE session_id=? AND state='settled' ORDER BY rowid DESC LIMIT 1").get(id) as RunRow | undefined;
    return r?.response ? { clientTurnId: r.client_turn_id, response: JSON.parse(r.response) as TurnResponse } : null;
  }
  private runRow(id: string, clientTurnId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM turn_runs WHERE session_id=? AND client_turn_id=?').get(id, clientTurnId) as RunRow | undefined;
  }
  /** The durable run for this clientTurnId, or null. A different request body under the same ID is a 409. */
  findRun(id: string, clientTurnId: string, requestHash: string): TurnRun | null {
    this.live(id);
    const r = this.runRow(id, clientTurnId);
    if (!r) return null;
    if (r.request_hash && r.request_hash !== requestHash) throw new Failure(409, 'IDEMPOTENCY_MISMATCH', 'This clientTurnId was already used for a different message. Send a new clientTurnId.');
    return runOf(r);
  }
  /**
   * First turn transaction: store the pending buyer turn AND the durable running record together, so a crash at any
   * later point leaves something a retry or the sweep can settle. Orphaned runs of the session are settled first
   * (the caller guarantees no run of this session is executing in this process).
   */
  beginTurn(id: string, turn: BeginTurn): { run: TurnRun; buyer: ChatTurn; session: DemoSession } {
    const [buyerTurn] = [{ role: 'buyer', text: turn.text, status: 'pending' } as NewTurn].map(checkTurn);
    return this.txn(() => {
      this.live(id);
      if (this.runRow(id, turn.clientTurnId)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Tailor is still working on your previous message.');
      for (const orphan of this.db.prepare("SELECT * FROM turn_runs WHERE session_id=? AND state != 'settled'").all(id) as unknown as RunRow[]) this.settleIn(id, runOf(orphan));
      const row = this.live(id);
      const before = this.project(row);
      const { session, appended: [buyer] } = this.appendIn(id, row, [buyerTurn!], {});
      this.db.prepare("INSERT INTO turn_runs VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL, ?, ?, NULL)")
        .run(id, turn.clientTurnId, turn.requestHash, turn.turnId, buyer!.id, before.version, before.conversationVersion, this.clock.now(), JSON.stringify(turn.execution));
      return { run: runOf(this.runRow(id, turn.clientTurnId)!), buyer: buyer!, session };
    });
  }
  /** Settles an interrupted (running/published) run without re-running it; returns the stored response. */
  recoverRun(id: string, clientTurnId: string): TurnResponse {
    return this.txn(() => {
      this.live(id);
      const r = this.runRow(id, clientTurnId);
      if (!r) throw notFound();
      const run = runOf(r);
      return run.state === 'settled' ? run.response! : this.settleIn(id, run);
    });
  }
  /** In-transaction settlement of an interrupted run: truthful about whether the authoritative version moved. */
  private settleIn(id: string, run: TurnRun): TurnResponse {
    const row = this.live(id);
    const switchRow = this.db.prepare('SELECT * FROM demo_switches WHERE demo_id=? AND consumed_by=?').get(id, run.clientTurnId) as PendingSwitchRow | undefined;
    const targetId = switchRow?.resolved_demo_id && switchRow.resolved_demo_id !== id ? switchRow.resolved_demo_id : id;
    const targetRow = targetId !== id ? this.row(targetId) : row;
    const target = targetRow?.state === 'active' ? this.project(targetRow) : null;
    const current = target?.version ?? this.project(row).version;
    const moved = run.state === 'published' || current > run.startedVersion;
    const outcome: TurnOutcome = moved ? 'readback_uncertain' : 'provider_unavailable';
    const status: ChatStatus = moved ? 'uncertain' : 'failed';
    const text = run.state === 'published'
      ? `Tailor was interrupted after saving version ${run.publishedVersion} for this request and could not confirm it. The demo now reports version ${current}; reload it before relying on the change.`
      : moved
        ? `Tailor was interrupted and could not confirm whether this request was saved. The demo now reports version ${current}; reload it before relying on the change.`
        : `Tailor was interrupted before finishing this request, so nothing changed. Version ${current} is still live.`;
    const recoveredTarget = target && target.id !== id && targetRow && target.conversation.length === 0
      ? this.appendIn(target.id, targetRow, [{ role: 'buyer', text: switchRow!.requested_text, status }, { role: 'tailor', text, status }], {}).session
      : target;
    const { session, appended } = this.appendIn(id, row, [{ role: 'tailor', text, status }], { settle: { id: run.buyerTurnId, status } });
    const buyer = session.conversation.find(t => t.id === run.buyerTurnId);
    const response: TurnResponse = {
      turnId: run.turnId, outcome, version: current, conversationVersion: recoveredTarget?.conversationVersion ?? session.conversationVersion,
      ...(this.ownerOf(id) ? { demoId: target?.id ?? id, sessionId: this.ownerOf(id)! } : {}),
      messages: [...(buyer ? [buyer] : []), ...appended],
      steps: [{ name: 'model', status: 'failed', detail: 'Tailor was interrupted before this turn finished.' }],
      execution: run.execution,
    };
    this.settleRun(id, run.clientTurnId, response);
    return response;
  }
  private settleRun(id: string, clientTurnId: string, response: TurnResponse) {
    const updated = this.db.prepare("UPDATE turn_runs SET state='settled', response=? WHERE session_id=? AND client_turn_id=?").run(JSON.stringify(response), id, clientTurnId);
    if (Number(updated.changes) === 0) {
      this.db.prepare("INSERT INTO turn_runs VALUES (?, ?, '', 'settled', ?, '', ?, ?, ?, ?, ?, ?)")
        .run(id, clientTurnId, response.turnId, response.version, response.conversationVersion, response.version, this.clock.now(), JSON.stringify(response.execution), JSON.stringify(response));
    }
    this.db.prepare(`DELETE FROM turn_runs WHERE session_id=? AND state='settled' AND rowid NOT IN
      (SELECT rowid FROM turn_runs WHERE session_id=? AND state='settled' ORDER BY rowid DESC LIMIT ?)`).run(id, id, TURN_RUNS_PER_SESSION);
    this.db.prepare("DELETE FROM demo_artifacts WHERE demo_id=? AND namespace='turn-evidence' AND artifact_id NOT IN (SELECT client_turn_id FROM turn_runs WHERE session_id=?)").run(id, id);
    this.db.prepare('DELETE FROM demo_switches WHERE demo_id=? AND consumed_by IS NOT NULL AND consumed_by NOT IN (SELECT client_turn_id FROM turn_runs WHERE session_id=?)').run(id, id);
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
    return this.txn(() => this.appendIn(id, this.live(id), clean, opts));
  }
  /** Append inside an open transaction. `respond` also settles the turn's durable run with the stored response. */
  private appendIn(id: string, row: Row, clean: NewTurn[], opts: AppendOptions): { session: DemoSession; appended: ChatTurn[] } {
    const s = this.project(row);
    if (opts.expectedConversationVersion !== undefined && opts.expectedConversationVersion !== s.conversationVersion) throw new Failure(409, 'CONVERSATION_CONFLICT', 'The conversation changed. Reload it before sending again.');
    const now = this.clock.now();
    const appended: ChatTurn[] = clean.map(t => ({ ...t, id: randomUUID(), at: iso(now) }));
    let conversation = s.conversation.map(t => opts.settle && t.id === opts.settle.id ? { ...t, status: opts.settle.status } : t).concat(appended);
    let conversationTruncated = s.conversationTruncated;
    if (conversation.length > LIMITS.maxConversationTurns) { conversation = conversation.slice(-LIMITS.maxConversationTurns); conversationTruncated = true; }
    const next: DemoSession = { ...s, conversation, conversationTruncated, conversationVersion: s.conversationVersion + 1, lastActiveAt: iso(now) };
    if (opts.story !== undefined) next.story = opts.story;
    if (opts.respond) {
      const stored = opts.respond(appended, next);
      next.lastClientTurnId = stored.clientTurnId;
      this.settleRun(id, stored.clientTurnId, stored.response);
    }
    this.db.prepare('UPDATE sessions SET document=?, last_active_at=? WHERE id=?').run(JSON.stringify(next), now, id);
    return { session: next, appended };
  }

  listArtifacts<T>(demoId: string, namespace: string): T[] {
    this.live(demoId);
    return (this.db.prepare('SELECT document FROM demo_artifacts WHERE demo_id=? AND namespace=? ORDER BY rowid').all(demoId, namespace) as {document:string}[]).map(r => JSON.parse(r.document) as T);
  }
  readArtifact<T>(demoId: string, namespace: string, id: string): T | null {
    this.live(demoId);
    const row = this.db.prepare('SELECT document FROM demo_artifacts WHERE demo_id=? AND namespace=? AND artifact_id=?').get(demoId, namespace, id) as {document:string} | undefined;
    return row ? JSON.parse(row.document) as T : null;
  }
  compareAndSetArtifact<T>(demoId: string, namespace: string, id: string, expectedVersion: number | null, next: T): boolean {
    return this.atomic(() => {
      this.live(demoId);
      const document = JSON.stringify(next);
      if (Buffer.byteLength(document) > 512_000) throw new Failure(422, 'ARTIFACT_LIMIT', 'This local artifact is too large.');
      if (expectedVersion === null) return Number(this.db.prepare('INSERT OR IGNORE INTO demo_artifacts VALUES (?,?,?,1,?)').run(demoId, namespace, id, document).changes) === 1;
      return Number(this.db.prepare('UPDATE demo_artifacts SET version=version+1, document=? WHERE demo_id=? AND namespace=? AND artifact_id=? AND version=?').run(document, demoId, namespace, id, expectedVersion).changes) === 1;
    });
  }
  readTurnEvidence(demoId: string, clientTurnId: string): EvidenceManifestSnapshot | undefined {
    return this.readArtifact<EvidenceManifestSnapshot>(demoId, 'turn-evidence', clientTurnId) ?? undefined;
  }
  saveTurnEvidence(demoId: string, clientTurnId: string, manifest: EvidenceManifestSnapshot): void {
    const safe = createEvidenceObserver({ manifest }).snapshot();
    this.live(demoId);
    this.db.prepare("INSERT INTO demo_artifacts VALUES (?, 'turn-evidence', ?, 1, ?) ON CONFLICT(demo_id,namespace,artifact_id) DO UPDATE SET document=excluded.document").run(demoId, clientTurnId, JSON.stringify(safe));
  }
  /** Store the exact validated candidate; choices cannot authorize a later model-generated replacement. */
  prepareScenario(id: string, proposal: ScenarioProposal, requestedText: string): { state: 'ready' } | { state: 'confirmation_required'; confirmation: DemoSwitchConfirmation } {
    const session = this.read(id);
    if (!this.ownerOf(id) || proposal.mode !== 'new' || session.version === 1 || proposal.expectedVersion !== session.version) return { state: 'ready' };
    if (!validateProposal(id, session.dataset, proposal, this.clock).ok) return { state: 'ready' };
    const ref = randomUUID();
    const confirmation: DemoSwitchConfirmation = {
      kind: 'demo_switch', referenceId: ref, sourceDemoId: id, sourceVersion: session.version, browserSessionVersion: this.browserRow(this.ownerOf(id)!).version,
      sourceConversationVersion: session.conversationVersion + 1,
      requestedSummary: proposal.story.domain.slice(0, 120),
      question: 'This changes the workflow. Adapt the current demo, start a separate demo, or keep the current one?',
      choices: [{ id: 'adapt_current', label: 'Adapt current demo' }, { id: 'start_separate', label: 'Start separate demo' }, { id: 'keep_current', label: 'Keep current demo' }], allowFreeText: true,
    };
    this.txn(() => {
      const current = this.project(this.live(id));
      if (current.version !== session.version || current.conversationVersion !== session.conversationVersion) throw new Failure(409, 'STALE_CONFIRMATION', 'The demo changed. Ask again before switching it.');
      this.db.prepare('DELETE FROM demo_switches WHERE demo_id=? AND consumed_by IS NULL').run(id);
      this.db.prepare('INSERT INTO demo_switches VALUES (?,?,?,?,?,?,NULL,NULL,?)').run(ref, id, session.version, confirmation.sourceConversationVersion, JSON.stringify(proposal), requestedText.slice(0, LIMITS.maxTurnTextChars), confirmation.browserSessionVersion);
    });
    return { state: 'confirmation_required', confirmation };
  }
  assertSwitch(id: string, ref: string, choice: unknown): void {
    if (!(DEMO_SWITCH_CHOICES as readonly unknown[]).includes(choice)) throw new Failure(422, 'INVALID_CONFIRMATION', 'Choose one of the three saved confirmation options.');
    const pending = this.db.prepare('SELECT * FROM demo_switches WHERE id=? AND demo_id=?').get(ref, id) as PendingSwitchRow | undefined;
    const session = this.read(id);
    if (!pending || pending.consumed_by !== null || !this.ownerOf(id) || pending.source_version !== session.version || pending.source_conversation_version !== session.conversationVersion || pending.owner_version !== this.browserRow(this.ownerOf(id)!).version) throw new Failure(409, 'STALE_CONFIRMATION', 'This confirmation is no longer current. Ask again before switching the demo.');
  }
  resolveSwitch(id: string, ref: string, choice: DemoSwitchChoice, clientTurnId: string, observer?: PublishObserver): { demoId: string; requestedText: string; result: PublishResult | null } {
    const pending = this.db.prepare('SELECT * FROM demo_switches WHERE id=? AND demo_id=?').get(ref, id) as PendingSwitchRow | undefined;
    const source = this.read(id);
    if (!pending || pending.consumed_by !== null || pending.source_version !== source.version || pending.source_conversation_version + 1 !== source.conversationVersion || pending.owner_version !== this.browserRow(this.ownerOf(id)!).version) throw new Failure(409, 'STALE_CONFIRMATION', 'The demo changed before confirmation. Ask again.');
    const owner = this.ownerOf(id);
    if (!owner) throw notFound();
    const proposal = JSON.parse(pending.proposal) as ScenarioProposal;
    if (choice === 'keep_current') {
      this.txn(() => { this.db.prepare('UPDATE demo_switches SET consumed_by=?, resolved_demo_id=? WHERE id=? AND consumed_by IS NULL').run(clientTurnId, id, ref); });
      return { demoId: id, requestedText: pending.requested_text, result: null };
    }
    if (choice === 'adapt_current') return { demoId: id, requestedText: pending.requested_text, result: this.publish(id, proposal, { clientTurnId, confirmationRef: ref }, observer) };
    let targetId = id; let before = 1; let version = 1;
    try {
      this.txn(() => {
        const current = this.project(this.live(id));
        if (current.version !== pending.source_version || current.conversationVersion !== pending.source_conversation_version + 1) throw new Failure(409, 'STALE_CONFIRMATION', 'The demo changed before confirmation. Ask again.');
        if (this.faults.failSave?.()) throw new Error('Injected save failure.');
        const target = this.createOwned(owner, pending.requested_text, undefined, `switch-${ref}`).session;
        targetId = target.id; before = target.version;
        const verdict = validateProposal(target.id, target.dataset, { ...proposal, expectedVersion: target.version }, this.clock);
        if (!verdict.ok) throw new Failure(422, 'INVALID_DATASET', 'The separate demo failed validation.');
        version = target.version + 1;
        const next = { ...target, version, dataset: verdict.dataset, story: proposal.story };
        this.db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(next), target.id);
        this.db.prepare("UPDATE turn_runs SET state='published', published_version=? WHERE session_id=? AND client_turn_id=? AND state='running'").run(version, id, clientTurnId);
        this.db.prepare('UPDATE demo_switches SET consumed_by=?, resolved_demo_id=? WHERE id=? AND consumed_by IS NULL').run(clientTurnId, target.id, ref);
      });
    } catch (error) {
      if (error instanceof Failure && error.code === 'STALE_CONFIRMATION') throw error;
      return { demoId: id, requestedText: pending.requested_text, result: { state: 'save_failed', version: source.version, reason: 'The separate demo could not be saved; the current demo is unchanged.' } };
    }
    try {
      const readback = this.verifiedReadback(targetId, version, observer);
      return { demoId: targetId, requestedText: pending.requested_text, result: { state: 'committed', version, readback } };
    } catch {
      return { demoId: targetId, requestedText: pending.requested_text, result: { state: 'readback_uncertain', attemptedVersion: version, lastKnownVersion: before, reason: 'The separate demo may have been saved, but could not be read back.' } };
    }
  }

  /**
   * Validate → BEGIN IMMEDIATE → re-check state/version → UPDATE dataset + story (+ mark the turn run published)
   * → COMMIT → independent readback.
   */
  publish(id: string, proposal: ScenarioProposal, turn?: { clientTurnId: string; confirmationRef?: string }, observer?: PublishObserver): PublishResult {
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
        if (this.expired(row)) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); this.purgeRuns(id); return { kind: 'expired' }; }
        const s = this.project(row);
        if (s.version !== expectedVersion) return { kind: 'conflict', current: s.version };
        if (this.ownerOf(id) && proposal.mode === 'new' && s.version > 1) {
          const pending = turn?.confirmationRef ? this.db.prepare('SELECT * FROM demo_switches WHERE id=? AND demo_id=?').get(turn.confirmationRef, id) as PendingSwitchRow | undefined : undefined;
          if (!pending || pending.consumed_by !== null || pending.source_version !== s.version || pending.source_conversation_version + 1 !== s.conversationVersion || pending.owner_version !== this.browserRow(this.ownerOf(id)!).version || pending.proposal !== JSON.stringify(proposal)) return { kind: 'rejected', result: { state: 'rejected', version: s.version, problems: [{ path: 'mode', code: 'UNSUPPORTED_CAPABILITY', message: 'Confirm how to switch this workflow before replacing the current demo.' }] } };
        }

        let dataset = verdict.dataset;
        if (s.version !== before.version) {
          const again = validateProposal(id, s.dataset, proposal, this.clock);
          if (!again.ok) return { kind: 'rejected', result: { state: 'rejected', problems: again.problems, version: s.version } };
          dataset = again.dataset;
        }
        if (this.faults.failSave?.()) throw new Error('Injected save failure.');
        const next: DemoSession = { ...s, version: s.version + 1, dataset };
        if (storyProblems(proposal.story).length === 0) next.story = proposal.story;
        this.db.prepare("UPDATE sessions SET document=? WHERE id=? AND state='active'").run(JSON.stringify(next), id);
        if (turn) this.db.prepare("UPDATE turn_runs SET state='published', published_version=? WHERE session_id=? AND client_turn_id=? AND state != 'settled'").run(next.version, id, turn.clientTurnId);
        if (turn?.confirmationRef) this.db.prepare('UPDATE demo_switches SET consumed_by=?, resolved_demo_id=? WHERE id=? AND demo_id=? AND consumed_by IS NULL').run(turn.clientTurnId, id, turn.confirmationRef, id);
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
      const readback = this.verifiedReadback(id, outcome.version, observer);
      return { state: 'committed', version: readback.version, readback };
    } catch {
      return { state: 'readback_uncertain', attemptedVersion: outcome.version, lastKnownVersion: outcome.previous, reason: 'The save may have committed but could not be read back.' };
    }
  }
  private verifiedReadback(id: string, version: number, observer?: PublishObserver): ReadbackEvidence {
    const read = () => {
      if (this.faults.failReadback?.()) throw new Error('Injected readback failure.');
      return this.readback(id, version);
    };
    return observer ? observer.readback(read) : read();
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

  /**
   * Idempotent End demo: conversation, dataset and turn records are deleted now; a content-free tombstone answers 410.
   * With secure_delete and the WAL checkpoint the content is also physically gone from the database files.
   */
  end(id: string): { ended: true } {
    const changed = this.txn(() => {
      const row = this.row(id);
      if (!row || row.state === 'ended') return false;
      const now = this.clock.now();
      this.db.prepare("UPDATE sessions SET state='ended', document='{}', last_turn=NULL, last_active_at=?, expires_at=? WHERE id=?").run(now, now, id);
      this.purgeRuns(id);
      return true;
    });
    if (changed) this.checkpoint();
    return { ended: true };
  }
  /**
   * Deletes expired sessions, old tombstones and their turn records without a revisit, then settles runs that
   * outlived TURN_DEADLINE_MS (interrupted by a crash or restart) so no Pending bubble stays forever.
   */
  sweep(now = this.clock.now()): { expired: number; tombstones: number; interrupted: number } {
    const { expired, tombstones, interrupted } = this.txn(() => {
      const expired = this.db.prepare("DELETE FROM sessions WHERE state != 'ended' AND (? - last_active_at > ? OR ? >= expires_at)").run(now, LIMITS.idleMs, now).changes;
      const tombstones = this.db.prepare("DELETE FROM sessions WHERE state = 'ended' AND ? - last_active_at > ?").run(now, TOMBSTONE_TTL_MS).changes;
      const orphanedRuns = this.db.prepare("DELETE FROM turn_runs WHERE session_id NOT IN (SELECT id FROM sessions WHERE state = 'active')").run().changes;
      this.db.prepare("DELETE FROM demo_switches WHERE demo_id NOT IN (SELECT id FROM sessions WHERE state='active')").run();
      this.db.prepare("DELETE FROM demo_artifacts WHERE demo_id NOT IN (SELECT id FROM sessions WHERE state='active')").run();
      const owners = this.db.prepare('SELECT id FROM browser_sessions WHERE ? - last_active_at > ? OR ? >= expires_at').all(now, LIMITS.idleMs, now) as {id:string}[];
      let ownerExpired = 0;
      for (const owner of owners) {
        const children = this.db.prepare('SELECT id FROM sessions WHERE owner_id=?').all(owner.id) as {id:string}[];
        for (const child of children) this.purgeRuns(child.id);
        ownerExpired += Number(this.db.prepare('DELETE FROM sessions WHERE owner_id=?').run(owner.id).changes);
        this.db.prepare('DELETE FROM browser_sessions WHERE id=?').run(owner.id);
      }
      const stale = this.db.prepare("SELECT * FROM turn_runs WHERE state != 'settled' AND started_at < ?").all(now - TURN_DEADLINE_MS) as unknown as RunRow[];
      let interrupted = 0;
      for (const r of stale) { try { this.settleIn(r.session_id, runOf(r)); interrupted++; } catch (e) { if (!(e instanceof CommitThenThrow) && !isGone(e)) throw e; } }
      return { expired: Number(expired) + ownerExpired, tombstones: Number(tombstones), interrupted, purged: Number(orphanedRuns) };
    });
    if (expired + tombstones > 0) this.checkpoint();
    return { expired, tombstones, interrupted };
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
