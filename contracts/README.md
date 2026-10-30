# Trajectory Pro contracts

Executable contracts for the parts of Trajectory Pro that an implementation
other than the reference may provide: agent actions (and the outbound-only
relay), permissions, the audit trail, and configuration connectors.

Each contract is a `CONTRACT.md` with numbered clauses and a set of JSON
fixtures that a small, dependency-free Node runner plays against any
implementation over HTTP.

This README is a stub. The full guide (how to run, levels, outcomes, how to
add a target) is written in a later task.

## Layout

| Path | What it holds |
|---|---|
| `schema/contract-fixture-schema.json` | JSON Schema for a fixture |
| `schema/target-schema.json` | JSON Schema for a target profile |
| `runner/` | the runner (`node --test` runs its unit tests) |

## Licence

Copyright 2026 Athion, Inc. Licensed under the Apache License, Version 2.0.
