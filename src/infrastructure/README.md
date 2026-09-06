# Infrastructure layer

Repositories, the Fuel API adapter, the LLM adapter, the notifier — everything behind an interface,
per `04_ARCHITECTURE_SUMMARY.md` §4.3.

Subfolders land as their branches do:

- `db/` — Drizzle schema, client, migrations (`feature/db-schema`)
- `fuel-api/` — OAuth token manager, HTTP client, retry/backoff, response journal, budget guard,
  key fingerprinting (`feature/fuel-api-adapter` — see `21_DETAILED_DESIGN.md` §21.2 for the
  confirmed real request shape)
- `repositories/` — read/write access to Postgres for the application layer
