import { expect } from 'chai';
import request from 'supertest';
import nock from 'nock';
import type { Express } from 'express';
import DmPlugin from '@ldap-rest/core/abstract/plugin';
import CrowdSec from '@ldap-rest/auth-crowdsec';
import TrustedProxy from '@ldap-rest/auth-trustedproxy';

import { DM } from '../../helpers/dm';
import { outboundCalls } from '../../helpers/metrics';

// Simple plugin to test CrowdSec blocking
class TestPlugin extends DmPlugin {
  name = 'testPlugin';

  api(app: Express): void {
    app.get('/api/test', (req, res) => {
      res.json({ message: 'Success' });
    });
  }
}

describe('CrowdSec Plugin', () => {
  let dm: DM;
  let app: Express;
  const crowdsecUrl = 'http://localhost:8080';
  const apiKey = 'test-api-key-123';

  beforeEach(async () => {
    process.env.DM_CROWDSEC_URL = `${crowdsecUrl}/v1/decisions`;
    process.env.DM_CROWDSEC_API_KEY = apiKey;
    process.env.DM_CROWDSEC_CACHE_TTL = '1'; // 1 second cache for tests
    process.env.DM_TRUSTED_PROXIES = '127.0.0.1';

    dm = new DM();
    await dm.ready;

    const trustedProxy = new TrustedProxy(dm);
    const crowdsec = new CrowdSec(dm);
    const testPlugin = new TestPlugin(dm);

    await dm.registerPlugin('trustedProxy', trustedProxy);
    await dm.registerPlugin('crowdsec', crowdsec);
    await dm.registerPlugin('testPlugin', testPlugin);

    app = dm.app;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.DM_TRUSTED_PROXIES;
  });

  it('should allow requests from non-banned IPs', async () => {
    const clientIp = '192.168.1.100';

    // Mock CrowdSec API returning no decision (null as string)
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, 'null');

    const asked = await outboundCalls('crowdsec', '200');
    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    expect(response.status).to.equal(200);
    expect(response.body.message).to.equal('Success');
    expect(await outboundCalls('crowdsec', '200')).to.equal(asked + 1);
  });

  it('should block requests from banned IPs', async () => {
    const clientIp = '10.0.0.50';

    // Mock CrowdSec API returning a ban decision
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, [
        {
          duration: '4h',
          id: 12345,
          origin: 'cscli',
          scenario: 'manual ban',
          scope: 'ip',
          type: 'ban',
          value: clientIp,
        },
      ]);

    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    expect(response.status).to.equal(403);
    expect(response.body.error).to.equal('Access denied');
    expect(response.body.reason).to.include('banned');
  });

  it('should allow requests if IP has non-ban decision', async () => {
    const clientIp = '172.16.0.10';

    // Mock CrowdSec API returning a captcha decision (not ban)
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, [
        {
          duration: '1h',
          id: 54321,
          origin: 'cscli',
          scenario: 'test scenario',
          scope: 'ip',
          type: 'captcha',
          value: clientIp,
        },
      ]);

    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    expect(response.status).to.equal(200);
    expect(response.body.message).to.equal('Success');
  });

  it('should use cache for repeated requests', async () => {
    const clientIp = '192.168.1.200';

    // Mock CrowdSec API - should only be called once due to caching
    const scope = nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, 'null');

    // First request - will query CrowdSec
    await request(app).get('/api/test').set('X-Forwarded-For', clientIp);

    // Second request - should use cache
    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    expect(response.status).to.equal(200);
    expect(scope.isDone()).to.be.true;

    // Only one API call should have been made
    expect(nock.pendingMocks().length).to.equal(0);
  });

  it('caches two clients taking turns independently', async () => {
    const first = '192.168.1.201';
    const second = '192.168.1.202';
    const one = nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: first })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, 'null');
    const two = nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: second })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, 'null');

    for (let turn = 0; turn < 2; turn++) {
      await request(app).get('/api/test').set('X-Forwarded-For', first);
      await request(app).get('/api/test').set('X-Forwarded-For', second);
    }

    expect(one.isDone(), 'first client').to.be.true;
    expect(two.isDone(), 'second client').to.be.true;
  });

  it('should fail open if CrowdSec API is unavailable', async () => {
    const clientIp = '192.168.1.250';

    // Mock CrowdSec API returning error
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(500, 'Internal Server Error');

    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    // Should allow request despite CrowdSec error
    expect(response.status).to.equal(200);
    expect(response.body.message).to.equal('Success');
  });

  it('should handle multiple ban decisions correctly', async () => {
    const clientIp = '10.0.0.100';

    // Mock CrowdSec API returning multiple decisions including ban
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, [
        {
          duration: '1h',
          id: 1,
          origin: 'cscli',
          scenario: 'captcha scenario',
          scope: 'ip',
          type: 'captcha',
          value: clientIp,
        },
        {
          duration: '4h',
          id: 2,
          origin: 'cscli',
          scenario: 'ban scenario',
          scope: 'ip',
          type: 'ban',
          value: clientIp,
        },
      ]);

    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', clientIp);

    expect(response.status).to.equal(403);
    expect(response.body.error).to.equal('Access denied');
  });

  it('should extract IP from X-Forwarded-For with multiple proxies', async () => {
    const clientIp = '203.0.113.50';
    const proxyChain = `${clientIp}, 10.0.0.1, 172.16.0.1`;

    // Mock CrowdSec API - should query for the first IP only
    nock(crowdsecUrl)
      .get('/v1/decisions')
      .query({ ip: clientIp })
      .matchHeader('X-Api-Key', apiKey)
      .reply(200, 'null');

    const response = await request(app)
      .get('/api/test')
      .set('X-Forwarded-For', proxyChain);

    expect(response.status).to.equal(200);
  });
});
