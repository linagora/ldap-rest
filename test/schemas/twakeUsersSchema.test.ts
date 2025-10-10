import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Twake Users Schema', () => {
  let schema: any;

  before(() => {
    const schemaPath = path.join(
      __dirname,
      '../../static/schemas/twake/users.json'
    );
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    schema = JSON.parse(schemaContent);
  });

  it('should have organizationLink role on twakeDepartmentLink', () => {
    expect(schema.attributes).to.have.property('twakeDepartmentLink');
    expect(schema.attributes.twakeDepartmentLink).to.have.property(
      'role',
      'organizationLink'
    );
  });

  it('should have organizationPath role on twakeDepartmentPath', () => {
    expect(schema.attributes).to.have.property('twakeDepartmentPath');
    expect(schema.attributes.twakeDepartmentPath).to.have.property(
      'role',
      'organizationPath'
    );
  });

  it('should have required organization fields', () => {
    expect(schema.attributes.twakeDepartmentLink).to.have.property(
      'required',
      true
    );
    expect(schema.attributes.twakeDepartmentPath).to.have.property(
      'required',
      true
    );
  });

  it('should have correct types for organization fields', () => {
    expect(schema.attributes.twakeDepartmentLink).to.have.property(
      'type',
      'string'
    );
    expect(schema.attributes.twakeDepartmentPath).to.have.property(
      'type',
      'string'
    );
  });
});
