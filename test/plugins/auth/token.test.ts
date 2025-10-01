import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import AuthToken from '../../../src/plugins/auth/token';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';

describe('AuthToken', () => {
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
