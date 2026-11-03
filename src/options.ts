/**
 * The complete option set: the core options followed by every plugin
 * family's declarations.
 *
 * The core package declares only the options it reads. This umbrella module
 * composes them with the plugin families' declarations and is the template
 * the umbrella's `DM` passes to the core. See
 * `docs/development/modularization-plan.md`.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import coreConfigArgs from '@ldap-rest/core/config/args';
import { toConfigEntries } from '@ldap-rest/core/config/options';
import type {
  ConfigEntry,
  ConfigTemplate,
} from '@ldap-rest/core/lib/parseConfig';
import { scimOptions } from '@ldap-rest/core/lib/scim/options';
import { setShippedSchemasPath } from '@ldap-rest/core/lib/schemaFile';
import { setServerVersion } from '@ldap-rest/core/lib/version';

import { bclOptions } from './plugins/bcl.options';
import { metricsOptions } from './plugins/metrics.options';
import { rabbitmqOptions } from './plugins/rabbitmq.options';
import { staticOptions } from './plugins/static.options';
import { storageOptions } from './plugins/storage.options';
import {
  authzOptions,
  crowdsecOptions,
  dynamicOptions,
  fakeOptions,
  hmacOptions,
  linid1Options,
  llngOptions,
  openidconnectOptions,
  perBranchOptions,
  perRouteOptions,
  rateLimitOptions,
  tokenOptions,
  totpOptions,
  trustedProxyOptions,
} from './plugins/auth/auth.options';
import {
  bulkImportOptions,
  enterpriseRulesOptions,
  externalUsersOptions,
  flatGenericOptions,
  groupsOptions,
  organizationOptions,
  passwordPolicyOptions,
  rawOptions,
  trashOptions,
} from './plugins/ldap/ldap.options';
import { appAccountsOptions } from './plugins/twake/appAccounts.options';
import { calendarOptions } from './plugins/twake/calendar.options';
import { clouderyOptions } from './plugins/twake/cloudery.options';
import { cozyOptions } from './plugins/twake/cozy.options';
import { driveOptions } from './plugins/twake/drive.options';
import { jamesOptions } from './plugins/twake/james.options';
import { migrationProxyOptions } from './plugins/twake/migrationProxy.options';
import { twakeGroupsOptions } from './plugins/twake/twakeGroups.options';
import { twakeInstancesOptions } from './plugins/twake/twakeInstances.options';
import { twakeLifecycleOptions } from './plugins/twake/twakeLifecycle.options';
import { twakeSpacesOptions } from './plugins/twake/twakeSpaces.options';
import { twakeTombstoneOptions } from './plugins/twake/twakeTombstone.options';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const shippedSchemas = join(packageRoot, 'static', 'schemas');
setShippedSchemasPath(shippedSchemas);
setServerVersion(
  (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    }
  ).version
);

const coreOptions: ConfigTemplate = coreConfigArgs.map(entry =>
  entry[0] === '--schemas-path'
    ? ([entry[0], entry[1], shippedSchemas, ...entry.slice(3)] as ConfigEntry)
    : entry
);

const configArgs: ConfigTemplate = [
  ...coreOptions,

  // LDAP organizations
  ...toConfigEntries(organizationOptions),

  // LDAP enterprise rules plugin
  ...toConfigEntries(enterpriseRulesOptions),

  // Metrics, keyed storage and Back-Channel Logout plugins
  ...toConfigEntries(metricsOptions),
  ...toConfigEntries(storageOptions),
  ...toConfigEntries(bclOptions),

  // LDAP groups and external users plugins
  ...toConfigEntries(groupsOptions),
  ...toConfigEntries(externalUsersOptions),

  // static
  ...toConfigEntries(staticOptions),

  // LDAP flat, raw and bulk import plugins
  ...toConfigEntries(flatGenericOptions),
  ...toConfigEntries(rawOptions),
  ...toConfigEntries(bulkImportOptions),

  // James plugin
  ...toConfigEntries(jamesOptions),

  // Twake Mail migration proxy plugin
  ...toConfigEntries(migrationProxyOptions),

  // Drive (Cozy) plugin
  ...toConfigEntries(driveOptions),

  // Twake Calendar plugin
  ...toConfigEntries(calendarOptions),

  // Cozy provisioning plugin (twake/cozyProvision)
  ...toConfigEntries(cozyOptions),

  // clouderyProvision plugin
  ...toConfigEntries(clouderyOptions),

  // Account lifecycle, groups, spaces and tombstone options
  ...toConfigEntries(twakeLifecycleOptions),
  ...toConfigEntries(twakeGroupsOptions),
  ...toConfigEntries(twakeSpacesOptions),
  ...toConfigEntries(twakeTombstoneOptions),

  // twake/instances plugin
  ...toConfigEntries(twakeInstancesOptions),

  ...toConfigEntries(rabbitmqOptions),

  // Applicative Accounts plugin
  ...toConfigEntries(appAccountsOptions),

  // Trash plugin
  ...toConfigEntries(trashOptions),

  /* Access control plugins */

  // Lemonldap options
  ...toConfigEntries(llngOptions),

  // Auth token, fake, TOTP and HMAC plugins
  ...toConfigEntries(tokenOptions),
  ...toConfigEntries(fakeOptions),
  ...toConfigEntries(totpOptions),
  ...toConfigEntries(hmacOptions),

  // Auth authzPerRoute plugin
  ...toConfigEntries(perRouteOptions),

  // Auth authzScope plugin
  ...toConfigEntries(authzOptions),

  // Auth authzPerBranch plugin
  ...toConfigEntries(perBranchOptions),

  // Auth authzDynamic plugin
  ...toConfigEntries(dynamicOptions),

  // Auth authzLinid1 plugin
  ...toConfigEntries(linid1Options),

  // Auth OpenID Connect plugin
  ...toConfigEntries(openidconnectOptions),

  // Rate limiting, CrowdSec and trusted proxy plugins
  ...toConfigEntries(rateLimitOptions),
  ...toConfigEntries(crowdsecOptions),
  ...toConfigEntries(trustedProxyOptions),

  // Password Policy plugin
  ...toConfigEntries(passwordPolicyOptions),

  // SCIM plugin
  ...toConfigEntries(scimOptions),
];

export default configArgs;
