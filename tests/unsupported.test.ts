import {describe, expect, it} from 'vitest';
import {findUnsupportedConstructs, parse, type Diagnostic} from '../src';

function lint(input: string): Diagnostic[] {
  const {cst, diagnostics: parseDiagnostics} = parse(input);
  const walkerDiagnostics = findUnsupportedConstructs(cst, input);
  return [...parseDiagnostics, ...walkerDiagnostics];
}

function unsupported(input: string): Diagnostic[] {
  return lint(input).filter((d) => d.code === 'partiql-unsupported');
}

function applyEdit(input: string, d: Diagnostic): string {
  const action = d.actions?.[0];
  if (!action) throw new Error(`No quick-fix action on diagnostic: ${d.message}`);
  const {start, end, text} = action.edit;
  return input.slice(0, start) + text + input.slice(end);
}

describe('findUnsupportedConstructs — JOIN / set ops / CTE / DDL', () => {
  it.each([
    ['SELECT * FROM t JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t INNER JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t LEFT JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t LEFT OUTER JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t RIGHT JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t FULL OUTER JOIN u ON t.x = u.x', 'JOIN is not supported'],
    ['SELECT * FROM t CROSS JOIN u', 'JOIN is not supported']
  ])('should flag %s', (input, msg) => {
    const ds = unsupported(input);
    expect(ds.some((d) => d.message.includes(msg))).toBe(true);
  });

  it('should flag UNION / INTERSECT / EXCEPT', () => {
    for (const op of ['UNION', 'INTERSECT', 'EXCEPT']) {
      const ds = unsupported(`SELECT * FROM t ${op} SELECT * FROM u`);
      expect(ds.length).toBeGreaterThan(0);
      expect(ds[0].message).toContain('UNION/INTERSECT/EXCEPT are not supported');
    }
  });

  it('should flag UNION ALL', () => {
    const ds = unsupported('SELECT * FROM t UNION ALL SELECT * FROM u');
    expect(ds.length).toBeGreaterThan(0);
  });

  it('should flag WITH/CTE', () => {
    const ds = unsupported('WITH c AS (SELECT * FROM t) SELECT * FROM c');
    expect(ds.some((d) => d.message.includes('WITH/CTE'))).toBe(true);
  });

  it('should flag WITH RECURSIVE', () => {
    const ds = unsupported('WITH RECURSIVE c AS (SELECT * FROM t) SELECT * FROM c');
    expect(ds.some((d) => d.message.includes('WITH/CTE'))).toBe(true);
  });

  it.each(['CREATE', 'DROP', 'ALTER', 'TRUNCATE'])('should flag DDL %s', (cmd) => {
    const ds = unsupported(`${cmd} TABLE foo`);
    expect(ds.some((d) => d.message.includes('DDL statements'))).toBe(true);
  });

  it('should flag subquery in WHERE', () => {
    const ds = unsupported('SELECT * FROM t WHERE x IN (SELECT y FROM u)');
    expect(ds.some((d) => d.message.includes('Subqueries in expressions'))).toBe(true);
  });

  it('should NOT emit "Use brackets" quick-fix for `IN (SELECT …)`', () => {
    // Replacing `(SELECT …)` with `[SELECT …]` is invalid PartiQL. Only the
    // subquery diagnostic should fire — the bracket quick-fix would corrupt
    // the user's query into garbage.
    const ds = unsupported('SELECT * FROM t WHERE x IN (SELECT y FROM u)');
    const bracketFixes = ds.filter((d) => d.actions?.some((a) => a.label === 'Use brackets'));
    expect(bracketFixes).toHaveLength(0);
  });

  it('should flag multi-statement scripts', () => {
    const ds = unsupported('SELECT * FROM t; SELECT * FROM u');
    expect(ds.some((d) => d.message.includes('Multi-statement scripts'))).toBe(true);
  });
});

describe('findUnsupportedConstructs — projection-level / limit / paging', () => {
  it('should flag DISTINCT', () => {
    const ds = unsupported('SELECT DISTINCT a FROM t');
    expect(ds.some((d) => d.message.includes('DISTINCT'))).toBe(true);
  });

  it('should flag TOP N', () => {
    const ds = unsupported('SELECT TOP 10 * FROM t');
    expect(ds.some((d) => d.message.includes('TOP N'))).toBe(true);
  });

  it('should flag GROUP BY', () => {
    const ds = unsupported('SELECT a FROM t GROUP BY a');
    expect(ds.some((d) => d.message.includes('GROUP BY'))).toBe(true);
  });

  it('should flag HAVING', () => {
    const ds = unsupported('SELECT a FROM t GROUP BY a HAVING a > 1');
    expect(ds.some((d) => d.message.includes('HAVING'))).toBe(true);
  });

  it('should flag LIMIT', () => {
    const ds = unsupported('SELECT * FROM t LIMIT 10');
    expect(ds.some((d) => d.message.includes('LIMIT'))).toBe(true);
  });

  it('should flag OFFSET', () => {
    const ds = unsupported('SELECT * FROM t ORDER BY a OFFSET 5');
    expect(ds.some((d) => d.message.includes('OFFSET'))).toBe(true);
  });

  it('should flag AS column-alias', () => {
    const ds = unsupported('SELECT a AS x FROM t');
    expect(ds.some((d) => d.message.includes('Column aliases'))).toBe(true);
  });
});

describe('findUnsupportedConstructs — expressions: CASE / CAST / OVER', () => {
  it('should flag CASE WHEN', () => {
    const ds = unsupported("SELECT CASE WHEN x = 1 THEN 'a' ELSE 'b' END FROM t");
    expect(ds.some((d) => d.message.includes('CASE expressions'))).toBe(true);
  });

  it('should flag CAST', () => {
    const ds = unsupported('SELECT CAST(x AS INTEGER) FROM t');
    expect(ds.some((d) => d.message.includes('CAST is not supported'))).toBe(true);
  });

  it('should flag CONVERT', () => {
    const ds = unsupported('SELECT CONVERT(x, INTEGER) FROM t');
    expect(ds.some((d) => d.message.includes('CONVERT is not supported'))).toBe(true);
  });

  it('should flag window OVER', () => {
    const ds = unsupported('SELECT row_number() OVER (PARTITION BY x) FROM t');
    expect(ds.some((d) => d.message.includes('Window functions'))).toBe(true);
  });
});

describe('findUnsupportedConstructs — arithmetic operators', () => {
  it.each([
    ['SELECT * FROM t WHERE a * 2 = 4', "'*'"],
    ['SELECT * FROM t WHERE a / 2 = 4', "'/'"],
    ['SELECT * FROM t WHERE a % 2 = 0', "'%'"],
    ["SELECT * FROM t WHERE a || 'x' = 'ax'", "'||'"]
  ])('should flag arithmetic %s', (input, op) => {
    const ds = unsupported(input);
    expect(ds.some((d) => d.message.includes(op))).toBe(true);
  });

  it('should accept + and -', () => {
    const ds = unsupported('SELECT * FROM t WHERE a + 1 - 2 = 3');
    expect(ds.filter((d) => d.message.includes('Arithmetic'))).toEqual([]);
  });
});

describe('findUnsupportedConstructs — SQL string functions + aggregates', () => {
  it.each([
    'SELECT UPPER(x) FROM t',
    'SELECT LOWER(x) FROM t',
    'SELECT SUBSTRING(x, 1, 2) FROM t',
    'SELECT TRIM(x) FROM t',
    'SELECT CONCAT(x, y) FROM t',
    'SELECT LENGTH(x) FROM t',
    'SELECT COALESCE(x, y) FROM t',
    'SELECT IFNULL(x, 0) FROM t',
    'SELECT NULLIF(x, 0) FROM t'
  ])('should flag %s', (input) => {
    const ds = unsupported(input);
    expect(ds.some((d) => d.message.includes('is not supported by DynamoDB PartiQL'))).toBe(true);
  });

  it('should flag aggregate in SELECT-list with Workbench pointer', () => {
    const ds = unsupported('SELECT COUNT(*) FROM t');
    expect(
      ds.some((d) =>
        d.message.includes('Use a Workbench (SQL) tab for COUNT/SUM/AVG/GROUP BY queries.')
      )
    ).toBe(true);
  });

  it('should flag aggregate in WHERE clause with the dedicated message', () => {
    const ds = unsupported('SELECT * FROM t WHERE COUNT(x) > 1');
    expect(ds.some((d) => d.message.includes('cannot be used in WHERE clause'))).toBe(true);
  });

  it('should accept DDB-valid functions (size, attribute_exists, …)', () => {
    const ds = unsupported(
      "SELECT * FROM t WHERE attribute_exists(x) AND size(y) > 0 AND begins_with(z, 'a')"
    );
    expect(ds).toEqual([]);
  });

  it('should accept AWS-canonical functions (SIZE, EXISTS, ATTRIBUTE_TYPE, …)', () => {
    const ds = unsupported(
      "SELECT * FROM t WHERE EXISTS(x) AND SIZE(y) > 0 AND BEGINS_WITH(z, 'a')"
    );
    expect(ds).toEqual([]);
  });

  it('should flag bare lowercase exists() and missing() with quick-fix to canonical names', () => {
    const ds1 = unsupported('SELECT * FROM t WHERE exists(x)');
    const fix1 = ds1.find((d) => d.actions?.[0]?.label === 'Use attribute_exists');
    expect(fix1).toBeDefined();
    expect(fix1?.actions?.[0].edit.text).toBe('attribute_exists');

    const ds2 = unsupported('SELECT * FROM t WHERE missing(x)');
    const fix2 = ds2.find((d) => d.actions?.[0]?.label === 'Use attribute_not_exists');
    expect(fix2).toBeDefined();
    expect(fix2?.actions?.[0].edit.text).toBe('attribute_not_exists');
  });
});

describe('findUnsupportedConstructs — IN(paren-list) quick-fix payload', () => {
  it('should produce a bracket-replacement edit that rewrites parens to brackets', () => {
    const input = "SELECT * FROM t WHERE x IN ('a','b','c')";
    const ds = unsupported(input);
    // The parser-side quick-fix has its own info diagnostic; the walker also
    // emits an `error` severity diagnostic with the quick-fix payload. The
    // applied edit should swap parens for brackets.
    const fixDiag = ds.find(
      (d) => d.severity === 'error' && d.actions?.[0]?.label === 'Use brackets'
    );
    expect(fixDiag).toBeDefined();
    const rewritten = applyEdit(input, fixDiag!);
    expect(rewritten).toBe("SELECT * FROM t WHERE x IN ['a','b','c']");
  });
});

describe('findUnsupportedConstructs — LIKE quick-fix payloads', () => {
  it("should flag LIKE '%foo%' (substring) → contains() quick-fix", () => {
    const input = "SELECT * FROM t WHERE name LIKE '%foo%'";
    const ds = unsupported(input);
    const fix = ds.find((d) => d.actions?.[0]?.label === 'Use contains');
    expect(fix).toBeDefined();
    expect(fix?.severity).toBe('error');
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe("SELECT * FROM t WHERE contains(name, 'foo')");
  });

  it("should flag LIKE 'foo%' (prefix) → begins_with warning quick-fix", () => {
    const input = "SELECT * FROM t WHERE name LIKE 'foo%'";
    // Filter to walker-warnings since walker emits a `partiql-warning` code
    const all = lint(input);
    const fix = all.find((d) => d.actions?.[0]?.label === 'Use begins_with');
    expect(fix).toBeDefined();
    expect(fix?.severity).toBe('warning');
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe("SELECT * FROM t WHERE begins_with(name, 'foo')");
  });

  it("should flag LIKE '%foo' (suffix) → error with no quick-fix (lossy)", () => {
    const input = "SELECT * FROM t WHERE name LIKE '%foo'";
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('suffix match'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });
});

describe('findUnsupportedConstructs — IS NULL quick-fix payloads (INVERSE mapping)', () => {
  it('should flag IS NULL → attribute_not_exists', () => {
    const input = 'SELECT * FROM t WHERE x IS NULL';
    const ds = unsupported(input);
    const fix = ds.find((d) => d.actions?.[0]?.label === 'Use attribute_not_exists');
    expect(fix).toBeDefined();
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe('SELECT * FROM t WHERE attribute_not_exists(x)');
  });

  it('should flag IS NOT NULL → attribute_exists', () => {
    const input = 'SELECT * FROM t WHERE x IS NOT NULL';
    const ds = unsupported(input);
    const fix = ds.find((d) => d.actions?.[0]?.label === 'Use attribute_exists');
    expect(fix).toBeDefined();
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe('SELECT * FROM t WHERE attribute_exists(x)');
  });
});

describe('findUnsupportedConstructs — double-quoted-as-value quick-fix', () => {
  it('should flag `WHERE x = "value"` and rewrites with single quotes', () => {
    const input = 'SELECT * FROM t WHERE x = "value"';
    const ds = unsupported(input);
    const fix = ds.find((d) => d.actions?.[0]?.label === 'Use single quotes');
    expect(fix).toBeDefined();
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe("SELECT * FROM t WHERE x = 'value'");
  });

  it('should NOT flag quoted identifier in SELECT-list', () => {
    const ds = unsupported('SELECT "ColName" FROM "Tbl"');
    expect(ds.filter((d) => d.message.includes('Double quotes'))).toEqual([]);
  });

  it('should NOT flag quoted identifier in FROM clause', () => {
    const ds = unsupported('SELECT * FROM "Tbl"."Idx" WHERE x = 1');
    expect(ds.filter((d) => d.message.includes('Double quotes'))).toEqual([]);
  });
});

describe('findUnsupportedConstructs — full-table-scan warning + missing-FROM', () => {
  // Matches the legacy regex rule: fires when a WHERE clause is present but
  // has no `=` / `IN [...]` partition-key predicate. Projection-independent.
  it('should emit full-table-scan warning on WHERE with no key predicate', () => {
    for (const q of ['SELECT * FROM t WHERE x > 5', "SELECT a, b FROM t WHERE name LIKE 'foo'"]) {
      const all = lint(q);
      const w = all.find((d) => d.severity === 'warning' && d.message.includes('full table scan'));
      expect(w, q).toBeDefined();
    }
  });

  it('should NOT emit full-table-scan warning with a key predicate', () => {
    for (const q of ['SELECT * FROM t WHERE x = 1', 'SELECT * FROM t WHERE x IN [1, 2]']) {
      expect(
        lint(q).filter((d) => d.message.includes('full table scan')),
        q
      ).toEqual([]);
    }
  });

  it('should NOT emit full-table-scan warning when there is no WHERE clause', () => {
    for (const q of ['SELECT * FROM t', 'SELECT a, b FROM t']) {
      expect(
        lint(q).filter((d) => d.message.includes('full table scan')),
        q
      ).toEqual([]);
    }
  });

  it('should emit Missing-FROM error on bare `SELECT *`', () => {
    const all = lint('SELECT *');
    expect(all.some((d) => d.message.includes('Missing FROM clause'))).toBe(true);
  });
});

describe('findUnsupportedConstructs — SQL comments are warnings', () => {
  it('should flag -- line comments', () => {
    const all = lint('-- comment\nSELECT * FROM t WHERE x = 1');
    expect(all.some((d) => d.severity === 'warning' && d.message.includes('SQL comments'))).toBe(
      true
    );
  });

  it('should flag /* block */ comments', () => {
    const all = lint('SELECT /* note */ * FROM t WHERE x = 1');
    expect(all.some((d) => d.severity === 'warning' && d.message.includes('SQL comments'))).toBe(
      true
    );
  });
});

describe('findUnsupportedConstructs — happy path: bare valid statements emit zero diagnostics', () => {
  it.each([
    'SELECT * FROM "t" WHERE pk = 1',
    "SELECT a, b FROM t WHERE pk = 'x'",
    'SELECT * FROM "Tbl"."Idx" WHERE pk = 1',
    "INSERT INTO t VALUE {'pk': 'x', 'data': 1}",
    "UPDATE t SET a = 1 WHERE pk = 'x'",
    "DELETE FROM t WHERE pk = 'x'",
    "SELECT * FROM t WHERE x IN ['a', 'b']",
    'SELECT * FROM t WHERE x BETWEEN 1 AND 10',
    'SELECT * FROM t WHERE attribute_exists(x)',
    "UPDATE t SET tags = set_add(tags, <<'a','b'>>) WHERE pk = 'x'"
  ])('should emit no walker diagnostics for: %s', (input) => {
    const ds = lint(input);
    const errs = ds.filter(
      (d) =>
        d.code === 'partiql-unsupported' ||
        (d.code === 'partiql-parse-error' && d.severity === 'error')
    );
    expect(errs).toEqual([]);
  });
});

describe('findUnsupportedConstructs — walker context flags survive nested SELECT', () => {
  it('should still classify aggregate in outer WHERE after a subquery as WHERE-clause aggregate', () => {
    // Subquery in WHERE recurses through walkSelect → resets ctx.inWhereClause.
    // The outer COUNT(a) sibling must still receive the WHERE-clause-specific
    // message, not the generic "is not supported by DynamoDB PartiQL" form.
    const input = 'SELECT name FROM t WHERE x IN (SELECT y FROM u WHERE z = 1) AND COUNT(a) = 1';
    const ds = unsupported(input);
    expect(
      ds.some((d) => d.message.includes('cannot be used in WHERE clause')),
      ds.map((d) => d.message).join(' | ')
    ).toBe(true);
  });

  it('should still classify aggregate in outer SELECT-list after a subquery projection', () => {
    // Subquery in SELECT-list recurses through walkSelect → resets ctx.inSelectList.
    // Outer AVG(x) must still receive the Workbench-pointer SELECT-list message.
    const input = 'SELECT (SELECT COUNT(*) FROM u), AVG(x) FROM t';
    const ds = unsupported(input);
    expect(
      ds.some((d) =>
        d.message.includes('Use a Workbench (SQL) tab for COUNT/SUM/AVG/GROUP BY queries.')
      ),
      ds.map((d) => d.message).join(' | ')
    ).toBe(true);
  });
});

describe('findUnsupportedConstructs — NOT LIKE preserves negation in quick-fix', () => {
  it("should rewrite `NOT LIKE '%foo%'` to `NOT contains(...)`, not bare contains", () => {
    const input = "SELECT * FROM t WHERE name NOT LIKE '%foo%'";
    const ds = unsupported(input);
    const fix = ds.find((d) => d.actions?.[0]?.label.includes('contains'));
    expect(fix).toBeDefined();
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe("SELECT * FROM t WHERE NOT contains(name, 'foo')");
  });

  it("should rewrite `NOT LIKE 'foo%'` to `NOT begins_with(...)`, not bare begins_with", () => {
    const input = "SELECT * FROM t WHERE name NOT LIKE 'foo%'";
    const all = lint(input);
    const fix = all.find((d) => d.actions?.[0]?.label.includes('begins_with'));
    expect(fix).toBeDefined();
    const rewritten = applyEdit(input, fix!);
    expect(rewritten).toBe("SELECT * FROM t WHERE NOT begins_with(name, 'foo')");
  });
});

describe('findUnsupportedConstructs — quick-fix suppressed when test is not a path', () => {
  it('should NOT emit a contains() quick-fix when LIKE-test is an arithmetic expression', () => {
    // `foo + 1 LIKE '%x%'` → quick-fix would yield `contains(foo + 1, 'x')`,
    // which is invalid PartiQL. Diagnostic still fires; only the action is dropped.
    const input = "SELECT * FROM t WHERE foo + 1 LIKE '%x%'";
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('contains'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });

  it('should NOT emit a begins_with() quick-fix when LIKE-test is a function call', () => {
    const input = "SELECT * FROM t WHERE concat(a, b) LIKE 'foo%'";
    const all = lint(input);
    const diag = all.find((d) => d.message.includes('begins_with'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });

  it('should NOT emit an attribute_not_exists() quick-fix when IS NULL test is arithmetic', () => {
    const input = 'SELECT * FROM t WHERE foo + 1 IS NULL';
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('attribute_not_exists'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });
});

describe('findUnsupportedConstructs — quick-fix suppressed on lossy LIKE patterns', () => {
  it("should NOT emit a quick-fix when stripped pattern still has `%` (e.g. '%foo%bar%')", () => {
    // contains('foo%bar') is a literal-substring match — applying it would
    // silently demote a wildcard predicate. Diagnostic still names the
    // canonical replacement; only the destructive action is dropped.
    const input = "SELECT * FROM t WHERE name LIKE '%foo%bar%'";
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('contains'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });

  it("should NOT emit a quick-fix when pattern contains SQL `_` wildcard (e.g. 'foo_bar%')", () => {
    const input = "SELECT * FROM t WHERE name LIKE 'foo_bar%'";
    const all = lint(input);
    const diag = all.find((d) => d.message.includes('begins_with'));
    expect(diag).toBeDefined();
    expect(diag?.actions).toBeUndefined();
  });

  it("should NOT spell out the misleading literal when stripped pattern is lossy ('%foo%bar%')", () => {
    // The action is suppressed, but the message MUST NOT name `contains(path, 'foo%bar')`
    // — a user typing that manually would get a literal-substring match for the
    // string `foo%bar`, silently demoting the wildcard semantic. Diagnostic still
    // names `contains()` so the user knows the canonical family of replacements.
    const input = "SELECT * FROM t WHERE name LIKE '%foo%bar%'";
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('contains'));
    expect(diag).toBeDefined();
    expect(diag?.message).not.toMatch(/foo%bar/);
  });

  it("should NOT spell out the misleading literal for lossy prefix ('foo_bar%')", () => {
    const input = "SELECT * FROM t WHERE name LIKE 'foo_bar%'";
    const all = lint(input);
    const diag = all.find((d) => d.message.includes('begins_with'));
    expect(diag).toBeDefined();
    expect(diag?.message).not.toMatch(/foo_bar/);
  });

  it("should NOT spell out an empty literal when stripped pattern is empty ('%')", () => {
    // `LIKE '%'` strips to ''; spelling `contains(path, '')` would suggest a
    // no-op match. Diagnostic still names `contains()` for the family.
    const input = "SELECT * FROM t WHERE name LIKE '%'";
    const ds = unsupported(input);
    const diag = ds.find((d) => d.message.includes('contains'));
    expect(diag).toBeDefined();
    expect(diag?.message).not.toMatch(/contains\(path, ''\)/);
    expect(diag?.actions).toBeUndefined();
  });
});

describe('findUnsupportedConstructs — IN-list cardinality warning', () => {
  it('should warn on a literal IN list with >100 items', () => {
    const items = Array.from({length: 101}, (_, i) => String(i + 1)).join(', ');
    const input = `SELECT * FROM t WHERE attr IN [${items}]`;
    const all = lint(input);
    const warn = all.find((d) => d.message.includes('IN list has 101 items'));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('should NOT warn on a 100-item IN list (the cap, not over)', () => {
    const items = Array.from({length: 100}, (_, i) => String(i + 1)).join(', ');
    const input = `SELECT * FROM t WHERE attr IN [${items}]`;
    const all = lint(input);
    expect(all.some((d) => d.message.includes('IN list has'))).toBe(false);
  });
});

describe('findUnsupportedConstructs — bare dotted table.index warning', () => {
  it('should warn when both `tbl` and `idx` are unquoted', () => {
    const input = 'SELECT * FROM tbl.idx WHERE pk = 1';
    const all = lint(input);
    const warn = all.find((d) => d.message.includes('Quote table and index names'));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('should NOT warn when both segments are quoted', () => {
    const input = 'SELECT * FROM "Tbl"."Idx" WHERE pk = 1';
    const all = lint(input);
    expect(all.some((d) => d.message.includes('Quote table and index names'))).toBe(false);
  });

  it('should NOT warn on a bare table without an index suffix', () => {
    const input = 'SELECT * FROM tbl WHERE pk = 1';
    const all = lint(input);
    expect(all.some((d) => d.message.includes('Quote table and index names'))).toBe(false);
  });
});

describe('findUnsupportedConstructs — multi-construct query', () => {
  it('should emit multiple diagnostics for a query with several unsupported constructs', () => {
    const input = 'SELECT DISTINCT a AS x FROM t JOIN u ON t.x = u.x GROUP BY a LIMIT 10';
    const ds = unsupported(input);
    const messages = ds.map((d) => d.message).join(' | ');
    expect(messages).toContain('DISTINCT');
    expect(messages).toContain('Column aliases');
    expect(messages).toContain('JOIN');
    expect(messages).toContain('GROUP BY');
    expect(messages).toContain('LIMIT');
  });
});
