// Hand-written recursive-descent parser for the DynamoDB PartiQL subset.
//
// Task 2 scope: SELECT statements (projection, FROM, WHERE, ORDER BY) and the
// full expression precedence ladder:
//   OR > AND > NOT > comparison > BETWEEN/IN/LIKE/IS > additive >
//   multiplicative > unary > primary
//
// `IN [list]` is the legal DDB form. `IN (...)` ALSO parses (so the user sees
// a useful CST) but emits a `partiql-quick-fix` diagnostic with an edit that
// swaps parens for brackets.
//
// Error recovery: on a top-level syntax error the parser synchronises on `;`
// or the next statement-introducing keyword. Expression-level errors emit an
// `error_expression` node + diagnostic and keep going.

import {type Range, type Token, tokenize} from './lexer';
import type {Diagnostic, QuickFix} from './emit';
import {DIAGNOSTIC_CODES} from './emit';
import {
  isIdentifierEligibleKeyword,
  parseExpression,
  parseIdentifierToken,
  parsePathTail
} from './parser-expressions';
import type {
  ColumnAlias,
  CteEntry,
  DdlStatement,
  DeleteStatement,
  DistinctMarker,
  ErrorStatement,
  Expression,
  FromClause,
  GroupByClause,
  HavingClause,
  Identifier,
  InsertStatement,
  JoinClause,
  LimitClause,
  OffsetClause,
  OrderByClause,
  OrderByItem,
  Program,
  Projection,
  ProjectionExpression,
  ProjectionItem,
  ProjectionWildcard,
  QuotedIdentifier,
  RemoveAssignment,
  ReturningClause,
  SelectStatement,
  SetAssignment,
  SetOpClause,
  Statement,
  TableReference,
  TopClause,
  UpdateAssignment,
  UpdateStatement,
  WhereClause,
  WithClause
} from './cst';

export interface ParseResult {
  cst: Program;
  diagnostics: Diagnostic[];
}

const STATEMENT_KEYWORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

export function parse(input: string): ParseResult {
  const lexResult = tokenize(input);
  const tokens = lexResult.tokens.filter(
    (t) => t.type !== 'whitespace' && t.type !== 'comment_line' && t.type !== 'comment_block'
  );
  const diagnostics: Diagnostic[] = [];
  for (const err of lexResult.errors) {
    diagnostics.push({
      code: DIAGNOSTIC_CODES.parseError,
      message: err.message,
      range: err.range,
      severity: 'error'
    });
  }
  const parser = new PartiqlParser(input, tokens, diagnostics);
  const program = parser.parseProgram();
  return {cst: program, diagnostics};
}

// Hard ceiling on expression-recursion depth. A human-authored PartiQL
// statement in the editor never nests this deep; a pathological paste
// (`[[[[…`, `NOT NOT …`, `{'k':{'k':…`) otherwise overflows the V8 stack and
// throws an uncaught `RangeError` straight through the synchronous CodeMirror
// linter. Bail with one diagnostic instead. Kept well under the renderer
// main-thread stack budget.
const MAX_EXPR_DEPTH = 500;

export class PartiqlParser {
  pos = 0;
  private exprDepth = 0;

  constructor(
    readonly source: string,
    readonly tokens: Token[],
    readonly diagnostics: Diagnostic[]
  ) {}

  // Returns false once expression recursion exceeds `MAX_EXPR_DEPTH`. Every
  // caller that returns true MUST pair it with `leaveExpr()` (use try/finally).
  enterExpr(): boolean {
    return ++this.exprDepth <= MAX_EXPR_DEPTH;
  }

  leaveExpr(): void {
    this.exprDepth--;
  }

  // ===== Helpers (public so free-function parsers in sibling modules can use them) =====

  peek(offset = 0): Token {
    const idx = this.pos + offset;
    return this.tokens[idx] ?? this.tokens[this.tokens.length - 1];
  }

  isEof(): boolean {
    return this.peek().type === 'eof';
  }

  consume(): Token {
    const tok = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }

  match(predicate: (t: Token) => boolean): Token | undefined {
    if (predicate(this.peek())) return this.consume();
    return undefined;
  }

  matchKeyword(...names: string[]): Token | undefined {
    const t = this.peek();
    if (t.type === 'keyword' && names.includes(t.value.toUpperCase())) return this.consume();
    return undefined;
  }

  peekKeyword(...names: string[]): boolean {
    const t = this.peek();
    return t.type === 'keyword' && names.includes(t.value.toUpperCase());
  }

  peekPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  peekOperator(...values: string[]): boolean {
    const t = this.peek();
    return t.type === 'operator' && values.includes(t.value);
  }

  matchPunct(value: string): Token | undefined {
    if (this.peekPunct(value)) return this.consume();
    return undefined;
  }

  expectPunct(value: string): Token | undefined {
    const t = this.matchPunct(value);
    if (t) return t;
    const cur = this.peek();
    this.error(`Expected '${value}'`, cur.range);
    return undefined;
  }

  expectKeyword(...names: string[]): Token | undefined {
    const t = this.matchKeyword(...names);
    if (t) return t;
    const cur = this.peek();
    this.error(`Expected ${names.join(' or ')}`, cur.range);
    return undefined;
  }

  error(message: string, range: Range): void {
    // Don't pile duplicate diagnostics at the same offset (recovery loops).
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (
      last?.code === DIAGNOSTIC_CODES.parseError &&
      last.range.start === range.start &&
      last.range.end === range.end &&
      last.message === message
    ) {
      return;
    }
    this.diagnostics.push({
      code: DIAGNOSTIC_CODES.parseError,
      message,
      range,
      severity: 'error'
    });
  }

  quickFix(message: string, range: Range, fix: QuickFix): void {
    this.diagnostics.push({
      code: DIAGNOSTIC_CODES.quickFix,
      message,
      range,
      severity: 'info',
      actions: [fix]
    });
  }

  rangeFrom(start: Token, end?: Token): Range {
    const last = end ?? this.tokens[Math.max(this.pos - 1, 0)];
    return {start: start.range.start, end: last.range.end};
  }

  syncStatementBoundary(): void {
    while (!this.isEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === ';') {
        this.consume();
        return;
      }
      if (t.type === 'keyword' && STATEMENT_KEYWORDS.has(t.value.toUpperCase())) return;
      this.consume();
    }
  }

  // ===== Program =====

  parseProgram(): Program {
    const start: Range = {start: 0, end: this.source.length};
    const statements: Statement[] = [];
    while (!this.isEof()) {
      // Swallow stray `;` (empty statements, leading/trailing terminators)
      // before dispatching — otherwise `parseStatement` would fall through to
      // the "Unexpected token ';'" error path and pollute the diagnostics on
      // every keystroke around the cursor.
      if (this.matchPunct(';')) continue;
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      // Allow (and consume) optional statement terminators. Multi-statement
      // scripts are flagged by the walker; the parser accepts them.
      this.matchPunct(';');
    }
    return {kind: 'program', statements, range: start};
  }

  private parseStatement(): Statement | undefined {
    const t = this.peek();
    if (t.type === 'keyword') {
      const kw = t.value.toUpperCase();
      // WITH/CTE prefix is accepted-then-flagged. Attach to the wrapped
      // statement so the walker can flag at the WITH range.
      if (kw === 'WITH') {
        const withClause = this.parseWith();
        const inner = this.peek();
        if (inner.type === 'keyword' && inner.value.toUpperCase() === 'SELECT') {
          const select = this.parseSelect();
          select.withClause = withClause;
          select.range = {start: withClause.range.start, end: select.range.end};
          return select;
        }
        // CTE attached to a non-SELECT — still accept and synchronise.
        this.error('Expected SELECT after WITH clause', inner.range);
        const startTok = inner;
        this.syncStatementBoundary();
        const node: ErrorStatement = {
          kind: 'error_statement',
          range: {start: withClause.range.start, end: startTok.range.end}
        };
        return node;
      }
      if (kw === 'SELECT') return this.parseSelect();
      if (kw === 'INSERT') return this.parseInsert();
      if (kw === 'UPDATE') return this.parseUpdate();
      if (kw === 'DELETE') return this.parseDelete();
      if (kw === 'CREATE' || kw === 'DROP' || kw === 'ALTER' || kw === 'TRUNCATE') {
        return this.parseDdl();
      }
    }
    // Unknown statement -- emit error and synchronize.
    this.error(`Unexpected token '${t.value || t.type}'`, t.range);
    const startTok = this.peek();
    this.syncStatementBoundary();
    const node: ErrorStatement = {
      kind: 'error_statement',
      range: {start: startTok.range.start, end: this.peek().range.start}
    };
    return node;
  }

  // ===== WITH / CTE =====

  private parseWith(): WithClause {
    const startTok = this.consume(); // WITH
    const recursive = !!this.matchKeyword('RECURSIVE');
    const entries: CteEntry[] = [];
    entries.push(this.parseCteEntry());
    while (this.matchPunct(',')) {
      entries.push(this.parseCteEntry());
    }
    const last = entries[entries.length - 1];
    return {
      kind: 'with_clause',
      recursive,
      entries,
      range: {start: startTok.range.start, end: last.range.end}
    };
  }

  private parseCteEntry(): CteEntry {
    const name = parseIdentifierToken(this);
    this.expectKeyword('AS');
    this.expectPunct('(');
    const inner = this.peek();
    let body: SelectStatement | ErrorStatement;
    if (inner.type === 'keyword' && inner.value.toUpperCase() === 'SELECT') {
      body = this.parseSelect();
    } else {
      this.error('Expected SELECT in CTE body', inner.range);
      const errStart = inner;
      // Skip until close paren or statement boundary.
      while (!this.isEof() && !this.peekPunct(')')) this.consume();
      body = {
        kind: 'error_statement',
        range: {start: errStart.range.start, end: this.peek().range.start}
      };
    }
    const closeTok = this.expectPunct(')');
    return {
      kind: 'cte_entry',
      name,
      body,
      range: {start: name.range.start, end: closeTok ? closeTok.range.end : body.range.end}
    };
  }

  // ===== DDL (CREATE / DROP / ALTER / TRUNCATE) =====

  private parseDdl(): DdlStatement {
    const startTok = this.consume();
    const command = startTok.value.toUpperCase() as DdlStatement['command'];
    // Skip the remainder of the statement so a partial DDL doesn't poison the
    // rest of a multi-statement script. Stop at `;` or EOF without consuming
    // the terminator (parseProgram handles `;`).
    while (!this.isEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === ';') break;
      this.consume();
    }
    return {
      kind: 'ddl_statement',
      command,
      range: this.rangeFrom(startTok)
    };
  }

  // ===== SELECT =====

  parseSelect(): SelectStatement {
    // Set-op chains are flattened: `A UNION B UNION C` becomes
    // `head=A, setOps=[{op:UNION,right:B}, {op:UNION,right:C}]` rather than
    // nesting each right inside the previous one's setOps. Nested recursion
    // here would otherwise overflow the stack for long UNION/INTERSECT/EXCEPT
    // chains (each RHS pushed another `parseSelect` frame).
    const head = this.parseSelectCore();
    while (this.peekKeyword('UNION', 'INTERSECT', 'EXCEPT')) {
      const opTok = this.consume();
      const all = !!this.matchKeyword('ALL');
      const rightStart = this.peek();
      let right: SelectStatement | ErrorStatement;
      if (rightStart.type === 'keyword' && rightStart.value.toUpperCase() === 'SELECT') {
        right = this.parseSelectCore();
      } else {
        this.error('Expected SELECT after set operator', rightStart.range);
        right = {
          kind: 'error_statement',
          range: {start: rightStart.range.start, end: rightStart.range.end}
        };
      }
      const node: SetOpClause = {
        kind: 'set_op_clause',
        operator: opTok.value.toUpperCase() as 'UNION' | 'INTERSECT' | 'EXCEPT',
        all,
        right,
        range: {start: opTok.range.start, end: right.range.end}
      };
      if (!head.setOps) head.setOps = [];
      head.setOps.push(node);
      head.range = {start: head.range.start, end: right.range.end};
    }
    return head;
  }

  private parseSelectCore(): SelectStatement {
    const startTok = this.consume(); // SELECT
    // DDB-unsupported prefixes (DISTINCT, TOP N) — accept-then-flag.
    let distinct: DistinctMarker | undefined;
    if (this.peekKeyword('DISTINCT')) {
      const distinctTok = this.consume();
      distinct = {kind: 'distinct_marker', range: distinctTok.range};
    }
    let top: TopClause | undefined;
    if (this.peekKeyword('TOP')) {
      const topTok = this.consume();
      const count = parseExpression(this);
      top = {
        kind: 'top_clause',
        count,
        range: {start: topTok.range.start, end: count.range.end}
      };
    }
    const projection = this.parseProjection();
    let from: FromClause | undefined;
    if (this.peekKeyword('FROM')) {
      from = this.parseFrom();
    }
    let where: WhereClause | undefined;
    if (this.peekKeyword('WHERE')) {
      where = this.parseWhere();
    }
    let groupBy: GroupByClause | undefined;
    if (this.peekKeyword('GROUP')) {
      groupBy = this.parseGroupBy();
    }
    let having: HavingClause | undefined;
    if (this.peekKeyword('HAVING')) {
      having = this.parseHaving();
    }
    let orderBy: OrderByClause | undefined;
    if (this.peekKeyword('ORDER')) {
      orderBy = this.parseOrderBy();
    }
    let limit: LimitClause | undefined;
    if (this.peekKeyword('LIMIT')) {
      limit = this.parseLimit();
    }
    let offset: OffsetClause | undefined;
    if (this.peekKeyword('OFFSET')) {
      offset = this.parseOffset();
    }
    return {
      kind: 'select_statement',
      selectKeyword: startTok.range,
      distinct,
      top,
      projection,
      from,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      range: this.rangeFrom(startTok)
    };
  }

  private parseGroupBy(): GroupByClause {
    const groupTok = this.consume(); // GROUP
    this.expectKeyword('BY');
    const items: Expression[] = [];
    items.push(parseExpression(this));
    while (this.matchPunct(',')) {
      items.push(parseExpression(this));
    }
    const last = items[items.length - 1];
    return {
      kind: 'group_by_clause',
      items,
      range: {start: groupTok.range.start, end: last.range.end}
    };
  }

  private parseHaving(): HavingClause {
    const startTok = this.consume(); // HAVING
    const condition = parseExpression(this);
    return {
      kind: 'having_clause',
      condition,
      range: {start: startTok.range.start, end: condition.range.end}
    };
  }

  private parseLimit(): LimitClause {
    const startTok = this.consume(); // LIMIT
    const count = parseExpression(this);
    return {
      kind: 'limit_clause',
      count,
      range: {start: startTok.range.start, end: count.range.end}
    };
  }

  private parseOffset(): OffsetClause {
    const startTok = this.consume(); // OFFSET
    const count = parseExpression(this);
    return {
      kind: 'offset_clause',
      count,
      range: {start: startTok.range.start, end: count.range.end}
    };
  }

  private parseProjection(): Projection {
    const startTok = this.peek();
    const items: ProjectionItem[] = [];
    items.push(this.parseProjectionItem());
    while (this.matchPunct(',')) {
      items.push(this.parseProjectionItem());
    }
    return {kind: 'projection', items, range: this.rangeFrom(startTok)};
  }

  private parseProjectionItem(): ProjectionItem {
    const startTok = this.peek();
    if (startTok.type === 'wildcard') {
      const tok = this.consume();
      const node: ProjectionWildcard = {kind: 'projection_wildcard', range: tok.range};
      return node;
    }
    const expression = parseExpression(this);
    // Optional AS alias (DDB doesn't support — walker flags in Task 4).
    let alias: ColumnAlias | undefined;
    if (this.peekKeyword('AS')) {
      const asTok = this.consume();
      const nameTok = this.peek();
      const isIdLike =
        nameTok.type === 'identifier' ||
        nameTok.type === 'quoted_identifier' ||
        (nameTok.type === 'keyword' && isIdentifierEligibleKeyword(nameTok.value));
      if (isIdLike) {
        const name = parseIdentifierToken(this);
        alias = {
          kind: 'column_alias',
          hasAsKeyword: true,
          name,
          range: {start: asTok.range.start, end: name.range.end}
        };
      } else {
        this.error('Expected identifier after AS', nameTok.range);
      }
    }
    const node: ProjectionExpression = {
      kind: 'projection_expression',
      expression,
      alias,
      range: this.rangeFrom(startTok)
    };
    return node;
  }

  // ===== FROM =====

  private parseFrom(): FromClause {
    const fromKw = this.consume(); // FROM
    const tableRef = this.parseTableReference();
    let joins: JoinClause[] | undefined;
    let lastEnd = tableRef.range.end;
    while (this.isJoinStart()) {
      const join = this.parseJoin();
      if (!joins) joins = [];
      joins.push(join);
      lastEnd = join.range.end;
    }
    return {
      kind: 'from_clause',
      source: tableRef,
      joins,
      range: {start: fromKw.range.start, end: lastEnd}
    };
  }

  private isJoinStart(): boolean {
    return this.peekKeyword('JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS');
  }

  private parseJoin(): JoinClause {
    const startTok = this.peek();
    let joinType: JoinClause['joinType'] = '';
    if (this.peekKeyword('INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS')) {
      joinType = this.consume().value.toUpperCase() as JoinClause['joinType'];
    }
    const outer = !!this.matchKeyword('OUTER');
    this.expectKeyword('JOIN');
    const table = this.parseTableReference();
    let on: Expression | undefined;
    let using: Array<Identifier | QuotedIdentifier> | undefined;
    if (this.matchKeyword('ON')) {
      on = parseExpression(this);
    } else if (this.matchKeyword('USING')) {
      this.expectPunct('(');
      using = [];
      if (!this.peekPunct(')')) {
        using.push(parseIdentifierToken(this));
        while (this.matchPunct(',')) {
          using.push(parseIdentifierToken(this));
        }
      }
      this.expectPunct(')');
    }
    return {
      kind: 'join_clause',
      joinType,
      outer,
      table,
      on,
      using,
      range: this.rangeFrom(startTok)
    };
  }

  private parseTableReference(): TableReference {
    const tableStartTok = this.peek();
    const table = parseIdentifierToken(this);
    let index: Identifier | QuotedIdentifier | undefined;
    if (this.peekPunct('.')) {
      this.consume();
      index = parseIdentifierToken(this);
    }
    return {
      kind: 'table_reference',
      table,
      index,
      range: {
        start: tableStartTok.range.start,
        end: index ? index.range.end : table.range.end
      }
    };
  }

  // ===== INSERT / UPDATE / DELETE =====

  private parseInsert(): InsertStatement {
    const startTok = this.consume(); // INSERT
    this.expectKeyword('INTO');
    const table = this.parseTableReference();
    this.expectKeyword('VALUE');
    const value = parseExpression(this);
    return {
      kind: 'insert_statement',
      table,
      value,
      range: this.rangeFrom(startTok)
    };
  }

  private parseUpdate(): UpdateStatement {
    const startTok = this.consume(); // UPDATE
    const table = this.parseTableReference();
    const assignments: UpdateAssignment[] = [];
    // Accept any number of SET / REMOVE clauses in source order. Each clause
    // can carry a comma-separated assignment list of its own:
    //   `SET a=1, b=2 REMOVE c, d SET e=3` — all flattened into `assignments`.
    while (this.peekKeyword('SET', 'REMOVE')) {
      const kw = this.consume();
      const isSet = kw.value.toUpperCase() === 'SET';
      assignments.push(this.parseAssignment(isSet));
      while (this.matchPunct(',')) {
        assignments.push(this.parseAssignment(isSet));
      }
    }
    if (assignments.length === 0) {
      this.error('Expected SET or REMOVE after UPDATE target', this.peek().range);
    }
    let where: WhereClause | undefined;
    if (this.peekKeyword('WHERE')) where = this.parseWhere();
    let returning: ReturningClause | undefined;
    if (this.peekKeyword('RETURNING')) returning = this.parseReturning();
    return {
      kind: 'update_statement',
      table,
      assignments,
      where,
      returning,
      range: this.rangeFrom(startTok)
    };
  }

  private parseAssignment(isSet: boolean): UpdateAssignment {
    const target = this.parseLValue();
    if (isSet) {
      // SET path = expr
      const eq = this.peek();
      if (eq.type !== 'operator' || eq.value !== '=') {
        this.error("Expected '=' after SET target", eq.range);
      } else {
        this.consume();
      }
      const value = parseExpression(this);
      const node: SetAssignment = {
        kind: 'set_assignment',
        target,
        value,
        range: {start: target.range.start, end: value.range.end}
      };
      return node;
    }
    const node: RemoveAssignment = {
      kind: 'remove_assignment',
      target,
      range: {start: target.range.start, end: target.range.end}
    };
    return node;
  }

  // Restricted form of a primary expression: identifier root + optional path
  // tail. Used for UPDATE SET/REMOVE targets where function calls / literals
  // are not legal lvalues.
  private parseLValue(): Expression {
    const root = parseIdentifierToken(this);
    return parsePathTail(this, root);
  }

  private parseDelete(): DeleteStatement {
    const startTok = this.consume(); // DELETE
    this.expectKeyword('FROM');
    const table = this.parseTableReference();
    let where: WhereClause | undefined;
    if (this.peekKeyword('WHERE')) where = this.parseWhere();
    let returning: ReturningClause | undefined;
    if (this.peekKeyword('RETURNING')) returning = this.parseReturning();
    return {
      kind: 'delete_statement',
      table,
      where,
      returning,
      range: this.rangeFrom(startTok)
    };
  }

  private parseReturning(): ReturningClause {
    const startTok = this.consume(); // RETURNING
    const first = this.matchKeyword('ALL', 'MODIFIED');
    if (!first) {
      this.error('Expected ALL or MODIFIED after RETURNING', this.peek().range);
      return {
        kind: 'returning_clause',
        mode: 'ALL OLD',
        range: this.rangeFrom(startTok)
      };
    }
    const second = this.matchKeyword('OLD', 'NEW');
    if (!second) {
      this.error(`Expected OLD or NEW after RETURNING ${first.value}`, this.peek().range);
      return {
        kind: 'returning_clause',
        mode: `${first.value.toUpperCase()} OLD` as ReturningClause['mode'],
        range: this.rangeFrom(startTok)
      };
    }
    const mode = `${first.value.toUpperCase()} ${second.value.toUpperCase()}` as
      'ALL OLD' | 'MODIFIED OLD' | 'ALL NEW' | 'MODIFIED NEW';
    // Literal `*` per AWS spec.
    const starTok = this.peek();
    if (starTok.type !== 'wildcard') {
      this.error("Expected '*' after RETURNING mode", starTok.range);
    } else {
      this.consume();
    }
    return {
      kind: 'returning_clause',
      mode,
      range: this.rangeFrom(startTok)
    };
  }

  // ===== WHERE =====

  private parseWhere(): WhereClause {
    const whereKw = this.consume(); // WHERE
    const condition = parseExpression(this);
    return {
      kind: 'where_clause',
      condition,
      range: {start: whereKw.range.start, end: condition.range.end}
    };
  }

  // ===== ORDER BY =====

  private parseOrderBy(): OrderByClause {
    const orderKw = this.consume(); // ORDER
    this.expectKeyword('BY');
    const items: OrderByItem[] = [];
    items.push(this.parseOrderByItem());
    while (this.matchPunct(',')) {
      items.push(this.parseOrderByItem());
    }
    return {
      kind: 'order_by_clause',
      items,
      range: {start: orderKw.range.start, end: items[items.length - 1].range.end}
    };
  }

  private parseOrderByItem(): OrderByItem {
    const startTok = this.peek();
    const key = parseExpression(this);
    let direction: 'ASC' | 'DESC' | undefined;
    if (this.matchKeyword('ASC')) direction = 'ASC';
    else if (this.matchKeyword('DESC')) direction = 'DESC';
    return {
      kind: 'order_by_item',
      key,
      direction,
      range: this.rangeFrom(startTok)
    };
  }
}
