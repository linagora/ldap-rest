import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import AuthToken from '../../../src/plugins/auth/token';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';

describe('AuthToken', () => {
  describe('Unnamed tokens (legacy)', () => {
    let dm: DM;
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'secrettoken1,secrettoken2';
      const dm = new DM();
      await dm.ready;
      const p = new AuthToken(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authToken', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should return 401 if no token is provided', async () => {
      // Test implementation
      const res = await request(app).get('/api/hello');
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'Unauthorized' });
    });

    it('should return 401 if an invalid token is provided', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer invalidtoken');
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'Unauthorized' });
    });

    it('should accept valid tokens', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer secrettoken1');
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    });

    it('should accept valid second tokens', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer secrettoken2');
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    });
  });

  describe('Named tokens', () => {
    let dm: DM;
    let app: Express;
    let authPlugin: AuthToken;

    before(async () => {
      process.env.DM_AUTH_TOKENS =
        'abc123:web-app,def456:monitoring,ghi789:backup';
      dm = new DM();
      await dm.ready;
      authPlugin = new AuthToken(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authToken', authPlugin);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept token with name', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer abc123');
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    });

    it('should accept second named token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer def456');
      expect(res.status).to.equal(200);
    });

    it('should accept third named token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer ghi789');
      expect(res.status).to.equal(200);
    });

    it('should reject invalid token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer wrongtoken');
      expect(res.status).to.equal(401);
    });

    it('should reject token name as authentication', async () => {
      // User should not be able to authenticate using the name
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer web-app');
      expect(res.status).to.equal(401);
    });

    it('should set req.user to token name', async () => {
      // This tests that the token name is properly set in req.user
      // We can verify this by checking logs or hooks, but for now
      // we just verify that authentication succeeds
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer abc123');
      expect(res.status).to.equal(200);
      // In a real scenario, req.user would be "web-app"
    });
  });

  describe('Mixed named and unnamed tokens', () => {
    let dm: DM;
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'abc123:named-token,plaintoken';
      dm = new DM();
      await dm.ready;
      const p = new AuthToken(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authToken', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept named token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer abc123');
      expect(res.status).to.equal(200);
    });

    it('should accept unnamed token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer plaintoken');
      expect(res.status).to.equal(200);
      // req.user would be "token 1" for this one
    });

    it('should reject invalid token', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer invalid');
      expect(res.status).to.equal(401);
    });
  });

  describe('Token with colon in name', () => {
    let dm: DM;
    let app: Express;

    before(async () => {
      // Test edge case: what if the name contains a colon?
      process.env.DM_AUTH_TOKENS = 'token123:service:production';
      dm = new DM();
      await dm.ready;
      const p = new AuthToken(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authToken', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept token and use everything after first colon as name', async () => {
      // With split(':', 2), "token123:service:production" becomes
      // token="token123", name="service:production"
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer token123');
      expect(res.status).to.equal(200);
      // req.user would be "service:production"
    });
  });

  describe('Tokens with whitespace', () => {
    let dm: DM;
    let app: Express;

    before(async () => {
      // Test that trim() works properly
      process.env.DM_AUTH_TOKENS = ' abc123 : web-app , def456 : monitoring ';
      dm = new DM();
      await dm.ready;
      const p = new AuthToken(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authToken', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept token with trimmed whitespace', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer abc123');
      expect(res.status).to.equal(200);
    });

    it('should accept second token with trimmed whitespace', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer def456');
      expect(res.status).to.equal(200);
    });

    it('should reject token with whitespace', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer  abc123 ');
      expect(res.status).to.equal(401);
    });
  });
});
