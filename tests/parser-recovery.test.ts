import {describe, expect, it} from 'vitest';
import {parse} from '../src';

// All of these must NOT throw and must produce at least one parse-error
// diagnostic with a sensible range that starts inside the input. The parser's
// job here isn't to "guess what the user meant" — it's to keep the editor
// alive while the user is mid-typing.

describe('parse — recovery (truncated / malformed inputs)', () => {
  it('should recover from a bare `SELECT`', () => {
    expect(() => parse('SELECT')).not.toThrow();
    const {diagnostics} = parse('SELECT');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should accept `SELECT *` with no FROM at parse time (walker flags it)', () => {
    const {diagnostics} = parse('SELECT *');
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
  });

  it('should recover from a truncated WHERE with no expression body', () => {
    expect(() => parse('SELECT * FROM t WHERE')).not.toThrow();
    const {diagnostics} = parse('SELECT * FROM t WHERE');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should recover from a truncated expression after `=`', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE x =');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report missing closing paren in WHERE', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE (x = 1');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report an unterminated quoted identifier', () => {
    expect(() => parse('SELECT * FROM "tbl')).not.toThrow();
    const {diagnostics} = parse('SELECT * FROM "tbl');
    const err = diagnostics.find((d) => d.code === 'partiql-parse-error');
    expect(err).toBeDefined();
    expect(err?.range.start).toBeGreaterThanOrEqual(0);
  });

  it('should report an unterminated single-quoted string', () => {
    expect(() => parse("SELECT * FROM t WHERE x = 'abc")).not.toThrow();
    const {diagnostics} = parse("SELECT * FROM t WHERE x = 'abc");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report an unterminated block comment', () => {
    expect(() => parse('SELECT * FROM t /* nope')).not.toThrow();
    const {diagnostics} = parse('SELECT * FROM t /* nope');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should recover from a truncated IN list (missing `]`)', () => {
    const {diagnostics} = parse("SELECT * FROM t WHERE x IN ['a', 'b'");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report IN with neither `[` nor `(`', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE x IN');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report IS without NULL or MISSING', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE x IS');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report INSERT missing INTO keyword', () => {
    const {diagnostics} = parse("INSERT t VALUE {'k': 1}");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report INSERT missing VALUE keyword', () => {
    const {diagnostics} = parse("INSERT INTO t {'k': 1}");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report UPDATE missing assignment value', () => {
    const {diagnostics} = parse("UPDATE t SET a = WHERE pk = 'x'");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report UPDATE missing `=` in SET', () => {
    const {diagnostics} = parse("UPDATE t SET a 1 WHERE pk = 'x'");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report DELETE missing FROM', () => {
    const {diagnostics} = parse("DELETE t WHERE pk = 'x'");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report RETURNING without mode', () => {
    const {diagnostics} = parse("DELETE FROM t WHERE pk = 'x' RETURNING");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should report RETURNING with valid mode but no `*`', () => {
    const {diagnostics} = parse("DELETE FROM t WHERE pk = 'x' RETURNING ALL OLD");
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should sync past garbage tokens at statement start and surface the next statement', () => {
    const {cst, diagnostics} = parse('??? SELECT * FROM t');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
    expect(cst.statements.some((s) => s.kind === 'select_statement')).toBe(true);
  });

  it('should parse both statements when garbage sits between two SELECTs', () => {
    const {cst, diagnostics} = parse('SELECT * FROM t; ??? SELECT * FROM u');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
    expect(cst.statements.filter((s) => s.kind === 'select_statement')).toHaveLength(2);
  });

  it('should emit a diagnostic range inside the source span on partial input', () => {
    const input = 'SELECT * FROM t WHERE';
    const {diagnostics} = parse(input);
    const err = diagnostics.find((d) => d.code === 'partiql-parse-error');
    expect(err).toBeDefined();
    expect(err?.range.start).toBeGreaterThanOrEqual(0);
    expect(err?.range.start).toBeLessThanOrEqual(input.length);
    expect(err?.range.end).toBeLessThanOrEqual(input.length);
  });
});
