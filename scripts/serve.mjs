import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = 8080;
const rootDir = process.cwd();

export function handleRequest(req, res, currentRootDir = rootDir) {
  const activeRoot = path.join(currentRootDir, 'active');
  const dataRoot = path.join(currentRootDir, 'data');
  const realActiveRoot = fs.existsSync(activeRoot) ? fs.realpathSync(activeRoot) : activeRoot;
  const realDataRoot = fs.existsSync(dataRoot) ? fs.realpathSync(dataRoot) : dataRoot;

  const rawUrl = req.url || '';
  const pathname = rawUrl.split('?')[0];

  // 1. URL decode with Fail-Closed
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: Malformed URI');
    return;
  }

  // Reject NUL byte
  if (decodedPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: Invalid character in URI');
    return;
  }

  // Root redirect
  if (decodedPath === '/' || decodedPath === '') {
    res.writeHead(302, { Location: '/manager/' });
    res.end();
    return;
  }

  // 2. Traversal & Dot Segment rejection
  // Reject any segment that starts with '.' (., .., .git, .secrets, .env, etc.)
  const rawSegments = decodedPath.split('/').filter(Boolean);
  if (rawSegments.some(seg => seg.startsWith('.'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Access denied');
    return;
  }

  // 3. Rewrites
  let rewrittenPath = decodedPath;
  if (rewrittenPath.startsWith('/manager/')) {
    rewrittenPath = rewrittenPath.replace('/manager/', '/active/manager/');
  } else if (rewrittenPath === '/manager') {
    rewrittenPath = '/active/manager/index.html';
  } else if (rewrittenPath.startsWith('/app/')) {
    rewrittenPath = rewrittenPath.replace('/app/', '/active/h-app/');
  } else if (rewrittenPath === '/app' || rewrittenPath === '/mobile') {
    rewrittenPath = '/active/h-app/index.html';
  } else if (rewrittenPath.startsWith('/business/')) {
    rewrittenPath = rewrittenPath.replace('/business/', '/active/business/');
  }

  // 4. Lexical Containment Check (Allowlist: active/** or data/** only)
  const candidate = path.resolve(currentRootDir, '.' + path.normalize('/' + rewrittenPath));
  const isLexicallyContained =
    (candidate === activeRoot || candidate.startsWith(activeRoot + path.sep)) ||
    (candidate === dataRoot || candidate.startsWith(dataRoot + path.sep));

  if (!isLexicallyContained) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Path outside allowed root');
    return;
  }

  // 5. File / Directory existence check
  let targetFile = candidate;
  if (!fs.existsSync(targetFile)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${rawUrl}`);
    return;
  }

  if (fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(targetFile, 'index.html');
    if (!fs.existsSync(targetFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${rawUrl}`);
      return;
    }
  }

  // 6. Realpath Containment Check (prevent symlink escapes)
  let realCandidate;
  try {
    realCandidate = fs.realpathSync(targetFile);
  } catch (err) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Realpath resolution failed');
    return;
  }

  const isRealContained =
    (realCandidate === realActiveRoot || realCandidate.startsWith(realActiveRoot + path.sep)) ||
    (realCandidate === realDataRoot || realCandidate.startsWith(realDataRoot + path.sep));

  if (!isRealContained) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Realpath outside allowed root');
    return;
  }

  // 7. Read and serve file
  fs.readFile(realCandidate, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${rawUrl}`);
      return;
    }

    let contentType = 'text/html; charset=utf-8';
    if (realCandidate.endsWith('.js') || realCandidate.endsWith('.mjs')) contentType = 'application/javascript; charset=utf-8';
    if (realCandidate.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    if (realCandidate.endsWith('.json')) contentType = 'application/json; charset=utf-8';
    if (realCandidate.endsWith('.png')) contentType = 'image/png';
    if (realCandidate.endsWith('.jpg') || realCandidate.endsWith('.jpeg')) contentType = 'image/jpeg';
    if (realCandidate.endsWith('.svg')) contentType = 'image/svg+xml';
    if (realCandidate.endsWith('.csv')) contentType = 'text/plain; charset=utf-8';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
}

export const server = http.createServer((req, res) => handleRequest(req, res, rootDir));

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`========================================================`);
    console.log(`🚀 POSTING MAP Local Server Running:`);
    console.log(`   👉 Manager Dashboard: http://localhost:${PORT}/manager/`);
    console.log(`   👉 H-App (Mobile):     http://localhost:${PORT}/app/`);
    console.log(`   👉 Root URL:           http://localhost:${PORT}/`);
    console.log(`========================================================`);
  });
}
