// Operator-only migration of the cumulative numeric ledger onto a fresh volume.
// Use only for the approved live cutover; remove both variables after verified first boot.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bucketKeys = ['calls','inputTokens','outputTokens','thinkingTokens','cacheReadTokens','cacheWriteTokens','spentUsd'];
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exactKeys = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const bucket = (value: any) => exactKeys(value,bucketKeys) && bucketKeys.every(key => number(value[key]));
export function seedSpendLedger(env: NodeJS.ProcessEnv): {sha256: string; alreadyPresent: boolean} | null {
  const encoded=env.TAILOR_SPEND_LEDGER_SEED_BASE64?.trim();
  const expected=env.TAILOR_SPEND_LEDGER_SEED_SHA256?.trim();
  if (!encoded && !expected) return null;
  if (env.TAILOR_PROVIDER !== 'anthropic') throw new Error('Ledger seed is permitted only for explicit anthropic cutover.');
  if (!env.TAILOR_PUBLIC_ORIGIN || !env.TAILOR_SPEND_LEDGER) throw new Error('Ledger seed requires public mode and the explicit persistent ledger path.');
  if (!encoded || !expected || !/^[a-f0-9]{64}$/.test(expected) || encoded.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Ledger seed must be bounded base64 plus its SHA256.');
  const bytes=Buffer.from(encoded,'base64');
  if (bytes.toString('base64') !== encoded || bytes.length > 65536 || hash(bytes) !== expected) throw new Error('Ledger seed hash/encoding mismatch.');
  let value:any;try {value=JSON.parse(bytes.toString('utf8'));} catch {throw new Error('Ledger seed is not JSON.');}
  if (!exactKeys(value,['version','total','byKind','unreconciled','pending','updatedAt','safetyViolation']) || value.version !== 2 || !bucket(value.total) || !number(value.updatedAt) || !exactKeys(value.unreconciled,['calls','usd']) || !number(value.unreconciled.calls) || !number(value.unreconciled.usd) || !Array.isArray(value.pending) || !value.byKind || typeof value.byKind !== 'object' || Array.isArray(value.byKind) || (value.safetyViolation !== undefined && typeof value.safetyViolation !== 'boolean')) throw new Error('Ledger seed is not the numeric version-2 ledger.');
  if (!Object.entries(value.byKind).every(([kind,b])=>/^[a-zA-Z0-9_-]{1,80}$/.test(kind) && bucket(b)) || !value.pending.every((p:any)=>exactKeys(p,['id','kind','model','usd','at']) && typeof p.id === 'string' && /^[a-f0-9-]{1,80}$/.test(p.id) && typeof p.kind === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(p.kind) && (p.model === null || (typeof p.model === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(p.model))) && number(p.usd) && number(p.at))) throw new Error('Ledger seed contains unexpected accounting metadata.');
  const path=env.TAILOR_SPEND_LEDGER;
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== expected) throw new Error('Persistent ledger differs from the seed. Refusing overwrite; remove seed variables.');
    return {sha256:expected,alreadyPresent:true};
  }
  mkdirSync(dirname(path),{recursive:true});
  const fd=openSync(path,'wx',0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
  return {sha256:expected,alreadyPresent:false};
}
