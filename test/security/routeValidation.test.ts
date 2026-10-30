/**
 * What a route does with an input it cannot take (#417): every route that
 * declares a query or a body is probed with a value of the wrong shape, and
 * must answer 4xx naming the part — before its handler runs.
 *
 * The routes are read from the registry `defineRoute` fills, so a new
 * declaration is covered without touching this file.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import { registeredRoutes, type RegisteredRoute } from '../../src/lib/route';
import LdapAccountLifecycle from '../../src/plugins/ldap/accountLifecycle';
import LdapFlatGeneric from '../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../src/plugins/ldap/groups';
import LdapOrganizations from '../../src/plugins/ldap/organizations';
import OnLdapChange from '../../src/plugins/ldap/onChange';
import LdapPasswordPolicy from '../../src/plugins/ldap/passwordPolicy';
import LdapRaw from '../../src/plugins/ldap/raw';
import AppAccountsConsistency from '../../src/plugins/twake/appAccountsConsistency';
import AppAccountsApi from '../../src/plugins/twake/appAccountsApi';
import TwakeInstances from '../../src/plugins/twake/instances';
import TwakeTombstone from '../../src/plugins/twake/tombstone';
import { skipIfMissingEnvVars, LDAP_ENV_VARS_WITH_ORG } from '../helpers/env';

/** A JSON schema, as the registry keeps it */
interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** The path with every `:param` given a value the params schema accepts */
const fill = (path: string): string => path.replace(/:\w+/g, 'probe');

/** A value the schema takes */
const valid = (schema: Schema): unknown => {
  switch (schema?.type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return ['probe'];
    default:
      return 'probe';
  }
};

/** A value the schema cannot take */
const wrong = (schema: Schema): unknown => {
  switch (schema?.type) {
    case 'integer':
    case 'number':
      return 'soon';
    case 'boolean':
      return 'maybe';
    default:
      return 5;
  }
};

/**
 * A query string the schema refuses, or undefined when it names no property
 * this test can mistype.
 */
const badQuery = (schema: Schema): string | undefined => {
  const properties = Object.entries(schema?.properties ?? {});
  for (const [name, property] of properties)
    if (['integer', 'number', 'boolean'].includes(property.type ?? ''))
      return `${name}=${property.type === 'boolean' ? 'maybe' : 'soon'}`;
  const textual = properties.find(([, property]) => property.type === 'string');
  // A key given twice is not a string
  return textual ? `${textual[0]}=a&${textual[0]}=b` : undefined;
};

/** Bodies the schema refuses, with what each one tests */
const badBodies = (schema: Schema): Array<{ body: unknown; why: string }> => {
  const bodies: Array<{ body: unknown; why: string }> = [
    { body: [], why: 'not an object' },
  ];
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const first = Object.keys(properties).find(name => required.has(name));
  if (first)
    bodies.push({
      body: { [first]: wrong(properties[first]) },
      why: `${first} of the wrong type`,
    });
  if (schema?.additionalProperties === false) {
    // The required fields hold values it takes, so only the key is at fault
    const filled = Object.fromEntries(
      Object.entries(properties)
        .filter(([name]) => required.has(name))
        .map(([name, property]) => [name, valid(property)])
    );
    bodies.push({
      body: { ...filled, probeUnknown: true },
      why: 'an unknown key',
    });
  }
  return bodies;
};

/** A broker that takes every message, for the plugins requiring one */
class StubRabbitMq {
  name = 'rabbitmq';
  getRawClient(): Promise<unknown> {
    return Promise.resolve({});
  }
  subscribe(): Promise<void> {
    return Promise.resolve();
  }
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Every route refuses the input it cannot take', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let routes: readonly RegisteredRoute[];

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    server.config.ppolicy_validate_complexity = true;
    server.config.mail_attribute = 'mail';
    server.config.twake_lifecycle_deleted_attribute = 'employeeType';
    server.config.twake_lifecycle_deleted_value = 'deleted';
    server.config.twake_tombstone_dn = [
      `^uid=probe-gone,ou=users,${process.env.DM_LDAP_BASE}$`,
    ];
    server.config.applicative_account_base = `ou=probeapplicative,${process.env.DM_LDAP_BASE}`;
    Object.assign(server.config, {
      twake_instance_provider: 'cozy-stack',
      twake_instance_cozy_url: 'http://127.0.0.1:9',
      twake_instance_cozy_domain: 'probe.example',
      twake_instance_fqdn_attribute: 'carLicense',
      twake_instance_sent_attribute: 'businessCategory',
    });
    server.loadedPlugins['rabbitmq'] = new StubRabbitMq() as never;
    for (const [name, Plugin] of [
      ['ldapFlatGeneric', LdapFlatGeneric],
      ['ldapAccountLifecycle', LdapAccountLifecycle],
      ['ldapGroups', LdapGroups],
      ['ldapOrganizations', LdapOrganizations],
      ['ldapRaw', LdapRaw],
      ['ldapPasswordPolicy', LdapPasswordPolicy],
      ['ldapOnChange', OnLdapChange],
      ['appAccountsConsistency', AppAccountsConsistency],
      ['appAccountsApi', AppAccountsApi],
      ['twakeTombstone', TwakeTombstone],
      ['twakeInstances', TwakeInstances],
    ] as [string, new (s: DM) => LdapFlatGeneric][])
      await server.registerPlugin(name, new Plugin(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
    routes = registeredRoutes(server.app);
  });

  it('declares routes to probe', () => {
    const withQuery = routes.filter(route => route.query);
    const withBody = routes.filter(route => route.body);
    expect(withQuery.length, 'routes with a query').to.be.greaterThan(0);
    expect(withBody.length, 'routes with a body').to.be.greaterThan(0);
  });

  it('refuses a query value of the wrong type', async () => {
    let probed = 0;
    for (const route of routes) {
      if (!route.query) continue;
      const query = badQuery(route.query as Schema);
      if (query === undefined) continue;
      const call = request[route.method](
        `${fill(route.path)}?${query}`
      ) as ReturnType<typeof request.get>;
      const res = await call;
      expect(res.status, `${route.method} ${route.path}?${query}`).to.equal(
        400
      );
      expect(res.body.error, `${route.method} ${route.path}?${query}`).to.match(
        /^Invalid request: query(:|\.)/
      );
      probed++;
    }
    expect(probed, 'routes probed').to.be.greaterThan(0);
  });

  it('refuses a body of the wrong shape', async () => {
    let probed = 0;
    for (const route of routes) {
      if (!route.body) continue;
      for (const { body, why } of badBodies(route.body as Schema)) {
        const call = request[route.method](fill(route.path)) as ReturnType<
          typeof request.get
        >;
        const res = await call.send(body as object);
        const label = `${route.method} ${route.path} with ${why}`;
        expect(res.status, label).to.equal(400);
        expect(res.body.error, label).to.match(/^Invalid request: body(:|\.)/);
        probed++;
      }
    }
    expect(probed, 'bodies probed').to.be.greaterThan(0);
  });
});
