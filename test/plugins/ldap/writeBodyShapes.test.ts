/**
 * The directory stores text. A JSON number or boolean reached ldapts as is,
 * which threw while encoding the request: a 500. A modify body without
 * `add`, `replace` or `delete` changed nothing and answered success.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Write bodies the directory cannot take as they are', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let topOrg: string;
  let alice: string;
  const created: string[] = [];

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    topOrg = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    alice = `uid=shapes.alice,ou=users,${base}`;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  beforeEach(async () => {
    await server.ldap.delete(alice).catch(() => undefined);
    await server.ldap.add(alice, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: 'shapes.alice',
      cn: 'Shapes Alice',
      sn: 'Alice',
      givenName: 'Shapes',
      displayName: 'Shapes Alice',
      mail: 'shapes.alice@example.com',
      employeeNumber: 'SHA0001',
      mobile: '+33600000000',
      twakeDepartmentLink: topOrg,
      twakeDepartmentPath: 'Top',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    });
  });

  after(async () => {
    for (const dn of [alice, ...created])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  const read = async (attribute: string): Promise<unknown> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: [attribute] },
      alice
    )) as SearchResult;
    return res.searchEntries[0]?.[attribute];
  };

  describe('values that are not text', () => {
    const newUser = (
      extra: Record<string, unknown>
    ): Record<string, unknown> => ({
      cn: 'Shapes Bob',
      sn: 'Bob',
      givenName: 'Shapes',
      displayName: 'Shapes Bob',
      mail: 'shapes.bob@example.com',
      employeeNumber: 'SHA0002',
      twakeDepartmentLink: topOrg,
      ...extra,
    });

    for (const [name, value] of [
      ['employeeNumber', 12345],
      ['mobile', true],
      ['mobile', { number: '1' }],
      ['mobile', ['+33600000001', 2]],
    ] as const) {
      it(`should refuse ${JSON.stringify(value)} for ${name} on a creation`, async () => {
        const res = await request
          .post('/api/v1/ldap/users')
          .send(newUser({ [name]: value }));
        expect(res.status, JSON.stringify(res.body)).to.equal(400);
        expect(res.body.error).to.equal(
          `Attribute "${name}" must be a string or an array of strings`
        );
      });
    }

    it('should refuse a number for a text attribute on a modify', async () => {
      const res = await request
        .put('/api/v1/ldap/users/shapes.alice')
        .send({ replace: { mobile: 5 } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(await read('mobile')).to.equal('+33600000000');
    });

    it('should write a number as text where the schema declares one', async () => {
      const res = await request
        .put('/api/v1/ldap/users/shapes.alice')
        .send({ replace: { mailQuotaSize: 1000 } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read('mailQuotaSize')).to.equal('1000');
    });

    it('should write a boolean as LDAP TRUE where the schema declares one', async () => {
      const res = await request
        .put('/api/v1/ldap/users/shapes.alice')
        .send({ replace: { pwdReset: true } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read('pwdReset')).to.equal('TRUE');
    });
  });

  describe('modify bodies', () => {
    for (const body of [
      {},
      { twakeDepartmentLink: 'ou=Sales,dc=example,dc=com' },
      { foo: 'bar' },
      { replace: { description: 'x' }, extra: 1 },
      { replace: 'x' },
      { add: ['description'] },
      { delete: [1] },
    ]) {
      it(`should refuse ${JSON.stringify(body)} on a user`, async () => {
        const res = await request
          .put('/api/v1/ldap/users/shapes.alice')
          .send(body);
        expect(res.status, JSON.stringify(res.body)).to.equal(400);
      });
    }

    it('should name the keys it does not know', async () => {
      const res = await request
        .put('/api/v1/ldap/users/shapes.alice')
        .send({ twakeDepartmentLink: topOrg });
      expect(res.body.error).to.equal(
        'A modification carries add, replace or delete, not twakeDepartmentLink'
      );
    });

    it('should refuse a body without a change on a group', async () => {
      const group = `cn=shapes-guild,${server.config.ldap_group_base}`;
      await server.ldap.delete(group).catch(() => undefined);
      await server.ldap.add(group, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'shapes-guild',
        member: [alice],
      });
      created.push(group);
      const res = await request
        .put('/api/v1/ldap/groups/shapes-guild')
        .send({ description: 'x' });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });

    it('should refuse a body without a change on an organization', async () => {
      const res = await request
        .put(`/api/v1/ldap/organizations/${encodeURIComponent(topOrg)}`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
    });

    it('should still apply a well-formed modification', async () => {
      const res = await request
        .put('/api/v1/ldap/users/shapes.alice')
        .send({ replace: { mobile: '+33600000002' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read('mobile')).to.equal('+33600000002');
    });
  });
});
