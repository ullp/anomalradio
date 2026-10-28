/**
 * A stand-in for the Node app, so nginx can be exercised without it.
 *
 * Its whole purpose is `/__forwarded`: it reports the `X-Forwarded-For` it actually received, which
 * is how `scripts/verify-nginx.sh` proves the config *overwrites* that header instead of appending
 * to it. Appending would let a client choose its own apparent IP and walk around the per-IP rate
 * limit, the stream cap and token/IP binding.
 *
 * Usage: node scripts/nginx-stub-upstream.mjs <port>
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);

const server = createServer((req, res) => {
  if (req.url === '/__ping') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (req.url.startsWith('/__forwarded')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(String(req.headers['x-forwarded-for'] ?? ''));
    return;
  }

  // Anything else stands in for the continuous mount.
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Anomalradio' });
  res.end('audio-bytes');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub upstream on 127.0.0.1:${server.address().port}\n`);
});
