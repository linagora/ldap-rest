/**
 * The complete option set: the core options followed by every plugin
 * family's declarations.
 *
 * The server reads only the plugins its command names; this module keeps the
 * complete set for the build scripts, the option snapshot and the tests. See
 * `docs/development/modularization-plan.md`.
 */
import { toConfigEntries } from '@ldap-rest/core/config/options';
import type { ConfigTemplate } from '@ldap-rest/core/lib/parseConfig';
import { scimOptions } from '@ldap-rest/core/lib/scim/options';
import { appAccountsOptions } from '@ldap-rest/twake-appaccounts/options';
import { authzOptions } from '@ldap-rest/authz-scope/options';
import { bclOptions } from '@ldap-rest/bcl/options';
import { bulkImportOptions } from '@ldap-rest/ldap-bulkimport/options';
import { calendarOptions } from '@ldap-rest/twake-calendar/options';
import { clouderyOptions } from '@ldap-rest/twake-provisioning/cloudery-options';
import { cozyOptions } from '@ldap-rest/twake-provisioning/cozy-options';
import { crowdsecOptions } from '@ldap-rest/auth-crowdsec/options';
import { driveOptions } from '@ldap-rest/twake-drive/options';
import { dynamicOptions } from '@ldap-rest/authz-dynamic/options';
import { enterpriseRulesOptions } from '@ldap-rest/ldap-enterpriserules/options';
import { externalUsersOptions } from '@ldap-rest/ldap-externalusers/options';
import { fakeOptions } from '@ldap-rest/auth-fake/options';
import { flatGenericOptions } from '@ldap-rest/ldap-flatgeneric/options';
import { groupsOptions } from '@ldap-rest/ldap-groups/options';
import { hmacOptions } from '@ldap-rest/auth-hmac/options';
import { jamesOptions } from '@ldap-rest/james/options';
import { linid1Options } from '@ldap-rest/authz-linid1/options';
import { llngOptions } from '@ldap-rest/auth-llng/options';
import { metricsOptions } from '@ldap-rest/metrics/options';
import { migrationProxyOptions } from '@ldap-rest/twake-mail-migration/options';
import { openidconnectOptions } from '@ldap-rest/auth-openidconnect/options';
import { organizationOptions } from '@ldap-rest/ldap-organizations/options';
import { passwordPolicyOptions } from '@ldap-rest/ldap-passwordpolicy/options';
import { perBranchOptions } from '@ldap-rest/authz-perbranch/options';
import { perRouteOptions } from '@ldap-rest/authz-perroute/options';
import { rabbitmqOptions } from '@ldap-rest/rabbitmq/options';
import { rateLimitOptions } from '@ldap-rest/auth-ratelimit/options';
import { rawOptions } from '@ldap-rest/ldap-raw/options';
import { staticOptions } from '@ldap-rest/static/options';
import { storageOptions } from '@ldap-rest/storage/options';
import { tokenOptions } from '@ldap-rest/auth-token/options';
import { totpOptions } from '@ldap-rest/auth-totp/options';
import { trashOptions } from '@ldap-rest/ldap-trash/options';
import { trustedProxyOptions } from '@ldap-rest/auth-trustedproxy/options';
import { twakeGroupsOptions } from '@ldap-rest/twake-collaboration/groups-options';
import { twakeInstancesOptions } from '@ldap-rest/twake-provisioning/options';
import { twakeLifecycleOptions } from '@ldap-rest/twake-lifecycle/options';
import { twakeSpacesOptions } from '@ldap-rest/twake-collaboration/spaces-options';
import { twakeTombstoneOptions } from '@ldap-rest/twake-lifecycle/tombstone-options';

import { coreOptions, withoutCoreDuplicates } from './coreOptions.js';

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

/** The plugin declarations alone, before the core entries drop their copies */
export const pluginConfigArgs = configArgs.slice(coreOptions.length);

export default withoutCoreDuplicates(configArgs);
