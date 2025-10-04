import { expect } from 'chai';
import request from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import RateLimit from '../../../src/plugins/auth/rateLimit';

// Simple auth plugin that accepts "valid-token" and rejects others
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';

  // Need this to trigger afterAuth hook in AuthBase
  hooks = {
    onAuth: (): void => {
      // Triggers afterAuth hook chain
    },
  };

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token === 'valid-token') {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  api(app: Express): void {
    // Call parent to set up beforeAuth/afterAuth hooks
    super.api(app);

    // Add our test route
    app.get('/api/test', (req: Request, res: Response) => {
      res.json({ message: 'Success' });
    });
  }
}

describe('Rate Limit Plugin', () => {
  let dm: DM;
  let app: Express;

  beforeEach(async () => {
    process.env.DM_RATE_LIMIT_WINDOW_MS = '60000'; // 1 minute
    process.env.DM_RATE_LIMIT_MAX = '5'; // 5 attempts max

    dm = new DM();
    await dm.ready;

    const rateLimit = new RateLimit(dm);
    const testAuth = new TestAuthPlugin(dm);

    await dm.registerPlugin('rateLimit', rateLimit);
    await dm.registerPlugin('testAuth', testAuth);

    app = dm.app;
  });

  it('should allow requests with valid token', async () => {
    const response = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).to.equal(200);
    expect(response.body.message).to.equal('Success');
  });

  it('should reject requests without valid token', async () => {
    const response = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).to.equal(401);
    expect(response.body.error).to.equal('Unauthorized');
  });

  it('should not rate-limit successful requests', async () => {
    // Make 10 successful requests (more than the limit of 5)
    for (let i = 0; i < 10; i++) {
      const response = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).to.equal(200);
      expect(response.body.message).to.equal('Success');
    }
  });

  it('should rate-limit after multiple failed auth attempts', async () => {
    // Make 5 failed attempts (the max limit)
    for (let i = 0; i < 5; i++) {
      const response = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).to.equal(401);
    }

    // The 6th failed attempt should be rate-limited
    const response = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).to.equal(429);
    expect(response.body.error).to.include('Too many authentication attempts');
    expect(response.body.retryAfter).to.be.a('number');
  });

  it('should rate-limit based on IP address', async () => {
    // Simulate requests from different IPs using X-Forwarded-For
    // IP 1: Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer invalid-token')
        .set('X-Forwarded-For', '192.168.1.1');
    }

    // IP 1: Should be rate-limited
    const response1 = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer invalid-token')
      .set('X-Forwarded-For', '192.168.1.1');
    expect(response1.status).to.equal(429);

    // IP 2: Should NOT be rate-limited (different IP)
    const response2 = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer invalid-token')
      .set('X-Forwarded-For', '192.168.1.2');
    expect(response2.status).to.equal(401);
  });

  it('should block all requests from rate-limited IP', async () => {
    // Make 5 failed attempts to trigger rate limit
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer invalid-token');
    }

    // Verify rate-limited for invalid token
    const rateLimitedResponse = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer invalid-token');
    expect(rateLimitedResponse.status).to.equal(429);

    // Even with a valid token, rate-limited IP should be blocked
    // (this prevents attackers from continuing after a successful brute force)
    const validResponse = await request(app)
      .get('/api/test')
      .set('Authorization', 'Bearer valid-token');
    expect(validResponse.status).to.equal(429);
    expect(validResponse.body.error).to.include(
      'Too many authentication attempts'
    );
  });
});
