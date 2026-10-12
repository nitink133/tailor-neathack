import { createHash } from 'node:crypto';
import type { DemoSession } from './contracts.ts';
import { ROUTING_DESTINATIONS, ROUTING_RECIPIENTS, ROUTING_SCHEMA_VERSION,
  type RoutingDetail, type RoutingPreview, type RoutingRepository, type RoutingRule, type RoutingService, type StoredRoutingPreview } from './routing-contract.ts';

export class RoutingError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status=status; this.code=code; }
}
const invalid = (message: string): never => { throw new RoutingError(400, 'ROUTING_INVALID', message); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function object(v: unknown, keys: string[]) {
  if (!isObject(v) || Object.keys(v).some(k => !keys.includes(k))) return invalid('Unexpected routing fields.');
  return v;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function active(session: DemoSession, now: Date) {
  if (session.state !== 'active' || Date.parse(session.expiresAt) <= now.getTime()) throw new RoutingError(410,'SESSION_EXPIRED','This demo has ended or expired.');
}
const detail = (stored: StoredRoutingPreview, session: DemoSession): RoutingDetail => ({preview:structuredClone(stored.preview),stale:stored.preview.datasetVersion !== session.version});

/** Adapter-local deterministic preview. No connections, arbitrary destinations, dispatch, or executable predicates. */
export function createRoutingService(repository: RoutingRepository, options: {now?: () => Date} = {}): RoutingService {
  const now = options.now ?? (() => new Date());
  const read = (session: DemoSession, id: string) => {
    const stored = repository.read(session.id,id);
    if (!stored) throw new RoutingError(404,'ROUTING_NOT_FOUND','Routing preview not found in this demo.');
    return stored;
  };
  const replay = (stored: StoredRoutingPreview, fingerprint: string, session: DemoSession) => {
    if (stored.operation.fingerprint !== fingerprint) throw new RoutingError(409,'IDEMPOTENCY_MISMATCH','This operation key was already used for a different routing request.');
    return detail(stored,session);
  };
  return {
    list(session) { active(session,now()); return {datasetVersion:session.version,previews:repository.list(session.id).map(s => detail(s,session))}; },
    read(session,id) { active(session,now()); return detail(read(session,id),session); },
    create(session,raw) {
      active(session,now());
      const body=object(raw,['clientOperationId','datasetVersion','name','traceIds','rule','recipient','destination','severity','cooldownMs']);
      if (typeof body.clientOperationId !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(body.clientOperationId)) return invalid('Send an 8–96 character clientOperationId.');
      const fingerprint=hash(body), id=`routing-${hash([session.id,body.clientOperationId]).slice(0,24)}`;
      const existing=repository.read(session.id,id);
      if (existing) return replay(existing,fingerprint,session);
      if (!Number.isSafeInteger(body.datasetVersion) || Number(body.datasetVersion)<1) return invalid('datasetVersion must be a positive integer.');
      if (body.datasetVersion !== session.version) throw new RoutingError(409,'DATASET_CONFLICT','The saved traces changed. Reload before previewing routing.');
      if (repository.list(session.id).length >= 8) throw new RoutingError(409,'ROUTING_LIMIT','This demo already has eight routing previews.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length>120) return invalid('Name must contain 1–120 characters.');
      if (!Array.isArray(body.traceIds) || !body.traceIds.length || body.traceIds.length>4 || body.traceIds.some(id => typeof id !== 'string') || new Set(body.traceIds).size !== body.traceIds.length) return invalid('Select 1–4 distinct saved traces.');
      const traceIds=body.traceIds as string[];
      const traces=traceIds.map(id => { const trace=session.dataset.traces.find(t => t.id===id); if (!trace) throw new RoutingError(404,'TRACE_NOT_FOUND','A selected trace is not in this demo.'); return structuredClone(trace); });
      const r=object(body.rule,['type','failedTraceThreshold']);
      let rule: RoutingRule;
      if (r.type==='per_event' && r.failedTraceThreshold===undefined) rule={type:'per_event'};
      else if (r.type==='threshold' && Number.isSafeInteger(r.failedTraceThreshold) && Number(r.failedTraceThreshold)>=1 && Number(r.failedTraceThreshold)<=4) rule={type:'threshold',failedTraceThreshold:Number(r.failedTraceThreshold)};
      else return invalid('Select error per event or a failed-trace threshold from 1 to 4.');
      if (!ROUTING_RECIPIENTS.includes(body.recipient as RoutingPreview['recipient'])) return invalid('Select a fictional demo role; real people or addresses are unsupported.');
      if (!ROUTING_DESTINATIONS.includes(body.destination as RoutingPreview['destination'])) return invalid('Select a demo destination; URLs and connections are unsupported.');
      if (!['warning','critical'].includes(String(body.severity))) return invalid('Select warning or critical severity.');
      if (!Number.isSafeInteger(body.cooldownMs) || Number(body.cooldownMs)<0 || Number(body.cooldownMs)>600000) return invalid('cooldownMs must be an integer from 0 to 600000.');
      const recipient=body.recipient as RoutingPreview['recipient'];
      const failed=traces.filter(t => t.outcomeKind==='failure');
      const candidates=rule.type==='per_event' ? traces.filter(t => t.spans.some(s => s.status==='ERROR')) : failed;
      const conditionMet=rule.type==='per_event' ? candidates.length>0 : failed.length>=rule.failedTraceThreshold;
      const preview: RoutingPreview={id,schemaVersion:ROUTING_SCHEMA_VERSION,version:1,datasetVersion:session.version,name:body.name.trim(),rule,traceIds,traceSnapshot:traces,
        recipient,destination:body.destination as RoutingPreview['destination'],severity:body.severity as RoutingPreview['severity'],cooldownMs:Number(body.cooldownMs),
        mode:'synthetic',provenance:'local_trace_snapshot',conditionMet,observedFailedTraceCount:failed.length,delivery:conditionMet?'simulated':'not_triggered',createdAt:now().toISOString(),
        deliveryNote:'Local preview only. Fictional role and destination; no message was sent. Cooldown is stored configuration, not an active timer.',
        matches:conditionMet ? candidates.map(t => ({traceId:t.id,spanIds:t.spans.filter(s => s.status==='ERROR').map(s => s.id),owner:recipient,
          context:rule.type==='per_event' ? 'An ERROR span matched this saved synthetic trace.' : `Failure outcome counted toward the ${rule.failedTraceThreshold}-trace threshold.`})) : []};
      const stored: StoredRoutingPreview={preview,operation:{id:body.clientOperationId,fingerprint}};
      if (!repository.compareAndSet(session.id,id,null,stored)) {
        const concurrent=repository.read(session.id,id);
        if (concurrent) return replay(concurrent,fingerprint,session);
        throw new RoutingError(409,'ROUTING_CONFLICT','The preview changed. Reload and try again.');
      }
      return detail(read(session,id),session);
    },
  };
}
