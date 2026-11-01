import { expect } from 'chai';

import {
  diffOpenApi,
  operations,
  shapeOf,
  type OpenApiDocument,
} from '../../scripts/contracts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Document = Record<string, any>;

function document(): Document {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/api/v1/things': {
        get: {
          summary: 'List things',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Things',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id'],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Thing' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
    },
  };
}

function changed(mutate: (spec: Document) => void): Document {
  const spec = document();
  mutate(spec);
  return spec;
}

describe('OpenAPI contracts', () => {
  it('reads the operations with their path-level parameters', () => {
    const spec = document();
    spec.paths['/api/v1/things'].parameters = [
      {
        name: 'tenant',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    ];
    const found = operations(spec as OpenApiDocument);

    expect([...found.keys()]).to.deep.equal([
      'GET /api/v1/things',
      'POST /api/v1/things',
    ]);
    expect(found.get('GET /api/v1/things')?.parameters).to.have.length(2);
  });

  it('ignores documentation-only changes', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.summary = 'Another summary';
      document.paths['/api/v1/things'].get.responses['200'].description =
        'Changed';
      document.components.schemas.Thing.properties.label.description = 'x';
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('reports a removed path or method', () => {
    const withoutMethod = changed(document => {
      delete document.paths['/api/v1/things'].post;
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutMethod as OpenApiDocument
      )
    ).to.deep.include({ kind: 'removed', what: 'POST /api/v1/things' });

    const withoutPath = changed(document => {
      delete document.paths['/api/v1/things'];
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutPath as OpenApiDocument
      ).map(difference => difference.what)
    ).to.deep.equal(['GET /api/v1/things', 'POST /api/v1/things']);
  });

  it('reports a removed parameter, not an added optional one', () => {
    const withoutQuery = changed(document => {
      document.paths['/api/v1/things'].get.parameters = [];
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutQuery as OpenApiDocument
      )
    ).to.deep.include({
      kind: 'removed',
      what: 'parameter GET /api/v1/things query q',
    });

    const optional = changed(document => {
      document.paths['/api/v1/things'].get.parameters.push({
        name: 'page',
        in: 'query',
        required: false,
        schema: { type: 'number' },
      });
    });
    expect(
      diffOpenApi(document() as OpenApiDocument, optional as OpenApiDocument)
    ).to.deep.equal([]);

    const required = changed(document => {
      document.paths['/api/v1/things'].get.parameters.push({
        name: 'tenant',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    });
    expect(
      diffOpenApi(document() as OpenApiDocument, required as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things header tenant',
      detail: 'required parameter added',
    });
  });

  it('reports a parameter that becomes required or changes type', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.parameters[0].required = true;
      document.paths['/api/v1/things'].get.parameters[0].schema = {
        type: 'number',
      };
    });
    const differences = diffOpenApi(
      document() as OpenApiDocument,
      spec as OpenApiDocument
    );

    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things query q',
      detail: 'required: false → true',
    });
    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things query q',
      detail: 'type: string → number',
    });
  });

  it('reports a removed response, field or type', () => {
    const withoutStatus = changed(document => {
      delete document.paths['/api/v1/things'].get.responses['200'];
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutStatus as OpenApiDocument
      )
    ).to.deep.include({
      kind: 'removed',
      what: 'response GET /api/v1/things 200',
    });

    const withoutField = changed(document => {
      delete document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.properties.name;
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutField as OpenApiDocument
      )
    ).to.deep.include({
      kind: 'removed',
      what: 'GET /api/v1/things 200 response application/json[].name',
    });

    const changedType = changed(document => {
      document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.properties.id = { type: 'number' };
    });
    expect(
      diffOpenApi(document() as OpenApiDocument, changedType as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].id',
      detail: 'type: string → number',
    });
  });

  it('reports a removed request field or a field that becomes required', () => {
    const withoutField = changed(document => {
      delete document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.age;
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutField as OpenApiDocument
      )
    ).to.deep.include({
      kind: 'removed',
      what: 'POST /api/v1/things request application/json.age',
    });

    const nowRequired = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.required.push('age');
    });
    expect(
      diffOpenApi(document() as OpenApiDocument, nowRequired as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.age',
      detail: 'required: false → true',
    });

    const addedOptional = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.nickname = { type: 'string' };
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        addedOptional as OpenApiDocument
      )
    ).to.deep.equal([]);
  });

  it('reports a request body or media type that goes away', () => {
    const withoutBody = changed(document => {
      delete document.paths['/api/v1/things'].post.requestBody;
    });
    expect(
      diffOpenApi(document() as OpenApiDocument, withoutBody as OpenApiDocument)
    ).to.deep.include({
      kind: 'removed',
      what: 'request body POST /api/v1/things',
    });

    const withoutMedia = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content = {
        'text/plain': { schema: { type: 'string' } },
      };
    });
    expect(
      diffOpenApi(
        document() as OpenApiDocument,
        withoutMedia as OpenApiDocument
      )
    ).to.deep.include({
      kind: 'removed',
      what: 'request body POST /api/v1/things application/json',
    });
  });

  it('reports an enum value that disappears', () => {
    const withEnum = document();
    withEnum.paths['/api/v1/things'].get.parameters[0].schema = {
      type: 'string',
      enum: ['a', 'b'],
    };
    const narrowed = changed(spec => {
      spec.paths['/api/v1/things'].get.parameters[0].schema = {
        type: 'string',
        enum: ['a'],
      };
    });

    expect(
      diffOpenApi(withEnum as OpenApiDocument, narrowed as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things query q',
      detail: 'enum value "b" removed',
    });
  });

  it('treats an added operation as additive', () => {
    const spec = changed(document => {
      document.paths['/api/v1/other'] = {
        get: { responses: { '200': { description: 'ok' } } },
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({ kind: 'added', what: 'GET /api/v1/other' });
  });

  it('follows a component reference and reports its narrowing', () => {
    const spec = changed(document => {
      document.components.schemas.Thing.properties.label = { type: 'number' };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things 201 response application/json.label',
      detail: 'type: string → number',
    });
  });

  it('reports a request field added as required', () => {
    const spec = changed(document => {
      const schema =
        document.paths['/api/v1/things'].post.requestBody.content[
          'application/json'
        ].schema;
      schema.properties.nickname = { type: 'string' };
      schema.required.push('nickname');
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.nickname',
      detail: 'required: false → true',
    });
  });

  it('reports a required request body added to an operation', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.requestBody = {
        required: true,
        content: {
          'application/json': { schema: { type: 'object' } },
        },
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'request body GET /api/v1/things',
      detail: 'required request body added',
    });
  });

  it('reports a parameter that becomes explicitly required', () => {
    const base = document();
    delete base.paths['/api/v1/things'].get.parameters[0].required;
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.parameters[0].required = true;
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things query q',
      detail: 'required: false → true',
    });
  });

  it('reports a format, nullable or additional-properties narrowing', () => {
    const base = document();
    const baseSchema =
      base.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.properties.id;
    baseSchema.format = 'uuid';
    baseSchema.nullable = true;

    const spec = changed(document => {
      const schema =
        document.paths['/api/v1/things'].get.responses['200'].content[
          'application/json'
        ].schema.items.properties.id;
      schema.format = 'email';
      schema.nullable = false;
    });
    const differences = diffOpenApi(
      base as OpenApiDocument,
      spec as OpenApiDocument
    );

    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].id',
      detail: 'format: uuid → email',
    });
    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].id',
      detail: 'nullable: true → false',
    });
  });

  it('reports a response field that stops being required', () => {
    const spec = changed(document => {
      delete document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.required;
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].id',
      detail: 'required: true → false',
    });
  });

  it('reports an object-valued additional properties narrowing', () => {
    const base = document();
    const baseSchema =
      base.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items;
    baseSchema.additionalProperties = { type: 'string' };
    const spec = changed(document => {
      const schema =
        document.paths['/api/v1/things'].get.responses['200'].content[
          'application/json'
        ].schema.items;
      schema.additionalProperties = { type: 'number' };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[]{}',
      detail: 'type: string → number',
    });
  });

  it('treats an added union variant as additive', () => {
    const base = document();
    base.paths['/api/v1/things'].get.responses['200'].content[
      'application/json'
    ].schema = {
      oneOf: [{ type: 'string' }],
    };
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema = {
        oneOf: [{ type: 'string' }, { type: 'number' }],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('reports a union variant that disappears', () => {
    const base = document();
    base.paths['/api/v1/things'].get.responses['200'].content[
      'application/json'
    ].schema = {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    };
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema = {
        oneOf: [{ type: 'string' }],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json',
      detail: 'oneOf variant removed',
    });
  });

  it('reports a removed response header or a narrowed one', () => {
    const base = document();
    base.paths['/api/v1/things'].post.responses['201'] = {
      description: 'Created',
      headers: { Location: { required: true, schema: { type: 'string' } } },
    };
    const removed = changed(document => {
      document.paths['/api/v1/things'].post.responses['201'] = {
        description: 'Created',
        headers: {},
      };
    });
    expect(
      diffOpenApi(base as OpenApiDocument, removed as OpenApiDocument)
    ).to.deep.include({
      kind: 'removed',
      what: 'response header POST /api/v1/things 201 Location',
    });

    const narrowed = changed(document => {
      document.paths['/api/v1/things'].post.responses['201'] = {
        description: 'Created',
        headers: { Location: { schema: { type: 'string' } } },
      };
    });
    expect(
      diffOpenApi(base as OpenApiDocument, narrowed as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'response header POST /api/v1/things 201 Location',
      detail: 'required: true → false',
    });
  });

  it('resolves a parameter written as a component reference', () => {
    const base = document();
    base.paths['/api/v1/things'].get.parameters = [
      { $ref: '#/components/parameters/Query' },
    ];
    base.components = {
      schemas: {},
      parameters: {
        Query: { in: 'query', name: 'q', schema: { type: 'string' } },
      },
    };
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.parameters = [
        {
          $ref: '#/components/parameters/Query',
        },
      ];
      document.components = {
        schemas: {},
        parameters: {
          Query: { in: 'query', name: 'q', schema: { type: 'number' } },
        },
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'parameter GET /api/v1/things query q',
      detail: 'type: string → number',
    });
  });

  it('reports a narrowed bound and an added request-side bound', () => {
    const base = document();
    const schema =
      base.paths['/api/v1/things'].post.requestBody.content['application/json']
        .schema;
    schema.properties.name.maximum = 100;
    const spec = changed(document => {
      const schema =
        document.paths['/api/v1/things'].post.requestBody.content[
          'application/json'
        ].schema;
      schema.properties.name.maximum = 10;
      schema.properties.name.minLength = 2;
    });
    const differences = diffOpenApi(
      base as OpenApiDocument,
      spec as OpenApiDocument
    );

    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'maximum: 100 → 10',
    });
    expect(differences).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'minLength: undefined → 2',
    });
  });

  it('compares an additive edit inside a union variant field by field', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema = {
      oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
    };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema = {
        oneOf: [
          {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
          },
        ],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('reports a type replaced by a union that drops it', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        oneOf: [{ type: 'number' }, { type: 'boolean' }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'type: string → none',
    });
  });

  it('reports a null alternative added to a response', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.properties.name = {
        anyOf: [{ type: 'string' }, { type: 'null' }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].name',
      detail: 'null added to the answer',
    });
  });

  it('reports a free request value that becomes an enum', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = { type: 'string', enum: ['x'] };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'enum added',
    });
  });

  it('reports a request that stops accepting additional properties', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.additionalProperties = false;
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json',
      detail: 'additional properties no longer accepted',
    });
  });

  it('reports a changed const value', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name.const = 'a';
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name.const = 'b';
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'const: "a" → "b"',
    });
  });

  it('reports a replaced const union variant', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema = {
      anyOf: [{ const: 'a' }, { const: 'b' }],
    };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema = {
        anyOf: [{ const: 'a' }, { const: 'c' }],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json anyOf[0]',
      detail: 'const: "b" → "c"',
    });
  });

  it('reports a const alternative that closes a request value', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [
          { type: 'string', const: 'a' },
          { type: 'string', const: 'b' },
        ],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'const: undefined → "a"',
    });
  });

  it('reports an enum alternative that closes a request value', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [{ type: 'string', enum: ['x'] }, { type: 'number' }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'enum added',
    });
  });

  it('reports a bound added inside a union alternative', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [{ type: 'string', maxLength: 3 }, { type: 'null' }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'maxLength: undefined → 3',
    });
  });

  it('reports a closed object alternative', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name = { type: 'object' };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [
          { type: 'object', additionalProperties: false },
          { type: 'null' },
        ],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'additional properties no longer accepted',
    });
  });

  it('reports an item alternative that closes the values', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name = { type: 'array', items: { type: 'string' } };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        type: 'array',
        items: { anyOf: [{ type: 'string', const: 'a' }] },
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name[]',
      detail: 'const: undefined → "a"',
    });
  });

  it('reports an enum added through allOf', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        type: 'string',
        allOf: [{ enum: ['x'] }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'enum added',
    });
  });

  it('leaves an enum split across union alternatives additive', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name = { type: 'string', enum: ['a', 'b'] };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [
          { type: 'string', enum: ['a'] },
          { type: 'string', enum: ['b'] },
        ],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('reports an untyped request value that becomes a union', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name = {};
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [{ const: 'a' }, { const: 'b' }],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'type: none → union',
    });
  });

  it('reports an enum added next to the type through oneOf', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        type: 'string',
        oneOf: [{ enum: ['x'] }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'POST /api/v1/things request application/json.name',
      detail: 'enum added',
    });
  });

  it('leaves a union additive when an alternative keeps the base', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [{ type: 'string' }, { type: 'string', const: 'a' }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('keeps a const an alternative of the union carries', () => {
    const base = document();
    base.paths['/api/v1/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name = { const: 'a' };
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema.properties.name = {
        anyOf: [{ const: 'a' }, { const: 'b' }],
      };
    });

    expect(
      diffOpenApi(base as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('keeps the properties an allOf member does not touch', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].post.requestBody.content[
        'application/json'
      ].schema = {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
        allOf: [{ properties: { age: { type: 'number' } } }],
      };
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.equal([]);
  });

  it('reports a nullable response field that was not nullable', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.responses['200'].content[
        'application/json'
      ].schema.items.properties.name.nullable = true;
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json[].name',
      detail: 'null added to the answer',
    });
  });

  it('reports security requirements added to an operation', () => {
    const spec = changed(document => {
      document.paths['/api/v1/things'].get.security = [{ bearer: [] }];
    });

    expect(
      diffOpenApi(document() as OpenApiDocument, spec as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'security GET /api/v1/things',
      detail: 'security requirements changed',
    });
  });

  it('reports array and multiple-of bounds added to a request', () => {
    const base = document();
    const schema =
      base.paths['/api/v1/things'].post.requestBody.content['application/json']
        .schema;
    schema.properties.tags = { type: 'array', items: { type: 'string' } };
    const spec = changed(document => {
      const schema =
        document.paths['/api/v1/things'].post.requestBody.content[
          'application/json'
        ].schema;
      schema.properties.tags = {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
      };
      schema.properties.age = { type: 'number', multipleOf: 5 };
    });
    const differences = diffOpenApi(
      base as OpenApiDocument,
      spec as OpenApiDocument
    );

    for (const detail of [
      'minItems: undefined → 1',
      'maxItems: undefined → 3',
      'multipleOf: undefined → 5',
    ])
      expect(differences).to.deep.include({
        kind: 'changed',
        what:
          detail === 'multipleOf: undefined → 5'
            ? 'POST /api/v1/things request application/json.age'
            : 'POST /api/v1/things request application/json.tags',
        detail,
      });
  });

  it('reports a response reached through a component reference', () => {
    const base = document();
    base.paths['/api/v1/things'].get.responses['200'] = {
      $ref: '#/components/responses/Thing',
    };
    base.components.responses = {
      Thing: {
        description: 'Things',
        content: {
          'application/json': { schema: { type: 'string' } },
        },
      },
    };

    expect(
      diffOpenApi(base as OpenApiDocument, document() as OpenApiDocument)
    ).to.deep.include({
      kind: 'changed',
      what: 'GET /api/v1/things 200 response application/json',
      detail: 'type: string → array',
    });
  });

  it('stops on a cycle between component schemas', () => {
    const spec = document();
    spec.components.schemas.A = {
      type: 'object',
      properties: { b: { $ref: '#/components/schemas/B' } },
    };
    spec.components.schemas.B = {
      type: 'object',
      properties: { a: { $ref: '#/components/schemas/A' } },
    };

    expect(() =>
      shapeOf(spec.components.schemas.A, spec as OpenApiDocument)
    ).not.to.throw();
  });
});
