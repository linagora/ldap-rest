import { expect } from 'chai';

import { localizedText as serverText } from '../../src/config/schema';
import {
  hasRole,
  localizedText as browserText,
} from '../../src/browser/shared/utils/schema';

describe('Browser schema utils', () => {
  describe('hasRole', () => {
    it('reads a role given alone or among several', () => {
      expect(hasRole({ role: 'displayName' }, 'displayName')).to.be.true;
      expect(hasRole({ role: ['domainName', 'displayName'] }, 'displayName')).to
        .be.true;
      expect(hasRole({ role: ['domainName'] }, 'displayName')).to.be.false;
      expect(hasRole({}, 'displayName')).to.be.false;
      expect(hasRole(undefined, 'displayName')).to.be.false;
    });
  });

  // The browser build cannot import the server's module: the two copies
  // must pick the same text
  describe('localizedText', () => {
    const map = { en: 'Mail', fr: 'Courriel', 'pt-BR': 'Correio' };
    const cases: [Parameters<typeof serverText>[0], string | undefined][] = [
      [map, undefined],
      [map, 'fr'],
      [map, 'fr-CA'],
      [map, 'pt-BR'],
      [map, 'de'],
      [{ fr: 'Courriel' }, 'de'],
      [{ en: '', fr: 'Courriel' }, 'en'],
      ['Mail', 'fr'],
      ['', 'en'],
      [{}, 'en'],
      [undefined, 'en'],
    ];
    for (const [text, language] of cases)
      it(`picks the same text for ${JSON.stringify(text)} in ${language}`, () => {
        expect(browserText(text, language)).to.equal(
          serverText(text, language)
        );
      });
  });
});
