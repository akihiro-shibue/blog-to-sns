// Simple local server for blog-to-sns dashboard
// Usage: node serve.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3002;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'index.html');

  const ext = path.extname(filePath);
  res.setHeader('Content-Type', mime[ext] || 'text/plain');
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`blog-to-sns dashboard: http://localhost:${PORT}`);
});
