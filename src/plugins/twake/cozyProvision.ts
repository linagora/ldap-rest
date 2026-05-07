/**
 * @module plugins/twake/cozyProvision
 *
 * Provisions a Cozy instance and publishes lifecycle events on RabbitMQ when
 * users are created or deleted via SCIM. Depends on cozy-stack admin API and
 * an AMQP broker reachable from the ldap-rest process.
 *
 * Hooks:
 *   - scimusercreatedone: POST /instances on cozy admin, then publish
 *     `auth` / `user.created` so downstream services (cozy-stack, etc.)
 *     can react.
 *   - scimuserdeletedone: publish `b2b` / `domain.user.deleted` so peer
 *     instances can clean up the deleted user's contact card.
 *
 * The RabbitMQ client (`@linagora/rabbitmq-client`) is declared as an
 * optional dependency: if it is not installed at runtime, AMQP publishes
 * are silently skipped and a one-time warning is logged.
 */
import { Buffer } from 'buffer';

import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import { Hooks } from '../../hooks';
import type { ScimUser } from '../scim/types';

interface RabbitPublisher {
  init(): Promise<void>;
  publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>
  ): Promise<void>;
  close(clearSubscriptions?: boolean): Promise<void>;
}

export default class CozyProvision extends DmPlugin {
  name = 'cozyProvision';
  roles: Role[] = ['consistency'] as const;

  private readonly cozyAdminUrl: string;
  private readonly cozyAdminPassphrase: string;
  private readonly cozyAdminUser: string;
  private readonly cozyOrgId: string;
  private readonly cozyOrgDomain: string;
  private readonly cozyDefaultLocale: string;
  private readonly cozyContextName: string;
  private readonly cozyApps: string;
  private readonly rabbitmqUrl: string;
  private readonly authExchange: string;
  private readonly b2bExchange: string;
  private readonly cozyAdminAuthHeader: string;

  private publisher: RabbitPublisher | null = null;
  private publisherInit: Promise<RabbitPublisher | null> | null = null;

  constructor(server: DM) {
    super(server);

    this.cozyAdminUrl = ((this.config.cozy_admin_url as string) || '').replace(
      /\/$/,
      ''
    );
    this.cozyAdminUser = (this.config.cozy_admin_user as string) || 'admin';
    this.cozyAdminPassphrase =
      (this.config.cozy_admin_passphrase as string) || '';
    this.cozyOrgId = (this.config.cozy_org_id as string) || '';
    this.cozyOrgDomain = (this.config.cozy_org_domain as string) || '';
    this.cozyDefaultLocale =
      (this.config.cozy_default_locale as string) || 'fr';
    this.cozyContextName =
      (this.config.cozy_context_name as string) || 'default';
    this.cozyApps = (this.config.cozy_apps as string) ?? '';
    this.rabbitmqUrl = (this.config.rabbitmq_url as string) || '';
    this.authExchange = (this.config.cozy_auth_exchange as string) || 'auth';
    this.b2bExchange = (this.config.cozy_b2b_exchange as string) || 'b2b';
    this.cozyAdminAuthHeader = `Basic ${Buffer.from(
      `${this.cozyAdminUser}:${this.cozyAdminPassphrase}`
    ).toString('base64')}`;

    if (!this.cozyAdminUrl) {
      this.logger.warn(
        `${this.name}: cozy_admin_url is empty — Cozy instance creation will be skipped`
      );
    }
    if (!this.cozyOrgDomain) {
      this.logger.warn(
        `${this.name}: cozy_org_domain is empty — workplaceFqdn cannot be composed`
      );
    }
    if (!this.rabbitmqUrl) {
      this.logger.warn(
        `${this.name}: rabbitmq_url is empty — AMQP publishes will be skipped`
      );
    }

    this.registerShutdown();
  }

  hooks: Hooks = {
    scimusercreatedone: async (user: ScimUser): Promise<void> => {
      const ok = await this.createCozyInstance(user);
      if (ok) {
        await this.publishUserCreated(user);
      }
    },
    scimuserdeletedone: async (id: string): Promise<void> => {
      const ok = await this.destroyCozyInstance(id);
      if (ok) {
        await this.publishUserDeleted(id);
      }
    },
  };

  /**
   * POST /instances on the cozy-stack admin API. Returns true on success
   * (including 409 idempotent "already exists").
   */
  private async createCozyInstance(user: ScimUser): Promise<boolean> {
    if (!this.cozyAdminUrl) return false;

    const id = this.extractId(user);
    if (!id) {
      this.logger.warn({
        plugin: this.name,
        event: 'createCozyInstance',
        message: 'user has no userName/id — skipping',
      });
      return false;
    }
    if (!this.cozyOrgDomain) {
      this.logger.error({
        plugin: this.name,
        event: 'createCozyInstance',
        id,
        message: 'cozy_org_domain not configured — cannot compose Domain',
      });
      return false;
    }

    const domain = `${id}.${this.cozyOrgDomain}`;
    const params = new URLSearchParams();
    params.set('Domain', domain);
    params.set('Locale', this.extractLocale(user));
    const email = this.extractPrimaryEmail(user);
    if (email) params.set('Email', email);
    const publicName = this.extractPublicName(user);
    if (publicName) params.set('PublicName', publicName);
    const phone = this.extractPrimaryPhone(user);
    if (phone) params.set('Phone', phone);
    if (this.cozyOrgId) params.set('OrgID', this.cozyOrgId);
    if (this.cozyOrgDomain) params.set('OrgDomain', this.cozyOrgDomain);
    if (this.cozyContextName) params.set('ContextName', this.cozyContextName);
    if (this.cozyApps) params.set('Apps', this.cozyApps);
    // Set the cozy instance's OIDCID to the user's SCIM userName so the
    // sub claim from the OP after authentication matches the instance and
    // cozy-stack's OIDC callback succeeds. Without this the callback fails
    // with `Invalid sub: <sub> != ""`.
    params.set('OIDCID', id);

    const url = `${this.cozyAdminUrl}/instances?${params.toString()}`;

    const log = {
      plugin: this.name,
      event: 'createCozyInstance',
      id,
      domain,
      email: email || undefined,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.cozyAdminAuthHeader,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        if (res.status === 409) {
          this.logger.info({
            ...log,
            result: 'already_exists',
            http_status: res.status,
          });
          return true;
        }
        this.logger.error({
          ...log,
          result: 'error',
          http_status: res.status,
          http_status_text: res.statusText,
        });
        return false;
      }
      this.logger.info({
        ...log,
        result: 'success',
        http_status: res.status,
      });
      await this.markInstanceOnboarded(domain);
      return true;
    } catch (err) {
      this.logger.error({
        ...log,
        result: 'error',
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
      return false;
    }
  }

  /**
   * PATCH /instances/<domain>?OnboardingFinished=true on the cozy admin API.
   *
   * SCIM-provisioned users have no signup flow to complete (the admin already
   * provisioned them), so the per-user instance should land directly in the
   * onboarded state. Without this PATCH the instance stays in onboarding and
   * the user gets dropped onto a setup wizard at first OIDC login.
   */
  private async markInstanceOnboarded(domain: string): Promise<void> {
    const url = `${this.cozyAdminUrl}/instances/${encodeURIComponent(
      domain
    )}?OnboardingFinished=true`;
    const log = {
      plugin: this.name,
      event: 'markInstanceOnboarded',
      domain,
    };
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: this.cozyAdminAuthHeader,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        this.logger.error({
          ...log,
          result: 'error',
          http_status: res.status,
          http_status_text: res.statusText,
        });
        return;
      }
      this.logger.info({
        ...log,
        result: 'success',
        http_status: res.status,
      });
    } catch (err) {
      this.logger.error({
        ...log,
        result: 'error',
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  /**
   * DELETE /instances/<domain> on the cozy-stack admin API. The SCIM delete
   * hook only removed the LDAP entry; without this, a subsequent re-import
   * of the same userName re-attaches to a stale cozy instance whose
   * per-user state (oidc_id, sharings, contacts, ...) no longer matches
   * the operator's intent. A 404 from cozy-stack is treated as success so
   * the lifecycle stays idempotent.
   */
  private async destroyCozyInstance(id: string): Promise<boolean> {
    if (!this.cozyAdminUrl) return false;
    if (!this.cozyOrgDomain) {
      this.logger.error({
        plugin: this.name,
        event: 'destroyCozyInstance',
        id,
        message: 'cozy_org_domain not configured — cannot compose Domain',
      });
      return false;
    }

    const domain = `${id}.${this.cozyOrgDomain}`;
    const url = `${this.cozyAdminUrl}/instances/${encodeURIComponent(domain)}`;
    const log = {
      plugin: this.name,
      event: 'destroyCozyInstance',
      id,
      domain,
    };

    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: this.cozyAdminAuthHeader,
          Accept: 'application/json',
        },
      });
      if (res.ok || res.status === 404) {
        this.logger.info({
          ...log,
          result: res.ok ? 'success' : 'not_found',
          http_status: res.status,
        });
        return true;
      }
      this.logger.error({
        ...log,
        result: 'error',
        http_status: res.status,
        http_status_text: res.statusText,
      });
      return false;
    } catch (err) {
      this.logger.error({
        ...log,
        result: 'error',
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
      return false;
    }
  }

  /**
   * Publish user.created on the `auth` topic exchange. Payload matches what
   * cozy-stack's stack.user.created consumer expects: a `twakeId` identifier,
   * the `organizationDomain` so the consumer can match the instance, and
   * optional `internalEmail` / `mobile` fields used for org-contact-sync.
   * Sending `sub` instead of `twakeId`, or `email` instead of `internalEmail`,
   * causes cozy-stack to nack the message.
   */
  private async publishUserCreated(user: ScimUser): Promise<void> {
    const publisher = await this.getPublisher();
    if (!publisher) return;

    const id = this.extractId(user);
    if (!id) return;
    const email = this.extractPrimaryEmail(user);
    const mobile = this.extractPrimaryPhone(user);

    const message: Record<string, unknown> = {
      twakeId: id,
      domain: this.cozyOrgDomain,
      organizationDomain: this.cozyOrgDomain,
      workplaceFqdn: `${id}.${this.cozyOrgDomain}`,
    };
    if (email) message.internalEmail = email;
    if (mobile) message.mobile = mobile;

    try {
      await publisher.publish(this.authExchange, 'user.created', message);
      this.logger.info({
        plugin: this.name,
        event: 'publishUserCreated',
        result: 'success',
        exchange: this.authExchange,
        routingKey: 'user.created',
        twakeId: id,
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserCreated',
        twakeId: id,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  /**
   * Publish domain.user.deleted on the `b2b` topic exchange so peer cozy
   * instances can drop the deleted user's contact card.
   */
  private async publishUserDeleted(id: string): Promise<void> {
    const publisher = await this.getPublisher();
    if (!publisher) return;
    if (!this.cozyOrgDomain) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserDeleted',
        id,
        message:
          'cozy_org_domain not configured — cannot compose workplaceFqdn',
      });
      return;
    }

    const message: Record<string, unknown> = {
      workplaceFqdn: `${id}.${this.cozyOrgDomain}`,
      domain: this.cozyOrgDomain,
    };

    try {
      await publisher.publish(this.b2bExchange, 'domain.user.deleted', message);
      this.logger.info({
        plugin: this.name,
        event: 'publishUserDeleted',
        result: 'success',
        exchange: this.b2bExchange,
        routingKey: 'domain.user.deleted',
        workplaceFqdn: message.workplaceFqdn,
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserDeleted',
        id,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `${err}`,
      });
    }
  }

  /**
   * Lazy-init the AMQP publisher. The `@linagora/rabbitmq-client` dependency
   * is optional — if the package or the broker is unreachable, return null
   * so callers can no-op cleanly.
   *
   * Override this in tests to inject a stub publisher.
   */
  protected async getPublisher(): Promise<RabbitPublisher | null> {
    if (this.publisher) return this.publisher;
    if (!this.rabbitmqUrl) return null;
    if (this.publisherInit) return this.publisherInit;

    this.publisherInit = (async (): Promise<RabbitPublisher | null> => {
      try {
        const mod = await import('@linagora/rabbitmq-client');
        const client = new mod.RabbitMQClient({
          url: this.rabbitmqUrl,
        }) as unknown as RabbitPublisher;
        await client.init();
        this.publisher = client;
        this.logger.info(
          `${this.name}: connected to RabbitMQ at ${redactAmqpUrl(
            this.rabbitmqUrl
          )}`
        );
        return client;
      } catch (err) {
        this.logger.warn({
          plugin: this.name,
          event: 'rabbitmq_init',
          message:
            '@linagora/rabbitmq-client unavailable or broker unreachable — AMQP publishes disabled',
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          error: `${err}`,
        });
        return null;
      }
    })();

    return this.publisherInit;
  }

  private extractId(user: ScimUser): string | null {
    if (typeof user.userName === 'string' && user.userName.length > 0) {
      return user.userName;
    }
    if (typeof user.id === 'string' && user.id.length > 0) {
      return user.id;
    }
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

  /**
   * Best-effort display name for the cozy instance's `public_name` setting,
   * which downstream features (org-contact sync, sharing, mailer, …) read
   * from the instance settings document. Without it cozy-stack's
   * SyncCreatedOrgContact bails with "missing public_name in settings".
   *
   * Order of preference: SCIM displayName → name.formatted →
   * givenName + familyName → userName/id.
   */
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
    if (composed.length > 0) return composed;
    return this.extractId(user);
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
    return this.cozyDefaultLocale;
  }

  private registerShutdown(): void {
    const shutdown = (): void => {
      const pub = this.publisher;
      // Clear both: a closed client must not be returned by a still-pending
      // initialisation promise.
      this.publisher = null;
      this.publisherInit = null;
      if (!pub) return;
      pub.close().catch((err: unknown) => {
        this.logger.warn({
          plugin: this.name,
          event: 'shutdown',
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          error: `${err}`,
        });
      });
    };
    registerProcessShutdown(shutdown);
  }
}

/**
 * Strip credentials from an AMQP URL before logging — `amqp://user:pass@host`
 * becomes `amqp://host`. Falls back to `amqp://[broker]` if the URL cannot
 * be parsed (e.g. malformed config).
 */
function redactAmqpUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return 'amqp://[broker]';
  }
}

/**
 * Registers a single SIGTERM/SIGINT handler at the process level. Each plugin
 * instance contributes one callback that fans out from the shared handler, so
 * we don't accumulate per-instance listeners (which would trip
 * MaxListenersExceededWarning when many DM instances are created in tests).
 */
const shutdownCallbacks: Array<() => void> = [];
let processShutdownInstalled = false;

function registerProcessShutdown(cb: () => void): void {
  shutdownCallbacks.push(cb);
  if (processShutdownInstalled) return;
  processShutdownInstalled = true;
  const fanOut = (): void => {
    for (const fn of shutdownCallbacks.splice(0)) {
      try {
        fn();
      } catch {
        // Hooks must never throw during shutdown.
      }
    }
  };
  process.once('SIGTERM', fanOut);
  process.once('SIGINT', fanOut);
}
