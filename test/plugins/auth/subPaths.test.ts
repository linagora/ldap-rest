/**
 * The umbrella still publishes the authentication and authorization plugins
 * at their historical paths, so an import that predates the packages keeps
 * resolving. Each shim must re-export exactly what its package does, until
 * phase 3 removes the former sub-paths.
 *
 * See `docs/development/modularization-plan.md`.
 */
import { expect } from 'chai';
import * as authToken from '@ldap-rest/auth-token';
import * as authTotp from '@ldap-rest/auth-totp';
import * as authHmac from '@ldap-rest/auth-hmac';
import * as authLlng from '@ldap-rest/auth-llng';
import * as authOpenidconnect from '@ldap-rest/auth-openidconnect';
import * as authFake from '@ldap-rest/auth-fake';
import * as authCrowdsec from '@ldap-rest/auth-crowdsec';
import * as authRatelimit from '@ldap-rest/auth-ratelimit';
import * as authTrustedproxy from '@ldap-rest/auth-trustedproxy';
import * as authzDynamic from '@ldap-rest/authz-dynamic';
import * as authzDynamicHash from '@ldap-rest/authz-dynamic/hash';
import * as authzLinid1 from '@ldap-rest/authz-linid1';
import * as authzPerbranch from '@ldap-rest/authz-perbranch';
import * as authzPerroute from '@ldap-rest/authz-perroute';
import * as authzScope from '@ldap-rest/authz-scope';
import * as authTokenOptions from '@ldap-rest/auth-token/options';
import * as authTotpOptions from '@ldap-rest/auth-totp/options';
import * as authHmacOptions from '@ldap-rest/auth-hmac/options';
import * as authLlngOptions from '@ldap-rest/auth-llng/options';
import * as authOpenidconnectOptions from '@ldap-rest/auth-openidconnect/options';
import * as authFakeOptions from '@ldap-rest/auth-fake/options';
import * as authCrowdsecOptions from '@ldap-rest/auth-crowdsec/options';
import * as authRatelimitOptions from '@ldap-rest/auth-ratelimit/options';
import * as authTrustedproxyOptions from '@ldap-rest/auth-trustedproxy/options';
import * as authzDynamicOptions from '@ldap-rest/authz-dynamic/options';
import * as authzLinid1Options from '@ldap-rest/authz-linid1/options';
import * as authzPerbranchOptions from '@ldap-rest/authz-perbranch/options';
import * as authzPerrouteOptions from '@ldap-rest/authz-perroute/options';
import * as authzScopeOptions from '@ldap-rest/authz-scope/options';

import * as shimAuthToken from '../../../src/plugins/auth/token';
import * as shimAuthTotp from '../../../src/plugins/auth/totp';
import * as shimAuthHmac from '../../../src/plugins/auth/hmac';
import * as shimAuthLlng from '../../../src/plugins/auth/llng';
import * as shimAuthOpenidconnect from '../../../src/plugins/auth/openidconnect';
import * as shimAuthFake from '../../../src/plugins/auth/fake';
import * as shimAuthCrowdsec from '../../../src/plugins/auth/crowdsec';
import * as shimAuthRatelimit from '../../../src/plugins/auth/rateLimit';
import * as shimAuthTrustedproxy from '../../../src/plugins/auth/trustedProxy';
import * as shimAuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import * as shimAuthzDynamicHash from '../../../src/plugins/auth/authzDynamicHash';
import * as shimAuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import * as shimAuthzPerbranch from '../../../src/plugins/auth/authzPerBranch';
import * as shimAuthzPerroute from '../../../src/plugins/auth/authzPerRoute';
import * as shimAuthzScope from '../../../src/plugins/auth/authzScope';
import * as shimOptions from '../../../src/plugins/auth/auth.options';

type Namespace = Record<string, unknown>;

/** Historical shim path, package it re-exports, both modules */
const pairs: Array<[string, string, Namespace, Namespace]> = [
  ['token', '@ldap-rest/auth-token', shimAuthToken, authToken],
  ['totp', '@ldap-rest/auth-totp', shimAuthTotp, authTotp],
  ['hmac', '@ldap-rest/auth-hmac', shimAuthHmac, authHmac],
  ['llng', '@ldap-rest/auth-llng', shimAuthLlng, authLlng],
  [
    'openidconnect',
    '@ldap-rest/auth-openidconnect',
    shimAuthOpenidconnect,
    authOpenidconnect,
  ],
  ['fake', '@ldap-rest/auth-fake', shimAuthFake, authFake],
  ['crowdsec', '@ldap-rest/auth-crowdsec', shimAuthCrowdsec, authCrowdsec],
  ['rateLimit', '@ldap-rest/auth-ratelimit', shimAuthRatelimit, authRatelimit],
  [
    'trustedProxy',
    '@ldap-rest/auth-trustedproxy',
    shimAuthTrustedproxy,
    authTrustedproxy,
  ],
  ['authzDynamic', '@ldap-rest/authz-dynamic', shimAuthzDynamic, authzDynamic],
  [
    'authzDynamicHash',
    '@ldap-rest/authz-dynamic/hash',
    shimAuthzDynamicHash,
    authzDynamicHash,
  ],
  ['authzLinid1', '@ldap-rest/authz-linid1', shimAuthzLinid1, authzLinid1],
  [
    'authzPerBranch',
    '@ldap-rest/authz-perbranch',
    shimAuthzPerbranch,
    authzPerbranch,
  ],
  [
    'authzPerRoute',
    '@ldap-rest/authz-perroute',
    shimAuthzPerroute,
    authzPerroute,
  ],
  ['authzScope', '@ldap-rest/authz-scope', shimAuthzScope, authzScope],
];

/** The option sets the former `./plugin-auth-auth.options` entry published */
const optionPairs: Array<[string, Namespace]> = [
  ['authzOptions', authzScopeOptions],
  ['crowdsecOptions', authCrowdsecOptions],
  ['dynamicOptions', authzDynamicOptions],
  ['fakeOptions', authFakeOptions],
  ['hmacOptions', authHmacOptions],
  ['linid1Options', authzLinid1Options],
  ['llngOptions', authLlngOptions],
  ['openidconnectOptions', authOpenidconnectOptions],
  ['perBranchOptions', authzPerbranchOptions],
  ['perRouteOptions', authzPerrouteOptions],
  ['rateLimitOptions', authRatelimitOptions],
  ['tokenOptions', authTokenOptions],
  ['totpOptions', authTotpOptions],
  ['trustedProxyOptions', authTrustedproxyOptions],
];

/** Every name the former entry exported, the helpers included */
const optionNames = [
  ...optionPairs.map(([key]) => key),
  'crowdsecOptionsOf',
  'dynamicOptionsOf',
  'hmacOptionsOf',
  'perBranchOptionsOf',
  'rateLimitOptionsOf',
  'totpOptionsOf',
].sort();

describe('the historical authentication sub-paths', () => {
  for (const [name, packageName, shim, pkg] of pairs)
    it(`src/plugins/auth/${name} re-exports ${packageName}`, () => {
      expect(Object.keys(shim).sort()).to.deep.equal(Object.keys(pkg).sort());
      for (const key of Object.keys(pkg))
        expect(shim[key], key).to.equal(pkg[key]);
    });

  it('plugin-auth-auth.options re-exports every option set', () => {
    expect(Object.keys(shimOptions).sort()).to.deep.equal(optionNames);
    for (const [key, pkg] of optionPairs)
      expect((shimOptions as Namespace)[key], key).to.equal(pkg[key]);
  });
});
