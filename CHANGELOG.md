# Changelog

All notable changes to AgentState are documented here.

## [0.2.0] — 2026-04-27

### Added

- `skill/scripts/scaffold.ts` — programmatic implementation of the `ScaffoldFolders` workflow. CLI: `bun scaffold.ts <instance-dir> --host=<host> --agent=<agent> [--strict]`. Hosts (e.g. `forge/agent/scaffold-instance.sh`) call it once during install to lay down the per-instance four-folder layout (`state.sqlite` + `dashboard.md` + `CLAUDE.md` + `context/` + `retros/`). Idempotent.
- `--strict` mode asserts every bundled migration file is present + non-empty before opening state.sqlite — protects against bundle-relocation breakage at runtime.
- `arc-manifest.yaml` now exposes `scaffold` under `provides.scripts[]` so hosts can resolve it via the standard arc bundle layout.

### Changed

- `lib/db.ts` — `getMigrationsDir()` and `listMigrationFiles()` extracted; `MF_MIGRATIONS_DIR_OVERRIDE` env hook flows through both `loadMigrations()` and the strict precheck (single source of truth).
- Re-running `scaffold` on an existing instance now reports any newly-applied migrations in the output (e.g. `state.sqlite present (applied 0002, 0003)`) instead of bare `(exists)`.

### Removed

- `--force-fallback` flag — was parsed but never read; removed per YAGNI.

### Notes

- `state.sqlite` is the canonical name (was `errands.sqlite` in the design doc; corrected to `state.sqlite` everywhere).
- Scaffold preserves operator-editable files (`CLAUDE.md`, `context/*.md`, `retros/`); `dashboard.md` is treated as derived — `RegenerateDashboard` workflow rebuilds it on event, so don't hand-edit.

## [0.1.0] — 2026-04-26

Initial MVP — schema, 8 workflows, 4 scripts, 70 tests. Released via PR #2 (`feat(as-001)`).
