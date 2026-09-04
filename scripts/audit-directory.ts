#!/usr/bin/env tsx
/**
 * Audit a live directory against an entity schema.
 *
 * Tightening a validation pattern changes what the server accepts *from now
 * on*; it says nothing about the entries already stored. A directory whose
 * addresses were never anchored, or whose organization names predate the rule
 * that now governs them, will load fine and then refuse the first update of
 * every offending entry — which is discovered one support ticket at a time.
 *
 * This reads the entries as they are and reports what the schema would refuse,
 * so the work is known before the switch rather than after it.
 *
 * Usage:
 *
 * ```sh
 * npm run audit:directory -- \
 *   --schema static/schemas/example/users.json \
 *   --base ou=users,dc=example,dc=org
 * ```
 *
 * The directory is read with the same `DM_LDAP_*` environment variables the
 * server uses. Exits non-zero when anything was refused, so a migration
 * pipeline can gate on it.
 */

import fs from 'fs';

import { Client } from 'ldapts';

import type { Schema, SchemaAttribute } from '../src/config/schema';

interface Options {
  schema: string;
  base?: string;
  url: string;
  bindDn: string;
  bindPassword: string;
  filter: string;
  /** Offending entries listed per attribute before the report stops naming them */
  samples: number;
}

/** One attribute's worth of findings. */
export interface Finding {
  attribute: string;
  reason: string;
  hint?: string;
  count: number;
  samples: { dn: string; value: string }[];
}

/**
 * Read the command line, falling back to the server's own environment
 * variables for the connection.
 *
 * @param argv arguments, without the interpreter and script name
 * @returns the options
 * @throws Error when a required option is missing
 */
export function parseOptions(argv: string[]): Options {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = argv[++i] ?? '';
  }

  const schema = flags.schema;
  if (!schema) throw new Error('--schema <file> is required');

  const url = flags.url || process.env.DM_LDAP_URL || process.env.DM_LDAP_URI;
  if (!url) throw new Error('--url or DM_LDAP_URL is required');

  return {
    schema,
    base: flags.base,
    url: url.split(/[ ,]/)[0],
    bindDn: flags['bind-dn'] || process.env.DM_LDAP_DN || '',
    bindPassword: flags['bind-password'] || process.env.DM_LDAP_PWD || '',
    filter: flags.filter || '(objectClass=*)',
    samples: Number(flags.samples || 5),
  };
}

/**
 * Substitute the `__ldap_base__` placeholders a schema carries, the way the
 * server does when it loads one.
 *
 * @param text schema file content
 * @param base directory suffix
 * @returns the resolved content
 */
export function resolvePlaceholders(
  text: string,
  config: Record<string, string | undefined>
): string {
  return text.replace(/__(\S+)__/g, (match, key: string) => {
    const value = config[key.trim().toLowerCase()];
    return value ? value : match;
  });
}

/**
 * The configuration a schema may name, as the server assembles it: every
 * `DM_*` variable under its lowercased name, `--base` overriding `ldap_base`.
 *
 * The server resolves any `__KEY__` the configuration holds and leaves the
 * literal when it holds none. Resolving only `ldap_base`, and resolving it to
 * an empty string when it is unset, made every other placeholder audit
 * against its own literal text and reported the whole branch as malformed.
 *
 * @param base value of `--base`, when given
 * @returns the keys a schema may name, lowercased
 */
export function schemaConfig(base?: string): Record<string, string> {
  const config: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (name.startsWith('DM_') && value)
      config[name.slice(3).toLowerCase()] = value;
  if (base) config.ldap_base = base;
  return config;
}

/**
 * Attribute values, always as a list of strings.
 *
 * A value the directory stores as binary — a certificate, a photo — is not
 * text and decoding it would report every entry as failing a pattern the
 * server never applies to it either. Such a value is dropped rather than
 * mangled: a `Buffer` that does not survive a round trip through UTF-8 is not
 * a string that was written, it is bytes that were.
 *
 * @param value value as the directory returned it
 * @returns the values that can be read as text
 */
function valueList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (!Buffer.isBuffer(item)) {
      out.push(String(item));
      continue;
    }
    const text = item.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(item)) out.push(text);
  }
  return out;
}

/**
 * Check one entry against the schema and collect what it would be refused for.
 *
 * Only the rules that can be answered from the entry itself are checked:
 * patterns, required attributes and the branch a pointer must land in. A
 * uniqueness or cross-entry rule needs the whole directory and belongs to a
 * dry run of the server, not here.
 *
 * @param dn entry being checked
 * @param entry its attributes
 * @param schema schema to check against
 * @param report findings so far, updated in place
 * @param sampleLimit offending entries to keep per finding
 */
export function auditEntry(
  dn: string,
  entry: Record<string, unknown>,
  schema: Schema,
  report: Map<string, Finding>,
  sampleLimit = 100
): void {
  // LDAP attribute names are case-insensitive (RFC 4512) and a directory
  // answers with the case it was written in, which is not always the schema's.
  // Read straight off the entry, `MAIL` was simply not audited.
  const byName = new Map<string, unknown>();
  for (const [key, entryValue] of Object.entries(entry))
    byName.set(key.toLowerCase(), entryValue);
  const add = (
    attribute: string,
    reason: string,
    value: string,
    definition?: SchemaAttribute
  ): void => {
    // A separator no attribute name and no reason can hold. Written as an
    // escape: the byte itself in the source makes git call this file binary,
    // and a source file with no diff and no blame is worse than a long key.
    const key = `${attribute}\u0000${reason}`;
    let finding = report.get(key);
    if (!finding) {
      finding = {
        attribute,
        reason,
        hint: definition?.hint || definition?.items?.hint,
        count: 0,
        samples: [],
      };
      report.set(key, finding);
    }
    finding.count++;
    if (finding.samples.length < sampleLimit)
      finding.samples.push({ dn, value });
  };

  for (const [name, definition] of Object.entries(schema.attributes)) {
    if (name === 'objectClass') continue;
    const values = valueList(byName.get(name.toLowerCase()));

    if (definition.required && values.length === 0 && !definition.generated) {
      add(name, 'missing', '', definition);
      continue;
    }

    const pattern = definition.test || definition.items?.test;
    if (pattern) {
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(String(pattern));
      } catch {
        add(name, `unusable pattern ${String(pattern)}`, '', definition);
      }
      if (regex)
        for (const value of values)
          if (!regex.test(value))
            add(name, 'does not match', value, definition);
    }

    const branches =
      definition.type === 'pointer'
        ? definition.branch
        : definition.items?.branch;
    if (branches?.length)
      for (const value of values)
        if (
          !branches.some(branch =>
            value.toLowerCase().endsWith(branch.toLowerCase())
          )
        )
          add(name, 'outside the allowed branch', value, definition);
  }
}

/**
 * Print the report.
 *
 * @param findings what the audit collected
 * @param total entries read
 * @param samples offending entries to name per finding
 * @returns true when the directory is clean
 */
export function printReport(
  findings: Finding[],
  total: number,
  samples: number
): boolean {
  if (findings.length === 0) {
    process.stdout.write(
      `${total} entries read: every one satisfies the schema\n`
    );
    return true;
  }

  const affected = findings.reduce((sum, finding) => sum + finding.count, 0);
  process.stdout.write(
    `${total} entries read, ${affected} value(s) the schema would refuse:\n\n`
  );
  for (const finding of findings.sort((a, b) => b.count - a.count)) {
    process.stdout.write(
      `  ${finding.attribute}: ${finding.reason} — ${finding.count}\n`
    );
    if (finding.hint) process.stdout.write(`    expected: ${finding.hint}\n`);
    for (const sample of finding.samples.slice(0, samples))
      process.stdout.write(
        `    ${sample.dn}${sample.value ? ` → ${JSON.stringify(sample.value)}` : ''}\n`
      );
    if (finding.count > samples)
      process.stdout.write(`    … and ${finding.count - samples} more\n`);
    process.stdout.write('\n');
  }
  return false;
}

/**
 * Read the branch and report.
 *
 * @param options what to audit and where
 * @returns true when the directory is clean
 */
export async function audit(options: Options): Promise<boolean> {
  const raw = fs.readFileSync(options.schema, 'utf8');
  const config = schemaConfig(options.base);
  const suffix = config.ldap_base || '';
  const schema = JSON.parse(resolvePlaceholders(raw, config)) as Schema & {
    entity?: { base?: string };
  };

  const client = new Client({ url: options.url });
  await client.bind(options.bindDn, options.bindPassword);
  try {
    // `entity.base` names configuration keys the way `flatGeneric` reads them:
    // any `{config_key}`, not `{ldap_base}` alone.
    const declared = schema.entity?.base?.replace(
      /\{([^}]+)\}/g,
      (match, key: string) => config[key.trim().toLowerCase()] ?? match
    );
    const base = options.base || declared || suffix;
    if (!base)
      throw new Error(
        '--base is required when the schema declares no entity base'
      );

    const report = new Map<string, Finding>();
    let total = 0;
    const { searchEntries } = await client.search(base, {
      scope: 'sub',
      filter: options.filter,
      paged: { pageSize: 500 },
    });
    for (const entry of searchEntries) {
      // The base of the branch is not an entry of the entity.
      if (String(entry.dn).toLowerCase() === base.toLowerCase()) continue;
      total++;
      auditEntry(String(entry.dn), entry, schema, report, options.samples);
    }
    return printReport([...report.values()], total, options.samples);
  } finally {
    await client.unbind();
  }
}

/* c8 ignore start -- entry point, exercised by running the script */
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('audit-directory.ts');
if (invokedDirectly) {
  audit(parseOptions(process.argv.slice(2)))
    .then(clean => {
      process.exitCode = clean ? 0 : 1;
    })
    .catch((err: Error) => {
      process.stderr.write(`audit-directory: ${err.message}\n`);
      process.exitCode = 2;
    });
}
/* c8 ignore stop */
