import http from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/app.js', 'app.js'], ['/model.js', 'model.js'], ['/styles.css', 'styles.css']]);
const types = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8'
};
const port = Number(process.env.SEAT_MARKET_PORT || 18816);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('SEAT_MARKET_PORT must be a port number between 0 and 65535.');
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, {Allow:'GET, HEAD'}).end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  } catch {
    res.writeHead(400).end('Invalid URL');
    return;
  }
  const file = files.get(pathname);
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL('./dist/' + file, import.meta.url));
    res.writeHead(200, {
      'Content-Type': types[file.split('.').pop()],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500).end('Preview file unavailable');
  }
});
server.on('error', error => {
  console.error(`Preview could not start: ${error.code}. Choose another SEAT_MARKET_PORT; existing processes were not changed.`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Seat Market preview: http://127.0.0.1:${server.address().port}/`));
