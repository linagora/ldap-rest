/**
 * `core/ldap/flatGeneric` is loaded once and creates one instance per schema.
 * Everything reading those instances — the enterprise rules, the lifecycle
 * endpoints, the configuration API — must therefore hold for two entities at
 * once, and must not apply one entity's rules to the other's entries.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import LdapAccountLifecycle from '../../../src/plugins/ldap/accountLifecycle';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('flatGeneric with several entities', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let flat: LdapFlatGeneric;
  let base: string;
  let deptDn: string;
  const userDnOf = (id: string) => `uid=${id},ou=users,${base}`;
  const positionDnOf = (id: string) => `cn=${id},ou=positions,${base}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    deptDn = `ou=MultiOrg,${base}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/users.json',
      './static/schemas/twake/positions.json',
    ];

    await server.ldap
      .add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'MultiOrg',
        twakeDepartmentPath: 'MultiOrg',
      })
      .catch(() => undefined);

    flat = new LdapFlatGeneric(server);
    await server.registerPlugin('ldapFlatGeneric', flat);
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    await server.registerPlugin(
      'ldapAccountLifecycle',
      new LdapAccountLifecycle(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    await server.ldap.delete(userDnOf('multi.user')).catch(() => undefined);
    await server.ldap
      .delete(positionDnOf('Multi Position'))
      .catch(() => undefined);
    await server.ldap.delete(deptDn).catch(() => undefined);
  });

  describe('instances', () => {
    it('should create one per schema, each with its own name', () => {
      expect(flat.instances.map(i => i.name)).to.deep.equal([
        'ldapFlat:twakeUser',
        'ldapFlat:twakePosition',
      ]);
    });

    it('should resolve each base, whatever the placeholder syntax', () => {
      expect(flat.instances.map(i => i.base)).to.deep.equal([
        `ou=users,${base}`,
        `ou=positions,${base}`,
      ]);
    });

    it('should describe both to the configuration API', () => {
      const data = flat.getConfigApiData() as {
        flatResources: { name: string; endpoints: { list: string } }[];
      };
      expect(data.flatResources.map(r => r.name)).to.deep.equal([
        'twakeUser',
        'twakePosition',
      ]);
      expect(data.flatResources.map(r => r.endpoints.list)).to.deep.equal([
        '/api/v1/ldap/users',
        '/api/v1/ldap/positions',
      ]);
    });
  });

  describe('both APIs answer', () => {
    it('should list users', async () => {
      const res = await request.get('/api/v1/ldap/users');
      expect(res.status).to.equal(200);
    });

    it('should list positions', async () => {
      const res = await request.get('/api/v1/ldap/positions');
      expect(res.status).to.equal(200);
    });
  });

  describe('the rules follow the entry, not the first schema', () => {
    it('should create a position without asking for a user attribute', async () => {
      const res = await request
        .post('/api/v1/ldap/positions')
        .send({ cn: 'Multi Position' });
      expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
    });

    it('should create a user, applying the user rules', async () => {
      const res = await request.post('/api/v1/ldap/users').send({
        cn: 'Multi User',
        sn: 'User',
        mail: 'multi.user@example.com',
        twakeDepartmentLink: deptDn,
      });
      expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
    });

    it('should have filled the user path the server owns', async () => {
      const entry = await server.ldap.search(
        {
          paged: false,
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: ['twakeDepartmentPath', 'twakeAccountStatus'],
        },
        userDnOf('multi.user')
      );
      const found = (entry as { searchEntries: Record<string, unknown>[] })
        .searchEntries[0];
      expect(found.twakeDepartmentPath).to.equal('MultiOrg');
      expect(String(found.twakeAccountStatus)).to.contain('cn=active');
    });
  });

  describe('lifecycle endpoints', () => {
    it('should be registered for the entity whose schema declares states', async () => {
      const res = await request
        .post('/api/v1/ldap/users/multi.user/status')
        .send({ state: 'disabled' });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('should not be registered for an entity that declares none', async () => {
      const res = await request
        .post('/api/v1/ldap/positions/Multi Position/status')
        .send({ state: 'disabled' });
      expect(res.status).to.equal(404);
    });
  });

  describe('uniqueness declared across the whole base', () => {
    it('should refuse a second user holding the same mail', async () => {
      const res = await request.post('/api/v1/ldap/users').send({
        cn: 'Multi Clone',
        sn: 'Clone',
        mail: 'multi.user@example.com',
        twakeDepartmentLink: deptDn,
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(409);
    });

    it('should not let a position collide with anything', async () => {
      const res = await request
        .post('/api/v1/ldap/positions')
        .send({ cn: 'Multi Position 2' });
      expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
      await server.ldap
        .delete(positionDnOf('Multi Position 2'))
        .catch(() => undefined);
    });
  });

  describe('two schemas claiming the same entity', () => {
    it('should not silently give both instances the same identity', () => {
      const twin = new DM();
      twin.config.ldap_flat_schema = [
        './static/schemas/standard/devices.json',
        './static/schemas/twake/devices.json',
      ];
      const plugin = new LdapFlatGeneric(twin);
      const names = plugin.instances.map(i => i.name);
      expect(
        names,
        `both schemas claim the same instance name: ${names.join(', ')}`
      ).to.have.length(new Set(names).size);
    });

    it('should not let two entities claim the same URL', async () => {
      const twin = new DM();
      await twin.ready;
      twin.config.ldap_flat_schema = [
        './static/schemas/twake/users.json',
        './static/schemas/standard/users.json',
      ];
      const plugin = new LdapFlatGeneric(twin);
      await twin.registerPlugin('ldapFlatGeneric', plugin);

      const plurals = plugin.instances.map(i => i.pluralName);
      expect(
        plurals,
        `both entities answer on /api/v1/ldap/${plurals[0]}: ${plugin.instances
          .map(i => i.name)
          .join(', ')}`
      ).to.have.length(new Set(plurals).size);
    });
  });
});
