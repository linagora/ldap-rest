/**
 * @module lib/changes
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * The shape of the changes a write makes, shared by the hooks and the
 * plugins that follow them.
 */
import type { AttributeValue } from './ldapActions';

/** The attributes a write changed, with their value before and after. */
export type ChangesToNotify = Record<
  string,
  [AttributeValue | null, AttributeValue | null]
>;
