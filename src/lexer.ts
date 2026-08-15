// Hand-written lexer for the DynamoDB PartiQL subset.
//
// Emits a flat token stream with `range: {start, end}` byte offsets on every
// token (parser maps these straight to CodeMirror diagnostic offsets).
//
// Design notes:
// - `*` is lexed as `wildcard` (parser disambiguates: projection vs.
//   binary-arithmetic vs. function-arg).
// - `<<` and `>>` are two-char punct tokens (bag literal `<<'a','b'>>`),
//   distinct from `<` `<=` `<>` operators.
// - `NULL`, `MISSING`, `TRUE`/`FALSE` lex as their own literal token types,
//   not `keyword` — this lets the parser cleanly accept both
//   `WHERE x IS MISSING` (literal) and `MISSING(x)` (function call).
// - Lexer never throws; recoverable errors are returned as `errors` so the
//   parser can keep going and surface a richer diagnostic set.

export type TokenType =
  | 'keyword'
  | 'identifier'
  | 'quoted_identifier'
  | 'string'
  | 'number'
  | 'bool'
  | 'null'
  | 'missing'
  | 'parameter'
  | 'operator'
  | 'wildcard'
  | 'punct'
  | 'comment_line'
  | 'comment_block'
  | 'whitespace'
  | 'eof';

export interface Range {
  start: number;
  end: number;
}

export interface Token {
  type: TokenType;
  value: string;
  range: Range;
  // For `string` and `quoted_identifier`: unquoted/un-escaped content.
  text?: string;
  // For `string` and `quoted_identifier`: the closing quote was never reached,
  // so the token runs to end-of-input. Structural twin of the `Unterminated …`
  // entry in `errors` — carried on the token so a consumer can act on the fact
  // without string-matching a diagnostic message. Only ever set to `true`; a
  // balanced literal omits the key.
  unterminated?: true;
}

export interface LexerError {
  message: string;
  range: Range;
  line: number;
  column: number;
}

export interface LexResult {
  tokens: Token[];
  errors: LexerError[];
}

const KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'DISTINCT',
  'INSERT',
  'INTO',
  'VALUE',
  'UPDATE',
  'SET',
  'DELETE',
  'REMOVE',
  'AND',
  'OR',
  'NOT',
  'IS',
  'BETWEEN',
  'IN',
  'LIKE',
  'AS',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'ON',
  'USING',
  'WITH',
  'RECURSIVE',
  'GROUP',
  'HAVING',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'ALL',
  'OVER',
  'PARTITION',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'CONVERT',
  'TOP',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'TABLE',
  'INDEX',
  'RETURNING',
  'OLD',
  'NEW',
  'MODIFIED'
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value.toUpperCase());
}

export function tokenize(input: string): LexResult {
  const tokens: Token[] = [];
  const errors: LexerError[] = [];
  const len = input.length;
  let i = 0;

  // Cap emitted lex errors. `makeError` → `lineColAt` scans from offset 0, so
  // one error per char on a garbage paste (e.g. 100KB of `#`) is O(n²) and
  // freezes the renderer. A handful of errors is all the gutter can show
  // anyway; past the cap, stop paying the scan entirely.
  const MAX_LEX_ERRORS = 50;
  const pushError = (message: string, range: Range): void => {
    if (errors.length >= MAX_LEX_ERRORS) return;
    errors.push(makeError(input, message, range));
  };

  while (i < len) {
    const c = input[i];
    const n = input[i + 1];

    // Whitespace (collapsed into one token).
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < len) {
        const cj = input[j];
        if (cj === ' ' || cj === '\t' || cj === '\n' || cj === '\r') j++;
        else break;
      }
      tokens.push({
        type: 'whitespace',
        value: input.slice(i, j),
        range: {start: i, end: j}
      });
      i = j;
      continue;
    }

    // -- line comment (terminate at \n, do NOT include the newline).
    if (c === '-' && n === '-') {
      let j = i + 2;
      while (j < len && input[j] !== '\n') j++;
      tokens.push({
        type: 'comment_line',
        value: input.slice(i, j),
        range: {start: i, end: j}
      });
      i = j;
      continue;
    }

    // /* block comment */
    if (c === '/' && n === '*') {
      let j = i + 2;
      let closed = false;
      while (j < len - 1) {
        if (input[j] === '*' && input[j + 1] === '/') {
          closed = true;
          j += 2;
          break;
        }
        j++;
      }
      if (!closed) {
        j = len;
        pushError('Unterminated block comment', {start: i, end: j});
      }
      tokens.push({
        type: 'comment_block',
        value: input.slice(i, j),
        range: {start: i, end: j}
      });
      i = j;
      continue;
    }

    // Single-quoted string literal with '' escape.
    if (c === "'") {
      const start = i;
      let j = i + 1;
      let closed = false;
      let content = '';
      while (j < len) {
        if (input[j] === "'" && input[j + 1] === "'") {
          content += "'";
          j += 2;
          continue;
        }
        if (input[j] === "'") {
          closed = true;
          j++;
          break;
        }
        content += input[j];
        j++;
      }
      if (!closed) {
        pushError('Unterminated string literal', {start, end: j});
      }
      tokens.push({
        type: 'string',
        value: input.slice(start, j),
        range: {start, end: j},
        text: content,
        ...(closed ? {} : {unterminated: true as const})
      });
      i = j;
      continue;
    }

    // Double-quoted identifier with "" escape.
    if (c === '"') {
      const start = i;
      let j = i + 1;
      let closed = false;
      let content = '';
      while (j < len) {
        if (input[j] === '"' && input[j + 1] === '"') {
          content += '"';
          j += 2;
          continue;
        }
        if (input[j] === '"') {
          closed = true;
          j++;
          break;
        }
        content += input[j];
        j++;
      }
      if (!closed) {
        pushError('Unterminated quoted identifier', {start, end: j});
      }
      tokens.push({
        type: 'quoted_identifier',
        value: input.slice(start, j),
        range: {start, end: j},
        text: content,
        ...(closed ? {} : {unterminated: true as const})
      });
      i = j;
      continue;
    }

    // Number literal: integer, decimal, scientific. Accept leading dot
    // (`.5`) but only when followed by a digit so a bare `.` stays as
    // path-separator punct.
    if ((c >= '0' && c <= '9') || (c === '.' && isDigit(n))) {
      const start = i;
      let j = i;
      while (j < len && isDigit(input[j])) j++;
      if (input[j] === '.' && isDigit(input[j + 1])) {
        j++;
        while (j < len && isDigit(input[j])) j++;
      } else if (start === i && c === '.') {
        j++;
        while (j < len && isDigit(input[j])) j++;
      } else if (input[j] === '.' && !isIdentStart(input[j + 1] ?? ' ') && input[j + 1] !== '.') {
        // Trailing-dot numeric literal (`123.`): valid in SQL/PartiQL. Only a
        // bare trailing dot — if an identifier follows it's member access on
        // the number, and a second dot stays a path separator.
        j++;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k++;
        if (isDigit(input[k])) {
          j = k;
          while (j < len && isDigit(input[j])) j++;
        }
      }
      tokens.push({
        type: 'number',
        value: input.slice(start, j),
        range: {start, end: j}
      });
      i = j;
      continue;
    }

    // Multi-char punct: << >>
    if (c === '<' && n === '<') {
      tokens.push({type: 'punct', value: '<<', range: {start: i, end: i + 2}});
      i += 2;
      continue;
    }
    if (c === '>' && n === '>') {
      tokens.push({type: 'punct', value: '>>', range: {start: i, end: i + 2}});
      i += 2;
      continue;
    }

    // Multi-char operators: <= <> >= != ||
    if (c === '<' && (n === '=' || n === '>')) {
      tokens.push({
        type: 'operator',
        value: input.slice(i, i + 2),
        range: {start: i, end: i + 2}
      });
      i += 2;
      continue;
    }
    if (c === '>' && n === '=') {
      tokens.push({type: 'operator', value: '>=', range: {start: i, end: i + 2}});
      i += 2;
      continue;
    }
    if (c === '!' && n === '=') {
      tokens.push({type: 'operator', value: '!=', range: {start: i, end: i + 2}});
      i += 2;
      continue;
    }
    if (c === '|' && n === '|') {
      tokens.push({type: 'operator', value: '||', range: {start: i, end: i + 2}});
      i += 2;
      continue;
    }

    // Single-char operators.
    if (c === '=' || c === '<' || c === '>' || c === '+' || c === '-' || c === '/' || c === '%') {
      tokens.push({type: 'operator', value: c, range: {start: i, end: i + 1}});
      i++;
      continue;
    }

    // Polymorphic wildcard.
    if (c === '*') {
      tokens.push({type: 'wildcard', value: '*', range: {start: i, end: i + 1}});
      i++;
      continue;
    }

    // Parameter (?).
    if (c === '?') {
      tokens.push({type: 'parameter', value: '?', range: {start: i, end: i + 1}});
      i++;
      continue;
    }

    // Punctuation.
    if (
      c === '(' ||
      c === ')' ||
      c === ',' ||
      c === ';' ||
      c === '.' ||
      c === '[' ||
      c === ']' ||
      c === '{' ||
      c === '}' ||
      c === ':'
    ) {
      tokens.push({type: 'punct', value: c, range: {start: i, end: i + 1}});
      i++;
      continue;
    }

    // Identifier / keyword / literal-keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentPart(input[j])) j++;
      const text = input.slice(i, j);
      const upper = text.toUpperCase();
      let type: TokenType;
      if (upper === 'TRUE' || upper === 'FALSE') {
        type = 'bool';
      } else if (upper === 'NULL') {
        type = 'null';
      } else if (upper === 'MISSING') {
        type = 'missing';
      } else if (KEYWORDS.has(upper)) {
        type = 'keyword';
      } else {
        type = 'identifier';
      }
      tokens.push({
        type,
        value: text,
        range: {start: i, end: j}
      });
      i = j;
      continue;
    }

    // Unrecognised character — emit error and skip.
    pushError(`Unexpected character '${c}'`, {start: i, end: i + 1});
    i++;
  }

  tokens.push({type: 'eof', value: '', range: {start: len, end: len}});
  return {tokens, errors};
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentPart(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '$'
  );
}

function lineColAt(input: string, offset: number): {line: number; column: number} {
  let line = 1;
  let column = 1;
  const stop = Math.min(offset, input.length);
  for (let k = 0; k < stop; k++) {
    if (input[k] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return {line, column};
}

function makeError(input: string, message: string, range: Range): LexerError {
  const lc = lineColAt(input, range.start);
  return {message, range, line: lc.line, column: lc.column};
}
