# Contributing

Standard pnpm workflow:

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm build       # tsdown (ESM + CJS + d.ts)
```

CI runs all of the above plus `publint` and `@arethetypeswrong/cli` on every PR.

## Fixtures

The spec corpus in `tests/fixtures/` pins parser behavior against the AWS
DynamoDB PartiQL reference. Each `<name>.partiql` fixture starts with a
`// SOURCE:` line (the AWS page the rule comes from) and a `// RULES:` line,
followed by the SQL under test; the golden expectation lives in the adjacent
`<name>.expected.json`. `fixtures/COVERAGE.md` maps every documented rule to
its fixture and the test suite fails if a fixture is missing from the table.

Adding a rule means: fixture + expected.json + a COVERAGE.md row. Changing
diagnostic wording means regenerating the affected expected.json files by
hand and reviewing the diff.
