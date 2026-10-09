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

### 2026-10-09 · Phase 0 · The template used by a fresh agent session

- Setup: `hackwin-sandbox` created from `hackwin-template`; one Claude Code session asked to build a small Node + Tailwind project.
- What happened: the session followed the template's `AGENTS.md` without being told to. It did not push to main, created its own worktree and the branch `foundation/node-scaffold`, and asked before opening a PR.
- Problems: none in the template. Local Node 25 gives an install warning (Vitest supports even Node versions); CI uses Node 24.
- Evidence: commit `98ec066` on `foundation/node-scaffold`.

### 2026-10-09 · Phase 0 · Build of Release 1

- Setup: one Claude Code session, prompt A, PRD revision 3 and the Phase 0 and 1 build brief.
- What happened: the session created the template files and the README. AC49 and AC50 passed; AC51 passed locally and needed a live run on GitHub; AC64 waited for human items of checklist 20.5.
- Problems found in the specification and the plan:
  - The PRD was uploaded first as revision 2, then as `HackWin-PRD-2.md`; renamed to `HackWin-PRD.md`.
  - "54 manual restarts" overstated the source, which counts 54 launches, most of them manual restarts. PRD and brief corrected.
  - The plan created the template with an MIT LICENSE, which every team would inherit. Removed.
  - The README merged "0 conflicting merges into main" and "8 branch-side conflicts" into one row. Split back so the 0 reads at a glance.
- Notes for Phase 1: the issue template's GitHub header must stay above HackWin's markers, so `setup` must leave it in place (6.5).
- Evidence: commits `65c2916` (template) and `ee5bb0c` (README); live AC51 run and v0 releases: to be added by the integrator.

### 2026-10-09 · Preparation

- Setup: public repositories `hackwin` and `hackwin-template` on a personal GitHub account, the sandbox repository, and one machine account added as a collaborator for automated tests.
- Problems: none.

## Ideas for the PRD

Observations that may become changes to the specification. Each stays here until the team decides.

- Phase 0 has no branch rules, so "only the Lead merges" is a convention. A step in the manual workflow guide could set them by hand.
- Claude Code mods could show a live HackWin status pane without tokens. Parked, because hard rules must also work in Codex.