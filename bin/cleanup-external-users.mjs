#!/usr/bin/env node

/**
 * Cleanup script for external users that are no longer referenced in any group
 *
 * Usage:
 *   cleanup-external-users.mjs [--dry-run] [--verbose] [--quiet]
 *
 * Options:
 *   --dry-run    Show what would be deleted without actually deleting
 *   --verbose    Show detailed information about each user checked
 *   --quiet      Only show errors and deletions (WOULD DELETE in dry-run mode)
 */

import { parseConfig } from '../dist/lib/parseConfig.js';
import configArgs from '../dist/config/args.js';
import ldapActions from '../dist/lib/ldapActions.js';
import { buildLogger } from '../dist/logger/winston.js';

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const quiet = args.includes('--quiet');

// Parse config
const config = parseConfig(configArgs);
const logger = buildLogger(config);

// Simple LDAP wrapper to match what DM provides
const server = {
  config,
  logger,
  hooks: {},
  loadedPlugins: {},
  operationSequence: 0,
};

const ldap = new ldapActions(server);

async function main() {
  try {
    if (!quiet) {
      logger.info('Starting cleanup of external users');
    }

    if (!config.external_members_branch) {
      logger.error('external_members_branch not configured');
      process.exit(1);
    }

    if (!config.ldap_group_base) {
      logger.error('ldap_group_base not configured');
      process.exit(1);
    }

    if (dryRun && !quiet) {
      logger.info('DRY RUN MODE - no changes will be made');
    }

    // Get all external users
    if (!quiet) {
      logger.info(`Searching for external users in ${config.external_members_branch}`);
    }
    const externalUsersResult = await ldap.search(
      {
        paged: false,
        scope: 'one',
        attributes: ['dn', 'mail'],
      },
      config.external_members_branch
    );

    const externalUsers = externalUsersResult.searchEntries;
    if (!quiet) {
      logger.info(`Found ${externalUsers.length} external users`);
    }

    if (externalUsers.length === 0) {
      if (!quiet) {
        logger.info('No external users to check');
      }
      return;
    }

    // Get all groups
    if (!quiet) {
      logger.info(`Searching for groups in ${config.ldap_group_base}`);
    }
    const groupsResult = await ldap.search(
      {
        paged: false,
        scope: 'sub',
        attributes: ['dn', config.ldap_group_member_attribute || 'member'],
      },
      config.ldap_group_base
    );

    const groups = groupsResult.searchEntries;
    if (!quiet) {
      logger.info(`Found ${groups.length} groups`);
    }

    // Build a set of all referenced member DNs
    const memberAttr = config.ldap_group_member_attribute || 'member';
    const referencedMembers = new Set();

    for (const group of groups) {
      const members = group[memberAttr];
      if (members) {
        const memberList = Array.isArray(members) ? members : [members];
        memberList.forEach(member => {
          // Normalize DN (remove spaces)
          referencedMembers.add(member.replace(/\s/g, ''));
        });
      }
    }

    if (!quiet) {
      logger.info(`Found ${referencedMembers.size} unique member references across all groups`);
    }

    // Check each external user
    let toDelete = 0;
    let kept = 0;

    for (const user of externalUsers) {
      const userDn = user.dn.replace(/\s/g, '');
      const isReferenced = referencedMembers.has(userDn);

      if (isReferenced) {
        kept++;
        if (verbose) {
          logger.info(`KEEP: ${user.dn} (${user.mail || 'no mail'}) - still referenced`);
        }
      } else {
        toDelete++;
        if (dryRun) {
          logger.info(`WOULD DELETE: ${user.dn} (${user.mail || 'no mail'}) - not referenced`);
        } else {
          if (!quiet) {
            logger.info(`DELETING: ${user.dn} (${user.mail || 'no mail'})`);
          }
          try {
            await ldap.del(user.dn);
          } catch (err) {
            logger.error(`Failed to delete ${user.dn}: ${err}`);
          }
        }
      }
    }

    // Summary
    if (!quiet) {
      logger.info('');
      logger.info('=== CLEANUP SUMMARY ===');
      logger.info(`Total external users: ${externalUsers.length}`);
      logger.info(`Kept (still referenced): ${kept}`);
      logger.info(`${dryRun ? 'Would delete' : 'Deleted'}: ${toDelete}`);

      if (dryRun && toDelete > 0) {
        logger.info('');
        logger.info('Run without --dry-run to actually delete these users');
      }
    }

  } catch (err) {
    logger.error(`Error during cleanup: ${err}`);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
