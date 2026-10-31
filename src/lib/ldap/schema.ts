/**
 * The directory schema: where it lives, its index, how this server spells
 * attribute names, the object classes an entity declares and the repair a
 * write needs.
 */
import type { SearchOptions, SearchResult } from 'ldapts';
import { LRUCache } from 'lru-cache';

import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../ldapActions';
import { BadRequestError, NotFoundError } from '../errors';
import { parseSchema, SchemaIndex } from '../ldapSchema';
import { isDnInBranch, knownAttributeName, normalizeDn } from '../utils';

export interface SchemaLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type DirectorySearch = (
  options: SearchOptions,
  base: string
) => Promise<SearchResult | AsyncGenerator<SearchResult>>;

export interface DirectorySchemaOptions {
  logger: SchemaLogger;
  /** Run a search as the server itself. */
  search: DirectorySearch;
  /** Whether a modify may add the classes it needs. */
  autoRepair: () => boolean;
  /** How long the schema index is kept, in milliseconds. */
  schemaCacheTtl: () => number;
}

export default class DirectorySchema {
  private readonly logger: SchemaLogger;
  private readonly search: DirectorySearch;
  private readonly autoRepair: () => boolean;
  private readonly schemaCacheTtl: () => number;
  /** See {@link declareObjectClasses}. */
  private declaredClasses = new Map<
    string,
    { base: string; classes: string[]; includeBase: boolean }
  >();
  private schemaCache?: { index: SchemaIndex; fetchedAt: number };
  private schemaLoading?: Promise<SchemaIndex>;
  /** Whether the last schema read failed, so a failure is logged once. */
  private schemaUnavailable = false;
  /**
   * How this server spells attribute names, by name in lower case: the
   * configuration's, then the loaded schemas'. See {@link canonicalName}.
   */
  private spellings = new Map<string, string>();
  /** The first name given for each attribute type, to warn of another. */
  private spelledTypes = new Map<string, string>();
  /** Class problems already reported, per entry. See {@link warnOnce}. */
  private classWarnings = new LRUCache<string, true>({ max: 10000 });

  constructor(options: DirectorySchemaOptions) {
    this.logger = options.logger;
    this.search = options.search;
    this.autoRepair = options.autoRepair;
    this.schemaCacheTtl = options.schemaCacheTtl;
  }

  /**
   * Declare the object classes an entity gives the entries of its branch.
   *
   * An entry created by another tool may lack some of them, and a class it
   * lacks can forbid an attribute written here: the organization link of an
   * account made as a bare `inetOrgPerson` is refused by the directory. A
   * modify writing such an attribute adds the auxiliary class that allows
   * it, see {@link classRepair}.
   *
   * @param base branch holding the entity's entries
   * @param classes object classes the entity's schema declares; a schema
   * file may give a single one as a string
   * @param includeBase whether the base is itself one of the entries, as the
   * top organization is
   */
  declareObjectClasses(
    base: string,
    classes: string[] | string,
    includeBase = false
  ): void {
    const list = (Array.isArray(classes) ? classes : [classes]).filter(
      (name): name is string => typeof name === 'string' && name !== ''
    );
    if (!base || list.length === 0) return;
    // Keyed so that declaring again, as each new instance of an entity
    // does, adds nothing
    const key = JSON.stringify([
      normalizeDn(base),
      list.map(name => name.toLowerCase()).sort(),
      includeBase,
    ]);
    this.declaredClasses.set(key, { base, classes: list, includeBase });
  }

  /**
   * The classes declared for the branch holding a DN. Several entities may
   * share a branch — the shipped `users`, `posixAccounts` and
   * `sshPublicKeys` schemas all live in `ou=users` — so every declaration at
   * the deepest matching base counts.
   */
  private declaredFor(dn: string): string[] {
    let depth = 0;
    let classes: string[] = [];
    for (const declared of this.declaredClasses.values()) {
      if (!isDnInBranch(dn, declared.base)) continue;
      const base = normalizeDn(declared.base);
      if (!declared.includeBase && normalizeDn(dn) === base) continue;
      const here = base.split(',').length;
      if (here > depth) {
        depth = here;
        classes = [];
      }
      if (here === depth) classes.push(...declared.classes);
    }
    const seen = new Set<string>();
    return classes.filter(name => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Log a class problem of an entry once, not on every write to it: nothing
   * an administrator can do stops a sync job from touching it again.
   */
  private warnOnce(message: string): void {
    if (this.classWarnings.has(message)) return;
    this.classWarnings.set(message, true);
    this.logger.warn(message);
  }

  /**
   * The auxiliary classes a modify needs added: for each attribute it writes
   * that the entry's classes do not allow, a class declared for its branch
   * or by the writer that allows it, provided the entry holds or receives
   * that class's mandatory attributes once the change is applied.
   *
   * Only what the write needs is added. Entities sharing a branch declare
   * classes that are not all meant for every entry: `shadowAccount` is not
   * something every account should be given because it sits in `ou=users`.
   * And a write that the directory would have accepted is never changed.
   *
   * Nothing is added when the change names `objectClass` itself, and a
   * schema or entry that cannot be read skips the repair.
   *
   * @param dn entry being modified
   * @param changes the modification, after the hooks
   * @param extra classes the writer declares, see {@link ModifyOptions}
   * @returns names of the classes to add, or `allowed` when the entry's
   * classes take the change as it is
   */
  async classRepair(
    dn: string,
    changes: ModifyRequest,
    extra: string[] = []
  ): Promise<string[] | 'allowed'> {
    if (!this.autoRepair()) return [];
    const declared = [...this.declaredFor(dn)];
    for (const name of extra)
      if (!declared.some(d => d.toLowerCase() === name.toLowerCase()))
        declared.push(name);
    if (declared.length === 0) return [];
    const deleted = Array.isArray(changes.delete)
      ? changes.delete
      : Object.entries(changes.delete || {})
          // Deleting some values leaves the attribute in place.
          .filter(
            ([, value]) => !value || (Array.isArray(value) && !value.length)
          )
          .map(([name]) => name);
    const named = [
      ...Object.keys(changes.add || {}),
      ...Object.keys(changes.replace || {}),
      ...(Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete || {})),
    ];
    if (named.some(name => name.toLowerCase() === 'objectclass')) return [];

    let index: SchemaIndex;
    try {
      index = await this.schemaIndex();
      this.schemaUnavailable = false;
    } catch (err) {
      if (!this.schemaUnavailable)
        this.logger.warn(
          `Object classes are not repaired: the directory schema could not be read (${String(err)})`
        );
      this.schemaUnavailable = true;
      return [];
    }

    const attributeKey = (name: string): string =>
      index.getAttributeType(name)?.oid ?? name.toLowerCase();
    const allowedBy = (classes: string[]): Set<string> => {
      const { must, may } = index.resolveAttributes(classes);
      return new Set([...must, ...may].map(attributeKey));
    };
    // ldapts answers every attribute asked for, an absent one as empty; and
    // an empty `replace` removes the attribute.
    const valued = (list?: Record<string, unknown>): string[] =>
      Object.entries(list || {})
        .filter(([, value]) =>
          Array.isArray(value)
            ? value.length > 0
            : value !== undefined && value !== null && value !== ''
        )
        .map(([name]) => name);
    const written = [...valued(changes.add), ...valued(changes.replace)];

    // Declared auxiliary classes that could carry something this change
    // writes. None: the entry is not read at all.
    const auxiliaries = declared.filter(name => {
      const oc = index.getObjectClass(name);
      if (oc?.kind !== 'AUXILIARY') return false;
      const allows = allowedBy([name]);
      return written.some(attribute => allows.has(attributeKey(attribute)));
    });
    if (auxiliaries.length === 0) return [];

    let entry: AttributesList | undefined;
    try {
      const result = (await this.search(
        {
          paged: false,
          scope: 'base',
          attributes: [
            'objectClass',
            ...index.resolveAttributes(auxiliaries).must,
          ],
        },
        dn
      )) as SearchResult;
      entry = result.searchEntries[0];
    } catch {
      return [];
    }
    if (!entry) return [];

    const raw = entry.objectClass ?? entry.objectclass;
    const present = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const allowed = allowedBy(present);
    let needed = written.filter(
      attribute =>
        index.getAttributeType(attribute) &&
        !allowed.has(attributeKey(attribute))
    );
    if (needed.length === 0) return 'allowed';

    const gone = new Set(deleted.map(attributeKey));
    const held = new Set(
      [
        ...valued(entry).filter(name => !gone.has(attributeKey(name))),
        ...written,
      ].map(attributeKey)
    );
    const { auxiliary, structural } = index.missingClasses(declared, present);
    const added: string[] = [];
    for (const oc of auxiliary) {
      const name = oc.names[0] ?? oc.oid;
      const allows = allowedBy([name]);
      const covers = needed.filter(attribute =>
        allows.has(attributeKey(attribute))
      );
      if (covers.length === 0) continue;
      const lacking = index
        .resolveAttributes([name])
        .must.filter(attribute => !held.has(attributeKey(attribute)));
      if (lacking.length > 0) {
        this.warnOnce(
          `${dn} needs ${name} for ${covers.join(', ')}, and cannot be given it without ${lacking.join(', ')}`
        );
        continue;
      }
      added.push(name);
      needed = needed.filter(attribute => !covers.includes(attribute));
    }
    const blocking = structural.filter(name => {
      const allows = allowedBy([name]);
      return needed.some(attribute => allows.has(attributeKey(attribute)));
    });
    if (blocking.length > 0)
      this.warnOnce(
        `${dn} cannot hold ${needed.join(', ')}: its schema declares ${blocking.join(', ')}, a structural class an existing entry cannot be given`
      );
    if (added.length > 0)
      this.logger.info(
        `${dn}: adding ${added.join(', ')}, which the change needs and its schema declares`
      );
    return added;
  }

  /**
   * DN of the subschema entry the root DSE advertises, or the conventional
   * `cn=Subschema` when it advertises none.
   */
  async subschemaDn(): Promise<string> {
    try {
      const result = (await this.search(
        {
          paged: false,
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: ['subschemaSubentry'],
        },
        ''
      )) as SearchResult;
      const value = result.searchEntries[0]?.subschemaSubentry;
      const dn = Array.isArray(value) ? value[0] : value;
      if (dn) return String(dn);
    } catch (err) {
      this.logger.warn(
        `Unable to read subschemaSubentry from root DSE: ${String(err)}`
      );
    }
    return 'cn=Subschema';
  }

  /**
   * The directory schema, kept for `--ldap-raw-schema-cache-ttl`: it is
   * large and changes rarely. The raw browser and the object class repair
   * share it, and concurrent callers share a single read.
   *
   * @returns indexed schema
   */
  async schemaIndex(): Promise<SchemaIndex> {
    const maxAge = this.schemaCacheTtl();
    if (this.schemaCache && Date.now() - this.schemaCache.fetchedAt < maxAge)
      return this.schemaCache.index;
    if (this.schemaLoading) return this.schemaLoading;

    this.schemaLoading = (async (): Promise<SchemaIndex> => {
      const dn = await this.subschemaDn();
      const result = (await this.search(
        {
          paged: false,
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: [
            'objectClasses',
            'attributeTypes',
            'ldapSyntaxes',
            'matchingRules',
          ],
        },
        dn
      ).catch((err: unknown) => {
        if ((err as { code?: number })?.code === 32)
          throw new NotFoundError(`Subschema entry ${dn} not found`);
        throw err;
      })) as SearchResult;
      const entry = result.searchEntries[0];
      if (!entry) throw new NotFoundError(`Subschema entry ${dn} not found`);

      const list = (value: AttributeValue | undefined): string[] => {
        if (value === undefined) return [];
        const values: (Buffer | string)[] = Array.isArray(value)
          ? value
          : [value];
        return values.map(v => (Buffer.isBuffer(v) ? v.toString('utf8') : v));
      };
      const index = new SchemaIndex(
        parseSchema({
          objectClasses: list(entry.objectClasses),
          attributeTypes: list(entry.attributeTypes),
          ldapSyntaxes: list(entry.ldapSyntaxes),
          matchingRules: list(entry.matchingRules),
        })
      );
      this.schemaCache = { index, fetchedAt: Date.now() };
      this.logger.info(
        `LDAP schema loaded from ${dn}: ` +
          `${index.schema.objectClasses.length} object classes, ` +
          `${index.schema.attributeTypes.length} attribute types`
      );
      return index;
    })();

    try {
      return await this.schemaLoading;
    } finally {
      this.schemaLoading = undefined;
    }
  }

  /**
   * Say how this server spells attribute names: a schema loaded by a plugin
   * names its attributes as the plugins compare them. The first spelling of
   * a name wins.
   *
   * @param names attribute names
   */
  knowAttributeNames(names: Iterable<string>): void {
    for (const name of names) {
      if (!name || name.includes(';')) continue;
      const key = name.toLowerCase();
      if (!this.spellings.has(key)) this.spellings.set(key, name);
      // A plugin comparing with the other spelling, or the other name of
      // the type, would miss the writes. The aliases a deployment's own
      // schema declares are not known here
      const type = (knownAttributeName(name) ?? name).toLowerCase();
      const known = this.spelledTypes.get(type);
      if (known === undefined) this.spelledTypes.set(type, name);
      else if (known !== name)
        this.logger.warn(
          `Attribute "${name}" is also named "${known}" in the configuration ` +
            'or a schema: plugins comparing with one name miss the other'
        );
    }
  }

  /**
   * Name each attribute of a write as this server does, in place.
   *
   * The directory takes `MAIL`, `rfc822Mailbox` and `0.9.2342.19200300.100.1.3`
   * for `mail`, while the authorization plugins and the hooks look for
   * `mail`: a write naming the organization link by its OID was judged as
   * if it left the link alone. Each name is resolved through the directory
   * schema — case, aliases, OIDs — and written as the configuration or a
   * loaded schema spells it, or as the directory declares it first.
   *
   * An option names a value of its own (`member;lang-en` is not `member` to
   * the hooks guarding `member`), and is refused, `;binary` aside. Two names
   * for one attribute in one part of a write are refused too: on a modify
   * the directory applies both, and only one would have been judged.
   *
   * Without the schema, the case is still set, and a name given as an OID,
   * which nothing here could resolve, is refused. So is, with or without
   * it, a name that is neither a descriptor nor a numeric OID.
   *
   * @param entry attributes of an add, or one part of a modify
   * @throws BadRequestError on an option, on a name that describes no
   * attribute, or on one attribute named twice
   */
  async canonicalAttributes(entry: AttributesList | undefined): Promise<void> {
    if (!entry) return;
    const keys = Object.keys(entry);
    const names = await this.canonicalNames(keys);
    if (keys.every((key, i) => key === names[i])) return;
    const values = keys.map(key => entry[key]);
    for (const key of keys) delete entry[key];
    names.forEach((name, i) => (entry[name] = values[i]));
  }

  /**
   * {@link canonicalAttributes} for every part of a modify, in place.
   *
   * @param changes the modify
   * @throws BadRequestError as {@link canonicalAttributes}
   */
  async canonicalChanges(changes: ModifyRequest | undefined): Promise<void> {
    if (!changes) return;
    await this.canonicalAttributes(changes.add);
    await this.canonicalAttributes(changes.replace);
    if (Array.isArray(changes.delete))
      changes.delete = await this.canonicalNames(changes.delete);
    else await this.canonicalAttributes(changes.delete);
  }

  /**
   * The names of one part of a write, as {@link canonicalAttributes} writes
   * them.
   */
  private async canonicalNames(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return keys;
    let index: SchemaIndex | undefined;
    try {
      index = await this.schemaIndex();
      this.schemaUnavailable = false;
    } catch (err) {
      // One warning for both its uses, this and the class repair
      if (!this.schemaUnavailable)
        this.logger.warn(
          `The directory schema could not be read (${String(err)}): ` +
            'attribute names are resolved from the standard types only, a ' +
            'name given as another OID is refused, and object classes are ' +
            'not repaired'
        );
      this.schemaUnavailable = true;
    }
    const seen = new Map<string, string>();
    return keys.map(key => {
      const name = this.canonicalName(key, index);
      const same = seen.get(name.toLowerCase());
      if (same !== undefined)
        throw new BadRequestError(
          `"${same}" and "${key}" name the same attribute`
        );
      seen.set(name.toLowerCase(), key);
      return name;
    });
  }

  /**
   * One attribute description, named as this server does.
   *
   * @param key the name as written, options included
   * @param index the directory schema, when it could be read
   */
  private canonicalName(key: string, index?: SchemaIndex): string {
    const [written, ...options] = key.split(';');
    // `OID.2.5.4.3`, the LDAPv2 spelling of an OID
    const base = written.replace(/^oid\./i, '');
    const option = options.find(o => o.toLowerCase() !== 'binary');
    if (option !== undefined)
      throw new BadRequestError(
        `Attribute option "${option}" of "${key}" is not accepted`
      );
    // A descriptor or a numeric OID (RFC 4512 §1.4), nothing else: the names
    // below are copied to a new key of the body, and `__proto__` would be
    // its prototype
    if (!/^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)$/.test(base))
      throw new BadRequestError(`"${key}" is not an attribute description`);
    const type = index?.getAttributeType(base);
    // Without the schema, the names and OIDs this server knows of itself
    const builtIn = index ? undefined : knownAttributeName(base);
    if (!index && !builtIn && /^\d+(\.\d+)+$/.test(base))
      throw new BadRequestError(
        `Attribute "${key}" cannot be named by its OID here`
      );
    const known = type
      ? [...type.names, type.oid]
      : [base, ...(builtIn ? [builtIn] : [])];
    const name =
      known.map(n => this.spellings.get(n.toLowerCase())).find(Boolean) ??
      type?.names[0] ??
      builtIn ??
      base;
    return options.length ? `${name};binary` : name;
  }
}
