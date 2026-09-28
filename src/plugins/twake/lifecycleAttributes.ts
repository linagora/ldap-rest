/**
 * @module plugins/twake/lifecycleAttributes
 *
 * The attributes that carry an account's lifecycle (its role, its lock, its
 * deletion), read from the `--twake-lifecycle-*` options.
 */
import type { Config } from '../../bin';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';
import { DEFAULT_LOCK_ATTRIBUTE, resolveLockConfig } from '../scim/mapping';

export type DeletedAtFormat = 'iso8601' | 'generalizedTime';

export interface LifecycleAttributes {
  role: string;
  lock: string;
  lockValue: string;
  deleted: string;
  deletedValue: string;
  deletedAt: string;
  deletedAtFormat: DeletedAtFormat;
}

export function lifecycleAttributes(config: Config): LifecycleAttributes {
  const format = config.twake_lifecycle_deleted_at_format || 'iso8601';
  if (format !== 'iso8601' && format !== 'generalizedTime') {
    throw new Error(
      `--twake-lifecycle-deleted-at-format must be iso8601 or generalizedTime, got '${format}'`
    );
  }
  const own = config.twake_lifecycle_lock_attribute?.trim();
  const scim =
    config.scim_user_lock_attribute?.trim() || DEFAULT_LOCK_ATTRIBUTE;
  // SCIM's value goes with SCIM's attribute only: nsAccountLock falling back
  // to the ppolicy value would never read as locked
  const lock = resolveLockConfig(
    own || scim,
    config.twake_lifecycle_lock_value?.trim() ||
      (!own || own.toLowerCase() === scim.toLowerCase()
        ? config.scim_user_lock_value || ''
        : ''),
    {
      attribute: '--twake-lifecycle-lock-attribute',
      value: '--twake-lifecycle-lock-value',
    }
  );
  return {
    role: config.twake_lifecycle_role_attribute || '',
    lock: lock.attribute,
    // The administrative lock only: a ppolicy lockout timestamp is not it
    lockValue: lock.value,
    deleted: config.twake_lifecycle_deleted_attribute || '',
    deletedValue: config.twake_lifecycle_deleted_value || 'TRUE',
    deletedAt: config.twake_lifecycle_deleted_at_attribute || '',
    deletedAtFormat: format,
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

/** Case-insensitive, whatever the matching rule of the attribute. */
function holds(
  entry: AttributesList,
  attribute: string,
  wanted: string
): boolean {
  const value = valueOf(entry, attribute);
  if (value === undefined) return false;
  const lower = wanted.toLowerCase();
  return (Array.isArray(value) ? value : [value]).some(
    v => String(v).toLowerCase() === lower
  );
}

export const isTombstone = (
  entry: AttributesList,
  attrs: LifecycleAttributes
): boolean => holds(entry, attrs.deleted, attrs.deletedValue);

export const isLocked = (
  entry: AttributesList,
  attrs: LifecycleAttributes
): boolean => holds(entry, attrs.lock, attrs.lockValue);

/** A deletion date as the directory holds it, or undefined if unreadable. */
export function parseDeletedAt(
  value: string,
  format: DeletedAtFormat
): Date | undefined {
  if (format === 'iso8601') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:[.,](\d+))?Z$/.exec(
    value
  );
  if (!m) return undefined;
  return new Date(
    Date.UTC(
      +m[1],
      +m[2] - 1,
      +m[3],
      +m[4],
      +m[5],
      +(m[6] || 0),
      Math.round(+`0.${m[7] || 0}` * 1000)
    )
  );
}
