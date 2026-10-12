import type { RefusalReason } from '../../tailor/adapter.ts';
const CODE_STRONG = /child_process|require\s*\(|rm\s+-rf|<\s*script|\beval\s*\(|\bexec\s*\(|os\.system|subprocess|__import__|curl[^|]*\|\s*(?:ba)?sh|process\.env/i;
const CODE_REQUEST = /\b(?:run|execute|insert|inject|embed)\b[^.]{0,40}\b(?:code|script|shell|command|javascript|python|bash|payload)\b/i;
const CROSS_SESSION = /\b(?:other|another|previous|earlier|different|last)\s+(?:buyer|user|session|customer|visitor|person|demo)s?\b|\beveryone'?s\b|\b(?:all|every) (?:sessions?|buyers?|users?)\b|\bsomeone else'?s\b|\bwho was here before\b/i;
// Explicit session identifiers. An ID-like token is a UUID, a 26-char ULID, a 6+ char kebab token with a digit, or an 8+ char
// token mixing letters and digits (not a plain number with a unit such as 300000ms). Ordinary words never match.
const ID_TOKEN = String.raw`(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-hjkmnp-tv-z]{26}|(?=[a-z0-9-]*\d)[a-z0-9]{6,}(?:-[a-z0-9]+)+|(?!\d+[a-z]{0,3}(?![a-z0-9]))(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,})`;
const LOOSE_ID = String.raw`(?!\d+[a-z]{0,3}(?![a-z0-9]))(?=[\w-]*\d)[\w-]{6,}`;
const GAP_WORDS = String.raw`(?:[^\w-]+[\w'’-]+){0,3}?`;
const SESSION_ID_REFERENCES: RegExp[] = [
  // (i) session|demo|visitor|buyer|user, then an identifier within ~3 tokens
  new RegExp(String.raw`\b(?:session|demo|visitor|buyer|user)s?\b${GAP_WORDS}[^\w-]+${ID_TOKEN}(?![\w-])`, 'i'),
  // (ii) /demo/<id> or /api/sessions/<id>
  new RegExp(String.raw`/(?:demo|api/sessions)/(?!(?:traces?|entry|new|me|current|this|mine)\b)[\w-]{4,}`, 'i'),
  // (iii) sessionId / session id / session_id  =  :  is  token
  new RegExp(String.raw`\bsession[\s_-]?id\b\s*(?:=|:|\bis\b|\bwas\b)\s*["'“]?${LOOSE_ID}`, 'i'),
  // (iv) show|open|load|read|get|fetch|pull|access ... session <token>
  new RegExp(String.raw`\b(?:show|open|load|read|get|fetch|pull|access)\b${GAP_WORDS}[^\w-]+sessions?\b${GAP_WORDS}[^\w-]+${LOOSE_ID}`, 'i'),
];
const MUTATION_VERB = /\b(?:delete|remove|drop|wipe|cancel|rotate|revoke|reset|modify|change|update|upgrade|downgrade|edit)\b/i;
const MUTATION_TARGET = /\b(?:real|actual|production|live)\b[^.]{0,30}\b(?:neatlogs|project|account|workspace|traces|data)\b|\bneatlogs\b[^.]{0,20}\b(?:account|project|workspace|api key|billing|subscription|plan)\b|\bmy (?:neatlogs|real) (?:account|project|workspace)\b|\bmy (?:account|api key|billing|subscription)\b/i;


export function requestBoundary(text: string): { reason: RefusalReason; text: string } | null {
  const raw = text.normalize('NFKC').replace(/[’‘]/g, "'");
  // Examples quoted for explanation are data. Subject descriptions about a coding agent grant no code execution.
  const t = raw.replace(/```[\s\S]*?```|"[^"\n]*"|“[^”]*”/g, ' [quoted data] ');
  if ((CODE_STRONG.test(t) || CODE_REQUEST.test(t)) && !/\b(?:how|what|explain|describe|simulate|fictional|my .*agent)\b/i.test(t)) return { reason: 'arbitrary_code', text: 'I can explain fictional coding workflows, but I can’t run or embed executable code in this demo.' };
  if (CROSS_SESSION.test(t) || SESSION_ID_REFERENCES.some(re => re.test(t))) return { reason: 'cross_session', text: 'I can only use this demo’s own data. I can’t access another visitor or session.' };
  if (MUTATION_VERB.test(t) && MUTATION_TARGET.test(t)) return { reason: 'real_mutation', text: 'I can explain the product, but I can’t change a real Neatlogs project or account from this synthetic demo.' };
  return null;
}
