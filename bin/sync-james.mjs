#!/usr/bin/env node
/**
 * Sync utility to verify and fix consistency between LDAP and James
 * Ensures James quotas match LDAP mailQuota values
 * @author Generated with Claude Code
 */

import fetch from 'node-fetch';
import { DM } from '../dist/bin/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const dryRun = args.includes('--dry-run') || args.includes('-n');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: sync-james [options]

Synchronizes James quotas with LDAP mailQuota values.
LDAP is considered the source of truth.

Options:
  --quiet, -q      Only show summary and errors
  --dry-run, -n    Show what would be changed without making changes
  --help, -h       Show this help message

Environment variables:
  DM_JAMES_WEBADMIN_URL    James WebAdmin URL (required)
  DM_JAMES_WEBADMIN_TOKEN  James WebAdmin authentication token
  DM_LDAP_BASE             LDAP search base
  DM_MAIL_ATTRIBUTE        Mail attribute name (default: mail)
  DM_QUOTA_ATTRIBUTE       Quota attribute name (default: mailQuota)
`);
  process.exit(0);
}

async function syncJamesQuotas() {
  const dm = new DM();
  await dm.ready;

  const mailAttr = dm.config.mail_attribute || 'mail';
  const quotaAttr = dm.config.quota_attribute || 'mailQuota';
  const jamesUrl = dm.config.james_webadmin_url;
  const jamesToken = dm.config.james_webadmin_token;

  if (!jamesUrl) {
    dm.logger.error('DM_JAMES_WEBADMIN_URL is not configured');
    process.exit(1);
  }

  if (!quiet) {
    dm.logger.info('Starting LDAP to James quota synchronization...');
    dm.logger.info(`LDAP base: ${dm.config.ldap_base}`);
    dm.logger.info(`James URL: ${jamesUrl}`);
    if (dryRun) {
      dm.logger.info('DRY RUN MODE: No changes will be made');
    }
    dm.logger.info('');
  }

  try {
    // Search for all users with mail and quota attributes (paginated for large directories)
    const resultGenerator = await dm.ldap.search({
      paged: true,
      filter: `(&(${mailAttr}=*)(${quotaAttr}=*))`,
      attributes: [mailAttr, quotaAttr, 'dn'],
    });

    let checked = 0;
    let synced = 0;
    let errors = 0;

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
        const ldapQuota = Array.isArray(entry[quotaAttr])
          ? Number(entry[quotaAttr][0])
          : Number(entry[quotaAttr]);

        if (!mail || isNaN(ldapQuota)) {
          dm.logger.warn(`Skipping ${dn}: invalid mail or quota`);
          continue;
        }

        checked++;

        try {
          // Get James quota
          const getUrl = `${jamesUrl}/quota/users/${mail}/size`;
          const headers = {};
          if (jamesToken) {
            headers.Authorization = `Bearer ${jamesToken}`;
          }

          const getRes = await fetch(getUrl, { method: 'GET', headers });

          if (!getRes.ok) {
            if (getRes.status === 404) {
              dm.logger.warn(
                `User ${mail} not found in James, skipping (DN: ${dn})`
              );
            } else {
              dm.logger.error(
                `Error getting quota for ${mail}: ${getRes.status} ${getRes.statusText}`
              );
              errors++;
            }
            continue;
          }

          const jamesQuota = Number(await getRes.text());

          if (jamesQuota === ldapQuota) {
            if (!quiet) {
              dm.logger.info(`${mail}: quota OK (${ldapQuota})`);
            }
          } else {
            dm.logger.warn(
              `${mail}: quota mismatch - LDAP: ${ldapQuota}, James: ${jamesQuota}`
            );
            if (dryRun) {
              dm.logger.info(`  Would update James quota to ${ldapQuota}`);
              synced++;
            } else {
              if (!quiet) {
                dm.logger.info(`  Updating James quota to ${ldapQuota}...`);
              }

              // Update James quota
              const putUrl = `${jamesUrl}/quota/users/${mail}/size`;
              const putRes = await fetch(putUrl, {
                method: 'PUT',
                headers,
                body: ldapQuota.toString(),
              });

              if (putRes.ok) {
                if (!quiet) {
                  dm.logger.info(`  Updated successfully`);
                }
                synced++;
              } else {
                dm.logger.error(
                  `  Failed to update: ${putRes.status} ${putRes.statusText}`
                );
                errors++;
              }
            }
          }
        } catch (err) {
          dm.logger.error(`Error processing ${mail}: ${err.message}`);
          errors++;
        }
      }
    }

    dm.logger.info('\n' + '='.repeat(60));
    dm.logger.info('Synchronization summary:');
    dm.logger.info(`  Users checked: ${checked}`);
    dm.logger.info(`  Quotas ${dryRun ? 'needing sync' : 'synced'}: ${synced}`);
    dm.logger.info(`  Errors: ${errors}`);
    dm.logger.info('='.repeat(60));
  } catch (err) {
    dm.logger.error('Error during synchronization:', err);
    process.exit(1);
  } finally {
    await dm.ldap.unbind();
  }
}

// Run the sync
syncJamesQuotas().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
