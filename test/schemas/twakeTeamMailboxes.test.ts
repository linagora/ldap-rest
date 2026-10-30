import { expect } from 'chai';
import * as fs from 'fs';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../src/plugins/ldap/enterpriseRules';
import LdapGroups from '../../src/plugins/ldap/groups';
import OnLdapChange from '../../src/plugins/ldap/onChange';
import James from '../../src/plugins/twake/james';
import type { SearchResult } from '../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';
import { waitFor } from '../helpers/waitFor';

describe('Twake team mailbox schema', () => {
  const timestamp = Date.now();
  let dm: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let branch: string;
  let alice: string;
  let org: string;
  const calls: string[] = [];
  const api = '/api/v1/ldap/teamMailboxes';
  const name = `support-${timestamp}`;
  const mailbox = `/domains/test.org/team-mailboxes/${name}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    branch = `ou=teammailboxes,${base}`;
    alice = `uid=tmalice-${timestamp},ou=users,${base}`;
    org = `ou=TM Org ${timestamp},ou=organization,${base}`;
    process.env.DM_LDAP_FLAT_SCHEMA =
      './static/schemas/twake/teamMailboxes.json';
    dm = new DM();
    dm.config.james_init_delay = 0;
    await dm.ready;
    await dm.ldap
      .add(branch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'teammailboxes',
      })
      .catch(() => undefined);
    await dm.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: `TM Org ${timestamp}`,
      twakeDepartmentPath: `TM Org ${timestamp}`,
    });
    await dm.ldap.add(alice, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: `tmalice-${timestamp}`,
      cn: 'Alice',
      sn: 'Alice',
      mail: `tmalice-${timestamp}@test.org`,
    });

    const scope = nock(
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
    ).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope.intercept(/.*/, method).reply((uri: string) => {
        calls.push(`${method} ${decodeURIComponent(uri)}`);
        return method === 'GET' ? [200, []] : [204];
      });

    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
    await dm.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(dm));
    await dm.registerPlugin('ldapEnterpriseRules', new LdapEnterpriseRules(dm));
    await dm.registerPlugin('james', new James(dm));
    dm.setupErrorMiddleware();
    request = supertest(dm.app);
  });

  after(async () => {
    nock.cleanAll();
    delete process.env.DM_LDAP_FLAT_SCHEMA;
    if (!dm) return;
    await dm.ldap.delete(`cn=${name},${branch}`).catch(() => undefined);
    await dm.ldap.delete(alice).catch(() => undefined);
    await dm.ldap.delete(org).catch(() => undefined);
    await dm.stop();
  });

  const body = (
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    cn: name,
    mail: `${name}@test.org`,
    member: [alice],
    twakeDepartmentLink: org,
    ...extra,
  });

  it('gives every text a client shows in each shipped language', () => {
    const schema = JSON.parse(
      fs.readFileSync('static/schemas/twake/teamMailboxes.json', 'utf-8')
    ) as Record<string, unknown>;
    const texts: Record<string, string>[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node))
        if (['label', 'singularLabel', 'hint', 'group'].includes(key))
          texts.push(value as Record<string, string>);
        else walk(value);
    };
    walk(schema);
    expect(texts).not.to.be.empty;
    for (const text of texts)
      for (const language of ['en', 'fr', 'mn'])
        expect(text[language], JSON.stringify(text)).to.be.a('string');
  });

  it('refuses an address TMail cannot name a team mailbox after', async () => {
    const res = await request
      .post(api)
      .send(body({ mail: `first.last-${timestamp}@test.org` }));
    expect(res.status).to.equal(400);
  });

  it('refuses a team mailbox without a member', async () => {
    const res = await request.post(api).send(body({ member: [] }));
    expect(res.status).to.equal(400);
  });

  it('creates the team mailbox in its branch, and in Twake Mail', async () => {
    const res = await request.post(api).send(body());
    expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);

    const stored = (await dm.ldap.search(
      { scope: 'base', attributes: ['twakeMailboxType'], paged: false },
      `cn=${name},${branch}`
    )) as SearchResult;
    expect(stored.searchEntries[0].twakeMailboxType).to.equal(
      `cn=teamMailbox,ou=twakeMailboxType,ou=nomenclature,${base}`
    );

    const expected = [
      `PUT ${mailbox}`,
      `PUT ${mailbox}/members/tmalice-${timestamp}@test.org`,
    ];
    await waitFor(() => expected.every(call => calls.includes(call)), {
      what: expected.join(', '),
    });
  });

  it('keeps its mailbox type', async () => {
    const res = await request.put(`${api}/${name}`).send({
      replace: {
        twakeMailboxType: `cn=mailingList,ou=twakeMailboxType,ou=nomenclature,${base}`,
      },
    });
    expect(res.status).to.equal(400);
  });
});
