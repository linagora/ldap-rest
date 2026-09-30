import { expect } from 'chai';

import { DM } from '../../src/bin';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

/**
 * An entry created by another tool than this one may lack a class its
 * schema declares, and the directory then refuses an attribute that class
 * carries. A modify writing such an attribute adds the auxiliary class that
 * allows it.
 */
describe('Object class repair on modify', function () {
  let server: DM;
  let users: any;
  let base: string;
  let usersBase: string;
  let orgDn: string;
  let accountDn: string;
  let strayDn: string;

  const classes = async (dn: string): Promise<string[]> => {
    const result = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['objectClass'] },
      dn
    )) as { searchEntries: Record<string, unknown>[] };
    const raw = result.searchEntries[0].objectClass as string | string[];
    return (Array.isArray(raw) ? raw : [raw]).map(c => c.toLowerCase());
  };

  /** A server with no plugin: only the declarations a test makes. */
  const bare = (): DM => new DM();

  const status = async (write: Promise<unknown>): Promise<number | 'ok'> => {
    try {
      await write;
      return 'ok';
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    usersBase = `ou=users,${base}`;
    orgDn = `ou=RepairTest,${base}`;
    accountDn = `uid=repair-test,${usersBase}`;
    strayDn = `uid=repair-stray,${orgDn}`;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    users = new LdapFlatGeneric(server).instances[0];
    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'RepairTest',
        twakeDepartmentPath: 'RepairTest',
      })
      .catch(() => undefined);
  });

  beforeEach(async () => {
    for (const dn of [accountDn, strayDn])
      await server.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: dn === accountDn ? 'repair-test' : 'repair-stray',
        cn: 'Repair Test',
        sn: 'Test',
      });
  });

  afterEach(async () => {
    for (const dn of [accountDn, strayDn])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  after(async () => {
    await server?.ldap.delete(orgDn).catch(() => undefined);
  });

  it('should give an account made elsewhere the class its organization link needs', async () => {
    await users.moveEntry('repair-test', orgDn);
    expect(await classes(accountDn)).to.include('twakewhitepages');
    // A structural class cannot be added to an existing entry.
    expect(await classes(accountDn)).not.to.include('twakeaccount');
  });

  it('should add nothing a change does not need', async () => {
    await server.ldap.modify(accountDn, { replace: { description: 'x' } });
    expect(await classes(accountDn)).not.to.include('twakewhitepages');
  });

  it('should leave the classes alone when the change names them', async () => {
    expect(
      await status(
        server.ldap.modify(accountDn, {
          replace: {
            objectClass: ['top', 'inetOrgPerson'],
            twakeDepartmentLink: orgDn,
          },
        })
      )
    ).to.equal(409);
    expect(await classes(accountDn)).not.to.include('twakewhitepages');
  });

  it('should answer 409, not 500, when the entry cannot hold the change', async () => {
    // Outside every declared branch: nothing is repaired.
    let raised: unknown;
    try {
      await server.ldap.modify(strayDn, {
        replace: { twakeDepartmentLink: orgDn },
      });
    } catch (err) {
      raised = err;
    }
    expect((raised as { statusCode?: number }).statusCode).to.equal(409);
    expect((raised as { code?: number }).code).to.equal(65);
  });

  it('should repair nothing when --ldap-flat-auto-repair is off', async () => {
    const dm = bare();
    dm.config.ldap_flat_auto_repair = false;
    dm.ldap.declareObjectClasses(usersBase, ['top', 'twakeWhitePages']);
    expect(
      await status(
        dm.ldap.modify(accountDn, { replace: { twakeDepartmentLink: orgDn } })
      )
    ).to.equal(409);
    expect(await classes(accountDn)).not.to.include('twakewhitepages');
  });

  it('should add an auxiliary class only once its mandatory attributes are there', async function () {
    const dm = bare();
    const index = await dm.ldap.schemaIndex();
    if (index.getObjectClass('posixAccount')?.kind !== 'AUXILIARY')
      return this.skip();
    dm.ldap.declareObjectClasses(orgDn, ['posixAccount']);

    expect(
      await status(dm.ldap.modify(strayDn, { replace: { uidNumber: '10042' } }))
    ).to.equal(409);
    expect(await classes(strayDn)).not.to.include('posixaccount');

    await dm.ldap.modify(strayDn, {
      replace: {
        uidNumber: '10042',
        gidNumber: '10042',
        homeDirectory: '/home/repair-stray',
      },
    });
    expect(await classes(strayDn)).to.include('posixaccount');
  });

  it('should consider every entity sharing a branch, whatever their order', async function () {
    for (const order of [
      [
        ['posixAccount', 'shadowAccount'],
        ['top', 'twakeWhitePages'],
      ],
      [
        ['top', 'twakeWhitePages'],
        ['posixAccount', 'shadowAccount'],
      ],
    ]) {
      const dm = bare();
      const index = await dm.ldap.schemaIndex();
      if (index.getObjectClass('posixAccount')?.kind !== 'AUXILIARY')
        return this.skip();
      for (const declared of order)
        dm.ldap.declareObjectClasses(usersBase, declared);

      await dm.ldap.modify(accountDn, {
        replace: { twakeDepartmentLink: orgDn },
      });
      await dm.ldap.modify(accountDn, {
        replace: {
          uidNumber: '10043',
          gidNumber: '10043',
          homeDirectory: '/home/repair-test',
        },
      });
      const held = await classes(accountDn);
      expect(held).to.include.members(['twakewhitepages', 'posixaccount']);
      // Declared for the branch, needed by no write.
      expect(held).not.to.include('shadowaccount');

      await server.ldap.delete(accountDn);
      await server.ldap.add(accountDn, {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'repair-test',
        cn: 'Repair Test',
        sn: 'Test',
      });
    }
  });

  it('should keep one declaration per distinct base and classes', () => {
    const dm = bare();
    for (let i = 0; i < 3; i++) {
      dm.ldap.declareObjectClasses(usersBase, ['top', 'twakeWhitePages']);
      dm.ldap.declareObjectClasses(usersBase.toUpperCase(), [
        'twakeWhitePages',
        'TOP',
      ]);
    }
    dm.ldap.declareObjectClasses(usersBase, ['top', 'twakeWhitePages'], true);
    dm.ldap.declareObjectClasses(usersBase, ['posixAccount']);
    expect((dm.ldap as any).declaredClasses.size).to.equal(3);
  });

  it('should take classes a schema file gives as a single string', async () => {
    const dm = bare();
    dm.ldap.declareObjectClasses(
      usersBase,
      'twakeWhitePages' as unknown as string[]
    );
    await dm.ldap.modify(accountDn, {
      replace: { twakeDepartmentLink: orgDn },
    });
    expect(await classes(accountDn)).to.include('twakewhitepages');
  });

  it('should not fail when a writer gave the entry the class in the meantime', async () => {
    const dm = bare();
    // What the repair would decide from a read taken before that writer.
    (dm.ldap as any).classRepair = async (): Promise<string[]> => [
      'twakeWhitePages',
    ];
    await server.ldap.modify(accountDn, {
      add: { objectClass: 'twakeWhitePages' },
    });
    await dm.ldap.modify(accountDn, { replace: { description: 'raced' } });
  });

  it('should report an entry it cannot repair once, not on every write', async () => {
    const dm = bare();
    dm.ldap.declareObjectClasses(usersBase, [
      'top',
      'twakeAccount',
      'twakeWhitePages',
    ]);
    const warned: string[] = [];
    const warn = dm.logger.warn.bind(dm.logger);
    (dm.logger as any).warn = (message: string, ...rest: unknown[]) => {
      warned.push(String(message));
      return warn(message, ...rest);
    };
    for (let i = 0; i < 2; i++)
      expect(
        await status(
          dm.ldap.modify(accountDn, {
            replace: {
              twakeDepartmentLink: orgDn,
              twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
            },
          })
        )
      ).to.equal(409);
    expect(
      warned.filter(message => message.includes('structural class'))
    ).to.have.length(1);
  });
});
