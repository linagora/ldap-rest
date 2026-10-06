import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import Scim from '../../../src/plugins/scim/scim';
import TwakeGroups from '../../../src/plugins/twake/groups';

const ORGS = `ou=tga-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = (org: string): string => `ou=${org},${ORGS}`;
const users = (org: string): string => `ou=users,${orgDn(org)}`;

describe('Twake groups plugin routes', function () {
  let dm: DM;
  let groups: TwakeGroups;
  let api: supertest.Agent;
  const route = (org = 'acme'): string => `/api/v1/organizations/${org}/groups`;

  const ou = (dn: string, extra = {}): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
        ...extra,
      })
      .catch(() => undefined);

  const create = async (name: string, extra = {}): Promise<string> => {
    const res = await api
      .post(route())
      .send({ name, ...extra })
      .expect(201);
    return res.body.id as string;
  };

  before(async () => {
    const mapping = join(
      tmpdir(),
      `tga-scim-group-mapping-${process.pid}.json`
    );
    writeFileSync(
      mapping,
      JSON.stringify({ entries: [{ scim: 'displayName', ldap: 'o' }] })
    );
    dm = new DM();
    Object.assign(dm.config, {
      scim_user_base: users('acme'),
      scim_group_base: `ou=groups,${orgDn('acme')}`,
      scim_group_mapping: mapping,
      twake_group_base: `ou=groups,ou={org},${ORGS}`,
      twake_group_user_base: `ou=users,ou={org},${ORGS}`,
      twake_group_organization_dn: `ou={org},${ORGS}`,
      // Spelled unlike the schema, which the directory answers with: every
      // route then reads them whatever their configured case.
      twake_group_organization_status_attribute: 'DESCRIPTION',
      // groupOfNames attributes, so the test needs no extra schema
      twake_group_display_name_attribute: 'O',
      twake_group_color_attribute: 'BUSINESSCATEGORY',
      twake_group_created_at_attribute: 'OU',
      twake_lifecycle_deleted_attribute: 'employeeType',
      twake_lifecycle_deleted_value: 'deleted',
      group_class: ['top', 'groupOfNames'],
      group_schema: 'static/schemas/twake/organizationGroups.json',
    });
    await dm.ready;
    groups = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', groups);
    await dm.registerPlugin('core/scim', new Scim(dm));
    for (let tries = 0; !groups.schema; tries++) {
      if (tries === 200) throw new Error('the group schema did not load');
      await new Promise(r => setTimeout(r, 10));
    }
    api = supertest(dm.app);
    await ou(ORGS);
    await ou(orgDn('acme'));
    await ou(orgDn('gone'), { description: 'deleted' });
    await ou(users('acme'));
    await ou(`ou=groups,${orgDn('acme')}`);
    for (const uid of ['tga-alice', 'tga-bob'])
      await dm.ldap
        .add(`uid=${uid},${users('acme')}`, {
          objectClass: [
            'top',
            'inetOrgPerson',
            'organizationalPerson',
            'person',
          ],
          cn: uid,
          sn: 'Doe',
          givenName: uid,
          uid,
          mail: `${uid}@acme.example.org`,
        })
        .catch(() => undefined);
  });

  afterEach(async () => {
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'one', attributes: ['dn'] },
      `ou=groups,${orgDn('acme')}`
    )) as { searchEntries: { dn: string }[] };
    for (const { dn } of searchEntries) await dm.ldap.delete(dn);
  });

  after(async () => {
    for (const uid of ['tga-alice', 'tga-bob'])
      await dm.ldap
        .delete(`uid=${uid},${users('acme')}`)
        .catch(() => undefined);
    for (const dn of [
      users('acme'),
      `ou=groups,${orgDn('acme')}`,
      orgDn('acme'),
      orgDn('gone'),
      ORGS,
    ])
      await dm.ldap.delete(dn).catch(() => undefined);
  });

  it('answers 404 for an unknown organization and 410 for a deleted one', async () => {
    const missing = await api.get(route('nowhere')).expect(404);
    expect(missing.body).to.deep.equal({
      error: 'Organization not found',
      code: 'ORGANIZATION_NOT_FOUND',
    });
    const gone = await api.post(route('gone')).send({ name: 'x' }).expect(410);
    expect(gone.body.code).to.equal('ORGANIZATION_DELETED');
  });

  it('creates a group with a generated id and answers it', async () => {
    const res = await api
      .post(route())
      .send({ name: 'Eng & Ops', description: 'Team', color: '#3366FF' })
      .expect(201);
    expect(res.body.id).to.match(/^[0-9a-f-]{36}$/);
    expect(res.body).to.deep.include({
      cn: res.body.id,
      displayName: 'Eng & Ops',
      description: 'Team',
      color: '#3366FF',
      organizationId: 'acme',
      members: [],
    });
    expect(res.body.baseDN).to.equal(
      `cn=${res.body.id},ou=groups,${orgDn('acme')}`
    );
    expect(res.body.createdAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses an invalid body and a name already taken', async () => {
    await create('Eng');
    for (const body of [
      {},
      { name: ' ' },
      { name: 'x', color: 'blue' },
      { name: 'x', description: 1 },
    ]) {
      const res = await api.post(route()).send(body).expect(400);
      expect(res.body.code).to.equal('INVALID_INPUT');
    }
    const taken = await api.post(route()).send({ name: 'Eng' }).expect(409);
    expect(taken.body).to.deep.equal({
      error: 'Group already exists',
      code: 'GROUP_EXISTS',
    });
  });

  it('lists, searches, sorts and pages', async () => {
    await create('Beta', { description: 'second' });
    await create('Alpha', { description: 'first' });
    const res = await api
      .get(`${route()}?sortBy=displayName&limit=1&page=2`)
      .expect(200);
    expect(res.body.organizationId).to.equal('acme');
    expect(
      res.body.groups.map((g: { displayName: string }) => g.displayName)
    ).to.deep.equal(['Beta']);
    expect(res.body.pagination).to.deep.equal({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    const found = await api.get(`${route()}?search=firs`).expect(200);
    expect(found.body.groups).to.have.length(1);
    const empty = await api.get(`${route()}?search=`).expect(200);
    expect(empty.body.groups).to.have.length(2);
    expect(
      (await api.get(`${route()}?search=f`).expect(400)).body.code
    ).to.equal('INVALID_SEARCH_QUERY');
    expect(
      (await api.get(`${route()}?sortBy=cn`).expect(400)).body.code
    ).to.equal('INVALID_SORT_FIELD');
  });

  it('searches the cn of a group without a display name only', async () => {
    const id = await create('Alpha');
    await dm.ldap.add(`cn=Legacy Team,ou=groups,${orgDn('acme')}`, {
      objectClass: ['top', 'groupOfNames'],
      cn: 'Legacy Team',
      member: `uid=tga-alice,${users('acme')}`,
    });
    const found = await api.get(`${route()}?search=legacy`).expect(200);
    expect(
      found.body.groups.map((g: { displayName: string }) => g.displayName)
    ).to.deep.equal(['Legacy Team']);
    const byId = await api
      .get(`${route()}?search=${id.slice(0, 8)}`)
      .expect(200);
    expect(byId.body.groups).to.deep.equal([]);
  });

  it('gets a group, and answers 404 for an unknown one', async () => {
    const id = await create('Eng');
    expect(
      (await api.get(`${route()}/${id}`).expect(200)).body.displayName
    ).to.equal('Eng');
    const res = await api.get(`${route()}/nope`).expect(404);
    expect(res.body).to.deep.equal({
      error: 'Group not found',
      code: 'GROUP_NOT_FOUND',
    });
  });

  it('updates the name, and clears the color', async () => {
    const id = await create('Eng', { color: '#fff' });
    await create('Ops');
    await api
      .patch(`${route()}/${id}`)
      .send({ name: 'Platform', color: '' })
      .expect(200);
    const group = (await api.get(`${route()}/${id}`)).body;
    expect(group.displayName).to.equal('Platform');
    expect(group).to.not.have.property('color');
    expect(
      (await api.patch(`${route()}/${id}`).send({ name: 'Ops' }).expect(409))
        .body.code
    ).to.equal('GROUP_EXISTS');
    expect(
      (await api.patch(`${route()}/${id}`).send({ cn: 'x' }).expect(400)).body
        .code
    ).to.equal('INVALID_INPUT');
    expect(
      (await api.patch(`${route()}/${id}`).send({}).expect(400)).body.code
    ).to.equal('INVALID_INPUT');
    expect(
      (await api.patch(`${route()}/${id}`).expect(400)).body.code
    ).to.equal('INVALID_INPUT');
    await api.patch(`${route()}/nope`).send({ description: 'x' }).expect(404);
  });

  it('adds members, lists their profiles, and removes them down to the placeholder', async () => {
    const id = await create('Eng');
    await api
      .post(`${route()}/${id}/members`)
      .send({ usernames: ['TGA-alice', 'tga-bob', 'tga-alice'] })
      .expect(200);
    expect((await api.get(`${route()}/${id}`)).body.members).to.have.members([
      'tga-alice',
      'tga-bob',
    ]);
    const listed = await api
      .get(`${route()}/${id}/members?sortBy=uid&sortOrder=desc`)
      .expect(200);
    expect(listed.body.id).to.equal(id);
    expect(listed.body.members[0]).to.deep.include({
      uid: 'tga-bob',
      mail: 'tga-bob@acme.example.org',
      name: { familyName: 'Doe', givenName: 'tga-bob' },
      isTechnical: false,
    });
    expect(listed.body.pagination).to.include({ total: 2, hasNextPage: false });

    await api.delete(`${route()}/${id}/members/tga-alice`).expect(200);
    await api.delete(`${route()}/${id}/members/tga-bob`).expect(200);
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([]);
    const res = await api
      .delete(`${route()}/${id}/members/tga-bob`)
      .expect(404);
    expect(res.body.code).to.equal('MEMBER_NOT_FOUND');
  });

  it('refuses unknown users and invalid member lists', async () => {
    const id = await create('Eng');
    const unknown = await api
      .post(`${route()}/${id}/members`)
      .send({ usernames: ['tga-alice', 'nobody'] })
      .expect(404);
    expect(unknown.body.code).to.equal('USER_NOT_FOUND');
    const tombstone = `uid=tga-gone,${users('acme')}`;
    await dm.ldap.add(tombstone, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'tga-gone',
      sn: 'Gone',
      uid: 'tga-gone',
      employeeType: 'deleted',
    });
    try {
      const gone = await api
        .post(`${route()}/${id}/members`)
        .send({ usernames: ['tga-gone'] })
        .expect(404);
      expect(gone.body.code).to.equal('USER_NOT_FOUND');
    } finally {
      await dm.ldap.delete(tombstone);
    }
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([]);
    for (const usernames of [[], [''], 'tga-alice'])
      await api
        .post(`${route()}/${id}/members`)
        .send({ usernames })
        .expect(400);
    await api
      .post(`${route()}/nope/members`)
      .send({ usernames: ['tga-alice'] })
      .expect(404);
  });

  it('deletes a group', async () => {
    const id = await create('Eng');
    await api.delete(`${route()}/${id}`).expect(200);
    await api.delete(`${route()}/${id}`).expect(404);
  });

  it('validates groups against the organization group schema', async () => {
    for (const [field, value] of [
      ['twakeDepartmentLink', ORGS],
      ['cn', 'not-a-uuid'],
      ['BUSINESSCATEGORY', 'blue'],
    ]) {
      const refused = await groups._validateOneChange(field, value).then(
        () => false,
        () => true
      );
      expect(refused, field).to.equal(true);
    }
    expect(await groups._validateOneChange('O', 'Team')).to.equal(true);
    expect(
      await groups._validateOneChange('BUSINESSCATEGORY', '#abc')
    ).to.equal(true);
  });

  it('declares its attributes under their configured names, whatever the schema case', () => {
    const { attributes } = groups['adaptSchema']({
      strict: true,
      attributes: { o: { type: 'string', required: false } },
    });
    expect(attributes).not.to.have.property('o');
    expect(attributes.O).to.deep.equal({ type: 'string', required: false });
    expect(attributes).to.have.keys('O', 'BUSINESSCATEGORY', 'OU');
  });

  it('gives a SCIM group a generated cn and keeps its name in the display name attribute', async () => {
    const scim = (req: supertest.Test): supertest.Test =>
      req.set('Content-Type', 'application/scim+json');
    const created = await scim(api.post('/scim/v2/Groups'))
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        id: 'chosen-by-client',
        displayName: 'Eng & Ops',
        members: [{ value: 'tga-alice' }],
      })
      .expect(201);
    const { id } = created.body as { id: string };
    expect(id).to.match(/^[0-9a-f-]{36}$/);
    expect(created.body.displayName).to.equal('Eng & Ops');

    const group = (await api.get(`${route()}/${id}`).expect(200)).body;
    expect(group).to.deep.include({
      cn: id,
      displayName: 'Eng & Ops',
      members: ['tga-alice'],
    });
    expect(group.createdAt).to.be.a('string').and.not.be.empty;

    const found = await api
      .get(
        `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "Eng & Ops"')}`
      )
      .expect(200);
    expect(found.body.Resources.map((g: { id: string }) => g.id)).to.deep.equal(
      [id]
    );

    await scim(api.patch(`/scim/v2/Groups/${id}`))
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'displayName', value: 'Platform' }],
      })
      .expect(200);
    expect(
      (await api.get(`/scim/v2/Groups/${id}`).expect(200)).body.displayName
    ).to.equal('Platform');
  });

  it('still names a SCIM group after a hook that drops the base', async () => {
    const legacy = ([group, req]: unknown[]) => [group, req];
    const hooks = dm.hooks.scimgroupcreate as unknown[];
    hooks.unshift(legacy);
    try {
      const created = await api
        .post('/scim/v2/Groups')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'Legacy',
        })
        .expect(201);
      expect(created.body.id).to.match(/^[0-9a-f-]{36}$/);
    } finally {
      hooks.splice(hooks.indexOf(legacy), 1);
    }
  });

  it('warns when the SCIM group mapping writes the RDN attribute', () => {
    const mapping = dm.config.scim_group_mapping;
    const realWarn = groups.logger.warn;
    const warned: string[] = [];
    groups.logger.warn = ((m: string) => {
      warned.push(m);
    }) as unknown as typeof groups.logger.warn;
    try {
      groups.afterLoad();
      expect(warned).to.deep.equal([]);
      dm.config.scim_group_mapping = '';
      groups.afterLoad();
      expect(warned).to.have.length(1);
      expect(warned[0]).to.match(/writes displayName to cn/);
    } finally {
      groups.logger.warn = realWarn;
      dm.config.scim_group_mapping = mapping;
    }
  });

  it('does not serve the flat group routes', async () => {
    await api.get('/api/v1/ldap/groups').expect(404);
  });
});
