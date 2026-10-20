# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-20

### Added

- One device per Backrest plan: state (OK, with warnings, failed, overdue,
  running, never run), last successful backup, hours since then, duration of
  the last backup, data it added, snapshots kept, errors and warnings, running,
  next scheduled backup.
- One device per repository (size, snapshots) and one for the instance (a
  backup running, its progress and plan, the number of plans failed and
  overdue).
- Scene triggers: a backup succeeds, a backup fails (errors, and warnings if
  chosen), a plan is overdue (from its schedule, cron included, or a fixed
  delay), for any plan.
- Scene actions: state of a plan (with a ready-made sentence), start a backup
  (can be disabled in the configuration).
- A dashboard widget: failed plans first, then the overdue ones, then the
  others.
- Backrest with or without authentication; texts in English, French, German
  and Spanish.

[Unreleased]: https://github.com/guim31/gladys-backrest/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-backrest/releases/tag/v1.0.0
