/**
 * A bulk import tells a caller what a single write would: nothing about the
 * directory outside their scope.
 *
 * Each row was checked as the server before its write was judged: an
 * existing entry was "skipped" without being judged, a dry run counted
 * every row "created", an organization was looked for whoever asked, and a
 * refusal came back with the branch it named.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapBulkImport from '../../../src/plugins/ldap/bulkImport';
import { AUTHZ_REFUSED } from '../../../src/lib/errors';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

/** Authentication reduced to a header, so the test is about authorization */
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

interface RowError {
  line: number;
  error: string;
  code?: string;
}

describe('Bulk import and the caller', function () {
  const OUTSIDER = 'bia.outsider';
  const BASE_WRITER = 'bia.basewriter';
  const HOLDER = 'bia-holder';
  let base: string;
  let ownOrg: string;
  let otherOrg: string;
  let transit: string;
  let holderDn: string;
  let plain: DM;
  let request: ReturnType<typeof supertest>;
  let dir: string;
  const previous: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    const top = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    ownOrg = `ou=BiaOwnOrg,${top}`;
    otherOrg = `ou=BiaOtherOrg,${top}`;
    transit = `ou=BiaTransit,${top}`;
    holderDn = `uid=${HOLDER},${base}`;

    dir = mkdtempSync(join(tmpdir(), 'bia-'));
    const schema = join(dir, 'schema.json');
    writeFileSync(
      schema,
      JSON.stringify({
        base,
        mainAttribute: 'uid',
        properties: {
          objectClass: {
            type: 'array',
            fixed: true,
            default: ['top', 'twakeAccount', 'twakeWhitePages'],
          },
          uid: { type: 'string', required: true },
          cn: { type: 'string', required: true },
          sn: { type: 'string', required: true },
          twakeDepartmentLink: { type: 'string', role: ['organizationLink'] },
          twakeDepartmentPath: { type: 'string', role: ['organizationPath'] },
        },
      })
    );
    for (const k of [
      'DM_AUTHZ_PER_BRANCH_CONFIG',
      'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
      'DM_BULK_IMPORT_SCHEMAS',
    ])
      previous[k] = process.env[k];
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [OUTSIDER]: { [ownOrg]: { read: true, write: true, delete: true } },
        // Writes the whole base, not the transit branch
        [BASE_WRITER]: {
          [transit]: { read: false, write: false, delete: false },
          [base]: { read: true, write: true, delete: true },
        },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';
    process.env.DM_BULK_IMPORT_SCHEMAS = `biausers:${schema}`;

    plain = new DM();
    await plain.ready;
    for (const [dn, ou] of [
      [ownOrg, 'BiaOwnOrg'],
      [otherOrg, 'BiaOtherOrg'],
      [transit, 'BiaTransit'],
    ])
      await plain.ldap
        .add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou,
          twakeDepartmentPath: ou,
        })
        .catch(() => undefined);
    await plain.ldap.delete(holderDn).catch(() => undefined);
    await plain.ldap.add(holderDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: HOLDER,
      cn: HOLDER,
      sn: 'Holder',
      twakeDepartmentLink: otherOrg,
      twakeDepartmentPath: 'BiaOtherOrg',
    });

    const server = new DM();
    await server.ready;
    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('bulkImport', new LdapBulkImport(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      holderDn,
      `uid=bia-new,${base}`,
      `uid=bia-multi,${base}`,
      `uid=bia-t1,${base}`,
      `uid=bia-mine,${base}`,
      ownOrg,
      otherOrg,
      transit,
    ])
      await plain.ldap.delete(dn).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  const importRows = (
    rows: string[],
    fields: Record<string, string> = {}
  ): Promise<supertest.Response> => {
    let call = request
      .post('/api/v1/ldap/bulk-import/biausers')
      .set('X-Test-User', OUTSIDER)
      .attach(
        'file',
        Buffer.from(['uid,cn,sn,organizationDn', ...rows].join('\n')),
        'rows.csv'
      );
    for (const [name, value] of Object.entries(fields))
      call = call.field(name, value);
    return call;
  };

  it('answers rows of another organization alike, whether the entry is there or not', async () => {
    const res = await importRows([
      `${HOLDER},Holder,Holder,"${otherOrg}"`,
      `bia-new,New,New,"${otherOrg}"`,
    ]);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.include({ skipped: 0, created: 0, failed: 2 });
    const errors = res.body.errors as RowError[];
    expect(errors.map(e => e.error)).to.deep.equal([
      AUTHZ_REFUSED,
      AUTHZ_REFUSED,
    ]);
    // Never the branch an authorization plugin judged
    expect(JSON.stringify(res.body)).to.not.match(/authz-forbidden|ou=/i);
  });

  it('refuses to update an entry of another organization from a row linked to the caller own', async () => {
    for (const fields of [
      { updateExisting: 'true', dryRun: 'true' },
      { updateExisting: 'true' },
    ] as Record<string, string>[]) {
      const res = await importRows(
        [`${HOLDER},Holder,Holder,"${ownOrg}"`],
        fields
      );
      expect(res.body, JSON.stringify(res.body)).to.include({
        updated: 0,
        failed: 1,
      });
      expect((res.body.errors as RowError[])[0].error).to.equal(AUTHZ_REFUSED);
      // Never the branch the entry is attached to
      expect(JSON.stringify(res.body)).to.not.match(/authz-forbidden|ou=/i);
    }
  });

  it('refuses in a dry run what the import refuses', async () => {
    const res = await importRows([`bia-new,New,New,"${otherOrg}"`], {
      dryRun: 'true',
    });
    expect(res.body).to.include({ created: 0, failed: 1 });
  });

  it('refuses a row before looking for its organization', async () => {
    const res = await importRows([
      `bia-new,New,New,"ou=BiaNowhere,${process.env.DM_LDAP_TOP_ORGANIZATION}"`,
    ]);
    expect((res.body.errors as RowError[])[0].error).to.equal(AUTHZ_REFUSED);
  });

  it('still imports the rows of the caller own organization', async () => {
    const res = await importRows([`bia-mine,Mine,Mine,"${ownOrg}"`], {
      dryRun: 'true',
    });
    expect(res.body, JSON.stringify(res.body)).to.include({
      created: 1,
      failed: 0,
    });
  });
  // Judged by attachment: an entry is the organization's it is linked to
  describe('judged by attachment', () => {
    let attached: ReturnType<typeof supertest>;
    const OWN = 'bia-own';
    let ownDn: string;

    const send = (
      header: string,
      rows: string[],
      fields: Record<string, string> = {},
      user = OUTSIDER
    ): Promise<supertest.Response> => {
      let call = attached
        .post('/api/v1/ldap/bulk-import/biausers')
        .set('X-Test-User', user)
        .attach('file', Buffer.from([header, ...rows].join('\n')), 'rows.csv');
      for (const [name, value] of Object.entries(fields))
        call = call.field(name, value);
      return call;
    };
    const linkOf = async (dn: string): Promise<unknown> =>
      (
        (await plain.ldap.search(
          { paged: false, scope: 'base', attributes: ['twakeDepartmentLink'] },
          dn
        )) as { searchEntries: Record<string, unknown>[] }
      ).searchEntries[0]?.twakeDepartmentLink;

    before(async function () {
      this.timeout(20000);
      ownDn = `uid=${OWN},${base}`;
      await plain.ldap.delete(ownDn).catch(() => undefined);
      await plain.ldap.add(ownDn, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        uid: OWN,
        cn: OWN,
        sn: 'Own',
        twakeDepartmentLink: ownOrg,
        twakeDepartmentPath: 'BiaOwnOrg',
      });
      const server = new DM();
      Object.assign(server.config, {
        authz_filter_attached_entries: true,
        authz_transit_branch: transit,
      });
      await server.ready;
      await server.registerPlugin('testAuth', new TestAuthPlugin(server));
      await server.registerPlugin('bulkImport', new LdapBulkImport(server));
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
      server.setupErrorMiddleware();
      attached = supertest(server.app);
    });

    after(async () => {
      await plain.ldap.delete(ownDn).catch(() => undefined);
    });

    it('lets an administrator update their own entries from rows naming no organization', async () => {
      for (const fields of [
        { updateExisting: 'true', dryRun: 'true' },
        { updateExisting: 'true' },
      ] as Record<string, string>[]) {
        const res = await send('uid,cn,sn', [`${OWN},Own,Renamed`], fields);
        expect(res.body, JSON.stringify(res.body)).to.include({
          updated: 1,
          failed: 0,
        });
      }
    });

    it('judges a link written in another case as a move', async () => {
      const res = await send(
        'uid,cn,sn,twakedepartmentlink',
        [`${OWN},Own,Own,"${otherOrg}"`],
        { updateExisting: 'true' }
      );
      expect(res.body, JSON.stringify(res.body)).to.include({
        updated: 0,
        failed: 1,
      });
      expect(await linkOf(ownDn)).to.equal(ownOrg);
    });

    it('refuses a link naming several organizations', async () => {
      const res = await send('uid,cn,sn,twakeDepartmentLink', [
        `bia-multi,M,M,"${ownOrg};${otherOrg}"`,
      ]);
      expect(res.body, JSON.stringify(res.body)).to.include({
        created: 0,
        failed: 1,
      });
    });

    it('counts in a dry run only what the import would write', async () => {
      // Let through as a move into transit, which it is not: there is no
      // entry to move
      for (const fields of [{ dryRun: 'true' }, {}] as Record<
        string,
        string
      >[]) {
        const res = await send(
          'uid,cn,sn,organizationDn',
          [`bia-t1,T,T,"${transit}"`],
          fields,
          BASE_WRITER
        );
        expect(res.body, JSON.stringify(res.body)).to.include({
          created: 0,
          failed: 1,
        });
      }
    });

    it('stops on a refused row with the refusal only', async () => {
      const res = await send(
        'uid,cn,sn,organizationDn',
        [`bia-new,New,New,"${otherOrg}"`],
        { continueOnError: 'false' }
      );
      expect(res.status).to.equal(403);
      expect(res.body.error).to.equal(AUTHZ_REFUSED);
    });
  });
});
