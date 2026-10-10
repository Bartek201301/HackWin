# HackWin build plan: Phase 1

| Field | Value |
| --- | --- |
| Phase | 1: the CLI with `setup`, `join`, `take`, `ship`, `status` and `gate`, without the Resolver |
| Specification | `docs/HackWin-build-phase-0-1.md` (the brief), under the authority of `docs/HackWin-PRD.md` |
| Rules for every session | `AGENTS.md`, imported by `CLAUDE.md` |
| Ownership map | `owners.yml` |
| Interfaces and data formats | `docs/build/contracts.md`, written by task 1.3a |
| Written | Step 1.1, 9 October 2026 |

GitHub holds the state of every task: an issue is open until the pull request that closes it is merged. This file holds the plan and changes only through an integrator task.

## 1. How the build runs

One integrator and three builder lanes work in parallel on this repository, the way the HackYeah 2026 team worked (PRD 1.4): shared code with exactly one author, ownership by directory, contracts before code, small pull requests from fresh main, one merger.

| Role | Owns | Does |
| --- | --- | --- |
| `integrator` (shared role) | Shared code, package files, CI, the test harness, docs other than `docs/verification.md` | Plans in the main checkout; builds the foundation and the integration; merges, one pull request at a time, only when the human names it (section 8); is the only session that edits `docs/test-log.md` |
| `lane-a` | Git hooks, CI generation, Claude Code settings and hooks, `setup`, `join` | Tasks 1.4a to 1.4g |
| `lane-b` | `take`, `ship`, the platform verification | Tasks 1.2 and 1.5a to 1.5e |
| `lane-c` | `gate`, `status` | Tasks 1.6a to 1.6f |

Every task is one issue, one fresh session, one worktree and one pull request (`AGENTS.md`). Steps 1.0 (the sandbox) and 1.8 (release 0.1.0) are human steps and have no issue.

**Where this plan differs from the step table of the phase, and why.**

- Step 1.3 is four tasks, 1.3a to 1.3d, so that each stays a small pull request (T4). Task 1.3a is the foundation task: it comes first and blocks the other three and every lane task. Every lane task depends on all four, so no lane starts before the whole foundation is merged.
- Task 1.3e, the protection state reader, is shared code that setup (lane A) and the Gate (lane C) both need. Its mechanism depends on the verification of step 1.2, so it runs after 1.2, in parallel with the lanes, and only 1.4f and 1.6a wait for it.
- Step 1.2 belongs to `lane-b`, the lane with the fewest criteria. Any lane is idle during the foundation.
- AC18 moves from lane B to lane A (1.4a): the `pre-push` hook decides it alone; `ship` only writes the check record through shared code.
- AC54 (lane B), and AC70, AC76 and AC80 (lane A) need more than one lane and close in the integration tasks 1.7b and 1.7d (section 4).

## 2. Ownership map

Four owners never edit the same file. Each command lives in its own directory, and the lanes reach shared code only through the integrator's modules.

| Path | Role | Content |
| --- | --- | --- |
| `bin/` | integrator | The `hackwin` executable; it only calls `src/cli` |
| `src/cli/` | integrator | Dispatcher, command registry, global flags, the runner (configuration, version check, CM10, exit codes, `--json`) |
| `src/core/` | integrator | Shared modules: `runtime`, `git`, `github`, `config`, `tasks`, `secrets`, `state`, `worktrees`, `project`, `changes`, `protection` (section 3) |
| `src/commands/setup/`, `src/commands/join/` | lane-a | `setup` (also `--resume`, `--regenerate`) and `join` |
| `src/internal/` | lane-a | `hackwin internal hook <name>` (git hooks and Claude Code hooks) and `hackwin internal ci` |
| `src/generate/` | lane-a | Generators and templates of every committed file of section 6.4, and the generated file manifest |
| `src/commands/take/`, `src/commands/ship/` | lane-b | `take` and `ship` |
| `docs/verification.md` | lane-b | The result of step 1.2 |
| `src/commands/gate/`, `src/commands/status/` | lane-c | The Gate (process, status issue, pipeline) and `status` |
| `test/cli/`, `test/core/`, `test/harness/`, `test/integration/` | integrator | Tests of shared code, the test harness, the cross-lane tests of step 1.7 |
| `test/commands/setup/`, `test/commands/join/`, `test/internal/`, `test/generate/` | lane-a | Lane A's tests |
| `test/commands/take/`, `test/commands/ship/` | lane-b | Lane B's tests |
| `test/commands/gate/`, `test/commands/status/` | lane-c | Lane C's tests |
| Everything else | integrator | `package.json`, the lockfile, root configuration, `.github/`, `AGENTS.md`, `CLAUDE.md`, `owners.yml`, `README.md`, `docs/` |

- The registry in `src/cli` maps each command to its module path in this table and loads it lazily. The foundation creates no file inside a lane directory, and no lane ever edits `src/cli`.
- Tests are found by glob, so a lane adds tests only under its own test directories.
- Step 1.1 created the empty directories of the layout with a `.gitkeep` file. A role may delete the one in its own directory once the directory holds a real file.
- The `open` list is empty: `README.md` is the release README and belongs to the integrator in this build.
- **A rule of this build only.** All pull requests of this build may come from one GitHub account, so the integrator checks a pull request against the role of its task (section 8, step 3). The product does not do this: HackWin checks scope against the roles that the pull request's author holds (G11, 8.4), and the `pre-commit` hook checks against the roles of the committing member (E1). No lane builds the task-role rule into the product; issues #8, #9 and #22 say so.

## 3. Interfaces that keep the lanes apart

Each row is a place where two owners would otherwise edit the same file, and the integrator interface, fixed in the foundation, that removes the need. `docs/build/contracts.md` (task 1.3a) gives the names, inputs, outputs and errors of each.

| Shared need | Would otherwise be edited by | Integrator interface | Task |
| --- | --- | --- | --- |
| Adding commands to the CLI, including `internal hook` and `internal ci` | A, B, C | Command registry with fixed module paths per lane, lazy loading, and the command module contract | 1.3a |
| Exit codes, short output and `--json`, "run in" and block messages | A, B, C | `src/core/runtime` and the runner | 1.3a |
| Terminal or wrapper: `take` prints the prompt inside a session, `gate` refuses to start there | A writes the wrappers; B and C react | Caller kind: `terminal`, `claude-code` (wrappers set `HACKWIN_CALLER=claude-code`), `non-interactive` | 1.3a |
| All git and GitHub access | A, B, C | `src/core/git`; `src/core/github` with one executor seam and typed helpers. A call that only one lane makes goes through the executor inside that lane | 1.3a |
| Pull request body with `Closes #<N>` | B writes; A (CI) and C (Gate) read | Body format in the contracts; the task link parser in `src/core/tasks` | 1.3a, 1.3b |
| Dependencies | A, B, C | `package.json` is the integrator's; the foundation installs what the specification implies; a lane asks for anything else | 1.3a |
| Configuration, identity, version check, fast-forward of the main checkout | A, B, C | `src/core/config` and the runner wiring | 1.3b |
| Scope check | A (pre-commit, PreToolUse, CI), B (`ship`), C (Gate stage 3) | Ownership functions in `src/core/config` | 1.3b |
| Task block, queue, readiness, task link, branch name | A (CI, `join`), B (`take`, `ship`), C (Gate, `status`) | `src/core/tasks` | 1.3b |
| Labels | A creates them (`setup`); B and C set them | Label catalogue and status transitions in `src/core/tasks` | 1.3b |
| Secret scan | A (pre-commit, CI), B (`ship`), C (Gate intake and stage 4) | `src/core/secrets` | 1.3b |
| Check record | B writes it (`ship`); A reads it (`pre-push`) | `src/core/state` and its format | 1.3c |
| Join record and personal settings | A writes them (`join`); B reads them (`take`) | `src/core/state` | 1.3c |
| Last main commit per worktree and the summary of changes on main | B (`take` prompt), A (`SessionStart`) | `src/core/state`, `src/core/changes` | 1.3c |
| Worktree paths, removal of merged worktrees, `core.hooksPath` repair | A (`join`), B (`take`, `ship`) | `src/core/worktrees` | 1.3c |
| Install, check, tests, format check, generated file check | A (CI, `join`, PostToolUse), B (`take`, `ship`), C (Gate stage 7) | `src/core/project` | 1.3c |
| Fixtures, fake GitHub, fixture repositories, accounts | A, B, C | `test/harness` | 1.3d |
| Protection state | A (`setup` reads its rules back), C (Gate header, status issue) | `src/core/protection` | 1.3e |

Three things stay inside one lane and need no shared file: the generated file manifest and its generators (lane A, built in order by 1.4a to 1.4d), the status issue format (lane C: the Gate writes it, `status` reads it through the parser in `src/commands/gate`), and the prompt (lane B).

## 4. Criteria that need more than one lane

| Criterion | Parts and where they are built | Closed by |
| --- | --- | --- |
| AC2 | Soft mode in `setup` (1.4f), the `pre-push` hook (1.4a), the joined clone (1.4e): all lane A | 1.4f |
| AC4 | Validation (1.3b), CI (1.4b), `setup` (1.4d) | 1.4d |
| AC6 | Files and rollback (1.4d), `join` rerun (1.4e), `setup --resume` (1.4f) | 1.4f |
| AC18 | The `pre-push` hook (1.4a) with the check record format (1.3c) | 1.4a, moved from lane B |
| AC31 | Keep awake and heartbeat (1.6a), the stale warning of `status` (1.6f) | 1.6f |
| AC54 | Stale generated files fail CI (1.4b); `pre-push` and `pre-commit` (1.4a); `core.hooksPath` repair in `take` (1.5c) and `ship` (1.5d) | 1.7b, moved from lane B |
| AC58 | The wrapper only calls the CLI (1.4c); `gate` refuses outside a terminal (1.6a) | 1.6a, checked again through the generated wrapper in 1.7c |
| AC70 | `setup` reports the state (1.4f); Gate header and status issue (1.6a, 1.6b); one shared reader (1.3e) | 1.7b, moved from lane A |
| AC76 | Version check (1.3b); install skip (1.3c, used by `join` 1.4e and `take` 1.5b); `setup` identity and `codex` refusal (1.4d) | 1.7d, moved from lane A |
| AC80 | Push protection (1.4f); blocks at commit (1.4a), in CI (1.4b) and by the Gate (1.6c) | 1.7b, moved from lane A |
| AC14, AC32, AC33, AC47, AC63, AC65, AC66, AC67, AC71, AC77 | Several lanes each, as the step table says | 1.7a to 1.7d |

AC12 (`join` not completed) and AC44 (`status` after `join`) use another lane's state only through the harness fixtures, so they close in their own lane (1.5a, 1.6f).

Coverage of the 54 criteria of Phase 1: lane A closes 8 (AC1 to AC6, AC18, AC55), lane B 9 (AC11 to AC13, AC15 to AC17, AC52, AC53, AC72), lane C 23 (AC21 to AC31, AC34, AC35, AC42, AC44, AC56 to AC58, AC60 to AC62, AC78, AC79), the integration tasks 14. A task that closes a part lists it as a test id `AC<n>/<part>`.

## 5. Tasks

Waves: 1 is 1.1, 1.2 and the foundation 1.3a to 1.3d; 2 is 1.3e and the lanes; 3 is the integration. Brief sections are those of `docs/HackWin-build-phase-0-1.md`. Deadlines (section 9, decision 1): wave 1 `2026-10-17T23:59:00+02:00`, wave 2 `2026-11-01T23:59:00+01:00`, wave 3 `2026-11-06T23:59:00+01:00`; 1.1 has none.

| Step | Issue | Task | Owner | Owned paths | Depends on | Brief sections | Closes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | #1 | Build workflow: rules, ownership map, task plan, CI | `integrator` | `AGENTS.md`<br>`CLAUDE.md`<br>`owners.yml`<br>`docs/build/**`<br>`.github/**`<br>`**/.gitkeep` | None | 0, 20.3; PRD 1.4, 3, 4 | None |
| 1.2 | #2 | Platform verification: docs/verification.md | `lane-b` | `docs/verification.md` | #1 | 5.6, 20.5 | None (the result goes into the release notes) |
| 1.3a | #3 | Foundation: package, CLI skeleton, git and GitHub access, contracts | `integrator` | `package.json`<br>`package-lock.json`<br>`.gitignore`<br>`.npmrc`<br>`.nvmrc`<br>`tsconfig*.json`<br>`*.config.*`<br>`.prettierrc*`<br>`.prettierignore`<br>`.editorconfig`<br>`bin/**`<br>`src/cli/**`<br>`src/core/runtime/**`<br>`src/core/git/**`<br>`src/core/github/**`<br>`test/cli/**`<br>`test/core/runtime/**`<br>`test/core/git/**`<br>`test/core/github/**`<br>`docs/build/contracts.md`<br>`.github/workflows/test.yml` | #1 | 0, 5.1, 5.4, 5.5, 6.4 (last paragraph), 7.0, 14 (test setup), A1, A2, A10 | None (blocks every lane) |
| 1.3b | #4 | Foundation: configuration, ownership, tasks, labels, secret scan, version check | `integrator` | `src/cli/**`<br>`src/core/config/**`<br>`src/core/tasks/**`<br>`src/core/secrets/**`<br>`test/cli/**`<br>`test/core/config/**`<br>`test/core/tasks/**`<br>`test/core/secrets/**` | #3 | 3.4, 3.5, 5.4, 6.1 to 6.3, 7.0 (CM9, CM10, CM12), 8.1, 8.2, 8.4, 9.2 stage 4, 10.5 (E1, E6, E11, E16), 20.6 | The validation part of AC4 (`AC4/validation`) |
| 1.3c | #5 | Foundation: local state, worktrees, project commands, changes on main | `integrator` | `src/core/state/**`<br>`src/core/worktrees/**`<br>`src/core/project/**`<br>`src/core/changes/**`<br>`test/core/state/**`<br>`test/core/worktrees/**`<br>`test/core/project/**`<br>`test/core/changes/**` | #3 | 5.3, 6.4 (local files), 7.2 steps 4, 5, 9, 7.7 steps 2, 5, 6, 7.9 steps 1, 5 to 9, 10.2 steps 7 to 9, 10.5 (E4, E5, E10, E13, E14, E20) | Part of AC76 (`AC76/install-skip`) |
| 1.3d | #6 | Foundation: test harness with the machine account | `integrator` | `test/harness/**` | #3, #4, #5 | 14 (test setup), 3.5, 5.4, 6.1, 8.1, 8.2 | None (blocks every lane) |
| 1.3e | #7 | Shared: protection state reader | `integrator` | `src/core/protection/**`<br>`test/core/protection/**` | #2, #3, #4, #5, #6 | 5.6 (protection rows), 7.1 steps 11 and 12, 7.5 step 7, 9.6, 10.6, A32 | None (used by 1.4f and 1.6a; AC70 closes in 1.7b) |
| 1.4a | #8 | Git hooks: pre-commit and pre-push | `lane-a` | `src/internal/hook/**`<br>`src/generate/**`<br>`test/internal/hook/**`<br>`test/generate/**` | #3, #4, #5, #6 | 10.3, 10.5 (E1, E2, E4, E6, E12, E18), 6.4 (.githooks), 7.2 step 5 | AC18 (moved from lane B); parts AC2/pre-push, AC47/commit, AC54/hooks, AC80/commit |
| 1.4b | #9 | CI workflow and internal ci | `lane-a` | `src/internal/ci/**`<br>`src/generate/**`<br>`test/internal/ci/**`<br>`test/generate/**` | #3, #4, #5, #6, #8 | 10.2, 6.4 (workflow row), 6.5, 20.6 step 4, A17, A48, A60 | Parts AC4/ci, AC47/ci, AC54/ci, AC71/ci, AC77/ci, AC80/ci |
| 1.4c | #10 | Claude Code settings, hooks and command wrappers | `lane-a` | `src/internal/hook/**`<br>`src/generate/**`<br>`test/internal/hook/**`<br>`test/generate/**` | #2, #3, #4, #5, #6, #9 | 10.4, 6.4 (.claude rows), 6.5, 5.5, 5.6 (rows 1 and 2), 7.0 CM1, 10.6, I13 | AC55; parts AC63/deny, AC67/wrappers, AC71/wrapper |
| 1.4d | #11 | setup: questions, detection, generated files, bootstrap commit | `lane-a` | `src/commands/setup/**`<br>`src/generate/**`<br>`test/commands/setup/**`<br>`test/generate/**` | #3, #4, #5, #6, #10 | 7.1 steps 1 to 9 and failure behavior, 6.1 to 6.5, 7.0 (CM3, CM11), 3.5, 20.1, A34, A45, A47, A61, A62 | AC3, AC4; parts AC6/files, AC76/setup |
| 1.4e | #12 | join | `lane-a` | `src/commands/join/**`<br>`test/commands/join/**` | #3, #4, #5, #6, #8 | 7.2, 6.4 (local files), 5.3, A35, A62 | AC5; part AC76/join |
| 1.4f | #13 | setup: labels, invitations, branch rules, push protection, resume | `lane-a` | `src/commands/setup/**`<br>`test/commands/setup/**` | #2, #3, #4, #5, #6, #7, #11, #12 | 7.1 steps 10 to 15 and failure behavior, 8.2, 5.6, 10.6, 7.0 CM3, A32, A47, D2, D19 | AC1, AC2, AC6; parts AC70/setup, AC80/setup |
| 1.4g | #14 | setup --regenerate | `lane-a` | `src/commands/setup/**`<br>`src/generate/**`<br>`test/commands/setup/**`<br>`test/generate/**` | #3, #4, #5, #6, #13 | 7.1 (--regenerate), 20.6, 7.0 CM12, A48, A60, D10 | Part AC77/regenerate |
| 1.5a | #15 | take: checks and the queue | `lane-b` | `src/commands/take/**`<br>`test/commands/take/**` | #3, #4, #5, #6 | 7.7 (preconditions, checks, without a number, failure behavior), 8.1, 8.3, 11.2, 3.4 | AC12, AC13, AC53; part AC65/take |
| 1.5b | #16 | take: worktree, labels, prompt and agent start | `lane-b` | `src/commands/take/**`<br>`test/commands/take/**` | #2, #3, #4, #5, #6, #15 | 7.7 steps 1 to 7 and failure behavior, 5.5, 5.6 (rows 3 and 4), 20.3 (I6, I10, I14), A9, A11 to A14 | AC11, AC72; part AC76/take |
| 1.5c | #17 | take: resume, release and fix prompt | `lane-b` | `src/commands/take/**`<br>`test/commands/take/**` | #3, #4, #5, #6, #16 | 7.7 (resuming and releasing), 8.3, A12, A35 | AC52; parts AC54/take, AC32/take |
| 1.5d | #18 | ship: merge main and local checks | `lane-b` | `src/commands/ship/**`<br>`test/commands/ship/**` | #3, #4, #5, #6 | 7.9 steps 1 to 9 and failure behavior, 8.4, 10.5 (E1, E4, E6, E10, E12 to E14, E16), A15, A46 | AC15, AC17; part AC54/ship |
| 1.5e | #19 | ship: push, pull request, report and rerun | `lane-b` | `src/commands/ship/**`<br>`test/commands/ship/**` | #3, #4, #5, #6, #18 | 7.9 steps 10 to 15 and failure behavior, 8.4, 7.0 CM3, T1, T10 | AC16 |
| 1.6a | #20 | gate: process, lock, keep awake, state file, terminal input | `lane-c` | `src/commands/gate/**`<br>`test/commands/gate/**` | #2, #3, #4, #5, #6, #7 | 7.5, 9.1 (G1 to G6, G24), 9.6 (state file), 5.6 (keep awake), 10.3, A43 | AC30, AC58; part AC31/gate |
| 1.6b | #21 | gate: status issue | `lane-c` | `src/commands/gate/**`<br>`test/commands/gate/**` | #2, #3, #4, #5, #6, #20 | 9.1 (G25), 9.6 (status issue), 7.5 step 6, 5.6 (pinning, edit notification, body size, write limits), A55, D4 | AC62 |
| 1.6c | #22 | gate: intake and stages 1 to 6 | `lane-c` | `src/commands/gate/**`<br>`test/commands/gate/**` | #3, #4, #5, #6, #21 | 9.2 (intake, stages 1 to 6), 9.3, 9.4 (RS11), 9.5, 9.6 (attention), 9.1 (G7 to G12, G17, G18, G21, G26), 8.2, A23, A41, A53, D3, D16 | AC25, AC26, AC42, AC79; part AC80/gate |
| 1.6d | #23 | gate: stages 7 to 11 | `lane-c` | `src/commands/gate/**`<br>`test/commands/gate/**` | #3, #4, #5, #6, #22 | 9.2 (stages 7 to 11, flaky handling, semantic conflicts), 9.1 (G13 to G17, G19 to G22), 9.5, 5.6 (pinned merge, CI rerun), A11, A23, A35, A43, A44 | AC23, AC24, AC27, AC28, AC29, AC57 |
| 1.6e | #24 | gate: restarts, errors and repeated failures | `lane-c` | `src/commands/gate/**`<br>`test/commands/gate/**` | #3, #4, #5, #6, #23 | 7.5 (failure behavior), 9.1 (G3, G4, G23), 9.6 (attention closing, heartbeat gaps), 12, A24, A42, A54 | AC21, AC22, AC34, AC35, AC56, AC78 |
| 1.6f | #25 | status | `lane-c` | `src/commands/status/**`<br>`test/commands/status/**` | #3, #4, #5, #6, #23 | 7.6, 9.6, 7.0 (CM6, CM10), 8.1 (T11), A40 | AC31, AC44, AC60, AC61 |
| 1.7a | #26 | Integration: a task written by hand from take to merge | `integrator` | `test/integration/flow/**` | #14, #17, #19, #24, #25 | 7.0, 8.1, 8.3, 9.2, 20.3 (I2, I12) | AC32, AC33, AC65, AC71 |
| 1.7b | #27 | Integration: enforcement across layers | `integrator` | `test/integration/enforcement/**` | #14, #17, #19, #24, #25 | 10 (all), 5.4, 7.1 steps 11 to 13, 9.6 | AC47, AC54, AC63, AC70, AC80 |
| 1.7c | #28 | Integration: terminal and Claude Code parity, solo mode, command set | `integrator` | `test/integration/parity/**` | #14, #17, #19, #24, #25 | 5.5, 7.0 (CM1), 3.5, 20.3 (I13) | AC14, AC66, AC67 |
| 1.7d | #29 | Integration: version rule and a bug fix release in the same phase | `integrator` | `test/integration/release/**` | #14, #17, #19, #24, #25 | 20.6, 7.0 (CM12), 10.2, 7.1 (--regenerate) | AC76, AC77 |

## 6. Order of work

1. **1.1** first. Its pull request carries this plan and is merged before any other task starts.
2. **Wave 1.** 1.2 (`lane-b`) and 1.3a in parallel; then 1.3b and 1.3c in parallel; then 1.3d.
3. **Wave 2**, once 1.3a to 1.3d are merged:
   - Lane A: 1.4a, 1.4b, 1.4c, 1.4d, 1.4e, 1.4f, 1.4g. 1.4e may run beside 1.4d in a second session; their paths differ.
   - Lane B: `take` 1.5a, 1.5b, 1.5c and `ship` 1.5d, 1.5e. The two chains may run in two sessions.
   - Lane C: 1.6a to 1.6e; 1.6f after 1.6d, beside 1.6e.
   - Integrator: 1.3e after 1.2, before 1.4f and 1.6a need it.
4. **Wave 3.** 1.7a to 1.7d in parallel; their test directories differ.
5. **Step 1.8**, human: release 0.1.0 with the results of `docs/verification.md` and checklist 20.5.
6. **Manual check per release**, human, for 0.1.0 and every bug fix release. Automated tests never start a real Claude Code session (section 9, decision 9), so each release is checked once in a real Claude Code session with default permissions, and once with bypass permissions on:
   - an edit outside the role scope is blocked before the file changes;
   - `gh pr merge`, a merge through `gh api` and a push to main are refused;
   - after an edit only that file is formatted;
   - the session start summary appears;
   - `/take`, `/ship`, `/status` and `/gate` behave as in the terminal.
   These are AC14, AC55, AC58 and AC63. The result goes into `docs/test-log.md`.

## 7. Working on a task

1. Check that every issue in `depends_on` is closed and that no open pull request changes a file inside the task's paths (`gh pr list --state open`, then `gh pr diff <PR> --name-only`).
2. In the main checkout, create the worktree as `AGENTS.md` says.
3. Start a fresh session in the worktree with: "Work on issue #<N> in the worktree <absolute worktree path>, on the branch task/<N>-<slug>. Read the issue with `gh issue view <N> --comments`, including every comment that starts with "Scope change:", and follow AGENTS.md."
4. The session finishes as `AGENTS.md` says and stops with the pull request number and the full head SHA.

## 8. Merging

Only the integrator merges, one pull request at a time, and only when the human names it. Each step runs only when every earlier step passed.

| # | Step | How |
| --- | --- | --- |
| 1 | Fetch | `git fetch origin && git fetch origin "+pull/<PR>/head:pr/<PR>"`, then note both full SHAs with `git rev-parse origin/main pr/<PR>` |
| 2 | Task link | The branch starts with `task/`, the body says `Closes #<N>`, and issue N is open |
| 3 | Ownership | Every file of `git diff --name-only origin/main...pr/<PR>` lies inside the paths of the task's role in `owners.yml` (a rule of this build only, section 2). A file outside the task's own paths but inside the role is named in the merge report |
| 4 | Secrets | No added line matches a secret pattern and no env file other than `.env.example` is added |
| 5 | Conflicts | `git merge-tree --write-tree origin/main pr/<PR>` exits 0 |
| 6 | Merge test | In a scratch worktree `../HackWin.worktrees/pr-<PR>`: the pull request merged with the newest main, then `npm ci && npm test && npm run test:ac -- <ids of the task>` |
| 7 | CI | `gh pr checks <PR> --watch` until the check `test` succeeds on this head |
| 8 | Freshness | `origin/main` is still the SHA tested in step 6; otherwise repeat from step 5 |
| 9 | Merge | `gh pr merge <PR> --merge --match-head-commit <full head SHA>`, then delete the remote branch and the scratch worktree |
| 10 | Test log | Add the pull request's "Workflow notes" to `docs/test-log.md` on the branch `log/next`, as an entry in the format the file describes, newest first, writing only what was observed or measured |

**The test log.** Only the integrator's planning session edits `docs/test-log.md`, and it batches the updates:

1. Pending entries collect on one branch, `log/next`, in the worktree `../HackWin.worktrees/log-next`. When the branch does not exist, the integrator creates it from the current `origin/main`. Each entry is one commit, pushed to `log/next` at once.
2. At the end of each working session, or when the human says "close the day", the integrator merges `origin/main` into `log/next` (never a rebase) and opens one pull request from it. That pull request changes only `docs/test-log.md`.
3. The integrator merges it with steps 1, 7, 8 and 9. It has no task issue, so step 2 does not apply.
4. Then `log/next` and its worktree are deleted; the next entry starts the branch again from the new `origin/main`.

A failed step leaves one comment on the pull request with the step, the reason and the next action. A fix never lands on main directly: a conflict is resolved on the branch, and a problem that two pull requests cause together is fixed by a separate small task of the owning role.

## 9. Decisions on the open questions

The human answered the open questions of the setup on 10 October 2026. Each issue named below got its body changed and one "Scope change:" comment.

| # | Question | Decision | Issues changed |
| --- | --- | --- | --- |
| 1 | Deadlines | Wave 1 (1.2, 1.3a to 1.3d): `2026-10-17T23:59:00+02:00`. Wave 2 (1.3e and the lanes): `2026-11-01T23:59:00+01:00`. Wave 3 (integration): `2026-11-06T23:59:00+01:00`. 1.1 has none; PR #30 closes it | #2 to #29 |
| 2 | Accounts | `builder1` is `test-bot-builder`. `builder2` is `maljul`, a real teammate's account used only as a name in team configurations: it is never invited to any repository and nobody acts as it on real GitHub. Every test in which `builder2` acts runs against the fake GitHub. A live test that needs a second builder says so in its pull request instead of inviting this account. `solo` is the Lead's account | #6, #13 |
| 3 | Machine account credential | The harness reads `test-bot-builder`'s token from `HACKWIN_TEST_BUILDER_TOKEN`, which the human sets locally; 1.3a records the name in `docs/build/contracts.md`. CI of this repository holds no credential and runs only the offline suite. Tests on fixture repositories run locally | #3, #6 |
| 4 | Repositories for tests | No repository is ever deleted, and the `delete_repo` scope is never requested. Each lane has a fixture repository, `hackwin-fixture-a`, `hackwin-fixture-b` and `hackwin-fixture-c`, plus the private `hackwin-fixture-private` for the cases where GitHub refuses protection; the integration tasks use the lane fixtures. Before a test run the harness resets a fixture: close issues and pull requests, delete labels and rules, reset `main` to the recorded commit (table below). Automated tests never touch `hackwin-sandbox`; it is for the human's live tests | #2, #6, #7, #13, #26 to #29 |
| 5 | Versions before release 0.1.0 | `.tgz` packages from `npm pack`, attached to GitHub pre-releases of this repository and installed by URL. The major and minor numbers name the phase, so Phase 1 is `0.1`. Builds are `0.1.0-pre.<n>`. For AC77 the same code is also packed as `0.1.1-pre.<n>`, a bug fix of the same phase with a different patch number, and as `0.2.0-pre.<n>`, another phase. CM12 compares the major and minor numbers for the phase and semver precedence for older and newer, so `0.1.0-pre.<n>` < `0.1.1-pre.<n>` < `0.1.1`, and no npm release from step 1.8 on shares a version with a pre-release. The integrator creates a pre-release when the human asks. 1.3a records the scheme in `docs/build/contracts.md` | #3, #4, #9, #26, #29 |
| 6 | Package name | `hackwin`. It was free on npm on 9 October 2026, and `npm view hackwin` still returned 404 on 10 October 2026. The install command is `npm install -g hackwin@<version>`, or `npm install -g` with the URL of the `.tgz` for a pre-release | #3, #4 |
| 7 | Cases where GitHub refuses | The private fixture repository gives "no protection" and, if step 1.2 confirms it, "no push protection". A case that no real repository can produce is tested against the fake GitHub; step 1.2 decides which | #2, #13, #27 |
| 8 | Acceptance tests that do not exist | In v1 every `acceptance_tests` entry of a task block is a file path, and an entry that is not an existing file fails. The test ids in the issues of this build (`AC11`, `1.3a/registry`) are a convention of the build, run with `npm run test:ac` | #3, #5, #18 |
| 9 | Claude Code in automated tests | Tests feed recorded hook events to the handlers and run each wrapper's command line; no test starts a real headless Claude Code session. A manual check per release covers a real Claude Code session, also with bypass permissions on (section 6) | #10, #27, #28 |
| 10 | Machine account | `test-bot-builder` is the machine account of step 1.0 | #6 |
| 11 | Node version | The minimum is Node 22. The test workflow runs on Node 22 and 24; one job `test` that fails unless both runs succeeded stays the required check | #3, #11, #12 |

The answers to the setup review add one more rule: checking a pull request against the role of its task is a rule of this build only (section 2; issues #8, #9 and #22).

**Fixture repositories.** The integrator created them on 10 October 2026 as test infrastructure. It pushed the history of `hackwin-sandbox` up to its `main` after PR #1, which holds the template and the Node, Vite, Tailwind and TypeScript project. It then invited `test-bot-builder` to each with write access.

| Repository | Visibility | Used by | `main` and reset commit |
| --- | --- | --- | --- |
| `hackwin-fixture-a` | Public | Lane A; the integration tasks | `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` |
| `hackwin-fixture-b` | Public | Lane B; the experiments of 1.2 that change settings | `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` |
| `hackwin-fixture-c` | Public | Lane C; the integration tasks | `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` |
| `hackwin-fixture-private` | Private | The cases where GitHub refuses protection (AC2, and AC80 if 1.2 confirms it), in 1.4f and 1.7b; the experiments of 1.2 that change settings | `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` |

**Still open.** Nothing.
