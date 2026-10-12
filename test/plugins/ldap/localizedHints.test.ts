/**
 * A schema `hint` may be translated, `{ "en": …, "fr": … }`, as the Twake
 * schemas ship theirs. The server quotes it when it refuses a value, and its
 * messages are English: the English text is quoted, not the map.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import { localizedText } from '../../../src/config/schema';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

describe('localizedText', () => {
  it('should read a plain string as the text itself', () => {
    expect(localizedText('Mailbox', 'fr')).to.equal('Mailbox');
    expect(localizedText('')).to.equal(undefined);
    expect(localizedText(undefined)).to.equal(undefined);
  });

  it('should pick the tag, then its language, then English, then any', () => {
    const text = { en: 'Mailbox', fr: 'Boîte', 'fr-CA': 'Boîte (CA)' };
    expect(localizedText(text, 'fr-CA')).to.equal('Boîte (CA)');
    expect(localizedText(text, 'fr-BE')).to.equal('Boîte');
    expect(localizedText(text, 'de')).to.equal('Mailbox');
    expect(localizedText(text)).to.equal('Mailbox');
    expect(localizedText({ fr: 'Boîte' })).to.equal('Boîte');
  });
});

describe('Translated hints in refusals', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let orgDn: string;
  let userDn: string;
  const UID = 'hint.alice';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    orgDn = `ou=HintOrg,${process.env.DM_LDAP_TOP_ORGANIZATION as string}`;
    userDn = `uid=${UID},ou=users,${base}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    server.config.organization_schema =
      './static/schemas/twake/organizations.json';
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    const organizations = new LdapOrganizations(server);
    await server.registerPlugin('ldapOrganizations', organizations);
    await waitFor(() => Boolean(organizations.schema), {
      what: 'the organizations schema',
    });
    server.setupErrorMiddleware();
    request = supertest(server.app);

    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'HintOrg',
        twakeDepartmentPath: 'HintOrg',
      })
      .catch(() => undefined);
    await server.ldap.delete(userDn).catch(() => undefined);
    await server.ldap.add(userDn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: UID,
      cn: UID,
      sn: 'Hint',
      givenName: 'Test',
      displayName: `Test ${UID}`,
      mail: `${UID}@example.com`,
      employeeNumber: 'HNT0001',
      twakeDepartmentLink: orgDn,
      twakeDepartmentPath: 'HintOrg',
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });
  });

  after(async () => {
    await server.ldap.delete(userDn).catch(() => undefined);
    await server.ldap.delete(orgDn).catch(() => undefined);
  });

  const modify = (replace: Record<string, string>) =>
    request.put(`/api/v1/ldap/users/${UID}`).type('json').send({ replace });

  it('should quote the English hint of a value the pattern refuses', async () => {
    const res = await modify({ mail: 'nope' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.equal(
      'Invalid value for attribute "mail": Expected an email address, e.g. jane.doe@example.org'
    );
  });

  it('should quote it for a size it cannot read', async () => {
    const res = await modify({ mailQuotaSize: 'lots' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.equal(
      'Invalid value for attribute "mailQuotaSize": Expected pattern xGB, xMB, xKB or a number of bytes'
    );
  });

  it('should quote it for a date it cannot read', async () => {
    const res = await modify({ twakeDeletionDate: 'soon' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.equal(
      'Invalid value for attribute "twakeDeletionDate": Expected a date not earlier than today'
    );
  });

  it('should quote it on the organization routes', async () => {
    const res = await request
      .post('/api/v1/ldap/organizations')
      .type('json')
      .send({ ou: '-HintChild', parentDn: orgDn });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.equal(
      "Invalid value for field ou: Letters, digits, spaces and ( ) & / , . ' - _, starting with a letter or a digit"
    );
  });
});
