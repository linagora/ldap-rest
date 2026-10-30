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
import LdapPasswordPolicy from '../../src/plugins/ldap/passwordPolicy';
import LdapRaw from '../../src/plugins/ldap/raw';
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
  if (schema?.additionalProperties === false)
    bodies.push({ body: { probeUnknown: true }, why: 'an unknown key' });
  return bodies;
};

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
    for (const [name, Plugin] of [
      ['ldapFlatGeneric', LdapFlatGeneric],
      ['ldapAccountLifecycle', LdapAccountLifecycle],
      ['ldapGroups', LdapGroups],
      ['ldapOrganizations', LdapOrganizations],
      ['ldapRaw', LdapRaw],
      ['ldapPasswordPolicy', LdapPasswordPolicy],
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
      const res = await request.get(`${fill(route.path)}?${query}`);
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
