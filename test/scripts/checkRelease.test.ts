import { expect } from 'chai';

import {
  changelogSection,
  isMajorRelease,
  listsBreakingChange,
  previousRelease,
} from '../../scripts/check-release';

const changelog = `# Changelog

## Unreleased

### Added

- Something.

## v1.2.0 (2026-10-28)

### Breaking Changes

- An option went away.

### Features

- A feature.

## v1.1.0 (2026-10-25)

### Fixes

- A fix.

## v1.0.1 (2026-10-25)

### Security

- A fix.
`;

describe('Release gate', () => {
  it('reads the section of the released version', () => {
    expect(changelogSection(changelog, 'v1.2.0')).to.contain(
      'An option went away.'
    );
    expect(changelogSection(changelog, '1.2.0')).to.contain('A feature.');
    expect(changelogSection(changelog, '1.2.0')).not.to.contain('A fix.');
    expect(changelogSection(changelog, '9.9.9')).to.equal(null);
  });

  it('reads the release that came before', () => {
    expect(previousRelease(changelog, '1.2.0')).to.equal('1.1.0');
    expect(previousRelease(changelog, '1.1.0')).to.equal('1.0.1');
    expect(previousRelease(changelog, '1.0.1')).to.equal(null);
  });

  it('only lets a major release break the published contracts', () => {
    expect(isMajorRelease('1.2.0', '1.3.0')).to.equal(false);
    expect(isMajorRelease('1.2.0', '1.2.1')).to.equal(false);
    expect(isMajorRelease('1.2.0', '2.0.0')).to.equal(true);
    expect(isMajorRelease(null, '1.0.0')).to.equal(true);
    // Without an earlier release, only a first major version may break
    expect(isMajorRelease(null, '1.3.0')).to.equal(false);
    expect(isMajorRelease(null, '0.27.0')).to.equal(false);
    // Semantic versioning lets a 0.x minor break too
    expect(isMajorRelease('0.26.0', '0.27.0')).to.equal(true);
    expect(isMajorRelease('0.26.0', '0.26.1')).to.equal(false);
  });

  it('reads a prerelease section, not the final of the same version', () => {
    const withPrereleases = `## v2.0.0 (2026-11-01)

### Breaking Changes

- Final.

## v2.0.0-rc.2 (2026-10-30)

### Fixes

- Release candidate.

## v1.2.1 (2026-10-28)

### Fixes

- Previous.
`;
    expect(changelogSection(withPrereleases, 'v2.0.0')).to.contain('Final.');
    expect(changelogSection(withPrereleases, 'v2.0.0-rc.2')).to.contain(
      'Release candidate.'
    );
    expect(previousRelease(withPrereleases, '2.0.0')).to.equal('1.2.1');
    expect(previousRelease(withPrereleases, '2.0.0-rc.2')).to.equal('1.2.1');
  });

  it('reads the highest earlier release even when the file is not sorted', () => {
    const unsorted = `## v1.2.1 (2026-10-28)

### Fixes

- Current.

## v1.1.0 (2026-10-25)

### Fixes

- Older.

## v1.2.0 (2026-10-26)

### Fixes

- Newer than 1.1.0.
`;
    expect(previousRelease(unsorted, '1.2.1')).to.equal('1.2.0');
  });

  it('spots a Breaking Changes heading only', () => {
    expect(listsBreakingChange('### Breaking Changes\n\n- x')).to.equal(true);
    expect(listsBreakingChange('### Fixes\n\n- not breaking')).to.equal(false);
    expect(
      listsBreakingChange('- the answer no longer says breaking changes')
    ).to.equal(false);
  });
});
