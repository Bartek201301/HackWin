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

### 2026-10-12 · Phase 1 · Step 1.3e, the protection state reader (PR #42, issue #7)

- Setup: one builder session (Claude Code) in the worktree `task/7-protection-state-reader`, created by the integrator from `0468baa` at the start of wave 2, with `HACKWIN_TEST_BUILDER_TOKEN` set in its terminal. The integrator's planning session for the merge, without that variable.
- What happened:
  - The first commit, `297e930`, and PR #42 at 13:14:34 UTC. After the Lead's review, a commit `02c73ad` added `rules.bypassable` (the rules the Lead's account can bypass, besides the update restriction's `update`), and a merge of `origin/main` followed (`8b6a467`).
  - The Lead reviewed the head, the CI run and the five files, checked that the new field covers the review's two cases with tests and that `hackwin-fixture-b` was clean after the live runs, and asked for the merge, scope changes on #23 and #20, and the start of #41 and #20. The request arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8. Steps 1 to 5 passed: 5 files inside issue #7's paths, `docs/build/contracts.md` by its scope change; no secret pattern; no conflict with `a0610d7`. Step 6, with the PR merged into `a0610d7`: `npm test` passed 345 of 345, and the offline tests of `test/core/protection/protection.test.js` passed 28 of 28. The live part of `1.3e/protection` was not run, because the integrator's shell has no `HACKWIN_TEST_BUILDER_TOKEN`; the merge relied on the session's live run, as the Lead's review did. Main had not moved, and the merge was pinned to the head SHA.
  - After the merge: a scope change on #23 replaced the limit of `--admin` to `full-restricted` (the Gate uses `--admin` exactly when the update restriction is active, and requires `rules.bypassable` to be empty before each such merge), and one on #20 added the same check at the Gate's start. Worktrees for #41 and #20 were created at `104c2f5`.
- Problems, from the PR's "Workflow notes":
  - The fake GitHub of the harness answers no rule set request; the session registered the two reads in `test/core/protection/rulesets.js`, which 1.4f and 1.6a need too. Follow-up #46 moves them into the harness.
  - `docs/verification.md` did not record how `GET .../rules/branches/main` answers. The session made two read-only `gh api` calls outside the harness before writing the code: `[]` on `hackwin-fixture-b`, HTTP 403 on `hackwin-fixture-private`.
  - The first reset of `hackwin-fixture-b` deleted 10 labels an earlier run had left.
  - After the review, three runs of `npm run test:ac -- 1.3e/protection` failed on the network before a fourth passed: 2 failures with no cause captured; "net/http: TLS handshake timeout" in the account check; "unexpected end of JSON input" on the reset's `DELETE` of a rule set, which left three rule sets on `hackwin-fixture-b` until the next reset deleted them. In the same minutes 2 of 3 read-only `inspectFixtureRepo` calls failed. The integrator's own `gh` calls hit "TLS handshake timeout" twice on this day as well (after the merges of #40 and #45).
- Measured:
  - PR open 3 h 9 min (13:14:34 to 16:23:09 UTC), including the Lead's review and one fix.
  - 3 commits (one a merge of `origin/main`), 2 PR runs (42 s on `297e930`, 54 s on `8b6a467`), 0 conflicts.
  - Live runs of `1.3e/protection` in the session: 3 failed on the network, then 1 passed.
  - Local merge test: `npm test` 18.23 s. The run on main after the merge: 48 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/42; head `8b6a467`; merge commit `104c2f5`; runs `38258354126` (last PR run) and `38277024545` (main).

### 2026-10-12 · Phase 1 · Step 1.5a, take: checks and the queue (PR #45, issue #15)

- Setup: one builder session of lane B (Claude Code) in the worktree `task/15-take-checks-queue`, created by the integrator from `0468baa` at the start of wave 2, beside the sessions of #7, #8 and #18. The integrator's planning session in the main checkout for the merge.
- What happened:
  - One commit, `cc0398f` (13:25:35 UTC); PR #45 opened at 13:26:37 UTC; main had not moved.
  - The Lead asked for the merges of #44, #43 and #45 in that order, in pasted text; the integrator asked for and got a confirmation first. #45 was the third.
  - Merged with the procedure of the plan, section 8. Steps 1 to 5 passed: 6 files inside issue #15's paths, the two `.gitkeep` files of its directories removed; no secret pattern; no conflict with `a265588`, main after #44 and #43. Step 6, with the PR merged into `a265588`: `npm test` passed 317 of 317, and `npm run test:ac` passed AC12 (6), AC13 (5), AC53 (1) and AC65/take (2). Main had not moved, and the merge was pinned to the head SHA. The `gh pr view` after the merge failed with "TLS handshake timeout"; the cleanup commands that followed ran.
- Problems, from the PR's "Workflow notes":
  - Missing interface: check 4 needs `createMatcher` and `samplePath`, which `src/core/config/index.js` does not export. The human decided to import them from `src/core/config/glob.js` directly; `holderOf` is not exported either, so `take` finds the holder of a role itself. Follow-up #46.
  - Unclear instruction: 7.7 has "issue N is an open task" as a precondition (exit 2) and "the task is open" in check 2 (exit 1); the session chose exit 2 for a closed issue.
- Measured: PR open 16 min 41 s (13:26:37 to 13:43:18 UTC); 1 commit, 1 PR run (39 s), 0 conflicts; local merge test `npm test` 19.90 s; the run on main after the merge 53 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/45; head `cc0398f`; merge commit `a0610d7`; runs `38255731525` (PR) and `38257680242` (main).

### 2026-10-12 · Phase 1 · Step 1.5d, ship: merge main and local checks (PR #43, issue #18)

- Setup: one builder session of lane B (Claude Code) in the worktree `task/18-ship-merge-checks`, created by the integrator from `0468baa` at the start of wave 2. The integrator's planning session for the merge.
- What happened:
  - One commit, `1bc56f8` (13:19:43 UTC); PR #43 opened at 13:20:44 UTC; main had not moved.
  - The second of the three merges. Steps 1 to 5 passed: 7 files inside issue #18's paths, the two `.gitkeep` files removed; no secret pattern; no conflict with `cca0d36`, main after #44. Step 6, with the PR merged into `cca0d36`: `npm test` passed 285 of 285, and `npm run test:ac` passed AC15 (6), AC17 (2) and AC54/ship (1). Main had not moved, and the merge was pinned to the head SHA.
  - The Lead's review found that the check record #43 writes matches what the `pre-push` hook of #44 reads (contracts 5.2).
- Problems, from the PR's "Workflow notes":
  - The contracts and the brief name no local place for the logs of `ship`'s steps, while 7.9 says a failed step names its log. The session wrote them under the temporary directory, `$TMPDIR/hackwin-ship/`. Follow-up #46 chooses a place.
  - `formatCheck` and `generatedFileCheck` take no log file (contracts 4.9), so steps 5 and 6 print only the tail.
  - Two tests first failed because `fixture.publish` on a pushed task branch starts from the remote branch, so `ship` fast-forwarded instead of merging; a few minutes lost, no harness change needed.
- Measured: PR open 21 min 43 s (13:20:44 to 13:42:27 UTC); 1 commit, 1 PR run (52 s), 0 conflicts; local merge test `npm test` 20.14 s; the run on main after the merge 58 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/43; head `1bc56f8`; merge commit `a265588`; runs `38255038505` (PR) and `38257579617` (main).

### 2026-10-12 · Phase 1 · Step 1.4a, git hooks: pre-commit and pre-push (PR #44, issue #8)

- Setup: one builder session of lane A (Claude Code) in the worktree `task/8-git-hooks`, created by the integrator from `0468baa` at the start of wave 2. The integrator's planning session for the merge.
- What happened:
  - One commit, `6707437` (13:21:31 UTC); PR #44 opened at 13:22:52 UTC; main had not moved.
  - The first of the three merges. Steps 1 to 5 passed: 15 files inside issue #8's paths, the two `.gitkeep` files removed; no secret pattern; no conflict. Step 6: the head already contained main `0468baa`. `npm test` passed 267 of 267, and `npm run test:ac` passed AC18 (2), AC54/hooks (2), AC2/pre-push (1), AC47/commit (1), AC80/commit (1) and 1.4a/shims (4). Main had not moved, and the merge was pinned to the head SHA.
  - After the three merges, scope changes went to #11 (the bootstrap commit and push with the member hooks off, because the hooks of #44 block both on the default branch) and #10 (the Claude Code hooks apply CM12 as the git hooks do), and follow-up #46 was opened.
- Problems, from the PR's "Workflow notes":
  - `mainRef` and the raw-version fallback of `loadCheckedConfig` in `src/cli/main.js` are not exported. The hook keeps its own copy of `mainRef` and imports `pinnedVersionOf` and `HACKWIN_FILE` from `src/core/config/load.js` instead of the module index. Follow-up #46.
  - The harness fixture's commits run git without a `hackwin` command on PATH, so the hook tests write their own wrapper in `test/internal/hook/hook-fixture.js`.
- Measured: PR open 16 min 47 s (13:22:52 to 13:39:39 UTC); 1 commit, 1 PR run (49 s), 0 conflicts; local merge test `npm test` 17.11 s; the run on main after the merge 45 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/44; head `6707437`; merge commit `cca0d36`; runs `38255292216` (PR) and `38257247949` (main).

### 2026-10-12 · Phase 1 · Step 1.3d, the test harness with the machine account (PR #40, issue #6)

- Setup: one builder session (Claude Code) in the worktree `task/6-foundation-test-harness`, created by the integrator from `536c133` after the merge of #38, beside the session of #37; restarted by the human with `HACKWIN_TEST_BUILDER_TOKEN` set. The integrator's planning session in the main checkout for the merge, without that variable.
- What happened:
  - The session made two commits and one merge of `origin/main`, and opened PR #40 at 11:29:53 UTC. After the Lead's review at `0115127`, a last commit, `5a04be2`, kept the Node fixture as one text file, `test/harness/node-project.yml`, instead of a working copy with the template's `CLAUDE.md`, `AGENTS.md`, `.claude/` and `.agents/` inside this repository.
  - The PR reports the live runs of the session: on `hackwin-fixture-a` and `hackwin-fixture-private`, two resets each, a scenario as the Lead and a credential run as `test-bot-builder`; `hackwin-fixture-b` and `-c` untouched; the token occurred 0 times in the output and the run logs.
  - The Lead reviewed the head, the CI run and the files, checked that no agent file is tracked under `test/harness` and that the recorded tree equals that of `bf2af03`, and asked for the merge, a docs task and a wave 2 proposal. The request arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8:
    - Steps 1 to 5 passed: 21 files, all inside issue #6's paths (`test/harness/**`, `vitest.config.js`); no conflict. In step 4 only two added lines contained `eyJ`, both in `test/harness/node-project.yml`: line 2587, a `sha512` integrity hash of the fixture's `package-lock.json`, which matches the pattern, and line 487, the guide's pattern text. No agent file is tracked under `test/harness`. GitHub gives `dd1e605a2bd588e38de2fa5dacc034996f16d5f5` as the tree of `bf2af03`, the tree the file records.
    - Step 6: the head already contained main `ef15bb4`. `npm ci` and `npm test` passed 234 of 234 on Node 25.8.1. `npm run test:ac` passed `1.3d/fixture` (4) and `1.3d/fake-github` (10). The live ids `1.3d/fixture-repo` and `1.3d/no-credential-output` were not run, because the integrator's shell has no `HACKWIN_TEST_BUILDER_TOKEN`; the merge relied on the session's live run, as the Lead's review did.
    - Main had not moved, and the merge was pinned to the head SHA. The `gh pr view` after the merge failed with "TLS handshake timeout", which skipped the deletion of the remote branch in the same command chain; it was deleted afterwards. Both worktrees were removed.
  - Docs task #41 opened; its `gh issue create` answered HTTP 504, but the issue existed when listed, so it was not created twice.
- Problems, from the PR's "Workflow notes":
  - `HACKWIN_TEST_BUILDER_TOKEN` was not set in the first session, so the two live acceptance tests could not run there; the human restarted the session with it set.
  - Before the human set the rule to reach GitHub only through the harness, the session read the four fixture repositories and the login `hackwin-test-builder3` directly with `gh api`, read only; all later calls went through the harness.
  - The human's review before the push changed two decisions: guard every name-only login, and leave `main` as the only branch after a reset.
  - The Lead's review at `0115127` found the fixture's agent files inside this repository; the Claude Code documentation the PR cites says such files load for a session that opens a file in their directory. Fixed by the single text file and a test that fails on such names under `test/harness`.
  - `origin/main` moved during the task (#39); the merge had no conflict.
- Measured:
  - PR open 1 h 1 min (2026-10-12 11:29:53 to 12:31:17 UTC), including the Lead's review and one fix.
  - 4 commits (one a merge of `origin/main`), 2 PR runs (39 s on `0115127`, 38 s on `5a04be2`), 0 conflicts.
  - Local merge test: `npm test` 11.44 s.
  - The run on main after the merge: 41 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/40; head `5a04be2`; merge commit `0468baa`; runs `38244452664` (last PR run) and `38249551778` (main); docs task #41.

### 2026-10-12 · Phase 1 · Foundation follow-up: parseBranch, Config and the decisions of #36 and #38 (PR #39, issue #37)

- Setup: one builder session (Claude Code) in the worktree `task/37-foundation-follow-up`, created by the integrator from `536c133` after the merge of #38, beside the session of 1.3d (#6); the first message named `gh issue view 37` and `gh issue view 37 --comments`. The integrator's planning session in the main checkout for the merge.
- What happened:
  - The session made one commit, `1a951b9` (10:50:37 UTC), and opened PR #39 at 10:51:25 UTC; main had not moved.
  - The Lead reviewed the head, the CI run and the three files, found no test changed and the contracts entries matching item 3 and the scope change, and accepted the two deviations the PR describes. The merge request was typed directly, so no confirmation was needed.
  - Merged with the procedure of the plan, section 8:
    - Steps 1 to 5 passed: `docs/build/contracts.md`, `src/core/project/index.js` and `src/core/worktrees/index.js`, all inside issue #37's paths; no secret pattern; no conflict.
    - Step 6: the head already contained main `536c133`. `npm ci` and `npm test` passed 197 of 197 on Node 25.8.1, and `npm run test:ac` for the five ids of issue #37 passed 20 tests. Inspection: no `taskIssueOf` and no `ProjectConfig` remain; `src/core/worktrees` imports `parseBranch`, `src/core/project` imports the type `Config`, and section 6.4 names `builder2` as `maljul`.
    - Main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
- Problems, from the PR's "Workflow notes" and "Remaining limitations":
  - `gh issue view 37 --comments` again printed only the comment, not the body. The first message named both commands, so no time was lost.
  - `parseBranch` and the removed `taskIssueOf` differ on branch names that `branchName` never makes: `task/0` and `task/0-x` now give issue 0, `task/05-x` gives issue 5, and `task/5-a/b` gives no task. The issue said both "its behavior does not change" and "stop when `parseBranch` does not fit", so the session asked the human instead of choosing; the human chose `parseBranch`. No test covers these names.
  - Unsupported glob syntax is a `ConfigError` in `owners.yml` and the `paths` groups, but makes a task block invalid in `parseTaskBlock`; the contracts record both, as 1.3b's code does.
- Measured:
  - PR open 11 min 6 s (10:51:25 to 11:02:31 UTC), including the Lead's review.
  - 1 commit, 1 PR run (38 s: `node 24` 23 s, `node 22` 30 s, `test` 4 s), 0 conflicts.
  - Local merge test: `npm test` 11.62 s.
  - The run on main after the merge: 39 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/39; head `1a951b9`; merge commit `ef15bb4`; runs `38238935495` (PR) and `38240108915` (main).

### 2026-10-12 · Phase 1 · Step 1.3b, configuration, ownership, tasks, secret scan, version check (PR #38, issue #4)

- Setup: one builder session (Claude Code) in the worktree `task/4-foundation-configuration-tasks`, created by the integrator from `218091d` after the merge of #33, beside the session of 1.3c (#5); the integrator's planning session in the main checkout for the merge.
- What happened:
  - The session made one commit, `63e0271` (2026-10-11 22:31:44 UTC), merged `origin/main` without a conflict (`16bd91c`; main had moved by #36) and opened PR #38 at 22:32:56 UTC.
  - The Lead reviewed the head, the CI run and the files, spot-checked the tests of `1.3b/secrets-lockfile` and `1.3b/task-block`, and accepted the three choices the PR asked about. The request to merge arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8:
    - Steps 1 to 5 passed: 26 files, all inside issue #4's paths; no conflict. In step 4 the secret patterns matched five added lines, all of them the scanner's own regular expressions in `src/core/secrets/index.js` or synthetic values in `test/core/secrets/secrets.test.js`, which the tests assemble at run time; no env file was added.
    - Step 6: the head already contained main `8ee2d9c`. `npm ci` and `npm test` passed 197 of 197 on Node 25.8.1, and `npm run test:ac` for the eleven ids of issue #4 passed 76 tests.
    - Main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
  - After the merge: the decisions of #38 and the `builder2` correction went to #37 as a scope change; `docs/build/contracts.md` left the paths of #6, so that #6 and #37 share no path; both issue bodies were updated and #37 was retitled. Worktrees for #6 and #37 were created at `536c133`.
- Problems, from the PR's "Workflow notes":
  - `gh issue view 4 --comments` printed only the three comments, not the issue body; the session read the body with `gh issue view 4 --json`. The human pointed this out during the task; a comparison with `gh issue view 4` changed nothing.
  - 1.3a's tests `test/cli/runner.test.js` and `test/cli/registry.test.js` assumed an empty `prepareContext`; without changes they would fail on an unconfigured repository and call the real `gh`. The session moved them to a configured fixture with a fake `gh`, inside its own paths.
  - The contract made `ctx.identity` present for every prepared command, which does not work for the plumbing commands: hooks must stay offline and the caller in CI is not a member. The runner now prepares the six user commands only; #37 records it in the contracts.
  - `test/core/config/fixtures.js` is a small fixture helper written because the harness (1.3d) was not merged.
- Measured:
  - PR open 11 h 53 min (2026-10-11 22:32:56 to 2026-10-12 10:26:18 UTC), including the Lead's review.
  - 2 commits (one a merge of `origin/main`), 1 PR run (34 s: `node 24` 24 s, `node 22` 27 s, `test` 3 s), 0 conflicts.
  - Local merge test: `npm test` 9.35 s, `npm run test:ac` 5.75 s.
  - The run on main after the merge: 38 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/38; head `16bd91c`; merge commit `536c133`; runs `38180863915` (PR) and `38236320356` (main).

### 2026-10-11 · Phase 1 · Step 1.3c, local state, worktrees, project commands (PR #36, issue #5)

- Setup: one builder session (Claude Code) in the worktree `task/5-foundation-state-worktrees`, created by the integrator from `218091d` after the merge of #33, beside the session of 1.3b (#4); the integrator's planning session in the main checkout for the merge.
- What happened:
  - The session made one commit, `71e78f2` (2026-10-11 22:17:04 UTC), merged `origin/main` without a conflict (`3351429`; main had moved by #34) and opened PR #36 at 22:18:05 UTC.
  - The Lead reviewed the head, the CI run, the files and spot-checked the acceptance tests, and asked for the merge and a follow-up task. The request arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8. Steps 1 to 5 passed: 8 files, all inside issue #5's paths; no secret pattern in the added lines; no conflict. Step 6: the head already contained main `afc3b6c`. `npm ci` and `npm test` passed 104 of 104 on Node 25.8.1, and `npm run test:ac` for the eight ids of issue #5 passed 35 tests (7, 5, 4, 3, 4, 3, 5 and 4). Main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
  - Follow-up task #37 opened, to start once #4 is merged.
- Problems, from the PR's "Workflow notes":
  - `gh issue view 5 --comments`, the command of the plan's first message (section 7, step 3), printed only the comments and not the issue body in the non-interactive session; the session read the body with `gh issue view 5 --json body`. The Lead reported reproducing it with gh 2.88.1. The integrator observed the same with gh 2.88.1 in its own non-interactive shell: 24 lines with the two "Scope change:" comments and no line of the body, while `gh issue view 5` printed the body. From now on the first message names both commands; the plan follows with the next plan change.
  - 1.3b (#4) ran in parallel and was not merged, so `parseBranch` and `Config` were missing. The session added a private branch parser, `taskIssueOf`, and a local type, `ProjectConfig`, although the scope change of #5 says not to add a second version of a helper. Follow-up #37 replaces both.
  - `docs/build/contracts.md` lies outside the task's paths, so the decisions the session made where the contracts are silent are listed in the PR description only. #37 records four of them.
- Measured:
  - PR open 8 min 40 s (2026-10-11 22:18:05 to 22:26:45 UTC), including the Lead's review.
  - 2 commits (one a merge of `origin/main`), 1 PR run (26 s: `node 24` 18 s, `node 22` 17 s, `test` 4 s), 0 conflicts.
  - Local merge test: `npm test` 6.23 s, `npm run test:ac` 2.29 s.
  - The run on main after the merge: 31 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/36; head `3351429`; merge commit `8ee2d9c`; runs `38179872394` (PR) and `38180451660` (main); follow-up issue #37.

### 2026-10-11 · Phase 1 · Step 1.2, platform verification (PR #34, issue #2)

- Setup: one builder session of lane B (Claude Code) in the worktree `task/2-platform-verification`, created by the integrator from `42eaead`; the `gh` login `Bartek201301`; experiments on `hackwin-fixture-b` and `hackwin-fixture-private` with the human's agreement; the integrator's planning session in the main checkout for the merge.
- What happened:
  - First round, 2026-10-10: documentation, local experiments L1 to L3 and GitHub experiments E1 to E4 from 23:44 to 23:49 UTC; one commit, `04a8714`, and PR #34 opened at 23:57:58 UTC.
  - After the Lead's review, 2026-10-11: experiment E5 (a required check pinned to GitHub Actions, and `--admin`) from 21:32 to 21:34 UTC on `hackwin-fixture-b`, and L4 (a macOS notification while the human watched); a second commit, `e02e53c`, and a merge of `origin/main` (`a85f159`).
  - The Lead's second review approved the head and asked for the merge and for scope changes. The request arrived inside pasted text, so the integrator asked for and got a confirmation first.
  - Merged with the procedure of the plan, section 8:
    - Steps 1 to 5 passed; the only file was `docs/verification.md`, inside lane B's paths.
    - Step 6: the head already contained main `218091d`, so the merged tree was the head's. `npm ci` and `npm test` passed, 66 of 66. `npm run test:ac` was skipped on the Lead's instruction, because issue #2 has inspection criteria only and no test ids. The integrator's own reading of the document matched both inspection criteria.
    - Main had not moved, and the merge was pinned to the head SHA. The remote branch and both worktrees were removed.
  - After the merge, nine "Scope change:" comments went to #7, #10, #13, #16, #17, #21, #23, #27 and #28; no issue body changed.
  - Read back at the log entry: `hackwin-fixture-b` has `main` at `bf2af03`, no ruleset and only the branch `main`. Its issue and PR numbers 1 to 7 are taken: PRs #1 and #4 merged into deleted scratch branches, PRs #2, #5, #6 and #7 and issue #3 closed.
- Problems, from the PR's "Workflow notes":
  - `docs/build/contracts.md`, named under "Read first", did not exist during the first commit, because 1.3a (#3) was not merged yet. The task did not need it.
  - `package.json` did not exist at the first push, so `npm test` first ran after `origin/main` was merged for the second commit.
  - The refusal of a merge by a builder's account (row 6) could not use `test-bot-builder`, because accounts come only through the harness (1.3d, #6), which does not exist yet. The Lead's account with the bypass removed stood in; AC63 covers the builder.
  - In the first round, two experiment steps went beyond the list the human agreed to, on the same fixture and undone: the update restriction ruleset was switched to `disabled` and back, and after 65,537 characters was accepted, 25 more body edits on issue #3 found the body limit.
  - The Lead's token has no `workflow` scope, so E5 could not add a workflow that produces a `hackwin` check. It pinned the fixture's existing Actions job `check` instead, and used `[skip ci]` for the PR that needed no Actions run.
  - GitHub cannot remove the experiments' PRs and issue on `hackwin-fixture-b`, so the harness (1.3d) cannot assume that numbers there start at 1.
  - `npm run test:ac` fails without an id, so a task whose acceptance criteria are all inspections cannot run it. The Lead decided that merge step 6 then skips it; recorded for the next plan change.
- Measured:
  - PR open 22 h 15 min (2026-10-10 23:57:58 to 2026-10-11 22:13:17 UTC), including two reviews of the Lead and experiment E5.
  - 3 commits (one a merge of `origin/main`), 2 PR runs of `test` (7 s on `04a8714`, before `package.json` existed; 26 s on `a85f159`), 0 conflicts.
  - Experiments on GitHub, as `docs/verification.md` records them: E1 to E4 from 23:44 to 23:49 UTC, E5 from its setup at 21:32:02 to its read back at 21:33:49 UTC. Local merge test: `npm test` 5.14 s.
  - The run on main after the merge: 28 s.
- Evidence: PR https://github.com/Bartek201301/HackWin/pull/34; head `a85f159`; merge commit `afc3b6c`; runs `38178346372` (last PR run) and `38179547413` (main); `docs/verification.md`, sections 6 (experiment log) and 4 (open questions).

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