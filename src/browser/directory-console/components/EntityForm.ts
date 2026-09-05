/**
 * Schema-driven form.
 *
 * Every field, its type, whether it is required, what a valid value looks like
 * and even its label come from the entity schema. Nothing here knows a
 * concrete attribute, so an attribute the deployment adds appears in the form
 * on its own.
 *
 * Two things the interface it replaces got wrong are fixed here: the pattern a
 * value has to satisfy is shown *under the field*, in words, before the user
 * gets it wrong; and a long form opens as a side panel rather than a modal
 * whose Save button ends up off screen.
 *
 * @module browser/directory-console/components/EntityForm
 */

import { escapeHtml } from '../../shared/utils/dom';
import { attributeLabel, entryValue, formatByteSize } from '../format';
import type { Translator } from '../i18n';
import type { EntityDescriptor, Entry, SchemaAttribute } from '../types';

/** A field's current value, always as a list to keep one code path. */
type Values = Record<string, string[]>;

export interface FormOptions {
  entity: EntityDescriptor;
  translator: Translator;
  /** Existing entry when editing; absent when creating */
  entry?: Entry;
  /** Load the candidates of a pointer field */
  pointerOptions(branch: string): Promise<{ dn: string; label: string }[]>;
  /** Called with the attributes to write and those to clear */
  onSubmit(
    values: Record<string, string | string[]>,
    cleared: string[]
  ): Promise<void>;
  onCancel(): void;
}

/** Above this many fields a modal stops being usable and becomes a panel. */
const PANEL_THRESHOLD = 8;

/**
 * Quote an attribute name for use inside an attribute selector.
 *
 * `CSS.escape` would do, but it does not exist outside a browser, and a
 * component that cannot be rendered in a test is a component nobody tests.
 * LDAP attribute names are letters, digits and hyphens, so quoting the two
 * characters that could close the selector early is enough.
 *
 * @param name attribute name
 * @returns the name, safe to embed between double quotes
 */
function selectorValue(name: string): string {
  return name.replace(/["\\]/g, '\\$&');
}

/** Read an entry value as a list of strings. */
function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v));
  return [String(value)];
}

export class EntityForm {
  private readonly options: FormOptions;
  private readonly fields: [string, SchemaAttribute][];
  private values: Values = {};
  private root: HTMLElement | null = null;
  private errors: Record<string, string> = {};

  constructor(options: FormOptions) {
    this.options = options;
    this.fields = this.editableFields();
    for (const [name] of this.fields)
      this.values[name] = toList(entryValue(options.entry, name));
  }

  /**
   * Attributes a person may actually fill in: what the server computes or
   * derives is shown on the detail view, not offered for editing.
   *
   * @returns the attributes to render, in schema order
   */
  private editableFields(): [string, SchemaAttribute][] {
    const { entity, entry } = this.options;
    return Object.entries(entity.schema.attributes).filter(([name, attr]) => {
      if (attr.fixed) return false;
      if (attr.generated || attr.readOnly) return false;
      // The identifier is the RDN: chosen once, then changed through the
      // rename endpoint rather than by editing the field.
      if (name === entity.mainAttribute && entry) return false;
      return true;
    });
  }

  /** True when the form is long enough to deserve a panel rather than a modal. */
  get wantsPanel(): boolean {
    return this.fields.length > PANEL_THRESHOLD;
  }

  /** Label of an attribute: its schema label, or its name made readable. */
  private label(name: string, attr: SchemaAttribute): string {
    return attributeLabel(name, attr, this.options.translator.language);
  }

  /**
   * Render the form into a container.
   *
   * @param container element to fill
   */
  async render(container: HTMLElement): Promise<void> {
    this.root = container;
    const { translator } = this.options;
    const groups = new Map<string, [string, SchemaAttribute][]>();
    for (const field of this.fields) {
      const group = field[1].group || '';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(field);
    }

    container.innerHTML = `
      <form class="dc-form" novalidate>
        <p class="dc-form-required">${escapeHtml(translator.t('form.required'))}</p>
        ${[...groups.entries()]
          .map(
            ([group, fields]) => `
          <fieldset class="dc-form-group">
            ${group ? `<legend>${escapeHtml(group)}</legend>` : ''}
            ${fields.map(([name, attr]) => this.fieldMarkup(name, attr)).join('')}
          </fieldset>`
          )
          .join('')}
        <div class="dc-form-actions">
          <button type="button" class="dc-button" data-cancel>${escapeHtml(
            translator.t('app.cancel')
          )}</button>
          <button type="submit" class="dc-button dc-button-primary">${escapeHtml(
            translator.t(this.options.entry ? 'app.save' : 'app.create')
          )}</button>
        </div>
      </form>`;

    this.bind();
    await this.fillPointers();
  }

  /** Markup of one field, chosen from its schema type. */
  private fieldMarkup(name: string, attr: SchemaAttribute): string {
    const id = `dc-field-${name}`;
    const hint = attr.hint || attr.items?.hint;
    const required = attr.required ? ' <span class="dc-required">*</span>' : '';
    const control =
      attr.type === 'array'
        ? this.tokenMarkup(name, attr)
        : attr.type === 'pointer'
          ? this.pointerMarkup(name, attr)
          : attr.type === 'boolean'
            ? this.booleanMarkup(name)
            : this.inputMarkup(name, attr);

    return `
      <div class="dc-field" data-field="${escapeHtml(name)}">
        <label for="${escapeHtml(id)}">${escapeHtml(this.label(name, attr))}${required}</label>
        ${control}
        ${hint ? `<p class="dc-hint" data-hint>${escapeHtml(hint)}</p>` : ''}
        <p class="dc-error" data-error hidden></p>
      </div>`;
  }

  private inputMarkup(name: string, attr: SchemaAttribute): string {
    const value = this.values[name][0] ?? '';
    const type =
      attr.type === 'date' ? 'date' : attr.neverReturn ? 'password' : 'text';
    // A normalised size is stored as a bare byte count and edited as one, so
    // the operator counted zeros to change a quota. The field is text, and
    // the server reads `4 GB` with the same `parseByteSize` that produced the
    // number — the value shown is a value it accepts back.
    const shown =
      attr.type === 'date'
        ? EntityForm.toDateInput(value)
        : attr.normalize === 'byteSize'
          ? formatByteSize(value)
          : value;
    return `<input id="dc-field-${escapeHtml(name)}" name="${escapeHtml(name)}"
      type="${type}" class="dc-input" value="${escapeHtml(shown)}"
      ${attr.neverReturn ? 'autocomplete="new-password"' : ''} />`;
  }

  private booleanMarkup(name: string): string {
    const { translator } = this.options;
    const value = (this.values[name][0] ?? '').toUpperCase();
    return `<select id="dc-field-${escapeHtml(name)}" name="${escapeHtml(name)}" class="dc-input">
      <option value="">${escapeHtml(translator.t('form.none'))}</option>
      <option value="TRUE"${value === 'TRUE' ? ' selected' : ''}>${escapeHtml(
        translator.t('form.true')
      )}</option>
      <option value="FALSE"${value === 'FALSE' ? ' selected' : ''}>${escapeHtml(
        translator.t('form.false')
      )}</option>
    </select>`;
  }

  private pointerMarkup(name: string, attr: SchemaAttribute): string {
    const { translator } = this.options;
    const current = this.values[name][0] ?? '';
    const branch = (attr.branch || [])[0] || '';
    return `<select id="dc-field-${escapeHtml(name)}" name="${escapeHtml(name)}"
      class="dc-input" data-pointer="${escapeHtml(branch)}">
      <option value="">${escapeHtml(translator.t('form.choose'))}</option>
      ${current ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>` : ''}
    </select>`;
  }

  /**
   * A multi-valued attribute as a list of removable tokens plus one input.
   * The instruction is explicit — a text box that silently swallows Enter is
   * the surest way to lose a value.
   */
  private tokenMarkup(name: string, attr: SchemaAttribute): string {
    const { translator } = this.options;
    const isPointer = attr.items?.type === 'pointer';
    const branch = (attr.items?.branch || [])[0] || '';
    return `
      <div class="dc-tokens" data-tokens="${escapeHtml(name)}">
        <ul class="dc-token-list">${this.tokenItems(name)}</ul>
        ${
          isPointer
            ? `<select class="dc-input" data-token-input data-pointer="${escapeHtml(branch)}">
                 <option value="">${escapeHtml(translator.t('form.choose'))}</option>
               </select>`
            : `<input class="dc-input" data-token-input type="text"
                 placeholder="${escapeHtml(translator.t('form.addValue'))}" />`
        }
      </div>`;
  }

  private tokenItems(name: string): string {
    const { translator } = this.options;
    return this.values[name]
      .map(
        (value, index) => `
      <li class="dc-token">
        <span title="${escapeHtml(value)}">${escapeHtml(value)}</span>
        <button type="button" data-remove="${index}"
          aria-label="${escapeHtml(translator.t('form.removeValue'))}">×</button>
      </li>`
      )
      .join('');
  }

  /** Wire the controls up to the value map. */
  private bind(): void {
    const root = this.root;
    if (!root) return;

    root.querySelector('[data-cancel]')?.addEventListener('click', () => {
      this.options.onCancel();
    });

    root.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault();
      void this.submit();
    });

    for (const [name, attr] of this.fields) {
      const wrapper = root.querySelector<HTMLElement>(
        `[data-field="${selectorValue(name)}"]`
      );
      if (!wrapper) continue;

      if (attr.type === 'array') {
        this.bindTokens(name, wrapper);
        continue;
      }
      const control = wrapper.querySelector<
        HTMLInputElement | HTMLSelectElement
      >('.dc-input');
      control?.addEventListener('change', () => {
        const raw = control.value;
        this.values[name] =
          raw === ''
            ? []
            : [attr.type === 'date' ? EntityForm.toDirectoryDate(raw) : raw];
      });
    }
  }

  private bindTokens(name: string, wrapper: HTMLElement): void {
    const redraw = (): void => {
      const list = wrapper.querySelector('.dc-token-list');
      if (list) list.innerHTML = this.tokenItems(name);
    };

    wrapper.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-remove]'
      );
      if (!button) return;
      this.values[name].splice(Number(button.dataset.remove), 1);
      redraw();
    });

    const input = wrapper.querySelector<HTMLInputElement | HTMLSelectElement>(
      '[data-token-input]'
    );
    if (!input) return;

    const add = (value: string): void => {
      const trimmed = value.trim();
      if (!trimmed || this.values[name].includes(trimmed)) return;
      this.values[name].push(trimmed);
      input.value = '';
      redraw();
    };

    if (input instanceof HTMLSelectElement) {
      input.addEventListener('change', () => add(input.value));
    } else {
      input.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key !== 'Enter') return;
        event.preventDefault();
        add(input.value);
      });
      // A value typed and left in the box is a value the user meant to add.
      input.addEventListener('blur', () => add(input.value));
    }
  }

  /** Load the candidates of every pointer control. */
  private async fillPointers(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const selects = root.querySelectorAll<HTMLSelectElement>('[data-pointer]');
    await Promise.all(
      Array.from(selects).map(async select => {
        const branch = select.dataset.pointer;
        if (!branch) return;
        // A branch the caller may not read answers 403, and the form is
        // awaited by a caller that does not await it back: the rejection
        // would surface as an unhandled one and leave the whole form
        // half-built. The select keeps the value the entry already holds and
        // offers nothing else, which is what an unreadable branch means.
        let options: { dn: string; label: string }[];
        try {
          options = await this.options.pointerOptions(branch);
        } catch {
          options = [];
        }
        const current = select.value;
        select.innerHTML =
          `<option value="">${escapeHtml(this.options.translator.t('form.choose'))}</option>` +
          options
            .map(
              option =>
                `<option value="${escapeHtml(option.dn)}"${
                  option.dn === current ? ' selected' : ''
                }>${escapeHtml(option.label)}</option>`
            )
            .join('');
        if (current && !options.some(option => option.dn === current)) {
          // Keep a value the directory holds but the branch listing missed,
          // rather than silently dropping it on the next save.
          select.insertAdjacentHTML(
            'beforeend',
            `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`
          );
        }
        select.value = current;
      })
    );
  }

  /** Validate, then hand the values to the caller. */
  private async submit(): Promise<void> {
    if (!this.validate()) return;
    const values: Record<string, string | string[]> = {};
    const cleared: string[] = [];
    for (const [name, attr] of this.fields) {
      const list = this.values[name];
      const before = toList(entryValue(this.options.entry, name));
      if (list.length === 0) {
        if (before.length > 0) cleared.push(name);
        continue;
      }
      if (
        this.options.entry &&
        list.length === before.length &&
        list.every((value, index) => value === before[index])
      )
        continue;
      values[name] = attr.type === 'array' ? list : list[0];
    }
    await this.options.onSubmit(values, cleared);
  }

  /**
   * Check what the schema says before the round trip. The server checks again;
   * this only spares the user a request to be told what the hint already said.
   *
   * @returns true when every field passes
   */
  private validate(): boolean {
    this.errors = {};
    for (const [name, attr] of this.fields) {
      const list = this.values[name];
      if (attr.required && list.length === 0) {
        this.errors[name] = this.options.translator.t('form.required');
        continue;
      }
      const pattern = attr.test || attr.items?.test;
      if (!pattern) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        continue; // A pattern the browser cannot compile is the server's business
      }
      const bad = list.find(value => !regex.test(value));
      if (bad !== undefined)
        this.errors[name] =
          attr.hint || attr.items?.hint || `${bad}: ${String(pattern)}`;
    }

    const root = this.root;
    if (root) {
      for (const [name] of this.fields) {
        const field = root.querySelector<HTMLElement>(
          `[data-field="${selectorValue(name)}"]`
        );
        const holder = field?.querySelector<HTMLElement>('[data-error]');
        if (!holder) continue;
        const message = this.errors[name];
        holder.textContent = message || '';
        holder.hidden = !message;
        // The refusal repeats the hint, so showing both says the same thing
        // twice, once in grey and once in red.
        const hint = field?.querySelector<HTMLElement>('[data-hint]');
        if (hint) hint.hidden = Boolean(message);
      }
      const first = Object.keys(this.errors)[0];
      if (first)
        root
          .querySelector<HTMLElement>(`[data-field="${selectorValue(first)}"]`)
          ?.scrollIntoView({ block: 'center' });
    }
    return Object.keys(this.errors).length === 0;
  }

  /** `20240930220000Z` → `2024-09-30`, for an `input[type=date]`. */
  static toDateInput(value: string): string {
    const generalized = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (generalized)
      return `${generalized[1]}-${generalized[2]}-${generalized[3]}`;
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return iso ? iso[1] : '';
  }

  /** `2024-09-30` → `20240930000000Z`, the form the directory stores. */
  static toDirectoryDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[1]}${match[2]}${match[3]}000000Z` : value;
  }
}
