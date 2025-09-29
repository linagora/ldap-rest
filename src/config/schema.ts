import type { AttributeValue } from '../lib/ldapActions';

export interface Schema {
  strict: boolean;
  attributes: {
    [key: string]: {
      type: string;
      items?: {
        type: string;
        test?: string | RegExp;
      };
      default?: AttributeValue;
      required?: boolean;
      test?: string | RegExp;
    };
  };
}
