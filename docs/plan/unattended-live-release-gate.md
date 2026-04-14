# Unattended Live Release Gate

Date: 2026-04-14

Current status: `NO-GO`

Unattended live is allowed only when validation, operations, and monitoring are all clean.

## 1. Decision Scorecard

| Gate | Minimum bar | Current status |
|---|---:|---|
| Holdout PF | `> 1.20` | `FAIL` |
| OOS PF | `> 1.10` | `FAIL` |
| Holdout trades | `>= 40` | `MIXED` |
| OOS trades | `>= 100` | `MIXED` |
| OOS MaxDD | `< 20%` | `MIXED` |
| Restart drills with open exposure | `>= 3 clean passes` | `FAIL` |
| Planned shutdown drills | `>= 3 clean passes` | `FAIL` |
| Ownership ambiguity after drills | `0 unresolved` | `FAIL` |
| Incident runbook + escalation | written and rehearsed | `FAIL` |

## 2. Current Blockers

- current validation evidence still collapses on holdout
- supervised-live drill evidence is not yet recorded as repeated clean passes
- incident handling exists as docs, but not yet as repeated evidence

## 3. Fail-Fast Rules

Automatic `NO-GO` if any of these are true:

- holdout PF `<= 1.0`
- holdout trades `< 40`
- OOS PF `< 1.0`
- unresolved ownership ambiguity during restart drills
- repeated manual rescue in supervised live
- exchange-sync blindness that needs repeated manual intervention

## 4. Evidence Format

When you reassess the gate, use the unified evidence template:

- [Evidence Capture Template](./evidence-capture-template.md)

## 5. Supporting Docs

- [Supervised Live Operator Sheet](./supervised-live-operator-sheet.md)
- [Supervised Live Runbook](./supervised-live-runbook.md)
- [Go-Live Checklist](./go-live-checklist.md)
