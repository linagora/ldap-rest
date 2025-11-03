# Test Suite

## Quick Start

```bash
# Run all tests (uses embedded LDAP server automatically)
npm test

# Run a specific test file
npm run test:one test/plugins/ldap/flatGeneric.test.ts

# Run with external LDAP server
export DM_LDAP_URL=ldap://localhost:389
export DM_LDAP_DN=cn=admin,dc=example,dc=com
export DM_LDAP_PWD=secret
export DM_LDAP_BASE=dc=example,dc=com
npm test
```

## Overview

The test suite automatically manages LDAP server setup:

- **No LDAP configured** → Embedded Docker LDAP server starts automatically
- **LDAP env vars set** → Uses your external LDAP server

This means tests work:

- ✅ In CI/CD without any setup
- ✅ Locally without installing LDAP
- ✅ With your existing LDAP server if configured

## Documentation

See [Testing with Embedded LDAP](../docs/testing-with-embedded-ldap.md) for complete documentation.

## Test Structure

```
test/
├── helpers/
│   ├── ldapServer.ts          # Docker LDAP server management
│   ├── env.ts                 # Environment detection
│   └── testSetup.ts           # Test helpers
├── fixtures/
│   ├── base-structure.ldif    # B2C test data (always loaded)
│   └── b2b-organizations.ldif # B2B test data (future use)
├── integration/
│   └── ldapServer.test.ts     # Infrastructure tests
├── plugins/
│   ├── ldap/                  # LDAP plugin tests
│   ├── twake/                 # Twake plugin tests
│   └── auth/                  # Auth plugin tests
└── setup.ts                   # Global test configuration
```

## Requirements

- **Node.js** 20+
- **Docker** (for embedded LDAP server)

## Writing Tests

### Standard Test

```typescript
import { expect } from 'chai';
import { DM } from '../../src/bin';

describe('My Feature', () => {
  let server: DM;

  before(async () => {
    server = new DM();
    await server.ready;
  });

  it('should work', async () => {
    // Your test here
  });
});
```

### Test with Direct LDAP Access

```typescript
import { getTestLdapServer } from '../helpers/testSetup';

describe('Advanced LDAP Feature', () => {
  it('should query LDAP directly', async () => {
    const ldap = getTestLdapServer();
    const result = await ldap.search('(uid=john.doe)');
    expect(result).to.include('john.doe');
  });
});
```

## Test Data

Pre-loaded LDAP data:

**Users:**

- john.doe@example.com (password: password123)
- jane.smith@example.com (password: password123)

**Groups:**

- cn=admins (members: john.doe, jane.smith)

**Nomenclature:**

- Titles: Dr, Mr, Ms
- List Types: openList, memberRestrictedList
- Mailbox Types: group, mailingList, teamMailbox

## Troubleshooting

**Tests fail with "LDAP server not started":**

```bash
# Check Docker is running
docker ps

# Clean up old containers
docker rm -f $(docker ps -a | grep ldap-test | awk '{print $1}')
```

**Tests are slow:**

- First test run starts LDAP server (~2-3s)
- Subsequent tests in same run are fast
- Server is shared across all tests in a single `npm test` run

**Want to use external LDAP:**

```bash
# Set these before running tests
export DM_LDAP_URL=ldap://your-server:389
export DM_LDAP_DN=cn=admin,dc=yourdc,dc=com
export DM_LDAP_PWD=your-password
export DM_LDAP_BASE=dc=yourdc,dc=com
```
