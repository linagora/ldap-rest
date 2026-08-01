import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

import {
  absolutizeRepoLinks,
  extractReadmeIntro,
} from '../scripts/build-pages';

describe('build-pages', () => {
  describe('absolutizeRepoLinks', () => {
    it('should point relative file links at the repository', () => {
      expect(
        absolutizeRepoLinks('See [Helm chart](./helm/ldap-rest/README.md).')
      ).to.equal(
        'See [Helm chart](https://github.com/linagora/ldap-rest/blob/master/helm/ldap-rest/README.md).'
      );
    });

    it('should use the tree view for directory links', () => {
      expect(absolutizeRepoLinks('[Demos](./examples/web/)')).to.equal(
        '[Demos](https://github.com/linagora/ldap-rest/tree/master/examples/web/)'
      );
    });

    it('should serve relative images from raw.githubusercontent.com', () => {
      expect(absolutizeRepoLinks('![Logo](./docs/linagora.png)')).to.equal(
        '![Logo](https://raw.githubusercontent.com/linagora/ldap-rest/master/docs/linagora.png)'
      );
    });

    it('should leave absolute links, anchors and titles alone', () => {
      const md =
        '[a](https://linagora.com) [b](#usage) [c](/absolute) [d](mailto:x@y.z)';
      expect(absolutizeRepoLinks(md)).to.equal(md);
      expect(absolutizeRepoLinks('[c](./LICENSE "License")')).to.equal(
        '[c](https://github.com/linagora/ldap-rest/blob/master/LICENSE "License")'
      );
    });
  });

  describe('README intro published on GitHub Pages', () => {
    // The landing page is served from the site root, so any surviving
    // relative link would 404 (e.g. /ldap-rest/helm/ldap-rest/README.md).
    it('should not contain repository-relative links', () => {
      const readme = fs.readFileSync(
        path.join(__dirname, '..', 'README.md'),
        'utf-8'
      );
      const intro = absolutizeRepoLinks(extractReadmeIntro(readme));
      const relative = [...intro.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)]
        .map(m => m[1])
        .filter(target => !/^(https?:|mailto:|#)/i.test(target));
      expect(relative).to.deep.equal([]);
    });
  });
});
