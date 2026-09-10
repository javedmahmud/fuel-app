# Domain layer

The portable core — see `04_ARCHITECTURE_SUMMARY.md` §4.3 in the doc pack.

Rules, enforced in code review, not just here:

- **No I/O.** No database, no HTTP, no filesystem access.
- **No clock.** `now` is always a parameter, never `Date.now()` read internally — see
  `09_CALCULATION_ENGINE.md`. A hidden clock read makes freshness tests non-deterministic.
- **No randomness**, for the same reason.
- Depends on nothing above it. Only plain data in, plain data out.

This is what makes the calculation engine exhaustively testable with Vitest + golden fixtures, and
what keeps it portable if the platform ever changes (`14_DEPLOYMENT.md` Appendix A).

Populated starting in `feature/fuel-api-adapter` and the calculation-engine work that follows it —
this file exists so the layering is real in the repo from day one, not just in the docs.
