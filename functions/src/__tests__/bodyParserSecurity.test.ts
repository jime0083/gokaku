import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// Resolve the parser through the existing Firebase -> Express dependency path.
const firebaseRequire = createRequire(require.resolve('firebase-functions'));
const expressRequire = createRequire(firebaseRequire.resolve('express'));
const parserPath = expressRequire.resolve('body-parser');
const fixture = path.join(__dirname, 'testFixtures/bodyParserProcess.cjs');
const encodings = ['identity', 'gzip', 'deflate', 'br'] as const;
const cases = encodings.flatMap((encoding) =>
  ['valid', 'invalid-json', 'oversized', 'raw'].map((scenario) => [encoding, scenario]),
);
cases.push(...['gzip', 'deflate', 'br'].map((encoding) => [encoding, 'trailing']));

describe('P-161-A body-parser security regression (isolated localhost process)', () => {
  it.each(cases)('%s / %s preserves the contract without crashing', (encoding, scenario) => {
    const result = spawnSync(process.execPath, [fixture, parserPath, encoding, scenario], {
      encoding: 'utf8',
      // Bound a hung child and reap it; this does not change any existing timeout.
      timeout: 2500,
      killSignal: 'SIGKILL',
      env: { PATH: path.dirname(process.execPath), NODE_ENV: 'test' },
    });
    expect({ error: result.error?.message, signal: result.signal, status: result.status, stderr: result.stderr })
      .toEqual({ error: undefined, signal: null, status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      encoding, scenario,
      status: scenario === 'oversized' ? 413 : scenario === 'invalid-json' ? 400 : 200,
      alive: true,
    });
  });
});
