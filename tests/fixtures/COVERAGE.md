# AWS DynamoDB PartiQL — Spec Coverage Matrix

Every AWS-documented PartiQL rule below maps to at least one corpus fixture in
this directory. `partiql-spec-corpus.test.ts` FAILS if any rule row has no
existing fixture, so this table is a hard coverage gate, not documentation.

AWS sources:

- SELECT — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html
- INSERT — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.insert.html
- UPDATE — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.update.html
- DELETE — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.delete.html
- Functions — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-functions.html
- Operators — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.operators.html

## SELECT grammar

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule                              | Fixture(s)                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `select-star`                     | [select-star](./select-star.partiql)                                         |
| `select-projection-list`          | [select-projection-list](./select-projection-list.partiql)                   |
| `select-document-path-projection` | [select-document-path-projection](./select-document-path-projection.partiql) |
| `from-quoted-table-index`         | [select-from-quoted-index](./select-from-quoted-index.partiql)               |
| `where-pk-sk-equality`            | [select-where-pk-sk](./select-where-pk-sk.partiql)                           |
| `where-in-bracket-list`           | [select-where-in-bracket](./select-where-in-bracket.partiql)                 |
| `order-by-asc`                    | [select-order-by-asc](./select-order-by-asc.partiql)                         |
| `order-by-desc`                   | [select-order-by-desc](./select-order-by-desc.partiql)                       |
| `order-by-sortkey-only`           | [select-order-by-sortkey-only](./select-order-by-sortkey-only.partiql)       |
| `select-where-no-key-full-scan`   | [select-full-scan-warning](./select-full-scan-warning.partiql)               |

## INSERT grammar

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.insert.html)

| Rule                  | Fixture(s)                                           |
| --------------------- | ---------------------------------------------------- |
| `insert-value-object` | [insert-value-object](./insert-value-object.partiql) |
| `insert-nested-value` | [insert-nested-value](./insert-nested-value.partiql) |
| `insert-parameter`    | [insert-parameter](./insert-parameter.partiql)       |

## UPDATE grammar

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.update.html)

| Rule                            | Fixture(s)                                                               |
| ------------------------------- | ------------------------------------------------------------------------ |
| `update-set-single`             | [update-set-single](./update-set-single.partiql)                         |
| `update-set-multiple`           | [update-set-multiple](./update-set-multiple.partiql)                     |
| `update-set-nested-path`        | [update-set-nested-path](./update-set-nested-path.partiql)               |
| `update-remove`                 | [update-remove](./update-remove.partiql)                                 |
| `update-returning-all-old`      | [update-returning-all-old](./update-returning-all-old.partiql)           |
| `update-returning-modified-old` | [update-returning-modified-old](./update-returning-modified-old.partiql) |
| `update-returning-all-new`      | [update-returning-all-new](./update-returning-all-new.partiql)           |
| `update-returning-modified-new` | [update-returning-modified-new](./update-returning-modified-new.partiql) |
| `update-where-composite-key`    | [update-where-composite](./update-where-composite.partiql)               |
| `fn-list-append`                | [update-list-append](./update-list-append.partiql)                       |
| `fn-set-add`                    | [update-set-add-bag](./update-set-add-bag.partiql)                       |
| `fn-set-delete`                 | [update-set-delete](./update-set-delete.partiql)                         |

## DELETE grammar

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.delete.html)

| Rule                  | Fixture(s)                                           |
| --------------------- | ---------------------------------------------------- |
| `delete-single-pk`    | [delete-single-pk](./delete-single-pk.partiql)       |
| `delete-composite-pk` | [delete-composite-pk](./delete-composite-pk.partiql) |
| `delete-returning`    | [delete-returning](./delete-returning.partiql)       |

## Operators (supported)

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.operators.html)

| Rule                 | Fixture(s)                                                     |
| -------------------- | -------------------------------------------------------------- |
| `op-equality`        | [op-equality](./op-equality.partiql)                           |
| `op-not-equal-angle` | [op-not-equal-angle](./op-not-equal-angle.partiql)             |
| `op-not-equal-bang`  | [op-not-equal-bang](./op-not-equal-bang.partiql)               |
| `op-gt`              | [op-comparison](./op-comparison.partiql)                       |
| `op-lt`              | [op-comparison](./op-comparison.partiql)                       |
| `op-gte`             | [op-comparison](./op-comparison.partiql)                       |
| `op-lte`             | [op-comparison](./op-comparison.partiql)                       |
| `op-and`             | [op-and-or-not](./op-and-or-not.partiql)                       |
| `op-or`              | [op-and-or-not](./op-and-or-not.partiql)                       |
| `op-not`             | [op-and-or-not](./op-and-or-not.partiql)                       |
| `op-between`         | [select-where-between](./select-where-between.partiql)         |
| `op-arith-plus`      | [op-arithmetic-plus-minus](./op-arithmetic-plus-minus.partiql) |
| `op-arith-minus`     | [op-arithmetic-plus-minus](./op-arithmetic-plus-minus.partiql) |
| `op-is-missing`      | [op-is-missing](./op-is-missing.partiql)                       |
| `op-is-not-missing`  | [op-is-not-missing](./op-is-not-missing.partiql)               |

## Operators (unsupported)

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.operators.html)

| Rule                    | Fixture(s)                                               |
| ----------------------- | -------------------------------------------------------- |
| `op-unsupported-star`   | [op-unsupported-star](./op-unsupported-star.partiql)     |
| `op-unsupported-slash`  | [op-unsupported-slash](./op-unsupported-slash.partiql)   |
| `op-unsupported-modulo` | [op-unsupported-modulo](./op-unsupported-modulo.partiql) |
| `op-unsupported-concat` | [op-unsupported-concat](./op-unsupported-concat.partiql) |

## Functions (supported)

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-functions.html)

| Rule                      | Fixture(s)                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `fn-size`                 | [fn-canonical](./fn-canonical.partiql)                         |
| `fn-exists`               | [fn-canonical](./fn-canonical.partiql)                         |
| `fn-attribute-type`       | [fn-canonical](./fn-canonical.partiql)                         |
| `fn-begins-with`          | [fn-canonical](./fn-canonical.partiql)                         |
| `fn-contains`             | [fn-canonical](./fn-canonical.partiql)                         |
| `fn-missing`              | [fn-missing-canonical](./fn-missing-canonical.partiql)         |
| `fn-attribute-exists`     | [fn-conditionexpr-aliases](./fn-conditionexpr-aliases.partiql) |
| `fn-attribute-not-exists` | [fn-conditionexpr-aliases](./fn-conditionexpr-aliases.partiql) |

## Functions (unsupported)

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-functions.html)

| Rule                              | Fixture(s)                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `fn-unsupported-string`           | [fn-unsupported-upper](./fn-unsupported-upper.partiql)                       |
| `fn-unsupported-aggregate-select` | [fn-unsupported-aggregate-select](./fn-unsupported-aggregate-select.partiql) |
| `fn-unsupported-aggregate-where`  | [fn-unsupported-aggregate-where](./fn-unsupported-aggregate-where.partiql)   |
| `fn-bare-exists-quickfix`         | [fn-bare-exists-quickfix](./fn-bare-exists-quickfix.partiql)                 |
| `fn-bare-missing-quickfix`        | [fn-bare-missing-quickfix](./fn-bare-missing-quickfix.partiql)               |

## Literals

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule                    | Fixture(s)                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `literal-string-escape` | [lit-string-escape](./lit-string-escape.partiql)                                                                                                   |
| `literal-integer`       | [lit-numbers](./lit-numbers.partiql)                                                                                                               |
| `literal-decimal`       | [lit-numbers](./lit-numbers.partiql)                                                                                                               |
| `literal-scientific`    | [lit-numbers](./lit-numbers.partiql)                                                                                                               |
| `literal-bool`          | [lit-bool-null](./lit-bool-null.partiql)                                                                                                           |
| `literal-null`          | [lit-bool-null](./lit-bool-null.partiql)                                                                                                           |
| `literal-parameter`     | [insert-parameter](./insert-parameter.partiql), [lit-parameter](./lit-parameter.partiql)                                                           |
| `literal-bag`           | [update-set-add-bag](./update-set-add-bag.partiql), [lit-bag](./lit-bag.partiql)                                                                   |
| `literal-list`          | [select-where-in-bracket](./select-where-in-bracket.partiql), [insert-nested-value](./insert-nested-value.partiql), [lit-list](./lit-list.partiql) |
| `literal-map`           | [insert-nested-value](./insert-nested-value.partiql), [lit-map-nested](./lit-map-nested.partiql)                                                   |
| `literal-nested-combo`  | [lit-map-nested](./lit-map-nested.partiql)                                                                                                         |

## Document paths

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule          | Fixture(s)                           |
| ------------- | ------------------------------------ |
| `path-simple` | [path-simple](./path-simple.partiql) |
| `path-member` | [path-member](./path-member.partiql) |
| `path-index`  | [path-index](./path-index.partiql)   |
| `path-deep`   | [path-deep](./path-deep.partiql)     |

## IN cardinality

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule                     | Fixture(s)                                 |
| ------------------------ | ------------------------------------------ |
| `in-cardinality-50`      | [in-50-pk](./in-50-pk.partiql)             |
| `in-cardinality-100`     | [in-100-nonkey](./in-100-nonkey.partiql)   |
| `in-cardinality-warning` | [in-101-warning](./in-101-warning.partiql) |

## Table identifiers

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule                  | Fixture(s)                                       |
| --------------------- | ------------------------------------------------ |
| `table-bare`          | [tbl-bare](./tbl-bare.partiql)                   |
| `table-quoted`        | [tbl-quoted](./tbl-quoted.partiql)               |
| `table-quoted-dotted` | [tbl-quoted-dotted](./tbl-quoted-dotted.partiql) |
| `table-bare-dotted`   | [tbl-bare-dotted](./tbl-bare-dotted.partiql)     |

## Comments

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule            | Fixture(s)                               |
| --------------- | ---------------------------------------- |
| `comment-line`  | [comment-line](./comment-line.partiql)   |
| `comment-block` | [comment-block](./comment-block.partiql) |

## Unsupported constructs

[AWS source](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html)

| Rule                              | Fixture(s)                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `unsupported-join`                | [unsupported-join](./unsupported-join.partiql)                               |
| `unsupported-inner-join`          | [unsupported-inner-join](./unsupported-inner-join.partiql)                   |
| `unsupported-left-join`           | [unsupported-left-join](./unsupported-left-join.partiql)                     |
| `unsupported-cross-join`          | [unsupported-cross-join](./unsupported-cross-join.partiql)                   |
| `unsupported-with-cte`            | [unsupported-with-cte](./unsupported-with-cte.partiql)                       |
| `unsupported-with-recursive`      | [unsupported-with-recursive](./unsupported-with-recursive.partiql)           |
| `unsupported-subquery`            | [unsupported-subquery](./unsupported-subquery.partiql)                       |
| `unsupported-multi-statement`     | [unsupported-multi-statement](./unsupported-multi-statement.partiql)         |
| `unsupported-group-by`            | [unsupported-group-by](./unsupported-group-by.partiql)                       |
| `unsupported-having`              | [unsupported-having](./unsupported-having.partiql)                           |
| `unsupported-union`               | [unsupported-union](./unsupported-union.partiql)                             |
| `unsupported-intersect`           | [unsupported-intersect](./unsupported-intersect.partiql)                     |
| `unsupported-except`              | [unsupported-except](./unsupported-except.partiql)                           |
| `unsupported-window-over`         | [unsupported-window-over](./unsupported-window-over.partiql)                 |
| `unsupported-limit`               | [unsupported-limit](./unsupported-limit.partiql)                             |
| `unsupported-offset`              | [unsupported-offset](./unsupported-offset.partiql)                           |
| `unsupported-distinct`            | [unsupported-distinct](./unsupported-distinct.partiql)                       |
| `unsupported-top-n`               | [unsupported-top-n](./unsupported-top-n.partiql)                             |
| `unsupported-ddl-create`          | [unsupported-ddl-create](./unsupported-ddl-create.partiql)                   |
| `unsupported-ddl-drop`            | [unsupported-ddl-drop](./unsupported-ddl-drop.partiql)                       |
| `unsupported-ddl-alter`           | [unsupported-ddl-alter](./unsupported-ddl-alter.partiql)                     |
| `unsupported-ddl-truncate`        | [unsupported-ddl-truncate](./unsupported-ddl-truncate.partiql)               |
| `unsupported-case-when`           | [unsupported-case-when](./unsupported-case-when.partiql)                     |
| `unsupported-cast`                | [unsupported-cast](./unsupported-cast.partiql)                               |
| `unsupported-convert`             | [unsupported-convert](./unsupported-convert.partiql)                         |
| `unsupported-as-alias`            | [unsupported-as-alias](./unsupported-as-alias.partiql)                       |
| `unsupported-missing-from`        | [unsupported-missing-from](./unsupported-missing-from.partiql)               |
| `unsupported-in-paren-list`       | [unsupported-in-paren-list](./unsupported-in-paren-list.partiql)             |
| `unsupported-like-substring`      | [unsupported-like-substring](./unsupported-like-substring.partiql)           |
| `unsupported-like-prefix`         | [unsupported-like-prefix](./unsupported-like-prefix.partiql)                 |
| `unsupported-like-suffix`         | [unsupported-like-suffix](./unsupported-like-suffix.partiql)                 |
| `unsupported-is-null`             | [unsupported-is-null](./unsupported-is-null.partiql)                         |
| `unsupported-is-not-null`         | [unsupported-is-not-null](./unsupported-is-not-null.partiql)                 |
| `unsupported-double-quoted-value` | [unsupported-double-quoted-value](./unsupported-double-quoted-value.partiql) |
