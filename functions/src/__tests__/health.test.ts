import { functionUrl } from './emulator';

describe('health (Functions Emulator)', () => {
  const url = functionUrl('health');

  it('GET で 200 と { status: "ok" } を返す', async () => {
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET 以外は 405 を返す', async () => {
    const res = await fetch(url, { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});
