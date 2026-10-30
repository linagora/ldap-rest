/**
 * A plugin the OpenAPI generator reads, without running it: the schemas a
 * route declares are exported constants.
 */
import { Type } from '@sinclair/typebox';
import type { Express } from 'express';

import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import { defineRoute } from '../../../src/lib/route';

export const ItemParams = Type.Object({
  id: Type.String({ minLength: 1, description: 'The item identifier' }),
});

export const ItemQuery = Type.Object({
  verbose: Type.Optional(Type.Boolean()),
});

export const ItemBody = Type.Object(
  { name: Type.String() },
  { additionalProperties: false }
);

export const ItemResponse = Type.Object({
  id: Type.String(),
  name: Type.String(),
});

export default class FixturePlugin extends DmPlugin {
  name = 'fixture';
  roles: Role[] = ['api'] as const;

  api(app: Express): void {
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/items/:id`,
      params: ItemParams,
      query: ItemQuery,
      body: ItemBody,
      responses: { 200: ItemResponse, 409: ItemResponse },
      summary: 'Create an item',
      description: 'Creates the item the path names.',
      tags: ['Fixture'],
      handler: ({ res }) => {
        res.sendStatus(204);
      },
    });
  }
}
