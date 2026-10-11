import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { Store, Failure } from './store.ts';
import type { Proposal, TraceList } from './contracts.ts';

const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)tailor=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Failure(415, 'CONTENT_TYPE', 'Use application/json.');
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32000) throw new Failure(413, 'BODY_TOO_LARGE', 'Request exceeds 32 KB.'); }
  try { return JSON.parse(raw); } catch { throw new Failure(400, 'INVALID_JSON', 'Request must contain complete JSON.'); }
}
export function appServer(store: Store, devKey?: string) {
  return createServer(async (req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Loopback-only Host and same-origin writes also prevent DNS rebinding/CSRF.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) throw new Failure(403, 'LOCAL_ONLY', 'Use the local loopback server.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Failure(403, 'ORIGIN', 'Cross-origin requests are not supported.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (path === '/api/sessions' && req.method === 'POST') {
          const data = await body(req);
          const s = store.create(data?.description, data?.scenario, String(req.headers['idempotency-key'] ?? ''));
          res.setHeader('Set-Cookie', `tailor=${s.id}.${store.token(s.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
          return send(201, s);
        }
        if (path.startsWith('/api/dev/')) {
          if (!devKey || req.headers['x-tailor-dev-key'] !== devKey) throw new Failure(403, 'DEVELOPER_ONLY', 'Developer inspection is disabled or requires the local developer key.');
          if (path === '/api/dev/sessions' && req.method === 'GET') return send(200, store.list());
          const match = /^\/api\/dev\/sessions\/([\w-]+)\/proposal$/.exec(path);
          if (match && req.method === 'POST') {
            store.authorize(match[1]!, cookieOf(req));
            return send(200, store.publish(match[1]!, await body(req) as Proposal));
          }
          throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported developer action.');
        }
        if (req.method !== 'GET') throw new Failure(405, 'UNSUPPORTED_ACTION', 'This action is not supported.');
        if (path === '/api/session') {
          const cookie = cookieOf(req); const id = cookie.split('.')[0]!;
          store.authorize(id, cookie); return send(200, store.read(id));
        }
        const route = /^\/api\/sessions\/([\w-]+)(?:\/traces(?:\/([\w-]+)(?:\/spans\/([\w-]+))?)?)?$/.exec(path);
        if (!route) throw new Failure(404, 'NOT_FOUND', 'API route not found.');
        const [, id, traceId, spanId] = route;
        store.authorize(id!, cookieOf(req));
        const session = store.read(id!);
        if (traceId) {
          const trace = session.dataset.traces.find(t=>t.id===traceId);
          if (!trace) throw new Failure(404, 'NOT_FOUND', 'Trace not found in this session.');
          if (spanId) {
            const span = trace.spans.find(s=>s.id===spanId);
            if (!span) throw new Failure(404, 'NOT_FOUND', 'Span not found in this trace.');
            return send(200, { version: session.version, span });
          }
          return send(200, { version: session.version, trace });
        }
        if (path.endsWith('/traces')) {
          const allowed = ['q','scenario','detection','tag','minMs','maxMs'];
          if ([...url.searchParams.keys()].some(k=>!allowed.includes(k))) throw new Failure(400, 'UNSUPPORTED_FILTER', 'This filter is not supported.');
          const get = (key: string) => url.searchParams.get(key) ?? '';
          if ((get('scenario') && !['recovered','exhausted'].includes(get('scenario'))) || (get('detection') && !['yes','no'].includes(get('detection')))) throw new Failure(400, 'INVALID_FILTER', 'Unsupported filter value.');
          const min = get('minMs') ? Number(get('minMs')) : 0; const max = get('maxMs') ? Number(get('maxMs')) : Infinity;
          if (!Number.isFinite(min) || min < 0 || (max !== Infinity && !Number.isFinite(max)) || max < min) throw new Failure(400,'INVALID_FILTER','Latency bounds must be nonnegative and ordered.');
          const traces = session.dataset.traces.filter(t=>{
            const ms = t.spans[0]!.durationMs;
            return JSON.stringify(t).toLowerCase().includes(get('q').toLowerCase()) && (!get('scenario') || t.scenario === get('scenario')) && (!get('tag') || t.tags.includes(get('tag'))) && (!get('detection') || t.spans.some(s=>s.detection) === (get('detection')==='yes')) && ms>=min && ms<=max;
          });
          const response: TraceList = { version:session.version, activeScenario:session.dataset.activeScenario, total:session.dataset.traces.length, filtered:traces.length, traces };
          return send(200,response);
        }
        return send(200,session);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Failure(405,'UNSUPPORTED_ACTION','Unsupported action.');
      let file = '/index.html';
      if (path === '/app.js') file = '../dist/client.js';
      else if (path === '/style.css' || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) file = path;
      else if (!(path==='/' || path==='/entry' || /^\/demo\/[^/]+\/traces(?:\/[^/]+)?$/.test(path))) throw new Failure(404,'NOT_FOUND','Page not found.');
      const full = file === '../dist/client.js' ? resolve('dist/client.js') : resolve('public',file.slice(1));
      const content = await readFile(full);
      const types:Record<string,string> = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.webp':'image/webp'};
      res.writeHead(200,{'content-type':types[extname(full)] ?? 'application/octet-stream'}); res.end(req.method==='HEAD' ? undefined : content);
    } catch(e) {
      const failure = e instanceof Failure ? e : new Failure(500,'SERVER_FAILURE','Local request failed. Retry; previous accepted session state is retained.');
      if (!res.headersSent && !res.destroyed) send(failure.status,{error:{code:failure.code,message:failure.message}});
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const store = new Store(process.env.TAILOR_DATA_PATH ?? '.local/tailor.sqlite');
  const server = appServer(store,process.env.TAILOR_DEV_KEY);
  server.listen(Number(process.env.PORT ?? 4321),'127.0.0.1',()=>console.log(`Tailor local replica: http://127.0.0.1:${(server.address() as {port:number}).port}`));
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}
