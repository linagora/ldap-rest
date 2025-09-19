import { SearchOptions, SearchResult } from 'ldapts';

export interface Hooks {
  /*
   * Libraries
   */

  /* LDAP */
  ldapsearchopts?: (opts: SearchOptions) => SearchOptions;
  ldapsearchresult?: (results: SearchResult) => SearchResult;

  /*
   * Plugins
   */
  hello?: () => string;
}
