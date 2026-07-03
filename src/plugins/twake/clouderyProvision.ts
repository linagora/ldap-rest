/**
 * @module plugins/twake/clouderyProvision
 *
 * B2B sibling of `cozyProvision`. For SCIM users created under a configured
 * B2B LDAP branch, it provisions a Twake/Cozy instance via the Cloudery
 * (manager) API, writes the returned FQDN to the `twakeWorkspaceUrl` attribute
 * (bare FQDN) and the org id to `twakeOrganizationId` (the org id arrives in a
 * header, so the SCIM body cannot carry it), and publishes the same lifecycle
 * messages cozyProvision does.
 *
 * The org id is carried per-request in a header (single shared B2B token), so
 * onboarding a new org needs no config change; the org branch is selected by
 * the core `BaseResolver` (also from a header). The operator supplies the email
 * in the SCIM body, `org_domain` is its domain, and `slug` = `oidc` =
 * normalizeNickname(userName) + orgId (dots stripped).
 *
 * Alongside the FQDN, the post-create write stamps two attributes the admin
 * panel reads off the user entry: `twakeOrganizationRole` and (when present)
 * `twakePhones`. The role is per-request via a header, so a single batch import
 * can be all members and the next all admins; it accepts `admin`, `owner`, or
 * `member` and falls back to `cloudery_default_org_role` (`member`) when the
 * header is absent or unknown. `twakePhones` holds the SCIM phone numbers as the
 * JSON the panel expects: `[{ "number": "+33...", "primary": true }]`.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Request } from 'express';
import fetch from 'node-fetch';

import DmPlugin, { type Role, escapeDnValue } from '../../abstract/plugin';
import type { DM } from '../../bin';
import { Hooks } from '../../hooks';
import { isChildOf } from '../../lib/utils';
import type RabbitMq from '../rabbitmq';
import { BaseResolver } from '../scim/baseResolver';
import type { ScimUser } from '../scim/types';

type ReqWithUser = Request & { user?: string };

interface ClouderyInstanceResponse {
  id: string;
  fqdn: string;
  workflow?: string;
}

interface CreateContext {
  orgId: string;
  email: string;
  role: string;
  base: string;
  ts: number;
}

interface DeleteContext {
  fqdn: string;
  domain: string;
}

// A create that fails between the pre- and post-create hooks would otherwise
// leak its captured context; prune anything older than this.
const STASH_TTL_MS = 5 * 60 * 1000;

// Roles the admin panel recognises for the `twakeOrganizationRole` attribute;
// anything else from the header is rejected in favour of the configured default.
const VALID_ORG_ROLES = new Set(['admin', 'owner', 'member']);

// Cap on the manager API error body we log: enough to carry the actual error
// message, bounded so a large HTML error page (repeated across poll attempts)
// can't bloat the logs.
const MAX_LOG_BODY_LEN = 1000;

export default class ClouderyProvision extends DmPlugin {
  name = 'clouderyProvision';
  roles: Role[] = ['consistency'] as const;

  dependencies = { rabbitmq: 'core/rabbitmq' };

  private readonly managerUrl: string;
  private readonly managerToken: string;
  private readonly offer: string;
  private readonly clouderyDomain: string;
  private readonly userBranch: string;
  private readonly orgIdHeader: string;
  private readonly orgRoleHeader: string;
  private readonly defaultOrgRole: string;
  private readonly fqdnAttribute: string;
  private readonly orgIdAttribute: string;
  private readonly orgRoleAttribute: string;
  private readonly phonesAttribute: string;
  private readonly invitedAttribute: string;
  private readonly defaultLocale: string;
  private readonly rdnAttribute: string;
  private readonly authExchange: string;
  private readonly b2bExchange: string;
  private readonly userCreatedRoutingKey: string;
  private readonly userDeletedRoutingKey: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  private readonly baseResolver: BaseResolver;

  // pre-create hook (has req) → post-create hook (no req). Keyed by the
  // primary email (unique per user/tenant); userName alone collides across org
  // branches, which would let one tenant's create overwrite another's context.
  private readonly createStash = new Map<string, CreateContext>();
  // pre-delete hook (entry still exists) → post-delete hook; keyed by id.
  private readonly deleteStash = new Map<string, DeleteContext>();

  constructor(server: DM) {
    super(server);
    const cfg = this.config;

    this.managerUrl = ((cfg.cloudery_manager_url as string) || '').replace(
      /\/$/,
      ''
    );
    this.managerToken = (cfg.cloudery_manager_token as string) || '';
    this.offer = (cfg.cloudery_offer as string) || 'b2b_twake_default';
    this.clouderyDomain = (cfg.cloudery_domain as string) || '';
    this.userBranch = (cfg.cloudery_user_branch as string) || '';
    this.orgIdHeader = (
      (cfg.cloudery_org_id_header as string) || 'x-cloudery-org-id'
    ).toLowerCase();
    this.orgRoleHeader = (
      (cfg.cloudery_org_role_header as string) || 'x-cloudery-org-role'
    ).toLowerCase();
    // The default is the fallback for an absent/unknown header, so it must be a
    // valid, lower-cased role itself; otherwise a misconfigured default would
    // bypass the same validation resolveRole() applies to header values.
    const configuredRole =
      (cfg.cloudery_default_org_role as string) || 'member';
    const normalizedRole = configuredRole.trim().toLowerCase();
    if (VALID_ORG_ROLES.has(normalizedRole)) {
      this.defaultOrgRole = normalizedRole;
    } else {
      this.defaultOrgRole = 'member';
      this.logger.warn(
        `${this.name}: cloudery_default_org_role "${configuredRole}" is not one of ${[
          ...VALID_ORG_ROLES,
        ].join(', ')} — using "member"`
      );
    }
    this.fqdnAttribute =
      (cfg.cloudery_fqdn_attribute as string) || 'twakeWorkspaceUrl';
    this.orgIdAttribute =
      (cfg.cloudery_org_id_attribute as string) || 'twakeOrganizationId';
    this.orgRoleAttribute =
      (cfg.cloudery_org_role_attribute as string) || 'twakeOrganizationRole';
    this.phonesAttribute =
      (cfg.cloudery_phones_attribute as string) || 'twakePhones';
    this.invitedAttribute =
      (cfg.cloudery_invited_attribute as string) || 'twakeInvited';
    this.defaultLocale = (cfg.cloudery_default_locale as string) || 'en';
    this.rdnAttribute = (cfg.scim_user_rdn_attribute as string) || 'uid';
    this.authExchange = (cfg.cozy_auth_exchange as string) || 'auth';
    this.b2bExchange = (cfg.cozy_b2b_exchange as string) || 'b2b';
    this.userCreatedRoutingKey =
      (cfg.cozy_user_created_routing_key as string) || 'user.created';
    this.userDeletedRoutingKey =
      (cfg.cozy_user_deleted_routing_key as string) || 'domain.user.deleted';
    this.pollIntervalMs =
      Number(cfg.cloudery_workflow_poll_interval_ms) || 2000;
    this.maxPollAttempts = Number(cfg.cloudery_workflow_max_attempts) || 60;

    this.baseResolver = new BaseResolver(this.config);

    if (!this.managerUrl) {
      this.logger.warn(
        `${this.name}: cloudery_manager_url is empty — instance provisioning will be skipped`
      );
    }
    if (!this.userBranch) {
      this.logger.warn(
        `${this.name}: cloudery_user_branch is empty — no users will be provisioned`
      );
    }
    this.logger.info({
      plugin: this.name,
      event: 'init',
      managerUrl: this.managerUrl || undefined,
      userBranch: this.userBranch || undefined,
      orgIdHeader: this.orgIdHeader,
      orgRoleHeader: this.orgRoleHeader,
      defaultOrgRole: this.defaultOrgRole,
      fqdnAttribute: this.fqdnAttribute,
      orgIdAttribute: this.orgIdAttribute,
      orgRoleAttribute: this.orgRoleAttribute,
      phonesAttribute: this.phonesAttribute,
      invitedAttribute: this.invitedAttribute,
      pollIntervalMs: this.pollIntervalMs,
      maxPollAttempts: this.maxPollAttempts,
    });
  }

  hooks: Hooks = {
    scimusercreate: (
      args: [ScimUser, ReqWithUser?]
    ): [ScimUser, ReqWithUser?] => {
      this.captureCreate(args[0], args[1]);
      return args;
    },
    scimusercreatedone: async (user: ScimUser): Promise<void> => {
      await this.provision(user);
    },
    scimuserdelete: async (
      args: [string, ReqWithUser?]
    ): Promise<[string, ReqWithUser?]> => {
      await this.captureDelete(args[0], args[1]);
      return args;
    },
    scimuserdeletedone: async (id: string): Promise<void> => {
      await this.deprovision(id);
    },
  };

  /** Pre-create: stash the request-derived context for the post-create hook. */
  private captureCreate(user: ScimUser, req?: ReqWithUser): void {
    this.pruneStash();
    const userName = this.extractId(user);
    const base = this.baseResolver.userBase(req);
    this.logger.info({
      plugin: this.name,
      event: 'captureCreate',
      userName: userName || undefined,
      base,
      hasManagerUrl: Boolean(this.managerUrl),
      hasUserBranch: Boolean(this.userBranch),
    });
    if (!this.managerUrl || !this.userBranch) {
      this.logger.info({
        plugin: this.name,
        event: 'captureCreate',
        userName: userName || undefined,
        base,
        result: 'skipped',
        reason: 'missing_configuration',
      });
      return;
    }
    if (!userName) {
      this.logger.info({
        plugin: this.name,
        event: 'captureCreate',
        base,
        result: 'skipped',
        reason: 'missing_user_name',
      });
      return;
    }

    if (!this.isAtOrUnder(base, this.userBranch)) {
      this.logger.info({
        plugin: this.name,
        event: 'captureCreate',
        userName,
        base,
        result: 'skipped',
        reason: 'outside_b2b_branch',
      });
      return;
    }

    const orgId = this.readHeader(req, this.orgIdHeader);
    if (!orgId) {
      this.logger.warn({
        plugin: this.name,
        event: 'captureCreate',
        userName,
        message: `B2B branch create without ${this.orgIdHeader} — skipping provisioning`,
      });
      return;
    }

    // org_domain is the email domain (as in signup), so the email must be in
    // the body; the core maps it to `mail`.
    const email = this.extractPrimaryEmail(user);
    if (!email) {
      this.logger.warn({
        plugin: this.name,
        event: 'captureCreate',
        userName,
        message:
          'B2B branch create without a primary email — skipping provisioning',
      });
      return;
    }

    // Trim what we stash: leading/trailing whitespace in the email or org id
    // would otherwise leak into org_domain / internal_email / slug downstream.
    const cleanEmail = email.trim();
    const role = this.resolveRole(req, userName);
    this.createStash.set(cleanEmail.toLowerCase(), {
      orgId: orgId.trim(),
      email: cleanEmail,
      role,
      base,
      ts: Date.now(),
    });
    this.logger.info({
      plugin: this.name,
      event: 'captureCreate',
      userName,
      base,
      orgId: orgId.trim(),
      email: cleanEmail,
      role,
      result: 'stashed',
    });
  }

  /**
   * Post-create: provision via Cloudery, wait for the workflow, then write the
   * FQDN back and publish user.created. Gated on workflow success so nothing is
   * emitted for an instance that does not exist yet.
   */
  private async provision(user: ScimUser): Promise<void> {
    const userName = this.extractId(user);
    this.logger.info({
      plugin: this.name,
      event: 'provision',
      userName: userName || undefined,
    });
    if (!userName) {
      this.logger.info({
        plugin: this.name,
        event: 'provision',
        result: 'skipped',
        reason: 'missing_user_name',
      });
      return;
    }
    const lookupEmail = this.extractPrimaryEmail(user);
    if (!lookupEmail) {
      this.logger.info({
        plugin: this.name,
        event: 'provision',
        userName,
        result: 'skipped',
        reason: 'missing_primary_email',
      });
      return;
    }
    const key = lookupEmail.trim().toLowerCase();
    const ctx = this.createStash.get(key);
    if (!ctx) {
      this.logger.info({
        plugin: this.name,
        event: 'provision',
        userName,
        email: lookupEmail.trim(),
        result: 'skipped',
        reason: 'no_stashed_context',
      });
      return;
    }
    this.createStash.delete(key);
    this.logger.info({
      plugin: this.name,
      event: 'provision',
      userName,
      email: ctx.email,
      orgId: ctx.orgId,
      base: ctx.base,
      role: ctx.role,
      result: 'context_loaded',
    });

    const email = ctx.email;
    const orgDomain = emailDomain(email);
    const slug = normalizeNickname(userName) + ctx.orgId;
    const mobile = this.extractPrimaryPhone(user);
    const phones = this.extractPhones(user);
    const publicName = this.extractPublicName(user) || userName;

    const log = {
      plugin: this.name,
      event: 'provision',
      userName,
      orgId: ctx.orgId,
      slug,
    };

    let instance: ClouderyInstanceResponse;
    try {
      this.logger.info({
        ...log,
        result: 'creating_instance',
        orgDomain,
        email,
        mobile: mobile || undefined,
      });
      instance = await this.createInstance({
        email,
        publicName,
        locale: this.extractLocale(user),
        oidc: slug,
        phone: mobile || '',
        slug,
        public_name: publicName,
        offer: this.offer,
        domain: this.clouderyDomain,
        skip_email_validation: true,
        internal_email: email,
        org_domain: orgDomain,
        org_id: ctx.orgId,
      });
    } catch (err) {
      this.logger.error({
        ...log,
        result: 'error',
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
      return;
    }

    const ready = instance.workflow
      ? await this.waitForWorkflow(instance.workflow)
      : true;
    if (!ready) {
      this.logger.error({
        ...log,
        result: 'workflow_failed',
        workflow: instance.workflow,
      });
      return;
    }

    const fqdn = instance.fqdn;
    const dn = `${this.rdnAttribute}=${escapeDnValue(userName)},${ctx.base}`;
    // Role and phones live on the user entry for the admin panel to read; they
    // are not part of the Cloudery create payload. Phones are stored as the JSON
    // the panel expects ([{ number, primary }]) and only when present.
    // twakeInvited marks the member as pending invitation (the string "TRUE",
    // its schema is a Directory String); the registration app clears it to
    // "FALSE" once onboarding completes.
    const replace: Record<string, string> = {
      [this.fqdnAttribute]: fqdn,
      [this.orgIdAttribute]: ctx.orgId,
      [this.orgRoleAttribute]: ctx.role,
      [this.invitedAttribute]: 'TRUE',
      // Force cn to the userName for B2B provisioning; the core SCIM mapping
      // sets cn from name.formatted, which is not what we want here.
      cn: userName,
    };
    if (phones.length > 0) {
      replace[this.phonesAttribute] = JSON.stringify(phones);
    }
    try {
      this.logger.info({
        ...log,
        result: 'writing_fqdn',
        dn,
        hasPhones: phones.length > 0,
      });
      await this.server.ldap.modify(dn, { replace });
      this.logger.info({
        ...log,
        result: 'written_fqdn',
        dn,
      });
    } catch (err) {
      // Instance exists, so still publish; the write failure would break the
      // later delete lookup, so surface it.
      this.logger.error({
        ...log,
        event: 'writeFqdn',
        dn,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }

    await this.publishUserCreated({
      twakeId: userName,
      orgDomain,
      orgId: ctx.orgId,
      fqdn,
      email,
      mobile,
    });
    this.logger.info({ ...log, result: 'success', fqdn });
  }

  /**
   * Pre-delete: read the stored FQDN (and domain from mail) while the entry
   * still exists, so the post-delete hook can tear the instance down. No stored
   * FQDN means this user was not provisioned here.
   */
  private async captureDelete(id: string, req?: ReqWithUser): Promise<void> {
    const base = this.baseResolver.userBase(req);
    this.logger.info({
      plugin: this.name,
      event: 'captureDelete',
      id,
      base,
      hasManagerUrl: Boolean(this.managerUrl),
      hasUserBranch: Boolean(this.userBranch),
    });
    if (!this.managerUrl || !this.userBranch) {
      this.logger.info({
        plugin: this.name,
        event: 'captureDelete',
        id,
        base,
        result: 'skipped',
        reason: 'missing_configuration',
      });
      return;
    }
    if (!this.isAtOrUnder(base, this.userBranch)) {
      this.logger.info({
        plugin: this.name,
        event: 'captureDelete',
        id,
        base,
        result: 'skipped',
        reason: 'outside_b2b_branch',
      });
      return;
    }

    const dn = `${this.rdnAttribute}=${escapeDnValue(id)},${base}`;
    try {
      this.logger.info({
        plugin: this.name,
        event: 'captureDelete',
        id,
        dn,
        result: 'searching',
      });
      const res = (await this.server.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: [this.fqdnAttribute, 'mail'],
        },
        dn
      )) as { searchEntries?: Record<string, unknown>[] };
      const entry = res.searchEntries?.[0];
      const stored = entry ? firstValue(entry[this.fqdnAttribute]) : undefined;
      const fqdn = stored ? extractFqdn(stored) : undefined;
      if (!fqdn) {
        this.logger.info({
          plugin: this.name,
          event: 'captureDelete',
          id,
          dn,
          result: 'skipped',
          reason: 'missing_fqdn',
        });
        return;
      }
      const mail = entry ? firstValue(entry.mail) : undefined;
      const domain = mail ? emailDomain(mail) : '';
      this.deleteStash.set(id, {
        fqdn,
        domain,
      });
      this.logger.info({
        plugin: this.name,
        event: 'captureDelete',
        id,
        dn,
        fqdn,
        domain,
        result: 'stashed',
      });
    } catch (err) {
      this.logger.warn({
        plugin: this.name,
        event: 'captureDelete',
        id,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  /** Post-delete: delete the Cloudery instance by FQDN and publish the event. */
  private async deprovision(id: string): Promise<void> {
    this.logger.info({
      plugin: this.name,
      event: 'deprovision',
      id,
    });
    const ctx = this.deleteStash.get(id);
    if (!ctx) {
      this.logger.info({
        plugin: this.name,
        event: 'deprovision',
        id,
        result: 'skipped',
        reason: 'no_stashed_context',
      });
      return;
    }
    this.deleteStash.delete(id);

    const log = {
      plugin: this.name,
      event: 'deprovision',
      id,
      fqdn: ctx.fqdn,
    };
    let deleted = false;
    try {
      this.logger.info({ ...log, result: 'resolving_uuid' });
      const uuid = await this.findInstanceUuidByFqdn(ctx.fqdn);
      if (uuid) {
        this.logger.info({ ...log, result: 'deleting_instance', uuid });
        await this.deleteInstance(uuid);
        deleted = true;
        this.logger.info({ ...log, result: 'deleted', uuid });
      } else {
        this.logger.warn({ ...log, result: 'not_found' });
      }
    } catch (err) {
      this.logger.error({
        ...log,
        result: 'error',
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }

    // Only announce the deletion once the instance is actually destroyed, so a
    // failed lookup/delete never notifies downstream of a teardown that did not
    // happen (matching cozyProvision).
    if (deleted) {
      await this.publishUserDeleted(ctx.fqdn, ctx.domain);
    }
  }

  /* ----------------------------- Cloudery API ----------------------------- */

  private async createInstance(
    payload: Record<string, unknown>
  ): Promise<ClouderyInstanceResponse> {
    this.logger.info({
      plugin: this.name,
      event: 'createInstance',
      url: `${this.managerUrl}/api/v1/instances`,
    });
    const res = await fetch(`${this.managerUrl}/api/v1/instances`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.managerToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(
        0,
        MAX_LOG_BODY_LEN
      );
      this.logger.error({
        plugin: this.name,
        event: 'createInstance',
        result: 'error',
        http_status: res.status,
        http_status_text: res.statusText,
        body: body || undefined,
      });
      throw new Error(`Cloudery createInstance HTTP ${res.status}`);
    }
    const data = (await res.json()) as ClouderyInstanceResponse;
    this.logger.info({
      plugin: this.name,
      event: 'createInstance',
      result: 'success',
      id: data.id,
      fqdn: data.fqdn,
      workflow: data.workflow,
    });
    return data;
  }

  /** Poll the workflow until it succeeds. Returns false on failure/timeout. */
  private async waitForWorkflow(workflowId: string): Promise<boolean> {
    this.logger.info({
      plugin: this.name,
      event: 'waitForWorkflow',
      workflow: workflowId,
      maxPollAttempts: this.maxPollAttempts,
      pollIntervalMs: this.pollIntervalMs,
    });
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      try {
        const res = await fetch(
          `${this.managerUrl}/api/v1/workflows/${encodeURIComponent(
            workflowId
          )}`,
          { headers: { Authorization: `Bearer ${this.managerToken}` } }
        );
        if (res.ok) {
          const data = (await res.json()) as { status?: string };
          this.logger.info({
            plugin: this.name,
            event: 'waitForWorkflow',
            workflow: workflowId,
            attempt,
            status: data.status,
          });
          if (data.status === 'succeeded') {
            this.logger.info({
              plugin: this.name,
              event: 'waitForWorkflow',
              workflow: workflowId,
              attempt,
              result: 'success',
            });
            return true;
          }
          if (data.status === 'failed' || data.status === 'error') {
            this.logger.warn({
              plugin: this.name,
              event: 'waitForWorkflow',
              workflow: workflowId,
              attempt,
              result: 'failed',
              status: data.status,
            });
            return false;
          }
        } else {
          const body = (await res.text().catch(() => '')).slice(
            0,
            MAX_LOG_BODY_LEN
          );
          this.logger.info({
            plugin: this.name,
            event: 'waitForWorkflow',
            workflow: workflowId,
            attempt,
            result: 'http_error',
            http_status: res.status,
            http_status_text: res.statusText,
            body: body || undefined,
          });
        }
      } catch (err) {
        this.logger.info({
          plugin: this.name,
          event: 'waitForWorkflow',
          workflow: workflowId,
          attempt,
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          error: `${err}`,
        });
      }
      if (attempt < this.maxPollAttempts) {
        this.logger.info({
          plugin: this.name,
          event: 'waitForWorkflow',
          workflow: workflowId,
          attempt,
          result: 'retrying',
        });
        await sleep(this.pollIntervalMs);
      }
    }
    this.logger.info({
      plugin: this.name,
      event: 'waitForWorkflow',
      workflow: workflowId,
      result: 'timeout',
      maxPollAttempts: this.maxPollAttempts,
    });
    return false;
  }

  private async findInstanceUuidByFqdn(fqdn: string): Promise<string | null> {
    this.logger.info({
      plugin: this.name,
      event: 'findInstanceUuidByFqdn',
      fqdn,
    });
    const url = new URL(`${this.managerUrl}/api/v2/instances`);
    url.searchParams.set('fqdn', fqdn);
    url.searchParams.append('only', '_id');
    url.searchParams.set('limit', '1');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.managerToken}` },
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(
        0,
        MAX_LOG_BODY_LEN
      );
      this.logger.error({
        plugin: this.name,
        event: 'findInstanceUuidByFqdn',
        fqdn,
        result: 'error',
        http_status: res.status,
        http_status_text: res.statusText,
        body: body || undefined,
      });
      throw new Error(`Cloudery searchInstances HTTP ${res.status}`);
    }
    const data = (await res.json()) as { items?: { _id: string }[] };
    const uuid = data.items && data.items.length > 0 ? data.items[0]._id : null;
    this.logger.info({
      plugin: this.name,
      event: 'findInstanceUuidByFqdn',
      fqdn,
      result: uuid ? 'found' : 'not_found',
      uuid: uuid || undefined,
    });
    return uuid;
  }

  private async deleteInstance(uuid: string): Promise<void> {
    const url = new URL(
      `${this.managerUrl}/api/v1/instances/${encodeURIComponent(uuid)}`
    );
    url.searchParams.set('user_request', 'true');
    this.logger.info({
      plugin: this.name,
      event: 'deleteInstance',
      uuid,
      url: url.toString(),
    });
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.managerToken}` },
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(
        0,
        MAX_LOG_BODY_LEN
      );
      this.logger.error({
        plugin: this.name,
        event: 'deleteInstance',
        uuid,
        result: 'error',
        http_status: res.status,
        http_status_text: res.statusText,
        body: body || undefined,
      });
      throw new Error(`Cloudery deleteInstance HTTP ${res.status}`);
    }
    this.logger.info({
      plugin: this.name,
      event: 'deleteInstance',
      uuid,
      result: 'success',
      http_status: res.status,
    });
  }

  /* ------------------------------ Publishing ------------------------------ */

  private async publishUserCreated(p: {
    twakeId: string;
    orgDomain: string;
    orgId: string;
    fqdn: string;
    email: string | null;
    mobile: string | null;
  }): Promise<void> {
    const rabbitmq = this.requirePlugin<RabbitMq>('rabbitmq');
    this.logger.info({
      plugin: this.name,
      event: 'publishUserCreated',
      twakeId: p.twakeId,
      orgId: p.orgId,
      orgDomain: p.orgDomain,
      hasRabbitmq: Boolean(rabbitmq),
    });
    if (!rabbitmq) {
      this.logger.info({
        plugin: this.name,
        event: 'publishUserCreated',
        twakeId: p.twakeId,
        result: 'skipped',
        reason: 'missing_rabbitmq',
      });
      return;
    }

    const message: Record<string, unknown> = {
      twakeId: p.twakeId,
      domain: p.orgDomain,
      organizationDomain: p.orgDomain,
      workplaceFqdn: p.fqdn,
      organizationId: p.orgId,
    };
    if (p.email) message.internalEmail = p.email;
    if (p.mobile) message.mobile = p.mobile;

    try {
      await rabbitmq.publish(
        this.authExchange,
        this.userCreatedRoutingKey,
        message
      );
      this.logger.info({
        plugin: this.name,
        event: 'publishUserCreated',
        twakeId: p.twakeId,
        exchange: this.authExchange,
        routingKey: this.userCreatedRoutingKey,
        result: 'success',
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserCreated',
        twakeId: p.twakeId,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  private async publishUserDeleted(
    fqdn: string,
    domain: string
  ): Promise<void> {
    const rabbitmq = this.requirePlugin<RabbitMq>('rabbitmq');
    this.logger.info({
      plugin: this.name,
      event: 'publishUserDeleted',
      workplaceFqdn: fqdn,
      domain,
      hasRabbitmq: Boolean(rabbitmq),
    });
    if (!rabbitmq) {
      this.logger.info({
        plugin: this.name,
        event: 'publishUserDeleted',
        workplaceFqdn: fqdn,
        result: 'skipped',
        reason: 'missing_rabbitmq',
      });
      return;
    }
    try {
      await rabbitmq.publish(this.b2bExchange, this.userDeletedRoutingKey, {
        workplaceFqdn: fqdn,
        domain,
      });
      this.logger.info({
        plugin: this.name,
        event: 'publishUserDeleted',
        workplaceFqdn: fqdn,
        exchange: this.b2bExchange,
        routingKey: this.userDeletedRoutingKey,
        result: 'success',
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserDeleted',
        workplaceFqdn: fqdn,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  /* ------------------------------- Helpers -------------------------------- */

  /** Read a request header by name, falling back to a query parameter. */
  private readHeader(
    req: ReqWithUser | undefined,
    name: string
  ): string | undefined {
    if (!req) return undefined;
    const fromHeader = req.get ? req.get(name) : undefined;
    if (typeof fromHeader === 'string' && fromHeader.length > 0) {
      return fromHeader;
    }
    const q = req.query?.[name];
    return typeof q === 'string' && q.length > 0 ? q : undefined;
  }

  /**
   * Per-request org role from the header (so one batch import can be all admins
   * and the next all members), validated against {@link VALID_ORG_ROLES}. An
   * absent or unknown role falls back to the configured default rather than
   * failing the import.
   */
  private resolveRole(req: ReqWithUser | undefined, userName: string): string {
    const raw = this.readHeader(req, this.orgRoleHeader)?.trim().toLowerCase();
    if (!raw) {
      this.logger.debug({
        plugin: this.name,
        event: 'resolveRole',
        userName,
        result: 'default',
        role: this.defaultOrgRole,
      });
      return this.defaultOrgRole;
    }
    if (!VALID_ORG_ROLES.has(raw)) {
      this.logger.warn({
        plugin: this.name,
        event: 'captureCreate',
        userName,
        message: `Unknown ${this.orgRoleHeader} "${raw}" — falling back to ${this.defaultOrgRole}`,
      });
      this.logger.debug({
        plugin: this.name,
        event: 'resolveRole',
        userName,
        input: raw,
        result: 'default',
        role: this.defaultOrgRole,
      });
      return this.defaultOrgRole;
    }
    this.logger.debug({
      plugin: this.name,
      event: 'resolveRole',
      userName,
      input: raw,
      result: 'accepted',
      role: raw,
    });
    return raw;
  }

  private isAtOrUnder(dn: string, parent: string): boolean {
    return (
      dn.trim().toLowerCase() === parent.trim().toLowerCase() ||
      isChildOf(dn, parent)
    );
  }

  private pruneStash(): void {
    const cutoff = Date.now() - STASH_TTL_MS;
    for (const [key, ctx] of this.createStash) {
      if (ctx.ts < cutoff) {
        this.createStash.delete(key);
      }
    }
  }

  private extractId(user: ScimUser): string | null {
    if (typeof user.userName === 'string' && user.userName.length > 0) {
      return user.userName;
    }
    if (typeof user.id === 'string' && user.id.length > 0) return user.id;
    return null;
  }

  private extractPrimaryEmail(user: ScimUser): string | null {
    const emails = user.emails;
    if (!emails || emails.length === 0) return null;
    const primary = emails.find(e => e.primary);
    const value = (primary || emails[0]).value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private extractPrimaryPhone(user: ScimUser): string | null {
    const phones = user.phoneNumbers;
    if (!phones || phones.length === 0) return null;
    const primary = phones.find(p => p.primary);
    const value = (primary || phones[0]).value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /** All phone numbers, shaped for the `twakePhones` attribute the panel reads. */
  private extractPhones(
    user: ScimUser
  ): { number: string; primary: boolean }[] {
    const phones = user.phoneNumbers;
    if (!phones || phones.length === 0) return [];
    return phones
      .filter(p => typeof p.value === 'string' && p.value.trim().length > 0)
      .map(p => ({ number: p.value.trim(), primary: Boolean(p.primary) }));
  }

  private extractPublicName(user: ScimUser): string | null {
    if (
      typeof user.displayName === 'string' &&
      user.displayName.trim().length > 0
    ) {
      return user.displayName.trim();
    }
    const formatted = user.name?.formatted;
    if (typeof formatted === 'string' && formatted.trim().length > 0) {
      return formatted.trim();
    }
    const given = user.name?.givenName?.trim() ?? '';
    const family = user.name?.familyName?.trim() ?? '';
    const composed = `${given} ${family}`.trim();
    return composed.length > 0 ? composed : null;
  }

  private extractLocale(user: ScimUser): string {
    if (typeof user.locale === 'string' && user.locale.length > 0) {
      return user.locale;
    }
    if (
      typeof user.preferredLanguage === 'string' &&
      user.preferredLanguage.length > 0
    ) {
      return user.preferredLanguage;
    }
    return this.defaultLocale;
  }
}

/** Strip dots from the nickname to form the slug/oidc identifier. */
function normalizeNickname(nickname: string): string {
  return nickname.replace(/\./g, '');
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}

/** Reduce a stored workspace value to a bare FQDN, tolerating a protocol/path. */
function extractFqdn(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0];
}

/** LDAP attribute values come back as a scalar or an array. */
function firstValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const v: unknown = value[0];
    return typeof v === 'string' ? v : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}
