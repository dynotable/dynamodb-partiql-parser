// CST node types for the DynamoDB PartiQL parser.
//
// Every node carries a `range: {start, end}` byte-offset pair so diagnostics
// can map straight onto CodeMirror.
//
// Task 2 introduces the SELECT-statement subset (program, projection, FROM,
// WHERE, ORDER BY, full expression tree, list literals, function calls, paths).
// Task 3 extends with INSERT/UPDATE/DELETE. Task 4 adds the accept-then-flag
// productions (JOIN, GROUP BY, subquery, CASE, CAST, LIMIT, OFFSET, DISTINCT,
// DDL, etc.) plus AS-column-alias.

import type {Range} from './lexer';

export type {Range};

export interface BaseNode {
  range: Range;
}

// Program -- the top-level CST node.
export interface Program extends BaseNode {
  kind: 'program';
  statements: Statement[];
}

export type Statement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | DdlStatement
  | ErrorStatement;

// ---------- SELECT ----------

export interface SelectStatement extends BaseNode {
  kind: 'select_statement';
  // Range of the `SELECT` keyword token itself. Distinct from `range`, which
  // a WITH prefix widens to start at `WITH` — diagnostics that want to point
  // at the SELECT keyword (full-scan / missing-FROM) must use this.
  selectKeyword: Range;
  // WITH/CTE prefix (DDB-unsupported, accept-then-flag).
  withClause?: WithClause;
  // DDB doesn't support DISTINCT/TOP/LIMIT/OFFSET/GROUP BY/HAVING/set ops —
  // each is parsed into a marker node so the walker can flag with the right
  // range. Joins live on the FROM clause.
  distinct?: DistinctMarker;
  top?: TopClause;
  projection: Projection;
  from?: FromClause;
  where?: WhereClause;
  groupBy?: GroupByClause;
  having?: HavingClause;
  orderBy?: OrderByClause;
  limit?: LimitClause;
  offset?: OffsetClause;
  setOps?: SetOpClause[];
}

export interface Projection extends BaseNode {
  kind: 'projection';
  items: ProjectionItem[];
}

export type ProjectionItem = ProjectionWildcard | ProjectionExpression;

export interface ProjectionWildcard extends BaseNode {
  kind: 'projection_wildcard';
}

export interface ProjectionExpression extends BaseNode {
  kind: 'projection_expression';
  expression: Expression;
  alias?: ColumnAlias;
}

export interface ColumnAlias extends BaseNode {
  kind: 'column_alias';
  // AS keyword is optional in some SQL dialects but DDB PartiQL doesn't
  // support either form; the walker flags column aliases regardless.
  hasAsKeyword: boolean;
  name: Identifier | QuotedIdentifier;
}

// ---------- INSERT ----------

export interface InsertStatement extends BaseNode {
  kind: 'insert_statement';
  table: TableReference;
  // Per AWS spec: `INSERT INTO <table> VALUE <expr>` where the expression is
  // typically an object literal, but `?` (parameter) is also legal.
  value: Expression;
}

// ---------- UPDATE ----------

export interface UpdateStatement extends BaseNode {
  kind: 'update_statement';
  table: TableReference;
  // Flat list of SET/REMOVE operations in source order. Parser accepts any
  // mix of `SET path = expr (, path = expr)*` and `REMOVE path (, path)*`
  // clauses (multiple of each allowed in sequence).
  assignments: UpdateAssignment[];
  where?: WhereClause;
  returning?: ReturningClause;
}

export type UpdateAssignment = SetAssignment | RemoveAssignment;

export interface SetAssignment extends BaseNode {
  kind: 'set_assignment';
  target: Expression;
  value: Expression;
}

export interface RemoveAssignment extends BaseNode {
  kind: 'remove_assignment';
  target: Expression;
}

// ---------- DELETE ----------

export interface DeleteStatement extends BaseNode {
  kind: 'delete_statement';
  table: TableReference;
  where?: WhereClause;
  returning?: ReturningClause;
}

// ---------- RETURNING ----------

export interface ReturningClause extends BaseNode {
  kind: 'returning_clause';
  mode: 'ALL OLD' | 'MODIFIED OLD' | 'ALL NEW' | 'MODIFIED NEW';
}

// ---------- FROM ----------

export interface FromClause extends BaseNode {
  kind: 'from_clause';
  source: TableReference;
  // JOINs are DDB-unsupported but the parser collects them so the walker can
  // emit a per-JOIN diagnostic with its own range.
  joins?: JoinClause[];
}

export interface JoinClause extends BaseNode {
  kind: 'join_clause';
  // Raw keyword sequence preceding JOIN: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'
  // | 'CROSS' | '' (bare JOIN). 'OUTER' (when present) is stored separately.
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | '';
  outer: boolean;
  table: TableReference;
  on?: Expression;
  // Identifier list for USING (col, col, ...).
  using?: Array<Identifier | QuotedIdentifier>;
}

export interface TableReference extends BaseNode {
  kind: 'table_reference';
  table: Identifier | QuotedIdentifier;
  index?: Identifier | QuotedIdentifier;
}

// ---------- WHERE ----------

export interface WhereClause extends BaseNode {
  kind: 'where_clause';
  condition: Expression;
}

// ---------- ORDER BY ----------

export interface OrderByClause extends BaseNode {
  kind: 'order_by_clause';
  items: OrderByItem[];
}

export interface OrderByItem extends BaseNode {
  kind: 'order_by_item';
  key: Expression;
  direction?: 'ASC' | 'DESC';
}

// ---------- Expressions ----------

export type Expression =
  | Identifier
  | QuotedIdentifier
  | PathExpression
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | MissingLiteral
  | ParameterExpression
  | FunctionCall
  | ParenExpression
  | UnaryExpression
  | BinaryExpression
  | BetweenExpression
  | InExpression
  | LikeExpression
  | IsNullExpression
  | IsMissingExpression
  | ListLiteral
  | ParenList
  | ObjectLiteral
  | BagLiteral
  | CaseExpression
  | CastExpression
  | SubqueryExpression
  | ErrorExpression;

export interface Identifier extends BaseNode {
  kind: 'identifier';
  name: string;
}

export interface QuotedIdentifier extends BaseNode {
  kind: 'quoted_identifier';
  name: string;
  raw: string;
}

export interface PathExpression extends BaseNode {
  kind: 'path_expression';
  root: Identifier | QuotedIdentifier;
  steps: PathStep[];
}

export type PathStep = MemberAccess | IndexAccess;

export interface MemberAccess extends BaseNode {
  kind: 'member_access';
  property: Identifier | QuotedIdentifier;
}

export interface IndexAccess extends BaseNode {
  kind: 'index_access';
  index: Expression;
}

export interface StringLiteral extends BaseNode {
  kind: 'string_literal';
  value: string;
  raw: string;
  // True when the source token was a double-quoted identifier used in a
  // value-position (e.g. `WHERE x = "abc"`). The walker flags these.
  doubleQuoted?: boolean;
}

export interface NumberLiteral extends BaseNode {
  kind: 'number_literal';
  value: string;
}

export interface BooleanLiteral extends BaseNode {
  kind: 'boolean_literal';
  value: boolean;
}

export interface NullLiteral extends BaseNode {
  kind: 'null_literal';
}

export interface MissingLiteral extends BaseNode {
  kind: 'missing_literal';
}

export interface ParameterExpression extends BaseNode {
  kind: 'parameter';
}

export interface FunctionCall extends BaseNode {
  kind: 'function_call';
  name: Identifier;
  args: FunctionArg[];
  // OVER(...) suffix — flagged by the walker (window functions unsupported).
  over?: WindowSpec;
}

export interface WindowSpec extends BaseNode {
  kind: 'window_spec';
}

export type FunctionArg = Expression | WildcardArg;

export interface WildcardArg extends BaseNode {
  kind: 'wildcard_arg';
}

export interface ParenExpression extends BaseNode {
  kind: 'paren_expression';
  expression: Expression;
}

export interface UnaryExpression extends BaseNode {
  kind: 'unary_expression';
  // 'NOT' | '-' | '+'
  operator: string;
  argument: Expression;
}

export interface BinaryExpression extends BaseNode {
  kind: 'binary_expression';
  // '=', '<>', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '||',
  // 'AND', 'OR'
  operator: string;
  left: Expression;
  right: Expression;
}

export interface BetweenExpression extends BaseNode {
  kind: 'between_expression';
  negated: boolean;
  test: Expression;
  lower: Expression;
  upper: Expression;
}

export interface InExpression extends BaseNode {
  kind: 'in_expression';
  negated: boolean;
  test: Expression;
  // Bracket-list is the legal DDB form; paren-list parses but the walker
  // emits a quick-fix.
  source: ListLiteral | ParenList;
}

export interface LikeExpression extends BaseNode {
  kind: 'like_expression';
  negated: boolean;
  test: Expression;
  pattern: Expression;
}

export interface IsNullExpression extends BaseNode {
  kind: 'is_null_expression';
  negated: boolean;
  test: Expression;
}

export interface IsMissingExpression extends BaseNode {
  kind: 'is_missing_expression';
  negated: boolean;
  test: Expression;
}

export interface ListLiteral extends BaseNode {
  kind: 'list_literal';
  items: Expression[];
}

// `IN (a, b)` — parses but the walker flags it.
export interface ParenList extends BaseNode {
  kind: 'paren_list';
  items: Expression[];
}

export interface ObjectLiteral extends BaseNode {
  kind: 'object_literal';
  entries: ObjectEntry[];
}

export interface ObjectEntry extends BaseNode {
  kind: 'object_entry';
  key: StringLiteral;
  value: Expression;
}

export interface BagLiteral extends BaseNode {
  kind: 'bag_literal';
  items: Expression[];
}

// ---------- Accept-then-flag CST nodes (DDB-unsupported constructs) ----------
//
// These nodes carry just enough structure for the walker to emit a per-occurrence
// diagnostic with the correct range. The parser still consumes the tokens so a
// downstream tool sees a coherent CST instead of a generic syntax error.

export interface DistinctMarker extends BaseNode {
  kind: 'distinct_marker';
}

export interface TopClause extends BaseNode {
  kind: 'top_clause';
  count: Expression;
}

export interface LimitClause extends BaseNode {
  kind: 'limit_clause';
  count: Expression;
}

export interface OffsetClause extends BaseNode {
  kind: 'offset_clause';
  count: Expression;
}

export interface GroupByClause extends BaseNode {
  kind: 'group_by_clause';
  items: Expression[];
}

export interface HavingClause extends BaseNode {
  kind: 'having_clause';
  condition: Expression;
}

export interface SetOpClause extends BaseNode {
  kind: 'set_op_clause';
  operator: 'UNION' | 'INTERSECT' | 'EXCEPT';
  all: boolean;
  right: SelectStatement | ErrorStatement;
}

export interface WithClause extends BaseNode {
  kind: 'with_clause';
  recursive: boolean;
  entries: CteEntry[];
}

export interface CteEntry extends BaseNode {
  kind: 'cte_entry';
  name: Identifier | QuotedIdentifier;
  body: SelectStatement | ErrorStatement;
}

export interface DdlStatement extends BaseNode {
  kind: 'ddl_statement';
  command: 'CREATE' | 'DROP' | 'ALTER' | 'TRUNCATE';
}

export interface CastExpression extends BaseNode {
  kind: 'cast_expression';
  command: 'CAST' | 'CONVERT';
  source: Expression;
  // The target-type identifier; e.g. `CAST(x AS INTEGER)` → 'INTEGER'.
  targetType?: Identifier | QuotedIdentifier;
}

export interface CaseExpression extends BaseNode {
  kind: 'case_expression';
  whenBranches: CaseWhenBranch[];
  elseBranch?: Expression;
}

export interface CaseWhenBranch extends BaseNode {
  kind: 'case_when_branch';
  condition: Expression;
  result: Expression;
}

export interface SubqueryExpression extends BaseNode {
  kind: 'subquery_expression';
  select: SelectStatement | ErrorStatement;
}

// ---------- Error sentinel nodes (recovery) ----------

export interface ErrorStatement extends BaseNode {
  kind: 'error_statement';
}

export interface ErrorExpression extends BaseNode {
  kind: 'error_expression';
}
