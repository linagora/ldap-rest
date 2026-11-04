/**
 * The umbrella still publishes the LDAP plugins at their historical paths, so
 * an import that predates the packages keeps resolving. Each shim must
 * re-export exactly what its package does, until phase 3 removes the former
 * sub-paths.
 *
 * See `docs/development/modularization-plan.md`.
 */
import { expect } from 'chai';
import * as ldapAccountLifecycle from '@ldap-rest/ldap-accountlifecycle';
import * as ldapBulkImport from '@ldap-rest/ldap-bulkimport';
import * as ldapDepartmentSync from '@ldap-rest/ldap-departmentsync';
import * as ldapEnterpriseRules from '@ldap-rest/ldap-enterpriserules';
import * as ldapExternalUsers from '@ldap-rest/ldap-externalusers';
import * as ldapFlatGeneric from '@ldap-rest/ldap-flatgeneric';
import * as ldapGroups from '@ldap-rest/ldap-groups';
import * as ldapOnChange from '@ldap-rest/ldap-onchange';
import * as ldapOrganizations from '@ldap-rest/ldap-organizations';
import * as ldapPasswordPolicy from '@ldap-rest/ldap-passwordpolicy';
import * as ldapRaw from '@ldap-rest/ldap-raw';
import * as ldapTrash from '@ldap-rest/ldap-trash';
import * as ldapBulkImportOptions from '@ldap-rest/ldap-bulkimport/options';
import * as ldapEnterpriseRulesOptions from '@ldap-rest/ldap-enterpriserules/options';
import * as ldapExternalUsersOptions from '@ldap-rest/ldap-externalusers/options';
import * as ldapFlatGenericOptions from '@ldap-rest/ldap-flatgeneric/options';
import * as ldapGroupsOptions from '@ldap-rest/ldap-groups/options';
import * as ldapOrganizationsOptions from '@ldap-rest/ldap-organizations/options';
import * as ldapPasswordPolicyOptions from '@ldap-rest/ldap-passwordpolicy/options';
import * as ldapRawOptions from '@ldap-rest/ldap-raw/options';
import * as ldapTrashOptions from '@ldap-rest/ldap-trash/options';

import * as shimAccountLifecycle from '../../../src/plugins/ldap/accountLifecycle';
import * as shimBulkImport from '../../../src/plugins/ldap/bulkImport';
import * as shimDepartmentSync from '../../../src/plugins/ldap/departmentSync';
import * as shimEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import * as shimExternalUsers from '../../../src/plugins/ldap/externalUsersInGroups';
import * as shimFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import * as shimGroups from '../../../src/plugins/ldap/groups';
import * as shimOnChange from '../../../src/plugins/ldap/onChange';
import * as shimOrganizations from '../../../src/plugins/ldap/organizations';
import * as shimPasswordPolicy from '../../../src/plugins/ldap/passwordPolicy';
import * as shimRaw from '../../../src/plugins/ldap/raw';
import * as shimTrash from '../../../src/plugins/ldap/trash';
import shimOrganization from '../../../src/plugins/ldap/organization';
import * as shimOptions from '../../../src/plugins/ldap/ldap.options';

type Namespace = Record<string, unknown>;

/** Historical shim path, package it re-exports, both modules */
const pairs: Array<[string, string, Namespace, Namespace]> = [
  [
    'accountLifecycle',
    '@ldap-rest/ldap-accountlifecycle',
    shimAccountLifecycle,
    ldapAccountLifecycle,
  ],
  ['bulkImport', '@ldap-rest/ldap-bulkimport', shimBulkImport, ldapBulkImport],
  [
    'departmentSync',
    '@ldap-rest/ldap-departmentsync',
    shimDepartmentSync,
    ldapDepartmentSync,
  ],
  [
    'enterpriseRules',
    '@ldap-rest/ldap-enterpriserules',
    shimEnterpriseRules,
    ldapEnterpriseRules,
  ],
  [
    'externalUsersInGroups',
    '@ldap-rest/ldap-externalusers',
    shimExternalUsers,
    ldapExternalUsers,
  ],
  [
    'flatGeneric',
    '@ldap-rest/ldap-flatgeneric',
    shimFlatGeneric,
    ldapFlatGeneric,
  ],
  ['groups', '@ldap-rest/ldap-groups', shimGroups, ldapGroups],
  ['onChange', '@ldap-rest/ldap-onchange', shimOnChange, ldapOnChange],
  [
    'organizations',
    '@ldap-rest/ldap-organizations',
    shimOrganizations,
    ldapOrganizations,
  ],
  [
    'passwordPolicy',
    '@ldap-rest/ldap-passwordpolicy',
    shimPasswordPolicy,
    ldapPasswordPolicy,
  ],
  ['raw', '@ldap-rest/ldap-raw', shimRaw, ldapRaw],
  ['trash', '@ldap-rest/ldap-trash', shimTrash, ldapTrash],
];

/** The option sets and helpers the former entry published */
const optionPairs: Array<[string, Namespace]> = [
  ['bulkImportOptions', ldapBulkImportOptions],
  ['enterpriseRulesOptions', ldapEnterpriseRulesOptions],
  ['externalUsersOptions', ldapExternalUsersOptions],
  ['flatGenericOptions', ldapFlatGenericOptions],
  ['groupsOptions', ldapGroupsOptions],
  ['organizationOptions', ldapOrganizationsOptions],
  ['passwordPolicyOptions', ldapPasswordPolicyOptions],
  ['rawOptions', ldapRawOptions],
  ['trashOptions', ldapTrashOptions],
];

const optionHelpers = [
  'groupsOptionsOf',
  'organizationOptionsOf',
  'trashOptionsOf',
].sort();

describe('the historical LDAP sub-paths', () => {
  for (const [name, packageName, shim, pkg] of pairs)
    it(`src/plugins/ldap/${name} re-exports ${packageName}`, () => {
      expect(Object.keys(shim).sort()).to.deep.equal(Object.keys(pkg).sort());
      for (const key of Object.keys(pkg))
        expect(shim[key], key).to.equal(pkg[key]);
    });

  it('src/plugins/ldap/organization still names the organizations plugin', () => {
    expect(shimOrganization).to.equal(ldapOrganizations.default);
  });

  it('plugin-ldap-ldap.options re-exports every option set', () => {
    const names = Object.keys(shimOptions).sort();
    expect(names).to.deep.equal(
      [...optionPairs.map(([key]) => key), ...optionHelpers].sort()
    );
    for (const [key, pkg] of optionPairs)
      expect((shimOptions as Namespace)[key], key).to.equal(pkg[key]);
  });
});
