#!/bin/sh
# Refuse new rationale comments in the umbrella and the package sources.
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

node - "$root/src" "$root"/packages/*/src <<'NODE' > "$current"
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const roots = process.argv.slice(2);
const base = path.resolve(roots[0], '..');

// "used to" is also the instrumental sense ("the attribute used to resolve
// the DN"). It narrates history when it follows a subject, not a comma, a
// bracket, a modal or an instrument. The rule errs towards silence: a
// history phrase after an instrument noun, `never` or `not` goes unchecked.
const INSTRUMENTS = new Set(
  (
    'attribute attributes field fields option options param params parameter ' +
    'parameters value values column columns header headers key keys path ' +
    'paths name names helper function method regex pattern filter query ' +
    'flag structure set list table type types email address'
  ).split(' ')
);

function history(body) {
  const match = /\bused to\b/i.exec(body);
  if (!match) return false;
  const before = body.slice(0, match.index).trimEnd();
  if (/[,.(:]$/.test(before)) return false;
  if (
    /\b(?:be|is|are|was|were|been|being|can|could|may|might|will|would|never|not|also|often|already|still)$/i.test(
      before
    )
  )
    return false;
  const word = /([A-Za-z]+)$/.exec(before)?.[1].toLowerCase();
  return !word || !INSTRUMENTS.has(word);
}

const rules = [
  body => /#\d+\b/.test(body),
  body => /\bsince (v|version )?\d/i.test(body),
  history,
];

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      yield file;
  }
}

for (const root of roots)
  for (const file of sources(root)) {
  const text = fs.readFileSync(file, 'utf8');
  // The parser, not a bare scanner: a scanner without the parser's rescan
  // calls gets out of step at a template substitution or a regex and stops
  // seeing comments.
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const seen = new Set();

  const add = ranges => {
    for (const range of ranges ?? []) {
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = text
        .slice(range.pos, range.end)
        .replace(/^\/\/+/, '')
        .replace(/^\/\*+|\*+\/$/g, '')
        .replace(/^\s*\*+\s?/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!body || !rules.some(rule => rule(body))) continue;
      // `@openapi` blocks are the published API description, not a comment on
      // the code; their prose is reviewed as part of the REST contract.
      if (/@openapi(-component)?\b/.test(body)) continue;
      const where = `${path.relative(base, file)}:${
        text.slice(0, range.pos).split('\n').length
      }`;
      console.log(`${where}\t${body}`);
    }
  };

  // `getChildren` rather than `forEachChild`: the parser's children include
  // the tokens, so a comment before a closing bracket or after a comma is
  // some token's trivia. Node-only walking misses those, and with them a
  // comment that sits nowhere else.
  const visit = node => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  add(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
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
  echo "check-comments: new rationale comments in src/ or a package source:" >&2
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
check-comments: the baseline lists comments the sources no longer have. Let it shrink:
sh scripts/check-comments.sh --update
EOF
  exit 1
fi

echo "check-comments: no new rationale comments in the sources"
