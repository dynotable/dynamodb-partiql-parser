// One-call linting entry point: parse + DynamoDB-unsupported walk behind a
// throw guard. Mirrors the editor-adapter contract the parser was built for —
// a linter typically runs on every keystroke with no error sink, so `lint()`
// must never throw. `parse()` is designed never to throw on any input, and
// `findUnsupportedConstructs()` never throws on real-world queries, but a
// pathologically nested adversarial paste (tens of thousands of nesting
// levels) can exhaust the call stack in the walker; that case degrades to a
// single generic parse-error diagnostic instead of an exception.
//
// Callers that want the pieces (the CST, statement kinds, custom filtering)
// should use `parse()` + `findUnsupportedConstructs()` directly and decide
// their own error posture.

import {DIAGNOSTIC_CODES, type Diagnostic} from './emit';
import {parse} from './parser';
import {findUnsupportedConstructs} from './unsupported';

/**
 * Lint a PartiQL string against the DynamoDB dialect: structural parse
 * diagnostics plus every DynamoDB-unsupported construct, each carrying its
 * source range and (where available) quick-fix edits. Never throws.
 */
export function lint(text: string): Diagnostic[] {
  try {
    const {cst, diagnostics: parseDiagnostics} = parse(text);
    // Drop the parser's informational `IN (...)` quick-fix: the unsupported
    // walker re-emits the same construct as a proper error, so keeping both
    // would double-report it.
    const structural = parseDiagnostics.filter((d) => d.code !== DIAGNOSTIC_CODES.quickFix);
    return [...structural, ...findUnsupportedConstructs(cst, text)];
  } catch {
    return [
      {
        code: DIAGNOSTIC_CODES.parseError,
        message: 'Could not parse this PartiQL statement.',
        range: {start: 0, end: text.length},
        severity: 'error'
      }
    ];
  }
}
