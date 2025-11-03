# Testing with Embedded LDAP Server

## Overview

The test suite now includes an **embedded LDAP server** that runs automatically in Docker when no external LDAP is configured. This provides:

- ✅ **Zero-configuration testing** - Works out of the box in CI/CD
- ✅ **Isolation** - Each test run gets a fresh LDAP instance
- ✅ **Flexibility** - Use either embedded or external LDAP
- ✅ **Fast** - Server starts in ~2-3 seconds

## How It Works

### Automatic Server Selection

The test framework automatically detects which LDAP server to use:

```
┌─────────────────────────────────────┐
│ Test starts                         │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ Check environment variables:        │
│ - DM_LDAP_URL                       │
│ - DM_LDAP_DN                        │
│ - DM_LDAP_PWD                       │
│ - DM_LDAP_BASE                      │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
  ┌─────────┐   ┌──────────┐
  │ All set │   │ Missing  │
  └────┬────┘   └─────┬────┘
       │              │
       ▼              ▼
  ┌─────────────┐  ┌────────────────┐
  │ Use         │  │ Start embedded │
  │ external    │  │ Docker LDAP    │
  │ LDAP        │  │ server         │
  └─────────────┘  └────────────────┘
```

### Test Output Examples

**With embedded LDAP (default):**

```
🚀 Setting up global test environment...

ℹ️  No external LDAP configured, starting embedded LDAP server...

Starting LDAP test server on port 36759...
✓ LDAP test server started on port 36759 (container: ldap-test-...)
Loading initial LDIF from .../base-structure.ldif...
✓ Initial LDIF loaded
✓ Embedded LDAP server ready
  URL: ldap://localhost:36759
  Base DN: dc=example,dc=com
```

**With external LDAP:**

```
🚀 Setting up global test environment...

✓ Using external LDAP server
  URL: ldap://my-server:389
  Base DN: dc=company,dc=com
```

## Usage

### Running Tests

**Using embedded LDAP (no setup required):**

```bash
npm test
npm run test:one test/plugins/ldap/flatGeneric.test.ts
```

**Using external LDAP:**

```bash
export DM_LDAP_URL=ldap://localhost:389
export DM_LDAP_DN=cn=admin,dc=example,dc=com
export DM_LDAP_PWD=secret
export DM_LDAP_BASE=dc=example,dc=com

npm test
```

### In CI/CD

**GitHub Actions example:**

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test
        # No LDAP setup needed - embedded server starts automatically!
```

## LDAP Fixtures

The embedded server loads pre-configured test data:

### Base Structure (`test/fixtures/base-structure.ldif`)

- **Branches:**
  - `ou=users,dc=example,dc=com` (B2C users)
  - `ou=groups,dc=example,dc=com` (B2C groups)
  - `ou=nomenclature,dc=example,dc=com` (reference data)

- **Test Users:**
  - `john.doe@example.com` / password: `password123`
  - `jane.smith@example.com` / password: `password123`

- **Test Groups:**
  - `cn=admins` (contains john.doe, jane.smith)

- **Nomenclature Data:**
  - Titles: Dr, Mr, Ms
  - List Types: openList, memberRestrictedList
  - Mailbox Types: group, mailingList, teamMailbox

### B2B Organizations (`test/fixtures/b2b-organizations.ldif`)

For future B2B testing:

- **Acme Corporation** (`o=acme-corp`)
  - Users: alice@acme-corp.example.com, bob@acme-corp.example.com
  - Groups: engineering, management

- **Beta Industries** (`o=beta-industries`)
  - Users: charlie@beta-industries.example.com
  - Groups: sales

## Implementation Details

### Key Files

```
test/
├── setup.ts                      # Global test hooks
├── helpers/
│   ├── ldapServer.ts            # LDAP Docker server management
│   ├── env.ts                   # Environment detection
│   └── testSetup.ts             # Helper to access server in tests
└── fixtures/
    ├── base-structure.ldif      # B2C test data
    └── b2b-organizations.ldif   # B2B test data (future)
```

### How It Works Internally

1. **Startup** (`test/setup.ts:mochaHooks.beforeAll`):
   - Check if `DM_LDAP_*` env vars are set
   - If yes → use external LDAP
   - If no → start Docker container with OpenLDAP
   - Load fixtures from `test/fixtures/*.ldif`
   - Set environment variables for DM

2. **During Tests**:
   - All tests use `process.env.DM_LDAP_*` transparently
   - Works exactly the same whether using embedded or external LDAP

3. **Cleanup** (`test/setup.ts:mochaHooks.afterAll`):
   - Stop and remove Docker container (only if embedded)
   - External LDAP is left untouched

### Environment Variables Set

When using embedded LDAP, these are automatically set:

```bash
DM_LDAP_URL=ldap://localhost:<random-port>
DM_LDAP_DN=cn=admin,dc=example,dc=com
DM_LDAP_PWD=adminpassword
DM_LDAP_BASE=dc=example,dc=com
DM_LDAP_TOP_ORGANIZATION=dc=example,dc=com
DM_JAMES_WEBADMIN_URL=http://localhost:8000
DM_JAMES_WEBADMIN_TOKEN=test-token
```

## Accessing the LDAP Server in Tests

### Standard Usage (via DM)

Most tests don't need direct LDAP access - they test via the API:

```typescript
import { DM } from '../../../src/bin';

describe('My plugin', () => {
  let server: DM;

  before(async () => {
    server = new DM(); // Reads env vars automatically
    await server.ready;
  });

  it('should work', async () => {
    // Test via API
    const res = await request.get('/api/v1/users');
    expect(res.status).to.equal(200);
  });
});
```

### Direct LDAP Access

For tests that need direct LDAP operations:

```typescript
import { getTestLdapServer } from '../helpers/testSetup';

describe('Advanced LDAP test', () => {
  it('should perform raw LDAP operations', async () => {
    const server = getTestLdapServer();

    // Direct LDAP search
    const result = await server.search('(uid=john.doe)', ['cn', 'mail']);
    expect(result).to.include('john.doe');

    // Load additional test data
    await server.loadLdif(`
      dn: uid=test,ou=users,dc=example,dc=com
      objectClass: inetOrgPerson
      uid: test
      cn: Test User
      sn: User
      mail: test@example.com
    `);
  });
});
```

## Requirements

- **Docker** must be installed and running
- Tests will fail gracefully if Docker is not available
- Port range 30000-40000 must be available (for random port assignment)

## Troubleshooting

### Container Won't Start

```bash
# Check Docker is running
docker ps

# Check for conflicting containers
docker ps -a | grep ldap-test

# Clean up old test containers
docker rm -f $(docker ps -a | grep ldap-test | awk '{print $1}')
```

### Tests Timeout

Increase timeout in your test if LDAP is slow to start:

```typescript
before(async function () {
  this.timeout(120000); // 2 minutes
  // ...
});
```

### Wrong LDAP Data

The embedded server loads fresh data on each run. If you see stale data, you're likely connected to an external LDAP server. Check:

```bash
echo $DM_LDAP_URL
# Should be empty or ldap://localhost:<high-port>
```

## Migration Guide

### Existing Tests

No changes needed! Tests using `skipIfMissingEnvVars()` will now always pass:

```typescript
// Before: Would skip if no external LDAP
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('My test', () => {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]); // Still works!
  });
});

// Now: Runs with embedded LDAP automatically
```

### New Tests

Simply write tests without any LDAP setup:

```typescript
import { DM } from '../../../src/bin';

describe('New plugin', () => {
  let server: DM;

  before(async () => {
    server = new DM(); // That's it!
    await server.ready;
  });

  it('should work', () => {
    // Your test here
  });
});
```

## Future Enhancements

- [ ] Support for loading custom fixtures per test suite
- [ ] B2B organization fixtures automatically loaded
- [ ] LDAP server connection pooling across test files
- [ ] Parallel test execution with multiple LDAP containers
