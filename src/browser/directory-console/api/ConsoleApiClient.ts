/**
 * REST client of the directory console.
 *
 * It discovers what the server offers instead of assuming it: the entity list,
 * their schemas and their endpoints all come from `GET /v1/config`, and the
 * caller's own rights from `GET /v1/authz/scope`.
 *
 * @module browser/directory-console/api/ConsoleApiClient
 */

import type {
  EntityDescriptor,
  EntitySchema,
  Entry,
  LocalizedText,
  OrganizationNode,
  Scope,
  SchemaAttribute,
} from '../types';

interface FlatResource {
  name: string;
  singularName: string;
  pluralName: string;
  label?: LocalizedText;
  singularLabel?: LocalizedText;
  mainAttribute: string;
  base: string;
  schema: EntitySchema;
}

interface ConfigResponse {
  apiPrefix: string;
  ldapBase: string;
  features: {
    ldapFlatGeneric?: { flatResources?: FlatResource[] };
    ldapGroups?: {
      enabled?: boolean;
      base?: string;
      mainAttribute?: string;
      schema?: EntitySchema;
    };
    ldapOrganizations?: {
      enabled?: boolean;
      topOrganization?: string;
      organizationClass?: string[];
      pathSeparator?: string;
      schema?: EntitySchema;
    };
  };
}

/** Tell whether an attribute carries a role, single or among several. */
export function hasRole(
  attr: SchemaAttribute | undefined,
  role: string
): boolean {
  if (!attr?.role) return false;
  return Array.isArray(attr.role)
    ? attr.role.includes(role)
    : attr.role === role;
}

/** Name of the attribute carrying a role, if any. */
export function roleAttribute(
  schema: EntitySchema | undefined,
  role: string
): string | undefined {
  if (!schema) return undefined;
  for (const [name, attr] of Object.entries(schema.attributes || {}))
    if (hasRole(attr, role)) return name;
  return undefined;
}

/** Organizations walked before a pointer listing stops asking for more. */
const ORGANIZATION_OPTION_LIMIT = 200;

/**
 * The class `organizations` searches its own children on, and the one value
 * its `subnodes` endpoint understands as "child organizations only".
 */
const ORGANIZATION_CLASS = 'organizationalUnit';

export class ConsoleApiClient {
  private readonly origin: string;
  private apiPrefix = '/api';
  private ldapBase = '';
  private pathSeparator = ' / ';
  private topOrganization?: string;
  /** Attribute carrying the readable path of an organization, from its role */
  private organizationPathAttribute?: string;
  /** Object classes that make an entry an organization rather than a member */
  private organizationClasses: string[] = [];
  /**
   * Whether the API lives on another origin than the page. `same-origin`
   * attaches no cookie to a cross-origin request, so a deployment that points
   * the console at its own API host would be answered `401` on every call —
   * a session it holds and does not send. Such a deployment has to allow the
   * origin and credentials in its CORS policy either way.
   */
  private readonly crossOrigin: boolean;

  constructor(apiBaseUrl?: string, apiPrefix?: string) {
    const own = typeof window !== 'undefined' ? window.location.origin : '';
    this.origin = apiBaseUrl ?? own;
    this.crossOrigin = this.origin !== '' && this.origin !== own;
    // Everything else is asked at the prefix the configuration advertises;
    // the request that reads that configuration cannot be, so a server
    // started with `--api-prefix /ldap` has to be told once.
    if (apiPrefix) this.apiPrefix = apiPrefix;
  }

  /** Separator the directory puts between the segments of an organization path. */
  get organizationPathSeparator(): string {
    return this.pathSeparator;
  }

  /** Root of the organization tree, when the server serves one. */
  get organizationRoot(): string | undefined {
    return this.topOrganization;
  }

  /**
   * Issue a request and turn a failure into an `Error` carrying the server's
   * own message — the API explains what it refused and why, and repeating that
   * verbatim is more useful than any wording invented here.
   */
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      credentials: this.crossOrigin ? 'include' : 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        (payload as { error?: string } | null)?.error ||
        `${response.status} ${response.statusText}`;
      const error = new Error(message) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return payload as T;
  }

  /**
   * Read the server's configuration and turn it into the entity list the
   * console navigates.
   *
   * @returns one descriptor per entity the server exposes
   */
  async discover(): Promise<EntityDescriptor[]> {
    const config = await this.call<ConfigResponse>(
      `${this.apiPrefix}/v1/config`
    );
    this.apiPrefix = config.apiPrefix || this.apiPrefix;
    this.ldapBase = config.ldapBase || '';
    const entities: EntityDescriptor[] = [];

    for (const resource of config.features.ldapFlatGeneric?.flatResources ||
      []) {
      if (!resource.schema?.attributes) continue;
      entities.push(
        this.describe({
          key: resource.pluralName,
          pluralName: resource.pluralName,
          singularName: resource.singularName,
          label: resource.label ?? resource.schema.entity?.label,
          singularLabel:
            resource.singularLabel ?? resource.schema.entity?.singularLabel,
          mainAttribute: resource.mainAttribute,
          base: resource.base,
          schema: resource.schema,
          endpoint: `${this.apiPrefix}/v1/ldap/${resource.pluralName}`,
          kind: 'flat',
        })
      );
    }

    const groups = config.features.ldapGroups;
    if (groups?.enabled && groups.schema?.attributes) {
      entities.push(
        this.describe({
          key: 'groups',
          pluralName: 'groups',
          singularName: 'group',
          label: groups.schema.entity?.label,
          singularLabel: groups.schema.entity?.singularLabel,
          mainAttribute: groups.mainAttribute || 'cn',
          base: groups.base || '',
          schema: groups.schema,
          endpoint: `${this.apiPrefix}/v1/ldap/groups`,
          kind: 'group',
        })
      );
    }

    const organizations = config.features.ldapOrganizations;
    if (organizations?.enabled) {
      this.pathSeparator = organizations.pathSeparator || ' / ';
      this.topOrganization = organizations.topOrganization;
      this.organizationPathAttribute = roleAttribute(
        organizations.schema,
        'organizationPath'
      );
      this.organizationClasses = (organizations.organizationClass || [])
        .filter(name => name.toLowerCase() !== 'top')
        .map(name => name.toLowerCase());
      if (organizations.schema?.attributes) {
        entities.push(
          this.describe({
            key: 'organizations',
            pluralName: 'organizations',
            singularName: 'organization',
            label: organizations.schema.entity?.label,
            singularLabel: organizations.schema.entity?.singularLabel,
            mainAttribute: 'ou',
            base: organizations.topOrganization || '',
            schema: organizations.schema,
            endpoint: `${this.apiPrefix}/v1/ldap/organizations`,
            kind: 'organization',
          })
        );
      }
    }

    return entities;
  }

  /** Fill in the role-derived fields of a descriptor. */
  private describe(
    base: Omit<
      EntityDescriptor,
      'organizationLink' | 'organizationPath' | 'accountStatus' | 'password'
    >
  ): EntityDescriptor {
    return {
      ...base,
      organizationLink: roleAttribute(base.schema, 'organizationLink'),
      organizationPath: roleAttribute(base.schema, 'organizationPath'),
      accountStatus: roleAttribute(base.schema, 'accountStatus'),
      password: roleAttribute(base.schema, 'password'),
    };
  }

  /**
   * The caller's administration scope, or null when the server serves none.
   *
   * A `404` is the answer of a server that does not load `auth/authzScope`:
   * it has no scope to give, which is not the same thing as refusing to give
   * one. Every other failure is raised, because reading it as "unrestricted"
   * would show a caller who was just told `401` every button on the console.
   */
  async scope(): Promise<Scope | null> {
    try {
      return await this.call<Scope>(`${this.apiPrefix}/v1/authz/scope`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /**
   * List the entries of an entity, optionally narrowed by a substring on one
   * attribute.
   *
   * @param entity entity to list
   * @param search substring to look for
   * @param attribute attribute the substring applies to
   * @returns the entries, keyed by their identifier
   */
  async list(
    entity: EntityDescriptor,
    search?: string,
    attribute?: string
  ): Promise<Record<string, Entry>> {
    const params = new URLSearchParams();
    if (search && attribute) {
      params.set('match', search);
      params.set('attribute', attribute);
    }
    const query = params.toString();
    return this.call<Record<string, Entry>>(
      `${entity.endpoint}${query ? `?${query}` : ''}`
    );
  }

  /** Read one entry. */
  async get(entity: EntityDescriptor, id: string): Promise<Entry> {
    return this.call<Entry>(`${entity.endpoint}/${encodeURIComponent(id)}`);
  }

  /** Create an entry, and return it as stored. */
  async create(entity: EntityDescriptor, values: Entry): Promise<Entry> {
    return this.call<Entry>(entity.endpoint, {
      method: 'POST',
      body: JSON.stringify(values),
    });
  }

  /** Replace the given attributes of an entry. */
  async update(
    entity: EntityDescriptor,
    id: string,
    replace: Record<string, string | string[]>,
    remove: string[] = []
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (Object.keys(replace).length) body.replace = replace;
    if (remove.length) body.delete = remove;
    if (!Object.keys(body).length) return;
    await this.call(`${entity.endpoint}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /** Delete an entry. */
  async remove(entity: EntityDescriptor, id: string): Promise<void> {
    await this.call(`${entity.endpoint}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Move an entry to another organization. */
  async move(
    entity: EntityDescriptor,
    id: string,
    targetOrgDn: string
  ): Promise<void> {
    await this.call(`${entity.endpoint}/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ targetOrgDn }),
    });
  }

  /** Move an account to one of the states its schema declares. */
  async setStatus(
    entity: EntityDescriptor,
    id: string,
    state: string
  ): Promise<void> {
    await this.call(`${entity.endpoint}/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ state }),
    });
  }

  /**
   * Reset an account's credential.
   *
   * @returns the generated password, when the server chose one
   */
  async resetPassword(
    entity: EntityDescriptor,
    id: string,
    password?: string,
    forceChange = true
  ): Promise<{ generated: boolean; password?: string }> {
    return this.call<{ generated: boolean; password?: string }>(
      `${entity.endpoint}/${encodeURIComponent(id)}/password`,
      {
        method: 'POST',
        body: JSON.stringify({ password, forceChange }),
      }
    );
  }

  /** Top of the organization tree. */
  async organizationTop(): Promise<OrganizationNode | null> {
    try {
      const entry = await this.call<Entry>(
        `${this.apiPrefix}/v1/ldap/organizations/top`
      );
      return entry?.dn ? this.toNode(entry) : null;
    } catch {
      return null;
    }
  }

  /**
   * What the directory hangs under an organization: its child organizations
   * *and* the entries attached to it.
   *
   * Asked whole, the answer caps the attached entries at
   * `ldap_organization_max_subnodes` and appends a `moreIndicator` row
   * counting the rest. Asked for one class, it drops the attached entries
   * altogether — and with them the cap and the indicator.
   *
   * @param dn organization to read
   * @param objectClass class to restrict the answer to
   * @returns the raw entries
   */
  private async subnodes(dn: string, objectClass?: string): Promise<Entry[]> {
    const filter = objectClass
      ? `?objectClass=${encodeURIComponent(objectClass)}`
      : '';
    return (
      (await this.call<Entry[]>(
        `${this.apiPrefix}/v1/ldap/organizations/${encodeURIComponent(dn)}` +
          `/subnodes${filter}`
      )) || []
    );
  }

  /**
   * Tell an organization apart from an entry merely attached to one. The
   * subnodes endpoint returns both, and a tree that shows accounts as branches
   * of the org chart is worse than no tree at all.
   *
   * @param entry entry to classify
   * @returns true when the entry is itself an organization
   */
  private isOrganization(entry: Entry): boolean {
    const classes = (
      Array.isArray(entry.objectClass)
        ? entry.objectClass
        : [entry.objectClass ?? '']
    ).map(name => String(name).toLowerCase());
    if (this.organizationClasses.length)
      return this.organizationClasses.some(name => classes.includes(name));
    // No class list configured: fall back to the shape of the DN.
    return /^ou=/i.test(String(entry.dn || ''));
  }

  /**
   * Direct child organizations of an organization.
   *
   * The endpoint searches its own children on `organizationalUnit` whatever
   * it is asked, so that is the class to ask for; the class list a deployment
   * declares is what tells an *attached* entry apart, below.
   */
  async organizationChildren(dn: string): Promise<OrganizationNode[]> {
    return (await this.subnodes(dn, ORGANIZATION_CLASS)).map(entry =>
      this.toNode(entry)
    );
  }

  /**
   * Entries attached to an organization without being one — the accounts and
   * groups that answer "who is in this department?".
   *
   * @param dn organization to read
   * @returns DN and readable name of each attached entry
   */
  async organizationMembers(
    dn: string
  ): Promise<{ dn: string; label: string }[]> {
    return (await this.subnodes(dn))
      .filter(entry => !this.isOrganization(entry))
      .map(entry => ({
        dn: String(entry.dn || ''),
        label: String(entry.dn || '')
          .split(',')[0]
          .replace(/^[^=]+=/, ''),
      }));
  }

  /** Read one organization. */
  async organization(dn: string): Promise<Entry> {
    return this.call<Entry>(
      `${this.apiPrefix}/v1/ldap/organizations/${encodeURIComponent(dn)}`
    );
  }

  /** Create an organization, optionally under a parent. */
  async createOrganization(
    values: Record<string, unknown>,
    parentDn?: string
  ): Promise<void> {
    await this.call(`${this.apiPrefix}/v1/ldap/organizations`, {
      method: 'POST',
      body: JSON.stringify(parentDn ? { ...values, parentDn } : values),
    });
  }

  /** Replace the given attributes of an organization. */
  async updateOrganization(
    dn: string,
    replace: Record<string, string | string[]>,
    remove: string[] = []
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (Object.keys(replace).length) body.replace = replace;
    if (remove.length) body.delete = remove;
    if (!Object.keys(body).length) return;
    await this.call(
      `${this.apiPrefix}/v1/ldap/organizations/${encodeURIComponent(dn)}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
  }

  /** Delete an organization. */
  async deleteOrganization(dn: string): Promise<void> {
    await this.call(
      `${this.apiPrefix}/v1/ldap/organizations/${encodeURIComponent(dn)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Entries of a branch, for a pointer field. The branch is a raw DN, so the
   * console reads it through the low-level browsing API when it is available
   * and falls back to the entity that owns the branch otherwise.
   *
   * @param branch DN the pointer must land in
   * @param entities entities the console knows, to find one covering the branch
   * @returns DN and label of every candidate
   */
  async pointerOptions(
    branch: string,
    entities: EntityDescriptor[]
  ): Promise<{ dn: string; label: string }[]> {
    // An organization pointer names the whole tree, which no flat listing
    // covers: walk it instead, so the department field of an account is
    // filled from the organizations themselves.
    if (
      this.topOrganization &&
      (branch.toLowerCase() === this.topOrganization.toLowerCase() ||
        this.topOrganization.toLowerCase().endsWith(`,${branch.toLowerCase()}`))
    ) {
      return this.organizationOptions();
    }

    const owner = entities.find(
      entity =>
        entity.base && branch.toLowerCase() === entity.base.toLowerCase()
    );
    if (owner) {
      const list = await this.list(owner);
      return Object.entries(list).map(([id, entry]) => ({
        dn: String(entry.dn || id),
        label: id,
      }));
    }
    // An unknown branch: ask the raw browser, which every deployment that
    // enables it serves, and give up quietly when it is not there.
    try {
      const answer = await this.call<{
        children?: { dn: string; rdn: string }[];
      }>(
        `${this.apiPrefix}/v1/ldap/raw/children/${encodeURIComponent(branch)}`
      );
      return (answer.children || []).map(child => ({
        dn: child.dn,
        label: child.rdn.replace(/^[^=]+=/, ''),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Every organization, as pointer candidates labelled by their readable path.
   *
   * The walk is breadth-first and bounded: a directory with a very wide tree
   * should not turn opening a form into hundreds of requests.
   *
   * @returns DN and label of each organization found
   */
  private async organizationOptions(): Promise<
    { dn: string; label: string }[]
  > {
    const root = await this.organizationTop();
    if (!root) return [];
    const options: { dn: string; label: string }[] = [];
    const queue: OrganizationNode[] = [root];
    let visited = 0;
    while (queue.length > 0 && visited < ORGANIZATION_OPTION_LIMIT) {
      const node = queue.shift() as OrganizationNode;
      visited++;
      options.push({ dn: node.dn, label: node.path || node.name });
      try {
        queue.push(...(await this.organizationChildren(node.dn)));
      } catch {
        // A branch the caller may not read is simply not offered.
      }
    }
    return options;
  }

  /** Turn an organization entry into a tree node. */
  private toNode(entry: Entry): OrganizationNode {
    const dn = String(entry.dn || '');
    const value = (name: string): string | undefined => {
      const raw = entry[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    return {
      dn,
      name:
        value('ou') || value('o') || dn.split(',')[0].replace(/^[^=]+=/, ''),
      path: this.organizationPathAttribute
        ? value(this.organizationPathAttribute)
        : undefined,
    };
  }

  /** Base DN of the directory, for display. */
  get base(): string {
    return this.ldapBase;
  }
}
