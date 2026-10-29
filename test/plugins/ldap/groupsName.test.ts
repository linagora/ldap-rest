/**
 * The name of a group, on its route and in `addGroup`: a value names it in
 * the groups branch, a DN says where it lies. The two readings must refuse
 * the same inputs, and answer 400 rather than 500 when the name cannot be
 * written.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const B = String.fromCharCode(92);

describe('The name of a group', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  const route = '/api/v1/ldap/groups';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    // This is about how a name is read, not about the schema's patterns
    process.env.DM_GROUP_SCHEMA = '';
    server = new DM();
    await server.ready;
    server.config.ldap_group_base = `ou=lists,ou=groups,${base}`;
    await server.registerPlugin('core/ldap/groups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  // Built when the tests run: `base` is known only once the server started
  const refused = (): [string, string, RegExp][] => [
    ['an empty name', '', /non-empty/],
    // A raw control character, and one a DN escapes: both name nothing
    ['a name holding a control character', 'a\u0001', /control characters/],
    [
      'a DN whose value escapes a control character',
      `cn=a${B}0A,ou=lists,ou=groups,${base}`,
      /control characters/,
    ],
  ];

  for (const index of [0, 1, 2])
    it(`answers 400 for ${refused()[index][0]}`, async () => {
      const [label, cn, message] = refused()[index];
      const res = await request.post(route).send({ cn, member: [] });
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).to.equal(400);
      expect(res.body.error).to.match(message);
    });

  it('answers 400 for a DN that cannot name the group', async () => {
    // A multi-valued RDN: read as a value it would be written whole
    const dn = `cn=a+ou=b,ou=lists,ou=groups,${base}`;
    const res = await request.post(route).send({ cn: dn, member: [] });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/must be a value, or a/);
  });

  it('creates a group named by a DN whose value carries an escaped comma', async () => {
    // The route reads the DN as `addGroup` does: one comma is no separator
    const dn = `cn=Sales${B}, EMEA,ou=lists,ou=groups,${base}`;
    const res = await request.post(route).send({ cn: dn, member: [] });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    await server.ldap.delete(dn).catch(() => undefined);
  });
});
