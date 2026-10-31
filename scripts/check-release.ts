#!/usr/bin/env tsx
/**
 * Refuse a non-major release whose CHANGELOG section lists a breaking change.
 *
 * See docs/development/contracts.md.
 *
 * Usage: npx tsx scripts/check-release.ts <version>
 */
import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Version {
  major: number;
  minor: number;
  patch: number;
  suffix: string;
}

export function parseVersion(version: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)((?:[-+].*)?)$/.exec(version.trim());
  if (!match)
    throw new Error(`"${version}" is not a version number such as v1.2.3`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    suffix: match[4] ?? '',
  };
}

function sameVersion(left: Version, right: Version): boolean {
  return (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch &&
    left.suffix === right.suffix
  );
}

/** The body of the CHANGELOG section for a version, without its heading */
export function changelogSection(
  markdown: string,
  version: string
): string | null {
  const target = parseVersion(version);
  const lines = markdown.split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][^\s]*)?)/.exec(lines[index]);
    if (!heading) continue;
    if (sameVersion(parseVersion(heading[1]), target)) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;
  const end = lines.findIndex(
    (line, index) => index >= start && /^##\s/.test(line)
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/**
 * The highest release the CHANGELOG lists below this one. Read by version
 * rather than by line order, so a section appended at the end still counts.
 * A prerelease of the same base version came before the target, not after.
 */
export function previousRelease(
  markdown: string,
  version: string
): string | null {
  const target = parseVersion(version);
  const earlier = [...markdown.matchAll(/^##\s+v?(\d+\.\d+\.\d+)/gm)]
    .map(match => parseVersion(match[1]))
    .filter(
      found =>
        found.major < target.major ||
        (found.major === target.major &&
          (found.minor < target.minor ||
            (found.minor === target.minor && found.patch < target.patch)))
    );
  if (earlier.length === 0) return null;
  const previous = earlier.reduce((highest, found) =>
    found.major > highest.major ||
    (found.major === highest.major &&
      (found.minor > highest.minor ||
        (found.minor === highest.minor && found.patch > highest.patch)))
      ? found
      : highest
  );
  return `${previous.major}.${previous.minor}.${previous.patch}`;
}

/**
 * Whether a release may break the published contracts. Semantic versioning
 * lets a 0.x minor break too, so 0.26.0 → 0.27.0 counts as major there.
 * Without an earlier release in the CHANGELOG there is nothing to compare:
 * only a first major version may break, so a trimmed file cannot open the
 * gate.
 */
export function isMajorRelease(
  previous: string | null,
  target: string
): boolean {
  const to = parseVersion(target);
  if (previous === null)
    return to.major > 0 && to.minor === 0 && to.patch === 0 && to.suffix === '';
  const from = parseVersion(previous);
  if (to.major !== from.major) return to.major > from.major;
  return from.major === 0 && to.minor > from.minor;
}

/** Whether a CHANGELOG section announces a breaking change */
export function listsBreakingChange(section: string): boolean {
  return /^###\s+Breaking\b/im.test(section);
}

function main(): void {
  const version = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const section = changelogSection(changelog, version);
  const previous = previousRelease(changelog, version);

  if (section === null) {
    console.warn(
      `CHANGELOG.md has no section for v${version.replace(/^v/, '')}: ` +
        'nothing to check. Add one so the release gate can read it.'
    );
    return;
  }
  if (isMajorRelease(previous, version)) {
    console.log(`v${version.replace(/^v/, '')} is a major release.`);
    return;
  }
  if (listsBreakingChange(section)) {
    console.error(
      `v${version.replace(/^v/, '')} is not a major release, but its ` +
        'CHANGELOG section lists a breaking change. Release a major version, ' +
        'or keep the published contract. See docs/development/contracts.md.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `v${version.replace(/^v/, '')} lists no breaking change, as a non-major ` +
      'release requires.'
  );
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain())
  try {
    main();
  } catch (error: unknown) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
