# LDAP Bulk Import Plugin

Generic CSV-based bulk import plugin for LDAP resources, automatically configured from JSON schemas.

## Overview

The `ldapBulkImport` plugin provides CSV import functionality for any LDAP resource type (users, groups, etc.) by reading JSON schema definitions. It automatically:

- Generates CSV templates based on schema attributes
- Excludes fixed attributes from CSV (auto-populated from schema)
- Auto-calculates organization link and path from a single `organizationDn` column
- Validates data against schema requirements
- Supports dry-run mode for testing
- Provides detailed success/failure reports

## Configuration

### CLI Arguments

```bash
--plugin core/ldap/bulkImport \
--bulk-import-schemas "users:./static/schemas/twake/users.json,groups:./static/schemas/twake/groups.json" \
--bulk-import-max-file-size 10485760 \
--bulk-import-batch-size 100
```

### Configuration Options

| Argument                      | Environment Variable           | Default    | Description                                   |
| ----------------------------- | ------------------------------ | ---------- | --------------------------------------------- |
| `--bulk-import-schemas`       | `DM_BULK_IMPORT_SCHEMAS`       | (required) | Comma-separated list of resource:schema pairs |
| `--bulk-import-max-file-size` | `DM_BULK_IMPORT_MAX_FILE_SIZE` | `10485760` | Maximum upload file size in bytes (10MB)      |
| `--bulk-import-batch-size`    | `DM_BULK_IMPORT_BATCH_SIZE`    | `100`      | Number of records to process at once          |

### Schema Configuration Format

Format: `"resourceName:path/to/schema.json,resourceName2:path/to/schema2.json"`

**Example**:

```bash
--bulk-import-schemas "users:./static/schemas/twake/users.json,groups:./static/schemas/twake/groups.json"
```

This creates two import APIs:

- `/api/v1/ldap/bulk-import/users/*`
- `/api/v1/ldap/bulk-import/groups/*`

## REST API

For each configured schema, the plugin automatically generates two endpoints:

### GET /api/v1/ldap/bulk-import/{resource}/template.csv

Downloads a CSV template file with headers based on the schema.

**Response**: CSV file with headers

**Example**:

```bash
curl -O "http://localhost:8081/api/v1/ldap/bulk-import/users/template.csv"
```

**Generated template** (for users):

```csv
uid,cn,sn,givenName,mail,userPassword,telephoneNumber,organizationDn
```

**Notes**:

- Excludes attributes with `"fixed": true` (auto-populated)
- Excludes attributes with `"role": ["organizationLink"]` or `"role": ["organizationPath"]` (auto-calculated)
- Includes special column `organizationDn` for organization assignment

### POST /api/v1/ldap/bulk-import/{resource}

Bulk import entries from CSV file.

**Request** (multipart/form-data):

| Field             | Type    | Required | Default | Description                                   |
| ----------------- | ------- | -------- | ------- | --------------------------------------------- |
| `file`            | File    | Yes      | -       | CSV file to import                            |
| `dryRun`          | Boolean | No       | `false` | Validate without creating entries             |
| `updateExisting`  | Boolean | No       | `false` | Update entries if they already exist          |
| `continueOnError` | Boolean | No       | `true`  | Continue processing even if some entries fail |

**Response (200)**:

```json
{
  "success": true,
  "total": 100,
  "created": 95,
  "updated": 0,
  "skipped": 3,
  "failed": 2,
  "errors": [
    {
      "line": 15,
      "identifier": "baduser",
      "error": "Missing required attribute: sn"
    },
    {
      "line": 42,
      "identifier": "duplicate",
      "error": "Organization not found: ou=InvalidDept,dc=example,dc=com"
    }
  ],
  "details": {
    "duration": "2.5s",
    "linesProcessed": 100
  }
}
```

**Example**:

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "dryRun=false" \
  -F "updateExisting=false" \
  -F "continueOnError=true"
```

## CSV Format

### Basic Structure

```csv
uid,cn,sn,givenName,mail,userPassword,organizationDn
jdoe,John Doe,Doe,John,john.doe@example.com,password123,ou=IT,ou=organization,dc=example,dc=com
asmith,Alice Smith,Smith,Alice,alice.smith@example.com,secret456,ou=HR,ou=organization,dc=example,dc=com
```

### Special Column: `organizationDn`

The `organizationDn` column is special and triggers automatic calculation of:

1. **Organization Link** - Attribute with `role: ["organizationLink"]` in schema
   - Automatically set to the value of `organizationDn`

2. **Organization Path** - Attribute with `role: ["organizationPath"]` in schema
   - Automatically fetched from the organization's LDAP entry
   - Example: `"IT / organization"` for `ou=IT,ou=organization,dc=example,dc=com`

### Multi-Value Attributes

Use semicolon (`;`) as separator for multi-value attributes:

```csv
uid,cn,sn,mail,organizationDn
jdoe,John Doe,Doe,john@example.com;j.doe@example.com;jdoe@company.com,ou=IT,dc=example,dc=com
```

This creates:

```
mail: john@example.com
mail: j.doe@example.com
mail: jdoe@company.com
```

### Fixed Attributes

Attributes marked as `"fixed": true` in the schema are automatically added and should NOT be included in the CSV:

**Schema**:

```json
{
  "properties": {
    "objectClass": {
      "type": "array",
      "fixed": true,
      "default": ["inetOrgPerson", "organizationalPerson", "person", "top"]
    }
  }
}
```

**CSV** (objectClass NOT included):

```csv
uid,cn,sn,mail
jdoe,John Doe,Doe,jdoe@example.com
```

**Result in LDAP**:

```
objectClass: inetOrgPerson
objectClass: organizationalPerson
objectClass: person
objectClass: top
uid: jdoe
cn: John Doe
sn: Doe
mail: jdoe@example.com
```

## Complete Example

### Step 1: Configure Plugin

```bash
--plugin core/ldap/bulkImport \
--bulk-import-schemas "users:./static/schemas/twake/users.json"
```

### Step 2: Download Template

```bash
curl -O "http://localhost:8081/api/v1/ldap/bulk-import/users/template.csv"
```

**Generated `users-template.csv`**:

```csv
uid,cn,sn,givenName,mail,userPassword,telephoneNumber,organizationDn
```

### Step 3: Fill CSV File

**users.csv**:

```csv
uid,cn,sn,givenName,mail,userPassword,telephoneNumber,organizationDn
jdoe,John Doe,Doe,John,john.doe@example.com,SecurePass123,+1-555-0100,ou=Engineering,ou=organization,dc=example,dc=com
asmith,Alice Smith,Smith,Alice,alice.smith@example.com,SecretPass456,+1-555-0101,ou=Marketing,ou=organization,dc=example,dc=com
bwilson,Bob Wilson,Wilson,Bob,bob.wilson@example.com,MyPass789,+1-555-0102,ou=Engineering,ou=organization,dc=example,dc=com
```

### Step 4: Test with Dry Run

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "dryRun=true"
```

**Response**:

```json
{
  "success": true,
  "total": 3,
  "created": 3,
  "failed": 0,
  "errors": [],
  "details": {
    "duration": "0.5s",
    "linesProcessed": 3
  }
}
```

### Step 5: Import for Real

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "dryRun=false"
```

### Step 6: Verify in LDAP

```bash
ldapsearch -x -b "ou=users,dc=example,dc=com" "(uid=jdoe)"
```

**Result**:

```
dn: uid=jdoe,ou=users,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: organizationalPerson
objectClass: person
objectClass: top
uid: jdoe
cn: John Doe
sn: Doe
givenName: John
mail: john.doe@example.com
userPassword: {SSHA}...
telephoneNumber: +1-555-0100
twakeDepartmentLink: ou=Engineering,ou=organization,dc=example,dc=com
twakeDepartmentPath: Engineering / organization
```

## Operation Modes

### Dry Run Mode

Validate CSV without creating entries:

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "dryRun=true"
```

**Use cases**:

- Test CSV format before actual import
- Validate required attributes
- Check organization DNs exist
- Estimate import duration

### Update Existing Mode

Update entries that already exist:

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "updateExisting=true"
```

**Behavior**:

- If entry exists: Updates all attributes from CSV
- If entry doesn't exist: Creates new entry
- Uses LDAP `modify` operation for updates

### Continue on Error Mode

Process all records even if some fail:

```bash
curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
  -F "file=@users.csv" \
  -F "continueOnError=true"
```

**Behavior** (default: `true`):

- Continues processing remaining records after errors
- Collects all errors in response
- Reports partial success
- Successfully created entries remain in LDAP even if later entries fail

**Example with 5 entries**:
- Entry 1: ✅ Created
- Entry 2: ✅ Created
- Entry 3: ❌ Failed (invalid organization)
- Entry 4: ✅ Created (processed despite previous error)
- Entry 5: ✅ Created

**Result**: 4 created, 1 failed, all errors reported

**Opposite** (`continueOnError=false`):

- Stops at first error
- Returns immediately with error
- Previously created entries remain in LDAP
- No rollback (LDAP doesn't support transactions)

**Example with same 5 entries**:
- Entry 1: ✅ Created
- Entry 2: ✅ Created
- Entry 3: ❌ Failed → **STOPS HERE**
- Entry 4: ⏭️ Not processed
- Entry 5: ⏭️ Not processed

**Result**: 2 created, 1 failed, entries 4-5 not processed

**Important**: Entries already created are NOT rolled back. If you need to undo, you must manually delete them or re-run with correct data using `updateExisting=true`.

## Error Handling

### Common Errors

#### Missing Required Attribute

**CSV**:

```csv
uid,cn,mail
jdoe,John Doe,jdoe@example.com
```

**Error**:

```json
{
  "line": 2,
  "identifier": "jdoe",
  "error": "Missing required attribute: sn"
}
```

#### Invalid Organization DN

**CSV**:

```csv
uid,cn,sn,organizationDn
jdoe,John Doe,Doe,ou=NonExistent,dc=example,dc=com
```

**Error**:

```json
{
  "line": 2,
  "identifier": "jdoe",
  "error": "Organization not found: ou=NonExistent,dc=example,dc=com"
}
```

#### Duplicate Entry

**Scenario**: User already exists in LDAP

**CSV**:

```csv
uid,cn,sn,mail
existinguser,Updated Name,User,new@example.com
newuser,New User,User,new2@example.com
```

**With `updateExisting=false` (default)**:

```json
{
  "success": true,
  "total": 2,
  "created": 1,
  "skipped": 1,
  "failed": 0,
  "errors": []
}
```

- `existinguser`: ⏭️ Skipped (already exists)
- `newuser`: ✅ Created

**With `updateExisting=true`**:

```json
{
  "success": true,
  "total": 2,
  "created": 1,
  "updated": 1,
  "skipped": 0,
  "failed": 0,
  "errors": []
}
```

- `existinguser`: ✏️ Updated with new values
- `newuser`: ✅ Created

**Behavior**:

- With `updateExisting=false`: Skipped (not an error)
- With `updateExisting=true`: Updated

### Error Response Format

```json
{
  "success": true,
  "total": 10,
  "created": 7,
  "failed": 3,
  "errors": [
    {
      "line": 5,
      "identifier": "user004",
      "error": "Missing required attribute: mail"
    },
    {
      "line": 8,
      "identifier": "user007",
      "error": "Organization not found: ou=Invalid,dc=example,dc=com"
    },
    {
      "line": 10,
      "identifier": "user009",
      "error": "Invalid DN format"
    }
  ]
}
```

## Best Practices

### Handling Partial Failures

When importing large batches, some entries may fail while others succeed:

**Recommended workflow**:

1. **First import with continueOnError=true**:
   ```bash
   curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
     -F "file=@users.csv" \
     -F "continueOnError=true"
   ```

2. **Check response for errors**:
   ```json
   {
     "created": 95,
     "failed": 5,
     "errors": [
       {"line": 10, "identifier": "user10", "error": "..."},
       {"line": 25, "identifier": "user25", "error": "..."}
     ]
   }
   ```

3. **Fix failed entries in CSV**:
   - Extract lines 10, 25, etc.
   - Correct the errors
   - Create a new CSV with only failed entries

4. **Re-import fixed entries**:
   ```bash
   curl -X POST "http://localhost:8081/api/v1/ldap/bulk-import/users" \
     -F "file=@failed-users-fixed.csv" \
     -F "continueOnError=true"
   ```

**Result**: All entries successfully imported without duplicates.

### Re-running an Import

If you need to re-run an import (e.g., after partial failure):

**Option 1: Skip existing entries** (default)
```bash
# Only creates new entries, skips existing ones
-F "updateExisting=false"
```
- Safe for re-runs
- Won't modify existing data
- Good for: Adding new entries only

**Option 2: Update existing entries**
```bash
# Updates existing entries with CSV data
-F "updateExisting=true"
```
- Updates all attributes from CSV
- Good for: Correcting bulk data, synchronization

**Option 3: Delete and re-create**
```bash
# First, delete all entries manually or via API
# Then re-import with fresh data
```
- Clean slate approach
- Good for: Testing, development

## Authorization

The bulk import plugin respects all configured authorization plugins:

- Uses `ldapaddrequest` hook for each entry
- Checks write permissions on target branch
- Checks organization access permissions
- Supports `authzPerBranch` plugin

**Example with authzPerBranch**:

If user only has write permission on `ou=Engineering`:

- Can import users to `ou=Engineering`
- Cannot import users to `ou=Marketing` (fails with permission error)

## Performance

### Batch Processing

The plugin processes records in batches (default: 100):

```bash
--bulk-import-batch-size 100
```

**Recommendations**:

- **Small files (<1000 records)**: Use default batch size
- **Large files (>10000 records)**: Increase to 500-1000
- **Slow LDAP server**: Decrease to 50

### File Size Limits

Default maximum file size: 10MB

```bash
--bulk-import-max-file-size 10485760  # 10MB
--bulk-import-max-file-size 52428800  # 50MB
```

**File size estimates**:

- ~100 bytes per user record
- 10MB ≈ 100,000 users
- 50MB ≈ 500,000 users

### Processing Speed

Typical performance (depends on LDAP server and network):

- **Dry run**: ~1000 records/second
- **Create**: ~100-500 records/second
- **Update**: ~50-200 records/second

## Integration with Other Plugins

### With ldapFlat

```bash
--plugin core/ldap/flatGeneric \
--flat-resources "users:./static/schemas/twake/users.json" \
--plugin core/ldap/bulkImport \
--bulk-import-schemas "users:./static/schemas/twake/users.json"
```

Both plugins share the same schema for consistency.

### With authzPerBranch

```bash
--plugin core/auth/authzPerBranch \
--authz-per-branch-config '{"users":{"admin":{"ou=users,dc=example,dc=com":{"write":true}}}}' \
--plugin core/ldap/bulkImport \
--bulk-import-schemas "users:./static/schemas/twake/users.json"
```

Bulk import respects authorization rules.

### With onChange/James

```bash
--plugin core/ldap/onChange \
--plugin twake/james \
--plugin core/ldap/bulkImport \
--bulk-import-schemas "users:./static/schemas/twake/users.json"
```

Each imported user triggers `onChange` hooks (e.g., creates mailbox in James).

## Troubleshooting

### Problem: "No file uploaded"

**Cause**: Missing file in request

**Solution**:

```bash
curl -X POST "..." -F "file=@users.csv"  # Correct
curl -X POST "..." -d "file=users.csv"   # Wrong
```

### Problem: "Only CSV files are allowed"

**Cause**: File doesn't have `.csv` extension or correct mimetype

**Solution**:

- Rename file to `*.csv`
- Check file mimetype: `file --mime-type users.csv`

### Problem: All records failed with "Missing required attribute"

**Cause**: CSV headers don't match schema attribute names

**Solution**:

- Download template with `GET /template.csv`
- Ensure CSV headers match exactly (case-sensitive)
- Check for extra spaces in headers

### Problem: "Organization not found"

**Cause**: `organizationDn` in CSV points to non-existent organization

**Solution**:

- Verify organization exists: `ldapsearch -x -b "ou=IT,..." -s base`
- Check DN syntax (commas, spaces, escaping)
- Create missing organizations first

### Problem: Slow import (timeout)

**Cause**: Too many records or slow LDAP server

**Solution**:

- Split large CSV into smaller files
- Increase timeout in HTTP client
- Reduce `--bulk-import-batch-size`
- Use `dryRun` to estimate duration first

## See Also

- [LDAP Flat Generic Plugin](ldapFlatGeneric.md) - For individual CRUD operations
- [Authorization Plugin](authzPerBranch.md) - For access control
- [JSON Schemas](schemas/SCHEMAS.md) - For schema format reference
- [LDAP Organizations](ldapOrganizations.md) - For organization management
