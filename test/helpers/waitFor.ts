/**
 * Wait for a condition instead of guessing how long it takes.
 * @module test/helpers/waitFor
 */

import type { DM } from '../../src/bin';

/**
 * Poll a condition until it holds.
 *
 * Plugins react to LDAP changes through hooks that run after the operation
 * returns, so a test has to wait for the effect. A fixed `setTimeout` encodes
 * the speed of the machine that wrote it: the value passes locally, then fails
 * on a loaded CI runner or under coverage instrumentation, and the failure
 * looks like a bug in the code rather than in the wait.
 *
 * @param condition checked repeatedly; the wait ends when it returns true
 * @param options how long to wait overall, and how often to check
 * @param options.timeout milliseconds before giving up (default 5000)
 * @param options.interval milliseconds between checks (default 25)
 * @param options.what named in the error, to say what never happened
 * @throws Error when the condition never holds within the timeout
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  options: { timeout?: number; interval?: number; what?: string } = {}
): Promise<void> {
  const { timeout = 5000, interval = 25, what = 'condition' } = options;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/**
 * Wait until an LDAP entry exists.
 *
 * @param dm server whose connection is used
 * @param dn entry to wait for
 * @param timeout milliseconds before giving up
 */
export async function waitForEntry(
  dm: DM,
  dn: string,
  timeout = 5000
): Promise<void> {
  await waitFor(() => entryExists(dm, dn), { timeout, what: `${dn} to exist` });
}

/**
 * Wait until an LDAP entry is gone.
 *
 * @param dm server whose connection is used
 * @param dn entry to wait for the disappearance of
 * @param timeout milliseconds before giving up
 */
export async function waitForNoEntry(
  dm: DM,
  dn: string,
  timeout = 5000
): Promise<void> {
  await waitFor(async () => !(await entryExists(dm, dn)), {
    timeout,
    what: `${dn} to be deleted`,
  });
}

/**
 * Tell whether an entry is readable.
 *
 * @param dm server whose connection is used
 * @param dn entry to look up
 * @returns true when the entry exists
 */
async function entryExists(dm: DM, dn: string): Promise<boolean> {
  try {
    const result = await dm.ldap.search({ scope: 'base', paged: false }, dn);
    return 'searchEntries' in result && result.searchEntries.length > 0;
  } catch {
    // NoSuchObject, and any other read failure: not there yet
    return false;
  }
}
