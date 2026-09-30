/**
 * What `GET /api/v1/ldap/{resource}` answers when a list is longer than
 * wanted: longer than the `limit` the client passed, or longer than the
 * directory will list at once.
 *
 * The suite binds as the root DN, which OpenLDAP exempts from its size
 * limits, so the directory's refusal is provoked by binding as an account
 * given one — which needs the embedded server's cn=config. The stubbed cases
 * assert what a real server cannot be made to show: which searches are
 * asked, and the paths no configuration reaches.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import type { AttributesList } from '../../../src/lib/ldapActions';
import {
  hasExternalLdap,
  skipIfMissingEnvVars,
  LDAP_ENV_VARS,
} from '../../helpers/env';
import { getGlobalTestLdapServer } from '../../helpers/ldapServer';

interface Call {
  options: { paged?: unknown; sizeLimit?: number };
}

const ldapError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

const asResult = (entries: AttributesList[]): SearchResult =>
  ({ searchEntries: entries, searchReferences: [] }) as unknown as SearchResult;

/** A refusal raised from the walk, where a paged search actually fails */
const refusingPages = (err: Error): AsyncGenerator<SearchResult> =>
  (async function* () {
    await Promise.resolve();
    throw err;
    // eslint-disable-next-line no-unreachable
    yield asResult([]);
  })() as AsyncGenerator<SearchResult>;

const titles = (count: number): AttributesList[] =>
  Array.from({ length: count }, (_, i) => ({
    dn: `cn=title${i},ou=twakeTitle,ou=nomenclature,dc=example,dc=com`,
    cn: [`title${i}`],
  }));

describe('Flat list, limited', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let realSearch: DM['ldap']['search'];
  let calls: Call[];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/nomenclature/twakeTitle.json',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    realSearch = server.ldap.search.bind(server.ldap);
    request = supertest(server.app);
  });

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    server.ldap.search = realSearch;
  });

  /** Answer every search from `handler`, and remember what was asked */
  const stub = (
    handler: (call: Call) => SearchResult | AsyncGenerator<SearchResult>
  ): void => {
    server.ldap.search = ((options: Call['options']) => {
      const call = { options };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as unknown as typeof server.ldap.search;
  };

  /**
   * A directory that refuses any unbounded search, and answers a bounded one
   * with up to `available` entries — fewer than asked when that is all it
   * will give.
   */
  const refusingUnbounded = (available: number): void =>
    stub(call =>
      call.options.sizeLimit
        ? asResult(titles(Math.min(available, call.options.sizeLimit)))
        : refusingPages(ldapError(4, 'Size Limit Exceeded'))
    );

  describe('against the directory', () => {
    // The fixtures hold three titles: Dr, Mr and Ms.

    it('should return `limit` entries and say others were left out', async () => {
      const res = await request.get('/api/v1/ldap/titles?limit=2');
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body)).to.have.lengthOf(2);
      expect(res.headers['x-result-truncated']).to.equal('true');
    });

    it('should return everything, unflagged, when `limit` is not reached', async () => {
      for (const limit of [3, 50]) {
        const res = await request.get(`/api/v1/ldap/titles?limit=${limit}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.all.keys('Dr', 'Mr', 'Ms');
        expect(res.headers).to.not.have.property('x-result-truncated');
      }
    });

    it('should apply `limit` to a substring search', async () => {
      const res = await request.get(
        '/api/v1/ldap/titles?match=M&attribute=cn&limit=1'
      );
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body)).to.have.lengthOf(1);
      expect(Object.keys(res.body)[0]).to.match(/^M/);
      expect(res.headers['x-result-truncated']).to.equal('true');
    });

    it('should leave the list unflagged without `limit`', async () => {
      const res = await request.get('/api/v1/ldap/titles');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.all.keys('Dr', 'Mr', 'Ms');
      expect(res.headers).to.not.have.property('x-result-truncated');
    });

    it('should refuse a `limit` that is not a positive integer', async () => {
      for (const limit of ['0', '-1', '1.5', 'ten', '', '1e3']) {
        const res = await request.get('/api/v1/ldap/titles').query({ limit });
        expect(res.status, `limit=${limit}`).to.equal(400);
        expect(res.body.error).to.match(/"limit" must be a positive integer/);
      }
      const repeated = await request.get('/api/v1/ldap/titles?limit=1&limit=2');
      expect(repeated.status).to.equal(400);
    });
  });

  describe('when the directory refuses a long list', () => {
    it('should answer 422 without `limit`, not 500', async () => {
      refusingUnbounded(500);
      const res = await request.get('/api/v1/ldap/titles');
      expect(res.status).to.equal(422);
      expect(res.body.error).to.match(/size limit was exceeded.*pass `limit`/);
    });

    it('should answer 422 to a substring search matching too much', async () => {
      refusingUnbounded(500);
      const res = await request.get('/api/v1/ldap/titles?match=a&attribute=cn');
      expect(res.status).to.equal(422);
    });

    it('should ask again with a bounded search when `limit` is given', async () => {
      // ldapts raises `sizeLimitExceeded` only when the request carried no
      // limit of its own: the bounded search comes back with entries.
      refusingUnbounded(500);
      const res = await request.get('/api/v1/ldap/titles?limit=20');
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body)).to.have.lengthOf(20);
      expect(res.headers['x-result-truncated']).to.equal('true');
      expect(calls).to.have.lengthOf(2);
      expect(calls[0].options.sizeLimit).to.equal(undefined);
      expect(calls[1].options.paged).to.equal(false);
      expect(calls[1].options.sizeLimit).to.equal(21);
    });

    it('should flag a bounded answer shorter than `limit` all the same', async () => {
      // The server cuts a bounded search at its own hard limit without
      // ldapts saying so: 10 entries for a limit of 20 prove nothing.
      refusingUnbounded(10);
      const res = await request.get('/api/v1/ldap/titles?limit=20');
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body)).to.have.lengthOf(10);
      expect(res.headers['x-result-truncated']).to.equal('true');
    });

    it('should answer what it has, never 422, once `limit` was given', async () => {
      // Only a search whose bound was lost on the way ends this way: ldapts
      // then raises the refusal and keeps none of the entries.
      stub(call => {
        const refusal = ldapError(4, 'Size Limit Exceeded');
        if (call.options.sizeLimit) throw refusal;
        return refusingPages(refusal);
      });
      const res = await request.get('/api/v1/ldap/titles?limit=20');
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({});
      expect(res.headers['x-result-truncated']).to.equal('true');
    });

    it('should keep any other failure a failure, not an empty list', async () => {
      stub(() => refusingPages(ldapError(53, 'Unwilling to perform')));
      for (const url of [
        '/api/v1/ldap/titles',
        '/api/v1/ldap/titles?limit=5',
      ]) {
        const res = await request.get(url);
        expect(res.status, url).to.equal(500);
      }
      // No second, bounded search: only the size limit earns one.
      expect(calls).to.have.lengthOf(2);
    });
  });
});

describe('Flat list, bound as an account with a size limit', function () {
  // The fixtures hold three titles, and the branch's own entry comes back
  // with them: a limit of two refuses the list, as OpenLDAP's default of 500
  // refuses a larger branch.
  const readerDn = `cn=limited-reader,${process.env.DM_LDAP_BASE}`;
  const password = 'limited-reader-password';
  const access = `to * by dn.exact="${readerDn}" read by * break`;
  const limits = `dn.exact="${readerDn}" size.soft=2 size.hard=2 size.prtotal=2`;
  let admin: DM;
  let request: ReturnType<typeof supertest>;

  before(async function () {
    // cn=config is reachable only in the embedded server's container.
    if (hasExternalLdap()) this.skip();
    admin = new DM();
    await admin.ready;
    await admin.ldap
      .add(readerDn, {
        objectClass: ['organizationalRole', 'simpleSecurityObject'],
        cn: 'limited-reader',
        userPassword: password,
      })
      .catch(() => undefined);
    (await getGlobalTestLdapServer()).modifyConfig(
      [
        'dn: olcDatabase={1}mdb,cn=config',
        'changetype: modify',
        'add: olcAccess',
        `olcAccess: {0}${access}`,
        '-',
        'add: olcLimits',
        `olcLimits: ${limits}`,
        '',
      ].join('\n')
    );

    const env = { dn: process.env.DM_LDAP_DN, pwd: process.env.DM_LDAP_PWD };
    process.env.DM_LDAP_DN = readerDn;
    process.env.DM_LDAP_PWD = password;
    try {
      const server = new DM();
      await server.ready;
      server.config.ldap_flat_schema = [
        './static/schemas/twake/nomenclature/twakeTitle.json',
      ];
      await server.registerPlugin(
        'ldapFlatGeneric',
        new LdapFlatGeneric(server)
      );
      request = supertest(server.app);
    } finally {
      process.env.DM_LDAP_DN = env.dn;
      process.env.DM_LDAP_PWD = env.pwd;
    }
  });

  after(async function () {
    if (hasExternalLdap()) return;
    (await getGlobalTestLdapServer()).modifyConfig(
      [
        'dn: olcDatabase={1}mdb,cn=config',
        'changetype: modify',
        'delete: olcAccess',
        `olcAccess: {0}${access}`,
        '-',
        'delete: olcLimits',
        `olcLimits: {0}${limits}`,
        '',
      ].join('\n')
    );
    await admin.ldap.delete(readerDn).catch(() => undefined);
  });

  it('should answer 422 to a list the directory refuses', async () => {
    const res = await request.get('/api/v1/ldap/titles');
    expect(res.status).to.equal(422);
    expect(res.body.error).to.match(/size limit was exceeded/);
  });

  it('should answer what the directory gives when `limit` is past its limit', async () => {
    const res = await request.get('/api/v1/ldap/titles?limit=10');
    expect(res.status).to.equal(200);
    const ids = Object.keys(res.body);
    expect(ids.length).to.be.within(1, 2);
    expect(['Dr', 'Mr', 'Ms']).to.include.members(ids);
    expect(res.headers['x-result-truncated']).to.equal('true');
  });

  it('should answer `limit` entries when `limit` is within its limit', async () => {
    const res = await request.get('/api/v1/ldap/titles?limit=1');
    expect(res.status).to.equal(200);
    expect(Object.keys(res.body)).to.have.lengthOf(1);
    expect(res.headers['x-result-truncated']).to.equal('true');
  });
});
