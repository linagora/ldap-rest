/**
 * @module plugins/rabbitmq
 *
 * Shared RabbitMQ transport. Owns a single broker connection for the whole
 * process and exposes publish/consume so other plugins do not each bundle
 * (and re-open) their own AMQP client.
 *
 * The connection is lazy: it opens on the first publish/subscribe call, not at
 * load time, so a broker that is down or unconfigured never blocks startup.
 * `@linagora/rabbitmq-client` is an optional dependency; if the package is not
 * installed or `rabbitmq_url` is empty, every method is a logged no-op.
 *
 * Consumers declare it as a dependency and reach it through the loaded-plugin
 * registry:
 *
 *   dependencies = { rabbitmq: 'core/rabbitmq' };
 *   const rmq = this.server.loadedPlugins['rabbitmq'] as RabbitMq;
 *   await rmq.publish('auth', 'user.created', message);
 */
import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';

/** JSON-serialisable message payload. */
export type RabbitMessage = Record<string, unknown>;

/** Async handler invoked for each consumed message. */
export type RabbitMessageHandler = (message: RabbitMessage) => Promise<void>;

/** Options forwarded to the underlying client's `publish()`. */
export interface PublishOptions {
  maxAttempts?: number;
  headers?: Record<string, unknown>;
  correlationId?: string;
  messageId?: string;
  expiration?: string;
}

/** Options forwarded to the underlying client's `subscribe()`. */
export interface SubscribeOptions {
  queueArguments?: Record<string, unknown>;
}

/**
 * Subset of `@linagora/rabbitmq-client`'s `RabbitMQClient` that this plugin
 * relies on. Declared locally because the package is an optional dependency
 * and may be absent at type-check time.
 */
interface RabbitClient {
  init(): Promise<void>;
  publish(
    exchange: string,
    routingKey: string,
    message: RabbitMessage,
    options?: PublishOptions
  ): Promise<void>;
  subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMessageHandler,
    options?: SubscribeOptions
  ): Promise<void>;
  unsubscribe(queue: string): Promise<void>;
  close(clearSubscriptions?: boolean): Promise<void>;
}

export default class RabbitMq extends DmPlugin {
  name = 'rabbitmq';

  private readonly rabbitmqUrl: string;

  private client: RabbitClient | null = null;
  private clientInit: Promise<RabbitClient | null> | null = null;

  constructor(server: DM) {
    super(server);

    this.rabbitmqUrl = (this.config.rabbitmq_url as string) || '';

    if (!this.rabbitmqUrl) {
      this.logger.warn(
        `${this.name}: rabbitmq_url is empty — AMQP publishes/subscribes will be skipped`
      );
    }

    this.registerShutdown();
  }

  /**
   * Whether the plugin is configured with a broker URL. Lets consumers decide
   * whether to bother building a message. A `true` value does not guarantee
   * the broker is reachable — the connection is still lazy.
   */
  isAvailable(): boolean {
    return this.rabbitmqUrl.length > 0;
  }

  /**
   * Publish a JSON message to a topic exchange. No-op (returns silently) when
   * no broker is configured or the client is unavailable.
   */
  async publish(
    exchange: string,
    routingKey: string,
    message: RabbitMessage,
    options?: PublishOptions
  ): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    await client.publish(exchange, routingKey, message, options);
  }

  /**
   * Subscribe a handler to a topic exchange/routing-key on a named queue.
   * No-op when no broker is configured or the client is unavailable.
   */
  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMessageHandler,
    options?: SubscribeOptions
  ): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    await client.subscribe(exchange, routingKey, queue, handler, options);
  }

  /** Stop consuming from a queue. No-op when the client is unavailable. */
  async unsubscribe(queue: string): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    await client.unsubscribe(queue);
  }

  /**
   * The live broker client, or null when unavailable. Advanced consumers that
   * need features beyond publish/subscribe can reach the raw client here.
   */
  async getRawClient(): Promise<RabbitClient | null> {
    return this.getClient();
  }

  /**
   * Lazy-init the shared AMQP client. The `@linagora/rabbitmq-client`
   * dependency is optional — if the package or the broker is unreachable,
   * return null so callers can no-op cleanly.
   *
   * Override this in tests to inject a stub client.
   */
  protected async getClient(): Promise<RabbitClient | null> {
    if (this.client) return this.client;
    if (!this.rabbitmqUrl) return null;
    if (this.clientInit) return this.clientInit;

    this.clientInit = (async (): Promise<RabbitClient | null> => {
      try {
        const client = await this.connect();
        this.client = client;
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
            '@linagora/rabbitmq-client unavailable or broker unreachable — AMQP disabled',
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          error: `${err}`,
        });
        // Reset so a later call retries: a transient outage at the first
        // publish must not disable the broker for the process lifetime. Once
        // a connect succeeds, the client's own reconnection logic takes over.
        this.clientInit = null;
        return null;
      }
    })();

    return this.clientInit;
  }

  /**
   * Open and initialise the underlying client. Split out so the caching and
   * retry policy in `getClient()` can be tested without a live broker.
   */
  protected async connect(): Promise<RabbitClient> {
    const mod = await import('@linagora/rabbitmq-client');
    const client = new mod.RabbitMQClient({
      url: this.rabbitmqUrl,
    }) as unknown as RabbitClient;
    await client.init();
    return client;
  }

  private registerShutdown(): void {
    const shutdown = (): void => {
      const client = this.client;
      // Clear both: a closed client must not be returned by a still-pending
      // initialisation promise.
      this.client = null;
      this.clientInit = null;
      if (!client) return;
      client.close().catch((err: unknown) => {
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
