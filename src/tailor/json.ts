// The bounded JSON value domain: model-authored free-form values must be plain, finite and shallow enough to store.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 500 && value.every(v => isJson(v, depth + 1));
  if (isObj(value)) {
    const keys = Object.keys(value);
    return keys.length <= 200 && keys.every(k => isJson(value[k], depth + 1));
  }
  return false;
}
