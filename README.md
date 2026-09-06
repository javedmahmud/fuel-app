# Fuel Intelligence

A NSW fuel-price comparison web app. This repository is the code; the design and decision record
lives one level up, in **`claude-doco-v3/`** — start with `00_README.md` there if you're new to the
project. Nothing here should contradict that pack; if it does, the doc pack is stale and should be
fixed, not the other way around (dev-workflow rule: docs stay in sync with code).

## Architecture, in one line

Next.js web service (reads Postgres, never calls the upstream API directly) + a scheduled Node.js
worker (the only component that talks to the NSW Fuel API) + PostgreSQL, deployed on Railway. Full
reasoning in `claude-doco-v3/04_ARCHITECTURE_SUMMARY.md`.

## Layout

```
src/
  app/             Next.js App Router — presentation, no business rules
  application/     Use-case services — orchestration only
  domain/          Pure calculation engine — no I/O, no clock, no randomness
  infrastructure/  Repositories, Fuel API adapter, LLM adapter — behind interfaces
  worker/          Scheduled ingestion jobs — invoked as `node dist/worker.js <job>`
```

Strict dependency direction top-to-bottom, per `claude-doco-v3/04_ARCHITECTURE_SUMMARY.md` §4.3.
Most of these folders are still just a `README.md` explaining their purpose — they fill in as
Sprint 1's later branches (`feature/db-schema`, `feature/fuel-api-adapter`,
`feature/worker-scaffolding`) land.

## Getting started

```bash
npm install
cp .env.example .env   # fill in real values locally; .env is git-ignored, never commit it
npm run dev            # web, http://localhost:3000
```

## Scripts

| Script                 | What it does                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`          | Next.js dev server                                                             |
| `npm run build`        | Production build — web (`next build`) and worker (bundled to `dist/worker.js`) |
| `npm start`            | Serve the production web build                                                 |
| `npm run worker:start` | Run the built worker: `node dist/worker.js <job>`                              |
| `npm run lint`         | ESLint                                                                         |
| `npm run typecheck`    | `tsc --noEmit`                                                                 |
| `npm test`             | Vitest, single run                                                             |
| `npm run test:watch`   | Vitest, watch mode                                                             |
| `npm run format`       | Prettier, write                                                                |

## Branching

Two persistent branches — `main` (production) and `staging` (staging) — each auto-deployed by
Railway. All work happens on a `feature/<name>` branch cut from `staging`, PR'd back into it;
promotion to production is a separate `staging → main` PR, always a real merge commit (never
squash or rebase for that specific direction). Full model, including why, in
`claude-doco-v3/14_DEPLOYMENT.md` §14.1.1–§14.1.2.

## Before committing

A pre-commit hook (Husky) runs lint-staged (ESLint + Prettier on staged files) and a
[gitleaks](https://github.com/gitleaks/gitleaks) secret scan. Install gitleaks once, locally:

```bash
brew install gitleaks
```

CI (`.github/workflows/ci.yml`) re-runs the secret scan plus lint/typecheck/test/build on every PR
into `staging` or `main` — the pre-commit hook is the fast local check, CI is the one that's never
skippable.
