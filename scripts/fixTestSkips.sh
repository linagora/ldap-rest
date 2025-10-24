#!/bin/bash
# Script to remove manual LDAP env var checks from tests
# These are no longer needed since the embedded LDAP server sets them automatically

FILES=(
  "test/plugins/twake/calendarResources.test.ts"
  "test/plugins/twake/appAccountsConsistency.test.ts"
  "test/plugins/ldap/flatGenericTwakeUsers.test.ts"
  "test/plugins/ldap/flatGenericStandardUsers.test.ts"
  "test/plugins/ldap/getApis.test.ts"
  "test/plugins/ldap/trashIntegration.test.ts"
  "test/plugins/ldap/trash.test.ts"
  "test/plugins/ldap/fixedAttributes.test.ts"
)

for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "Processing $file..."

    # Remove the manual skip check blocks (if/console.warn/return pattern)
    # This is a complex sed operation, so we'll use perl for better multiline handling
    perl -i -0pe 's/  \/\/ Skip all tests if[^}]+\}\n//gs' "$file"
    perl -i -0pe 's/  if \(\s*![^}]+console\.warn\([^)]+Skipping[^}]+this\.skip[^}]+return;\s*\}\s*\n//gs' "$file"

    echo "  ✓ Processed $file"
  else
    echo "  ⚠ File not found: $file"
  fi
done

echo ""
echo "Done! Manual skip checks removed from ${#FILES[@]} files."
echo "Tests will now use the embedded LDAP server automatically."
