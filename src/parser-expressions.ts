// Expression parser for the DynamoDB PartiQL subset.
//
// Implemented as free functions taking a `PartiqlParser` instance so the
// recursive-descent state (pos, tokens, source, diagnostics) is shared with
// the statement-level parser without inflating a single `parser.ts` past the
// 1000-line max-lines budget.
//
// Precedence ladder (lowest → highest):
//   OR > AND > NOT > comparison > BETWEEN/IN/LIKE/IS > additive >
//   multiplicative > unary > primary.

import type {PartiqlParser} from './parser';
import type {Token} from './lexer';
import type {
  BagLiteral,
  BetweenExpression,
  BinaryExpression,
  BooleanLiteral,
  CaseExpression,
  CaseWhenBranch,
  CastExpression,
  ErrorExpression,
  Expression,
  FunctionArg,
  FunctionCall,
  Identifier,
  IndexAccess,
  InExpression,
  IsMissingExpression,
  IsNullExpression,
  LikeExpression,
  ListLiteral,
  MemberAccess,
  MissingLiteral,
  NullLiteral,
  NumberLiteral,
  ObjectEntry,
  ObjectLiteral,
  ParameterExpression,
  ParenExpression,
  ParenList,
  PathExpression,
  PathStep,
  QuotedIdentifier,
  StringLiteral,
  UnaryExpression,
  WildcardArg,
  WindowSpec
} from './cst';
import type {Range} from './lexer';

const COMPARISON_OPERATORS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);

// Keywords whose uppercase value the lexer flags as `keyword` but which can
// legally appear as bare attribute / table / function names. Two DDB common
// cases drive this: `SELECT value FROM t` and `WHERE order = 'x'` — both
// clean under the legacy regex linter, but the new parser would otherwise
// reject `value` / `order` / `group` etc. as `Expected expression, got 'X'`.
//
// Hard-reserved (excluded — structural to the expression grammar and core
// statement / clause boundaries): SELECT, FROM, WHERE, INSERT, UPDATE,
// DELETE; boolean / comparison operators (AND, OR, NOT, IS, IN, LIKE,
// BETWEEN, AS); CASE internals (CASE, WHEN, THEN, ELSE, END, CAST, CONVERT);
// ORDER-BY tail (BY, ASC, DESC); JOIN tail (ON, USING). Everything else in
// the lexer's KEYWORDS set is accepted as a bare identifier in identifier
// positions — peekKeyword still recognises clause keywords at clause
// boundaries (it checks token type, not whether the caller treats the
// keyword as an identifier elsewhere), so this doesn't break clause
// detection.
const IDENTIFIER_ELIGIBLE_KEYWORDS = new Set([
  'VALUE',
  'ORDER',
  'GROUP',
  'TABLE',
  'INDEX',
  'PARTITION',
  'NEW',
  'OLD',
  'MODIFIED',
  'RETURNING',
  'ALL',
  'TOP',
  'OFFSET',
  'LIMIT',
  'DISTINCT',
  'WITH',
  'OVER',
  'OUTER',
  'RECURSIVE',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'JOIN',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'HAVING',
  'INTO',
  'SET',
  'REMOVE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE'
]);

export function isIdentifierEligibleKeyword(value: string): boolean {
  return IDENTIFIER_ELIGIBLE_KEYWORDS.has(value.toUpperCase());
}

function isIdentifierStartToken(tok: Token): boolean {
  if (tok.type === 'identifier' || tok.type === 'quoted_identifier') return true;
  return tok.type === 'keyword' && isIdentifierEligibleKeyword(tok.value);
}

export function parseExpression(p: PartiqlParser): Expression {
  if (!p.enterExpr()) {
    p.leaveExpr();
    const t = p.peek();
    p.error('Expression is too deeply nested', t.range);
    const placeholder: ErrorExpression = {kind: 'error_expression', range: t.range};
    return placeholder;
  }
  try {
    return parseOr(p);
  } finally {
    p.leaveExpr();
  }
}

function parseOr(p: PartiqlParser): Expression {
  let left = parseAnd(p);
  while (p.matchKeyword('OR')) {
    const right = parseAnd(p);
    const node: BinaryExpression = {
      kind: 'binary_expression',
      operator: 'OR',
      left,
      right,
      range: {start: left.range.start, end: right.range.end}
    };
    left = node;
  }
  return left;
}

function parseAnd(p: PartiqlParser): Expression {
  let left = parseNot(p);
  while (p.matchKeyword('AND')) {
    const right = parseNot(p);
    const node: BinaryExpression = {
      kind: 'binary_expression',
      operator: 'AND',
      left,
      right,
      range: {start: left.range.start, end: right.range.end}
    };
    left = node;
  }
  return left;
}

function parseNot(p: PartiqlParser): Expression {
  // Iterative, not recursive: `NOT NOT NOT …` from a pathological paste would
  // otherwise overflow the stack (this path never re-enters parseExpression,
  // so the depth guard there can't see it).
  const notToks: Token[] = [];
  let notTok = p.matchKeyword('NOT');
  while (notTok) {
    notToks.push(notTok);
    notTok = p.matchKeyword('NOT');
  }
  let node = parseComparison(p);
  for (let k = notToks.length - 1; k >= 0; k--) {
    const t = notToks[k];
    const wrapped: UnaryExpression = {
      kind: 'unary_expression',
      operator: 'NOT',
      argument: node,
      range: {start: t.range.start, end: node.range.end}
    };
    node = wrapped;
  }
  return node;
}

function parseComparison(p: PartiqlParser): Expression {
  let left = parseBetweenInLike(p);
  // Left-associative chaining: `a = b = c` parses as `(a = b) = c` instead of
  // hard-erroring on the second operator (which the legacy regex linter never
  // flagged — non-chaining here was a parity regression that also cascaded
  // into a spurious "multi-statement" error via recovery).
  while (p.peekOperator(...COMPARISON_OPERATORS)) {
    const opTok = p.consume();
    const right = parseBetweenInLike(p);
    const node: BinaryExpression = {
      kind: 'binary_expression',
      operator: opTok.value,
      left,
      right,
      range: {start: left.range.start, end: right.range.end}
    };
    left = node;
  }
  return left;
}

function parseBetweenInLike(p: PartiqlParser): Expression {
  const left = parseAdditive(p);
  let negated = false;
  if (p.peekKeyword('NOT')) {
    const next = p.peek(1);
    if (next?.type === 'keyword' && ['BETWEEN', 'IN', 'LIKE'].includes(next.value.toUpperCase())) {
      p.consume();
      negated = true;
    }
  }
  if (p.matchKeyword('BETWEEN')) return parseBetweenTail(p, left, negated);
  if (p.matchKeyword('IN')) return parseInTail(p, left, negated);
  if (p.matchKeyword('LIKE')) return parseLikeTail(p, left, negated);
  if (p.matchKeyword('IS')) return parseIsTail(p, left);
  return left;
}

function parseBetweenTail(p: PartiqlParser, test: Expression, negated: boolean): BetweenExpression {
  const lower = parseAdditive(p);
  p.expectKeyword('AND');
  const upper = parseAdditive(p);
  return {
    kind: 'between_expression',
    negated,
    test,
    lower,
    upper,
    range: {start: test.range.start, end: upper.range.end}
  };
}

function parseInTail(p: PartiqlParser, test: Expression, negated: boolean): InExpression {
  const peekTok = p.peek();
  let source: ListLiteral | ParenList;
  if (p.peekPunct('[')) {
    source = parseListLiteral(p);
  } else if (p.peekPunct('(')) {
    // `IN (SELECT …)` is a subquery, not a list. Wrap as a ParenList with a
    // single SubqueryExpression item so the walker emits both diagnostics.
    const lookahead = p.peek(1);
    if (lookahead?.type === 'keyword' && lookahead.value.toUpperCase() === 'SELECT') {
      const openTok = p.consume();
      const select = p.parseSelect();
      const closeTok = p.expectPunct(')');
      const subqueryEnd = closeTok ? closeTok.range.end : select.range.end;
      source = {
        kind: 'paren_list',
        items: [
          {
            kind: 'subquery_expression',
            select,
            range: {start: openTok.range.start, end: subqueryEnd}
          }
        ],
        range: {start: openTok.range.start, end: subqueryEnd}
      };
    } else {
      const parenList = parseParenList(p);
      source = parenList;
      p.quickFix('DynamoDB PartiQL uses bracket list literals: IN [...]', parenList.range, {
        label: 'Use brackets',
        edit: {
          start: parenList.range.start,
          end: parenList.range.end,
          text: `[${p.source.slice(parenList.range.start + 1, parenList.range.end - 1)}]`
        }
      });
    }
  } else {
    p.error('Expected [ or ( after IN', peekTok.range);
    source = {
      kind: 'list_literal',
      items: [],
      range: {start: peekTok.range.start, end: peekTok.range.start}
    };
  }
  return {
    kind: 'in_expression',
    negated,
    test,
    source,
    range: {start: test.range.start, end: source.range.end}
  };
}

function parseLikeTail(p: PartiqlParser, test: Expression, negated: boolean): LikeExpression {
  const pattern = parseAdditive(p);
  return {
    kind: 'like_expression',
    negated,
    test,
    pattern,
    range: {start: test.range.start, end: pattern.range.end}
  };
}

function parseIsTail(p: PartiqlParser, test: Expression): Expression {
  const negated = !!p.matchKeyword('NOT');
  const nullTok = p.match((t) => t.type === 'null');
  if (nullTok) {
    const node: IsNullExpression = {
      kind: 'is_null_expression',
      negated,
      test,
      range: {start: test.range.start, end: nullTok.range.end}
    };
    return node;
  }
  const missingTok = p.match((t) => t.type === 'missing');
  if (missingTok) {
    const node: IsMissingExpression = {
      kind: 'is_missing_expression',
      negated,
      test,
      range: {start: test.range.start, end: missingTok.range.end}
    };
    return node;
  }
  const cur = p.peek();
  p.error('Expected NULL or MISSING after IS', cur.range);
  return makeErrorExpression(cur.range);
}

function parseAdditive(p: PartiqlParser): Expression {
  let left = parseMultiplicative(p);
  while (p.peekOperator('+', '-', '||')) {
    const opTok = p.consume();
    const right = parseMultiplicative(p);
    const node: BinaryExpression = {
      kind: 'binary_expression',
      operator: opTok.value,
      left,
      right,
      range: {start: left.range.start, end: right.range.end}
    };
    left = node;
  }
  return left;
}

function parseMultiplicative(p: PartiqlParser): Expression {
  let left = parseUnary(p);
  while (p.peekOperator('/', '%') || p.peek().type === 'wildcard') {
    // `*` in binary-arithmetic position is accepted-then-flagged.
    const opTok = p.consume();
    const right = parseUnary(p);
    const node: BinaryExpression = {
      kind: 'binary_expression',
      operator: opTok.value === '*' ? '*' : opTok.value,
      left,
      right,
      range: {start: left.range.start, end: right.range.end}
    };
    left = node;
  }
  return left;
}

function parseUnary(p: PartiqlParser): Expression {
  // Iterative, not recursive: `- - - - …1` / `+ + + …1` chains from a
  // pathological paste would otherwise overflow the stack (this path never
  // re-enters parseExpression, so the depth guard there can't see it —
  // mirrors the iterative treatment in parseNot / parseParenChain).
  const ops: Token[] = [];
  while (p.peekOperator('-', '+')) {
    ops.push(p.consume());
  }
  let node = parsePrimary(p);
  for (let k = ops.length - 1; k >= 0; k--) {
    const opTok = ops[k];
    const wrapped: UnaryExpression = {
      kind: 'unary_expression',
      operator: opTok.value,
      argument: node,
      range: {start: opTok.range.start, end: node.range.end}
    };
    node = wrapped;
  }
  return node;
}

function parsePrimary(p: PartiqlParser): Expression {
  const tok = p.peek();
  if (tok.type === 'parameter') {
    p.consume();
    const node: ParameterExpression = {kind: 'parameter', range: tok.range};
    return node;
  }
  if (tok.type === 'null') {
    p.consume();
    const node: NullLiteral = {kind: 'null_literal', range: tok.range};
    return node;
  }
  if (tok.type === 'missing') {
    // `MISSING(x)` is the AWS-canonical function form for attribute_not_exists;
    // bare `MISSING` is the literal. Disambiguate via 1-token lookahead.
    const lookahead = p.peek(1);
    if (lookahead?.type === 'punct' && lookahead.value === '(') {
      p.consume();
      const fnName: Identifier = {kind: 'identifier', name: tok.value, range: tok.range};
      return parseFunctionCall(p, fnName);
    }
    p.consume();
    const node: MissingLiteral = {kind: 'missing_literal', range: tok.range};
    return node;
  }
  if (tok.type === 'bool') {
    p.consume();
    const node: BooleanLiteral = {
      kind: 'boolean_literal',
      value: tok.value.toUpperCase() === 'TRUE',
      range: tok.range
    };
    return node;
  }
  if (tok.type === 'string') {
    p.consume();
    const node: StringLiteral = {
      kind: 'string_literal',
      value: tok.text ?? '',
      raw: tok.value,
      range: tok.range
    };
    return node;
  }
  if (tok.type === 'number') {
    p.consume();
    const node: NumberLiteral = {
      kind: 'number_literal',
      value: tok.value,
      range: tok.range
    };
    return node;
  }
  if (tok.type === 'keyword') {
    const kw = tok.value.toUpperCase();
    if (kw === 'CASE') return parseCase(p);
    if (kw === 'CAST' || kw === 'CONVERT') return parseCast(p);
  }
  if (tok.type === 'punct' && tok.value === '(') return parseParenChain(p);
  if (tok.type === 'punct' && tok.value === '[') {
    const chain = tryParseFlatListChain(p);
    if (chain) return chain;
    return parseListLiteral(p);
  }
  if (tok.type === 'punct' && tok.value === '{') {
    const chain = tryParseFlatObjectChain(p);
    if (chain) return chain;
    return parseObjectLiteral(p);
  }
  if (tok.type === 'punct' && tok.value === '<<') return parseBagLiteral(p);
  if (isIdentifierStartToken(tok)) {
    return parseIdentifierOrCall(p);
  }
  p.error(`Expected expression, got '${tok.value || tok.type}'`, tok.range);
  if (!p.isEof()) p.consume();
  return makeErrorExpression(tok.range);
}

// Iteratively strip leading `(` so a pathological `((((…))))` chain doesn't
// recurse through the full precedence ladder per level. If the innermost `(`
// wraps a SELECT, emit a SubqueryExpression instead.
function parseParenChain(p: PartiqlParser): Expression {
  const opens: Token[] = [];
  while (p.peekPunct('(')) {
    opens.push(p.consume());
    if (p.peekKeyword('SELECT')) break;
  }
  let inner: Expression;
  if (p.peekKeyword('SELECT')) {
    const select = p.parseSelect();
    const closeTok = p.expectPunct(')');
    const innermostOpen = opens.pop();
    inner = {
      kind: 'subquery_expression',
      select,
      range: {
        start: innermostOpen ? innermostOpen.range.start : select.range.start,
        end: closeTok ? closeTok.range.end : select.range.end
      }
    };
  } else {
    inner = parseExpression(p);
  }
  for (let k = opens.length - 1; k >= 0; k--) {
    const closeTok = p.expectPunct(')');
    const wrapped: ParenExpression = {
      kind: 'paren_expression',
      expression: inner,
      range: {
        start: opens[k].range.start,
        end: closeTok ? closeTok.range.end : inner.range.end
      }
    };
    inner = wrapped;
  }
  return inner;
}

function parseCase(p: PartiqlParser): CaseExpression {
  const startTok = p.consume();
  const whenBranches: CaseWhenBranch[] = [];
  while (p.peekKeyword('WHEN')) {
    const whenTok = p.consume();
    const condition = parseExpression(p);
    p.expectKeyword('THEN');
    const result = parseExpression(p);
    whenBranches.push({
      kind: 'case_when_branch',
      condition,
      result,
      range: {start: whenTok.range.start, end: result.range.end}
    });
  }
  let elseBranch: Expression | undefined;
  if (p.matchKeyword('ELSE')) elseBranch = parseExpression(p);
  const endTok = p.matchKeyword('END');
  if (!endTok) p.error('Expected END after CASE expression', p.peek().range);
  return {
    kind: 'case_expression',
    whenBranches,
    elseBranch,
    range: {
      start: startTok.range.start,
      end: endTok ? endTok.range.end : p.tokens[Math.max(p.pos - 1, 0)].range.end
    }
  };
}

function parseCast(p: PartiqlParser): CastExpression {
  const startTok = p.consume();
  const command = startTok.value.toUpperCase() as CastExpression['command'];
  p.expectPunct('(');
  const source = parseExpression(p);
  let targetType: Identifier | QuotedIdentifier | undefined;
  if (p.matchKeyword('AS') || p.matchPunct(',')) {
    const next = p.peek();
    if (
      next.type === 'identifier' ||
      next.type === 'quoted_identifier' ||
      next.type === 'keyword'
    ) {
      if (next.type === 'keyword') {
        p.consume();
        targetType = {kind: 'identifier', name: next.value, range: next.range};
      } else {
        targetType = parseIdentifierToken(p);
      }
    } else {
      p.error('Expected target type', next.range);
    }
  }
  const closeTok = p.expectPunct(')');
  return {
    kind: 'cast_expression',
    command,
    source,
    targetType,
    range: {
      start: startTok.range.start,
      end: closeTok ? closeTok.range.end : source.range.end
    }
  };
}

function parseParenList(p: PartiqlParser): ParenList {
  const openTok = p.consume();
  const items: Expression[] = [];
  if (!p.peekPunct(')')) {
    items.push(parseExpression(p));
    while (p.matchPunct(',')) items.push(parseExpression(p));
  }
  const closeTok = p.expectPunct(')');
  return {
    kind: 'paren_list',
    items,
    range: {start: openTok.range.start, end: closeTok ? closeTok.range.end : openTok.range.end}
  };
}

function parseListLiteral(p: PartiqlParser): ListLiteral {
  const openTok = p.consume();
  const items: Expression[] = [];
  if (!p.peekPunct(']')) {
    items.push(parseExpression(p));
    while (p.matchPunct(',')) items.push(parseExpression(p));
  }
  const closeTok = p.expectPunct(']');
  return {
    kind: 'list_literal',
    items,
    range: {start: openTok.range.start, end: closeTok ? closeTok.range.end : openTok.range.end}
  };
}

// `[[[…1]]]` from a pathological paste nests one list per `[`/`]` pair. Without
// flattening, each level re-enters `parseExpression` and blows the stack long
// before `MAX_EXPR_DEPTH` can bail (the guard itself needs stack headroom).
// Mirrors `parseParenChain` / iterative `parseNot`.
function tryParseFlatListChain(p: PartiqlParser): ListLiteral | null {
  const startPos = p.pos;
  const opens: Token[] = [];
  while (p.peekPunct('[')) opens.push(p.consume());
  if (opens.length < 2) {
    p.pos = startPos;
    return null;
  }
  const inner = parseExpression(p);
  for (let i = 0; i < opens.length; i++) {
    if (!p.matchPunct(']')) {
      p.pos = startPos;
      return null;
    }
  }
  let node: Expression = inner;
  for (let k = opens.length - 1; k >= 0; k--) {
    const openTok = opens[k];
    node = {
      kind: 'list_literal',
      items: [node],
      range: {start: openTok.range.start, end: node.range.end}
    };
  }
  return node as ListLiteral;
}

function parseObjectLiteral(p: PartiqlParser): ObjectLiteral {
  const openTok = p.consume();
  const entries: ObjectEntry[] = [];
  if (!p.peekPunct('}')) {
    entries.push(parseObjectEntry(p));
    while (p.matchPunct(',')) entries.push(parseObjectEntry(p));
  }
  const closeTok = p.expectPunct('}');
  return {
    kind: 'object_literal',
    entries,
    range: {start: openTok.range.start, end: closeTok ? closeTok.range.end : openTok.range.end}
  };
}

function tryParseFlatObjectChain(p: PartiqlParser): ObjectLiteral | null {
  const startPos = p.pos;
  const opens: Token[] = [];
  const keys: StringLiteral[] = [];
  while (p.peekPunct('{')) {
    opens.push(p.consume());
    const keyTok = p.peek();
    if (keyTok.type !== 'string') break;
    p.consume();
    keys.push({
      kind: 'string_literal',
      value: keyTok.text ?? '',
      raw: keyTok.value,
      range: keyTok.range
    });
    if (!p.matchPunct(':')) break;
    if (!p.peekPunct('{')) break;
  }
  if (opens.length < 2 || keys.length !== opens.length) {
    p.pos = startPos;
    return null;
  }
  const inner = parseExpression(p);
  for (let i = 0; i < opens.length; i++) {
    if (!p.matchPunct('}')) {
      p.pos = startPos;
      return null;
    }
  }
  let node: Expression = inner;
  for (let k = opens.length - 1; k >= 0; k--) {
    const openTok = opens[k];
    const key = keys[k];
    const entry: ObjectEntry = {
      kind: 'object_entry',
      key,
      value: node,
      range: {start: key.range.start, end: node.range.end}
    };
    node = {
      kind: 'object_literal',
      entries: [entry],
      range: {start: openTok.range.start, end: node.range.end}
    };
  }
  return node as ObjectLiteral;
}

function parseObjectEntry(p: PartiqlParser): ObjectEntry {
  const keyTok = p.peek();
  let key: StringLiteral;
  if (keyTok.type === 'string') {
    p.consume();
    key = {
      kind: 'string_literal',
      value: keyTok.text ?? '',
      raw: keyTok.value,
      range: keyTok.range
    };
  } else {
    p.error('Expected single-quoted string key in object literal', keyTok.range);
    if (!p.isEof()) p.consume();
    key = {kind: 'string_literal', value: '', raw: '', range: keyTok.range};
  }
  p.expectPunct(':');
  const value = parseExpression(p);
  return {
    kind: 'object_entry',
    key,
    value,
    range: {start: key.range.start, end: value.range.end}
  };
}

function parseBagLiteral(p: PartiqlParser): BagLiteral {
  const openTok = p.consume();
  const items: Expression[] = [];
  if (!p.peekPunct('>>')) {
    items.push(parseExpression(p));
    while (p.matchPunct(',')) items.push(parseExpression(p));
  }
  const closeTok = p.expectPunct('>>');
  return {
    kind: 'bag_literal',
    items,
    range: {start: openTok.range.start, end: closeTok ? closeTok.range.end : openTok.range.end}
  };
}

function parseIdentifierOrCall(p: PartiqlParser): Expression {
  const root = parseIdentifierToken(p);
  if (p.peekPunct('(')) return parseFunctionCall(p, root);
  return parsePathTail(p, root);
}

function parseFunctionCall(p: PartiqlParser, name: Identifier | QuotedIdentifier): FunctionCall {
  const fnName: Identifier = {kind: 'identifier', name: name.name, range: name.range};
  const openTok = p.consume();
  const args: FunctionArg[] = [];
  if (!p.peekPunct(')')) {
    args.push(parseFunctionArg(p));
    while (p.matchPunct(',')) args.push(parseFunctionArg(p));
  }
  const closeTok = p.expectPunct(')');
  let over: WindowSpec | undefined;
  if (p.peekKeyword('OVER')) over = parseOver(p);
  return {
    kind: 'function_call',
    name: fnName,
    args,
    over,
    range: {
      start: name.range.start,
      end: over ? over.range.end : closeTok ? closeTok.range.end : openTok.range.end
    }
  };
}

// OVER (...) — DDB rejects window functions; consume the parenthesised body
// wholesale so a partial OVER doesn't poison the rest of the statement.
function parseOver(p: PartiqlParser): WindowSpec {
  const startTok = p.consume();
  p.expectPunct('(');
  let depth = 1;
  let lastTok = startTok;
  while (!p.isEof() && depth > 0) {
    const t = p.peek();
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (depth === 0) {
        lastTok = p.consume();
        break;
      }
    }
    lastTok = p.consume();
  }
  return {kind: 'window_spec', range: {start: startTok.range.start, end: lastTok.range.end}};
}

export function parseFunctionArg(p: PartiqlParser): FunctionArg {
  if (p.peek().type === 'wildcard') {
    const tok = p.consume();
    const node: WildcardArg = {kind: 'wildcard_arg', range: tok.range};
    return node;
  }
  return parseExpression(p);
}

export function parsePathTail(p: PartiqlParser, root: Identifier | QuotedIdentifier): Expression {
  const steps: PathStep[] = [];
  while (true) {
    if (p.peekPunct('.')) {
      p.consume();
      const propTok = p.peek();
      if (!isIdentifierStartToken(propTok)) {
        p.error('Expected identifier after .', propTok.range);
        break;
      }
      const property = parseIdentifierToken(p);
      const step: MemberAccess = {
        kind: 'member_access',
        property,
        range: {start: property.range.start, end: property.range.end}
      };
      steps.push(step);
      continue;
    }
    if (p.peekPunct('[')) {
      const openTok = p.consume();
      const index = parseExpression(p);
      const closeTok = p.expectPunct(']');
      const step: IndexAccess = {
        kind: 'index_access',
        index,
        range: {
          start: openTok.range.start,
          end: closeTok ? closeTok.range.end : index.range.end
        }
      };
      steps.push(step);
      continue;
    }
    break;
  }
  if (steps.length === 0) return root;
  const path: PathExpression = {
    kind: 'path_expression',
    root,
    steps,
    range: {start: root.range.start, end: steps[steps.length - 1].range.end}
  };
  return path;
}

export function parseIdentifierToken(p: PartiqlParser): Identifier | QuotedIdentifier {
  const tok = p.peek();
  if (tok.type === 'identifier') {
    p.consume();
    return {kind: 'identifier', name: tok.value, range: tok.range};
  }
  if (tok.type === 'quoted_identifier') {
    p.consume();
    return {
      kind: 'quoted_identifier',
      name: tok.text ?? '',
      raw: tok.value,
      range: tok.range
    };
  }
  // Soft-reserved keyword in identifier position — e.g. `INSERT INTO Value`,
  // `SELECT a.order`, `UPDATE t SET value = 1`. Legacy regex linter never
  // flagged these; preserve parity by accepting as a bare identifier.
  if (tok.type === 'keyword' && isIdentifierEligibleKeyword(tok.value)) {
    p.consume();
    return {kind: 'identifier', name: tok.value, range: tok.range};
  }
  p.error('Expected identifier', tok.range);
  if (!p.isEof()) p.consume();
  return {kind: 'identifier', name: '', range: tok.range};
}

export function makeErrorExpression(range: Range): ErrorExpression {
  return {kind: 'error_expression', range};
}
