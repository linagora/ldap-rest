/**
 * The complete option set: the core options followed by every plugin
 * family's declarations.
 *
 * `src/config/args.ts` and the parser know only the core options. This module
 * is the composition root that the server passes to `DM`; it moves to the
 * umbrella package when the repository is split. See
 * `docs/development/modularization-plan.md`.
 */
import coreConfigArgs from '../config/args';
import { toConfigEntries } from '../config/options';
import type { ConfigTemplate } from '../lib/parseConfig';
import { scimOptions } from '../lib/scim/options';
import { bclOptions } from '../plugins/bcl.options';
import { metricsOptions } from '../plugins/metrics.options';
import { rabbitmqOptions } from '../plugins/rabbitmq.options';
import { staticOptions } from '../plugins/static.options';
import { storageOptions } from '../plugins/storage.options';
import {
  authOptions,
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
} from '../plugins/auth/auth.options';
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
} from '../plugins/ldap/ldap.options';
import { appAccountsOptions } from '../plugins/twake/appAccounts.options';
import { calendarOptions } from '../plugins/twake/calendar.options';
import { clouderyOptions } from '../plugins/twake/cloudery.options';
import { cozyOptions } from '../plugins/twake/cozy.options';
import { driveOptions } from '../plugins/twake/drive.options';
import { jamesOptions } from '../plugins/twake/james.options';
import { migrationProxyOptions } from '../plugins/twake/migrationProxy.options';
import { twakeGroupsOptions } from '../plugins/twake/twakeGroups.options';
import { twakeInstancesOptions } from '../plugins/twake/twakeInstances.options';
import { twakeLifecycleOptions } from '../plugins/twake/twakeLifecycle.options';
import { twakeSpacesOptions } from '../plugins/twake/twakeSpaces.options';
import { twakeTombstoneOptions } from '../plugins/twake/twakeTombstone.options';

const configArgs: ConfigTemplate = [
  ...coreConfigArgs,

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

  // Common to every authentication plugin
  ...toConfigEntries(authOptions),

  // Auth token, fake, TOTP and HMAC plugins
  ...toConfigEntries(tokenOptions),
  ...toConfigEntries(fakeOptions),
  ...toConfigEntries(totpOptions),
  ...toConfigEntries(hmacOptions),

  // Auth authzPerRoute plugin
  ...toConfigEntries(perRouteOptions),

  // Common to every authorization plugin
  ...toConfigEntries(authzOptions),

  // Auth authzPerBranch plugin
  ...toConfigEntries(perBranchOptions),

  // Auth authzDynamic plugin
  //
  // Who may reach the directory through this plugin without presenting one
  // of its tokens. Empty — the default — means nobody: a request is checked
  // against the ACLs of the token it carries, whatever else authenticated
  // it. Values are identities as another authenticator publishes them in
  // `req.user`, plus two words:
  //
  //  - `any-authenticated`: anything another plugin authenticated, which is
  //    what the plugin did until 0.9.0, by accident rather than by decision;
  //  - `trusted-proxy`: a request `core/auth/trustedProxy` vouched for.
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
