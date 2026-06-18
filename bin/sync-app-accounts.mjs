#!/usr/bin/env node
/**
 * Sync utility to verify and fix consistency between users and applicative accounts
 * Ensures principal accounts exist for all users with mail
 * Removes orphaned applicative accounts
 * @author Generated with Claude Code
 */

import { DM } from '../dist/bin/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const dryRun = args.includes('--dry-run') || args.includes('-n');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: sync-app-accounts [options]

Synchronizes applicative accounts with LDAP users.
Ensures consistency between ou=users and ou=applicative branches.

Operations performed:
  1. Create missing principal accounts (uid=mail) for users with mail
  2. Delete orphaned applicative accounts (user_cXXXXXXXX without parent user)
  3. Delete orphaned principal accounts (uid=mail without matching user)

Options:
  --quiet, -q      Only show summary and errors
  --dry-run, -n    Show what would be changed without making changes
  --help, -h       Show this help message

Environment variables:
  DM_LDAP_BASE                    LDAP search base (required)
  DM_APPLICATIVE_ACCOUNT_BASE     Applicative accounts base (required)
  DM_MAIL_ATTRIBUTE               Mail attribute name (default: mail)
`);
  process.exit(0);
}

// A base-scoped LDAP search on a non-existent entry returns noSuchObject (32)
// rather than an empty result set, so callers must treat it as "absent".
const isNoSuchObject = err =>
  err?.code === 32 || /no such object|0x20/i.test(err?.message || '');

async function syncAppAccounts() {
  const dm = new DM();
  await dm.ready;

  const mailAttr = dm.config.mail_attribute || 'mail';
  const applicativeBase = dm.config.applicative_account_base;
  const userBase = dm.config.ldap_base;

  if (!applicativeBase) {
    dm.logger.error('DM_APPLICATIVE_ACCOUNT_BASE is not configured');
    process.exit(1);
  }

  if (!userBase) {
    dm.logger.error('DM_LDAP_BASE is not configured');
    process.exit(1);
  }

  // Fail fast with a clear message if the applicative branch is missing,
  // instead of letting the orphan scan abort with a raw NoSuchObjectError.
  try {
    await dm.ldap.search({ scope: 'base', paged: false }, applicativeBase);
  } catch (err) {
    if (isNoSuchObject(err)) {
      dm.logger.error(
        `Applicative base ${applicativeBase} does not exist. Create it first (e.g. an organizationalUnit entry) before running this sync.`
      );
      process.exit(1);
    }
    throw err;
  }

  if (!quiet) {
    dm.logger.info('Starting applicative accounts synchronization...');
    dm.logger.info(`User base: ${userBase}`);
    dm.logger.info(`Applicative base: ${applicativeBase}`);
    if (dryRun) {
      dm.logger.info('DRY RUN MODE: No changes will be made');
    }
    dm.logger.info('');
  }

  let principalCreated = 0;
  let appAccountsDeleted = 0;
  let principalDeleted = 0;
  let errors = 0;

  try {
    // Step 1: Check users and create missing principal accounts
    if (!quiet) {
      dm.logger.info(
        'Step 1: Checking users and creating missing principal accounts...'
      );
    }

    const usersResult = await dm.ldap.search(
      {
        paged: false,
        filter: `(${mailAttr}=*)`,
        attributes: [mailAttr, 'uid', 'cn', 'sn', 'givenName', 'displayName'],
      },
      userBase
    );

    const users = usersResult.searchEntries || [];
    if (!quiet) {
      dm.logger.info(`Found ${users.length} users with mail attribute`);
    }

    for (const user of users) {
      const mail = Array.isArray(user[mailAttr])
        ? String(user[mailAttr][0])
        : String(user[mailAttr]);

      if (!mail) continue;

      try {
        // Check if principal account exists. A base search on a missing entry
        // throws noSuchObject rather than returning an empty set, so we treat
        // that exception as "absent" and fall through to creation.
        const principalDn = `uid=${mail},${applicativeBase}`;
        let principalResult;
        try {
          principalResult = await dm.ldap.search(
            {
              scope: 'base',
              paged: false,
            },
            principalDn
          );
        } catch (err) {
          if (isNoSuchObject(err)) {
            principalResult = { searchEntries: [] };
          } else {
            throw err;
          }
        }

        if (
          !principalResult.searchEntries ||
          principalResult.searchEntries.length === 0
        ) {
          dm.logger.warn(`Missing principal account for ${mail}`);

          if (dryRun) {
            dm.logger.info(`  Would create: ${principalDn}`);
            principalCreated++;
          } else {
            // Create principal account
            const attrs = {
              objectClass: ['inetOrgPerson'],
              uid: mail,
            };

            // Copy attributes
            const attrsToCopy = [
              'cn',
              'sn',
              'givenName',
              mailAttr,
              'displayName',
            ];
            for (const attr of attrsToCopy) {
              const value = user[attr];
              // Skip absent values. A requested-but-missing attribute comes
              // back as an empty array (truthy in JS), which would otherwise
              // produce an `add` with no values → ProtocolError "no values for
              // attribute type".
              if (value === undefined || value === null || value === '') {
                continue;
              }
              if (Array.isArray(value)) {
                if (value.length === 0) continue;
                attrs[attr] = value.map(v =>
                  Buffer.isBuffer(v) ? v.toString() : String(v)
                );
              } else {
                attrs[attr] = Buffer.isBuffer(value)
                  ? value.toString()
                  : String(value);
              }
            }

            await dm.ldap.add(principalDn, attrs);
            dm.logger.info(`  Created: ${principalDn}`);
            principalCreated++;
          }
        }
      } catch (err) {
        dm.logger.error(`Error processing user ${mail}: ${err.message}`);
        errors++;
      }
    }

    // Step 2: Check applicative accounts and delete orphans
    if (!quiet) {
      dm.logger.info('\nStep 2: Checking applicative accounts for orphans...');
    }

    const appAccountsResult = await dm.ldap.search(
      {
        paged: false,
        filter: '(uid=*)',
      },
      applicativeBase
    );

    const appAccounts = appAccountsResult.searchEntries || [];
    if (!quiet) {
      dm.logger.info(`Found ${appAccounts.length} entries in applicative base`);
    }

    // Build user map for quick lookup
    const userMap = new Map();
    const mailMap = new Map();
    for (const user of users) {
      const uid = Array.isArray(user.uid)
        ? String(user.uid[0])
        : String(user.uid);
      const mail = Array.isArray(user[mailAttr])
        ? String(user[mailAttr][0])
        : String(user[mailAttr]);
      userMap.set(uid, true);
      if (mail) mailMap.set(mail, true);
    }

    for (const account of appAccounts) {
      const uid = Array.isArray(account.uid)
        ? String(account.uid[0])
        : String(account.uid);
      const dn = account.dn;

      try {
        // Check if it's an applicative account (format: username_cXXXXXXXX)
        if (uid.includes('_c')) {
          const username = uid.split('_')[0];

          if (!userMap.has(username)) {
            dm.logger.warn(
              `Orphaned applicative account: ${uid} (user ${username} not found)`
            );

            if (dryRun) {
              dm.logger.info(`  Would delete: ${dn}`);
              appAccountsDeleted++;
            } else {
              await dm.ldap.delete(dn);
              dm.logger.info(`  Deleted: ${dn}`);
              appAccountsDeleted++;
            }
          }
        } else {
          // Principal account (uid=mail) - check if mail exists in users
          const mail = uid;

          if (!mailMap.has(mail)) {
            dm.logger.warn(
              `Orphaned principal account: ${mail} (no user with this mail)`
            );

            if (dryRun) {
              dm.logger.info(`  Would delete: ${dn}`);
              principalDeleted++;
            } else {
              await dm.ldap.delete(dn);
              dm.logger.info(`  Deleted: ${dn}`);
              principalDeleted++;
            }
          }
        }
      } catch (err) {
        dm.logger.error(`Error processing account ${uid}: ${err.message}`);
        errors++;
      }
    }

    // Summary
    dm.logger.info('\n' + '='.repeat(60));
    dm.logger.info('Synchronization summary:');
    dm.logger.info(
      `  Principal accounts ${dryRun ? 'to create' : 'created'}: ${principalCreated}`
    );
    dm.logger.info(
      `  Applicative accounts ${dryRun ? 'to delete' : 'deleted'}: ${appAccountsDeleted}`
    );
    dm.logger.info(
      `  Principal accounts ${dryRun ? 'to delete' : 'deleted'}: ${principalDeleted}`
    );
    dm.logger.info(`  Errors: ${errors}`);
    dm.logger.info('='.repeat(60));

    if (errors > 0) {
      process.exit(1);
    }
  } catch (err) {
    dm.logger.error('Error during synchronization:', err);
    process.exit(1);
  } finally {
    // ldapActions exposes no public unbind; pooled connections are released on
    // process exit. Guard so this teardown never throws if the method is absent.
    if (typeof dm.ldap.unbind === 'function') {
      await dm.ldap.unbind();
    }
  }
}

// Run the sync. Pooled LDAP connections keep the event loop alive, so exit
// explicitly once the sync resolves instead of hanging.
syncAppAccounts()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
