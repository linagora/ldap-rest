/**
 * Helpers shared by the code that has to know what an LDAP filter tests.
 * @module lib/ldapFilter
 */

/**
 * The attribute names a parsed filter tests, at any depth. An extensible
 * match carries its attribute in `matchType`.
 *
 * @param filter filter tree returned by `FilterParser.parseString`
 * @returns attribute descriptions, in no particular order
 */
export function filterAttributeNames(filter: unknown): string[] {
  const names: string[] = [];
  const stack: unknown[] = [];
  const seen = new Set<unknown>();
  if (filter) stack.push(filter);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.attribute === 'string') names.push(record.attribute);
    if (typeof record.matchType === 'string') names.push(record.matchType);
    if (Array.isArray(record.filters))
      stack.push(...(record.filters as unknown[]));
    if (record.filter) stack.push(record.filter);
  }
  return names;
}

/**
 * An attribute description as LDAP compares it: no `oid.` prefix, no options.
 *
 * @param name attribute description from a filter
 * @returns its lowercased base name
 */
export function filterAttributeKey(name: string): string {
  return name
    .replace(/^oid\./i, '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}
