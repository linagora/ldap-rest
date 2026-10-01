/**
 * @module plugins/twake/instances
 *
 * Gives every account this server creates its workplace instance, once its
 * entry is written, from the Cloudery or from the cozy-stack admin API. The
 * address is written once the instance exists, then `user.created` is
 * published and the entry marked. The event is sent at least once.
 *
 * See `docs/usage/plugins/integrations/instances.md`.
 */
import type { Express, Request } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { jsonBody } from '../../lib/expressFormatedResponses';
import {
  ClouderyProvider,
  CozyStackProvider,
  type InstanceProvider,
  type InstanceRequest,
} from '../../lib/instanceProviders';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { extractLdapCode } from '../../lib/ldapCodes';
import {
  asyncHandler,
  escapeDnValue,
  escapeLdapFilter,
  escapeRegex,
  rdnValue,
  unescapeDnValue,
} from '../../lib/utils';
import type RabbitMq from '../rabbitmq';

import {
  isTombstone,
  lifecycleAttributes,
  type LifecycleAttributes,
} from './lifecycleAttributes';

export interface WorkplaceCreated {
  twakeId?: string;
  internalEmail?: string;
  workplaceFqdn?: string;
}

/** An account's instance request, and the id `user.created` names it by. */
interface Account extends InstanceRequest {
  twakeId: string;
}

const first = (value: unknown): string | undefined => {
  const one = (Array.isArray(value) ? value[0] : value) as
    | string
    | Buffer
    | undefined;
  const text = one === undefined || one === null ? '' : one.toString();
  return text || undefined;
};

const REPLACED = /(^|\/)twake\/(cozy|cloudery)Provision(\.js)?$/;

export default class TwakeInstances extends DmPlugin {
  name = 'twakeInstances';
  roles: Role[] = ['consistency', 'api'] as const;

  dependencies = { rabbitmq: 'core/rabbitmq' };

  protected readonly patterns: RegExp[];
  protected readonly provider: InstanceProvider;
  protected readonly fqdnAttribute: string;
  protected readonly sentAttribute: string;
  private readonly locale: string;
  private readonly lifecycle: LifecycleAttributes;
  /** Work on one account, or organization, waits for the work before it */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(server: DM) {
    super(server);
    const cfg = this.config;
    const replaced = (cfg.plugin || []).find(p => REPLACED.test(p));
    if (replaced)
      throw new Error(
        `${this.name}: ${replaced} gives accounts their instance too; load one of them`
      );
    this.patterns = (cfg.twake_instance_dn || []).map(p => new RegExp(p, 'i'));
    const groups = new Set(['uid']);
    for (const p of this.patterns)
      for (const [, name] of p.source.matchAll(/\(\?<(\w+)>/g))
        groups.add(name);
    for (const [, name] of (cfg.twake_instance_id || '{uid}').matchAll(
      /\{(\w+)\}/g
    ))
      if (!groups.has(name))
        throw new Error(
          `${this.name}: --twake-instance-id names {${name}}, which no --twake-instance-dn group captures`
        );
    this.lifecycle = lifecycleAttributes(cfg);
    this.fqdnAttribute =
      cfg.twake_instance_fqdn_attribute || 'twakeWorkspaceUrl';
    this.sentAttribute =
      cfg.twake_instance_sent_attribute || 'twakeCreatedEventAt';
    const timeout = cfg.twake_instance_timeout || 30000;
    if (cfg.twake_instance_provider === 'cozy-stack') {
      if (!cfg.twake_instance_cozy_url || !cfg.twake_instance_cozy_domain)
        throw new Error(
          `${this.name}: --twake-instance-cozy-url and --twake-instance-cozy-domain are required`
        );
      this.provider = new CozyStackProvider(
        cfg.twake_instance_cozy_url.replace(/\/$/, ''),
        cfg.twake_instance_cozy_user || 'admin',
        cfg.twake_instance_cozy_passphrase || '',
        cfg.twake_instance_cozy_domain,
        cfg.twake_instance_cozy_context || '',
        cfg.twake_instance_cozy_apps || '',
        timeout
      );
      this.locale = cfg.twake_instance_locale || 'fr';
    } else if (cfg.twake_instance_provider === 'cloudery') {
      if (
        !cfg.twake_instance_cloudery_url ||
        !cfg.twake_instance_cloudery_domain
      )
        throw new Error(
          `${this.name}: --twake-instance-cloudery-url and --twake-instance-cloudery-domain are required`
        );
      this.provider = new ClouderyProvider(
        cfg.twake_instance_cloudery_url.replace(/\/$/, ''),
        cfg.twake_instance_cloudery_token || '',
        cfg.twake_instance_cloudery_domain,
        cfg.twake_instance_cloudery_offer || '',
        timeout
      );
      this.locale = cfg.twake_instance_locale || 'en';
    } else {
      throw new Error(
        `${this.name}: --twake-instance-provider must be cloudery or cozy-stack`
      );
    }
  }

  hooks: Hooks = {
    // The address and the mark are this plugin's to write: one supplied by
    // the caller would skip the provider, or the event
    ldapaddrequest: ([dn, entry, req]) => {
      if (this.patterns.some(p => p.test(dn)) || this.isOrganization(dn)) {
        const owned = [
          this.fqdnAttribute,
          this.sentAttribute,
          this.organizationFqdn,
        ].map(a => a.toLowerCase());
        for (const key of Object.keys(entry))
          if (owned.includes(key.toLowerCase())) delete entry[key];
      }
      return [dn, entry, req];
    },
    ldapaddafter: async ([dn, entry]) => {
      const org = this.organizationOf(dn);
      if (org)
        await this.serialized(`organization:${org}`, async () => {
          try {
            await this.giveOrganizationAddress(org);
          } catch (err) {
            this.logger.error({
              plugin: this.name,
              event: 'organization account',
              dn,
              error: String(err),
            });
          }
        });
      const account = this.account(dn, entry);
      if (!account) return;
      await this.serialized(dn, async () => {
        try {
          await this.provide(dn, entry, account);
        } catch (err) {
          this.logger.error({
            plugin: this.name,
            event: 'create',
            dn,
            error: String(err),
          });
        }
      });
    },
    ldapdeletedone: async dns => {
      const provider = this.provider;
      if (!(provider instanceof CozyStackProvider)) return;
      for (const dn of Array.isArray(dns) ? dns : [dns]) {
        const match = this.match(dn);
        const uid = /^uid=/i.test(dn) ? rdnValue(dn) : '';
        if (!match || !uid) continue;
        // Queued before a re-create of the same DN, whose add comes after
        await this.serialized(dn, async () => {
          try {
            await provider.destroy(this.id(uid, match), uid);
          } catch (err) {
            this.logger.error({
              plugin: this.name,
              event: 'destroy',
              dn,
              error: String(err),
            });
          }
        });
      }
    },
  };

  /**
   * Without a broker `user.created` could not be sent, and with the Cloudery
   * no address would ever arrive: the server does not start.
   */
  async api(app: Express): Promise<void> {
    const rabbitmq = this.requirePlugin<RabbitMq>('rabbitmq');
    if (!rabbitmq || !(await rabbitmq.getRawClient()))
      throw new Error(`${this.name}: RabbitMQ is required and unreachable`);
    // Without them every add would stay pending, with an error log only
    const schema = await this.server.ldap.schemaIndex();
    const missing = [
      this.fqdnAttribute,
      this.sentAttribute,
      ...(this.config.twake_instance_organization_base
        ? [
            this.organizationDomain,
            this.organizationFqdn,
            this.organizationName,
          ]
        : []),
    ].filter(a => a && !schema.getAttributeType(a));
    if (missing.length)
      throw new Error(
        `${this.name}: the directory schema defines no ${missing.join(', ')}; load a schema that does, or name other attributes`
      );
    if (
      this.organizationFqdn &&
      this.organizationFqdn.toLowerCase() ===
        this.organizationName.toLowerCase()
    )
      throw new Error(
        `${this.name}: an organization's name and address cannot share the attribute ${this.organizationName}`
      );
    /**
     * @openapi
     * summary: Make sure an account has its workplace instance
     * description: |
     *   Writes a missing address and announces the account when its instance
     *   exists, and asks for the instance when it does not. Answers `ready`
     *   once the address is written, `pending` while the instance is built.
     *   The caller reads and writes the account with its own rights.
     * tags:
     *   - Twake
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         description: The account, by DN or by mail.
     *         properties:
     *           dn: { type: string }
     *           mail: { type: string }
     * responses:
     *   '200':
     *     description: Done or under way.
     *     content:
     *       application/json:
     *         example: { state: ready }
     *   '400':
     *     description: Neither a DN nor a mail, or a malformed one.
     *   '404':
     *     description: No such account the caller can read.
     */
    app.post(
      `${this.config.api_prefix}/v1/twake/instances/ensure`,
      asyncHandler(async (req, res) => {
        const body = jsonBody(req, res) as
          | { dn?: unknown; mail?: unknown }
          | undefined
          | false;
        if (body === false) return;
        let dn = body?.dn;
        if (dn === undefined && typeof body?.mail === 'string' && body.mail) {
          const found = await this.findByMail(body.mail, req);
          if (!found) throw new NotFoundError(`No account for ${body.mail}`);
          dn = found.dn;
        }
        if (typeof dn !== 'string' || !dn)
          throw new BadRequestError('Give the account as dn or mail');
        res.json({ state: await this.ensureInstance(dn, req) });
      })
    );
    if (!(this.provider instanceof ClouderyProvider)) return;
    await rabbitmq.subscribe(
      this.config.twake_instance_auth_exchange || 'auth',
      this.config.twake_instance_workplace_created_key || 'workplace.created',
      this.config.twake_instance_queue || 'workplace.created.ldap-rest',
      message => this.onWorkplaceCreated(message as WorkplaceCreated)
    );
  }

  /**
   * Make sure this account has its instance: covers a refused or lost
   * creation, and a `workplace.created` that never arrived. With a request,
   * the account is read and written with the caller's rights.
   */
  async ensureInstance(
    dn: string,
    req?: Request
  ): Promise<'ready' | 'pending'> {
    return this.serialized(dn, async () => {
      const entry = await this.read(dn, req);
      if (!entry) throw new NotFoundError(`No entry at ${dn}`);
      const account = this.account(dn, entry);
      if (!account) throw new BadRequestError(`${dn} gets no instance`);
      if (first(this.value(entry, this.sentAttribute))) return 'ready';
      // A write that changes nothing, so a caller who may read the account
      // but not write it is refused before the provider or the broker hear
      // of it
      if (req)
        await this.server.ldap.modify(
          dn,
          { replace: { [this.sentAttribute]: [] } },
          req
        );
      // A modify can write the address: taken as is only when it is the one
      // the provider gives this account, otherwise asked about
      const known = first(this.value(entry, this.fqdnAttribute));
      if (known) {
        const confirmed =
          known.toLowerCase() === this.provider.address(account)
            ? { fqdn: known, ready: true }
            : await this.provider.find(account, known);
        if (confirmed?.ready) {
          await this.ready(dn, entry, account, confirmed.fqdn, req);
          return 'ready';
        }
      }
      return this.provide(dn, entry, account, req);
    });
  }

  /**
   * Ask for an organization's own instance, which the Cloudery also needs as
   * an organization. `organization.created` follows once it exists. For the
   * application that creates organizations to call.
   */
  async ensureOrganization(org: {
    id: string;
    name: string;
    domain: string;
  }): Promise<'ready' | 'pending'> {
    return this.serialized(`organization:${org.id}`, async () => {
      const entry = await this.findOrganization(org.id);
      if (!entry) throw new NotFoundError(`No organization ${org.id}`);
      // organization.created reads the name from the entry, which an entry
      // written before it was kept there lacks
      if (org.name && !first(this.value(entry, this.organizationName))) {
        await this.server.ldap.modify(entry.dn as string, {
          replace: { [this.organizationName]: org.name },
        });
        entry[this.organizationName] = org.name;
      }
      const known =
        this.organizationFqdn &&
        first(this.value(entry, this.organizationFqdn));
      const request = this.organizationRequest(org);
      const found = known
        ? { fqdn: known, ready: true }
        : await this.provider.find(request);
      // Marked: link it again (idempotent) and release what is still held
      if (first(this.value(entry, this.sentAttribute))) {
        if (found?.ready) await this.organizationReady(entry, found.fqdn);
        else await this.releaseMembers(entry.dn as string);
        return 'ready';
      }
      let fqdn = found?.ready && found.fqdn;
      if (!found) {
        if (this.provider instanceof ClouderyProvider)
          await this.provider.createOrganization(org);
        fqdn = await this.provider.create(request);
      }
      if (!fqdn) return 'pending';
      await this.organizationReady(entry, fqdn);
      return 'ready';
    });
  }

  private organizationRequest(org: {
    id: string;
    name: string;
    domain: string;
  }): InstanceRequest {
    return {
      id: org.id,
      email: this.organizationMail(org.id, org.domain),
      publicName: org.name,
      locale: this.locale,
      orgId: org.id,
      orgDomain: org.domain,
      offer: this.config.twake_instance_cloudery_organization_offer,
    };
  }

  /**
   * The Cloudery builds no member instance for an organization it does not
   * have, so a member asks for a missing one first. The organization is
   * marked when its own workplace.created arrives. Not serialized on the
   * organization: its work releases members, which would wait on this one.
   */
  private async requestOrganization(id: string): Promise<void> {
    if (!(this.provider instanceof ClouderyProvider)) return;
    const entry = await this.findOrganization(id);
    if (!entry || first(this.value(entry, this.sentAttribute))) return;
    const name = first(this.value(entry, this.organizationName));
    const domain = first(this.value(entry, this.organizationDomain));
    if (!name || !domain) {
      this.logger.warn(
        `${this.name}: organization ${id} has no ${this.organizationName} or ${this.organizationDomain}, so its instance cannot be asked for`
      );
      return;
    }
    const request = this.organizationRequest({ id, name, domain });
    if (await this.provider.find(request)) return;
    await this.provider.createOrganization({ id, name, domain });
    try {
      await this.provider.create(request);
    } catch (err) {
      // Another member of the same new organization may have asked first
      if (!(await this.provider.find(request))) throw err;
    }
  }

  async onWorkplaceCreated(message: WorkplaceCreated): Promise<void> {
    const { internalEmail, workplaceFqdn } = message;
    if (!internalEmail || !workplaceFqdn) return;
    // An organization's instance carries its id and its own address; any
    // other message is an account's, even one whose uid is an organization id
    const org =
      message.twakeId && (await this.findOrganization(message.twakeId));
    if (org) {
      const id = (message.twakeId as string).toLowerCase();
      const domain = first(this.value(org, this.organizationDomain));
      const mail = internalEmail.toLowerCase();
      if (
        domain
          ? this.organizationMail(id, domain) === mail
          : mail.startsWith(`${id}@`)
      )
        return this.serialized(`organization:${message.twakeId}`, async () => {
          const current = await this.read(org.dn as string);
          if (current) await this.organizationReady(current, workplaceFqdn);
        });
    }
    const found = await this.findByMail(internalEmail);
    if (!found) {
      this.logger.debug(`${this.name}: no account here for ${internalEmail}`);
      return;
    }
    await this.settle(found.dn as string, workplaceFqdn);
  }

  private async settle(dn: string, fqdn: string): Promise<void> {
    await this.serialized(dn, async () => {
      const entry = await this.read(dn);
      const account = entry && this.account(dn, entry);
      if (!entry || !account) return;
      if (first(this.value(entry, this.sentAttribute))) return;
      await this.ready(dn, entry, account, fqdn);
    });
  }

  /** Find the instance, or ask for it; write it down once it exists. */
  private async provide(
    dn: string,
    entry: AttributesList,
    account: Account,
    req?: Request
  ): Promise<'ready' | 'pending'> {
    if (account.orgId) await this.requestOrganization(account.orgId);
    const found = await this.provider.find(account);
    const fqdn = found
      ? found.ready && found.fqdn
      : await this.provider.create(account);
    if (!fqdn) return 'pending';
    await this.ready(dn, entry, account, fqdn, req);
    return 'ready';
  }

  protected async ready(
    dn: string,
    entry: AttributesList,
    account: Account,
    fqdn: string,
    req?: Request
  ): Promise<void> {
    if (first(this.value(entry, this.fqdnAttribute)) !== fqdn)
      await this.server.ldap.modify(
        dn,
        { replace: { [this.fqdnAttribute]: fqdn } },
        req
      );
    if (first(this.value(entry, this.sentAttribute))) return;
    // The Cloudery refuses a member's user.created until its organization is
    // linked; organizationReady sends it then. Only members below the
    // organization entry are held, as only those are found to be released
    const org =
      this.provider instanceof ClouderyProvider &&
      account.orgId &&
      (await this.findOrganization(account.orgId));
    if (org && !first(this.value(org, this.sentAttribute))) {
      if (dn.toLowerCase().endsWith(`,${(org.dn as string).toLowerCase()}`)) {
        this.logger.info(
          `${this.name}: ${dn} waits for organization ${account.orgId}`
        );
        return;
      }
      this.logger.warn(
        `${this.name}: ${dn} is not below its organization entry, so it is announced before organization ${account.orgId} is linked; clear its ${this.sentAttribute} and send it again once the organization is announced`
      );
    }
    await this.announce(
      this.config.twake_instance_auth_exchange || 'auth',
      this.config.twake_instance_user_created_key || 'user.created',
      {
        twakeId: account.twakeId,
        internalEmail: account.email,
        workplaceFqdn: fqdn,
        ...(account.orgId ? { organizationId: account.orgId } : {}),
        ...(account.orgDomain
          ? {
              domain: account.orgDomain,
              organizationDomain: account.orgDomain,
            }
          : {}),
        ...(account.phone ? { mobile: account.phone } : {}),
      }
    );
    await this.server.ldap.modify(
      dn,
      { replace: { [this.sentAttribute]: new Date().toISOString() } },
      req
    );
  }

  private async organizationReady(
    entry: AttributesList,
    fqdn: string
  ): Promise<void> {
    const dn = entry.dn as string;
    const id = first(this.value(entry, this.organizationId));
    // The link is idempotent: an organization marked by an earlier version
    // was never linked, and gets linked on its next replay
    if (id && this.provider instanceof ClouderyProvider)
      await this.provider.linkOrganization(id, fqdn);
    // Before the mark check, so a replay fills an account added since. Its
    // failure must not hold back the announcement and the members
    if (id)
      await this.fillOrganizationAccount(id, fqdn).catch(err =>
        this.logger.error({
          plugin: this.name,
          event: 'organization account',
          organization: id,
          error: String(err),
        })
      );
    // Done once announced: an organization entry need not hold its address.
    // Its members are still released, in case a previous run stopped midway
    if (first(this.value(entry, this.sentAttribute)))
      return this.releaseMembers(dn);
    if (
      this.organizationFqdn &&
      !first(this.value(entry, this.organizationFqdn))
    )
      await this.server.ldap.modify(dn, {
        replace: { [this.organizationFqdn]: fqdn },
      });
    const domain = first(this.value(entry, this.organizationDomain));
    const name = first(this.value(entry, this.organizationName));
    await this.announce(
      this.config.twake_instance_b2b_exchange || 'b2b',
      this.config.twake_instance_organization_created_key ||
        'organization.created',
      {
        organizationId: id,
        workplaceFqdn: fqdn,
        ...(name ? { organization: name } : {}),
        ...(domain ? { domain } : {}),
      }
    );
    await this.server.ldap.modify(dn, {
      replace: { [this.sentAttribute]: new Date().toISOString() },
    });
    await this.releaseMembers(dn);
  }

  /** The organization whose account `dn` is, if it is one */
  private organizationOf(dn: string): string | undefined {
    const template = this.config.twake_instance_organization_account;
    if (!template) return undefined;
    const source = escapeRegex(template)
      .replace('\\{id\\}', '(?<id>(?:[^,\\\\]|\\\\.)+)')
      .replace(/\\\{id\\\}/g, '\\k<id>');
    const id = new RegExp(`^${source}$`, 'i').exec(dn)?.groups?.id;
    return id && unescapeDnValue(id);
  }

  /**
   * An organization account added once its organization is announced. One
   * added before is filled by organizationReady
   */
  private async giveOrganizationAddress(id: string): Promise<void> {
    const org = await this.findOrganization(id);
    if (!org || !first(this.value(org, this.sentAttribute))) return;
    let fqdn =
      this.organizationFqdn && first(this.value(org, this.organizationFqdn));
    if (!fqdn) {
      const found = await this.provider.find(
        this.organizationRequest({
          id,
          name: first(this.value(org, this.organizationName)) || '',
          domain: first(this.value(org, this.organizationDomain)) || '',
        })
      );
      if (found?.ready) fqdn = found.fqdn;
    }
    if (fqdn) await this.fillOrganizationAccount(id, fqdn);
  }

  private async fillOrganizationAccount(
    id: string,
    fqdn: string
  ): Promise<void> {
    const template = this.config.twake_instance_organization_account;
    if (!template) return;
    const dn = template.replace(/\{id\}/g, () => escapeDnValue(id));
    const entry = await this.read(dn);
    if (!entry || first(this.value(entry, this.fqdnAttribute))) return;
    await this.server.ldap.modify(dn, {
      replace: { [this.fqdnAttribute]: fqdn },
    });
  }

  /** Send the user.created held while the organization at `dn` was pending */
  private async releaseMembers(dn: string): Promise<void> {
    const members = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'sub',
        filter: `(&(${this.fqdnAttribute}=*)(!(${this.sentAttribute}=*)))`,
      },
      dn
    )) as SearchResult;
    // Each member on its own, so one that fails does not hold back the rest
    let failed = 0;
    for (const member of members.searchEntries) {
      try {
        await this.release(member);
      } catch (err) {
        failed++;
        this.logger.error(
          `${this.name}: ${member.dn} not released: ${String(err)}`
        );
      }
    }
    if (failed)
      throw new Error(
        `${this.name}: ${failed} member(s) of ${dn} not released`
      );
  }

  /** Announce a held member, with the address rule ensureInstance applies */
  private async release(member: AttributesList): Promise<void> {
    const dn = member.dn as string;
    const account = this.account(dn, member);
    const known = first(this.value(member, this.fqdnAttribute));
    if (!account || !known) return;
    const confirmed =
      known.toLowerCase() === this.provider.address(account)
        ? { fqdn: known, ready: true }
        : await this.provider.find(account, known);
    if (confirmed?.ready) return this.settle(dn, confirmed.fqdn);
    this.logger.warn(
      `${this.name}: ${dn} stays held, its address ${known} is not confirmed; ensureInstance sends it once it is`
    );
  }

  /**
   * Run `work` once the work already queued for `key` is over. One replica
   * only: across replicas, `user.created` may still be sent twice.
   */
  private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lower = key.toLowerCase();
    const before = this.queues.get(lower) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.queues.set(lower, tail);
    void tail.then(() => {
      if (this.queues.get(lower) === tail) this.queues.delete(lower);
    });
    return run;
  }

  private get organizationId(): string {
    return this.config.twake_instance_organization_id_attribute || 'ou';
  }

  private get organizationDomain(): string {
    return (
      this.config.twake_instance_organization_domain_attribute || 'twakeDomain'
    );
  }

  private get organizationName(): string {
    return (
      this.config.twake_instance_organization_name_attribute || 'description'
    );
  }

  private get organizationFqdn(): string {
    return this.config.twake_instance_organization_fqdn_attribute || '';
  }

  private organizationMail(id: string, domain: string): string {
    return `${id}@${domain}`.toLowerCase();
  }

  private isOrganization(dn: string): boolean {
    const base = this.config.twake_instance_organization_base;
    if (!base) return false;
    const rest = dn.slice(dn.indexOf(',') + 1);
    return rest.toLowerCase() === base.toLowerCase();
  }

  private async findOrganization(
    id: string
  ): Promise<AttributesList | undefined> {
    const base = this.config.twake_instance_organization_base;
    if (!base) return undefined;
    const res = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'one',
        filter: `(${this.organizationId}=${escapeLdapFilter(id)})`,
      },
      base
    )) as SearchResult;
    return res.searchEntries[0] as AttributesList | undefined;
  }

  private async read(
    dn: string,
    req?: Request
  ): Promise<AttributesList | undefined> {
    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base' },
        dn,
        req
      )) as SearchResult;
      return res.searchEntries[0] as AttributesList | undefined;
    } catch (err) {
      const code = extractLdapCode(err);
      if (code === 32) return undefined;
      if (code === 34) throw new BadRequestError(`Invalid DN: ${dn}`);
      throw err;
    }
  }

  protected async announce(
    exchange: string,
    key: string,
    message: Record<string, unknown>
  ): Promise<void> {
    const rabbitmq = this.requirePlugin<RabbitMq>('rabbitmq');
    // publish() drops a message silently without a client
    if (!rabbitmq || !(await rabbitmq.getRawClient()))
      throw new Error(`${this.name}: RabbitMQ unreachable, ${key} not sent`);
    await rabbitmq.publish(exchange, key, message);
    this.logger.info({ plugin: this.name, event: key, exchange });
  }

  /** What to ask for this account, when it gets an instance at all. */
  protected account(dn: string, entry: AttributesList): Account | undefined {
    const match = this.match(dn);
    if (!match) return undefined;
    // A tombstone put back (a refused SCIM create restores it) is no account
    if (isTombstone(entry, this.lifecycle)) return undefined;
    const skip = this.config.twake_instance_skip_attribute;
    if (
      skip &&
      first(this.value(entry, skip))?.toLowerCase() ===
        (this.config.twake_instance_skip_value || '').toLowerCase()
    )
      return undefined;
    const email = first(this.value(entry, 'mail'));
    const uid = first(this.value(entry, 'uid'));
    if (!email || !uid) {
      this.logger.warn(`${this.name}: ${dn} has no mail or uid, no instance`);
      return undefined;
    }
    const cozy = this.provider instanceof CozyStackProvider;
    const orgId =
      match.groups?.org ||
      (cozy ? this.config.twake_instance_cozy_org_id : '') ||
      undefined;
    const orgDomain = match.groups?.org
      ? email.split('@')[1]
      : (cozy && this.config.twake_instance_cozy_org_domain) || undefined;
    return {
      id: this.id(uid, match),
      // cozyProvision's OIDC id, the uid; the Cloudery's is the slug
      ...(cozy ? { oidc: uid } : {}),
      twakeId: uid,
      email,
      publicName:
        first(this.value(entry, 'displayName')) ||
        first(this.value(entry, 'cn')) ||
        uid,
      locale: first(this.value(entry, 'preferredLanguage')) || this.locale,
      phone: first(this.value(entry, 'mobile')),
      ...(orgId ? { orgId } : {}),
      ...(orgDomain ? { orgDomain } : {}),
    };
  }

  private match(dn: string): RegExpExecArray | undefined {
    return this.patterns
      .map(p => p.exec(dn))
      .find((m): m is RegExpExecArray => m !== null);
  }

  private id(uid: string, match: RegExpExecArray): string {
    const groups: Record<string, string> = { uid, ...match.groups };
    return (this.config.twake_instance_id || '{uid}')
      .replace(/\{(\w+)\}/g, (_, name: string) => groups[name] ?? '')
      .replace(/\./g, '')
      .toLowerCase();
  }

  protected value(entry: AttributesList, attribute: string): unknown {
    const lower = attribute.toLowerCase();
    const key = Object.keys(entry).find(k => k.toLowerCase() === lower);
    return key ? entry[key] : undefined;
  }

  protected async findByMail(
    email: string,
    req?: Request
  ): Promise<AttributesList | undefined> {
    const res = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'sub',
        filter: `(mail=${escapeLdapFilter(email)})`,
      },
      this.config.ldap_base,
      req
    )) as SearchResult;
    return res.searchEntries.find(e =>
      this.patterns.some(p => p.test(e.dn))
    ) as AttributesList | undefined;
  }
}
