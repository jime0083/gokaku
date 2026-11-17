// P-161-A: localhost only; uncaught decoder errors must terminate this child.
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');

const [parserPath, encoding, scenario] = process.argv.slice(2);
const bodyParser = require(parserPath);
const LIMIT_BYTES = 1024;
const compressors = {
  identity: (body) => body,
  gzip: zlib.gzipSync,
  deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync,
};
const compress = compressors[encoding];
assert.ok(compress, 'unsupported test encoding');
const normalBody = Buffer.from(' {"message":"合格","count":1} \n');
const source = scenario === 'oversized'
  ? Buffer.from(JSON.stringify({ message: 'a'.repeat(LIMIT_BYTES) }))
  : scenario === 'invalid-json' ? Buffer.from('{invalid') : normalBody;
const frame = compress(source);
const trailing = Buffer.alloc(100 * 1024, 0x58);
const first = scenario === 'trailing' ? Buffer.concat([frame, Buffer.from([0])]) : frame;
let client;
const sockets = new Set();
const options = {
  limit: LIMIT_BYTES,
  verify(req, _res, body) { req.rawBody = Buffer.from(body); },
};
const parser = scenario === 'raw'
  ? bodyParser.raw({ ...options, type: 'application/octet-stream' })
  : bodyParser.json(options);
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.end('alive');
    return;
  }
  parser(req, res, (error) => {
    const finish = () => {
      res.statusCode = error ? error.status || 500 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(error
        ? { type: error.type }
        : { body: Buffer.isBuffer(req.body) ? req.body.toString('hex') : req.body,
            rawBody: req.rawBody.toString('hex') }));
    };
    if (scenario === 'trailing') {
      // The decoder has completed its valid frame. Deliver the remaining HTTP
      // bytes now, then require the request to end; no timing sleeps or retries.
      if (req.readableEnded) finish();
      else req.once('end', finish);
      client.end(trailing);
    } else {
      finish();
    }
  });
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

async function request(method, body) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, method, agent: false,
      headers: method === 'GET' ? {} : {
        'Content-Type': scenario === 'raw' ? 'application/octet-stream' : 'application/json',
        'Content-Encoding': encoding,
        'Content-Length': body.length + (scenario === 'trailing' ? trailing.length : 0),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    if (method === 'POST') client = req;
    if (method === 'POST' && scenario === 'trailing') req.write(body);
    else req.end(body);
  });
}

async function main() {
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await request('POST', first);
    if (scenario === 'oversized') {
      assert.equal(response.status, 413);
      assert.equal(JSON.parse(response.text).type, 'entity.too.large');
    } else if (scenario === 'invalid-json') {
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(response.text).type, 'entity.parse.failed');
    } else {
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.text), {
        body: scenario === 'raw' ? normalBody.toString('hex') : JSON.parse(normalBody),
        rawBody: normalBody.toString('hex'),
      });
    }
    assert.deepEqual(await request('GET'), { status: 200, text: 'alive' });
    process.stdout.write(JSON.stringify({ encoding, scenario, status: response.status, alive: true }));
  } finally {
    if (client) client.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
// Deliberately no uncaughtException/unhandledRejection/decoder error handler.
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
