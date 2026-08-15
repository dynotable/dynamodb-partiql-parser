// CST walker that flags DDB-PartiQL-unsupported constructs the parser has
// accepted-then-collected (JOIN, GROUP BY, HAVING, set ops, LIMIT, OFFSET,
// DISTINCT, TOP, CASE WHEN, CAST/CONVERT, subqueries, AS column aliases,
// CTE/WITH, window OVER, DDL, arithmetic `*`/`/`/`%`/`||`, SQL-only function
// names, aggregates, IN(paren-list), LIKE patterns, IS NULL, double-quoted
// strings used in value position, full-table-scan warnings, and missing-FROM).
//
// Each finding is emitted as a `Diagnostic`. Quick-fix payloads are attached
// as `actions: QuickFix[]` where the source-range `edit` mirrors the legacy
// regex linter's CodeMirror Action edits 1:1 (rewritten as offset-based edits
// the renderer adapter maps to `view.dispatch({changes})`).
//
// Implementation note: this module is browser-safe and has zero runtime deps
// outside the parser's own emit/CST types.

import type {Diagnostic} from './emit';
import {DIAGNOSTIC_CODES} from './emit';
import {type Token, tokenize} from './lexer';
import type {
  BinaryExpression,
  CaseExpression,
  CastExpression,
  DdlStatement,
  DeleteStatement,
  Expression,
  FunctionCall,
  InsertStatement,
  IsNullExpression,
  JoinClause,
  LikeExpression,
  Program,
  SelectStatement,
  Statement,
  TableReference,
  UpdateStatement
} from './cst';
import type {Range} from './lexer';

// Function names the parser accepts as DDB-PartiQL valid (both AWS-canonical
// uppercase forms and the DDB ConditionExpression aliases, case-insensitive).
const VALID_FUNCTION_NAMES = new Set([
  // AWS-docs canonical form
  'size',
  'exists',
  'attribute_type',
  'begins_with',
  'contains',
  'missing',
  // DDB ConditionExpression aliases
  'attribute_exists',
  'attribute_not_exists',
  // UPDATE-only DML helpers
  'list_append',
  'set_add',
  'set_delete'
]);

const AGGREGATE_FUNCTION_NAMES = new Set(['count', 'sum', 'avg', 'min', 'max']);

const SQL_STRING_FUNCTION_NAMES = new Set([
  'upper',
  'lower',
  'substring',
  'substr',
  'trim',
  'concat',
  'length',
  'len',
  'coalesce',
  'ifnull',
  'nullif'
]);

interface WalkerContext {
  // Original source text — used for quick-fix edits (e.g. swapping `IN (`
  // parens for brackets requires reading the original comma list).
  source: string;
  diagnostics: Diagnostic[];
  // True while walking inside the SELECT-list of a SELECT — used to disambiguate
  // aggregate-in-projection vs aggregate-in-WHERE diagnostics.
  inSelectList: boolean;
  // True while walking inside a WHERE clause.
  inWhereClause: boolean;
}

export function findUnsupportedConstructs(program: Program, source: string): Diagnostic[] {
  const ctx: WalkerContext = {
    source,
    diagnostics: [],
    inSelectList: false,
    inWhereClause: false
  };

  // Multi-statement scripts — emit one diagnostic per extra statement, range
  // covering the offending statement.
  if (program.statements.length > 1) {
    for (let i = 1; i < program.statements.length; i++) {
      const s = program.statements[i];
      pushUnsupported(
        ctx,
        'Multi-statement scripts are not supported. Execute one statement at a time.',
        s.range
      );
    }
  }

  for (const stmt of program.statements) {
    walkStatement(stmt, ctx);
  }

  // Token-level passes (rules that don't depend on CST shape).
  scanTokenLevelDiagnostics(source, ctx);

  return ctx.diagnostics;
}

function walkStatement(stmt: Statement, ctx: WalkerContext): void {
  switch (stmt.kind) {
    case 'select_statement':
      walkSelect(stmt, ctx);
      break;
    case 'insert_statement':
      walkInsert(stmt, ctx);
      break;
    case 'update_statement':
      walkUpdate(stmt, ctx);
      break;
    case 'delete_statement':
      walkDelete(stmt, ctx);
      break;
    case 'ddl_statement':
      walkDdl(stmt, ctx);
      break;
    case 'error_statement':
      // Parse errors are emitted by the parser; nothing to add here.
      break;
  }
}

function walkSelect(stmt: SelectStatement, ctx: WalkerContext): void {
  if (stmt.withClause) {
    pushUnsupported(ctx, 'WITH/CTE is not supported by DynamoDB PartiQL.', stmt.withClause.range);
    for (const entry of stmt.withClause.entries) {
      if (entry.body.kind === 'select_statement') walkSelect(entry.body, ctx);
    }
  }

  if (stmt.distinct) {
    pushUnsupported(ctx, 'DISTINCT is not supported by DynamoDB PartiQL.', stmt.distinct.range);
  }
  if (stmt.top) {
    pushUnsupported(ctx, 'TOP N is not supported. Use the API limit parameter.', stmt.top.range);
  }
  if (stmt.groupBy) {
    pushUnsupported(ctx, 'GROUP BY is not supported by DynamoDB PartiQL.', stmt.groupBy.range);
    for (const item of stmt.groupBy.items) walkExpression(item, ctx);
  }
  if (stmt.having) {
    pushUnsupported(ctx, 'HAVING is not supported by DynamoDB PartiQL.', stmt.having.range);
    walkExpression(stmt.having.condition, ctx);
  }
  if (stmt.limit) {
    pushUnsupported(
      ctx,
      'Statement-level LIMIT is not supported. Use the API limit parameter.',
      stmt.limit.range
    );
  }
  if (stmt.offset) {
    pushUnsupported(ctx, 'OFFSET is not supported by DynamoDB PartiQL.', stmt.offset.range);
  }
  if (stmt.setOps) {
    for (const op of stmt.setOps) {
      pushUnsupported(
        ctx,
        'UNION/INTERSECT/EXCEPT are not supported by DynamoDB PartiQL.',
        op.range
      );
      if (op.right.kind === 'select_statement') walkSelect(op.right, ctx);
    }
  }

  // FROM + JOINs.
  if (stmt.from) {
    walkTableReference(stmt.from.source, ctx);
    if (stmt.from.joins) {
      for (const join of stmt.from.joins) {
        walkJoin(join, ctx);
      }
    }
  }

  // Projection — SELECT-list region. AS-aliases and aggregates-in-projection
  // are flagged here. Save/restore both flags so a subquery_expression inside
  // an outer projection doesn't clobber the outer classification.
  const prevSelectList = ctx.inSelectList;
  ctx.inSelectList = true;
  for (const item of stmt.projection.items) {
    if (item.kind === 'projection_expression') {
      if (item.alias) {
        pushUnsupported(
          ctx,
          'Column aliases (AS) are not supported in DynamoDB PartiQL.',
          item.alias.range
        );
      }
      walkExpression(item.expression, ctx);
    }
  }
  ctx.inSelectList = prevSelectList;

  // WHERE — flagged for aggregates separately from projection.
  if (stmt.where) {
    const prevWhere = ctx.inWhereClause;
    ctx.inWhereClause = true;
    walkExpression(stmt.where.condition, ctx);
    ctx.inWhereClause = prevWhere;
  }

  // ORDER BY items can also contain expressions worth walking (CAST, CASE…).
  if (stmt.orderBy) {
    for (const item of stmt.orderBy.items) {
      walkExpression(item.key, ctx);
    }
  }

  // Full-table-scan warning. Matches the legacy regex rule
  // (`partiql-validation-legacy.ts:549-567`): fires when a WHERE clause is
  // present but contains no partition-key predicate — i.e. no `=` comparison
  // and no `IN [...]` bracket list anywhere in the condition. Projection is
  // irrelevant (legacy fired on `SELECT a,b … WHERE x > 5` too). A query with
  // no WHERE at all does NOT warn (legacy `selectMatch?.[2]` is falsy).
  if (stmt.from && stmt.where && !whereHasKeyPredicate(stmt.where.condition)) {
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.warning,
      message:
        'This query may result in a full table scan. Consider adding a partition key condition with = or IN operator.',
      range: rangeOfSelectKeyword(stmt),
      severity: 'warning'
    });
  }

  // Missing FROM (`SELECT *` with no FROM) — preserves legacy `:533-541`.
  if (!stmt.from) {
    const isStarProjection =
      stmt.projection.items.length === 1 && stmt.projection.items[0].kind === 'projection_wildcard';
    if (isStarProjection) {
      ctx.diagnostics.push({
        code: DIAGNOSTIC_CODES.parseError,
        message: 'Missing FROM clause in SELECT statement',
        range: rangeOfSelectKeyword(stmt),
        severity: 'error'
      });
    }
  }
}

function walkJoin(join: JoinClause, ctx: WalkerContext): void {
  pushUnsupported(ctx, 'JOIN is not supported by DynamoDB PartiQL.', join.range);
  if (join.on) walkExpression(join.on, ctx);
}

function walkInsert(stmt: InsertStatement, ctx: WalkerContext): void {
  walkTableReference(stmt.table, ctx);
  walkExpression(stmt.value, ctx);
}

function walkUpdate(stmt: UpdateStatement, ctx: WalkerContext): void {
  walkTableReference(stmt.table, ctx);
  for (const a of stmt.assignments) {
    if (a.kind === 'set_assignment') {
      walkExpression(a.target, ctx);
      walkExpression(a.value, ctx);
    } else {
      walkExpression(a.target, ctx);
    }
  }
  if (stmt.where) {
    const prev = ctx.inWhereClause;
    ctx.inWhereClause = true;
    walkExpression(stmt.where.condition, ctx);
    ctx.inWhereClause = prev;
  }
}

function walkDelete(stmt: DeleteStatement, ctx: WalkerContext): void {
  walkTableReference(stmt.table, ctx);
  if (stmt.where) {
    const prev = ctx.inWhereClause;
    ctx.inWhereClause = true;
    walkExpression(stmt.where.condition, ctx);
    ctx.inWhereClause = prev;
  }
}

// Plain `tbl.idx` (both segments unquoted) parses but violates AWS convention:
// docs require `"tbl"."idx"` when an index suffix is present. Single bare
// segment (`SELECT * FROM tbl`) stays clean — only the dotted form triggers.
function walkTableReference(tref: TableReference, ctx: WalkerContext): void {
  if (tref.index && tref.table.kind === 'identifier' && tref.index.kind === 'identifier') {
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.warning,
      message: 'Quote table and index names to match AWS convention: "table"."index".',
      range: tref.range,
      severity: 'warning'
    });
  }
}

function walkDdl(stmt: DdlStatement, ctx: WalkerContext): void {
  pushUnsupported(
    ctx,
    'DDL statements are not supported via PartiQL. Use the AWS console or SDK.',
    stmt.range
  );
}

function walkExpression(expr: Expression, ctx: WalkerContext): void {
  switch (expr.kind) {
    case 'binary_expression':
      walkBinary(expr, ctx);
      return;
    case 'unary_expression':
      walkExpression(expr.argument, ctx);
      return;
    case 'paren_expression':
      walkExpression(expr.expression, ctx);
      return;
    case 'function_call':
      walkFunctionCall(expr, ctx);
      return;
    case 'between_expression':
      walkExpression(expr.test, ctx);
      walkExpression(expr.lower, ctx);
      walkExpression(expr.upper, ctx);
      return;
    case 'in_expression':
      walkExpression(expr.test, ctx);
      // Pre-execute cardinality guardrail. The IN operator's list caps at 100
      // values (AWS, "Writing conditions with legacy parameters",
      // docs.aws.amazon.com/amazondynamodb/latest/developerguide/LegacyConditionalParameters.Conditions.html,
      // fetched 2026-08-15: "The list can contain up to 100 values"). The
      // stricter 50-value cap for partition-key IN lists is widely reported
      // but absent from current operative AWS docs — treated as advisory
      // only. The linter can't tell PK from non-key without schema, so it
      // warns once past the documented 100 cap, giving advance notice before
      // a server-side rejection. Only literal lists are counted (subquery
      // expansions are flagged separately).
      if (expr.source.kind === 'list_literal' && expr.source.items.length > 100) {
        ctx.diagnostics.push({
          code: DIAGNOSTIC_CODES.warning,
          message: `IN list has ${expr.source.items.length} items. DynamoDB PartiQL caps IN at 50 values (PK column) or 100 values (non-key column).`,
          range: expr.source.range,
          severity: 'warning'
        });
      }
      if (expr.source.kind === 'paren_list') {
        // `IN (SELECT …)` wraps the subquery as a paren_list with a single
        // subquery_expression item — skip the bracket-replacement quick-fix
        // because `IN [SELECT …]` is invalid PartiQL. The subquery_expression
        // walker emits its own (correct) diagnostic.
        const hasSubquery = expr.source.items.some((item) => item.kind === 'subquery_expression');
        if (!hasSubquery) {
          const text = ctx.source.slice(expr.source.range.start + 1, expr.source.range.end - 1);
          ctx.diagnostics.push({
            code: DIAGNOSTIC_CODES.unsupported,
            message:
              'DynamoDB PartiQL uses square brackets with IN operator, not parentheses. Use: IN [value1, value2]',
            range: expr.source.range,
            severity: 'error',
            actions: [
              {
                label: 'Use brackets',
                edit: {
                  start: expr.source.range.start,
                  end: expr.source.range.end,
                  text: `[${text}]`
                }
              }
            ]
          });
        }
        for (const item of expr.source.items) walkExpression(item, ctx);
      } else {
        for (const item of expr.source.items) walkExpression(item, ctx);
      }
      return;
    case 'like_expression':
      walkLike(expr, ctx);
      return;
    case 'is_null_expression':
      walkIsNull(expr, ctx);
      return;
    case 'is_missing_expression':
      walkExpression(expr.test, ctx);
      return;
    case 'list_literal':
      for (const item of expr.items) walkExpression(item, ctx);
      return;
    case 'paren_list':
      for (const item of expr.items) walkExpression(item, ctx);
      return;
    case 'object_literal':
      for (const e of expr.entries) walkExpression(e.value, ctx);
      return;
    case 'bag_literal':
      for (const item of expr.items) walkExpression(item, ctx);
      return;
    case 'case_expression':
      walkCase(expr, ctx);
      return;
    case 'cast_expression':
      walkCast(expr, ctx);
      return;
    case 'subquery_expression':
      pushUnsupported(
        ctx,
        "Subqueries in expressions are not supported. Use a list literal: IN ['a','b']",
        expr.range
      );
      if (expr.select.kind === 'select_statement') walkSelect(expr.select, ctx);
      return;
    case 'string_literal':
      // Double-quoted-as-value detection happens in the token-level pass.
      return;
    case 'path_expression': {
      // Index expressions inside [...] can themselves be richer; walk them.
      for (const step of expr.steps) {
        if (step.kind === 'index_access') walkExpression(step.index, ctx);
      }
      break;
    }
    case 'identifier':
    case 'quoted_identifier':
    case 'parameter':
    case 'null_literal':
    case 'boolean_literal':
    case 'number_literal':
    case 'missing_literal':
    case 'error_expression':
      break;
  }
}

function walkBinary(expr: BinaryExpression, ctx: WalkerContext): void {
  const op = expr.operator;
  if (op === '/' || op === '%' || op === '||' || op === '*') {
    pushUnsupported(
      ctx,
      `Arithmetic operator '${op}' is not supported by DynamoDB PartiQL. Supported arithmetic: + and -`,
      expr.range
    );
  }
  walkExpression(expr.left, ctx);
  walkExpression(expr.right, ctx);
}

function walkFunctionCall(call: FunctionCall, ctx: WalkerContext): void {
  const name = call.name.name.toLowerCase();

  if (call.over) {
    pushUnsupported(
      ctx,
      'Window functions / OVER clauses are not supported by DynamoDB PartiQL.',
      call.over.range
    );
  }

  // bare `exists()` / `missing()` (lowercase, single-arg) — quick-fix to
  // attribute_exists / attribute_not_exists per legacy linter behavior.
  // Trigger ONLY on the lowercase source spelling (case-sensitive) so we don't
  // double-flag the AWS-canonical EXISTS / MISSING uppercase forms.
  if ((call.name.name === 'exists' || call.name.name === 'missing') && call.args.length >= 1) {
    const replacement = call.name.name === 'exists' ? 'attribute_exists' : 'attribute_not_exists';
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.unsupported,
      message: `${call.name.name}(path) is not a DynamoDB PartiQL function. Use ${replacement}(path).`,
      range: call.name.range,
      severity: 'error',
      actions: [
        {
          label: `Use ${replacement}`,
          edit: {
            start: call.name.range.start,
            end: call.name.range.end,
            text: replacement
          }
        }
      ]
    });
    // Still walk args so e.g. CAST(...) inside the call gets flagged.
    for (const arg of call.args) {
      if (arg.kind !== 'wildcard_arg') walkExpression(arg, ctx);
    }
    return;
  }

  if (AGGREGATE_FUNCTION_NAMES.has(name)) {
    if (ctx.inWhereClause) {
      pushUnsupported(
        ctx,
        `Aggregate function "${name.toUpperCase()}" cannot be used in WHERE clause`,
        call.name.range
      );
    } else if (ctx.inSelectList) {
      pushUnsupported(
        ctx,
        'DynamoDB PartiQL does not support aggregations. Use a Workbench (SQL) tab for COUNT/SUM/AVG/GROUP BY queries.',
        call.name.range
      );
    } else {
      pushUnsupported(
        ctx,
        `${name.toUpperCase()} is not supported by DynamoDB PartiQL.`,
        call.name.range
      );
    }
  } else if (SQL_STRING_FUNCTION_NAMES.has(name)) {
    pushUnsupported(
      ctx,
      `${name.toUpperCase()} is not supported by DynamoDB PartiQL.`,
      call.name.range
    );
  } else if (!VALID_FUNCTION_NAMES.has(name)) {
    // Unknown function name — accept-then-flag.
    pushUnsupported(ctx, `${call.name.name} is not a DynamoDB PartiQL function.`, call.name.range);
  }
  for (const arg of call.args) {
    if (arg.kind !== 'wildcard_arg') walkExpression(arg, ctx);
  }
}

function walkLike(expr: LikeExpression, ctx: WalkerContext): void {
  walkExpression(expr.test, ctx);
  if (expr.pattern.kind !== 'string_literal') {
    pushUnsupported(ctx, 'LIKE is not supported by DynamoDB PartiQL.', expr.range);
    return;
  }
  const {value} = expr.pattern;
  const hasLeading = value.startsWith('%');
  const hasTrailing = value.endsWith('%');
  const stripped = value.replace(/^%+/, '').replace(/%+$/, '');
  const literal = escapeSingleQuotes(stripped);
  const testText = sliceText(ctx.source, expr.test.range);
  // Quick-fix is only safe when `test` is a path expression. `foo + 1 LIKE 'x%'`
  // would rewrite to `begins_with(foo + 1, 'x')` which is invalid PartiQL.
  const testIsPath = isPathLikeExpression(expr.test);
  // The stripped literal is only semantically equivalent when it has no
  // internal LIKE metacharacters (`%` mid-pattern or `_` anywhere) and is
  // non-empty. Otherwise spelling out a `contains`/`begins_with` rewrite would
  // mislead the user — `LIKE '%a%b%'` → `contains(x, 'a%b')` silently demotes
  // a wildcard match to a literal substring, and `LIKE '%'` → `contains(x, '')`
  // matches everything. When unsafe, omit the literal from the message.
  const literalSafe = stripped.length > 0 && !stripped.includes('%') && !stripped.includes('_');
  const canQuickFix = testIsPath && literalSafe;
  const notPrefix = expr.negated ? 'NOT ' : '';
  const likeLabel = expr.negated ? 'NOT LIKE' : 'LIKE';
  if (hasLeading && hasTrailing) {
    // `'%foo%'` substring → contains(path, 'foo') (or NOT contains for NOT LIKE).
    const message = literalSafe
      ? `${likeLabel} '%foo%' is not supported in DynamoDB PartiQL. Use ${notPrefix}contains(path, '${literal}').`
      : `${likeLabel} pattern is not supported in DynamoDB PartiQL. No clean rewrite (pattern has internal wildcards or is empty); filter in application code or use ${notPrefix}contains() with a literal substring.`;
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.unsupported,
      message,
      range: expr.range,
      severity: 'error',
      actions: canQuickFix
        ? [
            {
              label: `Use ${notPrefix}contains`.trim(),
              edit: {
                start: expr.range.start,
                end: expr.range.end,
                text: `${notPrefix}contains(${testText}, '${literal}')`
              }
            }
          ]
        : undefined
    });
  } else if (hasLeading) {
    // suffix match — no clean rewrite, no quick-fix.
    const message = literalSafe
      ? `${likeLabel} '%foo' (suffix match) is not supported in DynamoDB PartiQL. No direct equivalent; filter in application code or use ${notPrefix}contains(path, '${literal}') as a superset match.`
      : `${likeLabel} pattern is not supported in DynamoDB PartiQL. No clean rewrite (pattern has internal wildcards); filter in application code or use ${notPrefix}contains() with a literal substring.`;
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.unsupported,
      message,
      range: expr.range,
      severity: 'error'
    });
  } else if (hasTrailing) {
    const message = literalSafe
      ? `Prefer ${notPrefix}begins_with(path, '${literal}') for clarity over ${likeLabel}.`
      : `Prefer ${notPrefix}begins_with(path, '<literal-prefix>') over ${likeLabel}. No clean rewrite from this pattern (it has internal wildcards or is empty); choose a literal prefix.`;
    ctx.diagnostics.push({
      code: DIAGNOSTIC_CODES.warning,
      message,
      range: expr.range,
      severity: 'warning',
      actions: canQuickFix
        ? [
            {
              label: `Use ${notPrefix}begins_with`.trim(),
              edit: {
                start: expr.range.start,
                end: expr.range.end,
                text: `${notPrefix}begins_with(${testText}, '${literal}')`
              }
            }
          ]
        : undefined
    });
  } else {
    pushUnsupported(ctx, 'LIKE is not supported by DynamoDB PartiQL.', expr.range);
  }
}

function isPathLikeExpression(expr: Expression): boolean {
  return (
    expr.kind === 'identifier' ||
    expr.kind === 'quoted_identifier' ||
    expr.kind === 'path_expression'
  );
}

function walkIsNull(expr: IsNullExpression, ctx: WalkerContext): void {
  walkExpression(expr.test, ctx);
  const fieldText = sliceText(ctx.source, expr.test.range);
  // Legacy maps `IS NULL → attribute_not_exists` and `IS NOT NULL → attribute_exists`
  // (inverse). Preserve that for parity-corpus stability. Quick-fix is only
  // safe when `test` is a path expression — `foo + 1 IS NULL` rewriting to
  // `attribute_not_exists(foo + 1)` would be invalid PartiQL. Legacy regex
  // only matched identifier paths; mirror that here.
  const fnName = expr.negated ? 'attribute_exists' : 'attribute_not_exists';
  const replacement = `${fnName}(${fieldText})`;
  const testIsPath = isPathLikeExpression(expr.test);
  ctx.diagnostics.push({
    code: DIAGNOSTIC_CODES.unsupported,
    message: `IS ${expr.negated ? 'NOT ' : ''}NULL is not supported in DynamoDB PartiQL. Use ${replacement}.`,
    range: expr.range,
    severity: 'error',
    actions: testIsPath
      ? [
          {
            label: `Use ${fnName}`,
            edit: {
              start: expr.range.start,
              end: expr.range.end,
              text: replacement
            }
          }
        ]
      : undefined
  });
}

function walkCase(expr: CaseExpression, ctx: WalkerContext): void {
  pushUnsupported(ctx, 'CASE expressions are not supported by DynamoDB PartiQL.', expr.range);
  for (const branch of expr.whenBranches) {
    walkExpression(branch.condition, ctx);
    walkExpression(branch.result, ctx);
  }
  if (expr.elseBranch) walkExpression(expr.elseBranch, ctx);
}

function walkCast(expr: CastExpression, ctx: WalkerContext): void {
  pushUnsupported(ctx, `${expr.command} is not supported by DynamoDB PartiQL.`, expr.range);
  walkExpression(expr.source, ctx);
}

// Token-level pass for rules that depend on raw source position rather than
// CST shape: double-quoted identifiers used in value-position (DDB rejects),
// and SQL-style comments (DDB strips them but emits a warning so users don't
// rely on the behavior).
function scanTokenLevelDiagnostics(source: string, ctx: WalkerContext): void {
  const lex = tokenize(source);
  let inSelectList = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  let prevSig: Token | undefined;
  for (const t of lex.tokens) {
    if (t.type === 'whitespace') continue;
    if (t.type === 'comment_line' || t.type === 'comment_block') {
      ctx.diagnostics.push({
        code: DIAGNOSTIC_CODES.warning,
        message:
          'SQL comments are not preserved when sent to DynamoDB and may cause statement parser errors. Remove before executing.',
        range: t.range,
        severity: 'warning'
      });
      continue;
    }
    if (t.type === 'keyword') {
      const kw = t.value.toUpperCase();
      if (kw === 'SELECT') inSelectList = true;
      else if (kw === 'FROM') inSelectList = false;
    }
    if (t.type === 'punct') {
      if (t.value === '[') bracketDepth++;
      else if (t.value === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (t.value === '{') braceDepth++;
      else if (t.value === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
    if (t.type === 'quoted_identifier') {
      let isValuePos = false;
      if (prevSig) {
        if (prevSig.type === 'operator') {
          isValuePos = true;
        } else if (prevSig.type === 'punct') {
          if (prevSig.value === '[') isValuePos = true;
          else if (prevSig.value === ',' && bracketDepth > 0) isValuePos = true;
          else if (prevSig.value === ':' && braceDepth > 0) isValuePos = true;
        }
      }
      if (
        isValuePos &&
        inSelectList &&
        bracketDepth === 0 &&
        braceDepth === 0 &&
        prevSig?.value === ','
      ) {
        // SELECT-list `,` at depth 0 is a column separator — not a value.
        isValuePos = false;
      }
      if (isValuePos) {
        const replacement = `'${escapeSingleQuotes(t.text ?? '')}'`;
        ctx.diagnostics.push({
          code: DIAGNOSTIC_CODES.unsupported,
          message:
            'Double quotes delimit identifiers in DynamoDB PartiQL, not strings. Use single quotes for string values.',
          range: t.range,
          severity: 'error',
          actions: [
            {
              label: 'Use single quotes',
              edit: {start: t.range.start, end: t.range.end, text: replacement}
            }
          ]
        });
      }
    }
    prevSig = t;
  }
}

function pushUnsupported(ctx: WalkerContext, message: string, range: Range): void {
  ctx.diagnostics.push({
    code: DIAGNOSTIC_CODES.unsupported,
    message,
    range,
    severity: 'error'
  });
}

// True if the WHERE condition contains a partition-key-shaped predicate
// anywhere: an `=` comparison or an `IN [...]` bracket list. Mirrors the
// legacy regex `/\w+\s*(?:=|IN\s*\[)/i`. Bounded by the parser's expression
// depth cap.
function whereHasKeyPredicate(expr: Expression): boolean {
  switch (expr.kind) {
    case 'binary_expression':
      if (expr.operator === '=') return true;
      return whereHasKeyPredicate(expr.left) || whereHasKeyPredicate(expr.right);
    case 'in_expression':
      if (expr.source.kind === 'list_literal') return true;
      return whereHasKeyPredicate(expr.test);
    case 'unary_expression':
      return whereHasKeyPredicate(expr.argument);
    case 'paren_expression':
      return whereHasKeyPredicate(expr.expression);
    case 'between_expression':
      return (
        whereHasKeyPredicate(expr.test) ||
        whereHasKeyPredicate(expr.lower) ||
        whereHasKeyPredicate(expr.upper)
      );
    default:
      return false;
  }
}

function rangeOfSelectKeyword(stmt: SelectStatement): Range {
  // Use the recorded SELECT-keyword range, not `stmt.range.start` — a WITH
  // prefix widens `stmt.range` to begin at `WITH`, which would underline the
  // wrong span.
  return stmt.selectKeyword;
}

function sliceText(source: string, range: Range): string {
  return source.slice(range.start, range.end);
}

function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "''");
}
