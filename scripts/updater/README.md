# Bar updater: end-to-end test on the Mac

`e2e_mac.sh` proves that the bar updater (`updater/`) works with real Docker
before it runs at the bar. It builds real images from the working tree, pushes
them to a local registry, starts a full copy of the bar stack with a copy of
the dev data, and runs the updater through five scenarios. It removes
everything it made when it ends, also on Ctrl-C or on a failure.

## How to run

From the repo root, with Docker Desktop running and the dev stack up (the
test reads the dev database `billiardbar` with `pg_dump`; it never writes to
it and never stops or restarts the `billar-pos` project):

```sh
scripts/updater/e2e_mac.sh
```

It takes about 4 minutes when Docker's build cache is warm; the first run
builds every image from scratch and can take 10 minutes or more. Scenario 4
can take up to the 5-minute health budget (usually it fails much sooner, see
below). It exits 0
when every scenario passes. A copy of the output goes to
`/private/tmp/billiards-e2e-<time>.log`.

Needs: ports 5001 (registry) and 18080 (the e2e POS) free, `python3`,
internet access for the base images and the docker/compose downloads in the
updater image.

Options (environment variables):

| Variable | Effect |
| --- | --- |
| `E2E_ROOT=<dir>` | Where the bar folder (`e2e-bar/`) and the build folders go. Default: a new folder under `/private/tmp`. Docker Desktop must share it (`/private` and `/Users` are shared by default). |
| `E2E_LOG=<file>` | Where the output copy goes. |
| `E2E_KEEP=1` | Leave the stack and registry running at the end, to look around. Remove them later with `scripts/updater/e2e_mac.sh --cleanup`. |
| `E2E_POST_SLACK=1` + `E2E_SLACK_WEBHOOK_URL=<url>` | Post the updater messages to that webhook, prefixed `[PRUEBA Mac]`. Default: messages are only printed. The URL is never printed. |

`scripts/updater/e2e_mac.sh --cleanup` removes what an interrupted run left
behind (compose project `billiards-e2e` with its volume, the registry
container, the test images).

## What it sets up

- **Four image sets**, built from the working tree and tagged with fake
  commit ids:
  - `OLD` = `aaaa…` – the tree as it is.
  - `NEW` = `bbbb…` – OLD plus a throwaway migration `999_e2e_probe`, which
    creates the marker table `e2e_probe` with one row.
  - `FAIL` = `cccc…` – NEW plus a migration `999f_e2e_fail` that raises.
    (Its version is `999f`, not `999`: the migration runner keys a migration
    by the part of the file name before the first `_`, and `999` is already
    applied by the probe.)
  - `BROKEN` = `dddd…` – NEW with a backend entrypoint that writes one row
    into `e2e_probe` and exits 1, so the backend is never healthy.

  The extra migrations and the broken entrypoint exist only in temporary
  copies of `backend/`; nothing is added to the repo. Each set gets its
  release image from `release/make_release.py --sha <sha> --registry
  localhost:5001`, so its `release.json` lists its own migrations.
- **Telegram bot stand-in.** The real bot image is built (to prove it
  builds), but the stack runs a stand-in on top of it that only stays up. The
  real bot needs a working token and polls Telegram; a real token on the Mac
  would steal the bar bot's messages. The e2e `.env` has an empty
  `TELEGRAM_TOKEN`, so the health check does not require `telegram-bot` at
  all (it only warns when it is not running); the stand-in still keeps the
  stack the same shape as at the bar.
- **Local registry** `registry:2` on `localhost:5001`, standing in for GHCR
  (`UPDATER_REGISTRY=localhost:5001`, empty `GHCR_TOKEN`, so no login). After
  the push the local tags are removed, so the stack and the updater really
  pull from the registry. "Promote" is a retag of
  `billar-pos-release:bar-stable` (the only tag the updater reads).
- **The bar folder** (`BAR_HOST_DIR`): `.env` (values without quotes),
  `docker-compose.bar.yml` from the OLD release, `backups/`, and
  `updater/state.json` saying OLD is installed.
- **Compose project `billiards-e2e`** (the script refuses to run as
  `billiards` or `billar-pos`), frontend on port 18080. Its postgres gets a
  `pg_dump -Fc` of the dev database, restored with `--no-owner
  --no-privileges`. An open drawer or ticket in the dev data is closed in the
  e2e copy only, so the scenarios start with nothing open.
- **Time zone.** The updater's daemon runs an attempt at start-up when the
  local time is between 03:00 and 12:00. To keep it out of the way, the stack
  uses `America/Mexico_City` unless it is between 01:00 and 12:00 there; then
  it uses a fixed offset where it is mid-afternoon.

Each scenario runs `docker compose -p billiards-e2e exec -T updater python -m
updater run-now` inside the e2e updater container.

## The scenarios

They run in the order 2, 1, 3, 4, 5: scenario 2 needs an update waiting, so
it runs while OLD is still installed.

| # | Setup | What it proves |
| --- | --- | --- |
| 2 | bar-stable = NEW, an OPEN cash session inserted in the e2e database | Outcome `blocked_open` (exit 3), message text "pospuesta". Compose file, running images and containers unchanged, no backup taken, state still OLD. The test row is deleted afterwards. |
| 1 | bar-stable = NEW, nothing open | Outcome `installed`: migration 999 applied in the live database, `e2e_probe` has its row, every app service runs NEW, backend healthy, frontend answers 200. Compose file names NEW, `.previous` names OLD, backup `pre-update-aaaaaaa-to-bbbbbbb-<date>.dump` written, scratch database dropped. The message contains "actualizado" (with the `[PRUEBA Mac]` prefix). The updater container is replaced and running on NEW (Ruling N); `updater status` shows NEW and `installed`. run-now may end with exit 137 here: the self-update replaces the container the command runs in. |
| 3 | bar-stable = FAIL | Outcome `rehearsal_failed` (exit 1); the error names `999f`. The live database is untouched (same migrations, tables and marker rows), no container recreated, compose file unchanged, scratch database and rehearsal container removed. FAIL is held in `state.failed`; a second run without `--force` gives `held` (Ruling O). |
| 4 | bar-stable = BROKEN | Outcome `rolled_back` (exit 1), message "Se regresó a bbbbbbb". The rehearsal passes (it overrides the entrypoint); then `docker compose up` itself fails within seconds ("dependency failed to start: container ... is unhealthy", because the frontend waits for a healthy backend), so the failed step is "el arranque de la nueva versión". The marker row count equals the count before the update, while the set-aside copy `billiardbar_failed` has the rows the broken backend wrote: the database was restored from the pre-update backup. Compose file back to NEW, every app service runs NEW, backend healthy, frontend 200, updater not replaced. BROKEN is held as `rolled_back`. |
| 5 | bar-stable = NEW (already installed) | Outcome `noop` (exit 0), no message, nothing recreated, no backup. |

## Expected output

Each check prints `PASS:` or `FAIL:`, each scenario ends with a line such as
`=> PASS (15/15 checks)`, and the run ends with:

```
SUMMARY
PASS  Scenario 2: drawer open -> blocked_open, nothing changes (9/9 checks)
PASS  Scenario 1: happy path OLD -> NEW, migration 999 applied (17/17 checks)
PASS  Scenario 3: failing migration -> rehearsal_failed, live database untouched (15/15 checks)
PASS  Scenario 4: backend never healthy -> rolled_back, database restored (13/13 checks)
PASS  Scenario 5: same version -> noop (6/6 checks)
ALL SCENARIOS PASS

cleanup evidence:
  containers of billiards-e2e left: 0
  volumes of billiards-e2e left   : 0
  registry container left    : 0
  e2e images left            : 0
  bar folder left            : no
  dev project billar-pos    : unchanged (same containers, start times, restart counts, volumes)
```

The full updater output of every run (its log lines and the printed message)
is shown under each scenario, indented with `|`.

## Safety

- Refuses to run when the compose project would be `billiards` or
  `billar-pos`, and checks that the e2e postgres and updater containers belong
  to `billiards-e2e` before it writes anything.
- The dev database is only read (`pg_dump`, one `count(*)`).
- Cleanup removes only the `billiards-e2e` project (containers and volume),
  the `billiards-e2e-registry` container, images named
  `localhost:5001/billar-pos-*` and `billiards-e2e-tmp/*`, and its own temp
  folders. At the end it compares the `billar-pos` containers (ids, start
  times, restart counts) and volumes with their state before the run.
- No Slack or Telegram message is sent unless `E2E_POST_SLACK=1`.
