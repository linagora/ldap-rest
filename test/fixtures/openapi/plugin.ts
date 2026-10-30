/**
 * A plugin the OpenAPI generator reads, without running it: the schemas a
 * route declares are exported constants, the declaration lives in a helper
 * method, and the import is aliased — the generator resolves all three.
 */
import { Type } from '@sinclair/typebox';
import type { Express } from 'express';

import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import { defineRoute as declare } from '../../../src/lib/route';

export const ItemParams = Type.Object({
  id: Type.String({ minLength: 1, description: 'The item identifier' }),
  orphan: Type.Optional(Type.String()),
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
    this.declare(app);
  }

  private declare(app: Express): void {
    declare(app, {
      method: 'post',
      path: `${this.config.api_prefix}/items/:id`,
      params: ItemParams,
      query: ItemQuery,
      body: ItemBody,
      responses: {
        200: { schema: ItemResponse, description: 'The item created' },
        409: ItemResponse,
      },
      summary: 'Create an item',
      description: 'Creates the item the path names.',
      tags: ['Fixture'],
      handler: ({ res }) => {
        res.sendStatus(204);
      },
    });
  }
}
