import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import { Attribute, Change, Client } from 'ldapts';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import { BadRequestError } from '../../../src/lib/errors';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
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
import { waitFor } from '../../helpers/waitFor';

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
        expect(() => parseByteSize(value), value).to.throw(BadRequestError);
      }
    });

    it('should refuse a size it cannot write as a safe integer', () => {
      const tooLarge = [
        '53687 TB',
        '1000000000 TB',
        `${'9'.repeat(400)} MB`,
        '9'.repeat(323) + 'mB ',
        String(Number.MAX_SAFE_INTEGER + 1),
      ];
      for (const value of tooLarge) {
        expect(() => parseByteSize(value), String(value)).to.throw(
          BadRequestError
        );
      }
      expect(parseByteSize('5GB')).to.equal(5_000_000_000);
      expect(parseByteSize('9007199254740991')).to.equal(
        Number.MAX_SAFE_INTEGER
      );
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

    it('should read an offset of bare hours, as RFC 4517 allows', () => {
      expect(parseDirectoryDate('20240930000000+02')?.toISOString()).to.equal(
        '2024-09-29T22:00:00.000Z'
      );
      expect(parseDirectoryDate('20240930000000-05')?.toISOString()).to.equal(
        '2024-09-30T05:00:00.000Z'
      );
      expect(parseDirectoryDate('20240930000000+0530')?.toISOString()).to.equal(
        '2024-09-29T18:30:00.000Z'
      );
      expect(
        parseDirectoryDate('20240930000000+02:00')?.toISOString()
      ).to.equal('2024-09-29T22:00:00.000Z');
    });

    it('should read the forms without minutes or seconds', () => {
      expect(parseDirectoryDate('2024093012Z')?.toISOString()).to.equal(
        '2024-09-30T12:00:00.000Z'
      );
      expect(parseDirectoryDate('202409301230Z')?.toISOString()).to.equal(
        '2024-09-30T12:30:00.000Z'
      );
      // A fraction applies to the last unit given: half an hour here
      expect(parseDirectoryDate('2024093012.5Z')?.toISOString()).to.equal(
        '2024-09-30T12:30:00.000Z'
      );
    });

    it('should read the year as written, below 100 too', () => {
      expect(parseDirectoryDate('0029123123')?.toISOString()).to.equal(
        '0029-12-31T23:00:00.000Z'
      );
      expect(
        parseDirectoryDate('00950704115160.0996-11:51')?.toISOString()
      ).to.equal('0095-07-04T23:43:00.100Z');
      // Year 0 is a leap year: its February counts from year -1
      expect(parseDirectoryDate('0000022913')?.toISOString()).to.equal(
        '0000-02-29T13:00:00.000Z'
      );
      expect(parseDirectoryDate('0000010100Z')?.toISOString()).to.equal(
        '0000-01-01T00:00:00.000Z'
      );
    });

    it('should read a leap second at the end of a day', () => {
      expect(parseDirectoryDate('20991231235960Z')?.toISOString()).to.equal(
        '2100-01-01T00:00:00.000Z'
      );
      expect(
        parseDirectoryDate('20991231235960.5+0530')?.toISOString()
      ).to.equal('2099-12-31T18:30:00.500Z');
      expect(parseDirectoryDate('20240630235960Z')?.toISOString()).to.equal(
        '2024-07-01T00:00:00.000Z'
      );
    });

    it('should return null for anything unreadable', () => {
      expect(parseDirectoryDate('not a date')).to.be.null;
      expect(parseDirectoryDate('20241340220000Z')).to.be.null;
      expect(parseDirectoryDate('20240231000000Z')).to.be.null;
      expect(parseDirectoryDate('000002300000Z')).to.be.null;
      expect(parseDirectoryDate('20240930250000Z')).to.be.null;
      expect(parseDirectoryDate('20240930225961Z')).to.be.null;
      expect(parseDirectoryDate('20240930000000+25')).to.be.null;
    });

    it('should accept the offsets RFC 4517 allows', () => {
      // UTC as tools spell it: `strftime('%z')`, Java's `Z`, ISO 8601
      for (const zone of ['+0000', '-0000', '+00', '+00:00']) {
        expect(
          parseDirectoryDate(`20240930000000${zone}`)?.toISOString(),
          zone
        ).to.equal('2024-09-30T00:00:00.000Z');
      }
      // Zones in use today: the Line Islands all year, the Chatham Islands in
      // summer and in winter
      expect(
        parseDirectoryDate('20240930000000+14:00')?.toISOString()
      ).to.equal('2024-09-29T10:00:00.000Z');
      expect(parseDirectoryDate('20240930000000+1345')?.toISOString()).to.equal(
        '2024-09-29T10:15:00.000Z'
      );
      expect(parseDirectoryDate('20240930000000+1245')?.toISOString()).to.equal(
        '2024-09-29T11:15:00.000Z'
      );
      expect(parseDirectoryDate('20240930000000+12')?.toISOString()).to.equal(
        '2024-09-29T12:00:00.000Z'
      );
      expect(parseDirectoryDate('20240930000000-1300')?.toISOString()).to.equal(
        '2024-09-30T13:00:00.000Z'
      );
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
    let devicesDn: string;
    let ownedDn: string;
    let ownedSchema: string;
    let previousOrganizationSchema: string | undefined;
    // What this fixture had to create — the domain of the organization, the
    // branch of the devices — in creation order; only these are removed, so
    // a directory that already holds its nomenclature keeps it.
    const createdFixtures: string[] = [];

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
    });

    before(async () => {
      base = process.env.DM_LDAP_BASE as string;
      orgDn = `ou=RulesOrg,ou=organization,${base}`;
      subOrgDn = `ou=RulesSubOrg,ou=RulesOrg,ou=organization,${base}`;
      otherOrgDn = `ou=RulesOtherOrg,ou=organization,${base}`;
      devicesDn = `ou=devices,${base}`;
      ownedDn = `ou=rulesowned,${base}`;

      // The shipped group owners, in `seeAlso`: `refint` rewrites `owner` by
      // itself, and would remove it whether or not the role is honoured.
      const groups = JSON.parse(
        fs.readFileSync('./static/schemas/twake/groups.json', 'utf8')
      ) as { attributes: Record<string, { role?: string }> };
      expect(groups.attributes.owner.role).to.equal('owners');
      ownedSchema = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'ldap-rest-rules-')),
        'owned.json'
      );
      fs.writeFileSync(
        ownedSchema,
        JSON.stringify({
          entity: {
            name: 'rulesOwned',
            mainAttribute: 'cn',
            objectClass: ['top', 'device'],
            singularName: 'rulesowned',
            pluralName: 'rulesowneds',
            base: ownedDn,
          },
          attributes: {
            objectClass: { type: 'array', items: { type: 'string' } },
            cn: { type: 'string', required: true, role: 'identifier' },
            seeAlso: groups.attributes.owner,
          },
        })
      );

      process.env.DM_LDAP_FLAT_SCHEMA = [
        './static/schemas/twake/users.json',
        './static/schemas/twake/devices.json',
        ownedSchema,
      ].join(',');
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

      // The domain `orgDn` links to. Without it the link resolves to no name,
      // which lifts the restriction for the whole subtree — so the two cases
      // below read a rule that never runs, and the one expecting a refusal
      // gets the address created instead.
      for (const [dn, attrs] of [
        [
          `ou=nomenclature,${base}`,
          { objectClass: ['top', 'organizationalUnit'], ou: 'nomenclature' },
        ],
        [
          `ou=domains,ou=nomenclature,${base}`,
          { objectClass: ['top', 'organizationalUnit'], ou: 'domains' },
        ],
        [
          devicesDn,
          { objectClass: ['top', 'organizationalUnit'], ou: 'devices' },
        ],
        [
          ownedDn,
          { objectClass: ['top', 'organizationalUnit'], ou: 'rulesowned' },
        ],
        [
          `dc=example,ou=domains,ou=nomenclature,${base}`,
          {
            objectClass: ['top', 'domain', 'domainRelatedObject'],
            dc: 'example',
            associatedDomain: 'example.com',
          },
        ],
      ] as [string, Record<string, unknown>][]) {
        try {
          await server.ldap.add(dn, attrs as never);
          createdFixtures.push(dn);
        } catch (e) {
          // already there, and not ours to remove
        }
      }

      const flat = new LdapFlatGeneric(server);
      await server.registerPlugin('ldapFlatGeneric', flat);
      server.config.group_schema = './static/schemas/twake/groups.json';
      await server.registerPlugin('ldapGroups', new LdapGroups(server));
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
      for (const dn of [...createdFixtures].reverse())
        await server.ldap.delete(dn).catch(() => undefined);
      fs.rmSync(path.dirname(ownedSchema), { recursive: true, force: true });
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
          employeeNumber: 'ENT0001',
          givenName: 'Test',
          displayName: 'Test Person',
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
            employeeNumber: 'ENT0002',
            givenName: 'Test',
            displayName: 'Test Person',
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
            employeeNumber: 'ENT0003',
            givenName: 'Test',
            displayName: 'Test Person',
          })
          .expect(201);
        // A second address with the same local part in another domain would
        // otherwise land on the same DN.
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules One Bis',
          sn: 'One',
          mail: 'rules.one@lists.example.com',
          twakeDepartmentLink: otherOrgDn,
          employeeNumber: 'ENT0004',
          givenName: 'Test',
          displayName: 'Test Person',
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

      // A payroll number of its own per call: it is unique across the base, so
      // a case about a duplicate *address* must not be refused for a number
      // two payloads happened to share.
      let payroll = 0;
      const create = (mail: string, extra: Record<string, unknown> = {}) =>
        request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: 'Rules Uniq',
            sn: 'Uniq',
            givenName: 'Rules',
            displayName: 'Rules Uniq',
            employeeNumber: `ENU${++payroll}`,
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
        // For a client to say it in its own words, under the field
        expect(res.body).to.include({
          code: 'unique',
          attribute: 'mail',
          value: 'rules.taken@example.com',
        });
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

      // The shipped schema exempts `UNIT`, the placeholder the interface
      // these schemas replace gives an account standing for a unit rather
      // than a person. The reference directory holds 2118 of them, so a
      // uniqueness rule refusing the second would refuse accounts the
      // deployment already has.
      it('should let every account carry the UNIT placeholder', async () => {
        await create('rules.uniq@example.com', {
          employeeNumber: 'UNIT',
        }).expect(201);
        await create('rules.other@example.com', {
          employeeNumber: 'UNIT',
        }).expect(201);
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

      it('should not hold a copy of the entry against it (#402)', async () => {
        // What `appAccountsConsistency` keeps of an account: an entry of its
        // own, elsewhere, carrying the account's mail
        const copies = `ou=rulescopies,${base}`;
        const copy = `uid=rules.uniq@example.com,${copies}`;
        await server.ldap
          .add(copies, { objectClass: ['top', 'organizationalUnit'] } as never)
          .catch(() => undefined);
        try {
          await create('rules.uniq@example.com', {
            mailAlternateAddress: ['rules.alias@example.com'],
          }).expect(201);
          await server.ldap.add(copy, {
            objectClass: ['top', 'twakeAccount'],
            uid: 'rules.uniq@example.com',
            mail: 'RULES.UNIQ@example.com',
            mailAlternateAddress: 'rules.alias@example.com',
          } as never);
          // The whole entry saved again, its values unchanged, or moved
          // between the attributes the constraint spans
          for (const replace of [
            { mail: 'rules.uniq@example.com', sn: 'Changed' },
            {
              mail: 'rules.alias@example.com',
              mailAlternateAddress: ['rules.uniq@example.com'],
            },
          ]) {
            const res = await request
              .put('/api/v1/ldap/users/rules.uniq')
              .type('json')
              .send({ replace });
            expect(res.status, JSON.stringify(res.body)).to.equal(200);
          }
        } finally {
          await server.ldap.delete(copy).catch(() => undefined);
          await server.ldap.delete(copies).catch(() => undefined);
        }
      });

      it('should read the values held under an option of the attribute', async () => {
        const copies = `ou=rulescopies,${base}`;
        const copy = `uid=rules.uniq@example.com,${copies}`;
        const self = `uid=rules.uniq,ou=users,${base}`;
        await server.ldap
          .add(copies, { objectClass: ['top', 'organizationalUnit'] } as never)
          .catch(() => undefined);
        try {
          await create('rules.uniq@example.com').expect(201);
          // As another tool may store it, which this server refuses to: the
          // address under a tagged name
          const client = new Client({ url: process.env.DM_LDAP_URI as string });
          try {
            await client.bind(
              process.env.DM_LDAP_DN as string,
              process.env.DM_LDAP_PWD as string
            );
            await client.modify(self, [
              new Change({
                operation: 'delete',
                modification: new Attribute({
                  type: 'mail',
                  values: ['rules.uniq@example.com'],
                }),
              }),
              new Change({
                operation: 'add',
                modification: new Attribute({
                  type: 'mail;lang-en',
                  values: ['rules.uniq@example.com'],
                }),
              }),
            ]);
          } finally {
            await client.unbind();
          }
          await server.ldap.add(copy, {
            objectClass: ['top', 'twakeAccount'],
            uid: 'rules.uniq@example.com',
            mail: 'rules.uniq@example.com',
          } as never);
          const res = await request
            .put('/api/v1/ldap/users/rules.uniq')
            .type('json')
            .send({
              replace: { mail: 'rules.uniq@example.com', sn: 'Changed' },
            });
          expect(res.status, JSON.stringify(res.body)).to.equal(200);
        } finally {
          await server.ldap.delete(copy).catch(() => undefined);
          await server.ldap.delete(copies).catch(() => undefined);
        }
      });

      it('should check a value written under another spelling of the attribute', async () => {
        await create('rules.uniq@example.com').expect(201);
        await create('rules.other@example.com').expect(201);
        // Below the API, which a strict schema guards: what another plugin
        // or a non-strict schema lets through
        // An option is refused before any rule
        for (const [name, refusal] of [
          ['MAIL', /already used/],
          ['rfc822Mailbox', /already used/],
          ['mail;lang-en', /option "lang-en"/],
        ] as [string, RegExp][])
          await server.ldap
            .modify(`uid=rules.other,ou=users,${base}`, {
              replace: { [name]: 'rules.uniq@example.com' },
            } as never)
            .then(
              () => expect.fail(`${name} was written`),
              (err: Error) => expect(err.message).to.match(refusal)
            );
      });

      it('should still refuse a value the entry does not hold', async () => {
        await create('rules.uniq@example.com').expect(201);
        await create('rules.other@example.com').expect(201);
        const res = await request
          .put('/api/v1/ldap/users/rules.other')
          .type('json')
          .send({ replace: { mail: 'rules.uniq@example.com' } });
        expect(res.status).to.equal(409);
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
          employeeNumber: 'ENT0005',
          givenName: 'Test',
          displayName: 'Test Person',
        });
        expect(res.status).to.equal(201);
      });

      it('should refuse an address outside those domains', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@elsewhere.example',
          twakeDepartmentLink: subOrgDn,
          employeeNumber: 'ENT0006',
          givenName: 'Test',
          displayName: 'Test Person',
        });
        expect(res.status).to.equal(409);
        expect(res.body.error).to.match(/not one of the authorised domains/);
        expect(res.body).to.deep.include({
          code: 'mailDomain',
          attribute: 'mail',
          value: 'rules.domain@elsewhere.example',
          domains: ['example.com'],
        });
      });

      it('should check a move whatever the spelling of the link', async () => {
        // No domain where it stands, so any address
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@elsewhere.example',
          twakeDepartmentLink: otherOrgDn,
          employeeNumber: 'ENT0051',
          givenName: 'Test',
          displayName: 'Test Person',
        });
        expect(res.status, JSON.stringify(res.body)).to.equal(201);
        const self = `uid=rules.domain,ou=users,${base}`;
        // Into an organization that allows example.com only: the stored
        // address, or one sent along, is checked against it
        for (const [replace, refusal] of [
          [{ TWAKEDEPARTMENTLINK: subOrgDn }, /not one of the authorised/],
          [
            { '1.3.6.1.4.1.10943.1.50.1.1': subOrgDn },
            /not one of the authorised/,
          ],
          [{ 'twakeDepartmentLink;x-tag': subOrgDn }, /option "x-tag"/],
          [
            {
              TwakeDepartmentLink: subOrgDn,
              mail: 'rules.other@elsewhere.example',
            },
            /not one of the authorised/,
          ],
        ] as [Record<string, string>, RegExp][])
          await server.ldap.modify(self, { replace } as never).then(
            () => expect.fail(`${JSON.stringify(replace)} was written`),
            (err: Error) => expect(err.message).to.match(refusal)
          );
      });

      it('should rewrite what is sent in another case of a name', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@example.com',
          twakeDepartmentLink: subOrgDn,
          employeeNumber: 'ENT0052',
          givenName: 'Test',
          displayName: 'Test Person',
        });
        expect(res.status, JSON.stringify(res.body)).to.equal(201);
        const self = `uid=rules.domain,ou=users,${base}`;
        await server.ldap.modify(self, {
          replace: { TWAKEDEPARTMENTLINK: orgDn, MAILQUOTASIZE: '5GB' },
        } as never);
        const stored = (
          (await server.ldap.search(
            {
              paged: false,
              scope: 'base',
              attributes: ['twakeDepartmentPath', 'mailQuotaSize'],
            },
            self
          )) as { searchEntries: Record<string, unknown>[] }
        ).searchEntries[0];
        // The path follows the move, the size is counted in bytes
        expect(stored.twakeDepartmentPath).to.equal('RulesOrg');
        expect(stored.mailQuotaSize).to.equal('5000000000');
      });

      it('should refuse a size it cannot write as a safe integer', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@example.com',
          twakeDepartmentLink: subOrgDn,
          employeeNumber: 'ENT0053',
          givenName: 'Test',
          displayName: 'Test Person',
        });
        expect(res.status, JSON.stringify(res.body)).to.equal(201);
        for (const size of [
          '53687 TB',
          '1000000000 TB',
          `${'9'.repeat(400)} MB`,
        ])
          await request
            .put(`/api/v1/ldap/users/rules.domain`)
            .type('json')
            .send({ replace: { mailQuotaSize: size } })
            .then(r => {
              expect(r.status, size).to.equal(400);
              expect(r.body.error).to.match(
                /Invalid value for attribute "mailQuotaSize"/
              );
            });
      });

      it('should list a domain linked at several levels once', async () => {
        // #350: the sub-organization links the domain its parent links too
        const link = `dc=example,ou=domains,ou=nomenclature,${base}`;
        await server.ldap.modify(subOrgDn, { add: { twakeDomainLink: link } });
        try {
          const res = await request
            .post('/api/v1/ldap/users')
            .type('json')
            .send({
              cn: 'Rules Domain',
              sn: 'Domain',
              mail: 'rules.domain@elsewhere.example',
              twakeDepartmentLink: subOrgDn,
              employeeNumber: 'ENT0050',
              givenName: 'Test',
              displayName: 'Test Person',
            });
          expect(res.status).to.equal(409);
          expect(res.body.error).to.match(/domains \(example\.com\)$/);
          expect(res.body.domains).to.deep.equal(['example.com']);
        } finally {
          await server.ldap.modify(subOrgDn, {
            delete: { twakeDomainLink: link },
          });
        }
      });

      it('should accept any address when no ancestor declares a domain', async () => {
        const res = await request.post('/api/v1/ldap/users').type('json').send({
          cn: 'Rules Domain',
          sn: 'Domain',
          mail: 'rules.domain@elsewhere.example',
          twakeDepartmentLink: otherOrgDn,
          employeeNumber: 'ENT0007',
          givenName: 'Test',
          displayName: 'Test Person',
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
            employeeNumber: 'ENT0008',
            givenName: 'Test',
            displayName: 'Test Person',
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

      it('should accept a leap second at the end of a future day', async () => {
        const res = await request
          .put('/api/v1/ldap/users/rules.date')
          .type('json')
          .send({ replace: { twakeDeletionDate: '20991231235960Z' } });
        expect(res.status, JSON.stringify(res.body)).to.equal(200);
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
            employeeNumber: 'ENT0009',
            givenName: 'Test',
            displayName: 'Test Person',
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

      it('should find no reference in a branch the directory does not hold', async () => {
        const rules = server.loadedPlugins[
          'ldapEnterpriseRules'
        ] as unknown as {
          searchReferrers(
            candidate: { name: string; binding: { base: string } },
            dn: string
          ): Promise<unknown[]>;
        };
        expect(
          await rules.searchReferrers(
            { name: 'title', binding: { base: `ou=nowhere,${base}` } },
            `cn=x,${base}`
          )
        ).to.deep.equal([]);
      });

      it('should refuse to delete a mail domain an organization still links', async () => {
        // `orgDn` links it: deleted, the link would name nothing, and no
        // account could be created at that domain any more (#394)
        const domainDn = `dc=example,ou=domains,ou=nomenclature,${base}`;
        let error: unknown;
        await server.ldap
          .delete(domainDn)
          .catch((err: unknown) => (error = err));
        expect(String(error)).to.match(/still referenced by.*twakeDomainLink/);
        const found = (await server.ldap.search(
          { paged: false, scope: 'base', attributes: ['1.1'] },
          domainDn
        )) as { searchEntries: unknown[] };
        expect(found.searchEntries).to.have.length(1);
      });

      const leaver = (): string => `uid=rules.leaver,ou=users,${base}`;
      const keeper = (): string => `uid=rules.keeper,ou=users,${base}`;
      const create = (uid: string, employeeNumber: string) =>
        request
          .post('/api/v1/ldap/users')
          .type('json')
          .send({
            cn: `Rules ${uid}`,
            sn: uid,
            mail: `${uid}@example.com`,
            twakeDepartmentLink: subOrgDn,
            employeeNumber,
            givenName: 'Test',
            displayName: 'Test Person',
          })
          .expect(201);
      const read = async (dn: string, name: string): Promise<string[]> => {
        server.ldap.invalidateCache(dn);
        const result = (await server.ldap.search(
          { paged: false, scope: 'base', attributes: [name] },
          dn
        )) as { searchEntries: Record<string, unknown>[] };
        const value = result.searchEntries[0]?.[name];
        if (value === undefined) return [];
        return (Array.isArray(value) ? value : [value]).map(String);
      };

      it('should take a deleted account out of the links naming it', async () => {
        await create('rules.leaver', 'ENT0010');
        await create('rules.keeper', 'ENT0011');
        const deviceDn = `cn=rules-device,${devicesDn}`;
        const ownedEntry = `cn=rules-owned,${ownedDn}`;
        try {
          await server.ldap.modify(subOrgDn, {
            add: {
              twakeLocalAdminLink: leaver(),
              twakeManagerLink: [leaver(), keeper()],
            },
          });
          await server.ldap.modify(keeper(), {
            add: { twakeDelegatedUsers: leaver() },
          });
          await server.ldap.add(deviceDn, {
            objectClass: ['top', 'device'],
            cn: 'rules-device',
            owner: leaver(),
          });
          await server.ldap.add(ownedEntry, {
            objectClass: ['top', 'device'],
            cn: 'rules-owned',
            seeAlso: [leaver(), keeper()],
          });

          await server.ldap.delete(leaver());

          await waitFor(
            async () =>
              !(await read(keeper(), 'twakeDelegatedUsers')).length &&
              !(await read(subOrgDn, 'twakeLocalAdminLink')).length &&
              (await read(subOrgDn, 'twakeManagerLink')).length === 1 &&
              !(await read(deviceDn, 'owner')).length &&
              (await read(ownedEntry, 'seeAlso')).length === 1,
            { what: 'the links to the deleted account to be removed' }
          );
          expect(await read(subOrgDn, 'twakeManagerLink')).to.deep.equal([
            keeper(),
          ]);
          expect(await read(ownedEntry, 'seeAlso')).to.deep.equal([keeper()]);
        } finally {
          await server.ldap
            .modify(subOrgDn, {
              replace: { twakeLocalAdminLink: [], twakeManagerLink: [] },
            })
            .catch(() => undefined);
          await server.ldap.delete(deviceDn).catch(() => undefined);
          await server.ldap.delete(ownedEntry).catch(() => undefined);
          await remove('rules.leaver');
          await remove('rules.keeper');
        }
      });

      it('should take an account moved to the trash out of them too', async () => {
        const trashDn = `ou=rulestrash,${base}`;
        const trashed = `uid=rules.leaver,${trashDn}`;
        const groupDn = `cn=rules-trash-group,${server.config.ldap_group_base}`;
        const previousTrash = server.config.trash_base;
        server.config.trash_base = trashDn;
        await create('rules.leaver', 'ENT0012');
        await create('rules.keeper', 'ENT0013');
        try {
          await server.ldap.add(trashDn, {
            objectClass: ['top', 'organizationalUnit'],
            ou: 'rulestrash',
          });
          await server.ldap.modify(subOrgDn, {
            add: { twakeLocalAdminLink: leaver() },
          });
          await server.ldap.add(groupDn, {
            objectClass: ['top', 'groupOfNames'],
            cn: 'rules-trash-group',
            member: [leaver(), keeper()],
          });

          await server.ldap.move(leaver(), trashed);

          // `refint` may move the membership to the trashed DN rather than
          // let the groups plugin remove it: either frees the old DN.
          await waitFor(
            async () =>
              !(await read(subOrgDn, 'twakeLocalAdminLink')).length &&
              !(await read(groupDn, 'member')).includes(leaver()),
            { what: 'the links to the trashed account to be removed' }
          );
        } finally {
          server.config.trash_base = previousTrash;
          await server.ldap
            .modify(subOrgDn, { replace: { twakeLocalAdminLink: [] } })
            .catch(() => undefined);
          await server.ldap.delete(groupDn).catch(() => undefined);
          await server.ldap.delete(trashed).catch(() => undefined);
          await server.ldap.delete(trashDn).catch(() => undefined);
          await remove('rules.leaver');
          await remove('rules.keeper');
        }
      });
    });
  });
});
