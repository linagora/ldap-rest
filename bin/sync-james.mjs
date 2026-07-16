#!/usr/bin/env node
/**
 * Sync utility to verify and fix consistency between LDAP and James
 * Ensures James quotas match LDAP mailQuota values and that James aliases
 * match the LDAP alias attribute (catch-up in case the event-based sync failed)
 * @author Generated with Claude Code
 */

import fetch from 'node-fetch';
import { DM } from '../dist/bin/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const dryRun = args.includes('--dry-run') || args.includes('-n');
const noAliasDelete = args.includes('--no-alias-delete');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: sync-james [options]

Synchronizes James with LDAP. LDAP is considered the source of truth.

For every user it reconciles:
  - the mailbox quota (James quota <- LDAP mailQuota)
  - the mail aliases (James aliases <- LDAP alias attribute)

The alias reconciliation is a catch-up mechanism: it repairs aliases that
were not propagated to James (e.g. when the event-based sync failed).

Options:
  --quiet, -q         Only show summary and errors
  --dry-run, -n       Show what would be changed without making changes
  --no-alias-delete   Do not remove James aliases that are absent from LDAP
                      (only add missing ones)
  --help, -h          Show this help message

Environment variables:
  DM_JAMES_WEBADMIN_URL    James WebAdmin URL (required)
  DM_JAMES_WEBADMIN_TOKEN  James WebAdmin authentication token
  DM_LDAP_BASE             LDAP search base
  DM_MAIL_ATTRIBUTE        Mail attribute name (default: mail)
  DM_QUOTA_ATTRIBUTE       Quota attribute name (default: mailQuota)
  DM_ALIAS_ATTRIBUTE       Alias attribute name (default: mailAlternateAddress)
`);
  process.exit(0);
}

/**
 * Normalize an email alias - handle AD format (smtp:alias@domain.com).
 * Mirrors the behaviour of TwakePlugin.normalizeAlias in the main codebase.
 * @param {string} alias
 * @returns {string}
 */
function normalizeAlias(alias) {
  if (alias.toLowerCase().startsWith('smtp:')) {
    return alias.substring(5);
  }
  return alias;
}

/**
 * Extract normalized aliases from an LDAP attribute value.
 * @param {string|string[]|Buffer|Buffer[]|undefined} value
 * @returns {string[]}
 */
function getAliases(value) {
  if (!value) return [];
  const aliases = Array.isArray(value) ? value : [value];
  return aliases
    .map(a => (Buffer.isBuffer(a) ? a.toString('utf-8') : String(a)))
    .map(a => normalizeAlias(a))
    .filter(a => a.length > 0);
}

async function syncJames() {
  const dm = new DM();
  await dm.ready;

  const mailAttr = dm.config.mail_attribute || 'mail';
  const quotaAttr = dm.config.quota_attribute || 'mailQuota';
  const aliasAttr = dm.config.alias_attribute || 'mailAlternateAddress';
  const jamesUrl = dm.config.james_webadmin_url;
  const jamesToken = dm.config.james_webadmin_token;

  if (!jamesUrl) {
    dm.logger.error('DM_JAMES_WEBADMIN_URL is not configured');
    process.exit(1);
  }

  const headers = {};
  if (jamesToken) {
    headers.Authorization = `Bearer ${jamesToken}`;
  }

  if (!quiet) {
    dm.logger.info('Starting LDAP to James synchronization...');
    dm.logger.info(`LDAP base: ${dm.config.ldap_base}`);
    dm.logger.info(`James URL: ${jamesUrl}`);
    if (dryRun) {
      dm.logger.info('DRY RUN MODE: No changes will be made');
    }
    dm.logger.info('');
  }

  const stats = {
    checked: 0,
    quotaSynced: 0,
    aliasesAdded: 0,
    aliasesDeleted: 0,
    errors: 0,
  };

  /**
   * Reconcile the mailbox quota for a single user.
   */
  async function syncQuota(dn, mail, ldapQuota) {
    if (isNaN(ldapQuota)) return;

    const url = `${jamesUrl}/quota/users/${mail}/size`;
    const getRes = await fetch(url, { method: 'GET', headers });

    if (!getRes.ok) {
      if (getRes.status === 404) {
        dm.logger.warn(`User ${mail} not found in James, skipping quota (DN: ${dn})`);
      } else {
        dm.logger.error(
          `Error getting quota for ${mail}: ${getRes.status} ${getRes.statusText}`
        );
        stats.errors++;
      }
      return;
    }

    const jamesQuota = Number(await getRes.text());

    if (jamesQuota === ldapQuota) {
      if (!quiet) {
        dm.logger.info(`${mail}: quota OK (${ldapQuota})`);
      }
      return;
    }

    dm.logger.warn(
      `${mail}: quota mismatch - LDAP: ${ldapQuota}, James: ${jamesQuota}`
    );
    if (dryRun) {
      dm.logger.info(`  Would update James quota to ${ldapQuota}`);
      stats.quotaSynced++;
      return;
    }

    if (!quiet) {
      dm.logger.info(`  Updating James quota to ${ldapQuota}...`);
    }
    const putRes = await fetch(url, {
      method: 'PUT',
      headers,
      body: ldapQuota.toString(),
    });
    if (putRes.ok) {
      if (!quiet) {
        dm.logger.info(`  Updated successfully`);
      }
      stats.quotaSynced++;
    } else {
      dm.logger.error(`  Failed to update quota: ${putRes.status} ${putRes.statusText}`);
      stats.errors++;
    }
  }

  /**
   * Fetch the aliases currently declared in James for a destination mail.
   * @returns {Promise<string[]|null>} list of source addresses, or null on error
   */
  async function fetchJamesAliases(mail) {
    const res = await fetch(`${jamesUrl}/address/aliases/${mail}`, {
      method: 'GET',
      headers,
    });

    // James returns 404 when the destination has no alias at all
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      dm.logger.error(
        `Error getting aliases for ${mail}: ${res.status} ${res.statusText}`
      );
      return null;
    }

    const body = await res.json();
    if (!Array.isArray(body)) {
      return [];
    }
    // James returns [{ source: 'alias@domain' }, ...]
    return body
      .map(e => (e && typeof e.source === 'string' ? e.source : null))
      .filter(Boolean);
  }

  /**
   * Reconcile the aliases for a single user (catch-up).
   * LDAP is the source of truth: missing aliases are added, extra aliases in
   * James are removed (unless --no-alias-delete is set).
   */
  async function syncAliases(dn, mail, ldapAliasesRaw) {
    const ldapAliases = getAliases(ldapAliasesRaw);

    const jamesAliases = await fetchJamesAliases(mail);
    if (jamesAliases === null) {
      stats.errors++;
      return;
    }

    // Case-insensitive comparison to avoid spurious add/delete churn
    const ldapSet = new Set(ldapAliases.map(a => a.toLowerCase()));
    const jamesSet = new Set(jamesAliases.map(a => a.toLowerCase()));

    const toAdd = ldapAliases.filter(a => !jamesSet.has(a.toLowerCase()));
    const toDelete = noAliasDelete
      ? []
      : jamesAliases.filter(a => !ldapSet.has(a.toLowerCase()));

    if (toAdd.length === 0 && toDelete.length === 0) {
      if (!quiet && (ldapAliases.length > 0 || jamesAliases.length > 0)) {
        dm.logger.info(`${mail}: aliases OK (${ldapAliases.length})`);
      }
      return;
    }

    for (const alias of toAdd) {
      dm.logger.warn(`${mail}: missing alias in James - ${alias}`);
      if (dryRun) {
        dm.logger.info(`  Would add alias ${alias}`);
        stats.aliasesAdded++;
        continue;
      }
      const res = await fetch(
        `${jamesUrl}/address/aliases/${mail}/sources/${alias}`,
        { method: 'PUT', headers }
      );
      // 409 = alias already exists, treat as success (mirrors plugin behaviour)
      if (res.ok || res.status === 409) {
        if (!quiet) {
          dm.logger.info(`  Added alias ${alias}`);
        }
        stats.aliasesAdded++;
      } else {
        dm.logger.error(
          `  Failed to add alias ${alias}: ${res.status} ${res.statusText}`
        );
        stats.errors++;
      }
    }

    for (const alias of toDelete) {
      dm.logger.warn(`${mail}: stale alias in James - ${alias}`);
      if (dryRun) {
        dm.logger.info(`  Would delete alias ${alias}`);
        stats.aliasesDeleted++;
        continue;
      }
      const res = await fetch(
        `${jamesUrl}/address/aliases/${mail}/sources/${alias}`,
        { method: 'DELETE', headers }
      );
      if (res.ok) {
        if (!quiet) {
          dm.logger.info(`  Deleted alias ${alias}`);
        }
        stats.aliasesDeleted++;
      } else {
        dm.logger.error(
          `  Failed to delete alias ${alias}: ${res.status} ${res.statusText}`
        );
        stats.errors++;
      }
    }
  }

  try {
    // Search for every user that has a mail (paginated for large directories).
    // We enumerate all mailboxes, not only those carrying a quota/alias, so
    // that a user whose alias attribute was cleared still gets its stale James
    // aliases removed (LDAP is the source of truth). Destinations whose mail is
    // absent from LDAP are intentionally left alone: James refuses delivery for
    // an alias pointing to a non-existent mailbox, so they are harmless.
    const resultGenerator = await dm.ldap.search({
      paged: true,
      filter: `(${mailAttr}=*)`,
      attributes: [mailAttr, quotaAttr, aliasAttr, 'dn'],
    });

    // Process results page by page
    for await (const result of resultGenerator) {
      if (!result.searchEntries || result.searchEntries.length === 0) {
        continue;
      }

      if (!quiet) {
        dm.logger.info(
          `Processing batch of ${result.searchEntries.length} users...`
        );
      }

      for (const entry of result.searchEntries) {
        const dn = entry.dn;
        const mail = Array.isArray(entry[mailAttr])
          ? entry[mailAttr][0]
          : entry[mailAttr];

        if (!mail) {
          dm.logger.warn(`Skipping ${dn}: invalid mail`);
          continue;
        }

        stats.checked++;

        try {
          // Reconcile quota only when the user has a quota attribute
          if (entry[quotaAttr] !== undefined) {
            const ldapQuota = Array.isArray(entry[quotaAttr])
              ? Number(entry[quotaAttr][0])
              : Number(entry[quotaAttr]);
            await syncQuota(dn, mail, ldapQuota);
          }

          // Reconcile aliases (catch-up). Always run so that stale aliases
          // are removed even when the LDAP attribute has been cleared.
          await syncAliases(dn, mail, entry[aliasAttr]);
        } catch (err) {
          dm.logger.error(`Error processing ${mail}: ${err.message}`);
          stats.errors++;
        }
      }
    }

    dm.logger.info('\n' + '='.repeat(60));
    dm.logger.info('Synchronization summary:');
    dm.logger.info(`  Users checked: ${stats.checked}`);
    dm.logger.info(
      `  Quotas ${dryRun ? 'needing sync' : 'synced'}: ${stats.quotaSynced}`
    );
    dm.logger.info(
      `  Aliases ${dryRun ? 'to add' : 'added'}: ${stats.aliasesAdded}`
    );
    dm.logger.info(
      `  Aliases ${dryRun ? 'to delete' : 'deleted'}: ${stats.aliasesDeleted}`
    );
    dm.logger.info(`  Errors: ${stats.errors}`);
    dm.logger.info('='.repeat(60));
  } catch (err) {
    dm.logger.error('Error during synchronization:', err);
    process.exit(1);
  } finally {
    await dm.ldap.unbind();
  }
}

// Run the sync
syncJames().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
