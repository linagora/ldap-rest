/**
 * Fail on a high or critical advisory in a production dependency.
 *
 * An allowlist entry names the package npm reports the advisory under, or
 * any of the ids the advisory carries (a GHSA or CVE id), and `until`, the
 * last day (UTC) it applies. An entry past that day, one without a day, and
 * one matching no advisory fail the build as well: none is a decision
 * anyone can rely on. See `CONTRIBUTING.md#dependencies`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const allowlistPath = path.resolve(
  __dirname,
  '..',
  '.github',
  'audit-allowlist.json'
);

const BLOCKING = ['high', 'critical'];

export type Severity =
  | 'info'
  | 'low'
  | 'moderate'
  | 'high'
  | 'critical'
  | 'unknown';

export interface Advisory {
  /** The package npm reports the advisory under */
  name: string;
  severity: Severity;
  /** Its title and the ids npm gives it */
  ids: string[];
}

export interface AllowlistEntry {
  /** A package name, or a GHSA or CVE id */
  id: string;
  /** Last day the entry applies, `YYYY-MM-DD` */
  until: string;
  /** Why the advisory does not apply to this server */
  reason: string;
}

const isSeverity = (value: unknown): value is Severity =>
  ['info', 'low', 'moderate', 'high', 'critical', 'unknown'].includes(
    value as string
  );

/** The advisories npm reports, from its `audit --json` report */
export const advisories = (report: unknown): Advisory[] => {
  const vulnerabilities = (
    report as {
      vulnerabilities?: Record<string, { severity?: unknown; via?: unknown }>;
    }
  ).vulnerabilities;
  if (!vulnerabilities) throw new Error('not an npm audit report');

  return Object.entries(vulnerabilities).map(([name, entry]) => {
    const ids = new Set<string>();
    for (const source of Array.isArray(entry.via) ? entry.via : []) {
      // A string is the name of a vulnerable package the advisory comes
      // through; the advisory is reported on that package too
      if (typeof source !== 'object' || source === null) continue;
      const { title, url } = source as { title?: unknown; url?: unknown };
      if (typeof title === 'string') ids.add(title);
      if (typeof url === 'string') {
        const id = url.split('/').pop();
        if (id) ids.add(id);
      }
    }
    return {
      name,
      severity: isSeverity(entry.severity) ? entry.severity : 'unknown',
      ids: [...ids],
    };
  });
};

const covers = (entry: AllowlistEntry, advisory: Advisory): boolean =>
  entry.id === advisory.name || advisory.ids.includes(entry.id);

const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/**
 * What stops the build, and the allowlist entries to clean up: high or
 * critical advisories in a production dependency that no entry valid on
 * `today` covers, entries past their date, entries matching no advisory.
 */
export const gate = (
  list: Advisory[],
  allowlist: AllowlistEntry[],
  today: Date
): {
  blocked: Advisory[];
  expired: AllowlistEntry[];
  unused: AllowlistEntry[];
  invalid: AllowlistEntry[];
} => {
  const day = today.toISOString().slice(0, 10);
  const invalid = allowlist.filter(entry => !isDay(entry.until));
  const valid = allowlist.filter(entry => isDay(entry.until));
  const current = valid.filter(entry => entry.until >= day);
  const expired = valid.filter(entry => entry.until < day);
  const unused = current.filter(
    entry => !list.some(advisory => covers(entry, advisory))
  );
  return {
    blocked: list.filter(
      advisory =>
        BLOCKING.includes(advisory.severity) &&
        !current.some(entry => covers(entry, advisory))
    ),
    expired,
    unused,
    invalid,
  };
};

const describe = (advisory: Advisory): string =>
  [advisory.name, ...advisory.ids].join(' ');

const run = (): void => {
  let out: string;
  try {
    out = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // npm exits non-zero when it finds an advisory, and its report is the
    // answer then; any other failure left nothing to read
    out = (err as { stdout?: string }).stdout ?? '';
    if (!out.trim()) throw err;
  }

  let report: unknown;
  try {
    report = JSON.parse(out);
  } catch {
    throw new Error(`npm audit did not answer a report: ${out.slice(0, 200)}`);
  }
  // npm answers a failure, a registry it cannot reach among them, in the
  // same JSON, without a report to read
  const failure = report as { error?: { summary?: string }; message?: string };
  // The reason, a registry that does not answer among them, is in `message`:
  // `error.summary` is empty for one
  if (failure.error || failure.message)
    throw new Error(
      `npm audit failed: ${failure.message || failure.error?.summary || 'no reason given'}`
    );
  if ((report as { auditReportVersion?: unknown }).auditReportVersion !== 2)
    throw new Error('unexpected npm audit report version');

  const allowlist: AllowlistEntry[] = fs.existsSync(allowlistPath)
    ? (JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as AllowlistEntry[])
    : [];
  const { blocked, expired, unused, invalid } = gate(
    advisories(report),
    allowlist,
    new Date()
  );

  for (const entry of invalid)
    console.error(`allowlist: ${entry.id} has no "until" day (YYYY-MM-DD)`);
  for (const entry of expired)
    console.error(
      `allowlist: ${entry.id} (${entry.reason}) expired on ${entry.until}`
    );
  for (const entry of unused)
    console.error(`allowlist: ${entry.id} matches no advisory, remove it`);
  if (invalid.length + expired.length + unused.length > 0) process.exit(1);

  if (blocked.length === 0) {
    console.log('No blocking advisory in the production dependencies.');
    return;
  }
  for (const advisory of blocked)
    console.error(`${advisory.severity}: ${describe(advisory)}`);
  console.error(
    `${blocked.length} blocking advisory(ies): fix them, or add an entry to` +
      ' .github/audit-allowlist.json naming one of the ids above and the date' +
      ' it is to be revisited'
  );
  process.exit(1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
