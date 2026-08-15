import {describe, expect, it} from 'vitest';
import {tokenize, isKeyword, type Token, type TokenType} from '../src';

// Filter out whitespace tokens (preserved by the lexer but noisy for most
// assertions). We assert against whitespace explicitly in dedicated tests.
function lex(input: string): Token[] {
  return tokenize(input).tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'eof');
}

function types(input: string): TokenType[] {
  return lex(input).map((t) => t.type);
}

function values(input: string): string[] {
  return lex(input).map((t) => t.value);
}

describe('tokenize — whitespace and EOF', () => {
  it('should emit a trailing eof token at the input length', () => {
    const {tokens} = tokenize('');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({type: 'eof', range: {start: 0, end: 0}});
  });

  it('should collapse runs of whitespace into a single token', () => {
    const {tokens} = tokenize('  \t\n  ');
    expect(tokens.filter((t) => t.type === 'whitespace')).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: 'whitespace',
      value: '  \t\n  ',
      range: {start: 0, end: 6}
    });
  });

  it('should keep whitespace between tokens and reports correct ranges', () => {
    const {tokens} = tokenize('a b');
    expect(tokens.map((t) => [t.type, t.range.start, t.range.end])).toEqual([
      ['identifier', 0, 1],
      ['whitespace', 1, 2],
      ['identifier', 2, 3],
      ['eof', 3, 3]
    ]);
  });
});

describe('tokenize — keywords and identifiers', () => {
  it('should recognise keywords case-insensitively and preserves original case in value', () => {
    const toks = lex('SeLect from WHERE');
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ['keyword', 'SeLect'],
      ['keyword', 'from'],
      ['keyword', 'WHERE']
    ]);
  });

  it('should lex identifiers with letters/digits/underscore/$', () => {
    expect(types('user_id orders2 $foo')).toEqual(['identifier', 'identifier', 'identifier']);
  });

  it('should NOT consume `.` as part of an identifier (dots are path separators)', () => {
    const toks = lex('a.b');
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ['identifier', 'a'],
      ['punct', '.'],
      ['identifier', 'b']
    ]);
  });

  it('should classify NULL, MISSING, TRUE, FALSE as literal-keyword token types', () => {
    expect(types('NULL MISSING TRUE FALSE true null')).toEqual([
      'null',
      'missing',
      'bool',
      'bool',
      'bool',
      'null'
    ]);
  });

  it('should be case-insensitive', () => {
    expect(isKeyword('select')).toBe(true);
    expect(isKeyword('SELECT')).toBe(true);
    expect(isKeyword('not_a_keyword')).toBe(false);
  });

  it('should treat RETURNING, OLD, NEW, MODIFIED as keywords (DML RETURNING clause)', () => {
    expect(types('RETURNING ALL OLD MODIFIED NEW')).toEqual([
      'keyword',
      'keyword',
      'keyword',
      'keyword',
      'keyword'
    ]);
  });
});

describe('tokenize — quoted identifiers', () => {
  it('should lex a basic double-quoted identifier', () => {
    const toks = lex('"my-table"');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({
      type: 'quoted_identifier',
      value: '"my-table"',
      text: 'my-table',
      range: {start: 0, end: 10}
    });
  });

  it('should unescape "" inside quoted identifiers', () => {
    const toks = lex('"my""tbl"');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({
      type: 'quoted_identifier',
      value: '"my""tbl"',
      text: 'my"tbl'
    });
  });

  it('should report an unterminated quoted identifier as a lexer error', () => {
    const {tokens, errors} = tokenize('"unterminated');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Unterminated quoted identifier/);
    expect(errors[0].line).toBe(1);
    expect(errors[0].column).toBe(1);
    expect(tokens[0].type).toBe('quoted_identifier');
  });
});

describe('tokenize — string literals', () => {
  it('should lex a basic single-quoted string', () => {
    const toks = lex("'hello'");
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({
      type: 'string',
      value: "'hello'",
      text: 'hello',
      range: {start: 0, end: 7}
    });
  });

  it("should unescape '' inside string literals", () => {
    const toks = lex("'it''s'");
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({type: 'string', text: "it's"});
  });

  it('should report an unterminated string literal', () => {
    const {tokens, errors} = tokenize("'oops");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Unterminated string literal/);
    expect(tokens[0].type).toBe('string');
  });
});

describe('tokenize — numbers', () => {
  it('should lex integers, decimals, leading-dot decimals, and scientific notation', () => {
    expect(values('0 42 3.14 .5 1e10 2.5E-3 9.0e+12')).toEqual([
      '0',
      '42',
      '3.14',
      '.5',
      '1e10',
      '2.5E-3',
      '9.0e+12'
    ]);
    expect(types('0 42 3.14 .5 1e10 2.5E-3 9.0e+12')).toEqual([
      'number',
      'number',
      'number',
      'number',
      'number',
      'number',
      'number'
    ]);
  });

  it('should not lex a bare `.` as a number', () => {
    expect(types('a.b')).toEqual(['identifier', 'punct', 'identifier']);
  });
});

describe('tokenize — operators, wildcard, parameter', () => {
  it('should lex every comparison / arithmetic / logical operator', () => {
    const cases: Array<[string, TokenType]> = [
      ['=', 'operator'],
      ['<>', 'operator'],
      ['!=', 'operator'],
      ['<', 'operator'],
      ['<=', 'operator'],
      ['>', 'operator'],
      ['>=', 'operator'],
      ['+', 'operator'],
      ['-', 'operator'],
      ['/', 'operator'],
      ['%', 'operator'],
      ['||', 'operator']
    ];
    for (const [src, type] of cases) {
      const toks = lex(src);
      expect(toks).toHaveLength(1);
      expect(toks[0]).toMatchObject({type, value: src});
    }
  });

  it('should lex * as the polymorphic wildcard token, NEVER as operator', () => {
    const toks = lex('*');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({type: 'wildcard', value: '*'});
  });

  it('should lex ? as a parameter token', () => {
    const toks = lex('?');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({type: 'parameter', value: '?'});
  });

  it('should disambiguate multi-char operators against single-char (e.g. <> vs <)', () => {
    expect(values('< <= <> = != >= > +')).toEqual(['<', '<=', '<>', '=', '!=', '>=', '>', '+']);
  });
});

describe('tokenize — punctuation', () => {
  it('should lex parens, brackets, braces, comma, semicolon, dot, colon', () => {
    expect(values('( ) [ ] { } , ; . :')).toEqual([
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      ',',
      ';',
      '.',
      ':'
    ]);
  });

  it('should lex << and >> as TWO-CHAR punct tokens for the bag literal', () => {
    const toks = lex("<<'a','b'>>");
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ['punct', '<<'],
      ['string', "'a'"],
      ['punct', ','],
      ['string', "'b'"],
      ['punct', '>>']
    ]);
  });

  it('should NOT tokenize << as two < operators', () => {
    const toks = lex('<<');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({type: 'punct', value: '<<'});
  });
});

describe('tokenize — comments', () => {
  it('should lex `--` line comments and terminates at \\n (newline NOT included)', () => {
    const toks = lex('-- hi\n42');
    expect(toks[0]).toMatchObject({
      type: 'comment_line',
      value: '-- hi',
      range: {start: 0, end: 5}
    });
    expect(toks[1]).toMatchObject({type: 'number', value: '42'});
  });

  it('should lex `--` line comment at EOF without newline', () => {
    const toks = lex('-- end');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({type: 'comment_line', value: '-- end'});
  });

  it('should lex `/* */` block comments', () => {
    const toks = lex('/* inner */ 1');
    expect(toks[0]).toMatchObject({
      type: 'comment_block',
      value: '/* inner */',
      range: {start: 0, end: 11}
    });
    expect(toks[1]).toMatchObject({type: 'number', value: '1'});
  });

  it('should emit a lexer error on unterminated block comment', () => {
    const {tokens, errors} = tokenize('/* never closed');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Unterminated block comment/);
    expect(tokens[0].type).toBe('comment_block');
    expect(tokens[0].range.end).toBe('/* never closed'.length);
  });
});

describe('tokenize — line/column tracking on errors', () => {
  it('should report line and column for an unterminated string on line 3', () => {
    const src = "SELECT 1;\n\n'oops";
    const {errors} = tokenize(src);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3);
    expect(errors[0].column).toBe(1);
  });
});

describe('tokenize — full PartiQL snippets', () => {
  it('should tokenise a SELECT with WHERE IN [bracket-list]', () => {
    const toks = lex("SELECT * FROM \"t\" WHERE id IN ['a', 'b']");
    expect(toks.map((t) => t.type)).toEqual([
      'keyword', // SELECT
      'wildcard', // *
      'keyword', // FROM
      'quoted_identifier', // "t"
      'keyword', // WHERE
      'identifier', // id
      'keyword', // IN
      'punct', // [
      'string',
      'punct', // ,
      'string',
      'punct' // ]
    ]);
  });

  it('should tokenise an UPDATE with bag literal and RETURNING', () => {
    const toks = lex("UPDATE t SET tags = <<'a','b'>> WHERE id = 1 RETURNING ALL OLD *");
    const sequence = toks.map((t) => t.value);
    expect(sequence).toContain('<<');
    expect(sequence).toContain('>>');
    expect(sequence).toContain('RETURNING');
    // The wildcard at the end is the literal `*` suffix per AWS spec.
    expect(toks[toks.length - 1]).toMatchObject({type: 'wildcard', value: '*'});
  });

  it('should tokenise double-quoted dotted table.index access', () => {
    const toks = lex('FROM "Tbl"."Idx"');
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ['keyword', 'FROM'],
      ['quoted_identifier', '"Tbl"'],
      ['punct', '.'],
      ['quoted_identifier', '"Idx"']
    ]);
  });
});
