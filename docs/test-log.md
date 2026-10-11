# HackWin test log

Every test of HackWin, while it is built and at real events, with what happened and what broke. This log is the raw material for the next case study, so it records only what was observed or measured.

**Who writes it.** Only the integrator session edits this file, so it never becomes a shared hotspot. Builder sessions put their observations into their PR description under the heading "Workflow notes", and the integrator copies them here when it merges the PR. A session that runs a live test writes its entry at the end of that test and hands it to the integrator.

**Entry format.** Newest entry first.

```
### YYYY-MM-DD · Phase N · what was tested
- Setup: repository, sessions, accounts
- What happened: in order, short
- Problems: each with its issue number, or "none"
- Measured: only numbers that were measured (time from task to merge, conflicts, Gate restarts, rule events, tokens)
- Evidence: commits, PRs, runs, releases
```

## Entries

### 2026-10-11 · Phase 1 · Step 1.3a, the foundation (PR #33, issue #3)

- Setup: one builder session (Claude Code) in the worktree `task/3-foundation-cli-skeleton`, created by the integrator from `42eaead`; the integrator's planning session in the main checkout for the merge; local Node 25.8.1, and Node 22.23.3 through `npx -p node@22`.
- What happened:
  - The builder session made one commit, `fd0645c`, and opened PR #33 on 2026-10-10 at 18:43:11 UTC. It reported `npm test` with 66 tests passing on Node 25.8.1 and on Node 22.23.3, the five acceptance ids with 9, 11, 6, 16 and 11 tests passing, and an `npm pack` installed into a scratch prefix that printed `0.1.0-pre.0`.
  - The PR's run was the first run of the new test workflow: `node 22`, `node 24` and the aggregating `test` all passed, and the required check `test` was met by the new aggregating job.
  - The human reviewed the head, the CI run and the files, and asked for the merge together with scope changes on #4 to #7, a new task for the runner script (#35) and the worktrees of #4 and #5. The request arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8:
    - Steps 1 to 5 passed. All 37 files lay inside issue #3's paths. No added line matched a secret pattern; `package-lock.json` had no line matching the guide's `eyJ` pattern. There was no conflict with `c4ff6af`.
    - Step 6 ran npm commands for the first time, in a scratch worktree with the PR merged into `c4ff6af`, on Node 25.8.1: `npm ci` added 53 packages, `npm test` passed 66 of 66, and `npm run test:ac` for the five ids passed 53 tests with 13 skipped, 0 failed.
    - The inspection of `.github/workflows/test.yml` passed: a matrix on Node 22 and 24 with `fail-fast: false`, and a job `test` that needs it, runs with `if: always()` and fails unless the matrix result is `success`.
    - Main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
  - After the merge, read for the scope change of #6: `hackwin-fixture-private` answered HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." on `GET rulesets` and `GET branches/main/protection`. `hackwin-fixture-b` had issue and PR numbers 1 to 7 in use, with PRs #4 to #7 of step 1.2's experiment E5 open.
- Problems, from the PR's "Workflow notes" and the merge:
  - The task's paths had no place for a runner script, so `test:ac` passes the ids through `sh -c` into `vitest.ac.config.js`. Follow-up task #35.
  - Tasks 1.3b and 1.3c cannot edit `package.json`, `src/core/git` or `src/core/github`, so this task added what they need ahead: `semver`, and the git helpers `changedFiles`, `addedLines`, `merge` with `ffOnly`, `configGet` and `configSet`.
  - Task 1.3d's paths had no Vitest configuration, so `vitest.config.js` loads `test/harness/setup.js` only once the file exists. #6 now has `vitest.config.js` in its paths and makes the load unconditional.
  - Issues #6 and #7 asked their tasks to write into `docs/build/contracts.md`, outside their paths. This task recorded the fixture repositories and their reset commit there itself; #6 and #7 now have the path.
  - Vitest 5.0 declares `node: ^22.12.0 || ^24.0.0 || >=26.0.0`, which leaves out the local Node 25.8.1, so Vitest 4.1.11 was chosen.
  - The branch started before #32 was merged, so the PR's "Remaining limitations" and section 6.4 of `docs/build/contracts.md` still say that `builder2`'s login is open; the plan names it `maljul`.
- Measured:
  - PR open 26 h 49 min (2026-10-10 18:43:11 to 2026-10-11 21:31:58 UTC), including the human's review.
  - 1 commit, 1 PR run (27 s from start to finish: `node 24` 17 s, `node 22` 19 s, `test` 3 s), 0 conflicts.
  - Local merge test: `npm test` 4.89 s, `npm run test:ac` 4.74 s.
  - The run on main after the merge: 27 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/33; head `fd0645c`; merge commit `218091d`; runs `38076913852` (PR) and `38176763352` (main); follow-up issue #35.

### 2026-10-11 · Phase 1 · Fixture repositories and builder2 recorded (PR #32, issue #31)

- Setup: the integrator's planning session (Claude Code) in the main checkout of `HackWin`; the task worktree `task/31-record-fixture-repositories`; the `gh` login `Bartek201301`; a fresh bare clone of `hackwin-sandbox` in the integrator's scratch directory.
- What happened:
  - The four fixture repositories were created with `gh repo create`: public `hackwin-fixture-a`, `hackwin-fixture-b`, `hackwin-fixture-c` and private `hackwin-fixture-private`. The history up to `bf2af03` was pushed from the bare clone, so the human's `hackwin-sandbox` checkout was not touched. Each `main` and default branch was read back from GitHub.
  - `test-bot-builder` was invited with write access to each; the pending invitations were read back. After the human accepted them, the collaborators read back showed `test-bot-builder` with write access on all four.
  - The human's first two answers named `builder2` only by a placeholder; the third named `maljul`, with the rule that the account is never invited and never acted as. It was recorded in section 9 of the plan and in `AGENTS.md` as a scope change of #31, which was retitled. None of the seven repositories had an invitation to `maljul` when read back.
  - Issues #2, #6, #10, #13 and #31 got "Scope change:" comments, #6 two of them.
  - Merged with the procedure of the plan, section 8. Steps 1 to 5 passed; the PR changed `AGENTS.md` and `docs/build/plan.md`, both integrator paths. The merge test had no npm commands to run, because no `package.json` exists on main or on the branch. `test` passed on the head, main had not moved, and the merge was pinned to the head SHA. The remote branch and the worktree were removed.
  - The human's merge request arrived inside pasted text, so the integrator asked for and got a confirmation before merging.
- Problems: none in the workflow. The PR's "Workflow notes" were written when it was opened and were not updated after the second commit: they say the PR changes only the plan and list issues #2, #6 and #10, while the second commit also changed `AGENTS.md` and issues #13 and #31 were also updated.
- Measured:
  - PR open 26 h 48 min (2026-10-10 18:11:00 to 2026-10-11 20:59:21 UTC).
  - 2 commits, 2 PR runs of `test` (7 s and 10 s from start to finish), 0 conflicts.
  - `test` on main after the merge: 7 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/32; head `ec51490`; merge commit `c4ff6af`; runs `38075184129` (last PR run) and `38174484564` (main); fixture reset commit `bf2af037ab756d7051e35bdd7e3f18c92eda45b5`.

### 2026-10-10 · Phase 1 · Step 1.1, the build workflow (PR #30)

- Setup: the integrator's planning session (Claude Code) in the main checkout of `HackWin`; the task worktree `task/1-build-workflow`; the `gh` login `Bartek201301`.
- What happened:
  - Issues #1 to #29 were created in the planned order, so no reference needed a correction.
  - Protection of main was applied and read back.
  - PR #30 got four more commits after it was opened: the human's test log, the integrator's log entries, the batching of log updates on `log/next`, and the setup review. The review set the deadlines and the decisions on the open questions, and added the rule that checking a PR against its task's role is a build rule only. It also edited 28 issue bodies, each with one "Scope change:" comment.
  - Merged with the procedure of the plan, section 8. Steps 1 to 5 passed; the only files outside the integrator's paths were 16 `.gitkeep` files of lane directories, the documented exception of 1.1. The merge test had no npm commands to run, because no `package.json` exists yet; the inspection checks passed. `test` passed on the head, main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
- Problems: none in the workflow. Tool observations:
  - `gh label list --search role:` listed one of the four new labels; `gh label list` listed all four.
  - `timeout` does not exist on this macOS machine; checks were watched with `gh pr checks --watch` in the foreground.
  - A `gh pr checks --watch` started seconds after a push reported "no checks reported"; the run appeared on the next call.
  - Two script errors of the integrator, both caught before any wrong write. A dash check with a doubled backslash tested the wrong characters and stopped the plan edit before it was written. zsh's `echo` expanded the `\n` escapes in `gh` JSON and broke `jq`; the check was redone in Python.
  - `hackwin-test-p0` no longer exists under that name; GitHub resolves it to `hackwin-sandbox`, same repository id.
- Measured:
  - PR open 23 h 55 min (2026-10-09 18:00:30 to 2026-10-10 17:55:51 UTC), including the human's review.
  - 5 commits, 4 PR runs of `test` (6 to 8 s each, from start to finish), 0 conflicts.
  - `test` on main after the merge: 7 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/30; head `237e8cb`; merge commit `42eaead`; runs `38073564736` (last PR run) and `38073732901` (main).

### 2026-10-09 · Phase 0 · The manual PR recipe on hackwin-sandbox (PR #1)

- Setup: `hackwin-sandbox`, created from the template; PR #1 from `foundation/node-scaffold`, the project of the next entry; the PR recipe of the template's `docs/hackwin/manual-workflow.md`, section 7.
- What happened: the template's `check` workflow passed on head `98ec066`. After confirming that main had not moved, the PR was merged with `gh pr merge --merge --match-head-commit`. The merge commit `bf2af03` has the previous main `1ab7694` as its first parent. The remote branch and the worktree were removed. The `check` run on main after the merge passed.
- Problems: the secret check of the recipe (stage 4) flagged line 1985 of `package-lock.json`. That line is the `sha512` integrity hash of a package; it contains `eyJ` and matches the guide's example pattern `eyJ[A-Za-z0-9_-]{20}`. A false positive. Phase 1: the shared secret scanner must not raise on it, task 1.3b (#4).
- Measured: PR check 13 s; 45 s from opening the PR to the merge (17:35:41 to 17:36:26 UTC); check on main after the merge 20 s.
- Evidence: PR https://github.com/Bartek201301/hackwin-sandbox/pull/1; runs `37967385729` (PR) and `37967471681` (main after the merge); commits `98ec066` and `bf2af03`.

### 2026-10-09 · Phase 0 · The template used by a fresh agent session

- Setup: `hackwin-sandbox` created from `hackwin-template`; one Claude Code session asked to build a small Node + Tailwind project.
- What happened: the session followed the template's `AGENTS.md` without being told to. It did not push to main, created its own worktree and the branch `foundation/node-scaffold`, and asked before opening a PR.
- Problems: none in the template. Local Node 25 gives an install warning (Vitest supports even Node versions); CI uses Node 24.
- Evidence: commit `98ec066` on `foundation/node-scaffold`.

### 2026-10-09 · Phase 0 · Build of Release 1

- Setup: one Claude Code session, prompt A, PRD revision 3 and the Phase 0 and 1 build brief.
- What happened: the session created the template files and the README. AC49 and AC50 passed; AC51 passed locally and needed a live run on GitHub; AC64 waited for human items of checklist 20.5.
- Live AC51 run: passed. `hackwin-test-p0` was created from the template; it has since been renamed `hackwin-sandbox`, and GitHub resolves the old name to the same repository id, 1412187262. On the push of its initial commit `1ab7694`, whose tree equals the template's v0 commit `65c2916`, the template's `check` workflow ran and succeeded. Its steps were the checkout and the placeholder check; no step installed HackWin.
- Measured: the live AC51 `check` job took 4 s.
- Problems found in the specification and the plan:
  - The PRD was uploaded first as revision 2, then as `HackWin-PRD-2.md`; renamed to `HackWin-PRD.md`.
  - "54 manual restarts" overstated the source, which counts 54 launches, most of them manual restarts. PRD and brief corrected.
  - The plan created the template with an MIT LICENSE, which every team would inherit. Removed.
  - The README merged "0 conflicting merges into main" and "8 branch-side conflicts" into one row. Split back so the 0 reads at a glance.
- Notes for Phase 1: the issue template's GitHub header must stay above HackWin's markers, so `setup` must leave it in place (6.5).
- Evidence: commits `65c2916` (template) and `ee5bb0c` (README); live AC51 run https://github.com/Bartek201301/hackwin-sandbox/actions/runs/37963644613; releases v0, published 2026-10-09 at 17:14 UTC: https://github.com/Bartek201301/HackWin/releases/tag/v0 (tag on `ee3e335`) and https://github.com/Bartek201301/hackwin-template/releases/tag/v0 (tag on `65c2916`).

### 2026-10-09 · Preparation

- Setup: public repositories `hackwin` and `hackwin-template` on a personal GitHub account, the sandbox repository, and one machine account added as a collaborator for automated tests.
- Problems: none.

## Ideas for the PRD

Observations that may become changes to the specification. Each stays here until the team decides.

- Phase 0 has no branch rules, so "only the Lead merges" is a convention. A step in the manual workflow guide could set them by hand.
- Claude Code mods could show a live HackWin status pane without tokens. Parked, because hard rules must also work in Codex.
- The secret scan (E6, A41, G12) must not raise on package integrity hashes in lockfiles. On sandbox PR #1 the guide's example pattern `eyJ[A-Za-z0-9_-]{20}` matched a `sha512` hash in `package-lock.json`. In Phase 1 such a false positive would fail every PR that touches the lockfile and raise a secret attention item, which only the Lead's `ack` closes. Built into task 1.3b (#4) with a test; the example pattern in `manual-workflow.md` has the same flaw.
- Test ids in `acceptance_tests` need a runner-specific existence check. A file path can be checked for existence, a test id only by the runner that runs it. Decided on 10 October 2026: in v1 every entry is a file path, and an entry that is not an existing file fails.