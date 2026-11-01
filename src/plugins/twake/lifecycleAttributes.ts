/**
 * @module plugins/twake/lifecycleAttributes
 *
 * The attributes that carry an account's lifecycle (its role, its lock, its
 * deletion), read from the `--twake-lifecycle-*` options: the ones
 * `core/twake/lifecycleEvents` reads, and `core/twake/tombstone` writes.
 */
import type { Config } from '../../bin';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';
import { parseDirectoryDate } from '../../lib/utils';
import {
  DEFAULT_LOCK_ATTRIBUTE,
  holdsValue,
  resolveLockConfig,
} from '../scim/mapping';
import { scimOptionsOf } from '../scim/scim.options';

import { twakeLifecycleOptionsOf } from './twakeLifecycle.options';

export type DeletedAtFormat = 'iso8601' | 'generalizedTime';

export interface LifecycleAttributes {
  role: string;
  lock: string;
  lockValue: string;
  deleted: string;
  deletedValue: string;
  deletedAt: string;
  deletedAtFormat: DeletedAtFormat;
  reason: string;
}

export function lifecycleAttributes(config: Config): LifecycleAttributes {
  const settings = twakeLifecycleOptionsOf(config);
  const scimSettings = scimOptionsOf(config);
  const format = settings.twake_lifecycle_deleted_at_format;
  if (format !== 'iso8601' && format !== 'generalizedTime') {
    throw new Error(
      `--twake-lifecycle-deleted-at-format must be iso8601 or generalizedTime, got '${format}'`
    );
  }
  const own = settings.twake_lifecycle_lock_attribute.trim();
  const scim =
    scimSettings.scim_user_lock_attribute.trim() || DEFAULT_LOCK_ATTRIBUTE;
  // SCIM's value goes with SCIM's attribute only: nsAccountLock falling back
  // to the ppolicy value would never read as locked
  const lock = resolveLockConfig(
    own || scim,
    settings.twake_lifecycle_lock_value.trim() ||
      (!own || own.toLowerCase() === scim.toLowerCase()
        ? scimSettings.scim_user_lock_value
        : ''),
    {
      attribute: '--twake-lifecycle-lock-attribute',
      value: '--twake-lifecycle-lock-value',
    }
  );
  return {
    role: settings.twake_lifecycle_role_attribute,
    lock: lock.attribute,
    // The administrative lock only: a ppolicy lockout timestamp is not it
    lockValue: lock.value,
    deleted: settings.twake_lifecycle_deleted_attribute,
    deletedValue: settings.twake_lifecycle_deleted_value,
    deletedAt: settings.twake_lifecycle_deleted_at_attribute,
    deletedAtFormat: format,
    reason: settings.twake_lifecycle_reason_attribute,
  };
}

/** An attribute of an entry, whatever case the caller spelled its name in. */
export function valueOf<T>(
  entry: Record<string, T>,
  attribute: string
): T | undefined {
  if (!attribute) return undefined;
  if (attribute in entry) return entry[attribute];
  const lower = attribute.toLowerCase();
  for (const key of Object.keys(entry))
    if (key.toLowerCase() === lower) return entry[key];
  return undefined;
}

export function first(
  value: AttributeValue | null | undefined
): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  if (one === undefined || one === null) return undefined;
  const text = Buffer.isBuffer(one) ? one.toString() : String(one);
  return text === '' ? undefined : text;
}

export const isTombstone = (
  entry: AttributesList,
  attrs: LifecycleAttributes
): boolean => holdsValue(entry, attrs.deleted, attrs.deletedValue);

export const isLocked = (
  entry: AttributesList,
  attrs: LifecycleAttributes
): boolean => holdsValue(entry, attrs.lock, attrs.lockValue);

export function formatDeletedAt(date: Date, format: DeletedAtFormat): string {
  const iso = date.toISOString();
  return format === 'iso8601'
    ? iso
    : iso.replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * The shapes a deletion date is written in: an LDAP GeneralizedTime, whose
 * zone RFC 4517 requires — without one, a 10-digit Unix timestamp reads as a
 * year — or an ISO 8601 date, alone or with a time.
 */
const GENERALIZED_TIME =
  /^\d{10}(?:\d{2}(?:\d{2})?)?(?:[.,]\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Whether a year, month and day name a day that exists. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Date.UTC() reads a year below 100 as 19xx
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A deletion date as the directory holds it, or undefined if unreadable.
 *
 * Read by the same reader as every other directory time: the format only says
 * how this deployment writes the date, not how it is read.
 *
 * A value of another shape is refused here rather than handed to that
 * reader, whose fallback to `new Date()` reads `1` or `Jan 1` as a date: the
 * erase guard takes an unreadable date for a refusal. The same fallback rolls
 * `2025-02-31` over to March, where the shared reader refuses that day
 * spelled as a GeneralizedTime.
 */
export function parseDeletedAt(value: string): Date | undefined {
  const text = value.trim();
  const iso = ISO_8601.exec(text);
  if (iso) {
    if (!isCalendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3])))
      return undefined;
  } else if (!GENERALIZED_TIME.test(text)) return undefined;
  return parseDirectoryDate(text) ?? undefined;
}
