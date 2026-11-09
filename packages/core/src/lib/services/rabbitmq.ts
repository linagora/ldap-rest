/**
 * The shared broker, as another plugin reads it.
 *
 * @see docs/plugin-development/services.md
 */
import { serviceToken } from './index.js';

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

export interface RabbitMqApi {
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
  /**
   * The underlying client, or null when the broker cannot be reached. A
   * consumer that must not lose its events checks it before publishing;
   * `publish` alone is a logged no-op without one.
   */
  getRawClient(): Promise<object | null>;
}

export const RabbitMqService = serviceToken<RabbitMqApi>('rabbitmq');
