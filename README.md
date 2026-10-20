# Backrest for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the plans and repositories of
[Backrest](https://github.com/garethgeorge/backrest), the web interface of
[restic](https://restic.net/), into Gladys: their state, and an alert when a
backup fails or stops running.

- **One device per plan**: state (OK, with warnings, failed, overdue, running,
  never run), last successful backup, hours since then, duration of the last
  backup, data it added, snapshots kept, errors and warnings, running, next
  scheduled backup.
- **One device per repository**: its size and its snapshots.
- **One instance device**: a backup running, its progress and plan, the number
  of plans failed and overdue.
- **Scene triggers**: a backup succeeds, a backup fails (errors, and warnings
  if chosen), a plan is overdue (no success for longer than its schedule, cron
  included, or a fixed delay) — for any plan, added to Gladys or not.
- **Scene actions**: state of a plan (with a ready-made sentence), start a
  backup (can be disabled in the configuration).
- **Dashboard widget**: failed plans first, then the overdue ones, then the
  others.
- Texts in English, French, German and Spanish.

Tested against a real Backrest 1.14.1 (Docker image `garethgeorge/backrest`, a
local restic repository): a backup that succeeds, one whose folder is missing,
one with an unreadable file, a backup started from the integration, with and
without authentication. Not yet tested on a real Gladys: feedback welcome on
[the issues](https://github.com/guim31/gladys-backrest/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- Backrest 1.x, its web interface reachable from the Gladys machine (port 9898
  by default, `BACKREST_PORT=0.0.0.0:9898` outside Docker), and a user when
  its authentication is enabled.

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-backrest`. Then open its configuration,
enter the address of Backrest (and a username and password if its
authentication is enabled), and add the plans from the Discover tab.

The full guide: [docs/en.md](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

The container calls the Connect API of Backrest (`/v1.Backrest/GetConfig`,
`GetOperations` per plan, the full history of each repository once an hour,
`Backup`), with HTTP Basic authentication when Backrest has users, every 5
minutes by default and every 30 seconds while a backup runs. It publishes the
states of the devices added to Gladys when they change, and fires the scene
events on the new backups and on the plans turning overdue. The last backup
seen of each plan is kept in `/data`, so a backup that failed during a restart
is announced once. The repository passwords present in the Backrest
configuration are dropped as soon as it is read, and redirects are not
followed.

## Limits

- One Backrest instance per configuration; plans of synced instances are not
  shown.
- The repository size comes from the last "stats" operation of Backrest.
- The integration watches plans and starts backups; it does not restore,
  prune or edit anything.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the
Backrest API.

## Credits

- [Backrest](https://github.com/garethgeorge/backrest) by Gareth George and
  its contributors (GPL-3.0): the API answers in `test/fixtures/backrest` come
  from its Docker image, and the names of its API from its `proto/` files. The
  logo on the cover is the Backrest logo, from its repository.
- [restic](https://restic.net/) (BSD-2-Clause), which Backrest drives.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-duplicati](https://github.com/guim31/gladys-duplicati).

Not affiliated with Backrest or restic.
