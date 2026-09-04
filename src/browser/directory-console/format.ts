/**
 * How a value and its name are shown.
 *
 * Two things are wrong by default when a schema is rendered as-is: an
 * attribute with no `label` shows as `twakeDepartmentPath`, and a DN reference
 * shows as the whole DN, which fills a column and tells the reader nothing
 * they did not already know. Both are fixed here, in one place, so the table,
 * the detail card and the form agree.
 *
 * @module browser/directory-console/format
 */

import { toTitleCase } from '../shared/utils/dom';

import type { LocalizedText, SchemaAttribute } from './types';

/**
 * Pick the text for a language.
 *
 * A deployment names its own entities and attributes, so those names — and
 * their translations — come from its schemas rather than from a catalogue
 * shipped with the product. A plain string is the text itself; a map is
 * searched for the exact tag, then for its language, then for English, and
 * finally for whatever it does hold, so a partially translated schema shows
 * *something* rather than nothing.
 *
 * @param text the schema's text, in one or several languages
 * @param language language tag the interface is running in
 * @returns the text to show, or undefined when there is none
 */
export function resolveText(
  text: LocalizedText | undefined,
  language: string
): string | undefined {
  if (text === undefined || text === null) return undefined;
  if (typeof text === 'string') return text || undefined;
  const short = language.split('-')[0].toLowerCase();
  const candidates = [language, short, 'en'];
  for (const key of candidates) {
    const found = text[key];
    if (found) return found;
  }
  return Object.values(text).find(Boolean);
}

/**
 * Name to show for an attribute: the schema's own label when it has one, in
 * the interface's language, and otherwise its name made readable —
 * `twakeDepartmentPath` reads better as "Twake department path" than as itself.
 *
 * @param name attribute name
 * @param attr its schema definition
 * @param language language tag the interface is running in
 * @returns the label to show
 */
export function attributeLabel(
  name: string,
  attr: SchemaAttribute | undefined,
  language = 'en'
): string {
  return resolveText(attr?.label, language) || toTitleCase(name);
}

/** Value of the first RDN of a DN, with its escapes removed. */
export function rdnValue(dn: string): string {
  const match = /^[^=]+=((?:\\.|[^,])*)/.exec(dn);
  return match ? match[1].replace(/\\(.)/g, '$1') : dn;
}

/**
 * Text to show for one value.
 *
 * A DN reference is shown by its own name — `active`, `Systems Analyst` — and
 * the full DN belongs in the tooltip, where it is available without being in
 * the way.
 *
 * @param attr schema definition of the attribute
 * @param value value as stored
 * @returns the text to show
 */
/**
 * Decimal units, the ones `parseByteSize` reads and the ones mail servers
 * report: 1 GB is 10^9 bytes, not 2^30.
 */
const SIZE_UNITS: [string, number][] = [
  ['TB', 1e12],
  ['GB', 1e9],
  ['MB', 1e6],
  ['KB', 1e3],
];

/**
 * A byte count as the size a reader recognises.
 *
 * The directory stores what `normalize: "byteSize"` computed — a bare number
 * of bytes — so a mail quota reads as ten digits where the operator set
 * `4GB`. It is turned back only when the shorter form means exactly the same
 * number: a value that needs more than three decimals is not made clearer by
 * a unit, and the form hands what is shown straight back to the server, which
 * reads it with `parseByteSize`.
 *
 * @param value value as stored
 * @returns the size in the largest unit that says it exactly
 */
export function formatByteSize(value: string): string {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return value;
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes)) return value;
  for (const [unit, size] of SIZE_UNITS) {
    if (bytes < size) continue;
    const quantity = (bytes / size).toFixed(3).replace(/\.?0+$/, '');
    if (Math.round(Number(quantity) * size) !== bytes) return value;
    return `${quantity} ${unit}`;
  }
  return `${bytes} B`;
}

export function displayValue(
  attr: SchemaAttribute | undefined,
  value: string
): string {
  const pointer = attr?.type === 'pointer' || attr?.items?.type === 'pointer';
  if (pointer) return rdnValue(value);
  if (attr?.normalize === 'byteSize') return formatByteSize(value);
  return value;
}
