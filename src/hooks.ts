import type { SearchOptions, SearchResult } from 'ldapts';

import { ModifyRequest, AttributeValue } from './lib/ldapActions';

export interface Hooks {
  /*
   * Libraries
   */

  /* LDAP */

  // search
  ldapsearchopts?: (opts: SearchOptions) => SearchOptions;
  ldapsearchresult?: (results: SearchResult) => SearchResult;
  // add
  ldapaddrequest?: (
    entry: Record<string, AttributeValue>
  ) => Record<string, AttributeValue>;
  // modify
  ldapmodifyrequest?: (changes: ModifyRequest) => ModifyRequest;
  // delete
  ldapdeleterequest?: (dn: string | string[]) => string | string[];

  /*
   * Plugins
   */

  /* Demo plugin */
  hello?: () => string;
}
