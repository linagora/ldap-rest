/**
 * @module plugins/twake/lifecycleAttributes
 *
 * The attributes that carry an account's lifecycle, shared by the plugins
 * that write it and the ones that publish it, so both read one configuration.
 */
import type { Config } from '../../bin';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';

export type DeletedAtFormat = 'iso8601' | 'generalizedTime';

export interface LifecycleAttributes {
  role: string;
  lock: string;
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
  return {
    role: config.twake_lifecycle_role_attribute || '',
    lock:
      config.twake_lifecycle_lock_attribute ||
      config.scim_user_lock_attribute ||
      'pwdAccountLockedTime',
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

/** Whether a value holds the deleted value; `TRUE` and `true` are one boolean. */
export function holdsDeleted(
  value: AttributeValue | null | undefined,
  attrs: LifecycleAttributes
): boolean {
  if (!attrs.deleted || value === undefined || value === null) return false;
  const values = Array.isArray(value) ? value : [value];
  const wanted = attrs.deletedValue.toLowerCase();
  return values.some(v => String(v).toLowerCase() === wanted);
}

export function isTombstone(
  entry: AttributesList,
  attrs: LifecycleAttributes
): boolean {
  return holdsDeleted(valueOf(entry, attrs.deleted), attrs);
}

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
