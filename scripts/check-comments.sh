#!/bin/sh
# Refuse new rationale comments in src/.
#
# A comment explains what is not obvious in the code beside it. Why a design
# is what it is belongs in docs/architecture/adr/, once; the comment points
# there. This check reads every comment under src/ and fails when one is new
# compared with scripts/comment-baseline.txt: an issue number, "used to",
# "since <version>" and the like.
#
# The baseline may only shrink: a change that removes such a comment updates
# it with `sh scripts/check-comments.sh --update`.
#
# Usage: npm run check:comments

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
baseline="$root/scripts/comment-baseline.txt"
current=$(mktemp)
texts=$(mktemp)
new=$(mktemp)
stale=$(mktemp)
trap 'rm -f "$current" "$texts" "$new" "$stale"' EXIT

node - "$root/src" <<'NODE' > "$current"
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = process.argv[2];
const base = path.resolve(root, '..');
// A digit run followed by a hex letter has no word boundary, so the browser
// sources' `#6200ee` colours are not mistaken for issue references.
const rules = [/#\d+\b/, /\bused to\b/i, /\bsince (v|version )?\d/i];

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      yield file;
  }
}

for (const file of sources(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text
  );
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (
      kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
      kind !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const start = scanner.getTokenPos();
    const body = text
      .slice(start, scanner.getTextPos())
      .replace(/^\/\/+/, '')
      .replace(/^\/\*+|\*+\/$/g, '')
      .replace(/^\s*\*+\s?/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body || !rules.some(rule => rule.test(body))) continue;
    // `@openapi` blocks are the published API description, not a comment on
    // the code; their prose is reviewed as part of the REST contract.
    if (/@openapi(-component)?\b/.test(body)) continue;
    const where = `${path.relative(base, file)}:${
      text.slice(0, start).split('\n').length
    }`;
    console.log(`${where}\t${body}`);
  }
}
NODE

cut -f2- "$current" | LC_ALL=C sort > "$texts"

if [ "${1:-}" = "--update" ]; then
  cp "$texts" "$baseline"
  echo "check-comments: baseline updated ($(wc -l <"$baseline") entries)"
  exit 0
fi

if [ ! -f "$baseline" ]; then
  echo "check-comments: no baseline at $baseline" >&2
  echo "run: sh scripts/check-comments.sh --update" >&2
  exit 1
fi

LC_ALL=C comm -13 "$baseline" "$texts" > "$new"
LC_ALL=C comm -23 "$baseline" "$texts" > "$stale"

if [ -s "$new" ]; then
  echo "check-comments: new rationale comments in src/:" >&2
  awk -F '\t' 'NR == FNR { new[$0] = 1; next } $2 in new {
    printf "  %s\n      %s\n", $1, $2
  }' "$new" "$current" >&2
  cat >&2 <<'EOF'

Move the rationale to docs/architecture/adr/ and leave a line pointing at it,
or drop the history: the check refuses issue numbers, "used to" and "since
<version>".
EOF
  exit 1
fi

if [ -s "$stale" ]; then
  cat >&2 <<'EOF'
check-comments: the baseline lists comments src/ no longer has. Let it shrink:
sh scripts/check-comments.sh --update
EOF
  exit 1
fi

echo "check-comments: no new rationale comments in src/"
