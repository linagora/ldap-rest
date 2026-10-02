import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import AuthHmac from '../../../src/plugins/auth/hmac';
import { HmacAuthClient } from '../../../src/browser/shared/utils/hmac';

/**
 * The browser client against the server it signs for: what one sends, the
 * other must accept.
 */
describe('HmacAuthClient against core/auth/hmac', () => {
  const serviceId = 'browser-client';
  const secret = 'browser-client-secret-with-sufficient-length';
  let server: Server;
  let origin: string;
  let client: HmacAuthClient;
  const globals = globalThis as { window?: unknown };

  before(async () => {
    process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Browser Client`;
    const dm = new DM();
    await dm.ready;
    await dm.registerPlugin('authHmac', new AuthHmac(dm));
    dm.app.post('/api/hmac-client-echo', (req, res) => {
      res.json({ type: req.headers['content-type'], body: req.body });
    });
    server = dm.app.listen(0);
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The client takes the path it signs from the page's origin
    globals.window = { location: { origin } };
    client = new HmacAuthClient({ serviceId, secret });
  });

  after(() => {
    delete globals.window;
    server.close();
  });

  it('sends an object as JSON', async () => {
    const res = await client.post(`${origin}/api/hmac-client-echo`, {
      a: 'b',
    });
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.include({ body: { a: 'b' } });
  });

  it('sends a string as JSON', async () => {
    const res = await client.post(
      `${origin}/api/hmac-client-echo`,
      '{"a": "b"}'
    );
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({
      type: 'application/json',
      body: { a: 'b' },
    });
  });

  it('keeps the Content-Type a caller sets for a string', async () => {
    const res = await client.post(`${origin}/api/hmac-client-echo`, 'a=b', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({
      type: 'application/x-www-form-urlencoded',
      body: { a: 'b' },
    });
  });
});
