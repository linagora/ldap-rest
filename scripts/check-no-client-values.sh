#!/bin/sh
# Refuse client-specific values in the published code.
#
# The core knows roles and schemas. A suffix, a mail domain, a national phone
# format, a nomenclature value or a quota default belongs to a schema or to a
# command-line option — never to `src/`. A default that happens to be one
# customer's number is a leak just as much as a constant named after them.
#
# The list of forbidden values is the one thing this repository cannot carry:
# writing a deployment's name here in order to forbid it would publish it just
# as surely. So scripts/client-values.txt is untracked. Copy
# scripts/client-values.example.txt to it, or point CLIENT_VALUES_FILE at a list
# kept outside the repository. Without either, the check says it has nothing to
# do rather than failing a clone that never had the list.
#
# Usage: npm run check:no-client-values

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
patterns="${CLIENT_VALUES_FILE:-$root/scripts/client-values.txt}"

if [ ! -f "$patterns" ]; then
  echo "check-no-client-values: no list at $patterns, nothing to check." >&2
  echo "Copy scripts/client-values.example.txt to scripts/client-values.txt" >&2
  echo "(git-ignored), or set CLIENT_VALUES_FILE to your own list." >&2
  exit 0
fi

# Comments and blank lines are for the reader, not for grep.
expression=$(grep -v '^[[:space:]]*#' "$patterns" | grep -v '^[[:space:]]*$' | paste -sd '|' -)

if [ -z "$expression" ]; then
  echo "check-no-client-values: no pattern configured, nothing to check"
  exit 0
fi

if grep -rniaE "$expression" "$root/src"; then
  cat >&2 <<'EOF'

check-no-client-values: the lines above put a deployment-specific value in the
published code. Move it to a schema under static/schemas/ or to a command-line
option, and read it from the configuration instead.
EOF
  exit 1
fi

echo "check-no-client-values: src/ is free of deployment-specific values"
