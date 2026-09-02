import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

/**
 * RFC 7644 section 3.4.2.4 — a list answers a window over the matching
 * resources, never an error because the collection is bigger than one page.
 */
describe('SCIM pagination (integration)', function () {
  const TOTAL = 12;
  const PAGE = 5;

  let server: DM;
  let plugin: Scim;
  let userBase: string;
  const saved: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string): void => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };

  before(async function () {
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn('Skipping SCIM pagination tests: LDAP env vars missing');
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=scimpage,${baseDn}`;
    setEnv('DM_SCIM_USER_BASE', userBase);
    setEnv('DM_SCIM_GROUP_BASE', `ou=groups,${baseDn}`);
    // A page smaller than the collection is the whole point of the suite.
    setEnv('DM_SCIM_MAX_RESULTS', String(PAGE));

    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;

    try {
      await plugin.ldap.add(userBase, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'scimpage',
      });
    } catch {
      /* may already exist */
    }
    for (let i = 0; i < TOTAL; i++) {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: `page-user-${String(i).padStart(2, '0')}`,
          name: { familyName: 'Page' },
        })
        .expect(201);
    }
  });

  after(async () => {
    if (plugin) {
      for (let i = 0; i < TOTAL; i++) {
        try {
          await plugin.ldap.delete(
            `uid=page-user-${String(i).padStart(2, '0')},${userBase}`
          );
        } catch {
          /* ignore */
        }
      }
      try {
        await plugin.ldap.delete(userBase);
      } catch {
        /* ignore */
      }
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const list = (query = ''): supertest.Test =>
    supertest(server.app).get(`/scim/v2/Users${query}`);

  it('answers a page instead of tooMany when the collection is larger', async () => {
    // This used to be a 400: the handler fetched everything and refused as
    // soon as the total passed --scim-max-results, even with no filter.
    const res = await list().expect(200);
    expect(res.body.totalResults).to.equal(TOTAL);
    expect(res.body.itemsPerPage).to.equal(PAGE);
    expect(res.body.startIndex).to.equal(1);
    expect(res.body.Resources).to.have.lengthOf(PAGE);
  });

  it('walks the whole collection through startIndex', async () => {
    const seen: string[] = [];
    for (let start = 1; start <= TOTAL; start += PAGE) {
      const res = await list(`?startIndex=${start}&count=${PAGE}`).expect(200);
      expect(res.body.totalResults).to.equal(TOTAL);
      expect(res.body.startIndex).to.equal(start);
      seen.push(...res.body.Resources.map((r: { id: string }) => r.id));
    }
    // Every resource exactly once: no gap, no repeat across pages.
    expect(seen).to.have.lengthOf(TOTAL);
    expect(new Set(seen).size).to.equal(TOTAL);
  });

  it('answers an empty page past the end, with the real total', async () => {
    const res = await list(`?startIndex=${TOTAL + 5}&count=${PAGE}`).expect(
      200
    );
    expect(res.body.totalResults).to.equal(TOTAL);
    expect(res.body.itemsPerPage).to.equal(0);
    expect(res.body.Resources).to.have.lengthOf(0);
  });

  it('count=0 answers the total and no resource', async () => {
    const res = await list('?count=0').expect(200);
    expect(res.body.totalResults).to.equal(TOTAL);
    expect(res.body.itemsPerPage).to.equal(0);
    expect(res.body.Resources).to.have.lengthOf(0);
  });

  it('caps count at --scim-max-results', async () => {
    const res = await list('?count=1000').expect(200);
    expect(res.body.itemsPerPage).to.equal(PAGE);
    expect(res.body.totalResults).to.equal(TOTAL);
  });

  it('paginates a filtered collection too', async () => {
    const res = await list(
      '?filter=' + encodeURIComponent('userName sw "page-user-0"') + '&count=3'
    ).expect(200);
    // page-user-00 … page-user-09
    expect(res.body.totalResults).to.equal(10);
    expect(res.body.itemsPerPage).to.equal(3);
  });

  describe('with a scan bound below the collection size', () => {
    let boundedServer: DM;
    let boundedPlugin: Scim;
    let savedScanned: string | undefined;

    before(async () => {
      savedScanned = process.env.DM_SCIM_MAX_SCANNED;
      process.env.DM_SCIM_MAX_SCANNED = '4';
      boundedServer = new DM();
      boundedPlugin = new Scim(boundedServer);
      await boundedPlugin.api(boundedServer.app);
      await boundedServer.ready;
    });

    after(() => {
      if (savedScanned === undefined) delete process.env.DM_SCIM_MAX_SCANNED;
      else process.env.DM_SCIM_MAX_SCANNED = savedScanned;
    });

    it('answers tooMany, which RFC 7644 section 3.12 provides for', async () => {
      const res = await supertest(boundedServer.app)
        .get('/scim/v2/Users')
        .expect(400);
      expect(res.body.scimType).to.equal('tooMany');
      expect(res.body.schemas[0]).to.equal(
        'urn:ietf:params:scim:api:messages:2.0:Error'
      );
    });
  });
});
