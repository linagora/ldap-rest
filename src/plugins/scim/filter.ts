/**
 * @module plugins/scim/filter
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 filter parser (RFC 7644 §3.4.2.2) → LDAP filter (RFC 4515).
 *
 * Grammar (simplified):
 *   filter      = logicExpr
 *   logicExpr   = notExpr (('and'|'or') notExpr)*
 *   notExpr     = 'not' ? primary
 *   primary     = '(' logicExpr ')'
 *               | attrPath complexOp '[' logicExpr ']'
 *               | attrPath compareOp value
 *               | attrPath 'pr'
 *   attrPath    = ATTR ('.' SUBATTR)?
 *   compareOp   = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le'
 *   value       = STRING | NUMBER | 'true' | 'false' | 'null'
 *
 * All string values are escaped via escapeLdapFilter() before emission.
 * Unknown SCIM attribute paths cause a ScimError(invalidFilter, 400).
 */
import { escapeLdapFilter } from '../../lib/utils';

import { scimPathToLdapAttribute } from './mapping';
import type { ResourceMapping } from './types';
import { scimInvalidFilter } from './errors';

type TokenKind =
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACK'
  | 'RBRACK'
  | 'WORD'
  | 'STRING'
  | 'NUMBER'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'pr',
  'eq',
  'ne',
  'co',
  'sw',
  'ew',
  'gt',
  'ge',
  'lt',
  'le',
  'true',
  'false',
  'null',
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'LPAREN', value: '(', pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'RPAREN', value: ')', pos: i });
      i++;
      continue;
    }
    if (c === '[') {
      tokens.push({ kind: 'LBRACK', value: '[', pos: i });
      i++;
      continue;
    }
    if (c === ']') {
      tokens.push({ kind: 'RBRACK', value: ']', pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      // String literal, with \" and \\ escapes
      const start = i;
      i++;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === '"') {
            value += '"';
            i += 2;
            continue;
          }
          if (next === '\\') {
            value += '\\';
            i += 2;
            continue;
          }
          if (next === 'n') {
            value += '\n';
            i += 2;
            continue;
          }
          if (next === 't') {
            value += '\t';
            i += 2;
            continue;
          }
        }
        value += input[i];
        i++;
      }
      if (i >= input.length) {
        throw scimInvalidFilter(
          `Unterminated string literal at position ${start}`
        );
      }
      i++; // skip closing "
      tokens.push({ kind: 'STRING', value, pos: start });
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (
        i < input.length &&
        /[0-9.+\-eE]/.test(input[i]) &&
        !/[\s()[\]]/.test(input[i])
      ) {
        i++;
      }
      tokens.push({ kind: 'NUMBER', value: input.slice(start, i), pos: start });
      continue;
    }
    // Word: identifier, keyword, or dotted path
    if (/[A-Za-z_$:]/.test(c)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_.$:]/.test(input[i])) {
        i++;
      }
      tokens.push({ kind: 'WORD', value: input.slice(start, i), pos: start });
      continue;
    }
    throw scimInvalidFilter(`Unexpected character '${c}' at position ${i}`);
  }
  tokens.push({ kind: 'EOF', value: '', pos: input.length });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private mapping: ResourceMapping
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private expect(kind: TokenKind, value?: string): Token {
    const tok = this.tokens[this.pos];
    if (tok.kind !== kind || (value && tok.value.toLowerCase() !== value)) {
      throw scimInvalidFilter(
        `Expected ${value || kind} at position ${tok.pos}, got '${tok.value}'`
      );
    }
    this.pos++;
    return tok;
  }

  parse(): string {
    const result = this.parseOr();
    if (this.peek().kind !== 'EOF') {
      throw scimInvalidFilter(
        `Unexpected token '${this.peek().value}' at position ${this.peek().pos}`
      );
    }
    return result;
  }

  private parseOr(): string {
    const parts: string[] = [this.parseAnd()];
    while (
      this.peek().kind === 'WORD' &&
      this.peek().value.toLowerCase() === 'or'
    ) {
      this.consume();
      parts.push(this.parseAnd());
    }
    if (parts.length === 1) return parts[0];
    return `(|${parts.join('')})`;
  }

  private parseAnd(): string {
    const parts: string[] = [this.parseNot()];
    while (
      this.peek().kind === 'WORD' &&
      this.peek().value.toLowerCase() === 'and'
    ) {
      this.consume();
      parts.push(this.parseNot());
    }
    if (parts.length === 1) return parts[0];
    return `(&${parts.join('')})`;
  }

  private parseNot(): string {
    if (
      this.peek().kind === 'WORD' &&
      this.peek().value.toLowerCase() === 'not'
    ) {
      this.consume();
      const expr = this.parsePrimary();
      return `(!${expr})`;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): string {
    const tok = this.peek();
    if (tok.kind === 'LPAREN') {
      this.consume();
      const inner = this.parseOr();
      this.expect('RPAREN');
      return inner;
    }
    if (tok.kind === 'WORD') {
      // attrPath
      const attrTok = this.consume();
      const path = attrTok.value;

      // Complex multi-valued: path '[' filter ']'
      if (this.peek().kind === 'LBRACK') {
        this.consume();
        // Inside: temporarily switch to sub-attribute resolution?
        // We flatten as: treat filter values as referring to the same LDAP attr
        // For simple cases like emails[type eq "work"], we currently ignore
        // sub-attribute filtering and fall back to presence of primary LDAP attr.
        const inner = this.parseOr();
        this.expect('RBRACK');
        return inner;
      }

      const op = this.consume();
      if (op.kind !== 'WORD') {
        throw scimInvalidFilter(
          `Expected comparison operator at position ${op.pos}`
        );
      }
      const opName = op.value.toLowerCase();
      if (opName === 'pr') {
        const ldapAttr = this.resolvePath(path);
        return `(${ldapAttr}=*)`;
      }
      if (!KEYWORDS.has(opName) || ['and', 'or', 'not'].includes(opName)) {
        throw scimInvalidFilter(
          `Unknown operator '${op.value}' at position ${op.pos}`
        );
      }
      const valueTok = this.consume();
      const value = this.tokenToValue(valueTok);
      return this.emitComparison(path, opName, value);
    }
    throw scimInvalidFilter(
      `Unexpected token '${tok.value}' at position ${tok.pos}`
    );
  }

  private tokenToValue(tok: Token): string | number | boolean | null {
    if (tok.kind === 'STRING') return tok.value;
    if (tok.kind === 'NUMBER') {
      const n = Number(tok.value);
      if (Number.isNaN(n)) {
        throw scimInvalidFilter(
          `Invalid number '${tok.value}' at position ${tok.pos}`
        );
      }
      return n;
    }
    if (tok.kind === 'WORD') {
      const v = tok.value.toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (v === 'null') return null;
      // Bare word value — treat as string
      return tok.value;
    }
    throw scimInvalidFilter(`Unexpected value token at position ${tok.pos}`);
  }

  private resolvePath(path: string): string {
    // 'id' is always mapped to the id attribute semantics: leave as `id` for
    // caller to resolve (handler translates `id` equality into DN search).
    if (path === 'id') return 'id';
    // 'active' → presence of pwdAccountLockedTime
    if (path === 'active') return 'active';

    const ldapAttr = scimPathToLdapAttribute(path, this.mapping);
    if (!ldapAttr) {
      throw scimInvalidFilter(`Unknown attribute path '${path}'`);
    }
    return ldapAttr;
  }

  private emitComparison(
    path: string,
    op: string,
    value: string | number | boolean | null
  ): string {
    const ldapAttr = this.resolvePath(path);

    // Pseudo-attributes
    if (ldapAttr === 'active') {
      const truthy =
        value === true ||
        (typeof value === 'string' && value.toLowerCase() === 'true');
      // active=true  <=> no pwdAccountLockedTime
      // active=false <=> pwdAccountLockedTime present
      if (op === 'eq')
        return truthy
          ? '(!(pwdAccountLockedTime=*))'
          : '(pwdAccountLockedTime=*)';
      if (op === 'ne')
        return truthy
          ? '(pwdAccountLockedTime=*)'
          : '(!(pwdAccountLockedTime=*))';
      throw scimInvalidFilter(`Operator '${op}' not supported for 'active'`);
    }

    if (value === null) {
      if (op === 'eq') return `(!(${ldapAttr}=*))`;
      if (op === 'ne') return `(${ldapAttr}=*)`;
      throw scimInvalidFilter(`Operator '${op}' not supported with null`);
    }

    const strValue = String(value);
    const esc = escapeLdapFilter(strValue);

    switch (op) {
      case 'eq':
        return `(${ldapAttr}=${esc})`;
      case 'ne':
        return `(!(${ldapAttr}=${esc}))`;
      case 'co':
        return `(${ldapAttr}=*${esc}*)`;
      case 'sw':
        return `(${ldapAttr}=${esc}*)`;
      case 'ew':
        return `(${ldapAttr}=*${esc})`;
      case 'gt':
        return `(&(${ldapAttr}>=${esc})(!(${ldapAttr}=${esc})))`;
      case 'ge':
        return `(${ldapAttr}>=${esc})`;
      case 'lt':
        return `(&(${ldapAttr}<=${esc})(!(${ldapAttr}=${esc})))`;
      case 'le':
        return `(${ldapAttr}<=${esc})`;
      default:
        throw scimInvalidFilter(`Unknown operator '${op}'`);
    }
  }
}

export interface TranslatedFilter {
  ldapFilter: string;
  /** True if the filter contains `id eq "..."`, which the caller should translate into a DN lookup. */
  touchesId: boolean;
  /** Extracted id value if the filter is a simple `id eq "..."` (single clause). */
  idEquals?: string;
}

/**
 * Translate a SCIM filter string into an LDAP filter.
 * Returns metadata enabling the caller to short-circuit id-equals queries.
 */
export function scimFilterToLdap(
  filter: string,
  mapping: ResourceMapping
): TranslatedFilter {
  const trimmed = filter.trim();
  if (!trimmed) {
    return { ldapFilter: '(objectClass=*)', touchesId: false };
  }

  // Detect a simple `id eq "value"` first (very common from clients)
  const simple = /^id\s+eq\s+"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/i.exec(trimmed);
  if (simple) {
    return {
      ldapFilter: '(objectClass=*)',
      touchesId: true,
      idEquals: simple[1].replace(/\\(.)/g, '$1'),
    };
  }

  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens, mapping);
  const ldapFilter = parser.parse();
  return { ldapFilter, touchesId: /\bid\b/.test(trimmed) };
}
