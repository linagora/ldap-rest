/**
 * Schema utility functions
 * @module browser/shared/utils/schema
 */

import type { PointerOption } from '../types';

/**
 * Cache for pointer options to avoid repeated API calls
 */
const pointerOptionsCache = new Map<string, PointerOption[]>();

/**
 * Load pointer options from API
 */
export async function loadPointerOptions(
  branch: string,
  apiLoader: (branch: string) => Promise<PointerOption[]>,
  useCache = true
): Promise<PointerOption[]> {
  if (useCache && pointerOptionsCache.has(branch)) {
    return pointerOptionsCache.get(branch)!;
  }

  try {
    const options = await apiLoader(branch);
    if (useCache) {
      pointerOptionsCache.set(branch, options);
    }
    return options;
  } catch (error) {
    console.error('Failed to load pointer options for branch:', branch, error);
    return [];
  }
}

/**
 * Clear pointer options cache
 */
export function clearPointerOptionsCache(): void {
  pointerOptionsCache.clear();
}

/**
 * Replace placeholders in schema branches
 */
export function replacePlaceholders(
  value: string | string[],
  replacements: Record<string, string>
): string | string[] {
  const replace = (str: string): string => {
    let result = str;
    for (const [key, val] of Object.entries(replacements)) {
      result = result.replace(new RegExp(key, 'g'), val);
    }
    return result;
  };

  if (Array.isArray(value)) {
    return value.map(replace);
  }
  return replace(value);
}

/**
 * Replace placeholders in schema attributes
 */
export function replaceSchemaPlaceholders<T extends Record<string, unknown>>(
  schema: T,
  replacements: Record<string, string>
): T {
  const processValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return replacePlaceholders(value, replacements);
    }
    if (Array.isArray(value)) {
      return value.map(processValue);
    }
    if (value && typeof value === 'object') {
      return processObject(value as Record<string, unknown>);
    }
    return value;
  };

  const processObject = (obj: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = processValue(value);
    }
    return result;
  };

  return processObject(schema) as T;
}

/**
 * Fetch organization path from API
 */
export async function getOrganizationPath(
  orgDn: string,
  apiBaseUrl: string
): Promise<string> {
  try {
    const response = await fetch(
      `${apiBaseUrl}/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`
    );
    if (!response.ok) {
      console.error('Failed to fetch organization:', response.status);
      return orgDn;
    }
    const org = await response.json();

    // Use twakeDepartmentPath if available (Twake schema)
    if (org.twakeDepartmentPath) {
      const pathValue = Array.isArray(org.twakeDepartmentPath)
        ? org.twakeDepartmentPath[0]
        : org.twakeDepartmentPath;
      return pathValue;
    }

    // Fallback to ou name for non-Twake schemas
    if (org.ou) {
      const ouValue = Array.isArray(org.ou) ? org.ou[0] : org.ou;
      return ouValue;
    }

    // Last resort: use DN
    return orgDn;
  } catch (error) {
    console.error('Failed to get organization info:', error);
    return orgDn;
  }
}

/**
 * Load schema from URL or object
 */
export async function loadSchema<T = unknown>(
  schemaSource: string | T
): Promise<T> {
  if (typeof schemaSource === 'string') {
    const response = await fetch(schemaSource);
    if (!response.ok) {
      throw new Error(`Failed to load schema from ${schemaSource}`);
    }
    return (await response.json()) as T;
  }
  return schemaSource;
}
