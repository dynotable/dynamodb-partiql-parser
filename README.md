# dynamodb-partiql-parser

A PartiQL parser and linter for DynamoDB, in pure TypeScript with zero dependencies.

DynamoDB accepts a narrow subset of PartiQL. Everything else fails at request time with a `ValidationException`, after you've already sent the statement. This package parses the full grammar, then tells you before execution which constructs DynamoDB will reject: JOIN, GROUP BY, LIMIT, OFFSET, subqueries, CASE WHEN, CAST, aggregates, SQL-only functions, and a few dozen more. Where a rewrite exists, diagnostics carry a machine-applicable quick fix (`IN (...)` to `[...]`, `LIKE` to `contains()`, `IS NULL` to `attribute_not_exists()`).

It was built for the query editor in [DynoTable](https://dynotable.com), where it lints on every keystroke. The parser is a hand-written lexer and recursive-descent CST parser: error-tolerant, no stack overflows on adversarial input, no grammar files, no build step surprises. 448 unit tests and a 200+ fixture corpus derived from the AWS PartiQL reference pin its behavior.

As of August 2026, the other PartiQL parsers on npm are WASM builds of AWS's Rust implementation, and nothing on the registry knows what DynamoDB rejects. That gap is why this exists.

## Install

```sh
npm install dynamodb-partiql-parser
```

ESM and CJS, browser-safe, no Node-only APIs.

## Thirty seconds

```ts
import {lint} from 'dynamodb-partiql-parser';

const diagnostics = lint(`SELECT * FROM "Orders" GROUP BY status`);

for (const d of diagnostics) {
  console.log(d.severity, d.message, d.range);
  // error  GROUP BY is not supported by DynamoDB PartiQL.  {start: 23, end: 38}
}
```

`lint()` never throws. It returns structural parse errors plus every DynamoDB-unsupported construct, each with a source range and, where possible, quick-fix edits.

## API

| Export | What it does |
| --- | --- |
| `lint(text)` | Parse + DynamoDB-dialect check in one call. Returns `Diagnostic[]`. Never throws. |
| `parse(text)` | Full parse. Returns `{cst, diagnostics}` with the complete CST, error-tolerant. |
| `findUnsupportedConstructs(cst, text)` | The DynamoDB-dialect walker on its own, for use with `parse`. |
| `tokenize(text)` | The lexer on its own. Returns tokens with ranges. |
| `isKeyword(word)` | PartiQL keyword check. |
| `DIAGNOSTIC_CODES` | The diagnostic code constants (`partiql-parse-error`, `partiql-unsupported`, `partiql-warning`, `partiql-quick-fix`). |

All CST node types (`SelectStatement`, `InsertStatement`, `Expression`, and the rest) and the `Diagnostic` / `QuickFix` shapes are exported as types. The full generated reference lives at [dynotable.github.io/dynamodb-partiql-parser](https://dynotable.github.io/dynamodb-partiql-parser/).

### Diagnostics and quick fixes

```ts
interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  range: {start: number; end: number}; // character offsets into the input
  severity?: 'error' | 'warning' | 'info';
  actions?: QuickFix[];
}

interface QuickFix {
  label: string; // e.g. `Replace with contains(name, 'value')`
  edit: {start: number; end: number; text: string};
}
```

Applying a fix is a string splice:

```ts
const fixed = text.slice(0, fix.edit.start) + fix.edit.text + text.slice(fix.edit.end);
```

### Walking the CST

```ts
import {parse} from 'dynamodb-partiql-parser';

const {cst} = parse(`UPDATE "Users" SET active = false WHERE id = 'u1'`);
const stmt = cst.statements[0];

if (stmt.kind === 'update_statement') {
  // typed access to assignments, WHERE clause, ranges
  console.log(stmt.assignments.length);
}
```

The CST keeps source ranges on every node, so it works for editor tooling, codemods, and query analysis, not just validation.

### Gating writes

```ts
import {parse} from 'dynamodb-partiql-parser';

const {cst} = parse(text);
const kind = cst.statements[0]?.kind;
const isWrite = kind === 'insert_statement' || kind === 'update_statement' || kind === 'delete_statement';
```

Useful when an editor auto-executes read statements but requires confirmation for writes. If you use CodeMirror, [codemirror-lang-partiql](https://github.com/dynotable/codemirror-lang-partiql) packages this pattern as `canAutoExecutePartiQL()`.

## What gets flagged

The dialect walker covers the DynamoDB PartiQL restrictions documented in the [AWS PartiQL reference](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.html): unsupported clauses (JOIN, GROUP BY, HAVING, LIMIT, OFFSET, DISTINCT, TOP, UNION and other set ops, WITH/CTE, OVER), unsupported expressions (CASE WHEN, CAST/CONVERT, subqueries, arithmetic `*` `/` `%` `||`, paren-list IN), SQL functions DynamoDB doesn't have (with the DynamoDB replacement suggested where one exists), DDL, multi-statement scripts, aliasing rules, quoting conventions, and full-table-scan warnings for SELECTs whose WHERE can't use a key. Each rule cites the construct in its message.

## Relationship to the editor

This is the same parser that runs inside DynoTable's PartiQL editor; the app consumes it with a thin CodeMirror adapter. If you want the editor wiring instead of the raw parser, use [codemirror-lang-partiql](https://github.com/dynotable/codemirror-lang-partiql). For a walkthrough of DynamoDB's PartiQL dialect itself, see the [DynamoDB PartiQL guide](https://dynotable.com/learn/dynamodb-partiql-examples).

## License

MIT © [DynoTable](https://dynotable.com)
