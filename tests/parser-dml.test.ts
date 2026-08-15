import {describe, expect, it} from 'vitest';
import {
  parse,
  type BinaryExpression,
  type DeleteStatement,
  type InsertStatement,
  type ObjectLiteral,
  type PathExpression,
  type Program,
  type RemoveAssignment,
  type SetAssignment,
  type Statement,
  type UpdateStatement
} from '../src';

function first<T extends Statement>(
  input: string,
  kind: T['kind']
): {
  stmt: T;
  cst: Program;
  diagnostics: ReturnType<typeof parse>['diagnostics'];
} {
  const result = parse(input);
  expect(result.cst.statements.length).toBeGreaterThan(0);
  const stmt = result.cst.statements[0];
  expect(stmt.kind).toBe(kind);
  return {stmt: stmt as T, cst: result.cst, diagnostics: result.diagnostics};
}

describe('parse — INSERT', () => {
  it('should parse `INSERT INTO "t" VALUE { ... }`', () => {
    const {stmt, diagnostics} = first<InsertStatement>(
      "INSERT INTO \"Music\" VALUE {'Artist': 'Acme', 'SongTitle': 'PartiQL'}",
      'insert_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.table.table.kind).toBe('quoted_identifier');
    expect(stmt.value.kind).toBe('object_literal');
    const obj = stmt.value as ObjectLiteral;
    expect(obj.entries).toHaveLength(2);
    expect(obj.entries[0].key.value).toBe('Artist');
  });

  it('should parse INSERT with a nested-object value', () => {
    const {stmt, diagnostics} = first<InsertStatement>(
      "INSERT INTO t VALUE {'k': {'inner': [1, 2, 3]}}",
      'insert_statement'
    );
    expect(diagnostics).toEqual([]);
    const obj = stmt.value as ObjectLiteral;
    expect(obj.entries[0].value.kind).toBe('object_literal');
  });

  it('should parse INSERT with a `?` parameter as the value', () => {
    const {stmt, diagnostics} = first<InsertStatement>('INSERT INTO t VALUE ?', 'insert_statement');
    expect(diagnostics).toEqual([]);
    expect(stmt.value.kind).toBe('parameter');
  });

  it('should recover from a truncated INSERT (missing VALUE)', () => {
    const result = parse('INSERT INTO t');
    expect(result.diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
    // Parser still produces a statement node so consumers don't crash.
    expect(result.cst.statements.length).toBeGreaterThan(0);
  });
});

describe('parse — UPDATE', () => {
  it('should parse a single SET assignment', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE Music SET AwardsWon = 1 WHERE Artist = 'Acme'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.assignments).toHaveLength(1);
    const a0 = stmt.assignments[0] as SetAssignment;
    expect(a0.kind).toBe('set_assignment');
    expect((a0.target as {name: string}).name).toBe('AwardsWon');
    expect(stmt.where).toBeDefined();
  });

  it('should parse multiple comma-separated SET assignments', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET a = 1, b = 2, c = 3 WHERE pk = 'x'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.assignments).toHaveLength(3);
    expect(stmt.assignments.every((a) => a.kind === 'set_assignment')).toBe(true);
  });

  it('should parse multiple SET clauses without commas (AWS-style)', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET a = 1 SET b = 2 WHERE pk = 'x'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.assignments).toHaveLength(2);
  });

  it('should parse SET with a nested-path target', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET Devices.tv.last[0] = 'lg' WHERE pk = 'x'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    const a0 = stmt.assignments[0] as SetAssignment;
    expect(a0.target.kind).toBe('path_expression');
    const path = a0.target as PathExpression;
    expect(path.steps.map((s) => s.kind)).toEqual([
      'member_access',
      'member_access',
      'index_access'
    ]);
  });

  it('should parse REMOVE', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t REMOVE Genre.Country WHERE pk = 'x'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.assignments).toHaveLength(1);
    const a0 = stmt.assignments[0] as RemoveAssignment;
    expect(a0.kind).toBe('remove_assignment');
    expect(a0.target.kind).toBe('path_expression');
  });

  it('should parse interleaved SET and REMOVE clauses', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET a = 1 REMOVE b, c SET d = 2 WHERE pk = 'x'",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.assignments.map((a) => a.kind)).toEqual([
      'set_assignment',
      'remove_assignment',
      'remove_assignment',
      'set_assignment'
    ]);
  });

  it('should parse RETURNING ALL OLD *', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET a = 1 WHERE pk = 'x' RETURNING ALL OLD *",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.returning?.mode).toBe('ALL OLD');
  });

  it.each(['ALL OLD', 'MODIFIED OLD', 'ALL NEW', 'MODIFIED NEW'] as const)(
    'should parse RETURNING %s *',
    (mode) => {
      const {stmt, diagnostics} = first<UpdateStatement>(
        `UPDATE t SET a = 1 WHERE pk = 'x' RETURNING ${mode} *`,
        'update_statement'
      );
      expect(diagnostics).toEqual([]);
      expect(stmt.returning?.mode).toBe(mode);
    }
  );

  it('should parse composite-key WHERE (PK + SK)', () => {
    const {stmt, diagnostics} = first<UpdateStatement>(
      "UPDATE t SET a = 1 WHERE pk = 'p' AND sk = 1",
      'update_statement'
    );
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.operator).toBe('AND');
  });

  it('should emit a parse error when SET/REMOVE missing', () => {
    const result = parse("UPDATE t WHERE pk = 'x'");
    expect(result.diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });
});

describe('parse — DELETE', () => {
  it('should parse DELETE with single-PK WHERE', () => {
    const {stmt, diagnostics} = first<DeleteStatement>(
      "DELETE FROM t WHERE pk = 'x'",
      'delete_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.table.table.kind).toBe('identifier');
    expect(stmt.where).toBeDefined();
  });

  it('should parse DELETE with composite-PK WHERE', () => {
    const {stmt, diagnostics} = first<DeleteStatement>(
      'DELETE FROM "t" WHERE pk = \'p\' AND sk = 1',
      'delete_statement'
    );
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.operator).toBe('AND');
  });

  it('should parse DELETE with RETURNING', () => {
    const {stmt, diagnostics} = first<DeleteStatement>(
      "DELETE FROM t WHERE pk = 'x' RETURNING MODIFIED OLD *",
      'delete_statement'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.returning?.mode).toBe('MODIFIED OLD');
  });
});
