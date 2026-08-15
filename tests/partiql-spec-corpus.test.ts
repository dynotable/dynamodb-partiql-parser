import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  findUnsupportedConstructs,
  parse,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity
} from '../src';

// AWS DynamoDB PartiQL spec corpus. Each `*.partiql` fixture is a `//`-headed
// (SOURCE + RULES) file followed by the SQL under test; its golden expectation
// lives in the adjacent `<name>.expected.json`. The COVERAGE.md table is a hard
// gate — every AWS-documented rule must map to an existing fixture.

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

interface ExpectedDiagnostic {
  code?: DiagnosticCode;
  messageIncludes: string;
  severity?: DiagnosticSeverity;
}

interface Expected {
  source: string;
  rules: string[];
  statementKind?: string;
  clean?: boolean;
  expect?: ExpectedDiagnostic[];
  quickFix?: {label: string; applied: string};
}

function splitFixture(raw: string): {source: string; query: string} {
  const lines = raw.split('\n');
  let i = 0;
  let source = '';
  while (i < lines.length && lines[i].startsWith('//')) {
    const m = lines[i].match(/^\/\/\s*SOURCE:\s*(.+)$/);
    if (m) source = m[1].trim();
    i++;
  }
  // Drop blank lines between header and query, keep the query verbatim.
  while (i < lines.length && lines[i].trim() === '') i++;
  return {source, query: lines.slice(i).join('\n').replace(/\n+$/, '')};
}

function lint(query: string): Diagnostic[] {
  const {cst, diagnostics} = parse(query);
  return [...diagnostics, ...findUnsupportedConstructs(cst, query)];
}

function applyFirstAction(query: string, label: string, diagnostics: Diagnostic[]): string {
  for (const d of diagnostics) {
    const action = d.actions?.find((a) => a.label === label);
    if (action) {
      const {start, end, text} = action.edit;
      return query.slice(0, start) + text + query.slice(end);
    }
  }
  throw new Error(`no quick-fix action labelled "${label}" found`);
}

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.partiql'))
  .map((f) => f.replace(/\.partiql$/, ''))
  .sort();

describe('PartiQL AWS-spec corpus', () => {
  it('should have at least 50 fixtures to run', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(50);
  });

  for (const name of fixtureNames) {
    it(`should match golden expectation for fixture: ${name}`, () => {
      const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.partiql`), 'utf8');
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES_DIR, `${name}.expected.json`), 'utf8')
      ) as Expected;
      const {source, query} = splitFixture(raw);

      // Header SOURCE must agree with the golden file (traceability gate).
      expect(source, `${name}: // SOURCE header`).toBe(expected.source);

      const result = parse(query);
      const diagnostics = lint(query);

      if (expected.statementKind) {
        expect(result.cst.statements[0]?.kind, `${name}: first statement kind`).toBe(
          expected.statementKind
        );
      }

      if (expected.clean) {
        const blocking = diagnostics.filter(
          (d) =>
            d.code === 'partiql-unsupported' ||
            (d.code === 'partiql-parse-error' && d.severity === 'error')
        );
        expect(
          blocking,
          `${name}: expected clean parse, got ${JSON.stringify(blocking.map((d) => d.message))}`
        ).toEqual([]);
      }

      for (const exp of expected.expect ?? []) {
        const hit = diagnostics.find(
          (d) =>
            (exp.code === undefined || d.code === exp.code) &&
            (exp.severity === undefined || d.severity === exp.severity) &&
            d.message.includes(exp.messageIncludes)
        );
        expect(
          hit,
          `${name}: expected diagnostic ${JSON.stringify(exp)}; got ${JSON.stringify(
            diagnostics.map((d) => ({code: d.code, severity: d.severity, message: d.message}))
          )}`
        ).toBeDefined();
      }

      if (expected.quickFix) {
        const rewritten = applyFirstAction(query, expected.quickFix.label, diagnostics);
        expect(rewritten, `${name}: quick-fix "${expected.quickFix.label}" output`).toBe(
          expected.quickFix.applied
        );
      }
    });
  }
});

describe('PartiQL AWS-spec corpus — COVERAGE.md gate', () => {
  const coverage = readFileSync(path.join(FIXTURES_DIR, 'COVERAGE.md'), 'utf8');
  const fixtureSet = new Set(fixtureNames);

  // Every `[fixture-name](./fixture-name.partiql)` reference in a table row.
  const refRe = /\[([a-z0-9-]+)\]\(\.\/([a-z0-9-]+)\.partiql\)/g;
  const referenced = new Set<string>();
  for (const m of coverage.matchAll(refRe)) {
    expect(m[1], 'COVERAGE link text must equal target fixture').toBe(m[2]);
    referenced.add(m[2]);
  }

  // Every rule row (| `rule` | ... |) must reference ≥1 existing fixture.
  const ruleRowRe = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(.+?)\s*\|$/gm;
  const ruleRows = [...coverage.matchAll(ruleRowRe)];

  it('should have at least 50 rule rows', () => {
    expect(ruleRows.length).toBeGreaterThanOrEqual(50);
  });

  for (const [, rule, cell] of ruleRows) {
    it(`should map rule "${rule}" to an existing fixture`, () => {
      const refs = [...cell.matchAll(/\[([a-z0-9-]+)\]/g)].map((m) => m[1]);
      expect(refs.length, `rule "${rule}" lists no fixture`).toBeGreaterThan(0);
      for (const r of refs) {
        expect(fixtureSet.has(r), `rule "${rule}" → missing fixture "${r}"`).toBe(true);
      }
    });
  }

  it('should reference every fixture in COVERAGE.md', () => {
    const orphans = fixtureNames.filter((n) => !referenced.has(n));
    expect(orphans, `fixtures absent from COVERAGE.md: ${orphans.join(', ')}`).toEqual([]);
  });
});
