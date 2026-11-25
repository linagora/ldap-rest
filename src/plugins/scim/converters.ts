/**
 * Typed values of simple mapping entries (`converter` in a mapping file).
 *
 * LDAP holds every value as text in the syntax of its attribute: a Boolean
 * is `TRUE`/`FALSE` (RFC 4517 §3.3.3), a time a GeneralizedTime (§3.3.13).
 * SCIM carries JSON `true`, numbers and `xsd:dateTime` strings (RFC 7643
 * §2.3). A converter turns one into the other on write, on read and in
 * filters, so that a directory refusing `true` for a Boolean attribute, or
 * a client expecting a JSON boolean, both get the form they take.
 */
import { parseDirectoryDate } from '../../lib/utils.js';

import { scimInvalidFilter, scimInvalidValue } from './errors.js';
import type { MappingEntry, ResourceMapping } from './types.js';

export type Converter = NonNullable<MappingEntry['converter']>;

export const CONVERTERS: readonly Converter[] = [
  'string',
  'boolean',
  'number',
  'date',
];

/** Refuse a mapping naming a converter this server does not have */
export function assertConverters(mapping: ResourceMapping): void {
  for (const e of mapping.entries) {
    if (e.converter === undefined) continue;
    if (!CONVERTERS.includes(e.converter))
      throw new Error(
        `Unknown converter '${String(e.converter)}' on SCIM attribute '${e.scim}' (expected one of ${CONVERTERS.join(', ')})`
      );
  }
}

/**
 * The converter of a SCIM path, when it names a simple entry (`ldap`, no
 * `sub`, no primary/secondary) that declares one.
 */
export function converterFor(
  path: string,
  mapping: ResourceMapping
): Converter | undefined {
  if (typeof path !== 'string' || path.includes('.')) return undefined;
  const m = mapping.entries.find(e => e.scim === path);
  if (!m || !m.ldap || m.sub || m.ldapPrimary || m.ldapSecondary)
    return undefined;
  return m.converter === 'string' ? undefined : m.converter;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** A Date as the GeneralizedTime the directory stores, in UTC */
function generalizedTime(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    (ms ? `.${pad(ms, 3).replace(/0+$/, '')}` : '') +
    'Z'
  );
}

/**
 * An `xsd:dateTime` with its zone: seconds are required, a fraction is kept
 * down to the millisecond, and a bare date is refused.
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * An `xsd:dateTime` read as a Date, when its fields name a real instant:
 * `2024-02-30` or `T24:00:00` would otherwise roll over to another day.
 */
function parseDateTime(value: string): Date | undefined {
  const m = ISO_DATE_TIME.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  wall.setUTCFullYear(y); // Date.UTC reads years 0 to 99 as 1900 to 1999
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== sec
  )
    return undefined;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59))
    return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/** An integer as decimal text, without prefix, fraction nor exponent */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * A SCIM value as the directory stores it. `error` builds the refusal, so a
 * filter answers `invalidFilter` where a body answers `invalidValue`.
 */
export function toLdap(
  value: unknown,
  converter: Converter | undefined,
  attribute: string,
  error: (detail: string) => Error = scimInvalidValue
): string {
  if (!converter || converter === 'string') return String(value);
  switch (converter) {
    case 'boolean': {
      const text = typeof value === 'string' ? value.toLowerCase() : value;
      if (text === true || text === 'true') return 'TRUE';
      if (text === false || text === 'false') return 'FALSE';
      throw error(`${attribute} must be a boolean, got ${String(value)}`);
    }
    case 'number': {
      // The directory's INTEGER syntax takes no fraction nor exponent, and
      // Number() would read `0x10` or `0b101` as one
      const n =
        typeof value === 'string' && DECIMAL_INTEGER.test(value.trim())
          ? Number(value)
          : value;
      if (typeof n === 'number' && Number.isSafeInteger(n)) return String(n);
      throw error(`${attribute} must be an integer, got ${String(value)}`);
    }
    case 'date': {
      const d = typeof value === 'string' ? parseDateTime(value) : undefined;
      if (d) return generalizedTime(d);
      throw error(
        `${attribute} must be an xsd:dateTime (2024-01-31T12:00:00Z), got ${String(value)}`
      );
    }
  }
}

/** Every value of a write, converted */
export function valuesToLdap(
  values: string | string[],
  converter: Converter | undefined,
  attribute: string
): string | string[] {
  if (!converter || converter === 'string') return values;
  return Array.isArray(values)
    ? values.map(v => toLdap(v, converter, attribute))
    : toLdap(values, converter, attribute);
}

/** A filter value converted, refused with `invalidFilter` */
export function filterValueToLdap(
  value: string | number | boolean,
  converter: Converter | undefined,
  attribute: string
): string {
  return toLdap(value, converter, attribute, scimInvalidFilter);
}

/**
 * A directory value as SCIM carries it. A value the converter cannot read
 * is answered as the directory holds it rather than dropped.
 */
export function fromLdap(
  value: string,
  converter: Converter | undefined
): string | number | boolean {
  if (!converter || converter === 'string') return value;
  switch (converter) {
    case 'boolean': {
      const upper = value.toUpperCase();
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      return value;
    }
    case 'number': {
      // Beyond 2^53 a JSON number would be rounded, and a client could not
      // write back what it read: the text is kept
      const n = DECIMAL_INTEGER.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(n) ? n : value;
    }
    case 'date': {
      const d = parseDirectoryDate(value);
      return d ? d.toISOString().replace(/\.000Z$/, 'Z') : value;
    }
  }
}
