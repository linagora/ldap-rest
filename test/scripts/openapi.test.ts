import { expect } from 'chai';
import path from 'path';

import { OpenAPIGenerator } from '../../scripts/generate-openapi';

const root = path.join(__dirname, '..', '..');

/** The spec of one operation from a route declared by `defineRoute`. */
interface Parameter {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
  description?: string;
}

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: {
    content: { 'application/json': { schema: Record<string, unknown> } };
  };
  responses: Record<
    string,
    { content?: { 'application/json': { schema: Record<string, unknown> } } }
  >;
}

describe('OpenAPI generator', () => {
  const specOf = async (
    dir: string
  ): Promise<{ paths: Record<string, Record<string, Operation>> }> => {
    const generator = new OpenAPIGenerator(root);
    await generator.analyze([dir]);
    return generator.generateSpec() as unknown as {
      paths: Record<string, Record<string, Operation>>;
    };
  };

  it('reads a defineRoute declaration, schemas included', async () => {
    const spec = await specOf(path.join(root, 'test', 'fixtures', 'openapi'));
    const operation = spec.paths['/api/items/{id}']?.post;
    expect(operation, 'the route is in the spec').to.exist;

    expect(operation.summary).to.equal('Create an item');
    expect(operation.description).to.equal('Creates the item the path names.');
    expect(operation.tags).to.deep.equal(['Fixture']);

    expect(operation.parameters?.find(p => p.name === 'id')).to.deep.equal({
      name: 'id',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        description: 'The item identifier',
      },
      description: 'The item identifier',
    });
    expect(operation.parameters?.find(p => p.name === 'verbose')).to.deep.equal(
      {
        name: 'verbose',
        in: 'query',
        required: false,
        schema: { type: 'boolean' },
        description: 'verbose parameter',
      }
    );

    expect(
      operation.requestBody?.content['application/json'].schema
    ).to.deep.equal({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('takes the declared answers, and keeps the default ones', async () => {
    const spec = await specOf(path.join(root, 'test', 'fixtures', 'openapi'));
    const operation = spec.paths['/api/items/{id}']?.post;

    expect(
      operation.responses['200'].content?.['application/json'].schema
    ).to.deep.equal({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    });
    expect(operation.responses['409'].content).to.exist;
    expect(operation.responses['400']).to.deep.equal({
      description: 'Bad request',
    });
  });

  it('documents the demo route from its declaration', async () => {
    const spec = await specOf(path.join(root, 'src', 'plugins'));
    const operation = spec.paths['/api/hello']?.get;

    expect(operation, 'the defineRoute route is in the spec').to.exist;
    expect(operation.summary).to.equal('Demo hello-world endpoint');
    const schema = operation.responses['200'].content?.['application/json']
      .schema as { properties?: { message?: { type?: string } } };
    expect(schema.properties?.message?.type).to.equal('string');
  });
});
