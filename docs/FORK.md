# This fork: one code base, three installs

`rafaelreis-r/career-ops` is a code-only fork of
[career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops). It carries
upstream plus the Jev/TypeSafe (System One) integration plus a small set of
owner customizations. Three installs (tracks A, B, C — one per career track)
receive code from this fork through the stock updater and keep every user-layer
file local. No application data ever lives here.

## Layout

| What | Where |
|---|---|
| Canonical code | `main` of this repo. Working clone: `~/dev/career-ops-fork` (`origin` = this fork, `upstream` = career-ops-hq). |
| Track A (Platform / SRE / DevOps) | `~/dev/career-ops` |
| Track B (Product Management) | `~/dev/career-ops-product` |
| Track C (Operations & Delivery) | `~/dev/career-ops-ops` |
| Shared, non-git material (ADRs, track registry) | `~/dev/career-ops-shared` |

Report numbers are installation-scoped but can be consumed by cross-track
tools, so each track owns a non-overlapping range in its local
`config/profile.yml`:

| Track | `report_number_range` |
|---|---|
| A | `"1-999"` |
| B | `"1000-1999"` |
| C | `"2000-2999"` |

`reserve-report-num.mjs` fails closed when this setting is missing or exhausted.
`CAREER_OPS_REPORT_NUMBER_RANGE` is only a one-run override. Before applying
this change to the tracks, add the assigned value above to each profile. Existing
out-of-range reports remain readable; new reservations stay within the assigned
range. To audit historical reuse across the three installs without writing any
files, run:

```sh
node reserve-report-num.mjs --collisions \
  ~/dev/career-ops ~/dev/career-ops-product ~/dev/career-ops-ops
```

Each track is a full checkout whose system files are byte-identical to `main`.
User-layer files (`cv.md`, `config/profile.yml`, `modes/_profile.md`,
`modes/_custom.md`, `modes/_brief.md`, `data/`, `reports/`, `jds/`, `.env`, …)
are the track's own and are never touched by an update; they are listed in
`USER_PATHS` in `update-system.mjs`.

## How code reaches a track

`update-system.mjs` resolves its source from `CANONICAL_SLUG`, which defaults to
`rafaelreis-r/career-ops`. `CAREER_OPS_CANONICAL_SLUG=<owner>/<repo>` overrides it.
Upstream hardcodes career-ops-hq there; that constant is the one line that makes
the tracks follow this fork instead.

Update one track:

```sh
cd ~/dev/career-ops            # or -product / -ops
node update-system.mjs apply --confirm --force
```

`--force` is required. Without it the updater keeps every system file the track
has ever changed locally (the Jev files included) and writes a `.bak` beside it,
so the track would silently stop receiving fixes for those files. Each run
creates `backup-pre-update-<version>-<timestamp>` and
`refs/backup-pre-update-wip/<version>`; `node update-system.mjs rollback` undoes
the last apply.

The updater commits its own change. The three tracks have `.git/lrc/disabled`
so the LiveReview `prepare-commit-msg` hook does not abort that commit.

## How to change code

1. Edit in `~/dev/career-ops-fork`, run the relevant tests
   (`node --test tests/jev-*.test.mjs`, `cd web && npm test`,
   `node validate-system-paths-coverage.mjs` after adding a file).
2. Commit and push to `origin main`. The pre-push guard flags two upstream test
   fixtures (`alice:hunter2@…example.org`, `user:pass@…`) as credentials; they are
   not. `GSTACK_REDACT_PREPUSH=skip git push` is the documented bypass.
3. Run the apply command above in each track.

Never edit a system file inside a track: the next `apply --force` overwrites it.
Track-specific behavior belongs in that track's `modes/_custom.md` or
`config/`, which the updater never touches.

## How to take a new upstream release

```sh
cd ~/dev/career-ops-fork
git fetch upstream
git rebase upstream/main
```

Three files conflict on almost every rebase; resolve them as follows.

| File | Fork side to keep |
|---|---|
| `update-system.mjs` | `CANONICAL_SLUG` block (replaces the three hardcoded URLs and the ref URL); the `Fork-owned` entries in `SYSTEM_PATHS` (`jev-ag-eval.mjs`, `jev-pregate.mjs`, `lib/jev-client.mjs`, `lib/apply-route.mjs`, `lib/jev-apply-helpers.mjs`, `web/`); and `modes/apply-llm-owned.md`. |
| `jd-skill-gap.mjs` | The `jev-client` import beside upstream's imports; the `jevChoice` call and `isJevEnabled` gate in the skill-gap scorer. |
| `web/src/lib/apply/drive.ts` | The `jev-drive` import and `DriveResult` re-export; the `isJevDriveEnabled()` branch that delegates to `driveSessionJev`. Keep upstream's spawn helper. |

Then re-run the tests in step 1 above, push, and apply to the tracks.

## Deliberate deviations from upstream

Keep these across rebases; each exists for a reason.

- **`web/` is in `SYSTEM_PATHS`.** Upstream excludes `web/` from its updater as a
  separate release component. The Jev apply driver
  (`web/src/lib/apply/jev-drive*.{ts,mjs}`, `web/scripts/arm1-jev-agentbrowser.mjs`)
  lives there and has to reach the tracks.
- **LLM-owned apply path.** `lib/apply-route.mjs`, `lib/jev-apply-helpers.mjs`,
  `web/scripts/jev-apply.mjs`, and `modes/apply-llm-owned.md` are the
  "LLM owning, Jev helping" apply path. Route is a pure function of the job URL
  and `FAST_HOSTS` (initially only `applytojob.com`); a dispatched worker on
  `apply-llm-owned` submits once after the ready gate. Interactive `apply` still
  never submits.
- **Hybrid apply filler.** `web/scripts/apply-hybrid.mjs` with
  `web/src/lib/apply/hybrid/`. Per form: one Stagehand `observe()` to find the
  application's controls (its model is a local `codex exec` callback, no
  provider key), then deterministic Playwright adapters for exact-label
  canonical answers, each re-reading the DOM after it acts. Every field they
  miss, misfill or cannot verify goes to the model: Jev matching (report
  answers, then profile answers), a second codex judge, Jev's yes/no judgment
  over the canonical facts (never for a consent question), Jev option picks,
  and a Stagehand `act()` on that field, followed by the same DOM check. The
  canonical answers add the profile blocks arm1 does not read (address,
  nationality, employment, the captain's form answers, the USD anchor). After
  both passes the page is rescanned once it settles: questions it revealed and
  verified fields it cleared are filled again. A value that does not fit the
  field (an e-mail in "Address", a monthly amount in an annual field, another
  currency) is never typed. Captcha frames are never scanned. The CV is always
  this posting's PDF (`data/pdf-index.tsv`, the report's `**PDF:**` line,
  `--cv`), checked by file name against the company; when there is none, the
  track's `pdf` mode generates it before any field is filled.

  The whole round runs in one visible Chrome with a fresh profile (state in
  `~/.cache/career-ops/hybrid-round.json`). A detached keeper process
  (`round-keeper.mjs`) launches it and holds the CDP connection that loaded
  Stagehand's runtime extension, because Chrome disables that extension when
  the connection closes. Each form is a tab and stays open; running a posting
  again reuses its tab as it stands. After each form the
  tabs are re-ordered: forms that only need the captcha first, then the rest
  from fewest to most pending items. Only a posting with no form (closed or
  removed ad) is closed. A posting whose tracker row is Applied or later is
  never opened. It never submits. Exit 0: ready, or ready except the captcha.
  3: pending items, listed by their labels. 4: no form. 5: already applied.
  1: failure. `--headless` uses a private browser that closes at the end.

  It runs beside `arm1-jev-agentbrowser.mjs`; routing in `lib/apply-route.mjs`
  is unchanged until it proves it replaces arm1. To compare both on one form,
  run each with the same URL and a distinct `--out`:

  ```sh
  cd ~/dev/career-ops-product/web   # the track that owns the posting
  node scripts/arm1-jev-agentbrowser.mjs --url <url> --row <n> --cv <pdf> --no-submit --out /tmp/arm1.json
  node scripts/apply-hybrid.mjs          --url <url> --row <n> --out /tmp/hybrid.json
  ```

  A track gets Stagehand from `web/package.json`: after `update-system.mjs
  apply`, run `npm install` once in that track's `web/`.
- **`agent-browser`, `jev-agent-browser` and `@browserbasehq/stagehand` are
  declared in `web/package.json`.** Installed with `--no-save`, the next
  `npm install` pruned them.
- **`import * as yaml from "js-yaml"`** in the Jev scripts. js-yaml 5 is ESM with
  no default export; upstream already uses the namespace form everywhere.
- **Templates:** `templates/cv-template.ops.{html,tex}`,
  `templates/cv-template.perfiltech.html`, `templates/cover-letter-template.ops.html`.
  All three tracks select `template: ops`. `templates/` is a system directory,
  and the updater prunes any file there that upstream does not ship, so the only
  place these survive is this fork.
- **`plugins/gmail`:** optional `senders` setting (match job-alert mail by `From:`
  address, OR'd with the label; used by the tracks' `config/plugins.yml`) and
  `isCleanUrl` filtering of LinkedIn CDN hosts and notification routes.
- **`batch/batch-runner.sh`:** seeds the JD temp file from a `jd=jds/…` note before
  falling back to upstream's curl prefetch, so headless workers evaluate archived
  JDs without fetching LinkedIn.
- **`merge-tracker.mjs`:** skips an addition whose Company or Role parsed blank
  (column-shift symptom; warn, skip, archive like the other parse failures), and
  refuses a tier-3 fuzzy match when more than one existing row qualifies instead
  of taking the first (2026-09-02: nine same-day CI&T postings merged into the
  wrong row). `tests/merge-tracker.test.mjs` carries both contracts beside
  upstream's own.

## Dropped on purpose

The tracks descended from a different fork (santifer) and carried code no
configuration used. It was not carried forward: the `block_scripts` location
filter in `scan.mjs` (no `profile.yml` sets it), `title_filter_overrides`
(upstream 1.33 ships its own), and unrelated local deltas in `test-all.mjs`.

## Verifying the three tracks are in sync

```sh
for f in update-system.mjs lib/jev-client.mjs lib/apply-route.mjs lib/jev-apply-helpers.mjs web/src/lib/apply/drive.ts web/package.json; do
  md5sum ~/dev/career-ops/$f ~/dev/career-ops-product/$f ~/dev/career-ops-ops/$f ~/dev/career-ops-fork/$f
done
node update-system.mjs check   # in any track: "status":"up-to-date"
```
