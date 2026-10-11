import { readFileSync } from 'node:fs';
import type { CapabilityRecord, DemonstrationLevel, KnowledgeIndex, KnowledgeSource } from './agent-contract.ts';
import { LIMITS } from './agent-contract.ts';

type PricingSummary = {
  verifiedOn: string;
  status: 'known' | 'unknown';
  plans: unknown[];
  sources: KnowledgeSource[];
  notes: string[];
};

type VersionFile = {
  version: string;
  contractVersion: string;
  recordCount: number;
  generatedBy: string;
  notes: string[];
};

const levels: readonly DemonstrationLevel[] = ['demonstrable', 'modifiable', 'explain_only', 'unsupported'];
const scopes = ['official_product', 'clone_only'] as const;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const sourceUrlPattern = /^(?:https?:\/\/|repo:)/;
const officialSourcePattern = /^https?:\/\//;
const defaultDirectory = new URL('../knowledge/neatlogs/', import.meta.url);

function parseJson(path: URL, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${label}: ${reason}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed capabilities.json: ${path} must be a non-empty string`);
}

function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Malformed capabilities.json: ${path} must be an array of non-empty strings`);
  }
}

function validateSource(value: unknown, path: string): asserts value is KnowledgeSource {
  if (!isObject(value)) throw new Error(`Malformed capabilities.json: ${path} must be an object`);
  requireString(value.url, `${path}.url`);
  requireString(value.verifiedOn, `${path}.verifiedOn`);
  requireString(value.claim, `${path}.claim`);
  if (!sourceUrlPattern.test(value.url)) throw new Error(`Malformed capabilities.json: ${path}.url must use http(s) or repo:`);
  if (!datePattern.test(value.verifiedOn)) throw new Error(`Malformed capabilities.json: ${path}.verifiedOn must be YYYY-MM-DD`);
}

function validateRecord(value: unknown, index: number): asserts value is CapabilityRecord {
  const path = `records[${index}]`;
  if (!isObject(value)) throw new Error(`Malformed capabilities.json: ${path} must be an object`);
  for (const field of ['id', 'title', 'buyerProblem', 'behaviour'] as const) requireString(value[field], `${path}.${field}`);
  if (!scopes.includes(value.scope as (typeof scopes)[number])) throw new Error(`Malformed capabilities.json: ${path}.scope is invalid`);
  for (const field of ['limitations', 'prerequisites', 'exampleQuestions', 'topics'] as const) {
    requireStringArray(value[field], `${path}.${field}`);
  }
  const exampleQuestions = value.exampleQuestions;
  const topics = value.topics;
  requireStringArray(exampleQuestions, `${path}.exampleQuestions`);
  requireStringArray(topics, `${path}.topics`);
  if (exampleQuestions.length < 1 || topics.length < 1) throw new Error(`Malformed capabilities.json: ${path} needs questions and topics`);

  if (!Array.isArray(value.sources) || value.sources.length === 0) throw new Error(`Malformed capabilities.json: ${path}.sources must not be empty`);
  value.sources.forEach((source, sourceIndex) => validateSource(source, `${path}.sources[${sourceIndex}]`));
  if (value.scope === 'official_product' && !value.sources.some((source) => officialSourcePattern.test(source.url) && datePattern.test(source.verifiedOn))) {
    throw new Error(`Malformed capabilities.json: official record ${value.id} needs a dated http(s) source`);
  }

  if (!isObject(value.planAvailability) || !['known', 'unknown'].includes(String(value.planAvailability.status))) {
    throw new Error(`Malformed capabilities.json: ${path}.planAvailability is invalid`);
  }
  if (value.planAvailability.status === 'known') {
    requireStringArray(value.planAvailability.plans, `${path}.planAvailability.plans`);
    if (value.planAvailability.plans.length === 0) throw new Error(`Malformed capabilities.json: ${path}.planAvailability.plans must not be empty`);
    if (value.planAvailability.note !== undefined && typeof value.planAvailability.note !== 'string') {
      throw new Error(`Malformed capabilities.json: ${path}.planAvailability.note must be a string`);
    }
  } else {
    requireString(value.planAvailability.note, `${path}.planAvailability.note`);
  }

  if (!isObject(value.demonstration)) throw new Error(`Malformed capabilities.json: ${path}.demonstration must be an object`);
  if (!levels.includes(value.demonstration.level as DemonstrationLevel)) throw new Error(`Malformed capabilities.json: ${path}.demonstration.level is invalid`);
  requireString(value.demonstration.evidence, `${path}.demonstration.evidence`);
  requireStringArray(value.demonstration.cloneSurfaces, `${path}.demonstration.cloneSurfaces`);
  requireStringArray(value.demonstration.tools, `${path}.demonstration.tools`);
}

function validateVersion(value: unknown): VersionFile {
  if (!isObject(value)) throw new Error('Malformed version.json: expected an object');
  for (const field of ['version', 'contractVersion', 'generatedBy'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') throw new Error(`Malformed version.json: ${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 0) throw new Error('Malformed version.json: recordCount must be a non-negative integer');
  if (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string')) throw new Error('Malformed version.json: notes must be strings');
  return value as VersionFile;
}

function validatePricing(value: unknown): PricingSummary {
  if (!isObject(value)) throw new Error('Malformed pricing.json: expected an object');
  if (typeof value.verifiedOn !== 'string' || !datePattern.test(value.verifiedOn)) throw new Error('Malformed pricing.json: verifiedOn must be YYYY-MM-DD');
  if (value.status !== 'known' && value.status !== 'unknown') throw new Error('Malformed pricing.json: status must be known or unknown');
  if (!Array.isArray(value.plans)) throw new Error('Malformed pricing.json: plans must be an array');
  if (!Array.isArray(value.sources)) throw new Error('Malformed pricing.json: sources must be an array');
  value.sources.forEach((source, index) => validateSource(source, `pricing.sources[${index}]`));
  if (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string')) throw new Error('Malformed pricing.json: notes must be strings');
  if (value.status === 'known' && (value.plans.length === 0 || !value.sources.some((source) => officialSourcePattern.test(source.url)))) {
    throw new Error('Malformed pricing.json: known pricing needs plans and an http(s) source');
  }
  return value as PricingSummary;
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean).map(stem));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits;
}

function scoreRecord(record: CapabilityRecord, queryTokens: Set<string>): number {
  const topicTokens = tokens(record.topics.join(' '));
  const titleAndQuestions = tokens(`${record.title} ${record.exampleQuestions.join(' ')}`);
  const descriptive = tokens(`${record.behaviour} ${record.buyerProblem}`);
  return intersectionSize(queryTokens, topicTokens) * 3
    + intersectionSize(queryTokens, titleAndQuestions) * 2
    + intersectionSize(queryTokens, descriptive);
}

function levelRank(level: DemonstrationLevel): number {
  if (level === 'demonstrable' || level === 'modifiable') return 0;
  if (level === 'explain_only') return 1;
  return 2;
}

function boundedMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(Math.floor(max), LIMITS.maxKnowledgeRecordsPerTurn);
}

export function loadKnowledge(dir: URL = defaultDirectory): KnowledgeIndex {
  const recordsValue = parseJson(new URL('capabilities.json', dir), 'capabilities.json');
  const version = validateVersion(parseJson(new URL('version.json', dir), 'version.json'));
  if (!Array.isArray(recordsValue)) throw new Error('Malformed capabilities.json: expected an array');
  recordsValue.forEach(validateRecord);
  const records = recordsValue as CapabilityRecord[];
  if (records.length !== version.recordCount) {
    throw new Error(`Malformed knowledge files: version.json recordCount ${version.recordCount} does not match ${records.length} records`);
  }
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Malformed capabilities.json: duplicate id ${record.id}`);
    ids.add(record.id);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const executable = records.filter((record) => record.demonstration.level === 'demonstrable' || record.demonstration.level === 'modifiable');

  return {
    version: version.version,
    select(query: string, max = LIMITS.maxKnowledgeRecordsPerTurn): CapabilityRecord[] {
      const limit = boundedMax(max);
      if (limit === 0) return [];
      const queryTokens = tokens(query);
      if (queryTokens.size === 0) return executable.slice(0, limit);
      return records
        .map((record, position) => ({ record, position, score: scoreRecord(record, queryTokens) }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score
          || levelRank(a.record.demonstration.level) - levelRank(b.record.demonstration.level)
          || a.position - b.position)
        .slice(0, limit)
        .map((candidate) => candidate.record);
    },
    get(id: string): CapabilityRecord | undefined {
      return byId.get(id);
    },
    all(): readonly CapabilityRecord[] {
      return records;
    },
  };
}

export function pricingSummary(dir: URL = defaultDirectory): PricingSummary {
  return validatePricing(parseJson(new URL('pricing.json', dir), 'pricing.json'));
}

export const knowledgeVersion = validateVersion(parseJson(new URL('version.json', defaultDirectory), 'version.json')).version;
