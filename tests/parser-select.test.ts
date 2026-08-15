import {describe, expect, it} from 'vitest';
import {
  parse,
  type BetweenExpression,
  type BinaryExpression,
  type FunctionCall,
  type InExpression,
  type IsMissingExpression,
  type IsNullExpression,
  type LikeExpression,
  type ListLiteral,
  type ParenList,
  type PathExpression,
  type Program,
  type ProjectionExpression,
  type SelectStatement,
  type StringLiteral,
  type UnaryExpression
} from '../src';

function parseSelect(input: string): {
  stmt: SelectStatement;
  cst: Program;
  diagnostics: ReturnType<typeof parse>['diagnostics'];
} {
  const result = parse(input);
  expect(result.cst.statements.length).toBeGreaterThan(0);
  const first = result.cst.statements[0];
  expect(first.kind).toBe('select_statement');
  return {stmt: first as SelectStatement, cst: result.cst, diagnostics: result.diagnostics};
}

describe('parse — SELECT projection', () => {
  it('should parse `SELECT * FROM "t"`', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM "t"');
    expect(diagnostics).toEqual([]);
    expect(stmt.projection.items.length).toBe(1);
    expect(stmt.projection.items[0].kind).toBe('projection_wildcard');
    expect(stmt.from?.source.table.kind).toBe('quoted_identifier');
    if (stmt.from?.source.table.kind === 'quoted_identifier') {
      expect(stmt.from.source.table.name).toBe('t');
    }
  });

  it('should parse a comma-separated projection list', () => {
    const {stmt, diagnostics} = parseSelect('SELECT a, b, c FROM t');
    expect(diagnostics).toEqual([]);
    expect(stmt.projection.items).toHaveLength(3);
    for (const item of stmt.projection.items) {
      expect(item.kind).toBe('projection_expression');
    }
  });

  it('should parse a nested-path projection item', () => {
    const {stmt, diagnostics} = parseSelect('SELECT a.b.c[0].d FROM t');
    expect(diagnostics).toEqual([]);
    const item = stmt.projection.items[0] as ProjectionExpression;
    expect(item.expression.kind).toBe('path_expression');
    const path = item.expression as PathExpression;
    expect(path.steps).toHaveLength(4);
    expect(path.steps.map((s) => s.kind)).toEqual([
      'member_access',
      'member_access',
      'index_access',
      'member_access'
    ]);
  });

  it('should parse a quoted-identifier root path', () => {
    const {stmt, diagnostics} = parseSelect('SELECT "ColName" FROM t');
    expect(diagnostics).toEqual([]);
    const item = stmt.projection.items[0] as ProjectionExpression;
    expect(item.expression.kind).toBe('quoted_identifier');
  });
});

describe('parse — FROM clause', () => {
  it('should parse a bare table identifier', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM tbl');
    expect(diagnostics).toEqual([]);
    expect(stmt.from?.source.table.kind).toBe('identifier');
    expect(stmt.from?.source.index).toBeUndefined();
  });

  it('should parse a dotted table.index reference (both segments quoted)', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM "Tbl"."Idx"');
    expect(diagnostics).toEqual([]);
    expect(stmt.from?.source.table.kind).toBe('quoted_identifier');
    expect(stmt.from?.source.index?.kind).toBe('quoted_identifier');
  });

  it('should parse a bare dotted table.index (parser accepts; walker warns)', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM tbl.idx');
    expect(diagnostics).toEqual([]);
    expect(stmt.from?.source.table.kind).toBe('identifier');
    expect(stmt.from?.source.index?.kind).toBe('identifier');
  });
});

describe('parse — WHERE comparison operators', () => {
  it.each([
    ['=', '='],
    ['<>', '<>'],
    ['!=', '!='],
    ['<', '<'],
    ['<=', '<='],
    ['>', '>'],
    ['>=', '>=']
  ])('should parse comparison %s', (op) => {
    const {stmt, diagnostics} = parseSelect(`SELECT * FROM t WHERE a ${op} 1`);
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.kind).toBe('binary_expression');
    expect(cond.operator).toBe(op);
  });
});

describe('parse — WHERE logical operators', () => {
  it('should parse AND with left-associative chain', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.operator).toBe('AND');
    expect((cond.left as BinaryExpression).operator).toBe('AND');
  });

  it('should give AND higher precedence than OR', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.operator).toBe('OR');
    expect((cond.right as BinaryExpression).operator).toBe('AND');
  });

  it('should parse leading NOT as a unary expression', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE NOT a = 1');
    const cond = stmt.where?.condition as UnaryExpression;
    expect(cond.kind).toBe('unary_expression');
    expect(cond.operator).toBe('NOT');
    expect((cond.argument as BinaryExpression).operator).toBe('=');
  });
});

describe('parse — IN expression', () => {
  it('should parse `IN [list-literal]` (bracket form, legal)', () => {
    const {stmt, diagnostics} = parseSelect("SELECT * FROM t WHERE id IN ['a', 'b']");
    // No quick-fix should be emitted for bracket form.
    expect(diagnostics.filter((d) => d.code === 'partiql-quick-fix')).toEqual([]);
    const cond = stmt.where?.condition as InExpression;
    expect(cond.kind).toBe('in_expression');
    expect(cond.source.kind).toBe('list_literal');
    const list = cond.source as ListLiteral;
    expect(list.items).toHaveLength(2);
  });

  it('should parse `IN (paren-list)` and emit a quick-fix swapping parens for brackets', () => {
    const input = "SELECT * FROM t WHERE x IN ('a','b')";
    const {stmt, diagnostics} = parseSelect(input);
    const cond = stmt.where?.condition as InExpression;
    expect(cond.kind).toBe('in_expression');
    expect(cond.source.kind).toBe('paren_list');
    const parenList = cond.source as ParenList;
    expect(parenList.items).toHaveLength(2);
    const qf = diagnostics.find((d) => d.code === 'partiql-quick-fix');
    expect(qf).toBeDefined();
    expect(qf?.actions).toBeDefined();
    expect(qf?.actions?.[0].label).toBe('Use brackets');
    const action = qf?.actions?.[0];
    expect(action).toBeDefined();
    if (!action) return;
    const {start, end, text} = action.edit;
    const rewritten = input.slice(0, start) + text + input.slice(end);
    expect(rewritten).toBe("SELECT * FROM t WHERE x IN ['a','b']");
  });

  it('should parse NOT IN [list]', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE x NOT IN [1, 2]');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as InExpression;
    expect(cond.kind).toBe('in_expression');
    expect(cond.negated).toBe(true);
  });
});

describe('parse — BETWEEN / LIKE / IS', () => {
  it('should parse BETWEEN', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE n BETWEEN 1 AND 5');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BetweenExpression;
    expect(cond.kind).toBe('between_expression');
    expect(cond.negated).toBe(false);
  });

  it('should parse NOT BETWEEN', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE n NOT BETWEEN 1 AND 5');
    const cond = stmt.where?.condition as BetweenExpression;
    expect(cond.kind).toBe('between_expression');
    expect(cond.negated).toBe(true);
  });

  it('should parse LIKE', () => {
    const {stmt, diagnostics} = parseSelect("SELECT * FROM t WHERE s LIKE 'foo%'");
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as LikeExpression;
    expect(cond.kind).toBe('like_expression');
    const pattern = cond.pattern as StringLiteral;
    expect(pattern.value).toBe('foo%');
  });

  it('should parse IS NULL', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE x IS NULL');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as IsNullExpression;
    expect(cond.kind).toBe('is_null_expression');
    expect(cond.negated).toBe(false);
  });

  it('should parse IS NOT NULL', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE x IS NOT NULL');
    const cond = stmt.where?.condition as IsNullExpression;
    expect(cond.kind).toBe('is_null_expression');
    expect(cond.negated).toBe(true);
  });

  it('should parse IS MISSING', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE x IS MISSING');
    const cond = stmt.where?.condition as IsMissingExpression;
    expect(cond.kind).toBe('is_missing_expression');
  });

  it('should parse IS NOT MISSING', () => {
    const {stmt} = parseSelect('SELECT * FROM t WHERE x IS NOT MISSING');
    const cond = stmt.where?.condition as IsMissingExpression;
    expect(cond.kind).toBe('is_missing_expression');
    expect(cond.negated).toBe(true);
  });
});

describe('parse — function calls', () => {
  it('should parse a 1-arg function call', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE attribute_exists(x)');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as FunctionCall;
    expect(cond.kind).toBe('function_call');
    expect(cond.name.name).toBe('attribute_exists');
    expect(cond.args).toHaveLength(1);
  });

  it('should parse a 2-arg function call with a path arg and a string arg', () => {
    const {stmt, diagnostics} = parseSelect("SELECT * FROM t WHERE begins_with(name.first, 'al')");
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as FunctionCall;
    expect(cond.kind).toBe('function_call');
    expect(cond.args[0].kind).toBe('path_expression');
    expect(cond.args[1].kind).toBe('string_literal');
  });
});

describe('parse — primary literals', () => {
  it('should parse a parameter `?`', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t WHERE x = ?');
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.right.kind).toBe('parameter');
  });

  it('should parse boolean / null / missing literals as primary expressions', () => {
    const {stmt: a} = parseSelect('SELECT * FROM t WHERE active = TRUE');
    expect((a.where?.condition as BinaryExpression).right.kind).toBe('boolean_literal');
    const {stmt: b} = parseSelect('SELECT * FROM t WHERE x = NULL');
    expect((b.where?.condition as BinaryExpression).right.kind).toBe('null_literal');
    const {stmt: c} = parseSelect('SELECT * FROM t WHERE x = MISSING');
    expect((c.where?.condition as BinaryExpression).right.kind).toBe('missing_literal');
  });

  it('should parse nested path access in WHERE', () => {
    const {stmt, diagnostics} = parseSelect("SELECT * FROM t WHERE devices.tv.lastSeen[0] = 'now'");
    expect(diagnostics).toEqual([]);
    const cond = stmt.where?.condition as BinaryExpression;
    expect(cond.left.kind).toBe('path_expression');
    const path = cond.left as PathExpression;
    expect(path.steps.map((s) => s.kind)).toEqual([
      'member_access',
      'member_access',
      'index_access'
    ]);
  });
});

describe('parse — ORDER BY', () => {
  it('should parse a single key with no direction', () => {
    const {stmt, diagnostics} = parseSelect('SELECT * FROM t ORDER BY a');
    expect(diagnostics).toEqual([]);
    expect(stmt.orderBy?.items).toHaveLength(1);
    expect(stmt.orderBy?.items[0].direction).toBeUndefined();
  });

  it('should parse ASC and DESC directions', () => {
    const {stmt} = parseSelect('SELECT * FROM t ORDER BY a ASC, b DESC');
    expect(stmt.orderBy?.items.map((i) => i.direction)).toEqual(['ASC', 'DESC']);
  });
});

describe('parse — soft-reserved keywords as identifiers', () => {
  // Legacy regex linter never flagged bare DDB attribute / table names that
  // collide with SQL-ish keywords (`value`, `order`, `group`, …). Preserve
  // parity so the editor doesn't show red squiggles on common DDB schemas.

  it('should accept `value` as a bare attribute name in projection', () => {
    const {stmt, diagnostics} = parseSelect("SELECT value FROM Users WHERE id = 'x'");
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(stmt.projection.items).toHaveLength(1);
  });

  it('should accept `order` as a bare attribute name in WHERE', () => {
    const {diagnostics} = parseSelect("SELECT * FROM Users WHERE order = 'x'");
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('should accept `group` as a bare attribute name in projection', () => {
    const {diagnostics} = parseSelect("SELECT group FROM Users WHERE id = 'x'");
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('should accept reserved-ish words as a path-step member name', () => {
    const {diagnostics} = parseSelect("SELECT a.value, a.order FROM Users WHERE id = 'x'");
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('should still recognise ORDER BY after a `WHERE order = 1` predicate', () => {
    const {stmt, diagnostics} = parseSelect(
      "SELECT * FROM Users WHERE order = 'x' ORDER BY id ASC"
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(stmt.orderBy?.items).toHaveLength(1);
  });

  it('should still detect GROUP BY (parser walker flags it) after `WHERE group = 1`', () => {
    // `group` consumed as identifier in WHERE doesn't eat the GROUP BY
    // clause that follows — peekKeyword sees the second GROUP token fine.
    const {stmt, diagnostics} = parseSelect("SELECT * FROM Users WHERE group = 'x' GROUP BY id");
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(stmt.groupBy?.items).toHaveLength(1);
  });
});

describe('parse — recovery', () => {
  it('should NOT crash on a truncated WHERE clause', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should NOT crash on a truncated expression after =', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE x =');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });

  it('should NOT crash on a missing closing paren', () => {
    const {diagnostics} = parse('SELECT * FROM t WHERE (x = 1');
    expect(diagnostics.some((d) => d.code === 'partiql-parse-error')).toBe(true);
  });
});

describe('parse — empty/terminator handling', () => {
  it('should treat a bare `;` as an empty program (no parse error)', () => {
    const {cst, diagnostics} = parse(';');
    expect(diagnostics).toEqual([]);
    expect(cst.statements).toEqual([]);
  });

  it('should accept `;;;` as zero statements without piling errors', () => {
    const {cst, diagnostics} = parse(';;;');
    expect(diagnostics).toEqual([]);
    expect(cst.statements).toEqual([]);
  });

  it('should accept a leading `;` before a real statement', () => {
    const {cst, diagnostics} = parse(';SELECT * FROM t');
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    expect(cst.statements).toHaveLength(1);
    expect(cst.statements[0].kind).toBe('select_statement');
  });

  it('should accept a trailing `;` after a real statement', () => {
    const {cst, diagnostics} = parse('SELECT * FROM t;');
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    expect(cst.statements).toHaveLength(1);
  });
});

describe('parse — set-op chains flatten (no nested setOps)', () => {
  it('should flatten `A UNION B UNION C` into head.setOps=[UNION,UNION]', () => {
    const {stmt, diagnostics} = parseSelect(
      'SELECT a FROM t UNION SELECT b FROM t UNION SELECT c FROM t'
    );
    expect(diagnostics).toEqual([]);
    expect(stmt.setOps).toHaveLength(2);
    // Each setOp's right is a CORE SELECT — itself has no setOps (otherwise we
    // would have built a nested tree).
    for (const op of stmt.setOps ?? []) {
      expect(op.right.kind).toBe('select_statement');
      if (op.right.kind === 'select_statement') {
        expect(op.right.setOps).toBeUndefined();
      }
    }
  });
});

describe('parse — AS-alias with identifier-eligible keyword', () => {
  it('should accept `SELECT x AS order FROM t` (soft-reserved keyword in alias position)', () => {
    const {stmt, diagnostics} = parseSelect('SELECT x AS order FROM t');
    // Walker will flag the AS-alias as DDB-unsupported, but the parser must
    // not error — `order` is in IDENTIFIER_ELIGIBLE_KEYWORDS and the alias
    // check was the last spot that hard-rejected it.
    expect(diagnostics.filter((d) => d.code === 'partiql-parse-error')).toEqual([]);
    const item = stmt.projection.items[0] as ProjectionExpression;
    expect(item.alias?.name.name).toBe('order');
  });
});
