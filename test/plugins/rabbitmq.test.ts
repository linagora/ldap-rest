import { expect } from 'chai';

import { DM } from '../../src/bin';
import RabbitMq from '../../src/plugins/rabbitmq';

interface PublishCall {
  exchange: string;
  routingKey: string;
  message: Record<string, unknown>;
  options?: Record<string, unknown>;
}

interface SubscribeCall {
  exchange: string;
  routingKey: string;
  queue: string;
  handler: (m: Record<string, unknown>) => Promise<void>;
}

class StubClient {
  publishCalls: PublishCall[] = [];
  subscribeCalls: SubscribeCall[] = [];
  unsubscribeCalls: string[] = [];
  closed = false;

  async init(): Promise<void> {}
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<void> {
    this.publishCalls.push({ exchange, routingKey, message, options });
  }
  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: (m: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    this.subscribeCalls.push({ exchange, routingKey, queue, handler });
  }
  async unsubscribe(queue: string): Promise<void> {
    this.unsubscribeCalls.push(queue);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class TestableRabbitMq extends RabbitMq {
  stub = new StubClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getClient(): Promise<any> {
    return this.stub;
  }
}

/**
 * Exercises the real getClient() caching/retry policy by stubbing the
 * connect() seam: the first attempt fails, the second succeeds.
 */
class FlakyRabbitMq extends RabbitMq {
  stub = new StubClient();
  connectAttempts = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async connect(): Promise<any> {
    this.connectAttempts++;
    if (this.connectAttempts === 1) throw new Error('broker down');
    return this.stub;
  }
}

describe('RabbitMq plugin', () => {
  describe('with a configured broker URL', () => {
    let dm: DM;
    let plugin: TestableRabbitMq;

    beforeEach(async () => {
      dm = new DM();
      dm.config.rabbitmq_url = 'amqp://guest:guest@rabbitmq:5672/';
      await dm.ready;
      plugin = new TestableRabbitMq(dm);
    });

    it('reports itself as available', () => {
      expect(plugin.isAvailable()).to.equal(true);
    });

    it('delegates publish to the client', async () => {
      await plugin.publish('auth', 'user.created', { twakeId: 'alice' });
      expect(plugin.stub.publishCalls).to.have.length(1);
      const call = plugin.stub.publishCalls[0];
      expect(call.exchange).to.equal('auth');
      expect(call.routingKey).to.equal('user.created');
      expect(call.message).to.deep.equal({ twakeId: 'alice' });
    });

    it('forwards publish options to the client', async () => {
      await plugin.publish(
        'auth',
        'user.created',
        { twakeId: 'bob' },
        { correlationId: 'abc' }
      );
      expect(plugin.stub.publishCalls[0].options).to.deep.equal({
        correlationId: 'abc',
      });
    });

    it('delegates subscribe to the client', async () => {
      const handler = async (): Promise<void> => {};
      await plugin.subscribe('b2b', 'domain.user.deleted', 'my-queue', handler);
      expect(plugin.stub.subscribeCalls).to.have.length(1);
      const call = plugin.stub.subscribeCalls[0];
      expect(call.exchange).to.equal('b2b');
      expect(call.routingKey).to.equal('domain.user.deleted');
      expect(call.queue).to.equal('my-queue');
      expect(call.handler).to.equal(handler);
    });

    it('delegates unsubscribe to the client', async () => {
      await plugin.unsubscribe('my-queue');
      expect(plugin.stub.unsubscribeCalls).to.deep.equal(['my-queue']);
    });
  });

  describe('connection retry', () => {
    let dm: DM;
    let plugin: FlakyRabbitMq;

    beforeEach(async () => {
      dm = new DM();
      dm.config.rabbitmq_url = 'amqp://guest:guest@rabbitmq:5672/';
      await dm.ready;
      plugin = new FlakyRabbitMq(dm);
    });

    it('retries connecting after an initial failure', async () => {
      const first = await plugin.getRawClient();
      expect(first, 'first connect fails → null').to.equal(null);

      const second = await plugin.getRawClient();
      expect(second, 'second connect succeeds').to.equal(plugin.stub);
      expect(plugin.connectAttempts).to.equal(2);
    });
  });

  describe('with no broker URL configured', () => {
    let dm: DM;
    let plugin: RabbitMq;

    beforeEach(async () => {
      dm = new DM();
      dm.config.rabbitmq_url = '';
      await dm.ready;
      plugin = new RabbitMq(dm);
    });

    it('reports itself as unavailable', () => {
      expect(plugin.isAvailable()).to.equal(false);
    });

    it('no-ops publish without throwing', async () => {
      await plugin.publish('auth', 'user.created', { twakeId: 'alice' });
    });

    it('no-ops subscribe without throwing', async () => {
      await plugin.subscribe('b2b', 'k', 'q', async () => {});
    });

    it('no-ops unsubscribe without throwing', async () => {
      await plugin.unsubscribe('q');
    });
  });
});
