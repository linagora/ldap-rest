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
 * A deletion date as the directory holds it, or undefined if unreadable.
 *
 * Read by the same reader as every other directory time: the format only says
 * how this deployment writes the date, not how it is read.
 */
export function parseDeletedAt(value: string): Date | undefined {
  return parseDirectoryDate(value) ?? undefined;
}
