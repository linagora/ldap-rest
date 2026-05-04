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
  private readonly rabbitmqUrl: string;
  private readonly authExchange: string;
  private readonly b2bExchange: string;

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
    this.rabbitmqUrl = (this.config.rabbitmq_url as string) || '';
    this.authExchange = (this.config.cozy_auth_exchange as string) || 'auth';
    this.b2bExchange = (this.config.cozy_b2b_exchange as string) || 'b2b';

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
      await this.publishUserDeleted(id);
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
    if (this.cozyOrgId) params.set('OrgID', this.cozyOrgId);
    if (this.cozyOrgDomain) params.set('OrgDomain', this.cozyOrgDomain);

    const url = `${this.cozyAdminUrl}/instances?${params.toString()}`;
    const auth = Buffer.from(
      `${this.cozyAdminUser}:${this.cozyAdminPassphrase}`
    ).toString('base64');

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
          Authorization: `Basic ${auth}`,
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
   * Publish user.created on the `auth` topic exchange. Payload mirrors what
   * cozy-stack expects: a sub identifier, an optional email, and the
   * organizationDomain so consumers can match the instance.
   */
  private async publishUserCreated(user: ScimUser): Promise<void> {
    const publisher = await this.getPublisher();
    if (!publisher) return;

    const id = this.extractId(user);
    if (!id) return;
    const email = this.extractPrimaryEmail(user);

    const message: Record<string, unknown> = {
      sub: id,
      organizationDomain: this.cozyOrgDomain,
      workplaceFqdn: `${id}.${this.cozyOrgDomain}`,
    };
    if (email) message.email = email;

    try {
      await publisher.publish(this.authExchange, 'user.created', message);
      this.logger.info({
        plugin: this.name,
        event: 'publishUserCreated',
        result: 'success',
        exchange: this.authExchange,
        routingKey: 'user.created',
        sub: id,
      });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'publishUserCreated',
        sub: id,
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
