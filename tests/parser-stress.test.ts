import {describe, expect, it} from 'vitest';
import {lint as lintPartiQL, parse} from '../src';

// Time bounds below are generous infinite-loop / O(n²) tripwires, NOT latency
// SLAs — kept well above any real parse time so a loaded CI runner can't flake
// them, while still catching an algorithmic blowup (which is orders of
// magnitude over, not a few hundred ms).

// Adversarial-input tests. Bound the parser's worst-case behavior so a
// malformed paste in the editor can't lock up the renderer thread or blow
// the stack.

describe('parse — stress (large and deeply-nested inputs)', () => {
  it('should parse a ~100KB SELECT in under 500ms', () => {
    // Long IN list of integers gets us close to 100KB without exploding
    // diagnostic count.
    const items: string[] = [];
    for (let i = 0; i < 16_000; i++) items.push(String(i));
    const sql = `SELECT * FROM t WHERE id IN [${items.join(', ')}]`;
    expect(sql.length).toBeGreaterThan(100_000);
    const t0 = Date.now();
    const {cst, diagnostics} = parse(sql);
    const elapsed = Date.now() - t0;
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    expect(cst.statements).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
  });

  it('should parse a 100-deep NOT chain without stack overflow', () => {
    const nots = 'NOT '.repeat(100);
    const sql = `SELECT * FROM t WHERE ${nots}x = 1`;
    expect(() => parse(sql)).not.toThrow();
    const {diagnostics} = parse(sql);
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
  });

  it('should not stack-overflow on 30k-deep unary -/+ chain', () => {
    // `parseUnary` recursed before — `- - - … 1` and `+ + + … 1` from a
    // pathological paste blew the stack without ever re-entering
    // parseExpression, so the depth guard there couldn't see it.
    const deepMinus = `SELECT * FROM t WHERE x = ${'- '.repeat(30_000)}1`;
    const deepPlus = `SELECT * FROM t WHERE x = ${'+ '.repeat(30_000)}1`;
    for (const sql of [deepMinus, deepPlus]) {
      expect(() => parse(sql)).not.toThrow();
    }
  });

  it('should parse 1000 trivial AND chains under 500ms', () => {
    const clauses: string[] = [];
    for (let i = 0; i < 1000; i++) clauses.push(`a${i} = ${i}`);
    const sql = `SELECT * FROM t WHERE ${clauses.join(' AND ')}`;
    const t0 = Date.now();
    const {diagnostics} = parse(sql);
    const elapsed = Date.now() - t0;
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    expect(elapsed).toBeLessThan(500);
  });

  it('should parse `((((…)))) × 1000` in under 1s without stack overflow', () => {
    const opens = '('.repeat(1000);
    const closes = ')'.repeat(1000);
    const sql = `SELECT * FROM t WHERE ${opens}1${closes} = 1`;
    const t0 = Date.now();
    expect(() => parse(sql)).not.toThrow();
    const {diagnostics} = parse(sql);
    const elapsed = Date.now() - t0;
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('should not be O(n²) on a 100KB garbage paste (capped lex errors)', () => {
    // Every char is unrecognized → one lex error each. `makeError`→`lineColAt`
    // scans from offset 0, so an uncapped emitter is O(n²) (~16s on 100KB,
    // freezing the renderer). The error cap keeps it linear.
    const sql = '#'.repeat(100_000);
    const t0 = Date.now();
    expect(() => parse(sql)).not.toThrow();
    const {diagnostics} = parse(sql);
    const elapsed = Date.now() - t0;
    expect(diagnostics.length).toBeGreaterThan(0);
    // Cap is enforced (handful, not 100k diagnostics).
    expect(diagnostics.length).toBeLessThan(100);
    expect(elapsed).toBeLessThan(2000);
  });

  it('should lint a 100KB garbage paste without freezing the editor', () => {
    const sql = '#'.repeat(100_000);
    const t0 = Date.now();
    expect(() => lintPartiQL(sql)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('should not stack-overflow on 30k-deep NOT / nested list / nested object', () => {
    const deepNot = `SELECT * FROM t WHERE ${'NOT '.repeat(30_000)}a`;
    const deepList = `SELECT * FROM t WHERE x IN ${'['.repeat(5000)}1${']'.repeat(5000)}`;
    const deepObj = `INSERT INTO t VALUE ${"{'k':".repeat(5000)}1${'}'.repeat(5000)}`;
    for (const sql of [deepNot, deepList, deepObj]) {
      expect(() => parse(sql)).not.toThrow();
      expect(() => lintPartiQL(sql)).not.toThrow();
    }
  });

  it('should not stack-overflow on a 5000-deep UNION chain', () => {
    // `parseSelect` previously recursed for each set-op RHS — `A UNION B UNION
    // C …` pushed one frame per UNION. Now flattened to a single SELECT plus a
    // `setOps[]` array so the chain is iterative.
    const sql = 'SELECT a FROM t' + ' UNION SELECT a FROM t'.repeat(5000);
    expect(() => parse(sql)).not.toThrow();
    expect(() => lintPartiQL(sql)).not.toThrow();
  });

  it('should not stack-overflow on a 2000-deep UNION inside a CTE body', () => {
    // CTE bodies also reach the same parseSelect — the flattening fixes both.
    const sql =
      'WITH x AS (SELECT a FROM t' + ' UNION SELECT a FROM t'.repeat(2000) + ') SELECT * FROM x';
    expect(() => parse(sql)).not.toThrow();
    expect(() => lintPartiQL(sql)).not.toThrow();
  });

  it('should return gracefully on a 50KB unterminated string (no infinite loop)', () => {
    const sql = "SELECT * FROM t WHERE x = '" + 'a'.repeat(50_000);
    const t0 = Date.now();
    expect(() => parse(sql)).not.toThrow();
    const {diagnostics} = parse(sql);
    const elapsed = Date.now() - t0;
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
