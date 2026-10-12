import {createServer, request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname} from 'node:path';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
export function createWebsiteServer({demoOrigin = process.env.TAILOR_DEMO_ORIGIN || 'http://127.0.0.1:4328', demoEntryPath = process.env.TAILOR_DEMO_ENTRY_PATH || '/entry'} = {}) {
  const target = new URL(demoOrigin);
  if (target.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Demo origin must be a loopback HTTP origin.');
  if (!/^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(demoEntryPath) || ['/', '/try-demo', '/manifesto', '/how-it-works'].includes(demoEntryPath)) throw new Error('Demo entry must be a local demo route.');
  const files = new Map([
    ['/','index.html'], ['/manifesto','index.html'], ['/how-it-works','index.html'],
    ...['app.js','base.css','landing.js','landing.css','pages.js','pages.css','motion.js','motion.css'].map(name => ['/marketing/'+name,name]),
    ...['landing.png','manifesto.png','how-it-works.png'].map(name => ['/assets/'+name,'assets/'+name])
  ]);
  return createServer(async (req,res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {res.writeHead(403);res.end('Use the local loopback server.');return;}
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {res.writeHead(403);res.end('Cross-origin requests are not supported.');return;}
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/try-demo') {
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
      res.writeHead(302, {'Location':demoEntryPath,'Cache-Control':'no-store'});res.end();return;
    }
    const file = files.get(url.pathname);
    if (file) {
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
      try {
        const data = await readFile(resolve(publicDir,file));
        const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'}[extname(file)];
        res.writeHead(200,{'Content-Type':mime,'Content-Length':data.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {res.writeHead(404);res.end('File not found.');}
      return;
    }
    // Preserve Host and Origin together: the existing demo validates their equality.
    // Forward cookies, query strings, body and response headers without touching demo code.
    const headers = {...req.headers};
    for (const key of ['connection','proxy-connection','keep-alive','upgrade','te','trailer','transfer-encoding']) delete headers[key];
    const upstream = request({hostname:target.hostname,port:target.port || 80,path:req.url,method:req.method,headers}, response => {
      const responseHeaders = {...response.headers};
      delete responseHeaders.connection;
      res.writeHead(response.statusCode || 502,responseHeaders);
      response.pipe(res);
    });
    upstream.setTimeout(180000, () => upstream.destroy(new Error('Demo timeout')));
    upstream.on('error', () => {
      if (res.headersSent) {res.destroy();return;}
      res.writeHead(502,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo unavailable · Tailor</title><h1>The demo is temporarily unavailable.</h1><p>Please retry when the demo server is running.</p><a href="/">Return to Tailor</a></html>');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => {if (!res.writableEnded) upstream.destroy();});
    req.pipe(upstream);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4348);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createWebsiteServer();
  server.listen(port,'127.0.0.1', () => console.log(`Tailor website: http://127.0.0.1:${port}`));
}
