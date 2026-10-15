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

Report numbers and tracker `#`s are installation-scoped, but cross-track tools
read them, so each track owns one 100,000-number block and the first digit of a
number names its track. The block is `report_number_range` in the track's local
`config/profile.yml` and `faixa` in the shared `trilhas.yml`:

| Track | `report_number_range` | Example |
|---|---|---|
| A | `"100000-199999"` | 3244 became 103244 |
| B | `"200000-299999"` | 1037 became 201037 |
| C | `"300000-399999"` | 2621 became 302621 |
| a fourth track | `"400000-499999"` | |

`reserve-report-num.mjs` fails closed when this setting is missing or exhausted,
and `merge-tracker.mjs` keeps its collision fallback inside the same range.
`CAREER_OPS_REPORT_NUMBER_RANGE` is only a one-run override. To audit
historical reuse across the three installs without writing any files, run:

```sh
node reserve-report-num.mjs --collisions \
  ~/dev/career-ops ~/dev/career-ops-product ~/dev/career-ops-ops
```

### Moving a track into its block

Before the blocks, the tracks numbered in 1-999, 1000-1999 and 2000-2999, and
track A overflowed into B's range. `renumber-ids.mjs` moves every number of one
track to `base + old` and writes an `id-map.tsv` that undoes the move. The
tracker `#` and the report number share one number space, so both get the same
function and every row keeps its report. Run it from this checkout with the
evaluation rounds and the scan/rank LaunchAgents stopped:

```sh
node renumber-ids.mjs plan --root ~/dev/career-ops --track A --base 100000 --out <dir>/A
node renumber-ids.mjs plan --root ~/dev/career-ops-product --track B --base 200000 --out <dir>/B
node renumber-ids.mjs plan --root ~/dev/career-ops-ops --track C --base 300000 --out <dir>/C
node renumber-ids.mjs shared --shared-dir ~/dev/career-ops-shared/data \
  --track A=~/dev/career-ops:100000 --track B=~/dev/career-ops-product:200000 \
  --track C=~/dev/career-ops-ops:300000 --out <dir>/shared
node renumber-ids.mjs apply --plan <dir>/A/plan.json    # then B, C and shared
```

Plan the shared files before applying any track, because their owners come
from the unmigrated trackers. After the apply, set `report_number_range` in each
profile and `faixa` in `trilhas.yml` to the track's block.

`plan` only reads. It writes `plan.json`, `id-map.tsv` (columns `trilha`,
`antigo`, `novo`, `tipo`, `detalhe`) and `changes.tsv` (one line per file
operation), prints the number of changes of each kind, and checks in memory
that the reverse of its own result gives back every byte. `apply` refuses to run
while a `reports/*-RESERVED.md` reservation exists, while the tracker lock is
held, while a `batch/batch-state*.tsv` row is `processing`, or when any file the
plan read has changed since; it holds the tracker and pipeline locks while it
writes.

What moves:

- the tracker `#` and its report links; `data/status-log.tsv`; the `appNum`
  column and the `#N` pins of `data/follow-ups.md`; the `- [x] #N` items of
  `data/pipeline.md`; the first column of `data/pdf-index.tsv`;
- entry names in `reports/`, `jds/`, `covers/`, `data/outcomes/`,
  `data/followup-drafts/`, `data/application-packets/` and `output/`. In
  `output/` the number that moves is the one right before the date or the
  extension (`cv-candidate-gitlab-3244-2026-10-08.pdf`), when it is one of the
  track's numbers; a number inside the slug (`up-to-1-600-week`) stays. A JD
  moves only when its numeric prefix belongs to a vacancy in the track and
  the following company slug matches that vacancy's tracker or report company.
  Prefix width does not matter: `64-acme.md` moves for Acme's vacancy 64.
  A mismatched file such as `1872-consulting-...` stays and appears in
  `manual-pending.json`;
- paths and links to renamed files, and free-text `#NNN` tokens (three digits
  or more) that belong to this track, in eligible text files under `data/`,
  `reports/`, `jds/`, `covers/` and `output/`. This includes
  `data/active-interviews.md` and other historical records.

What stays: other numbers in text (`req 1057`, `Story #1`, another track's
`#1037`, and `#NNN` followed by a space and a single capital letter other
than the track's own, as in `#1014 B`); `#NNN` inside HTML comments,
`<style>` or `<script>` content, or colour attributes such as `style=` and
`fill=`; symlinked files (the shared TSVs, which the `shared` mode migrates
with the base of the track that owns each row); backups and hidden copies
(renamed with their directory, never rewritten), binary files, `batch/`
history, and text outside the files above, such as `modes/_custom.md`. `data/applications.db` is
rebuilt from the tracker by the next `tracker.mjs` run. The
`reports/*-faixa-inicial.md` anchors are deleted; their content is kept in the
id-map.

When a tracker `#` repeats, the row whose report carries a different number
takes that number, and the plan stops until each `data/status-log.tsv` event of
the repeated `#` has an owner, given as `--ledger-assign <old>@<date>=<new>`
(`--ledger-assign A:<old>@<date>=<new>` in `shared`). A shared row whose owner
the trackers cannot decide needs `--owner <file>:<line>=<track>`.

A free-text `#NNN` whose tracker number repeats is left unchanged because its
vacancy is ambiguous. This includes tracker notes, follow-up pins and `appNum`
cells, and shared notes. Report-number fields still move. `plan` records each
ambiguous occurrence with its file, line and excerpt in `plan.json` and
`manual-pending.json`, and prints the list. `apply` prints the list again for
manual resolution after migration.

To undo, plan the reverse and apply it: `plan --root <track> --reverse --id-map
<dir>/A/id-map.tsv --out <dir>/A-reverse`, and for the shared files `shared
--reverse` with every track's id-map plus the shared one. Numbered fields and
file names allocated after the migration go back to `new - base` as well; a
number inside an `output/` name or in free text goes back only when the id-map
lists it.

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

**Channel.** Upstream's updater installs the newest published release by
default (`release` channel, #3845). This fork publishes no GitHub releases, so
`DEFAULT_CHANNEL` in `update-system.mjs` is `main`: `check` compares the track
with the fork's `main`, and `apply` installs `main`'s tip. `--channel release`
(or `CAREER_OPS_UPDATE_CHANNEL=release`) still selects upstream's behaviour and
fails here with "Could not reach …/releases/latest". `test-all.mjs` exports
`CAREER_OPS_UPDATE_DEFAULT_CHANNEL=release` so upstream's release-channel tests
run unchanged; `tests/updater-fork-default-channel.test.mjs` pins the fork
default.

Update one track:

```sh
cd ~/dev/career-ops            # or -product / -ops
git add data && git commit -m "data: before the update"   # if data/ has changes
node update-system.mjs apply --confirm --force
npm install && npx playwright install chromium
(cd web && npm install)
node update-system.mjs check   # "status":"up-to-date"
```

`--force` is required. Without it the updater keeps every system file the track
has ever changed locally (the Jev files included) and writes a `.bak` beside it,
so the track would silently stop receiving fixes for those files. Each run
creates `backup-pre-update-<version>-<timestamp>` and
`refs/backup-pre-update-wip/<version>`; `node update-system.mjs rollback` undoes
the last apply (then `npm install` and `(cd web && npm install)` to bring the
dependencies back with it).

Dependencies are a manual step. The updater runs `npm install --silent` with a
60-second limit and prints "npm install skipped" when it runs out, which a
Playwright or `dotenv` bump easily does; it never installs in `web/`, and it
does not download the Chromium a new Playwright needs. Run the three commands
above after every apply.

The updater refuses to run from a linked git worktree and re-runs itself in the
main checkout (#4738). To exercise it from a worktree on purpose (a rehearsal on
a copy of a track), set `CAREER_OPS_UPDATE_IN_WORKTREE=1`. To rehearse against
another repository, set `CAREER_OPS_CANONICAL_SLUG=<owner>/<repo>`; the private
`rafaelreis-r/career-ops-staging` exists for that.

The updater commits its own change. The three tracks have `.git/lrc/disabled`
so the LiveReview `prepare-commit-msg` hook does not abort that commit.

## How to change code

1. Edit in `~/dev/career-ops-fork` and run the relevant tests
   (`env -u TYPESAFE_API_KEY node test-all.mjs --quick` for everything,
   `node --test tests/jev-*.test.mjs`, `cd web && npm test`,
   `node validate-system-paths-coverage.mjs` after adding a file). Unset
   `TYPESAFE_API_KEY` for the suite: with the key set, Jev scores every rank test
   that does not pass `--cli`, and those are paid calls.
2. Commit and push to `origin main`. The pre-push guard flags two upstream test
   fixtures (`alice:hunter2@…example.org`, `user:pass@…`) as credentials; they are
   not. `GSTACK_REDACT_PREPUSH=skip git push` is the documented bypass.
3. Run the apply command above in each track.

Never edit a system file inside a track: the next `apply --force` overwrites it.
Track-specific behavior belongs in that track's `modes/_custom.md` or
`config/`, which the updater never touches.

## How to take a new upstream release

Sync at every upstream release; 1.34, 1.35 and 1.36 shipped within 16 days,
and the 676-commit gap of 2026-10 took a full rehearsal to close. Rehearse on a
branch first, then publish:

```sh
cd ~/dev/career-ops-fork
git fetch origin upstream
git branch backup/main-pre-<version> origin/main && git push origin backup/main-pre-<version>
git switch -c fm/rebase-<version> origin/main
git rebase <pinned upstream commit>        # pin the commit you tested, not a moving main
npm install --ignore-scripts && (cd web && npm install --ignore-scripts)
env -u TYPESAFE_API_KEY node test-all.mjs --quick
(cd web && npm test)
git diff <pinned upstream commit> HEAD -- modes/_shared.md CLAUDE.md   # must be empty
GSTACK_REDACT_PREPUSH=skip git push --force-with-lease=main:<old main sha> origin HEAD:main
```

Rollback of a bad publish: `git push --force-with-lease origin
backup/main-pre-<version>:main`, then `node update-system.mjs rollback` in any
track that already applied it.

Files that conflicted in the 2026-10 rebase (63 file conflicts across 17
commits) and the side to keep:

| File | Resolution |
|---|---|
| `update-system.mjs` | The `CANONICAL_SLUG` block, with `RELEASES_API` and `UPSTREAM_REF_API` derived from it; `DEFAULT_CHANNEL`; both sides of the `SYSTEM_PATHS` manifest: upstream's entries plus every path the fork adds (the `Fork-owned` block with the Jev files, `lib/tracks.mjs`, `lib/email-reconcile.mjs`, `reconcile-email.mjs`, `renumber-ids.mjs` and `web/`, and the fork scripts listed in place, such as `eval-queue.mjs`, `lib/rank-calibration.mjs`, `lib/us-only.mjs` and `modes/apply-llm-owned.md`). `node validate-system-paths-coverage.mjs` fails on a tracked file neither manifest covers. |
| `rank-pipeline.mjs` | Conflicted in six commits. Upstream's guards (`--cli hermes` refused, no `pipeline.md` exits 0) run first, then the fork's Jev block with `--cli` precedence; upstream's index-based annotation with the fork's calibration and US-only screen after it; the fork's flags in `KNOWN_FLAGS`/`VALUE_FLAGS`. |
| `merge-tracker.mjs` | Upstream wraps the script in `mergeTracker(options)`; take upstream's file and re-insert the fork's guards by hand (blank Company/Role, ambiguous tier-3 match, glued rows, range-bound collision fallback). |
| `batch/batch-prompt.md`, `modes/oferta.md` | Upstream's sections ("Score Evidence", `posting_location`, PcD check) plus the fork's paragraphs beside them. |
| `README*.md` | The fork's Human-in-the-Loop row and FAQ answer (see deviations). |
| `web/src/lib/apply/drive.ts`, `issue.ts` | Upstream's split helpers and `DriveStep`; the fork's `jev-drive` import and `DriveResult`. |
| `scan.mjs`, `tracker-utils.mjs`, `tracker-parse.mjs`, `reserve-report-num.mjs`, `test-all.mjs` | Upstream's version plus the fork's additions; `export { x } from` creates no local binding, so add a local import where a function in the same file calls it. |
| `.gitignore` | Upstream's rules plus `.browser-profiles/` and `!batch/*.mjs`. |

Upstream test gates catch fork code that merges without a marker. Each of these
broke the 2026-10 rebase at run time, not at merge time:

- new CLI flags must be listed in the script's `KNOWN_FLAGS` (`validateFlags`);
- a CLI with an `isMainModule` guard must answer `--help` through `lib/cli-flags.mjs`;
- recursive directory walks go through `lib/walk-tree.mjs`;
- tests link `node_modules` with `linkNodeModules()` and import `web/` dynamically behind `existsSync`;
- every CV template must satisfy the template contract (title slot, generated contact separators, break tokens) and be declared in `tests/theme-style.test.mjs`;
- a duplicated import from two auto-merged hunks is a `SyntaxError` that takes a whole plugin scan down.

After publishing, update the tracks one at a time (C, B, A), outside the scan
(05:00 BRT) and rank (08:00) windows.

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
  `web/src/lib/apply/hybrid/`. Per form: a DOM scan finds the application's
  controls, then deterministic Playwright adapters handle exact-label canonical
  answers, each re-reading the DOM after it acts. Every field they
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
  `--cv`), checked against the posting; when there is none, the track's `pdf`
  mode generates it before any field is filled, using only a JD already
  archived in the report or its report-numbered `jds/` capture. See
  [APPLY_AUTOFILL.md](APPLY_AUTOFILL.md#hybrid-driver) for answer-source and CV
  filename rules.

  The whole round runs in one visible Chrome with a fresh profile (state in
  `~/.cache/career-ops/hybrid-round.json`). A detached keeper process
  (`round-keeper.mjs`) launches it and holds the CDP connection that loaded
  Stagehand's runtime extension, because Chrome disables that extension when
  the connection closes. Each form is a tab and stays open; running a posting
  again reuses its tab as it stands. After each form the tabs are re-ordered:
  forms that only need the captcha first, then the rest from fewest to most
  pending items, submitted ones last. Only a posting with no form (closed or
  removed ad) is closed.

  It submits (captain, 2026-09-23), and only through one explicit final step:
  when the gate on the final DOM finds nothing (every required field with a
  verified canonical value, the posting's CV in the final DOM, no consent
  without a canonical answer, no captcha), it clicks the form's single submit
  control and counts the application only when the employer's confirmation
  shows; the tracker row then becomes Applied through `set-status.mjs`.
  Anything else leaves the tab filled for the human. Until that step, a lock
  in every frame of the tab (`submit.mjs`) cancels every submission of a form
  holding applicant fields (submit events, `submit()`, `requestSubmit()`, a
  button without a type, Enter) and clicks on submit-like controls; it lives
  on a heartbeat, so it lifts by itself when the driver stops.

  Never opened: a posting whose tracker row is Applied or later, a company or a
  posting host listed in `data/blacklist.md` (read with the scanner's own
  `parseBlacklist`/`findBlacklistEntry`, so a `domain` row matches the host and
  its subdomains), and a company whose submission limit is used up across
  every track listed in the shared `trilhas.yml`. Limits live in
  `data/submission-limits.tsv` of the shared directory (`$CAREER_OPS_SHARED_DIR`,
  default `~/dev/career-ops-shared`): `company`, `max_submissions`,
  `window_days`, tab-separated; the run reports the date the window reopens.
  Exit 0: submitted and confirmed. 3: left for the human (pending items, listed
  by their labels, or the captcha). 4: no form. 5: not eligible. 6: submitted
  without a confirmation, or refused by the employer. 1: failure.

  It runs beside `arm1-jev-agentbrowser.mjs`; routing in `lib/apply-route.mjs`
  is unchanged until it proves it replaces arm1:

  ```sh
  cd ~/dev/career-ops-product/web   # the track that owns the posting
  node scripts/apply-hybrid.mjs --url <url> --row <n> --out /tmp/hybrid.json
  ```

  A track gets Stagehand from `web/package.json`: after `update-system.mjs
  apply`, run `npm install` once in that track's `web/`.
- **`agent-browser`, `jev-agent-browser` and `@browserbasehq/stagehand` are
  declared in `web/package.json`.** Installed with `--no-save`, the next
  `npm install` pruned them.
- **`import * as yaml from "js-yaml"`** in the Jev scripts. js-yaml 5 is ESM with
  no default export; upstream already uses the namespace form everywhere.
- **Templates:** `templates/cv-template.ops.{html,tex}` and
  `templates/cover-letter-template.ops.html`. All three tracks select
  `template: ops`. `templates/` is a system directory, and the updater prunes
  any file there that upstream does not ship, so the only place these survive
  is this fork. `cv-template.ops.html` is upstream's `cv-template.html` plus four
  deltas: the manifest comment, accent-coloured underlined contact links (with
  the generated separator kept out of the underline), and justified summary,
  bullets and project text. When upstream changes `cv-template.html`, copy it
  over and re-apply those deltas; `git diff --no-index templates/cv-template.html
  templates/cv-template.ops.html` shows them. It is declared in
  `tests/theme-style.test.mjs` and `tests/cv-optional-sections.test.mjs`, which
  require every CV template to state its break defaults and section markers.
- **`plugins/gmail`:** optional `senders` setting (match job-alert mail by `From:`
  address, OR'd with the label; used by the tracks' `config/plugins.yml`) and
  `isCleanUrl` filtering of LinkedIn CDN hosts and notification routes.
- **`batch/batch-runner.sh`:** seeds the JD temp file from a `jd=jds/…` note before
  falling back to upstream's curl prefetch, so headless workers evaluate archived
  JDs without fetching LinkedIn.
- **`merge-tracker.mjs`:** skips an addition whose Company or Role parsed blank
  (column-shift symptom; warn, skip, archive like the other parse failures),
  refuses a tier-3 fuzzy match when more than one existing row qualifies instead
  of taking the first (2026-09-02: nine same-day CI&T postings merged into the
  wrong row), and keeps the tracker-`#` collision fallback inside
  `report_number_range`: it continues after the highest number taken inside the
  range, uses a lower free number only when the top is full, and refuses the
  addition when the range is full.
  `tests/merge-tracker.test.mjs` and `tests/merge-tracker-range-fallback.test.mjs`
  carry these contracts beside upstream's own.
- **E-mail reconciliation across tracks.** `reconcile-email.mjs` with
  `lib/email-reconcile.mjs` reads Gmail through `gog` (read-only) and has Jev
  classify each e-mail and pick its row among the trackers of every track in
  `trilhas.yml`; it writes forward-only changes through `set-status.mjs`
  only with `--apply`. See [SCRIPTS.md](SCRIPTS.md#reconcile-email).
  `lib/tracks.mjs` is the one reader of the registry and of every track's
  tracker, shared with the hybrid driver's submission-limit check.
- **Update channel `main`.** `DEFAULT_CHANNEL` in `update-system.mjs`; see
  [How code reaches a track](#how-code-reaches-a-track).
- **`--force` updates the configured template.** Upstream's updater keeps a
  template variant named in `config/profile.yml` whenever its local content
  differs from the target, even under `--force`. In the tracks that variant is
  the fork's own `ops`, so upstream's rule would freeze each track on the `ops`
  it first received. Under `--force` the fork overwrites it with the shipped
  version and writes a `.bak` of the local copy; without `--force` it is kept.
- **README submission contract.** Every `README*.md` keeps the fork's
  Human-in-the-Loop row and FAQ answer: interactive `apply` leaves submission to
  the user, and the separately invoked hybrid driver may submit once after its
  final gate. Translations point to [APPLY_AUTOFILL.md](APPLY_AUTOFILL.md).
  Upstream's `tests/readme-hitl-markers.test.mjs` pins the absolute
  "never submits" wording, so the fork does not carry it.
- **Aside and Ashby.** Upstream's `modes/apply.md` (#4443) sends an Ashby form
  to the candidate's ordinary browser. Here that browser is Aside, where `apply`
  already runs, so an Ashby posting is filled and submitted in Aside. The rule is
  in `modes/_custom.template.md`; each track's own `modes/_custom.md` is the
  copy the agent reads.
- **LinkedIn read through Aside.** `liveness-api.mjs` reads a LinkedIn posting
  through Aside's built-in `linkedin.getJob` (the candidate's logged-in
  session, via `aside repl`) before upstream's guest-endpoint rung, and the
  same read gives `fetch-jd.mjs` and `browser-extract.mjs` the LinkedIn JD.
  Without Aside the upstream path runs unchanged. See
  [SCRIPTS.md](SCRIPTS.md#liveness).
- **`.gitignore`:** `.browser-profiles/` (logged-in sessions) is ignored, and
  `!batch/*.mjs` keeps per-round helper scripts visible under upstream's
  `batch/*` rule.
- **`test-all.mjs` defaults:** `CAREER_OPS_REPORT_NUMBER_RANGE=1-9007199254740991`
  (the fork's `reserve-report-num.mjs` refuses to run without a range) and
  `CAREER_OPS_UPDATE_DEFAULT_CHANNEL=release`, both with `??=`, so upstream's
  suites run unchanged.
- **Scheduled community workflows** (`ci-approve`, `gfi-claims`, `gfi-handoff`,
  `plugin-registry-freshness`, `pr-adoption`, `pr-triage`, `stale`, plus
  `gh-events-feed` and `release`) run only when `github.repository` is
  career-ops-hq/career-ops.

## Dropped on purpose

The tracks descended from a different fork (santifer) and carried code no
configuration used. It was not carried forward: the `block_scripts` location
filter in `scan.mjs` (no `profile.yml` sets it), `title_filter_overrides`
(upstream 1.33 ships its own), and unrelated local deltas in `test-all.mjs`.
The 2026-09 migration of `CLAUDE.md` into `AGENTS.md` and its revert (net zero)
were dropped in the 2026-10 rebase.

## Fork changes

Upstream's `CHANGELOG.md` belongs to release-please, so a fork section there
conflicted on every rebase. The fork records its own changes here instead,
newest first. Upstream's changes are in `CHANGELOG.md` as shipped.

### Since the rebase

- **liveness / fetch-jd:** LinkedIn postings are read through the
  candidate's Aside session (`linkedin.getJob`) for liveness and JD text. On
  2026-10-15, 14 of 17 LinkedIn postings in the daily evaluation ended "sem
  confirmação" because the worker read the page text in a tab, where LinkedIn
  leaves the description out.

### Rebase onto upstream `2f1a548b41` (1.36.0 + 155 commits), 2026-10-13

- **update-system:** the default channel is `main`, because the fork publishes
  no releases and upstream's `release` default (#3845) made `check` report
  `offline` and `apply` throw. See [How code reaches a track](#how-code-reaches-a-track).
- **update-system:** `--force` overwrites a configured template variant the
  fork ships (`ops`) instead of keeping the track's older copy.
- **templates:** `ops` is rebuilt on upstream's `cv-template.html` with its own
  deltas. The `perfiltech` template is removed (candidate, 2026-10-14: hard to
  read; no track selected it).
- **web:** the hybrid driver refuses a posting on a domain-scoped blacklist row
  (upstream #4139), using the scanner's own blacklist reader.
- **readme:** every README describes the fork's submission contract instead of
  upstream's absolute "never submits".
- **modes:** the custom-instructions template says Aside is the candidate's
  browser and Ashby postings are submitted there.
- **merge-tracker:** the tracker-`#` collision fallback continues after the
  highest number already taken inside `report_number_range`, like the report
  allocator, and falls back to the lowest free number only when the top of the
  range is used up.
- **cli:** `eval-queue.mjs`, `rank-calibration-replay.mjs` and
  `providers/_jobs-search-auth.mjs` answer `--help` through `lib/cli-flags.mjs`.
- **renumber-ids:** walks track trees through `lib/walk-tree.mjs`.
- **profile:** `config/profile.example.yml` declares `application_answers`,
  `us_ats_answers` and `pipeline` (commented), so `validate-profile.mjs` stops
  calling them unknown.
- **ci:** scheduled community workflows run only in career-ops-hq/career-ops.
- **gitignore:** `.browser-profiles/` is ignored; per-round `batch/*.mjs`
  helpers stay visible under upstream's `batch/*` rule.

### Before the rebase

Features:

- **scoring:** require level and compensation targets for ranking and full
  evaluations; persist the final global score in the tracker.
- **eligibility:** treat a JD that offers 401(k), disability insurance, FSA, or
  HSA as US-only employment when `location.authorized_in` does not list the
  United States: `eval-queue.mjs` holds the row when its JD is saved locally,
  and the evaluation scores it below 3.5 with the reason in the report.
- **rank-pipeline:** rank US-only postings below the forwarding cutoff without a
  scorer call, including pending rows with an existing `cal-v3` rank: a US
  benefit in the JD, a US-only location, remote work limited to the US, or US
  work authorization without sponsorship. Mixed locations remain eligible for
  scoring. The reason shows on the annotated row; `location.authorized_in`
  listing the United States turns the screen off.
- **rank-pipeline:** make the CLI path's batch size and per-call timeout
  configurable (`--batch` / `CAREER_OPS_RANK_BATCH`, `--timeout-ms` /
  `CAREER_OPS_RANK_TIMEOUT_MS`); defaults stay 10 and 120 s, invalid values are
  refused.
- **rank-pipeline:** check selected postings against public ATS APIs before
  scoring, and mark confirmed closed ones as expired. See
  [rank-pipeline](SCRIPTS.md#rank-pipeline) for the check's limits and options.
- **rank-pipeline:** an explicit `--cli` wins over Jev when `TYPESAFE_API_KEY` is
  set.
- **renumber-ids:** move a track's tracker `#`s and report numbers into its
  100,000-number block (`new = base + old`) with `renumber-ids.mjs plan`/`apply`,
  migrate the shared TSVs with the base of each row's track, and undo it from
  the written `id-map.tsv`. The plan proves the reverse in memory before
  anything is written; see [Moving a track into its block](#moving-a-track-into-its-block).
- **profile:** `config/profile.example.yml` assigns 100,000-number blocks
  (`100000-199999`, `200000-299999`, …) instead of 1,000-number ranges, and the
  report-number prompts say "minimum 3 digits".

Bug fixes:

- **merge-tracker:** a re-evaluation no longer replaces a physical tracker line
  that holds two glued rows, which deleted the second row.
- **merge-tracker:** the tracker-`#` collision fallback stays inside
  `report_number_range` and refuses the addition when the range is full.
- **salary-gap:** read reports numbered with four or more digits, which the
  three-digit file match skipped.
- **gitignore:** browser profiles and per-round batch output are ignored.

## Verifying the three tracks are in sync

```sh
for f in update-system.mjs lib/jev-client.mjs lib/apply-route.mjs lib/jev-apply-helpers.mjs web/src/lib/apply/drive.ts web/package.json; do
  md5sum ~/dev/career-ops/$f ~/dev/career-ops-product/$f ~/dev/career-ops-ops/$f ~/dev/career-ops-fork/$f
done
node update-system.mjs check   # in any track: "status":"up-to-date"
```
