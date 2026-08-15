// Diagnostic + quick-fix shape emitted by the PartiQL parser and the
// `findUnsupportedConstructs` walker.
//
// Codes:
//   - 'partiql-parse-error'  : structural / lexer errors (severity: 'error')
//   - 'partiql-unsupported'  : syntactically valid but DDB-rejected constructs
//   - 'partiql-warning'      : advisory diagnostic (e.g. full-table-scan)
//   - 'partiql-quick-fix'    : informational diagnostic with a `QuickFix`
//                              payload the linter adapter maps to a
//                              CodeMirror Action.

import type {Range} from './lexer';

export const DIAGNOSTIC_CODES = {
  parseError: 'partiql-parse-error',
  unsupported: 'partiql-unsupported',
  warning: 'partiql-warning',
  quickFix: 'partiql-quick-fix'
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface QuickFix {
  label: string;
  edit: {start: number; end: number; text: string};
}

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  range: Range;
  severity?: DiagnosticSeverity;
  actions?: QuickFix[];
}
