/**
 * The route parameters reach the handlers decoded once. Express decodes a
 * `:id`, a `:cn` or a `:dn` already; decoding it again read a name holding
 * `%` as malformed (500) and a name holding `%41` as one holding `A`, so a
 * route addressed one entry and acted on another (#552).
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapAccountLifecycle from '../../../src/plugins/ldap/accountLifecycle';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import LdapRaw from '../../../src/plugins/ldap/raw';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Route parameters decoded once', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let previousGroupSchema: string | undefined;
  const people = '/api/v1/ldap/falsyPeople';
  const groups = '/api/v1/ldap/groups';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    // This is about the path, not about the schema's patterns, and the
    // suite that follows expects the default back
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    process.env.DM_GROUP_SCHEMA = '';
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/falsyPeople.json',
    ];
    server.config.ldap_group_base = `ou=lists,ou=groups,${base}`;
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('core/ldap/groups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      `uid=100%,ou=users,${base}`,
      `uid=a%41,ou=users,${base}`,
      `cn=100%,ou=lists,ou=groups,${base}`,
    ])
      await server?.ldap.delete(dn).catch(() => undefined);
    if (previousGroupSchema === undefined) delete process.env.DM_GROUP_SCHEMA;
    else process.env.DM_GROUP_SCHEMA = previousGroupSchema;
    await server?.stop();
  });

  it('reads a name holding % as its escaping spells it', async () => {
    // `100%` is a valid name; `100%25` is how RFC 3986 addresses it
    const added = await request
      .post(people)
      .send({ uid: '100%', cn: 'Percent', sn: 'P' });
    expect(added.status, JSON.stringify(added.body)).to.equal(201);

    const read = await request.get(`${people}/100%25`);
    expect(read.status, JSON.stringify(read.body)).to.equal(200);
    expect(read.body.uid).to.equal('100%');

    const removed = await request.delete(`${people}/100%25`);
    expect(removed.status, JSON.stringify(removed.body)).to.equal(200);
    const gone = await request.get(`${people}/100%25`);
    expect(gone.status, JSON.stringify(gone.body)).to.equal(404);
  });

  it('reads %41 as the characters it escapes, not as A', async () => {
    // `a%2541` names `a%41`: decoded twice it named `aA`
    const added = await request
      .post(people)
      .send({ uid: 'a%41', cn: 'Percent', sn: 'P' });
    expect(added.status, JSON.stringify(added.body)).to.equal(201);

    const removed = await request.delete(`${people}/a%2541`);
    expect(removed.status, JSON.stringify(removed.body)).to.equal(200);
    const gone = await request.get(`${people}/a%2541`);
    expect(gone.status, JSON.stringify(gone.body)).to.equal(404);
  });

  it('reads a group name holding % as its escaping spells it', async () => {
    const added = await request.post(groups).send({ cn: '100%', member: [] });
    expect(added.status, JSON.stringify(added.body)).to.equal(200);

    const removed = await request.delete(`${groups}/100%25`);
    expect(removed.status, JSON.stringify(removed.body)).to.equal(200);
    const gone = await request.get(`${groups}/100%25`);
    expect(gone.status, JSON.stringify(gone.body)).to.equal(404);
  });
});

describe('Route parameters decoded once: an organization DN', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  const route = '/api/v1/ldap/organizations';
  let branch: string;
  const dn = (): string => `ou=100%,${branch}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async () => {
    branch = process.env.DM_LDAP_TOP_ORGANIZATION as string;
    server = new DM();
    await server.ready;
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
    await server.ldap.add(dn(), {
      objectClass: ['top', 'organizationalUnit'],
      ou: '100%',
    });
  });

  after(async () => {
    await server?.ldap.delete(dn()).catch(() => undefined);
    await server?.stop();
  });

  it('reads a DN holding % as its escaping spells it', async () => {
    const read = await request.get(`${route}/${encodeURIComponent(dn())}`);
    expect(read.status, JSON.stringify(read.body)).to.equal(200);
    expect(read.body.ou).to.equal('100%');
  });
});

describe('Route parameters decoded once: a raw entry DN', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let prefix: string;
  const dn = (): string => `ou=100%,${base}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    await server.registerPlugin('ldapRaw', new LdapRaw(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
    prefix = `${server.config.api_prefix}/v1/ldap/raw`;
    await server.ldap.add(dn(), {
      objectClass: ['top', 'organizationalUnit'],
      ou: '100%',
    });
  });

  after(async () => {
    await server?.ldap.delete(dn()).catch(() => undefined);
    await server?.stop();
  });

  it('reads an entry DN holding % as its escaping spells it', async () => {
    const read = await request.get(
      `${prefix}/entry/${encodeURIComponent(dn())}`
    );
    expect(read.status, JSON.stringify(read.body)).to.equal(200);
    expect(read.body.attributes.ou.values).to.deep.equal(['100%']);
  });
});

describe('Route parameters decoded once: an account lifecycle id', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let prefix: string;
  let previousFlatSchema: string | undefined;
  const id = 'life.100%';
  const userDn = (): string => `uid=${id},ou=users,${base}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    previousFlatSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    server = new DM();
    await server.ready;
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapAccountLifecycle',
      new LdapAccountLifecycle(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
    prefix = `${server.config.api_prefix}/v1/ldap`;
    await server.ldap.add(userDn(), {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: id,
      cn: 'Percent Lifecycle',
      sn: 'Lifecycle',
      mail: 'life.100@example.com',
      employeeNumber: 'ACC0100',
      twakeDepartmentPath: 'PercentLifecycle',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    });
  });

  after(async () => {
    await server?.ldap.delete(userDn()).catch(() => undefined);
    if (previousFlatSchema === undefined)
      delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousFlatSchema;
    await server?.stop();
  });

  it('changes the state of an id holding % as its escaping spells it', async () => {
    const changed = await request
      .post(`${prefix}/users/${encodeURIComponent(id)}/status`)
      .send({ state: 'disabled' });
    expect(changed.status, JSON.stringify(changed.body)).to.equal(200);
    const read = await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['twakeAccountStatus'] },
      userDn()
    );
    expect(
      (read as { searchEntries: Array<Record<string, unknown>> })
        .searchEntries[0].twakeAccountStatus
    ).to.equal(`cn=disabled,ou=twakeAccountStatus,ou=nomenclature,${base}`);
  });
});
