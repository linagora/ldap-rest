import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import WebLogs from '../../src/plugins/weblogs';

describe('weblogs', () => {
  let dm: DM;
  let plugin: WebLogs;
  let notices: Record<string, unknown>[];
  let savedLdapBase: string | undefined;

  before(() => {
    savedLdapBase = process.env.DM_LDAP_BASE;
  });

  after(() => {
    if (savedLdapBase !== undefined) {
      process.env.DM_LDAP_BASE = savedLdapBase;
    } else {
      delete process.env.DM_LDAP_BASE;
    }
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_LDAP_BASE = 'dc=example,dc=com';
    dm = new DM();
    await dm.ready;

    plugin = new WebLogs(dm);
    await dm.registerPlugin('weblogs', plugin);

    // Collect what would be written to the access log
    notices = [];
    plugin.logger.notice = ((entry: Record<string, unknown>) => {
      notices.push(entry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    // Routes are declared after registerPlugin so the middleware sees them
    dm.app.get('/test/plain', (_req, res) => {
      res.json({ ok: true });
    });

    dm.app.get('/test/details', (req, res) => {
      req.logDetails = { uids: ['u1', 'u2'], entries: 2 };
      res.json({ ok: true });
    });

    dm.app.get('/test/override', (req, res) => {
      // A plugin must not be able to rewrite the core fields
      req.logDetails = { url: '/spoofed', status: 999, custom: 'kept' };
      res.status(418).json({ ok: false });
    });
  });

  it('should log the standard fields', async () => {
    await supertest(dm.app).get('/test/plain').expect(200);

    expect(notices).to.have.lengthOf(1);
    expect(notices[0]).to.include({
      method: 'GET',
      url: '/test/plain',
      status: 200,
    });
    expect(notices[0]).to.have.property('duration');
    expect(notices[0]).to.have.property('ip');
  });

  it('should merge req.logDetails into the access log entry', async () => {
    await supertest(dm.app).get('/test/details').expect(200);

    expect(notices).to.have.lengthOf(1);
    expect(notices[0].uids).to.deep.equal(['u1', 'u2']);
    expect(notices[0].entries).to.equal(2);
    // Standard fields are still there
    expect(notices[0]).to.include({ method: 'GET', url: '/test/details' });
  });

  it('should not let req.logDetails override core fields', async () => {
    await supertest(dm.app).get('/test/override').expect(418);

    expect(notices).to.have.lengthOf(1);
    expect(notices[0]).to.include({
      url: '/test/override',
      status: 418,
      custom: 'kept',
    });
  });

  it('should log nothing extra when req.logDetails is unset', async () => {
    await supertest(dm.app).get('/test/plain').expect(200);

    expect(Object.keys(notices[0]).sort()).to.deep.equal([
      'duration',
      'ip',
      'method',
      'status',
      'url',
    ]);
  });
});
