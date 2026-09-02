/**
 * Directory console — the administration interface.
 *
 * It is built entirely from what the server advertises: `GET /v1/config` gives
 * the entities, their schemas and their endpoints, `GET /v1/authz/scope` gives
 * what the signed-in administrator may do. No entity name, attribute name or
 * label is written here, so a deployment that names its things differently
 * gets its own interface without a change.
 *
 * @module browser/directory-console/DirectoryConsole
 */

import { escapeHtml } from '../shared/utils/dom';

import { ConsoleApiClient } from './api/ConsoleApiClient';
import { EntityDetail } from './components/EntityDetail';
import { EntityForm } from './components/EntityForm';
import { EntityList, SEARCH_MINIMUM } from './components/EntityList';
import { OrganizationTree } from './components/OrganizationTree';
import { attributeLabel, rdnValue, resolveText } from './format';
import { availableLanguages, Translator } from './i18n';
import type {
  ConsoleOptions,
  EntityDescriptor,
  Entry,
  OrganizationNode,
  Scope,
} from './types';

/** Where the console currently is. */
interface Route {
  view: 'dashboard' | 'entity' | 'organizations';
  entity?: string;
  id?: string;
}

const LANGUAGE_KEY = 'ldap-rest.console.language';

export class DirectoryConsole {
  private readonly options: ConsoleOptions;
  private readonly api: ConsoleApiClient;
  private translator: Translator;
  private container: HTMLElement | null = null;
  private entities: EntityDescriptor[] = [];
  private scope: Scope | null = null;
  /**
   * Why the scope could not be read, when it could not. A missing endpoint
   * is `scope = null` and means the server restricts nothing; a request that
   * failed means the console does not know what the caller may do, and it
   * offers nothing rather than every button.
   */
  private scopeError: string | null = null;
  private route: Route = { view: 'dashboard' };
  private tree: OrganizationTree | null = null;

  constructor(options: ConsoleOptions) {
    this.options = options;
    this.api = new ConsoleApiClient(options.apiBaseUrl, options.apiPrefix);
    this.translator = new Translator(options.language || this.storedLanguage());
  }

  /** Language remembered from a previous visit, if any. */
  private storedLanguage(): string | undefined {
    try {
      return localStorage.getItem(LANGUAGE_KEY) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Discover the directory and draw the console.
   *
   * @throws Error when the container does not exist
   */
  async init(): Promise<void> {
    this.container = document.getElementById(this.options.containerId);
    if (!this.container)
      throw new Error(`Container #${this.options.containerId} not found`);

    this.container.innerHTML = `<p class="dc-empty">${escapeHtml(
      this.translator.t('app.loading')
    )}</p>`;

    try {
      this.entities = await this.api.discover();
    } catch (err) {
      this.container.innerHTML = `<p class="dc-empty dc-error-block">${escapeHtml(
        (err as Error).message
      )}</p>`;
      return;
    }

    // The scope is not worth a dead page: a console that lists and reads is
    // still a console. But it stops offering to write, since what came back
    // was a failure rather than a permission.
    try {
      this.scope = await this.api.scope();
      this.scopeError = null;
    } catch (err) {
      this.scope = null;
      this.scopeError = (err as Error).message;
    }

    this.readRoute();
    window.addEventListener('hashchange', () => {
      this.readRoute();
      void this.renderMain();
    });

    this.drawShell();
    await this.renderMain();
  }

  /* ---------------------------------------------------------------- routing */

  /** Read `#/entity/id` into the current route. */
  private readRoute(): void {
    const hash = window.location.hash.replace(/^#\/?/, '');
    // A hash is typed, pasted and mailed around, so it is not always the one
    // `go()` wrote: `#/users/50%` throws out of `decodeURIComponent`, and an
    // exception here leaves the console on "Loading…" for good. A segment
    // that does not decode is taken as it stands.
    const [first, second] = hash.split('/').map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    if (!first) {
      this.route = { view: 'dashboard' };
      return;
    }
    if (first === 'organizations') {
      this.route = { view: 'organizations', id: second };
      return;
    }
    this.route = { view: 'entity', entity: first, id: second };
  }

  /** Navigate, letting the hash change drive the render. */
  private go(path: string): void {
    window.location.hash = `#/${path}`;
  }

  /* ------------------------------------------------------------------ shell */

  /** Draw the permanent frame: sidebar, scope, main area, side panel. */
  private drawShell(): void {
    const container = this.container;
    if (!container) return;
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);

    container.innerHTML = `
      <div class="dc-app">
        <aside class="dc-sidebar">
          <div class="dc-brand">${escapeHtml(t('app.title'))}</div>
          <nav class="dc-nav">
            <button type="button" class="dc-nav-item" data-nav="">${escapeHtml(
              t('nav.dashboard')
            )}</button>
            ${this.entities
              .map(
                entity =>
                  `<button type="button" class="dc-nav-item" data-nav="${escapeHtml(
                    entity.key
                  )}">${escapeHtml(this.plural(entity))}</button>`
              )
              .join('')}
          </nav>
          <div class="dc-sidebar-footer">
            <label class="dc-language">
              <span>${escapeHtml(t('app.language'))}</span>
              <select class="dc-input" data-language>
                ${availableLanguages
                  .map(
                    code =>
                      `<option value="${code}"${
                        code === this.translator.language ? ' selected' : ''
                      }>${code}</option>`
                  )
                  .join('')}
              </select>
            </label>
          </div>
        </aside>
        <div class="dc-content">
          <header class="dc-header">${this.scopeMarkup()}</header>
          <main class="dc-main" data-main></main>
        </div>
        <div class="dc-panel" data-panel hidden>
          <div class="dc-panel-inner">
            <header class="dc-panel-header">
              <h2 data-panel-title></h2>
              <button type="button" class="dc-icon-button" data-panel-close
                aria-label="${escapeHtml(t('app.close'))}">×</button>
            </header>
            <div class="dc-panel-body" data-panel-body></div>
          </div>
        </div>
        <div class="dc-toast" data-toast hidden></div>
      </div>`;

    for (const button of Array.from(
      container.querySelectorAll<HTMLElement>('[data-nav]')
    )) {
      button.addEventListener('click', () => this.go(button.dataset.nav || ''));
    }

    container
      .querySelector<HTMLSelectElement>('[data-language]')
      ?.addEventListener('change', event => {
        const code = (event.target as HTMLSelectElement).value;
        try {
          localStorage.setItem(LANGUAGE_KEY, code);
          // eslint-disable-next-line no-empty
        } catch {}
        this.translator = new Translator(code);
        this.drawShell();
        void this.renderMain();
      });

    container
      .querySelector('[data-panel-close]')
      ?.addEventListener('click', () => this.closePanel());
  }

  /**
   * The branches the caller administers, shown permanently.
   *
   * In a local-administration model this is the single most useful thing on
   * the screen, and the interface this replaces showed it nowhere.
   */
  private scopeMarkup(): string {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    if (this.scopeError)
      return `<span class="dc-scope-error">${escapeHtml(
        t('scope.unavailable', { error: this.scopeError })
      )}</span>`;
    if (!this.scope)
      return `<span class="dc-scope-empty">${escapeHtml(t('scope.unrestricted'))}</span>`;
    if (this.scope.unrestricted)
      return `<span class="dc-scope-empty">${escapeHtml(t('scope.unrestricted'))}</span>`;
    if (this.scope.branches.length === 0)
      return `<span class="dc-scope-empty">${escapeHtml(t('scope.none'))}</span>`;

    return `
      <span class="dc-scope-label">${escapeHtml(t('scope.title'))}</span>
      <ul class="dc-scope">
        ${this.scope.branches
          .map(branch => {
            const rights = [
              branch.read ? t('scope.read') : '',
              branch.write ? t('scope.write') : '',
              branch.delete ? t('scope.delete') : '',
            ]
              .filter(Boolean)
              .join(', ');
            return `<li title="${escapeHtml(branch.path || branch.dn)}">
              <strong>${escapeHtml(branch.name || branch.dn)}</strong>
              <span class="dc-muted">${escapeHtml(rights)}</span>
            </li>`;
          })
          .join('')}
      </ul>`;
  }

  /* ------------------------------------------------------------------ views */

  private main(): HTMLElement | null {
    return this.container?.querySelector<HTMLElement>('[data-main]') || null;
  }

  /** Draw whatever the current route asks for. */
  private async renderMain(): Promise<void> {
    const main = this.main();
    if (!main) return;

    for (const button of Array.from(
      this.container?.querySelectorAll<HTMLElement>('[data-nav]') || []
    )) {
      const key = button.dataset.nav || '';
      const active =
        (this.route.view === 'dashboard' && key === '') ||
        (this.route.view === 'organizations' && key === 'organizations') ||
        (this.route.view === 'entity' && key === this.route.entity);
      button.classList.toggle('dc-active', active);
    }

    if (this.route.view === 'dashboard') return this.renderDashboard(main);
    if (this.route.view === 'organizations')
      return this.renderOrganizations(main);

    const entity = this.entity(this.route.entity);
    if (!entity) return this.renderDashboard(main);
    if (entity.kind === 'organization') return this.renderOrganizations(main);
    if (this.route.id) return this.renderDetail(main, entity, this.route.id);
    return this.renderList(main, entity);
  }

  private entity(key?: string): EntityDescriptor | undefined {
    return this.entities.find(entity => entity.key === key);
  }

  /**
   * What to call a collection: the schema's label in the current language,
   * falling back to the name the schema gives it.
   *
   * @param entity entity to name
   * @returns the plural name to show
   */
  private plural(entity: EntityDescriptor): string {
    return (
      resolveText(entity.label, this.translator.language) ||
      // The organization tree is the one collection the product itself names,
      // because it is the product that draws it.
      (entity.kind === 'organization'
        ? this.translator.t('tree.title')
        : entity.pluralName)
    );
  }

  /**
   * What to call one entry of a collection.
   *
   * @param entity entity to name
   * @returns the singular name to show
   */
  private singular(entity: EntityDescriptor): string {
    return (
      resolveText(entity.singularLabel, this.translator.language) ||
      entity.singularName
    );
  }

  /** Whether the caller may create an entry of this entity. */
  private canCreate(entity: EntityDescriptor): boolean {
    if (this.scopeError) return false;
    if (!this.scope || this.scope.unrestricted) return true;
    const declared = this.scope.entities.find(
      item => item.name === entity.pluralName
    );
    // The server enumerates every entity it serves, so an entity it did not
    // name is one it does not know: its add hook is what would answer, and it
    // would answer 403.
    return declared ? declared.create : false;
  }

  /** Whether the caller may write anywhere at all. */
  private canWrite(): boolean {
    if (this.scopeError) return false;
    if (!this.scope || this.scope.unrestricted) return true;
    return this.scope.branches.some(branch => branch.write);
  }

  private canDelete(): boolean {
    if (this.scopeError) return false;
    if (!this.scope || this.scope.unrestricted) return true;
    return this.scope.branches.some(branch => branch.delete);
  }

  /**
   * The overview: the scope, and the entities with what can be done to them.
   * A page of four cards that only repeat the sidebar is decoration; this one
   * answers "what am I allowed to do here?".
   */
  private renderDashboard(main: HTMLElement): void {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    main.innerHTML = `
      <section class="dc-dashboard">
        <h1>${escapeHtml(t('app.title'))}</h1>
        ${
          this.scope?.user
            ? `<p class="dc-muted">${escapeHtml(
                t('dashboard.welcome', { user: this.scope.user })
              )}</p>`
            : ''
        }
        <h2>${escapeHtml(t('dashboard.entities'))}</h2>
        <ul class="dc-cards">
          ${this.entities
            .map(entity => {
              const allowed = this.canCreate(entity);
              return `<li class="dc-card">
                <h3>${escapeHtml(this.plural(entity))}</h3>
                <div class="dc-card-actions">
                  <button type="button" class="dc-button" data-open="${escapeHtml(
                    entity.key
                  )}">${escapeHtml(t('list.open'))}</button>
                  ${
                    allowed
                      ? `<button type="button" class="dc-button dc-button-primary" data-new="${escapeHtml(
                          entity.key
                        )}">${escapeHtml(
                          t('dashboard.create', {
                            entity: this.singular(entity),
                          })
                        )}</button>`
                      : `<span class="dc-muted">${escapeHtml(t('dashboard.noCreate'))}</span>`
                  }
                </div>
              </li>`;
            })
            .join('')}
        </ul>
      </section>`;

    for (const button of Array.from(
      main.querySelectorAll<HTMLElement>('[data-open]')
    ))
      button.addEventListener('click', () =>
        this.go(button.dataset.open as string)
      );
    for (const button of Array.from(
      main.querySelectorAll<HTMLElement>('[data-new]')
    ))
      button.addEventListener('click', () => {
        const entity = this.entity(button.dataset.new as string);
        if (entity) void this.openForm(entity);
      });
  }

  /** The table of an entity. */
  private async renderList(
    main: HTMLElement,
    entity: EntityDescriptor
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    main.innerHTML = `
      <section class="dc-view">
        <header class="dc-view-header">
          <h1>${escapeHtml(this.plural(entity))}</h1>
          ${
            this.canCreate(entity)
              ? `<button type="button" class="dc-button dc-button-primary" data-new>${escapeHtml(
                  t('dashboard.create', { entity: this.singular(entity) })
                )}</button>`
              : ''
          }
        </header>
        <div data-list></div>
      </section>`;

    main
      .querySelector('[data-new]')
      ?.addEventListener('click', () => void this.openForm(entity));

    const list = new EntityList({
      entity,
      translator: this.translator,
      // An entity attached to organizations is the large one; the small
      // reference tables are listed whole.
      listable: !entity.organizationLink,
      load: (
        search: string,
        attribute: string
      ): Promise<Record<string, Entry>> =>
        search.length >= SEARCH_MINIMUM
          ? this.api.list(entity, search, attribute)
          : this.api.list(entity),
      canDelete: this.canDelete(),
      onOpen: (id: string): void =>
        this.go(`${entity.key}/${encodeURIComponent(id)}`),
      onDelete: (ids: string[]): Promise<void> => this.deleteMany(entity, ids),
    });
    await list.render(
      main.querySelector<HTMLElement>('[data-list]') as HTMLElement
    );
  }

  /** One entry, read-only, with its actions and its relations. */
  private async renderDetail(
    main: HTMLElement,
    entity: EntityDescriptor,
    id: string
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    main.innerHTML = `<p class="dc-empty">${escapeHtml(t('app.loading'))}</p>`;
    let entry: Entry;
    try {
      entry = await this.api.get(entity, id);
    } catch (err) {
      // Only a 404 means what "no longer exists" says. A 401, a 403 or a
      // proxy error is a different thing entirely, and telling the operator
      // the entry is gone sends them looking for the wrong problem.
      const gone = (err as { status?: number }).status === 404;
      const message = gone ? t('detail.notFound') : (err as Error).message;
      main.innerHTML = `<p class="dc-empty${
        gone ? '' : ' dc-error-block'
      }">${escapeHtml(message)}</p>`;
      return;
    }

    main.innerHTML = `
      <section class="dc-view">
        <header class="dc-view-header">
          <button type="button" class="dc-button" data-back>${escapeHtml(t('app.back'))}</button>
        </header>
        <div data-detail></div>
      </section>`;
    main
      .querySelector('[data-back]')
      ?.addEventListener('click', () => this.go(entity.key));

    const detail = new EntityDetail({
      entity,
      entry,
      translator: this.translator,
      canWrite: this.canWrite(),
      canDelete: this.canDelete(),
      relations: this.relations(entity, entry),
      onEdit: (): void => {
        void this.openForm(entity, entry);
      },
      onDelete: (): void => {
        void this.confirmDelete(entity, id);
      },
      onStatus: (state: string): void => {
        void this.setStatus(entity, id, state);
      },
      onResetPassword: (): void => {
        void this.resetPassword(entity, id);
      },
      onOpenRelation: (target: string): void => this.openRelation(target),
    });
    detail.render(
      main.querySelector<HTMLElement>('[data-detail]') as HTMLElement
    );
  }

  /**
   * Entries related to this one: the members of a group, the groups an account
   * belongs to. Both are read from roles, so an entity that models them under
   * other names still gets the section.
   */
  private relations(
    entity: EntityDescriptor,
    entry: Entry
  ):
    | {
        title: string;
        attribute: string;
        items: { id: string; label: string }[];
      }
    | undefined {
    for (const role of ['members', 'groupMemberships']) {
      for (const [name, attr] of Object.entries(entity.schema.attributes)) {
        const roles = Array.isArray(attr.role) ? attr.role : [attr.role];
        if (!roles.includes(role)) continue;
        const raw = entry[name];
        const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        return {
          title: attributeLabel(name, attr, this.translator.language),
          attribute: name,
          items: list.map(dn => ({
            id: String(dn),
            label: rdnValue(String(dn)),
          })),
        };
      }
    }
    return undefined;
  }

  /** Follow a relation to whichever entity owns the DN. */
  private openRelation(dn: string): void {
    const owner = this.entities.find(
      entity =>
        entity.base &&
        dn.toLowerCase().endsWith(`,${entity.base.toLowerCase()}`)
    );
    if (!owner) return;
    const id = dn.split(',')[0].replace(/^[^=]+=/, '');
    this.go(`${owner.key}/${encodeURIComponent(id)}`);
  }

  /** The organization tree, with the selected node's card beside it. */
  private async renderOrganizations(main: HTMLElement): Promise<void> {
    const entity = this.entities.find(item => item.kind === 'organization');
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    main.innerHTML = `
      <section class="dc-split">
        <div class="dc-split-aside" data-tree></div>
        <div class="dc-split-main" data-org-detail>
          <p class="dc-empty">${escapeHtml(t('tree.empty'))}</p>
        </div>
      </section>`;

    this.tree = new OrganizationTree({
      translator: this.translator,
      root: (): Promise<OrganizationNode | null> => this.api.organizationTop(),
      children: (dn: string): Promise<OrganizationNode[]> =>
        this.api.organizationChildren(dn),
      onSelect: (node: OrganizationNode): void => {
        void this.showOrganization(node);
      },
      onCreateChild:
        entity && this.canCreate(entity)
          ? (node: OrganizationNode): void => {
              void this.openOrganizationForm(entity, undefined, node.dn);
            }
          : undefined,
    });
    await this.tree.render(
      main.querySelector<HTMLElement>('[data-tree]') as HTMLElement
    );

    if (this.route.id) {
      const node = { dn: this.route.id, name: this.route.id };
      this.tree.select(this.route.id);
      await this.showOrganization(node);
    }
  }

  /** Show one organization in the right-hand pane, tree still visible. */
  private async showOrganization(node: OrganizationNode): Promise<void> {
    const entity = this.entities.find(item => item.kind === 'organization');
    const holder =
      this.container?.querySelector<HTMLElement>('[data-org-detail]');
    if (!holder || !entity) return;

    let entry: Entry;
    try {
      entry = await this.api.organization(node.dn);
    } catch {
      holder.innerHTML = `<p class="dc-empty">${escapeHtml(
        this.translator.t('detail.notFound')
      )}</p>`;
      return;
    }

    // "Who is in this department?" is the question an organization card is
    // opened to answer, and the tree deliberately does not show accounts.
    const members = await this.api.organizationMembers(node.dn).catch(() => []);

    new EntityDetail({
      entity,
      entry,
      translator: this.translator,
      canWrite: this.canWrite(),
      canDelete: this.canDelete(),
      relations: {
        title: this.translator.t('detail.members'),
        items: members.map(member => ({
          id: member.dn,
          label: member.label,
        })),
      },
      onOpenRelation: (target: string): void => this.openRelation(target),
      onEdit: (): void => {
        void this.openOrganizationForm(entity, entry);
      },
      onDelete: (): void => {
        void this.confirmDeleteOrganization(node.dn);
      },
      onStatus: (): void => undefined,
      onResetPassword: (): void => undefined,
    }).render(holder);
  }

  /* ------------------------------------------------------------ side panel */

  /** Open the side panel with a title and a body builder. */
  /**
   * Show the overlay.
   *
   * A long form docks to the side, so its Save button stays put instead of
   * scrolling off the bottom of a modal — that was the complaint the brief
   * makes. A form of three fields does not need half the screen, and reads
   * better centred, which is what `modal` asks for.
   *
   * @param title heading of the overlay
   * @param build fills the body
   * @param modal centre it rather than docking it to the side
   */
  private openPanel(
    title: string,
    build: (body: HTMLElement) => void,
    modal = false
  ): void {
    const panel = this.container?.querySelector<HTMLElement>('[data-panel]');
    const heading =
      this.container?.querySelector<HTMLElement>('[data-panel-title]');
    const body =
      this.container?.querySelector<HTMLElement>('[data-panel-body]');
    if (!panel || !heading || !body) return;
    heading.textContent = title;
    panel.classList.toggle('dc-panel-modal', modal);
    body.innerHTML = '';
    build(body);
    panel.hidden = false;
  }

  private closePanel(): void {
    const panel = this.container?.querySelector<HTMLElement>('[data-panel]');
    if (panel) panel.hidden = true;
  }

  /** Create or edit an entry of a flat or group entity. */
  private async openForm(
    entity: EntityDescriptor,
    entry?: Entry
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    const form = new EntityForm({
      entity,
      entry,
      translator: this.translator,
      pointerOptions: (
        branch: string
      ): Promise<{ dn: string; label: string }[]> =>
        this.api.pointerOptions(branch, this.entities),
      onCancel: (): void => this.closePanel(),
      onSubmit: async (
        values: Record<string, string | string[]>,
        cleared: string[]
      ): Promise<void> => {
        try {
          if (entry) {
            const id = String(entry[entity.mainAttribute] ?? '');
            await this.api.update(entity, id, values, cleared);
            this.toast(t('save.done'));
            this.closePanel();
            await this.renderMain();
          } else {
            const created = await this.api.create(entity, values as Entry);
            this.toast(t('create.done'));
            this.closePanel();
            const id = String(created[entity.mainAttribute] ?? '');
            this.go(`${entity.key}/${encodeURIComponent(id)}`);
          }
        } catch (err) {
          this.toast((err as Error).message, true);
        }
      },
    });

    this.openPanel(
      entry
        ? `${t('app.edit')} — ${String(entry[entity.mainAttribute] ?? '')}`
        : t('dashboard.create', { entity: this.singular(entity) }),
      (body: HTMLElement): void => {
        void form.render(body);
      },
      !form.wantsPanel
    );
  }

  /**
   * Organizations live in the tree, so their form writes through the
   * organization endpoints rather than the flat ones.
   */
  private async openOrganizationForm(
    entity: EntityDescriptor,
    entry?: Entry,
    parentDn?: string
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    const form = new EntityForm({
      entity,
      entry,
      translator: this.translator,
      pointerOptions: (
        branch: string
      ): Promise<{ dn: string; label: string }[]> =>
        this.api.pointerOptions(branch, this.entities),
      onCancel: (): void => this.closePanel(),
      onSubmit: async (
        values: Record<string, string | string[]>,
        cleared: string[]
      ): Promise<void> => {
        try {
          if (entry?.dn) {
            await this.api.updateOrganization(
              String(entry.dn),
              values as Record<string, string | string[]>,
              cleared
            );
            this.toast(t('save.done'));
          } else {
            await this.api.createOrganization(values, parentDn);
            this.toast(t('create.done'));
          }
          this.closePanel();
          this.tree?.invalidate();
          await this.renderMain();
        } catch (err) {
          this.toast((err as Error).message, true);
        }
      },
    });

    this.openPanel(
      entry
        ? `${t('app.edit')} — ${String(entry[entity.mainAttribute] ?? '')}`
        : t('dashboard.create', { entity: this.singular(entity) }),
      (body: HTMLElement): void => {
        void form.render(body);
      },
      !form.wantsPanel
    );
  }

  /* --------------------------------------------------------------- actions */

  private async setStatus(
    entity: EntityDescriptor,
    id: string,
    state: string
  ): Promise<void> {
    try {
      await this.api.setStatus(entity, id, state);
      this.toast(this.translator.t('status.changed', { state }));
      await this.renderMain();
    } catch (err) {
      this.toast((err as Error).message, true);
    }
  }

  /**
   * Reset a password. The generated one is shown once, in a message that stays
   * until it is dismissed — it cannot be read back afterwards.
   */
  private async resetPassword(
    entity: EntityDescriptor,
    id: string
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    this.openPanel(t('password.title'), body => {
      body.innerHTML = `
        <form class="dc-form">
          <div class="dc-field">
            <label for="dc-new-password">${escapeHtml(t('password.choose'))}</label>
            <input id="dc-new-password" class="dc-input" type="password"
              autocomplete="new-password" />
            <p class="dc-hint">${escapeHtml(t('password.generate'))}</p>
          </div>
          <div class="dc-field dc-field-inline">
            <input id="dc-force-change" type="checkbox" checked />
            <label for="dc-force-change">${escapeHtml(t('password.forceChange'))}</label>
          </div>
          <div class="dc-form-actions">
            <button type="button" class="dc-button" data-cancel>${escapeHtml(
              t('app.cancel')
            )}</button>
            <button type="submit" class="dc-button dc-button-primary">${escapeHtml(
              t('app.confirm')
            )}</button>
          </div>
        </form>`;

      body
        .querySelector('[data-cancel]')
        ?.addEventListener('click', () => this.closePanel());
      body.querySelector('form')?.addEventListener('submit', event => {
        event.preventDefault();
        const password =
          body.querySelector<HTMLInputElement>('#dc-new-password')?.value || '';
        const force =
          body.querySelector<HTMLInputElement>('#dc-force-change')?.checked ??
          true;
        void this.api
          .resetPassword(entity, id, password || undefined, force)
          .then(result => {
            this.closePanel();
            this.toast(
              result.generated && result.password
                ? t('password.generated', { password: result.password })
                : t('password.set'),
              false,
              result.generated
            );
          })
          .catch((err: Error) => this.toast(err.message, true));
      });
    });
  }

  private async confirmDelete(
    entity: EntityDescriptor,
    id: string
  ): Promise<void> {
    if (!window.confirm(this.translator.t('delete.confirm', { name: id })))
      return;
    try {
      await this.api.remove(entity, id);
      this.toast(this.translator.t('delete.done'));
      this.go(entity.key);
    } catch (err) {
      this.toast((err as Error).message, true);
    }
  }

  private async confirmDeleteOrganization(dn: string): Promise<void> {
    if (!window.confirm(this.translator.t('delete.confirm', { name: dn })))
      return;
    try {
      await this.api.deleteOrganization(dn);
      this.toast(this.translator.t('delete.done'));
      this.tree?.invalidate();
      await this.renderMain();
    } catch (err) {
      this.toast((err as Error).message, true);
    }
  }

  /**
   * Delete a selection, reporting each refusal on its own: a bulk action that
   * stops at the first error leaves the operator guessing which entries went.
   */
  private async deleteMany(
    entity: EntityDescriptor,
    ids: string[]
  ): Promise<void> {
    const t = (key: string, values?: Record<string, string | number>): string =>
      this.translator.t(key, values);
    if (ids.length === 0) return;
    if (!window.confirm(t('delete.confirmMany', { count: ids.length }))) return;

    const failures: string[] = [];
    for (const id of ids) {
      try {
        await this.api.remove(entity, id);
      } catch (err) {
        failures.push(
          t('delete.failed', { name: id, error: (err as Error).message })
        );
      }
    }
    this.toast(
      failures.length === 0 ? t('delete.done') : failures.join(' · '),
      failures.length > 0
    );
  }

  /** Show a short message; a sticky one waits to be dismissed. */
  private toast(message: string, isError = false, sticky = false): void {
    const toast = this.container?.querySelector<HTMLElement>('[data-toast]');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('dc-toast-error', isError);
    toast.hidden = false;
    if (sticky) {
      toast.onclick = (): void => {
        toast.hidden = true;
      };
      return;
    }
    window.setTimeout((): void => {
      toast.hidden = true;
    }, 5000);
  }
}
