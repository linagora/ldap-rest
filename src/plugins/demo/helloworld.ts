/**
 * @module core/helloworld
 * Demo plugin, add /hello API + consumes 'hello' hook
 * @author Xavier Guimard <xguimard@linagora.com>
 */

import { Type } from '@sinclair/typebox';
import type { Express } from 'express';

import DmPlugin, { defineRoute, type Role } from '../../abstract/plugin';

/**
 * The answer of the hello-world endpoint.
 *
 * Exported because the OpenAPI generator reads it without running the
 * plugin, as it reads every schema a route declares.
 */
export const HelloResponse = Type.Object(
  {
    message: Type.String({
      description: 'Static greeting string.',
      example: 'Hello',
    }),
    hookResults: Type.Array(Type.Unknown(), {
      description:
        'Results collected from every function registered on the `hello` ' +
        'hook. Empty when no hook listeners are installed.',
      example: [],
    }),
  },
  {
    description: 'Response returned by the hello-world demo endpoint.',
    example: { message: 'Hello', hookResults: [] },
  }
);

export default class HelloWorld extends DmPlugin {
  name = 'hello';
  roles: Role[] = ['demo'] as const;

  api(app: Express): void {
    defineRoute(app, {
      method: 'get',
      path: `${this.config.api_prefix}/hello`,
      responses: {
        200: {
          schema: HelloResponse,
          description: 'Greeting with hook results.',
        },
      },
      summary: 'Demo hello-world endpoint',
      description:
        'Exists exclusively as a minimal example for plugin ' +
        'development. The handler fires the `hello` hook and collects the ' +
        'results from every registered listener into `hookResults`. In a ' +
        'production deployment this plugin is normally disabled; enabling ' +
        'it is safe but adds no functional value.',
      handler: async ({ res }) => {
        res.json({
          message: 'Hello',
          hookResults: await this.hookBus.call('hello'),
        });
      },
    });
  }
}
