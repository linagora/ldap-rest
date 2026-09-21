/**
 * What happens when a rename cannot be finished.
 *
 * The `modifyDN` is the only rollback point. Before it, nothing has
 * happened and a refusal is the directory's own; after it, the rename is a
 * fact and hiding it behind a 500 would describe a directory that does not
 * exist. So a rewrite that fails answers 207: the entry was renamed, and
 * here is what still names the old DN.
 *
 * The body counts per attribute and never names the referring entry: the
 * caller owns the entry it renamed, not the entries pointing at it. The
 * operator gets both DNs in the log.
 *
 * Re-issuing the same request is then the repair — it is also the repair for
 * a crash between the rename and the rewrite, which leaves the directory in
 * exactly the same state.
 *
 * The reference used here is `twakeDelegatedUsers`. A group membership would
 * not do: OpenLDAP's `refint` overlay rewrites `member` on its own, so the
 * directory would repair what this test needs left broken.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import type { Hooks } from '../../../src/hooks';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { ConflictError } from '../../../src/lib/errors';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import { normalizeDn } from '../../../src/lib/utils';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/**
 * A directory that refuses one entry, or the rename itself. Standing in for
 * an access control the caller does not satisfy, or a directory that says no.
 */
class Saboteur extends DmPlugin {
  name = 'renameSaboteur';
  roles: Role[] = ['consistency'] as const;

  /** Entry whose modification is refused, none when unset */
  unwritable?: string;
  /** Refuse the modifyDN itself */
  refuseRename = false;

  hooks: Hooks = {
    ldapmodifyrequest: ([dn, changes, op, req]) => {
      if (this.unwritable && normalizeDn(dn) === normalizeDn(this.unwritable))
        throw new Error('insufficient access rights');
      return [dn, changes, op, req];
    },
    ldaprenamerequest: ([oldDn, newDn, req]) => {
      if (this.refuseRename)
        throw new ConflictError('the directory refuses this rename');
      return [oldDn, newDn, req];
    },
  };
}

describe('Flat entity rename, what could not be finished', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let saboteur: Saboteur;
  let base: string;
  let userBranch: string;
  let orgDn: string;
  let aliceDn: string;
  let renamedDn: string;
  const ALICE = 'fail.alice';
  const RENAMED = 'fail.alice.renamed';
  const GOOD = 'fail.good';
  const DOOMED = 'fail.doomed';

  const user = (uid: string, employeeNumber: string): AttributesList => ({
    objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
    uid,
    cn: uid,
    sn: 'Fail',
    givenName: 'Test',
    displayName: `Test ${uid}`,
    mail: `${uid}@example.com`,
    employeeNumber,
    twakeDepartmentLink: orgDn,
    twakeDepartmentPath: 'FailOrg',
    twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    twakeDeliveryMode: [
      `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
    ],
  });

  const delegates = async (uid: string): Promise<string[]> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base' },
      `uid=${uid},${userBranch}`
    )) as SearchResult;
    const value = res.searchEntries[0]?.twakeDelegatedUsers;
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgDn = `ou=FailOrg,${base}`;
    aliceDn = `uid=${ALICE},${userBranch}`;
    renamedDn = `uid=${RENAMED},${userBranch}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];

    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'FailOrg',
        twakeDepartmentPath: 'FailOrg',
      })
      .catch(() => undefined);

    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    saboteur = new Saboteur(server);
    await server.registerPlugin('renameSaboteur', saboteur);
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      aliceDn,
      renamedDn,
      `uid=${GOOD},${userBranch}`,
      `uid=${DOOMED},${userBranch}`,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  beforeEach(async () => {
    saboteur.unwritable = undefined;
    saboteur.refuseRename = false;
    for (const dn of [
      aliceDn,
      renamedDn,
      `uid=${GOOD},${userBranch}`,
      `uid=${DOOMED},${userBranch}`,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    await server.ldap.add(aliceDn, user(ALICE, 'FAI0001'));
    for (const [uid, number] of [
      [GOOD, 'FAI0002'],
      [DOOMED, 'FAI0003'],
    ]) {
      await server.ldap.add(`uid=${uid},${userBranch}`, {
        ...user(uid, number),
        twakeDelegatedUsers: [aliceDn],
      });
    }
  });

  const rename = (id: string, newId: string): supertest.Test =>
    request
      .post(`/api/v1/ldap/users/${encodeURIComponent(id)}/rename`)
      .type('json')
      .send({ newId });

  it('should answer 207 when a reference cannot be rewritten, and rewrite the others', async () => {
    saboteur.unwritable = `uid=${DOOMED},${userBranch}`;
    const res = await rename(ALICE, RENAMED);

    expect(res.status, JSON.stringify(res.body)).to.equal(207);
    expect(res.body).to.deep.equal({
      success: false,
      dn: renamedDn,
      referencesUpdated: 1,
      referencesFailed: [{ attribute: 'twakeDelegatedUsers', count: 1 }],
    });
    // The caller owns the entry it renamed, not the entries pointing at it.
    expect(JSON.stringify(res.body)).to.not.match(new RegExp(DOOMED));

    // The rename happened and is not rolled back.
    expect(await delegates(GOOD)).to.deep.equal([renamedDn]);
    expect(await delegates(DOOMED)).to.deep.equal([aliceDn]);
  });

  it('should repair the leftover when the same rename is re-issued', async () => {
    saboteur.unwritable = `uid=${DOOMED},${userBranch}`;
    expect((await rename(ALICE, RENAMED)).status).to.equal(207);

    saboteur.unwritable = undefined;
    const res = await rename(ALICE, RENAMED);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.deep.equal({
      success: true,
      dn: renamedDn,
      referencesUpdated: 1,
    });
    expect(await delegates(DOOMED)).to.deep.equal([renamedDn]);
    expect(await delegates(GOOD)).to.deep.equal([renamedDn]);
  });

  it('should answer the directory when the rename itself is refused, changing nothing', async () => {
    saboteur.refuseRename = true;
    const res = await rename(ALICE, RENAMED);

    expect(res.status, JSON.stringify(res.body)).to.equal(409);
    const found = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['dn'] },
      aliceDn
    )) as SearchResult;
    expect(found.searchEntries).to.have.length(1);
    for (const uid of [GOOD, DOOMED])
      expect(await delegates(uid), uid).to.deep.equal([aliceDn]);
  });
});
