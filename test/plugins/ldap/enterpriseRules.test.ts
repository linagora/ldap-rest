import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapEnterpriseRules, {
  mailInDomains,
  parseByteSize,
  parseDirectoryDate,
} from '../../../src/plugins/ldap/enterpriseRules';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Enterprise rules', () => {
  describe('parseByteSize', () => {
    it('should read decimal units, as mail servers count them', () => {
      expect(parseByteSize('5GB')).to.equal(5000000000);
      expect(parseByteSize('500MB')).to.equal(500000000);
      expect(parseByteSize('2KB')).to.equal(2000);
      expect(parseByteSize('2048')).to.equal(2048);
      expect(parseByteSize('1.5GB')).to.equal(1500000000);
      expect(parseByteSize(' 5 GB ')).to.equal(5000000000);
      expect(parseByteSize('5gb')).to.equal(5000000000);
    });

    it('should refuse anything that is not a size', () => {
      for (const value of ['', 'GB', '5PB', '-1', 'five']) {
        expect(() => parseByteSize(value), value).to.throw();
      }
    });
  });

  describe('parseDirectoryDate', () => {
    it('should read an LDAP generalized time', () => {
      const date = parseDirectoryDate('20240930220000Z');
      expect(date?.toISOString()).to.equal('2024-09-30T22:00:00.000Z');
      expect(parseDirectoryDate('20240930220000.500Z')?.toISOString()).to.equal(
        '2024-09-30T22:00:00.500Z'
      );
    });

    it('should read an ISO date', () => {
      expect(
        parseDirectoryDate('2024-09-30T22:00:00Z')?.toISOString()
      ).to.equal('2024-09-30T22:00:00.000Z');
    });

    it('should return null for anything unreadable', () => {
      expect(parseDirectoryDate('not a date')).to.be.null;
      expect(parseDirectoryDate('20241340220000Z')).to.be.null;
    });
  });

  describe('mailInDomains', () => {
    it('should accept everything when no domain is declared', () => {
      expect(mailInDomains('a@anywhere.example', [])).to.be.true;
    });

    it('should honour the wildcard', () => {
      expect(mailInDomains('a@anywhere.example', ['*'])).to.be.true;
    });

    it('should compare the host, not a suffix of the address', () => {
      expect(mailInDomains('a@example.org', ['example.org'])).to.be.true;
      expect(mailInDomains('a@EXAMPLE.ORG', ['example.org'])).to.be.true;
      // The trap the pattern-only rule fell into: a domain that merely ends
      // with an authorised one is a different domain.
      expect(mailInDomains('a@evil-example.org', ['example.org'])).to.be.false;
      expect(mailInDomains('a@lists.example.org', ['example.org'])).to.be.false;
    });

    it('should accept a subdomain only when asked to', () => {
      expect(mailInDomains('a@lists.example.org', ['example.org'], true)).to.be
        .true;
      expect(mailInDomains('a@notexample.org', ['example.org'], true)).to.be
        .false;
    });

    it('should refuse an address without a host', () => {
      expect(mailInDomains('nobody', ['example.org'])).to.be.false;
    });
  });

  describe('against a directory', function () {
    let server: DM;
    let request: ReturnType<typeof supertest>;
    let base: string;
    let orgDn: string;
    let subOrgDn: string;
    let otherOrgDn: string;
    let previousOrganizationSchema: string | undefined;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
    });

    before(async () => {
      base = process.env.DM_LDAP_BASE as string;
      orgDn = `ou=RulesOrg,ou=organization,${base}`;
      subOrgDn = `ou=RulesSubOrg,ou=RulesOrg,ou=organization,${base}`;
      otherOrgDn = `ou=RulesOtherOrg,ou=organization,${base}`;

      process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
      previousOrganizationSchema = process.env.DM_ORGANIZATION_SCHEMA;
      process.env.DM_ORGANIZATION_SCHEMA =
        './static/schemas/twake/organizations.json';
      server = new DM();
      await server.ready;

      // The organization that owns a mail domain, and a child that inherits it.
      for (const [dn, attrs] of [
        [
          orgDn,
          {
            objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
            ou: 'RulesOrg',
            twakeDepartmentPath: 'RulesOrg',
            twakeDomainLink: `dc=example,ou=domains,ou=nomenclature,${base}`,
          },
        ],
        [
          subOrgDn,
          {
            objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
            ou: 'RulesSubOrg',
            twakeDepartmentPath: 'RulesOrg / RulesSubOrg',
          },
        ],
        [
          otherOrgDn,
          {
            objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
            ou: 'RulesOtherOrg',
            twakeDepartmentPath: 'RulesOtherOrg',
          },
        ],
      ] as [string, Record<string, unknown>][]) {
        try {
          await server.ldap.add(dn, attrs as never);
        } catch (e) {
          // already there
        }
      }

      const flat = new LdapFlatGeneric(server);
      await server.registerPlugin('ldapFlatGeneric', flat);
      const organizations = new LdapOrganizations(server);
      await server.registerPlugin('ldapOrganizations', organizations);
      await server.registerPlugin(
        'ldapEnterpriseRules',
        new LdapEnterpriseRules(server)
      );
      server.setupErrorMiddleware();
      request = supertest(server.app);
      // The organization plugin reads its schema asynchronously.
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    after(async () => {
      for (const dn of [subOrgDn, orgDn, otherOrgDn])
        await server.ldap.delete(dn).catch(() => undefined);
      // The whole suite shares one process: leaving this set would hand the
      // organization schema to every server built afterwards.
      if (previousOrganizationSchema === undefined)
        delete process.env.DM_ORGANIZATION_SCHEMA;
      else process.env.DM_ORGANIZATION_SCHEMA = previousOrganizationSchema;
    });

    const remove = async (uid: string): Promise<void> => {
      await server.ldap
        .delete(`uid=${uid},ou=users,${base}`)
        .catch(() => undefined);
    };

    describe('computed values', () => {
      afterEach(async () => {
        await remove('rules.one');
        await remove('rules.two');
      });

      it('should derive the identifier and the organization path', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules One',
          sn: 'One',
          mail: 'rules.one@example.com',
          twakeDepartmentLink: subOrgDn,
        });
        expect(res.status).to.equal(201);
        expect(res.body).to.have.property('uid', 'rules.one');
        const stored = await request
          .get('/api/v1/ldap/users/rules.one')
          .set('Accept', 'application/json');
        expect(stored.body).to.have.property(
          'twakeDepartmentPath',
          'RulesOrg / RulesSubOrg'
        );
      });

      it('should apply the default account status', async () => {
        await request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules One',
            sn: 'One',
            mail: 'rules.one@example.com',
            twakeDepartmentLink: subOrgDn,
          })
          .expect(201);
        const res = await request
          .get('/api/v1/ldap/users/rules.one')
          .set('Accept', 'application/json');
        expect(res.body).to.have.property(
          'twakeAccountStatus',
          `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`
        );
      });

      it('should suffix a colliding generated identifier', async () => {
        await request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules One',
            sn: 'One',
            mail: 'rules.one@example.com',
            twakeDepartmentLink: subOrgDn,
          })
          .expect(201);
        // A second address with the same local part in another domain would
        // otherwise land on the same DN.
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules One Bis',
          sn: 'One',
          mail: 'rules.one@lists.example.com',
          twakeDepartmentLink: otherOrgDn,
        });
        expect(res.status).to.equal(201);
        expect(res.body).to.have.property('uid', 'rules.one-2');
        await remove('rules.one-2');
      });
    });

    describe('uniqueness', () => {
      afterEach(async () => {
        await remove('rules.uniq');
        await remove('rules.other');
      });

      const create = (mail: string, extra: Record<string, unknown> = {}) =>
        request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules Uniq',
            sn: 'Uniq',
            mail,
            twakeDepartmentLink: subOrgDn,
            ...extra,
          });

      it('should refuse a mail address already used as an alias', async () => {
        await create('rules.uniq@example.com', {
          mailAlternateAddress: ['rules.taken@example.com'],
        }).expect(201);
        const res = await create('rules.taken@example.com');
        expect(res.status).to.equal(409);
        expect(res.body.error).to.match(/already used/);
      });

      it('should not name the entry holding it', async () => {
        // The uniqueness search runs with the server's own visibility, so its
        // result must not be projected back: a manager scoped to one branch
        // would otherwise probe any address and be told which entry, in which
        // branch, holds it.
        await create('rules.uniq@example.com').expect(201);
        const res = await create('rules.uniq@example.com');
        expect(res.status).to.equal(409);
        expect(res.body.error).to.not.contain('uid=');
        expect(res.body.error).to.not.contain(base);
      });

      it('should refuse a duplicate employee number', async () => {
        await create('rules.uniq@example.com', {
          employeeNumber: 'E12345',
        }).expect(201);
        const res = await create('rules.other@example.com', {
          employeeNumber: 'E12345',
        });
        expect(res.status).to.equal(409);
      });

      it('should not conflict with the entry being updated', async () => {
        await create('rules.uniq@example.com', {
          employeeNumber: 'E999',
        }).expect(201);
        // Re-sending an unchanged value used to conflict with the entry's own
        // stored value: the search never excluded it.
        const res = await request
          .put('/api/v1/ldap/users/rules.uniq')
          .type('json')
          .send({ replace: { employeeNumber: 'E999', sn: 'Changed' } });
        expect(res.status).to.equal(200);
      });
    });

    describe('mail domains', () => {
      afterEach(async () => {
        await remove('rules.domain');
      });

      it('should accept an address in a domain the organization owns', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@example.com',
          twakeDepartmentLink: subOrgDn,
        });
        expect(res.status).to.equal(201);
      });

      it('should refuse an address outside those domains', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@elsewhere.example',
          twakeDepartmentLink: subOrgDn,
        });
        expect(res.status).to.equal(409);
        expect(res.body.error).to.match(/not one of the authorised domains/);
      });

      it('should accept any address when no ancestor declares a domain', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@elsewhere.example',
          twakeDepartmentLink: otherOrgDn,
        });
        expect(res.status).to.equal(201);
      });
    });

    describe('scheduled deletion', () => {
      afterEach(async () => {
        await remove('rules.date');
      });

      beforeEach(async () => {
        await request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules Date',
            sn: 'Date',
            mail: 'rules.date@example.com',
            twakeDepartmentLink: subOrgDn,
          })
          .expect(201);
      });

      it('should accept a date in the future', async () => {
        const res = await request
          .put('/api/v1/ldap/users/rules.date')
          .type('json')
          .send({ replace: { twakeDeletionDate: '20991231220000Z' } });
        expect(res.status).to.equal(200);
      });

      it('should refuse a date already past', async () => {
        const res = await request
          .put('/api/v1/ldap/users/rules.date')
          .type('json')
          .send({ replace: { twakeDeletionDate: '20200101220000Z' } });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.match(/not be earlier than today/);
      });
    });

    describe('organization paths', () => {
      const created: string[] = [];

      afterEach(async () => {
        for (const dn of created.reverse())
          await server.ldap.delete(dn).catch(() => undefined);
        created.length = 0;
      });

      it('should build the path of a new organization from its parent', async () => {
        const dn = `ou=RulesChild,${orgDn}`;
        created.push(dn);
        await server.ldap.add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou: 'RulesChild',
        });
        const result = await server.ldap.search(
          { paged: false, scope: 'base', attributes: ['twakeDepartmentPath'] },
          dn
        );
        expect(
          (result as { searchEntries: Record<string, unknown>[] })
            .searchEntries[0]
        ).to.have.property('twakeDepartmentPath', 'RulesOrg / RulesChild');
      });
    });

    describe('referential integrity', () => {
      it('should refuse to delete a position a user still holds', async () => {
        const positionDn = `cn=Systems Analyst,ou=positions,${base}`;
        await request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules Ref',
            sn: 'Ref',
            mail: 'rules.ref@example.com',
            twakeDepartmentLink: subOrgDn,
            title: positionDn,
          })
          .expect(201);
        try {
          await server.ldap.delete(positionDn);
          expect.fail('the position should not have been deletable');
        } catch (err) {
          expect((err as Error).message).to.match(/still referenced by/);
        } finally {
          await remove('rules.ref');
        }
      });
    });
  });
});
