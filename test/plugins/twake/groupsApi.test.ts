import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import TwakeGroups from '../../../src/plugins/twake/groups';

const ORGS = `ou=tga-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = (org: string): string => `ou=${org},${ORGS}`;
const users = (org: string): string => `ou=users,${orgDn(org)}`;

describe('Twake groups plugin routes', function () {
  let dm: DM;
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
    dm = new DM();
    Object.assign(dm.config, {
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
      group_schema: '',
    });
    await dm.ready;
    await dm.registerPlugin('core/twake/groups', new TwakeGroups(dm));
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
    expect(
      (await api.get(`${route()}?search=f`).expect(400)).body.code
    ).to.equal('INVALID_SEARCH_QUERY');
    expect(
      (await api.get(`${route()}?sortBy=cn`).expect(400)).body.code
    ).to.equal('INVALID_SORT_FIELD');
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

  it('deletes a group', async () => {
    const id = await create('Eng');
    await api.delete(`${route()}/${id}`).expect(200);
    await api.delete(`${route()}/${id}`).expect(404);
  });

  it('does not serve the flat group routes', async () => {
    await api.get('/api/v1/ldap/groups').expect(404);
  });
});
