# HackWin build brief: Phases 0 and 1

| Field | Value |
| --- | --- |
| Derived from | `HackWin-PRD.md`, revision 3 of 9 October 2026 |
| Authority | The PRD. This brief extracts what is needed to build Phase 0 and Phase 1 and adds or changes no requirement. Where the two differ, the PRD wins, and the difference is a defect of this brief |
| Reader | The coding agent that builds Phase 0 and Phase 1, and the team that reviews the result |
| Scope | Phase 0: Release 1, the template and the HackYeah case study. Phase 1: the CLI with `setup`, `join`, `take`, `ship`, `status` and `gate` without the Resolver |

## 0. How to use this brief

- Section numbers are the PRD's. A number that is missing here has no content for Phases 0 and 1. Cross references such as "(9.6)" therefore resolve in both documents.
- Phase 0 is specified in sections 20.1, 1.3 (the case study numbers), 6.4 (the files marked for the template), 6.5 (the markers), 17, 20.5 and the Phase 0 criteria of section 14. Phase 1 is specified in sections 5 to 14, 20.3 and 20.6.
- Identifiers are the PRD's and stay stable: GO goals, P principles, CM common command behavior, T task rules, G Gate, RS Resolver, E enforcement, SF shared files, H hotspots, M metrics, AC acceptance criteria, F HackYeah failures, K risks, C resolved contradictions, A assumptions, S suggestions, D team decisions, I interim behaviors between phases.
- "Must" marks a requirement. "Later" marks something the team decided to postpone; nothing marked "later" may be built in v1 (section 2.2). Nothing that the PRD places in Phase 2 or Phase 3 is built now. Where a PRD text says "from Phase 2 on" or "from Phase 3 on", this brief leaves that part out.
- `[ASSUMPTION An]` marks a choice the PRD made because no input settled it. Implement it as written.
- "Verify at build time" marks a capability of Claude Code, Codex, GitHub or an operating system that no input confirms. Check it against current documentation before relying on it, and implement the stated fallback when it does not hold. Section 5.6 lists every such item for these phases.
- Source tags and the evidence behind each requirement are in the PRD (sections 1, 16 and 18). This brief drops the source tags and keeps the decision tags, except in the acceptance criteria (section 14) and section 17, which are quoted from the PRD unchanged. There, [B] is the team's input brief "Brief: workflow zespołowy z agentami AI" of 8 October 2026 (not this build brief), [W] the HackYeah workflow brief, [P] the HackYeah PR gate post-mortem, [T] the HackYeah tooling inventory, and [R1] to [R12] the external research of PRD section 16.2.

**Decisions that shape these phases.**

| # | Decision |
| --- | --- |
| D1 | No hold for migrations and production config in v1; the project must not apply migrations automatically on merge, because the Lead applies them by hand |
| D2 | `setup` adds a GitHub rule so that only the Lead's account can update the default branch; mechanism verified at build time; soft blocks as the fallback; the Lead's own sessions are not covered |
| D3 | A secret found by the Gate is a fifth attention type that interrupts the Lead |
| D4 | One pinned status issue holds the Gate's heartbeat, open attention items and digest, updated by editing; `status` reads it on every machine |
| D6 | Names stay placeholders until the pre-publication check |
| D7 | Codex support is beta in v1; Claude Code and the plain terminal are fully supported |
| D8 | Four shippable phases, each usable at a real hackathon on its own |
| D9 | Planning by hand in Phase 1 is accepted |
| D10 | A project stays on the phase it started with; during a project only bug fix releases of that phase are installed |
| D11 | Release 1 is two repositories |
| D12 | The Lead works with Claude Code; `setup` refuses `codex` as the Lead's agent and says why |
| D13 | The mechanical conflict script stays in Phase 3, with the conflict classification |
| D15 | The preparation guide recommends an organization owned repository where a personal account offers no update restriction |
| D16 | A found secret also raises an operating system notification on the Lead's laptop; terminal bell as the fallback |
| D17 | The Lead applies and records a migration before `ship` (recommended; not enforced) |
| D18 | No tooling for demo data; hand written README status; terminal mode of `take` is primary |
| D19 | `setup` enables GitHub's secret scanning push protection where offered and reads it back; HackWin's own scans stay |

## 1. What the phases deliver

### 1.1 Summary

HackWin turns the method a 4-person team used at HackYeah 2026 into a repeatable tool for hackathon teams of 2 to 4 people (3 or more recommended), in which every member runs their own Claude Code or Codex sessions on one shared GitHub repository. The main promise is fast delegation without conflicts. The full v1 consists of a repository template, a CLI `hackwin` with 9 commands, git hooks and a CI workflow, the Gate (a process without an LLM on the Lead's laptop that tests and merges PRs one at a time), the Resolver (Phase 3), Claude Code hooks, and a metrics report (Phase 3).

| Phase | The release contains | With it a team can |
| --- | --- | --- |
| 0 | Release 1: the template and the HackYeah case study, with no call to the CLI (section 20.1 below) | Run the HackYeah method by hand, with shared rules, ownership written down and tasks as issues (I1) |
| 1 | The CLI with `setup`, `join`, `take`, `ship`, `status` and `gate` without the Resolver; the enforcement layers, the branch rules [D2] and push protection [D19]; the five attention types [D3] with the notification for a secret [D16]; the status issue [D4] | Hand a task to any member's agent with `take`, and let the Gate test and merge every PR in its own process. Tasks are planned and written by hand (I2, I3) [D9] |

A project stays on the phase it started with [D10]. Phase 1 must be usable at a real hackathon on its own [D8].

### 1.3 HackYeah numbers for the case study

One event, one team in one room (N = 1). The numbers come from git history, GitHub data and session logs.

| Measure | Value |
| --- | --- |
| Team and duration | 4 people, about 23 hours (first merge 3 Oct 11:23, last merge 4 Oct 10:21, local time) |
| Merged PRs | 133 (per author account: 50, 39, 32, 12); 2 closed without merge |
| Median PR size | 5 files, 262 changed lines |
| Merges into main that conflicted | 0 |
| Branch-side conflict merges | 8 |
| Production regressions after a merge | None observed |
| Lead conversation busy on watcher events | About 146 min in one night; median 1.9 min and p90 6.8 min per event |
| Launches of the watcher loop in one night | 54, most of them manual restarts |
| Tokens per PR event | About 2.4M; context per model call median 255 thousand, p90 500 thousand tokens |
| Conversation compactions overnight | 3, plus 1 stop at the usage limit |
| Deterministic share of the PR recipe | 9 of 10 steps needed no model |
| Plan usage in 24 hours | 3 Claude Max limits and about 50% of a Codex plan (200 USD tier) |

What worked, in order of importance: shared code had exactly one author; one role per directory, not one person; contracts frozen before code (H+0:45); small PRs on short branches from current `origin/main`, each in its own worktree; one merger, merges in order, a merge test on current main and CI on every PR; builder agent sessions had no right to merge.

The three costly problems: one blocked integrator session that planned, merged and fixed conflicts; prompts for teammates copied to Discord by hand; rules by convention, some of which broke (a push before checks finished, a migration applied before review, no branch protection).

## 2. Non-goals

| Non-goal | Reason |
| --- | --- |
| Teams larger than 4, or long-lived product teams | v1 targets only hackathon teams of 2 to 4, with 3 or more recommended |
| Advertising solo use | Solo mode exists as a special case for testing v1 |
| Orchestrating sessions with a central agent | HackWin competes on ownership rules, task flow and gates, a layer independent of the agent tool |
| Shipping project code | HackWin is a tool, not ready project code |
| A freeze mode before the demo | Rejected |
| Gate takeover by another member | Rejected: one Gate, always on the Lead's laptop |
| Task state as files in the repo (GNAP style) | Rejected: issues do the same without commits, noise or pull delay |
| Enforcing a structure for registries such as routing or menus | HackWin must work with every framework |
| A single owner for README or owned README sections | Rejected: everyone edits |
| A required human review step | HackYeah ran without approval gates or review requests |
| Dependence on GitHub merge queue | Not available for the repositories HackWin targets; the Gate runs the queue |
| Moving a running project to the CLI of a later phase | A project stays on the phase it started with (20.6) [D10] |

Decided as later, not v1 [D1]: the database and production config gate (section 9.5); model choice per agent and cost controls; a ban on test writes to the database before the demo (handled by hand in the task plan); the Resolver inside GitHub Actions; a Discord webhook for the digest; events instead of polling.

## 3. Roles and team shapes

### 3.1 System roles in Phases 0 and 1

| Role | Who or what | Responsible for | Never does |
| --- | --- | --- | --- |
| Lead | Human, exactly one per team | Decisions; writing the task issues in Phase 1 (I2); applying migrations and production config changes by hand; rotating a secret that the Gate finds [D3]; holds the shared ownership role; runs the Planner session, the Gate terminal and their own builder sessions for shared code and infrastructure | Nothing beyond the rules for every member in Phase 1 (E21 arrives with Phase 2) |
| Planner | The Lead's agent session in the main checkout | Answers to questions; in Phase 1 also writing task issues from the task issue template through `gh` (I2) | Merging |
| Builder | Every member including the Lead: a human with 1 or 2 agent sessions, 3 as an advanced option | Tasks inside their ownership scope; shipping PRs; resolving conflicts in their own files | Editing outside scope; merging |
| Gate | A separate process made of scripts, no LLM, on the Lead's laptop | The PR pipeline: scope, secrets, conflict detection, merge test, CI, merge in order, smoke test; digest; the status issue | Injecting anything into an agent conversation; committing on main |

The Resolver does not exist in Phase 1 (I7).

### 3.2 Sessions and terminals

| Person | Runs |
| --- | --- |
| Lead | One Planner session (main checkout); 1 or 2 builder sessions (one worktree per task); one Gate terminal |
| Every other member | 1 or 2 builder sessions (one worktree per task) |

The Lead's sessions run in Claude Code [D12]; every other member chooses Claude Code or Codex (beta [D7]). The number of builder sessions per person is chosen in `setup`: 1 or 2, with 3 as an advanced option that prints a warning. `take` never allows more running tasks than the person has disjoint tasks in scope.

### 3.3 Who runs which command (Phase 1)

| Command | Runner |
| --- | --- |
| `setup` | Lead, once |
| `join` | Every member, once per machine |
| `gate` | Lead, in a separate terminal |
| `status` | Everyone |
| `take`, `ship` | Builders, the Lead included |

### 3.4 Ownership roles

An ownership role is a named part of the codebase, for example `shared` or `workbench`. `owners.yml` maps path globs to ownership roles; `hackwin.yml` maps members to ownership roles.

- Every directory has exactly one ownership role.
- Every ownership role has exactly one holder at a time. A member may hold several roles.
- The Lead holds the role flagged `shared: true`. It covers shared code, infrastructure, contracts, dependencies and configuration.
- A role swap changes one line in `hackwin.yml`. Ownership stays with the directory. Open tasks follow the role, not the person: `take` checks who holds the role on main (7.7). Before a swap the affected members ship or close their open PRs, because the scope check uses the roles the PR author holds at check time `[ASSUMPTION A29]`.

### 3.5 Supported team shapes

| Members | Shape |
| --- | --- |
| 1 | Solo: one person is Lead and builder and holds every ownership role. A special case for testing v1; not advertised |
| 2 | Lead (shared role plus one feature role) and one builder |
| 3 | Lead (shared role) and 2 feature builders. Recommended minimum |
| 4 | Lead (shared role) and 3 feature builders. The HackYeah shape |

`setup` refuses more than 4 members `[ASSUMPTION A34]`. These rules do not change with team size: exactly one merge mechanism; shared code has one author; one role per directory; every agent session works in its own worktree and has no right to merge; database and production config changes go only through the Lead. In solo mode every rule still applies: the single member runs the Planner session, the builder sessions and the Gate, and the Gate serializes merges from that member's parallel sessions.

## 4. Design principles

| # | Principle |
| --- | --- |
| P1 | One filter for every feature: does it speed up delegation without conflicts, or does it only add process? |
| P2 | Rules are invisible until someone breaks them. A builder types `/take 42` and works; a block appears only on leaving scope |
| P3 | An LLM is used only where judgment is needed. Everything that can be written as a rule runs as a script or in CI |
| P4 | Project state lives on GitHub, not in repo files and not in one session's context. Any session, including a new one after a reset, can answer "what is happening now" |
| P5 | One writer per path: one ownership role per directory, and shared code has one author |
| P6 | Exactly one merge mechanism: the Gate. No agent session merges |
| P7 | Small PRs on short branches from fresh `origin/main`, one worktree per session |
| P8 | Contracts before code. Interfaces are frozen before parallel work starts |
| P9 | Hard enforcement is independent of the agent tool: it lives in the CLI, git hooks, CI and GitHub's rules. Agent hooks are convenience only. Section 10.6 lists the gaps where only an agent hook or an instruction stands |
| P10 | Reports instead of interrupts: one digest line per PR; the Lead is interrupted only for the five attention types (G18) |
| P11 | Never commit a fix on main. Textual conflicts are fixed on the PR branch, semantic conflicts in a separate small PR |
| P12 | Fail fast and in order: a step runs only when every earlier step succeeded |
| P13 | Every commitment is measured against the HackYeah baseline |

## 5. Architecture and state model

### 5.1 Components

| Component | What it is | Uses an LLM | Runs where |
| --- | --- | --- | --- |
| Template repository | Static starting files without any call to the CLI (Phase 0, section 20.1) | No | GitHub |
| CLI `hackwin` | All logic of the commands. Deterministic steps cost no tokens | No | Every member's machine and CI |
| Command wrappers | One Claude Code skill per command of the installed CLI version. A wrapper only calls the CLI and passes the result to the session. Codex wrappers arrive in Phase 3 (I10) | The session that calls it | Claude Code sessions |
| Git hooks | `pre-commit` and `pre-push` shims that call the CLI | No | Every clone and worktree |
| CI workflow | Scope, secrets, task link, generated file checks, merge test, project checks | No | GitHub Actions `[ASSUMPTION A3]` |
| Gate | Persistent process that tests and merges PRs one at a time | No | The Lead's laptop, own terminal |
| Claude Code hooks | `SessionStart`, `PreToolUse`, `PostToolUse` conveniences | No | Claude Code sessions only |
| GitHub | Issues, labels, PRs, comments and the Gate's pinned status issue: the shared state. Branch rules protect main | No | GitHub |

### 5.2 Flow in Phase 1

```
Lead                       GitHub                         Builder (each member)
----                       ------                         ---------------------
hackwin setup      ->  labels, CI, protection
task issues by hand ->  task issues               ->      hackwin take [N]
                                                          worktree + prompt + agent session
                       PR + issue report          <-      hackwin ship
Gate (no LLM):     <-  open PRs
  scope, secrets, conflict detection,
  merge test, CI wait, pinned merge, smoke
                   ->  merged main, labels, comments,
                       pinned status issue        ->      hackwin status (everyone)
```

No arrow leads from the Gate into any agent conversation (G1).

### 5.3 State model

Shared state lives on GitHub, rarely changing documents with one owner live in the repo, personal and machine state lives in local files. Task state is never stored as repo files.

| State | Lives in | Written by | Read by |
| --- | --- | --- | --- |
| Task: problem, expected result, role, allowed paths, dependencies, acceptance tests, deadline | GitHub issue body and labels | By hand in Phase 1 (I2) | `take`, `ship`, `status`, Gate, CI |
| Task assignment | Issue assignee | `take`; by hand | `take`, `status` |
| Task status | Issue labels and open or closed state | `take`, `ship`, Gate; the Lead for `cut` | `take`, `ship`, `status`, Gate, CI |
| Agent report: PR number, head SHA, checks run | Issue comment | `ship` | The team on GitHub; the later report |
| Scope change of a task | Issue comment starting with "Scope change:" | Planner or Lead | `take`, session start summary |
| Pull request | GitHub PR | `ship` | Gate, CI, `status`, `take` |
| Gate stage and result per PR | PR labels, and the Gate state file | Gate | `status`, `take` |
| Gate heartbeat, open attention items, digest with one line per PR | The pinned status issue [D4] | Gate | `status` on every machine |
| Failure notes | PR comment | Gate | PR author, `take` |
| Ownership map | `owners.yml` in the repo | Lead, through a PR after bootstrap | CLI, hooks, CI, Gate |
| Team, stack commands, Gate settings | `hackwin.yml` in the repo | `setup`, later the Lead through a PR | Everything |
| PRD, spec, design, contracts, epics outline, non-code list | `docs/hackwin/` and the contract paths | The Lead with the Planner, by hand in Phase 1 (I3) | Agents through task prompts |
| Agent rules and command skills | `AGENTS.md`, `CLAUDE.md`, `.claude/` | `setup` (generated) | Agent sessions |
| Answer language, explanation style, personal notes | Local files, never committed | `join` | The member's own sessions |
| Secrets | `.env.local` on each machine | The human, received from the Lead over a private channel | The application only. Agents never read or print it |
| Green check record per commit | Local, per clone | `ship` | `pre-push` hook |
| Last main commit seen per worktree | Local | `take`, session start summary | `take`, session start summary |
| Time of the member's last `status` call | Local | `status` | `status` |
| Gate queue, per PR state, local heartbeat, full digest history, logs, cache | Local on the Lead's laptop | Gate | Gate after a restart, `status` on the Lead's laptop |
| The Lead's log | Local on the Lead's laptop | Planner | Planner |

Local state is stored in the git common directory of the clone (`<git-common-dir>/hackwin/`), which every worktree of that clone shares and which git never commits `[ASSUMPTION A6]`. The data that the Phase 3 report reads (issue and PR timelines, git history, `ship` reports, the status issue, the Gate files) accumulates from Phase 1 on (I9).

### 5.4 Identity and permissions

- The CLI identifies the person by the login that `gh` is authenticated with and matches it to `team.members[].github` `[ASSUMPTION A4]`.
- The Gate, the Planner and the Lead's builder sessions all act under the Lead's GitHub account. HackWin uses no bot account `[ASSUMPTION A5]`.
- Every member needs write access to the repository. `setup` offers to invite members who lack it.
- No agent session has the right to merge or to push to main. Where the update restriction is active (5.6), GitHub refuses a merge by every account except the Lead's [D2]. That rule cannot tell the Lead from the Lead's own agent sessions, which share the account, so for them the block is the Claude Code deny rule [D2], present for every Lead because the Lead works with Claude Code [D12]. Section 10 states how each layer enforces the rule and which gaps remain (10.6).

### 5.5 Agent neutrality

| Where | Form in Phase 1 |
| --- | --- |
| Claude Code | `/take 42` |
| Terminal | `hackwin take 42`, which always works |

Both forms behave identically (CM1). Claude Code hooks and skills do not work in Codex, so hard enforcement lives in the CLI, the git hooks, CI, the Gate and GitHub. A Codex user runs the terminal commands and is bound by every hard rule from Phase 1 on; the Codex wrappers, the Codex hook configuration and the Codex start in `take` arrive in Phase 3 as a beta (I10).

### 5.6 Platform prerequisites to verify at build time

Check each item against current documentation and implement the fallback when a capability is missing. Record each result in the release notes (20.5).

| Capability | Used for | Fallback |
| --- | --- | --- |
| Claude Code exposes a project skill as a slash command with the same name | `/take` and the other Phase 1 commands | Generate `.claude/commands/<name>.md` wrappers |
| Claude Code `SessionStart`, `PreToolUse`, `PostToolUse` hooks and `permissions.deny` rules for Bash commands, including patterns that also cover a merge made through `gh api` | Early feedback for all rules; the block against a merge by the Lead's own sessions [D2] | Edit, push and env rules stay enforced by git hooks and CI. For a merge by the Lead's own sessions only `AGENTS.md` remains (10.6) |
| The Claude Code CLI accepts a working directory and an initial prompt at start | `take` in terminal mode | Print the prompt file path and the start command |
| A running agent session can continue its work in another working directory | `take` called inside a session (A12) | The wrapper prints the terminal command instead; the terminal mode is primary anyway [D18] |
| GitHub branch protection or rulesets on a public repository of a personal account, including a rule that also binds the repository owner | Full protection | Soft protection |
| A GitHub rule that lets only the Lead's account update the default branch of a public repository owned by a personal account [D2]. The documentation suggests a ruleset rule "Restrict updates" with a bypass list. To verify: that the rule exists for this repository type, that it also refuses a merge made through the API, that the bypass does not lift the PR and check requirements for the Lead, and that the rule exists for a public repository owned by an organization on GitHub Free, which the preparation guide recommends as the remedy [D15] | E3 | The soft blocks listed in section 10.6 [D2] |
| GitHub secret scanning push protection [D19]: for which repository types and plans it is available, how the Lead's token enables it from the command line, how the setting is read back, and whether a pusher can bypass a block | `setup` step 13; E6 | HackWin's own secret scans alone (E6); `setup` reports push protection as off |
| Pinning an issue from the command line | Status issue (G25) | The issue is found by its label `gate-status`, and `status` prints its link |
| Editing an issue body sends no notification [D4] | Status issue (G25) | None needed: the content stays correct, and members can mute the issue |
| The largest issue body that GitHub accepts | Status issue (9.6) | The Gate drops the oldest digest lines of merged PRs when GitHub refuses an edit for its size |
| GitHub's limits on write requests. The documentation names 5,000 requests per hour as the primary limit and 500 content generating requests per hour as a secondary one, and does not say whether an issue edit counts toward the second | Status issue interval, labels, comments | Raise `gate.status_issue_seconds` together with `gate.heartbeat_stale_seconds` (6.1) |
| Inviting a collaborator from the command line with the Lead's token | `setup` step 10 | `setup` prints the instruction to invite the member by hand |
| GitHub offers the file under `.github/ISSUE_TEMPLATE/` when an issue is created | Tasks written by hand (I2) | The body is copied from the template file by hand |
| `gh pr merge --merge --match-head-commit <full SHA>` (worked at HackYeah; needs the full SHA) | Pinned merge | None: required |
| `git merge-tree --write-tree` (git 2.38 or later) | Conflict detection | None: `join` fails on an older git |
| Rerunning the failed jobs of a CI run from the command line | G14 | No rerun: the run fails with the reason `ci-failed` and the Lead may type `retry` |
| A command that keeps the laptop awake while a process runs, per operating system | Gate keep awake | Gate prints a warning that it cannot prevent sleep |
| An operating system notification raised by a terminal process, per supported platform (macOS, Linux, Windows through WSL) [D16] | G26 | The Gate rings the terminal bell in its own terminal |

## 6. Configuration and generated files

### 6.1 `hackwin.yml` schema

Committed at the repository root. Written by `setup`, changed later only by the Lead through a PR. Hooks, CI and the Gate always read it from `origin/main`, never from the branch under test `[ASSUMPTION A17]`.

```yaml
schema: 1                         # integer, schema version of this file
cli_version: "<x.y.z>"            # CLI version the team pinned; CI installs exactly this

project:
  default_branch: main
  language: en                    # language of code, commits, issues and PRs (A37)
  event:
    start: "<ISO 8601 with offset>"   # H+0
    end: "<ISO 8601 with offset>"     # submission deadline

team:
  lead: "<github login>"          # exactly one, must appear in members
  members:                        # 1 to 4 entries
    - name: "<string>"
      github: "<login>"
      roles: [shared]             # ownership roles from owners.yml, at least one
      agent: claude               # claude | codex (beta [D7]); the Lead's is claude [D12]
      sessions: 2                 # 1 | 2 | 3 (3 prints a warning)

commands:                         # detected by setup, confirmed by the Lead
  install: "<command>"            # clean dependency install
  check: "<command>"              # full check; must pass without secrets
  test: "<command>"               # runs the test files or ids appended as arguments
  format: "<command>"             # formats only the files appended as arguments
  generate: null                  # command that rebuilds generated files, or null
  lockfile_regen: "<command>"     # rebuilds the lockfile from the manifest
  smoke: null                     # post merge smoke test, or null

paths:
  contracts: []                   # globs: frozen interface files
  generated: []                   # globs: files produced by commands.generate
  manifests: []                   # globs: dependency manifests, at least one
  lockfiles: []                   # globs
  gated:
    migrations: []                # globs
    production_config: []         # globs
  ledger: null                    # path of the migration ledger, or null

tasks:
  max_files: 10                   # a task with more allowed files produces a warning

gate:
  poll_seconds: 60
  ci_rerun_limit: 1
  repeated_failure_threshold: 2
  heartbeat_stale_seconds: 300
  status_issue_seconds: 120       # the status issue is edited once per this interval
  ci_timeout_minutes: 20
  step_timeout_minutes: 20
  known_flaky_tests: []           # test ids or file globs
  secret_patterns: []             # extra regular expressions, added to the built in list

resolver:                         # used from Phase 3 on
  enabled: true                   # false in a project set up before Phase 3 (I11)
  model: "<model id>"             # asked from Phase 3 on (I11)
  max_turns: 30
```

This brief writes `main` for the default branch; the CLI uses `project.default_branch` everywhere. In Phase 1 `setup` does not ask for the Resolver model, `join` and `gate` do not check the `claude` CLI for it, and `resolver.enabled` is false (I11).

Validation rules. Any violation makes every command exit with code 2 and name the key.

| Rule |
| --- |
| `team.members` has 1 to 4 entries; exactly one equals `team.lead` (A34) |
| Every role in `owners.yml` is held by exactly one member; every role a member lists exists |
| The role flagged `shared: true` is held by the Lead |
| The Lead's `agent` is `claude` [D12] |
| With one member, that member holds every role |
| `sessions` is 1, 2 or 3 |
| `commands.install`, `check`, `test`, `format`, `lockfile_regen` are non-empty |
| Every glob under `paths.contracts`, `generated`, `manifests`, `lockfiles` and `gated` resolves to the shared role in `owners.yml` |
| `paths.manifests` is not empty |
| `resolver.model` is set when `resolver.enabled` is true |
| `gate.status_issue_seconds` is smaller than `gate.heartbeat_stale_seconds` |

### 6.2 `owners.yml` schema

```yaml
schema: 1
roles:
  shared:
    shared: true                  # exactly one role carries this flag
    paths: ["src/shared/**", "src/app/**", "docs/**", ".github/**"]
  workbench:
    paths: ["src/features/workbench/**"]
  detection:
    paths: ["src/features/detection/**"]
open:                             # paths every member may edit
  - README.md
```

- A path matches at most one role. `setup` and CI reject overlapping globs.
- A path that matches no role and no `open` entry belongs to the shared role, so every file always has exactly one owner `[ASSUMPTION A16]`.
- `open` exists because everyone may edit the README. `setup` puts only `README.md` there.
- The example paths show the HackYeah layout. `setup` proposes globs from the real directory tree and the Lead confirms them.

### 6.3 Defaults

| Setting | Default |
| --- | --- |
| Team size | 2 to 4, solo allowed |
| Sessions per person | 1 or 2; 3 advanced with a warning |
| `tasks.max_files` | 10 |
| `gate.poll_seconds` | 60 |
| `gate.ci_rerun_limit` | 1 |
| `gate.repeated_failure_threshold` | 2 `[ASSUMPTION A24]` |
| `gate.heartbeat_stale_seconds` | 300 `[ASSUMPTION A36]` |
| `gate.status_issue_seconds` | 120 `[ASSUMPTION A36]` |
| `gate.ci_timeout_minutes` | 20 `[ASSUMPTION A36]` |
| `gate.step_timeout_minutes` | 20 `[ASSUMPTION A36]` |
| `resolver.max_turns` | 30 `[ASSUMPTION A36]` |

### 6.4 Files and objects

**Committed to the repository.** The column "Template" marks what Release 1 already contains (20.1); `setup` (Phase 1) writes every row in one bootstrap commit.

| Path | Content | Template | Later owner |
| --- | --- | --- | --- |
| `hackwin.yml` | Section 6.1 | No | Lead |
| `owners.yml` | Section 6.2 | Example | Lead |
| `AGENTS.md` | Short shared rules for every agent: scope and ownership; one task one PR; worktree and branch rules; merge `origin/main` and never rebase or force push; never push to main; never merge; never read or print `.env.local`; format only changed files; where to run commands; request shared changes from the Lead (I14); stop after `ship`; leave every database and production config change to the Lead, including applying migrations and changes made outside the repository. It names the project language for code, commits, issues and PRs (English by default), while each member's answer language stays personal `[ASSUMPTION A37]`. In the template it names no command (A59) | Yes | Lead |
| `CLAUDE.md` | Imports `AGENTS.md` | Yes | Lead |
| `.claude/settings.json` | Hooks (10.4) and `permissions.deny` for reading `.env`, `.env.local`, `.env.*.local`, for `gh pr merge`, a merge made through `gh api` and pushes to main. The template holds only the env file rules | Env rules only | Lead |
| `.claude/skills/<command>/SKILL.md` | One wrapper per command of the installed CLI version (I13) | No | Generated |
| `.claude/skills/research/SKILL.md`, `.agents/skills/research/SKILL.md`, `.claude/agents/research.md` | One research skill for both agents and one research subagent `[ASSUMPTION A39]` | Yes | Lead |
| `.githooks/pre-commit`, `.githooks/pre-push` | Shims that call `hackwin internal hook <name>` | No | Generated |
| `.github/workflows/hackwin.yml` | CI workflow (10.2) | No; the template has `check.yml` (20.1) | Generated |
| `.github/pull_request_template.md` | Task link, owner and scope, shared changes, verification list, migration line, remaining limitations | Yes | Lead |
| `.github/ISSUE_TEMPLATE/hackwin-task.md` | The issue body of section 8.1 with empty fields, for tasks written by hand (I2) | Yes | Lead |
| `.env.example` | Created empty when missing; belongs to the Lead | Yes, empty | Lead |
| `.gitignore` entries | `CLAUDE.local.md`, `.env.local`, `.env.*.local`, `hackwin-report.md`, `hackwin-report.json` | Yes | Lead |
| `docs/hackwin/before-the-event.md` | Preparation guide. The template must teach this step, not assume it. It covers: the event's rules on AI tools and on code written before the event; the research, the choice of stack and the accounts that make a fast contract freeze possible; the warning that the project must not apply migrations automatically on merge, which some database integrations do, because in v1 the Lead applies them by hand, with the order that section 9.5 recommends [D1][D17]; the recommendation to create the repository under an organization when GitHub offers no update restriction for a repository of a personal account (5.6) [D15]; the note that user level tools add latency and noise to every session | Yes | Static |
| `docs/hackwin/manual-workflow.md` | The HackYeah method by hand, for a team that uses only the template (I1): tasks written as issues from the task issue template; the prompt content of section 7.7 step 6; the HackYeah PR recipe, which the Gate keeps as the stages of section 9.2, run by the Lead in a terminal session that is not the planning conversation; planning by hand, with the foundation first and the other tasks after it (I3) | Yes | Static |
| `docs/hackwin/` skeletons | `prd.md`, `spec.md`, `design.md`, `epics.md`, `non-code.md`; filled by hand in Phase 1 (I3), by `plan` from Phase 2 | Yes | Lead |

Generated files carry a header naming the CLI version. CI fails when a generated file differs from what the pinned CLI version produces (E19) `[ASSUMPTION A48]`.

**Created on GitHub.**

| Object | Detail |
| --- | --- |
| Labels | By `setup`; section 8.2 |
| Branch rules on the default branch, including the update restriction [D2] | By `setup`; section 7.1 steps 11 and 12 |
| Secret scanning push protection, where GitHub offers it [D19] | By `setup`; section 7.1 step 13 |
| The pinned status issue [D4] | By the Gate at its first start; section 9.6 |
| Collaborator invitations | By `setup`, for members without write access, after confirmation `[ASSUMPTION A47]` |

**Local, never committed.**

| Path | Created by | Content |
| --- | --- | --- |
| `<git-common-dir>/hackwin/local.yml` | `join` | Login, answer language, explanation style, the record of a completed `join` |
| `CLAUDE.local.md` in the main checkout | `join` | Answer language and explanation style for Claude Code |
| `.env.local` | The human | Secrets. `join` only checks that the file exists |
| `<git-common-dir>/hackwin/checks/<sha>.json` | `ship` | Green check record for one commit |
| `<git-common-dir>/hackwin/sessions/` | `take`, session start summary, `status` | Last main commit seen per worktree; time of the member's last `status` call |
| `<git-common-dir>/hackwin/prompts/<issue>.md` | `take` | The composed prompt of a task |
| `<repo-parent>/<repo-name>.worktrees/<issue>-<slug>/` | `take` | One worktree per task `[ASSUMPTION A9]` |
| `<git-common-dir>/hackwin/gate/` (Lead only) | `gate` | `state.json`, `heartbeat`, `digest.log`, `gate.lock`, `logs/`, `cache/`, and `worktrees/` for the scratch worktrees |
| `<git-common-dir>/hackwin/lead-log.md` (Lead only) | Planner | The Lead's log |

The CLI is a Node.js package installed from npm with the binary name `hackwin`; Node is therefore required on every machine and in CI, also for projects on other stacks `[ASSUMPTION A1]`. The package name, the domain and the GitHub owner stay placeholders until the pre-publication check of section 20.5 [D6]. Version 1 supports macOS and Linux, and Windows through WSL `[ASSUMPTION A2]`. Hooks and CI call a plumbing namespace, `hackwin internal <name>`, that is not a user command `[ASSUMPTION A10]`.

### 6.5 Existing files

How `setup` treats a file that already exists, from the template or from the team's own work `[ASSUMPTION A45]`:

- `hackwin.yml`: its presence on main means the repository is configured (exit 2).
- `owners.yml`: an existing file is the starting proposal in step 4 of `setup`.
- Generated files (command wrappers, hook shims, the `hackwin` workflow): overwritten.
- The template's own CI workflow (`.github/workflows/check.yml`): removed when it is unchanged; kept, with a notice that the `hackwin` job now runs the project's check, when the team changed it.
- The research skill and subagent files: kept as they are.
- `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, the PR template, the task issue template, `.gitignore`, `.env.example`: existing content is kept. `setup` adds or replaces only its own block, marked `hackwin:begin` and `hackwin:end` (in JSON files: only its own keys and list entries).
- Documents under `docs/hackwin/`: created only when missing.

## 7. Command specifications

Phase 1 has six commands: `setup`, `join`, `gate`, `status`, `take` and `ship`. The CLI of Phase 1 offers exactly these, and `setup` generates wrappers only for them (AC67).

### 7.0 Behavior common to all commands

| # | Requirement |
| --- | --- |
| CM1 | Every command is a thin wrapper over the CLI, where all logic lives. `/take` in Claude Code and `hackwin take` in a terminal behave identically. |
| CM2 | Exit codes: 0 success; 1 a rule or check blocked the action; 2 configuration or precondition error; 3 GitHub or network failure. |
| CM3 | Every command can be rerun after a failure; `setup` is rerun as `setup --resume`. A rerun continues from the first unfinished step and never creates a second copy of an issue, label, PR, comment or worktree. |
| CM4 | Every message that tells a human or an agent to run something names the directory to run it in. |
| CM5 | A block names the rule, the files or objects involved, and the command that resolves it. |
| CM6 | Output is short by default, because long tool output costs tokens in the calling session; `--json` gives the full machine readable result. |
| CM7 | All GitHub access goes through `gh`, all repository access through `git`. |
| CM8 | Except `setup` during bootstrap, no command pushes to the default branch. After that it changes only through the Gate's merges of PRs (G15). |
| CM9 | Commands read `hackwin.yml` and `owners.yml` from `origin/main` after a fetch (A17). |
| CM10 | A command that runs in the main checkout first fast forwards it to `origin/main` when it is on the default branch with a clean tree; otherwise it warns that the checkout is behind `[ASSUMPTION A52]`. |
| CM11 | `setup` and `join` ask their questions in an interactive terminal, or read the answers from `--answers <file>`, so that a wrapper or a test can drive them `[ASSUMPTION A47]`. `gate` runs only in an interactive terminal. A typed confirmation means that the command prints what it is about to do and proceeds only when the human types `yes`. The answers file is YAML: it uses the key names of `hackwin.yml` for everything stored there, `roles` and `open` in the form of `owners.yml`, `invite` for the invitation question and, for `join`, `language` and `explanation_style` `[ASSUMPTION A61]`. |
| CM12 | Every command compares its own version with `cli_version` on `origin/main`. The releases of one phase differ only in the patch number, so the major and minor numbers name the phase `[ASSUMPTION A60]`. An older CLI, or a CLI of another phase, exits 2 and prints the install command for the pinned version [D10]. A newer bug fix release of the same phase prints a one line warning and continues (20.6). `setup` pins its own version. (The exception for `status --report` belongs to Phase 3.) |

Sub-flags named below (for example `take --release`) belong to their command and are not additional commands `[ASSUMPTION A10]`.

### 7.1 `setup`

Who: the Lead, once per project, before the event or at its start, in the main checkout of a clone of the team repository (created from the template, or any existing repository).

**Preconditions.** A git repository with a GitHub remote; `gh` authenticated as the Lead, with admin rights on the repository; a clean working tree on the default branch; no `hackwin.yml` on `origin/main`. `--resume` and `--regenerate` run on a configured repository instead (see the failure behavior).

**Steps.**

1. Check the preconditions and the versions of `git`, `gh` and Node.
2. Ask a few questions: number of people (1 to 4); who is the Lead; for each person the name, the GitHub login, the agent (`claude`, or `codex` as a beta [D7]) and the number of sessions (1 or 2; 3 is offered as advanced with a warning). When the login named as the Lead differs from the `gh` login, `setup` exits 2 and says so, because the branch rules, the Gate and the approvals are tied to the Lead's account `[ASSUMPTION A62]`. `setup` refuses `codex` as the Lead's agent and says why: the only block against a merge by the Lead's own sessions is the Claude Code deny rule (10.6), and from Phase 3 on the Resolver needs the `claude` CLI on the Lead's laptop [D12]. In an interactive terminal it then asks again; with an answers file it exits 2 `[ASSUMPTION A62]`.
3. Check that each login exists and whether it has write access.
4. Propose ownership roles and path globs from the directory tree. The Lead edits and confirms the role names and globs and assigns each role to one member; the shared role goes to the Lead. In an empty repository the Lead types the roles and globs; the HackYeah layout (one directory per feature role, everything else shared) is shown as an example.
5. Detect the stack commands (install, check, test, format, generate, lockfile regeneration) from the project files and show them for confirmation. The Lead only confirms or edits them. Detection for Node projects is required; for any other stack `setup` asks for each command it could not detect. It also asks for an optional smoke test command. It then proposes the path groups of `paths` that are known before planning: manifests and lockfiles from the detected stack and, where the project files show them, the migration directories, the production config files and the ledger. The Lead confirms, edits or leaves a group empty, except `manifests`, which must name at least the manifest of the planned stack; a group can be set later through a PR (I16) `[ASSUMPTION A62]`.
6. Ask for the event start and end.
7. Detect the repository visibility. Public is the default recommendation because a public repository gets full branch protection for free. `setup` never changes visibility itself.
8. Generate every committed file of section 6.4, treating files that already exist as section 6.5 states, and validate `hackwin.yml` and `owners.yml`.
9. Create the bootstrap commit on the default branch and push it. This is the only direct push to the default branch in the life of the project; it happens before any protection exists.
10. Create the labels of section 8.2 and, after confirmation, invite the members who lack write access.
11. Apply two sets of rules to the default branch and read both back from GitHub.
    - Rules for everyone, the repository owner included: changes only through a PR, the CI check `hackwin` required, force pushes and branch deletion blocked `[ASSUMPTION A32]`. "Require branches to be up to date" stays off, because the Gate's merge test on the newest main gives the same guarantee without a new CI run per merged PR (A32).
    - The update restriction: only the Lead's account can update the default branch, so GitHub refuses a merge by any other account [D2]. The exact mechanism is verified at build time (5.6). When it works through a bypass list, the restriction is a rule set of its own, so that the bypass does not lift the rules above for the Lead.
12. Fall back where GitHub refuses. Without the update restriction the rules for everyone still apply, and merges by agent sessions are blocked only softly (10.6) [D2]. Without any protection (a private repository on a free plan has none) `setup` switches to soft protection: the `pre-push` hook blocks pushes to main, agent sessions have no right to merge, and the Gate serializes merges. Work continues in both cases.
13. Enable GitHub's secret scanning push protection for the repository where GitHub offers it, and read the setting back [D19]. Availability and the exact setting are verified at build time (5.6). Where GitHub refuses it, `setup` reports push protection as off and continues. HackWin's own secret scans (E6) run in both cases.
14. Run the steps of `join` for the Lead's machine.
15. Print a summary: the protection state, whether push protection is on, the command each member runs (`hackwin join`), the next steps (`hackwin gate` in a separate terminal, then the first tasks written by hand) and a reminder to send `.env.local` to each member over a private channel.

The protection state (full with the update restriction, full without it, or soft) is not stored in a file. `setup` and `gate` read it from GitHub with the Lead's token. The Gate publishes it in the status issue, where `status` reads it on every machine (9.6).

**Outputs.** The committed files, the GitHub labels, the branch rules or a notice of the fallback in use, the push protection setting or a notice that it is off, the Lead's local files, the summary.

**Failure behavior.**

- A failure before the push of step 9 succeeds changes nothing on GitHub; `setup` removes its own commit and files, so the working tree is as it was.
- After that push, `hackwin setup --resume` repeats every step that did not finish.
- More than 4 people: exit 2 (A34).
- A second run on a configured repository: exit 2 with the message that configuration changes go through a PR by the Lead.
- `hackwin setup --regenerate` installs a bug fix release of the same phase (20.6). In the worktree of a task of the shared role it rewrites the generated files and HackWin's own blocks in the kept files (6.5) and sets `cli_version` to its own version, for the Lead to ship. A CLI whose phase differs from that of `cli_version` exits 2 [D10]. On the default branch it exits 2 and names that procedure.

### 7.2 `join`

Who: every member, the Lead included (`setup` runs it for the Lead), once per machine, after cloning the repository.

**Preconditions.** A clone whose `origin/main` contains `hackwin.yml`.

**Steps.**

1. Find the person: match the `gh` login to `team.members`.
2. Check `gh` authentication and write access to the repository.
3. Check git (including support for `merge-tree --write-tree`), Node, and the presence of the member's agent CLI.
4. Run `commands.install` in the main checkout. While no file matches `paths.manifests`, as in an empty repository before the foundation, the step is skipped with a notice `[ASSUMPTION A62]`.
5. Activate the git hooks: point `core.hooksPath` of the clone at `.githooks` and run the hooks' self test.
6. Ask for the answer language and the explanation style; write them to `local.yml` and `CLAUDE.local.md`. These are personal settings and never enter the repository.
7. Check that `.env.local` exists whenever `.env.example` lists at least one key. The file is never opened.
8. (Phase 3: the Codex hook flag. Not in Phase 1.)
9. Remove worktrees of tasks whose PR is merged (A35).
10. Show the member's queue, as `status` does.

**Outputs.** A checklist with one pass or fail line per step; the local files; active hooks; the queue. A run that exits 0 is recorded in `local.yml`: this record is what "`join` is complete" means in the preconditions of other commands.

**Failure behavior.** A failed check prints its fix and the command continues with the remaining checks; the exit code is 1 when any check failed. The login is not in the team: exit 2 with "ask the Lead to add you to `hackwin.yml`". Missing `.env.local`: exit 1 naming the Lead as the source. Rerunning is always safe.

### 7.5 `gate`

Who: the Lead, in a separate terminal on the Lead's laptop. Started once after `setup`, before the first PR; it runs for the whole event. Section 9 specifies the pipeline; this section specifies the process. Phase 1 has no Resolver.

**Preconditions.** The `gh` login equals `team.lead`; no other Gate holds the lock on this machine; the command runs in an interactive terminal. The `/gate` wrapper inside an agent session never starts the Gate: it prints the instruction to run `hackwin gate` in a separate terminal and says whether a Gate is already running. A Gate started inside a conversation would repeat the HackYeah failure (G1).

**Steps.**

1. Verify the identity. Anyone other than the Lead gets exit 2 with the message that there is one Gate, on the Lead's laptop, and that merges wait while it is down.
2. Take the lock file; a lock left by a dead process is replaced. Count the start in the state file: every start after the first is a restart (M7).
3. Start the keep awake mechanism of the operating system so the laptop does not sleep while the Gate runs.
4. (Phase 3: the Resolver check. Not in Phase 1.)
5. Load the state file. A PR that was inside the pipeline restarts at the first stage with its recorded head SHA; scratch worktrees are rebuilt.
6. Find the status issue by its label, or create and pin it at the first start, and write the first heartbeat into it, which clears an earlier stop time (G25).
7. Print the header: protection state, Resolver availability (in Phase 1: none, I11), poll interval, number of queued PRs, link of the status issue and, while `paths.gated` is empty, a notice that no attention line for a migration or a production config change can be raised (9.5).
8. Run the loop of section 9 until the Lead stops it.
9. Accept typed input in the Gate terminal while the loop runs: `retry <PR>`, which queues the PR's current head SHA again, as at intake, after a failure that needs no new commit, such as a CI timeout or a flaky test `[ASSUMPTION A43]`; `ack <PR>`, which closes the secret attention item of that PR once the Lead has rotated the secret (9.6); and `quit`, which stops after the current step and writes the stop time into the status issue.

**Outputs.** The running process; the state file, heartbeat and digest; the status issue [D4]; one digest line per PR in the terminal; labels and comments on PRs; merged PRs; attention lines for the five attention types [D3]; for a secret also an operating system notification (G26) [D16].

**Failure behavior.**

- The Gate never exits because of an event. An unexpected error inside one PR's pipeline marks that PR as failed with the reason `gate-error` and the loop continues with the next PR.
- GitHub or network failure: retry with increasing waits; the local heartbeat keeps recording that the loop is alive and separately when GitHub last answered. The status issue then shows an old heartbeat, which is the right signal for teammates.
- Crash or terminal closed: all progress is in the state file; `hackwin gate` resumes it. No other recovery step exists.
- Laptop asleep or off: merges wait until it returns. No other member can start a Gate.

### 7.6 `status`

Who: everyone, at any time. `status` answers: who does what, what waits for a merge, what is blocked, and what the Gate did. It is built from GitHub, so it gives the same answer in a new session after a reset and on every laptop.

**Preconditions.** A clone with `hackwin.yml` on `origin/main` and a working `gh` login.

**Steps.**

1. Read the open and recently closed issues, the open PRs, their labels and the milestone of the current wave from GitHub.
2. Read the status issue: heartbeat time, stop time, protection state, queue order, open attention items and digest [D4]. The Gate stage of each PR comes from its labels. On the Lead's laptop, also read the local heartbeat, which is newer than the issue between two edits.
3. Print the sections below in this order.

| Section | Content |
| --- | --- |
| Header | Protection state, as the Gate published it (unknown before the Gate's first start); time left to `project.event.end`; Gate liveness: the age of the heartbeat in the status issue, or "stopped by the Lead" after `quit`; the link of the status issue. No freeze state before Phase 2 (I15) |
| Attention | The open items of the five attention types (migration, production config, scope violation, repeated failure, secret), read from the status issue; they are addressed to the Lead and visible to everyone [D3][D4]. For the Lead also everything labeled `needs-lead`. For any member: their PRs labeled `needs-owner`, `gate:failed` or `scope-violation` |
| Who does what | Per member: tasks in progress with deadline, overdue tasks marked, the next ready tasks |
| Waiting for merge | The queue in order, each PR with its Gate stage |
| Blocked | Tasks blocked by dependencies, task issues with an invalid data block, and failed PRs, each with the reason |
| Gate digest | One line per PR processed since this member's previous `status` call, plus every PR that still needs action, taken from the status issue [D4] |

**Flags.** `--json` prints the data. `--report` arrives in Phase 3 (I9).

**Failure behavior.**

- GitHub unreachable: exit 3; on the Lead's laptop the local heartbeat is still printed.
- Stale heartbeat (older than `gate.heartbeat_stale_seconds`) without a stop time: on every machine the first output line is a warning with the heartbeat age. After `quit` the first line says instead that the Lead stopped the Gate, and when.
- No status issue exists: the header says that the Gate has not been started. This is not an error.

### 7.7 `take [N]`

Who: a builder, the Lead included, whenever one of the member's sessions is free. `take` removes the hand copied prompt: it checks the task, prepares an isolated worktree and starts the agent with a prompt composed on the member's machine.

**Preconditions.** `join` is complete; with a number, issue N is an open task.

**Checks** (all must pass):

1. Assignment: the caller holds the task's role in `hackwin.yml` on main, whoever the assignee is, so after a role swap the open tasks of a role belong to its new holder.
2. The task is open with a valid data block, is not in progress, in review or cut, and is not labeled `needs-lead`.
3. Every dependency is closed.
4. No open PR changes a file inside the task's allowed paths, and no other task in progress has overlapping allowed paths. Paths on the `open` list are exempt (H3, H6).
5. The caller runs fewer tasks than their `sessions` value. Together with check 4 this guarantees that a member never runs more sessions than they have disjoint tasks in scope.

Without a number, `take` picks the first task of the caller's queue (8.1) that passes all checks and prints which tasks it skipped and why.

**Steps.**

1. Fetch, verify that the git hooks are active and repair `core.hooksPath` when they are not (E20), and run the checks.
2. Remove the worktrees of the caller's tasks whose PR is merged `[ASSUMPTION A35]`.
3. Print a warning for each of the caller's PRs that waits for them (`needs-owner`, `gate:failed`, `scope-violation`).
4. Set the label `in-progress` in place of `ready` and make the caller the assignee, which claims the task before the slower steps, and add the `role:` label when a task written by hand lacks it.
5. Create the branch `task/<N>-<slug>` from the fresh `origin/main` and a worktree for it `[ASSUMPTION A9]`, or reuse both when an earlier `take` left them. Link `.env.local` and `CLAUDE.local.md` from the main checkout into the worktree `[ASSUMPTION A13]`. Run `commands.install` there, unless `join` would skip it (7.2 step 4); worktrees share the package manager's cache `[ASSUMPTION A11]`.
6. Compose the prompt locally from the issue, `AGENTS.md` and the rules of the role. The prompt contains, in this order:
   - the task: problem, expected result, acceptance tests, deadline as the hard stop time, and every "Scope change:" comment;
   - the role, its owned paths, and the statement that every other path must not be touched and that shared changes are requested from the Lead (I14);
   - where to run: the absolute worktree path and the branch name;
   - what changed on main since the main commit last recorded for this worktree by `take` or a session start or, for a new worktree, last recorded anywhere in this clone: the files that changed, the member's own scope first (E5, I6). The first `take` in a clone has no such commit and says so. `take` then records the current main commit for the worktree;
   - the finish rule: commit, run `ship`, then stop with the PR number and head SHA, and never merge;
   - the security rules: never read or print `.env.local`, and leave every database and production config change to the Lead, also changes made outside the repository;
   - the member's personal settings (answer language, explanation style), so they apply in both agents `[ASSUMPTION A14]`.
7. Start the agent. In a terminal, `take` launches Claude Code in the worktree with the prompt as the first message, which gives every task a fresh, cheap context. This terminal mode is the primary one [D18]. For a member whose agent is `codex`, `take` prints the prompt file and the command that starts Codex (I10). Called from inside a running session through `/take`, it prints the prompt and the session continues in the worktree `[ASSUMPTION A12]` (5.6).

**Resuming and releasing** `[ASSUMPTION A12]`.

- `take N` on the caller's own task that is `in-progress`, for example after a crash, a usage limit or a cleared session, reopens its worktree and composes a continue prompt: the seven parts of step 6 plus the state of the branch. When the task has no prompt file yet, because an earlier `take` stopped before step 6, `take N` finishes steps 5 to 7 with the first prompt instead.
- `take N` on the caller's own task that is `in-review` and whose PR is labeled `gate:failed` reopens the worktree, brings the local branch up to the remote branch and composes a fix prompt: the seven parts of step 6 plus the Gate's comment.
- `take N --release` returns the caller's `in-progress` task to `ready`, frees the session slot and keeps the branch for the next `take`.

For a resume, checks 2, 4 and 5 do not count the task itself or its own PR.

**Outputs.** The worktree and branch, the label and assignee change, the prompt file, the running session.

**Failure behavior.**

- A precondition fails: exit 2 naming the missing step, `hackwin join`.
- A failed check: exit 1 with the reason and the next action, for example "blocked by #<issue>, still open", "path collision with PR #<PR>: <file>" or "you already run <count> tasks: <list>".
- Empty queue: exit 0 with "queue empty"; the message tells the member to ask the Lead for the next wave, which is due when a queue runs out.
- The worktree cannot be created: the label and assignee change is undone, exit 2.
- `commands.install` fails in the worktree: exit 1 with the log. The worktree and the label stay, and a later `take N` finishes the remaining steps.
- The agent cannot be started: the worktree and label stay; the command prints the prompt file path and the start command.

### 7.9 `ship`

Who: the builder's session, or the builder, inside the task worktree, once the work is committed and the acceptance tests pass locally. `ship` merges main into the branch, runs the full tests and the acceptance criteria, opens the PR, reports in the issue and stops. It contains only deterministic steps.

**Preconditions.** The current directory is a task worktree on a `task/` branch; the working tree is clean; the task issue is open and `in-progress` or `in-review`.

**Steps.** A step runs only when every earlier step succeeded. This order is the fix for the HackYeah push that went out before its checks had finished.

1. Fetch `origin/main` and the task branch, read the task issue, and verify that the git hooks are active, repairing `core.hooksPath` when they are not (E20). If the remote branch has commits that the local branch lacks, merge them in first; a conflict there is handled as in step 2.
2. Merge `origin/main` into the branch. Never rebase, never force push. On a conflict, stop and list the files: the session resolves them, because the branch owner knows the intent of the change, commits and runs `ship` again. This includes conflicts in the README and, for the Lead, in shared files `[ASSUMPTION A46]`. A conflict that appears after `ship` is handed back by the Gate (I7).
3. Scope check on the branch's own changes: a file outside the author's roles and the `open` list blocks; a file inside the role but outside the task's allowed paths only produces a warning `[ASSUMPTION A15]`.
4. Secret scan of the added lines (E6).
5. Format check of the changed files only.
6. Generated file check (E10).
7. Full checks: `commands.check`.
8. Acceptance tests: every test named in the task exists and passes when run with `commands.test`.
9. Write the green check record for the head commit.
10. Push the branch. The `pre-push` hook accepts it because the record exists.
11. Open the PR, not as a draft, from the PR template with `Closes #<N>`, or update the open PR of this task. A PR that was closed without a merge is not reused.
12. (Phase 3: the hotspot notice. Not in Phase 1.)
13. Comment on the issue: PR number, full head SHA, the checks that ran with their results.
14. Replace the issue label `in-progress` with `in-review`. The Gate clears the failure labels of an earlier run when it sees the new head SHA (9.2).
15. Print the stop line: `PR #<PR> opened at <SHA>. Do not merge. Stop.`

**Outputs.** The pushed branch, the PR, the issue report, the labels, the stop line.

**Failure behavior.**

- Steps 2 to 9 use only local data and the task issue read in step 1: a failure there exits 1, names the step and its log, and pushes nothing. A failed fetch or GitHub call in step 1 exits 3.
- A failure in steps 10 to 14 exits 3; rerunning continues at the failed step without repeating the checks for the same commit.
- Called outside a task worktree: exit 2 with the paths of the caller's task worktrees.
- Called on a `spike/` branch: exit 1, "spike branches are never merged" (E16).

## 8. Tasks, labels, lifecycle and pull requests

### 8.1 Task rules and issue format

| # | Rule |
| --- | --- |
| T1 | One issue is one PR |
| T2 | Every task is a GitHub issue with a role (label), allowed paths, dependencies, acceptance criteria and a deadline |
| T3 | The Planner writes a task (problem, expected result, acceptance criteria), not a prompt. `take` composes the prompt |
| T4 | Size: about one hour of agent work and up to about 10 files. Small PRs are the priority |
| T5 | Acceptance criteria are written as tests. A task names its test files or test ids; a named test that does not exist counts as a failure |
| T6 | Larger units are grouped by sub-issues or a milestone, never by a checklist inside one issue |
| T7 | Planning goes in waves: the whole project as an outline of epics with roles, only the next wave as ready issues, each wave approved by the Lead. A convention in Phase 1 (I2) |
| T8 | Before publication, tasks that can run in parallel are checked for overlapping paths. In Phase 1 a convention; an overlap is caught when the second task is taken (H3, I4) |
| T9 | Dependencies between people: a consumer works against the types and the mock from the contract; connecting provider and consumer is a separate integration task at the end of the wave. A convention in Phase 1 (I2) |
| T10 | Issue comments are used only for scope changes and agent reports |
| T11 | Every task has a deadline. `status` marks overdue tasks; cutting a task is the Lead's decision (label `cut`) `[ASSUMPTION A40]` |
| T12 | The instruction of every task states where to run: `take` adds the worktree path and branch to every prompt |

Issue body `[ASSUMPTION A7]`: one data block that the CLI parses, then fixed headings for the agent.

````markdown
```yaml
# hackwin:task
kind: task                 # task | proposal | integration | contract-change | foundation
role: <ownership role>
wave: <wave number>        # optional for tasks written by hand and for proposals
paths:                     # allowed paths, globs, inside the role's scope or on the open list
  - <glob>
depends_on: [<issue>, <issue>]
acceptance_tests:
  - <test file or test id>
deadline: "<ISO 8601 with offset>"
```

## Problem
<what is missing or wrong, in terms of the product>

## Expected result
<what exists when the task is done, including the interfaces it must respect>

## Acceptance criteria
<one line per criterion, each mapped to a test listed above>

## Out of scope
<what this task must not change>
````

A task issue is an issue whose body contains the `# hackwin:task` block; the task commands ignore every other issue, the status issue included. `take` and CI reject a block that is invalid, and `status` lists it as invalid. Three rules apply to the block: every path lies in exactly one role or on the `open` list; `acceptance_tests` may be empty only for the kind `foundation`, which arrives with Phase 2 (I15); a deadline is always present. In Phase 1 the body is written by hand from the task issue template (I2), and the foundation is a task of the kind `task` with at least one acceptance test (I15).

A member's queue is the list of open task issues whose role the member holds and that are not in progress, in review or cut. Its order is: wave, with tasks without a wave last; then deadline; then issue number.

A scope change of a task is made by editing the issue body and adding one comment that starts with "Scope change:".

### 8.2 Labels

`setup` creates every label below (7.1 step 10). Except `in-progress`, `proposal`, `contract-change` and `needs-owner`, the names are `[ASSUMPTION A8]`; the Gate is the only writer of the Gate labels on a PR.

| Label | On | Set in Phase 1 by | Meaning |
| --- | --- | --- | --- |
| `role:<name>` | Issue | `take` for a task written by hand that lacks it | The ownership role that does the task. It mirrors the `role` field of the data block |
| `ready` | Issue | `take --release`, Gate (I12) | Released for work and takeable: its dependencies are closed |
| `blocked` | Issue | By hand | Released for work, waiting for a dependency |
| `in-progress` | Issue | `take`; the Gate when a PR is closed without a merge | A session works on it |
| `in-review` | Issue | `ship` | A PR exists and waits for the Gate |
| `cut` | Issue | Lead | Dropped by decision of the Lead |
| `proposal`, `needs-lead`, `integration`, `contract-change`, `approved` | Issue | Not set by the Phase 1 CLI (Phase 2) | Proposal, waiting for the Lead, integration task, contract change request, accepted by the Lead |
| `contract-changed` | Issue, PR | Not set by the Phase 1 CLI (Phase 2) | An approved contract change affects this work |
| `gate:queued`, `gate:testing`, `gate:waiting-ci`, `gate:merged`, `gate:failed` | PR | Gate | The Gate stage; exactly one at a time, starting with `gate:queued` at intake, or with `gate:failed` when the intake scan finds a secret. A new head SHA or a `retry` replaces the labels of the earlier run, `needs-owner` and `scope-violation` included |
| `needs-owner` | PR | Gate | The PR author must act. In Phase 1: any conflict (I7). Always together with `gate:failed` |
| `scope-violation` | PR | Gate | The PR changes files outside its author's scope. Always together with `gate:failed` |
| `hotspot` | PR | Not set by the Phase 1 CLI (Phase 3) | Another open PR changes the same file |
| `gate-status` | Issue | Gate | Marks the one status issue of the Gate (G25). It is not a task |

### 8.3 Task lifecycle in Phase 1

| From | To | Trigger | Actor |
| --- | --- | --- | --- |
| Issue written by hand (I2) | Takeable | At once, when the data block is valid | Nobody |
| `blocked` | `ready` | The last dependency closes | Gate, after the merge |
| `ready` | `in-progress` | `take` | Builder |
| `in-progress` | `in-progress` | `take N` resumes after a crash, a usage limit or a cleared session | Builder |
| `in-progress` | `ready` | `take N --release` | Builder |
| `in-progress` | `in-review` | `ship` | Builder's session |
| `in-review` | `in-review` with `gate:failed` on the PR, plus `needs-owner` or `scope-violation` where they apply | A Gate stage fails | Gate |
| `in-review` with a failure label | `in-review` | `take N` (resume), fix, `ship`; or `retry` typed by the Lead in the Gate terminal | Builder, Lead |
| `in-review` | `in-progress` | The PR is closed without a merge: the Gate drops it from the queue and relabels the task | Gate |
| `in-review` | Closed, done | The Gate merges the PR and closes the issue | Gate |
| Any open state | Closed with `cut` | Decision of the Lead | Lead |

`take` and `status` decide whether a task is takeable from the actual state of its dependencies; the `blocked` and `ready` labels mirror that state for the GitHub view (I12).

### 8.4 Pull request rules

- A PR is opened only by `ship`. It always comes from a `task/` branch and names its task with `Closes #<N>` (T1). CI fails a PR without a valid task link (E11).
- The PR author is the member whose `gh` login pushed it; the scope check uses that login.
- A PR is never opened as a draft; the Gate ignores drafts (G7).
- No one merges by hand. The Gate merges with a merge commit, pinned to the head SHA it tested (G15).

## 9. Gate pipeline

The Gate keeps the HackYeah PR recipe and moves it out of the integrator's conversation into its own process.

### 9.1 Gate requirements

| # | Requirement |
| --- | --- |
| G1 | The Gate is its own operating system process in its own terminal on the Lead's laptop. It writes to its terminal, its files and GitHub and, for a secret, raises one operating system notification (G26). It never injects anything into an agent conversation |
| G2 | One Gate per project. Only the Lead's account can start it. No takeover by another member |
| G3 | The Gate never exits because of an event. It runs until the Lead stops it |
| G4 | State is kept in a file: per PR the last head SHA, the stage and the result. It is written after every stage, so a restart resumes |
| G5 | A heartbeat is written at every poll and every stage change. Stage commands run as child processes, so polling and the heartbeat continue while a stage runs |
| G6 | The Gate keeps the laptop awake while it runs |
| G7 | Intake: every open PR that is not a draft is a queue item, whoever its author is, the Lead included; the one exception is a head SHA in which the intake scan finds a secret (G12). Drafts are ignored. A new head SHA sends the PR to the back of the queue. A head SHA that the Gate pushed itself continues that PR's run (from Phase 3; the Gate pushes nothing in Phase 1, I7). No session is woken for anything |
| G8 | A stage runs only when every earlier stage succeeded, the `&&` rule |
| G9 | No stage uses an LLM. The Resolver arrives in Phase 3 (I7) |
| G10 | Gated paths (migrations, production config) are never handled by the Resolver: a conflict in them stops the run for the Lead. A PR that changes them raises an attention line of the type migration or production config and is otherwise processed like any PR. A hold until a manual `apply` is later (9.5) [D1] |
| G11 | Scope check of the PR's own changes against `owners.yml` |
| G12 | Secret scan of the lines that each head SHA adds. It runs once per head SHA, at intake, so that a finding does not wait for the PR's turn in the queue `[ASSUMPTION A53]`. A finding fails the PR and raises an attention line of the type secret: the repository is public by default, so a secret that reaches the Gate is already exposed on a pushed branch and must be rotated at once, which only the Lead can do [D3] |
| G13 | Merge test on the newest main with a cached dependency install |
| G14 | Flaky tests: `gate.ci_rerun_limit` CI reruns, by default one, before a PR is blamed, and a list of known time dependent tests |
| G15 | Merge with `gh pr merge <PR> --merge --match-head-commit <full SHA>`. The full SHA is required; a short SHA was rejected at HackYeah |
| G16 | Smoke test after the merge |
| G17 | Strictly one PR at a time, first in, first out by the time the current head SHA joined the queue, at intake or through `retry` `[ASSUMPTION A23]` |
| G18 | Reporting instead of interrupts: one digest line per PR. The Lead gets an attention line only for the five attention types: migration, production config, scope violation, repeated failure and secret [D3] |
| G19 | The Gate never commits on main. A textual conflict is fixed on the PR branch, a semantic conflict by a separate small PR |
| G20 | If main moved after the merge test, conflict detection and the merge test run again before the merge |
| G21 | A failed run leaves exactly one comment on the PR with the stage, the reason and the next action. A successful run leaves no comment in Phase 1; the label shows it. (From Phase 3 a run in which the Gate pushed a fix also says what was resolved.) `[ASSUMPTION A31]` |
| G22 | After a merge the Gate deletes the remote branch, closes the task issue, sets dependents from `blocked` to `ready` and removes its scratch worktree (A35) |
| G23 | Repeated failure means: the same PR fails the same stage on `gate.repeated_failure_threshold` consecutive head SHAs (default two), or that many consecutive queue items fail the same stage, or a known flaky test fails again after its rerun, or the post merge smoke test fails `[ASSUMPTION A24]` `[ASSUMPTION A42]` |
| G24 | Version 1 polls GitHub every `gate.poll_seconds`. Events instead of polling come later |
| G25 | The Gate keeps one pinned issue, the status issue, whose body holds the heartbeat time, the open attention items and the digest. The Gate updates it by editing the body, never by a comment, so it sends no notification, and on a fixed interval, `gate.status_issue_seconds`. `status` reads it on every machine (9.6) [D4] |
| G26 | For an attention item of the type secret the Gate also raises one operating system notification on the Lead's laptop when the item opens. Where the platform offers no notification (5.6), it rings the terminal bell in the Gate terminal instead. The other attention types raise neither. Nothing enters an agent conversation (G1) [D16] |

### 9.2 Pipeline, stage by stage

Intake. At every poll the Gate lists the open PRs. For a PR that is not a draft and whose head SHA is new, it removes the labels that an earlier run left (`gate:failed`, `needs-owner`, `scope-violation`), fetches the head and runs the secret scan at once (G12). With a finding the PR fails as described for stage 4 and does not join the queue. Without one it gets `gate:queued` and joins the back of the queue (G7). A PR that was closed without a merge leaves the queue, and its task, when still open, returns to `in-progress`. The Gate then takes the PR at the head of the queue and runs the stages below in order. "Failed" in the table means: set `gate:failed`, post the comment (G21), write the digest line and leave the queue.

| # | Stage | Action | On failure |
| --- | --- | --- | --- |
| 1 | Fetch | Fetch main and the PR head; record both full SHAs; set `gate:testing` | Retry with increasing waits |
| 2 | Task link | The PR comes from a `task/` branch and names one open task with a valid data block | Failed |
| 3 | Scope | Every changed file lies in a role held by the PR author or on the `open` list (G11) | Failed with `scope-violation`; the comment lists each file with its owning role and holder; attention: scope violation |
| 4 | Secrets | The intake scan found no added line that matches a secret pattern and no added env file other than `.env.example` `[ASSUMPTION A41]`. A head SHA that was not scanned yet, for example after a restart, is scanned here | Failed; the comment gives file, line number and pattern name, never the matched text; attention: secret [D3], with the notification of G26 |
| 5 | Gated paths | When the diff touches `paths.gated`, raise an attention line of the type migration or production config (G10) | None; the run continues |
| 6 | Conflict detection | `git merge-tree --write-tree origin/main pr/<PR>` | Any conflict, in any file: failed with `needs-owner` and the script generated comment of RS11 (9.3, I7) |
| 7 | Merge test | Scratch worktree with the merge of the PR head and the newest main; dependency install reused from the cache when the lockfile hash matches `[ASSUMPTION A11]`; `commands.check`; the task's acceptance tests, run with `commands.test`. A command that runs longer than `gate.step_timeout_minutes` fails with the reason `step-timeout` | Failed; the comment gives the command and the last lines of the log, and the full log stays in the Gate's log directory |
| 8 | CI | Set `gate:waiting-ci`; wait until the required checks on the exact head SHA succeed | G14; after `gate.ci_timeout_minutes` the run fails with the reason `ci-timeout` |
| 9 | Freshness | Compare main with the SHA tested in stage 7 (G20) | Repeat from stage 6 |
| 10 | Merge | Pinned merge (G15); delete the remote branch | Head moved: requeue with the new SHA. Any other refusal: failed with the reason `merge-refused` |
| 11 | After merge | Set `gate:merged`; close the task issue; update dependents; remove the scratch worktree; write the digest line; run `commands.smoke` on the new main when configured | Smoke failure: attention, repeated failure type. The fix arrives as a separate small PR (G19) |

Flaky handling (G14). When CI fails, the Gate reruns the failed jobs, at most `gate.ci_rerun_limit` times per head SHA, by default once. When the rerun fails too, the Gate searches the failed log for every entry of `gate.known_flaky_tests`. If it finds one, the digest result is `flaky`, the comment states that the PR is not blamed, and an attention item of the repeated failure type asks for a fix of the test. Otherwise the PR is blamed and fails with the reason `ci-failed`. A local merge test whose log names a known flaky test is rerun under the same limit.

Semantic conflicts. Two PRs that each pass alone but fail together are caught by stage 7, because it always tests the merge with the newest main. Who fixes it depends on where the needed change lies `[ASSUMPTION A44]`. If it lies in the queued PR's own files, the author adapts the PR on its branch (`take N`, fix, `ship`). If it lies outside them, it becomes a separate small PR: in Phase 1 the author asks the Lead (I14), who writes the task for the owning role, and the queued PR ships again once the fix is merged. In neither case is anything committed on main directly (G19).

### 9.3 Conflicts in Phase 1

The Gate does not classify conflicts before Phase 3, and the mechanical conflict script arrives with the classification (I7) [D13]. Every conflict that stage 6 finds, in any file, gets `gate:failed`, `needs-owner` and the script generated comment of RS11. No model is called. `needs-owner` always means that the PR author acts: `take <N>` resumes the task, the session merges main, resolves, and runs `ship` (A26). Most conflicts never reach the Gate: `ship` merges main into the branch first, and the session resolves what it finds there (A46).

### 9.4 Resolver

Not in Phase 1. Only RS11 applies, to every conflict (I7): the conflict gets `needs-owner` and a script generated comment with the files and the merged PRs that changed them `[ASSUMPTION A28]`.

### 9.5 Gated changes in version 1

Migrations and production config belong to the Lead, are additive only, and are recorded in a ledger. The gate that holds such a change until a manual `apply` is later [D1]. Version 1 does the following:

- Paths under `paths.gated` belong to the shared role, so a builder's PR that touches them fails the scope check (E8).
- A PR of the Lead that touches them raises an attention line in the Gate terminal and in the status issue. The line names the type and, when `paths.ledger` is set, the ledger file to update. The PR is then tested and merged like any other, and the attention item closes when the PR is merged or closed (9.6).
- The Lead reviews the change, applies it by hand outside HackWin and records it in the ledger. The recommended order is to apply and record before running `ship` on the PR: an additive migration is safe ahead of the code that needs it, and many projects deploy main automatically, as HackYeah did. The team adopted this order; the tool enforces none [D17]. `AGENTS.md` and every task prompt state that no agent session applies a migration or changes production config.
- Warning: the project must not apply migrations automatically on merge. Some database integrations do this, and it would bypass the Lead, on whom v1 relies [D1]. The preparation guide repeats the warning.

### 9.6 Digest, attention and state

Digest line, one per PR run, written when the run ends, in the Gate terminal and in `digest.log`. The latest line of each PR is published in the status issue, where `status` reads it [D4]:

```
<time> #<PR> <author> <result> stage=<stage> <duration> <note>
```

The terminal prints the time as hours and minutes. `digest.log` and the status issue carry the full time, so that `status` can select the lines since a member's previous call (7.6).

Results, with the state each leaves behind:

| Result | Labels on the PR | Comment | Returns to the queue when |
| --- | --- | --- | --- |
| `merged` | `gate:merged` | None | Never |
| `failed` | `gate:failed` | Stage, reason, next action | A new head SHA arrives, or the Lead types `retry <PR>` |
| `needs-owner` | `gate:failed`, `needs-owner` | From the script (RS11): files and the merged PRs that changed them | A new head SHA arrives |
| `scope-violation` | `gate:failed`, `scope-violation` | Files with their owners | A new head SHA arrives |
| `flaky` | `gate:failed` | The known flaky test; the PR is not blamed | The Lead types `retry <PR>`, or a new head SHA arrives |
| `requeued` | `gate:queued` | None | At once, at the back of the queue with the new head SHA: the author pushed during the run |

Attention line, only for the five attention types [D3]:

```
ATTENTION <migration|production-config|scope-violation|repeated-failure|secret> #<PR>: <what the Lead must do>
```

An attention item stays open in the Gate state, in the status issue and at the top of `status` until it is closed `[ASSUMPTION A54]`:

- Migration and production config: when the PR is merged or closed.
- Scope violation: when a later head SHA of the PR passes stage 3, or the PR is closed.
- Repeated failure: when the stage passes again, for the PR itself with a later head SHA or after `retry`, or for the next queue item when the failure ran across queue items; when the PR is closed; and, after a failed smoke test, when the smoke test passes after a later merge.
- Secret: only when the Lead types `ack <PR>` in the Gate terminal, after rotating the secret. A later head SHA does not close it, because the secret stays in the history of a pushed branch.

For a secret the Gate also raises an operating system notification on the Lead's laptop (G26) [D16]. Version 1 has no other push channel.

Status issue (G25) `[ASSUMPTION A55]`. At its first start the Gate creates one issue with the title "HackWin Gate status" and the label `gate-status` and pins it; later it finds the issue by the label. The Gate rewrites the body once per `gate.status_issue_seconds`; each edit carries the current heartbeat time and everything that changed since the last one. Two edits are never closer together than that interval, except the edit at a Gate start and the edit at `quit`. The issue has no comments.

````markdown
```yaml
# hackwin:gate-status
schema: 1
heartbeat_at: "<time>"
stopped_at: null               # set by quit
starts: <count of Gate starts>
protection: <full-restricted | full | soft>
queue: [<PR>, <PR>]
attention:
  - type: <attention type>
    pr: <PR>
    since: "<time>"
    todo: "<what the Lead must do>"
```

## Digest
<the latest digest line of each PR, newest first>
````

The digest in the issue holds one line per PR: the latest run of every PR the Gate has seen. The history of all runs stays in `digest.log` on the Lead's laptop. If the body would exceed the size GitHub accepts (5.6), the oldest lines of merged PRs are dropped first.

State file `state.json` (G4). The keys `pushed_by_gate`, `script_fixes`, `resolver` and `hotspots` belong to Phase 3 and stay empty in Phase 1.

```json
{
  "schema": 1,
  "starts": "<count of Gate starts>",
  "main_sha": "<sha>",
  "last_poll_at": "<time>",
  "last_github_ok_at": "<time>",
  "last_smoke": {"main_sha": "<sha>", "result": "<passed | failed | null>"},
  "heartbeat_gaps": [{"from": "<time>", "to": "<time>"}],
  "status_issue": {"number": "<issue>", "last_edit_at": "<time>"},
  "queue": ["<PR>", "<PR>"],
  "prs": {
    "<PR>": {
      "head_sha": "<full sha>",
      "first_seen_at": "<time>",
      "secret_scanned_sha": "<sha or null>",
      "stage": "<stage name>",
      "result": "<result or null>",
      "tested_main_sha": "<sha or null>",
      "gated": ["<migration | production_config>"],
      "ci_reruns": "<count>",
      "pushed_by_gate": ["<sha>"],
      "script_fixes": ["<sha>"],
      "resolver": [{"sha": "<sha>", "mode": "<fix | advise>", "outcome": "<outcome>", "tokens": "<count>"}],
      "failures": [{"stage": "<stage>", "sha": "<sha>", "at": "<time>"}],
      "stage_times": {"<stage>": "<seconds>"}
    }
  },
  "attention": [{"type": "<type>", "pr": "<PR>", "since": "<time>", "todo": "<text>", "resolved_at": "<time or null>"}],
  "hotspots": [{"prs": ["<PR>", "<PR>"], "files": ["<path>"], "notified_at": "<time>"}]
}
```

The Gate records a heartbeat gap when a poll or a start finds the previous heartbeat older than `gate.heartbeat_stale_seconds` (M7).

## 10. Enforcement

### 10.1 Layers

Every rule has at least one hard layer that does not depend on the agent tool (P9). For E3 that layer is GitHub's update restriction [D2], with the limits listed in section 10.6. Claude Code hooks give the earliest feedback but are convenience only. A Codex user has no Codex specific layer in Phase 1 and is bound by the CLI, the git hooks, CI, the Gate and GitHub (I10).

| Layer | Acts when | Can be bypassed by | Hard |
| --- | --- | --- | --- |
| CLI | A command runs | Not using the command | For the action it performs |
| Git hooks | Every commit and push, in every clone and worktree, with any agent | `--no-verify`, or a machine where `join` never ran | Yes, with CI as the backstop |
| CI | Every PR and every new head SHA | Nobody who works through PRs | Yes |
| Gate | Every merge | A merge made without it. Where the update restriction is active, GitHub refuses it for every account but the Lead's [D2] | Yes |
| GitHub rules, full mode | Every push and merge to main | Not available in soft mode. The update restriction does not bind the Lead's own agent sessions (10.6) [D2] | Yes |
| Claude Code hooks | At edit time and command time in Claude Code | Using Codex or a plain editor | No |

The Gate merges only after CI succeeded on the exact head SHA (stage 8), so every CI rule holds for every merge the Gate performs. A merge that goes around the Gate is stopped only by the GitHub rules, where they are active (10.6).

### 10.2 CI workflow

`.github/workflows/hackwin.yml` runs one job named `hackwin` on every PR event that opens a PR or changes its head. It installs the CLI version pinned in `hackwin.yml` on the base branch. When the PR itself changes `cli_version`, it installs the version the PR names instead, so that the PR that installs a bug fix release is checked by the version it introduces (20.6) `[ASSUMPTION A60]`. It then runs `hackwin internal ci`, which executes in order and stops at the first failure:

1. Read `hackwin.yml` and `owners.yml` from the base branch and apply their rules to the PR (A17). When the PR itself changes one of the two files, also validate the proposed version (schema, no overlapping globs, one holder per role, a `cli_version` of the same phase as on the base branch [D10]), so that a broken configuration can never reach main.
2. Task link and branch name (E11, E16).
3. Scope of the PR's own changes (E1).
4. Secret scan (E6).
5. (Phase 2: contract paths, E9. Not in Phase 1.)
6. Generated wrappers and hook shims are unmodified (E19).
7. Merge the PR with the current main, install, run `commands.generate` and fail if any tracked file changes (E10).
8. Format check of the changed files (E14).
9. `commands.check` and the task's acceptance tests, run with `commands.test`, on the merged tree (E13).

The scope check always evaluates the branch's own changes: the three dot diff against `origin/main`, or the diff against `MERGE_HEAD` while a merge is in progress, so files that arrive from main never count.

### 10.3 Git hooks

Both hooks are shims that call the CLI. They act on member work and stay out of the way of everything else.

| Hook | Checks | Exempt |
| --- | --- | --- |
| `pre-commit` | On a `task/` branch: the scope check of the staged changes (E1); no env file other than `.env.example` and no secret pattern in added lines (E6). On the default branch: every commit is blocked (E18) | `spike/` branches skip the scope check |
| `pre-push` | A push to the default branch is blocked (E2, E18). A push that rewrites the history of a remote branch is blocked (E12). A push of a `task/` branch needs the green check record for the pushed head commit (E4) | Tags and `spike/` branches need no check record. Deleting a remote branch is allowed |

The Gate runs its git commands with the member hooks switched off; its pushes and merges are covered by its own stages.

### 10.4 Claude Code hooks

| Hook | Action |
| --- | --- |
| `SessionStart` | `git fetch`, then a summary of what changed on main since the main commit last recorded for this worktree (7.7 step 6), the member's own scope first (I6), plus new scope change comments on the worktree's task and the member's PRs that wait for them. It then records the current main commit. In the main checkout it also applies CM10 |
| `PreToolUse` | Block an edit outside the session's role scope; block `gh pr merge`, a merge made through `gh api` and any push to main, together with the deny rules of the settings file (the patterns: verify at build time, 5.6). This applies to every agent session, the Lead's included; for the Lead's sessions, which always run in Claude Code [D12], it is the only block against a merge outside the queue [D2] |
| `PostToolUse` | Format only the file that was just changed |

A hook is a deterministic command triggered by an event; it does not change how the model answers. Each one is a single call to `hackwin internal hook`, and only `SessionStart` uses the network.

### 10.5 Matrix

Cell values: **Block** stops the action; **Guide** is an instruction without a mechanism; a hyphen means the layer does not apply. "CC hooks" are the Claude Code hooks and permission rules. E9 and E21 arrive in Phase 2, the Codex column in Phase 3.

| # | Rule | CLI | Git hooks | CI | Gate | CC hooks |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Edits stay inside the author's ownership scope | Block in `ship` | Block at commit | Block | Block, attention | Block at edit |
| E2 | No direct push to main | No command does it | Block at push | - | - | Block |
| E3 | No agent session merges; only the Gate does | No command does it | Cannot see it | - | Sole merger | Block `gh pr merge` |
| E4 | No push without green checks on the pushed commit | `ship` order | Block without a check record | Runs the checks again | Tests again on the newest main | - |
| E5 | A session starts from the fresh main and knows what changed | `take` fetches, branches from `origin/main`, adds the summary to the prompt | - | - | - | `SessionStart` summary |
| E6 | `.env.local` is never read, printed or committed. GitHub's push protection, where it is on, is named below the matrix [D19] | Scan in `ship` | Block env files and secret patterns at commit | Block | Block, attention [D3] | Deny rules for reading env files |
| E7 | New dependencies only through the Lead | As E1: manifests and lockfiles are shared paths | As E1 | As E1 | As E1 | As E1 |
| E8 | Migrations and production config only by the Lead; applying them stays a manual act of the Lead | As E1 | As E1 | As E1 | As E1; attention line at stage 5 | As E1 |
| E10 | Generated files are produced only by the Lead and are current | `ship` checks | - | Block | Through CI | - |
| E11 | One issue, one PR; the PR names a valid open task | `ship` creates it | - | Block | Block at stage 2 | - |
| E12 | Work happens on a `task/` branch in its own worktree; main is merged in, never rebased or force pushed | `take` creates, `ship` merges | Block a push that rewrites history | - | - | - |
| E13 | Merge test on the current main before every merge | `ship` merges main first | - | Block | Block at stages 7 and 9 | - |
| E14 | Only changed files are formatted | `ship` checks | - | Block | Through CI | Format on edit |
| E15 | Merges are serialized and pinned to the tested SHA | - | - | - | Only mechanism | - |
| E16 | `spike/` branches are never merged | `ship` refuses | - | Block | Block at stage 2 | - |
| E17 | No more running tasks than configured sessions and disjoint tasks | Block in `take` | - | - | - | - |
| E18 | No fix is committed directly on main | - | Block at commit and push | - | By design (G19) | Block |
| E19 | Generated wrappers and hook shims are not edited by hand | `setup --regenerate` | - | Block | Through CI | - |
| E20 | Hooks are active on every machine | `take` and `ship` check `core.hooksPath` and repair it | - | Backstop for every hook rule | - | - |

GitHub's rules act beside these layers. In full protection mode GitHub blocks E2 and E18 for everyone, the repository owner included, and refuses to merge a PR whose `hackwin` check is not green. With the update restriction it also enforces E3 for every account except the Lead's [D2]. Where push protection is on (7.1 step 13), GitHub's own secret scanning adds a layer to E6 at push time; HackWin's scans in every column above stay in force beside it [D19].

### 10.6 Known gaps

| Gap | Effect | Mitigation in v1 |
| --- | --- | --- |
| The update restriction does not cover the Lead's own agent sessions, because they share the Lead's account [D2] | One of the Lead's sessions that ignores its instructions can merge a green PR with `gh pr merge`, skipping the queue and the merge test on the newest main | The Claude Code deny rule and the `PreToolUse` block for `gh pr merge` [D2], which every Lead has, because the Lead works with Claude Code [D12]; the stop line of `ship` |
| Where GitHub offers no update restriction for the repository type, E3 has no hard block that is independent of the agent tool | Any session that ignores its instructions can merge a green PR | The soft blocks stay as the fallback [D2]: the Claude Code block, `AGENTS.md`, the stop line of `ship`. `setup` reports which state applies. The preparation guide recommends a repository owned by an organization for this case [D15] |
| `--no-verify` skips the git hooks | A commit or push that breaks E1, E4 or E6 reaches GitHub | CI and the Gate fail it before any merge |
| In soft protection mode a push to main with `--no-verify` is stopped by no later layer | A commit on main that no PR and no Gate run covered | None beyond the hook and the agent permissions. A public repository avoids the gap |
| In soft protection mode GitHub requires neither a PR nor the `hackwin` check | A merge that goes around the Gate can land a PR whose checks failed | Only the soft blocks: the Claude Code block, `AGENTS.md`, the stop line of `ship`. The Gate itself never merges such a PR |
| A merge made by another route than `gh pr merge`, for example through `gh api` | The deny patterns of the Lead's own sessions may not match it | The patterns also cover the merge call of `gh api` where Claude Code can express that (verify at build time, 5.6); the rule in `AGENTS.md` |
| HackWin cannot stop a Codex session from reading `.env.local` | A secret may enter that session's context | `AGENTS.md` rule; the `pre-commit` scan stops it at commit; where push protection is on, GitHub blocks a push with a secret it recognizes, unless the pusher bypasses the block (verify at build time, 5.6) [D19]; CI and the Gate fail a PR that still carries one (E6) |

## 11. Shared files and hotspots

### 11.1 Rules for shared files

| # | File class | Who writes | Rule |
| --- | --- | --- | --- |
| SF1 | Dependency manifests and lockfiles | Lead | New packages only through the Lead; others request them from the Lead (I14) |
| SF2 | Global styles | Lead by default | A change, for example a new style or an unusual component, is requested from the Lead (I14) |
| SF3 | Generated files, for example types from OpenAPI | Lead only | CI checks that they are current |
| SF4 | README | Everyone | It is on the `open` list |
| SF5 | Migrations | Lead only | Additive only; recorded in the ledger; an applied migration file is never edited; applied by the Lead by hand, never automatically on merge [D1] |
| SF6 | Production config | Lead only | Same rule as migrations (9.5) |
| SF7 | `.env.example` | Lead | `.env.local` is never committed |
| SF8 | Contracts | Lead | In Phase 1 protected by ownership alone: they belong to the shared role, so only the Lead can change them (E1, I5) |
| SF9 | Registries such as routing or menus | The role that owns the file | HackWin enforces no registry structure, because it must work with every framework |
| SF10 | HackWin's own files: `hackwin.yml`, `owners.yml`, `AGENTS.md`, the workflow, the hook shims | Lead | Changed through a PR; generated files only through `setup --regenerate` (A48) |

In Phase 1 a conflict in any of these files that appears after `ship` is handed back to the PR author (I7). Migrations and production config are never resolved by a script or a model.

### 11.2 Overlaps in Phase 1

| # | Requirement |
| --- | --- |
| H3 | `take` refuses a task whose allowed paths overlap an open PR or a task in progress |
| H6 | Files on the `open` list are exempt from H3; a conflict in one of them goes to the PR author until Phase 3 (I7, I8) |

The hotspot warnings H1, H2 and H5 arrive in Phase 3, the planning check H4 in Phase 2.

## 12. Metrics

No metric is computed in Phase 1. The data that `status --report` reads from Phase 3 on accumulates from Phase 1 (I9): issue and PR timelines, git history, the `ship` reports, the status issue (Gate starts) and the Gate files on the Lead's laptop (`state.json` with Gate starts, heartbeat gaps, attention items with their times, failures and stage times). The report later counts Gate restarts as Gate starts minus one (M7).

## 13. Default tooling

Rule: a tool is included when the HackYeah logs show it helped, optional when its effect was real but depends on the project, and excluded when it showed no effect or caused friction.

**Included by default.** One git worktree per task; `gh` for all GitHub operations, with the head pinned merge; one CI job with the full project check and the generated file diff; the format on edit hook plus the rule "format only changed files"; the deny rule for reading env files; the ownership check as a script (the `owners.yml` scope check); a fresh session per task; the PR template with owner, scope and verification; a short `AGENTS.md` for both agents, imported by `CLAUDE.md`; a local log for the Lead; one research skill and one research subagent.

**Optional, added by the project** (HackWin provides the slot, not the content). Review checklists as project skills next to the HackWin skills; module boundary rules as part of `commands.check`; a browser QA script as a project script; a production check after a merge as `commands.smoke`; the explanation style through `join`. Local replay of migrations belongs to the later database gate.

**Excluded from the defaults.** GSD framework; ponytail plugin; codegraph MCP server; Agent Reach; account level connectors; caveman; third party plugins enabled through the committed settings; a watcher that runs inside an agent session. HackWin's committed settings contain only its own hooks and deny rules. Members may install personal tools at user level; HackWin neither requires nor manages them, and the preparation guide notes that user level hooks add latency and noise to every session. HackWin's own hooks are single local calls without network access, except the fetch at session start.

## 14. Acceptance criteria for Phases 0 and 1

Test setup: a sandbox GitHub repository with a small Node project that uses Tailwind (the stack HackWin is tested on), three test accounts (one Lead, two builders) and, for the solo criteria, one account. "Fixture" means a scripted repository state. Every criterion is checked by an automated test unless it says "inspection". The criteria are quoted from the PRD without change; a later phase keeps them green, except AC42 and AC72, which describe interim behavior and end with Phase 3. AC67 and AC77 are tested again with each later phase.

### Phase 0


**14.1 Setup and join**

| # | Criterion |
| --- | --- |
| AC51 | Release 1, the template, contains no call to the CLI: its CI workflow passes on a repository created from it without HackWin installed. |

**14.6 Status, metrics, parity and delivery**

| # | Criterion |
| --- | --- |
| AC49 | The HackWin README states that HackWin is a tool and not ready project code, tells teams to check their event's rules about code written before the event [B], and shows the HackYeah numbers of section 1.3 with N = 1 named (inspection). |
| AC50 | The repository license is MIT [B] (inspection). |
| AC64 | Release 1 contains every item that section 20.1 lists for Phase 0, in two repositories laid out as section 20.1 describes [D11]. The preparation guide warns against applying migrations automatically on merge [D1] and recommends a repository owned by an organization where a personal account offers no update restriction [D15]. The README names Claude Code and the plain terminal as fully supported and Codex as beta [D7], states that the Lead works with Claude Code [D12], and presents every command as planned, not as available (17.4). Every item of the checklist in section 20.5 is done [D6] (inspection). |

### Phase 1


**14.1 Setup and join**

| # | Criterion |
| --- | --- |
| AC1 | On a fresh public sandbox repository, `setup` with scripted answers for 3 members creates the committed files of section 6.4 for the commands its CLI version contains and every label of section 8.2. Reading the rules back from GitHub shows: PR required, check `hackwin` required, force push and branch deletion blocked and, where GitHub offers it, updates of the default branch restricted to the Lead's account [D2]. |
| AC2 | On a repository where GitHub refuses protection, `setup` exits 0 and reports soft mode. From a joined clone, `git push origin main` is rejected by the `pre-push` hook. |
| AC3 | For the Node fixture, `setup` proposes the install, check, test and format commands without the user typing them. |
| AC4 | `setup` with 5 members exits 2. A second `setup` on a configured repository exits 2. An `owners.yml` with overlapping globs is rejected by `setup` and fails CI. A fixture whose `hackwin.yml` breaks a validation rule of section 6.1 makes a command exit 2 and name the key. |
| AC5 | `join` on a builder account reports every check as passed, sets `core.hooksPath`, creates the local files and leaves `git status` clean. With a key in `.env.example` and no `.env.local` it exits 1. With an unreadable `.env.local` it still passes, which shows that the file is never opened. |
| AC6 | Running `setup --resume` and `join` a second time creates no duplicate label, file or invitation. A `setup` that fails before the bootstrap push leaves the repository and GitHub unchanged; one that is interrupted after it is completed by `setup --resume`. On a repository created from the template, `setup` keeps the team's own lines in `AGENTS.md`, replaces only its own blocks and the generated files, and removes the template's unchanged `check.yml` (6.5). |
| AC70 | Where GitHub accepts the rules for everyone but not the update restriction, `setup` exits 0 and reports full protection without the update restriction; the Gate header and the status issue show the same state. |
| AC76 | A CLI older than `cli_version` on main, or of another phase, exits 2 from every command and prints the install command; a newer bug fix release of the same phase prints a warning and continues (CM12). In a repository whose manifest does not exist yet, `join` and `take` skip the install with a notice. `setup` run under an account other than the one named as the Lead exits 2. `setup` with answers that give the Lead the agent `codex` exits 2 and names the reason [D12]. |
| AC80 | On a sandbox repository where GitHub offers push protection, `setup` enables it, and the setting read back from GitHub is on. Where GitHub refuses it, `setup` exits 0 and its summary reports push protection as off. In both cases a test secret that matches a HackWin pattern but no pattern GitHub recognizes is still blocked at commit, in CI and by the Gate (E6) [D19]. |

**14.3 Take, propose, ship**

| # | Criterion |
| --- | --- |
| AC11 | `take <N>` creates a worktree on a `task/` branch whose base is the current `origin/main`, sets `in-progress`, and outputs a prompt that contains all seven parts of section 7.7 step 6. |
| AC12 | `take` exits 1 with a specific reason for each of: the caller does not hold the task's role, open dependency, path collision with an open PR, session limit reached. On a machine where `join` has not completed it exits 2 and names `hackwin join`. |
| AC13 | `take` without a number picks the first takeable task of the caller's queue and lists the skipped tasks with reasons. |
| AC14 | On the same fixture, `take`, `ship` and `status` called from a terminal and through the Claude Code wrapper produce the same labels, branch, PR body and exit code. |
| AC15 | `ship` exits 1 and leaves the remote branch unchanged for each of: a conflict with main, with the files listed; a failing acceptance test; a named acceptance test that does not exist; a file outside the author's scope; an unformatted changed file; an added line that matches a secret pattern. |
| AC16 | After a successful `ship`: a PR exists with `Closes #<N>`; the issue has one comment with the PR number, the full head SHA and the checks; the issue label is `in-review`; the last output line is the stop line. A `ship` that is interrupted after the push and run again completes without running the checks again and without a second PR or comment. A `ship` of a new commit after a Gate failure updates the same PR. |
| AC17 | `ship` outside a task worktree exits 2 and prints the worktree path. `ship` on a `spike/` branch exits 1. |
| AC18 | A manual `git push` of a commit without a check record is blocked. A script that runs a failing check, then `;`, then a push does not push. This replays the HackYeah failure [W][P]. |
| AC52 | `take <N>` on the caller's own `in-progress` task reopens the worktree with a continue prompt. After a `take` whose install failed, `take <N>` finishes the remaining steps and gives the first prompt. `take <N> --release` returns the task to `ready` and frees the session slot. `take <N>` on a task whose PR is `gate:failed` brings the local branch up to the remote branch, including a commit that reached the remote branch from elsewhere. |
| AC53 | After a role swap is merged on main, the new holder of the role can `take` its open tasks and the previous holder cannot. |
| AC54 | A PR whose generated files are stale fails CI. A push that rewrites the history of a pushed task branch is blocked by the `pre-push` hook. A commit on the default branch is blocked by the `pre-commit` hook. With `core.hooksPath` unset in a joined clone, `take` and `ship` set it again (E20). |
| AC55 | In a Claude Code session an edit outside the role scope is blocked before the file changes, `gh pr merge` is refused, and after an edit only the edited file is reformatted. At session start the summary lists the commits that reached main since the last session. |
| AC65 | A task issue written by hand from the template is taken by `take` and merged through `ship` and the Gate. An issue with an invalid data block is refused by `take` with the reason and listed by `status` as invalid. |
| AC71 | A PR that names no open task with a valid data block fails CI and stage 2 of the Gate, and so does a PR opened by hand from a `spike/` branch. A PR of the Lead that changes a generated wrapper by hand fails CI (E19). |
| AC72 | On a CLI before Phase 3, `take` for a member whose agent is `codex` prepares the worktree, sets the label and prints the path of the prompt file and the command that starts Codex (I10). |

**14.4 Gate**

| # | Criterion |
| --- | --- |
| AC21 | The Gate processes a scripted sequence of 45 PR events, the number of watcher notifications in the HackYeah night [P], without exiting; its start count stays 1. |
| AC22 | Killed during a merge test and started again, the Gate merges that PR exactly once and posts no duplicate comment. |
| AC23 | Two PRs that are ready at the same time merge one after the other; the second PR's `tested_main_sha` equals the merge commit of the first. |
| AC24 | Semantic conflict fixture: PR A renames a function; PR B, in another file, calls the old name; both are green alone. The Gate merges A and fails B at stage 7 with a comment. `commands.check` passes on every commit of main. |
| AC25 | A PR with a file outside its author's scope gets `scope-violation`, a comment that lists files and owners, and an attention line. It is not merged. The attention item closes when a later head SHA passes the scope check. |
| AC26 | A PR that adds a line matching a secret pattern fails, and the comment does not contain the matched text. The finding is made when the Gate first sees the head SHA, also while other PRs are queued ahead, and the PR does not join the queue. An attention line of the type secret appears in the Gate terminal and in the status issue. It stays open after a later head SHA without the line and closes when `ack <PR>` is typed [D3]. |
| AC79 | When a secret attention item opens, at intake or at stage 4 for a head SHA that was not scanned yet, the Gate raises one operating system notification on the Lead's laptop, or rings the terminal bell on a platform that offers no notification. An attention item of any other type raises neither (G26) [D16]. The test observes the notification through a stubbed notifier; its display on each supported platform is checked by inspection. |
| AC27 | A draft PR is ignored and is queued once it is marked ready. A push during testing ends the run and queues the new SHA at the back. No merge is ever executed with a SHA other than the tested one. |
| AC28 | CI fails once and passes on the rerun: the PR merges and the digest notes one rerun. CI fails twice with a known flaky test named in the log: the result is `flaky` and the comment says the PR is not blamed. |
| AC29 | A PR of the Lead that touches a migration path raises an attention line of the type migration and is then tested and merged like any other PR; the attention item closes with the merge. The same change in a builder's PR fails with `scope-violation`. While `paths.gated` is empty, the Gate header says that no such attention line can be raised. |
| AC30 | `gate` started under a builder account exits 2. A second `gate` on the Lead's laptop exits 2 while the first holds the lock. |
| AC31 | While the Gate runs, the operating system reports an active sleep inhibitor, and the local heartbeat is renewed at least once per poll interval. With the Gate process killed for longer than the stale threshold, `status` starts with the stale warning on the Lead's laptop and on a builder's machine. After `quit` it starts with the stop notice instead. |
| AC32 | After a merge the remote branch is deleted, the issue is closed, the tasks that depended on it are takeable (those labeled `blocked`, which the Phase 1 fixture sets by hand, are relabeled `ready`) and the scratch worktree is gone. On the builder's machine the next `take` removes the worktree of the merged task. |
| AC33 | In full protection mode, after the bootstrap commit, every commit on the first parent history of main is the merge commit of a PR. |
| AC34 | Over a run of PRs without conflicts the Gate makes zero model calls. |
| AC35 | The Gate's only outputs are its terminal, its own directory, GitHub API calls and the notification of G26; a process trace shows no write to an agent process or to a session log (inspection of the trace). |
| AC56 | The same PR failing stage 7 on two consecutive head SHAs produces one attention line of the type repeated failure, which closes when the stage passes again. A failing post merge smoke test produces one as well. |
| AC57 | After a CI timeout, `retry <PR>` typed in the Gate terminal queues the same head SHA again. |
| AC58 | The `/gate` wrapper called inside an agent session starts no Gate process and prints the instruction to run `hackwin gate` in a separate terminal. |
| AC61 | With the Gate running, `status` on a builder's machine shows a heartbeat age below the stale threshold, the open attention items and the digest line of a PR the Gate has just processed, all read from the status issue [D4]. |
| AC62 | Over a run of 45 PR events the status issue has no comment, its heartbeat time advances, and no two edits are closer together than `gate.status_issue_seconds`, apart from the edits at a Gate start and at `quit`. |
| AC63 | With the update restriction active, `gh pr merge` on a green PR under a builder's account is refused by GitHub, and the Gate merges the same PR under the Lead's account. In a Claude Code session of the Lead, `gh pr merge` is refused by the deny rule [D2]. |
| AC78 | An unexpected error inside one PR's pipeline fails that PR with the reason `gate-error`, and the Gate goes on with the next PR. While GitHub is unreachable the Gate keeps running and its local heartbeat advances. When main moves between the merge test and the merge of a PR, stages 6 and 7 run again before the merge (G20). A PR that is closed without a merge leaves the queue, and its task returns to `in-progress`. |

**14.5 Resolver and hotspots**

| # | Criterion |
| --- | --- |
| AC42 | On a CLI before Phase 3, a conflict found at stage 6, in any file, gets `gate:failed`, `needs-owner` and the script generated comment, and no model is called (I7). |

**14.6 Status, metrics, parity and delivery**

| # | Criterion |
| --- | --- |
| AC44 | For the same GitHub state, `status` on a fresh clone after `join` shows the same attention items and the same "who does what", "waiting for merge" and "blocked" sections as on the Lead's laptop. An overdue task is marked. `status --json` carries the same items. With GitHub unreachable `status` exits 3. |
| AC47 | With the Claude Code hooks disabled, which simulates a Codex user, an edit outside scope is blocked at commit. Committed with `--no-verify` and pushed, it fails CI and the Gate and is not merged. |
| AC60 | With the main checkout on the default branch and a clean tree, `status` leaves it at `origin/main`. With local changes it warns and changes nothing. |
| AC66 | Solo mode in Phase 1: with one member, `setup`, a task written by hand, `take`, `ship`, a Gate merge and `status` complete. |
| AC67 | The CLI of each phase offers exactly the commands of that phase and of the earlier ones, and `setup` generates wrappers only for those. |
| AC77 | A PR that installs a bug fix release of the same phase, with the output of `setup --regenerate` and the raised `cli_version`, passes CI, which installs the version the PR names (10.2); after its merge an older CLI exits 2. A PR that sets `cli_version` to a release of another phase fails CI, and `setup --regenerate` run with a CLI of another phase exits 2 [D10]. |

## 17. Positioning and the README of Release 1

### 17.1 Value proposition

For a hackathon team of 2 to 4 people who each drive their own coding agents, HackWin makes handing out work fast and free of conflicts. A task reaches a teammate's agent with one command. Parallel work lands on main through a gate that needs no model. The outcome the team cares about is a stronger demo: more features that work, and people who have time for the demo video, the pitch and the presentation. In v1 Claude Code and the plain terminal are the fully supported paths; Codex support is beta [D7].

The claim is measurable. HackWin counts conflicts into main, cycle time, PRs per person and token cost automatically and prints them next to the HackYeah 2026 baseline. Zero conflicts is the proof, not the slogan.

### 17.2 How HackWin differs from existing tools

The pieces exist elsewhere. According to the brief's research of 4 October 2026, nobody combines all four: several humans on separate machines with roles, tasks pushed to a specific person, the integrator as an automatic gate, and coordination through GitHub [B]. The table repeats the brief's findings; they were not checked again for this PRD and must be verified before they are published.

| Project | What it does [B] | What HackWin adds [B] |
| --- | --- | --- |
| CoProgrammer | Task claiming with path reservation, handoffs between sessions, PR digest | Coordination that reaches other machines through GitHub, and a merge gate. CoProgrammer keeps a local coordination log and has no merge gate |
| CCPM | PRD to epics to GitHub issues to code, parallel agents in worktrees | Several humans with roles and directory ownership. CCPM serves one human and their agents |
| Conductor, claude-coordinator, command-start-issue | Issue to worktree to agent in one command | Tasks pushed to specific people. These serve one operator who hands tasks to their own agents |
| GNAP | Tasks as JSON in the repo, coordination by git push | State on GitHub issues without a commit per status change. GNAP is a specification only |
| Claude Squad, Open-Inspect | A shared team session, an orchestrator and auto-merge | The opposite philosophy: directory ownership instead of a central orchestrator |
| MergeWarden, Aixgo Code | Gates for agent PRs: scope and permissions | Speed for a small team; those target security in companies |
| Native GitHub: CODEOWNERS, rulesets, merge queue | Path ownership and merge queuing | A workflow on top of the building blocks; parts of them need a paid plan or an organization repository |

Platform direction. Anthropic is developing its own coordination (Projects with threads and a coordinator, Claude Tag) [B], and GitHub is moving toward multi-agent coordination with Agent HQ [R10]. HackWin does not compete on orchestrating sessions. It competes on ownership rules, task flow and gates, a layer that is independent of the agent tool [B].

### 17.3 What HackWin is not

- Not project code: it is a tool, and a team must check its event's rules on prior code and AI use [B].
- Not an orchestrator: no agent directs other agents.
- Not a product for solo developers, although it runs solo for testing [B].
- Not a review tool: it has no human approval step.
- Not yet a finished Codex product: Codex support is beta in v1 [D7].

### 17.4 README hook

> HackWin is a workflow and CLI for hackathon teams of 2 to 4 people who each run their own Claude Code or Codex sessions on one GitHub repository. It came out of HackYeah 2026, where four people merged 133 pull requests in about 23 hours and not one merge into main conflicted. HackWin packages what made that possible and removes what hurt. Every directory has one owner. Contracts are frozen before parallel work starts. `/take` hands a task to your agent with no copied prompt. A gate that needs no AI tests and merges pull requests one at a time while your lead keeps planning. The promise is fast delegation without conflicts, so more features work in the demo and people have time for the video and the pitch. Zero conflicts is the proof, not the slogan: one command prints your numbers next to ours. Our baseline is a single event with one team, and we say so. Claude Code and the plain terminal are fully supported. Codex support is in beta.

The README must also contain [B]: the statement that HackWin is a tool and not ready project code; the advice to check the event's rules on code written before the hackathon; and the HackYeah case study with its numbers as the centerpiece. Its requirements section states that Claude Code and the plain terminal are fully supported, that Codex support is beta in v1 [D7] and that the Lead works with Claude Code [D12].

The README is written per release. For Release 1 it presents the case study and the template, and it describes every command, the Gate and the report as what the coming CLI will do; the hook above is adapted in the same way. A command is described as available only from the release that contains it (20.1).

Naming and license [B]: the name is HackWin; the license is MIT, with Apache 2.0 considered only if the name later needs protection; the GitHub login `hackwin` belongs to an unrelated person, so the repository lives under the team's own account or an organization with another name. The npm package name, the domain and the GitHub owner are checked before publication (section 20.5) [D6].

**Command overview for the README** (a non-normative aid; the PRD's command sections are the authority). The Release 1 README describes every command as planned, not as available (17.4). In one line each:

| Command | Phase | What it will do |
| --- | --- | --- |
| `setup` | 1 | Configures the repository once: team, ownership, stack commands, generated files, labels, branch rules |
| `join` | 1 | Prepares one member's machine: checks, hooks, personal settings |
| `take [N]` | 1 | Checks a task, creates its worktree and starts the member's agent with a composed prompt |
| `ship` | 1 | Merges main into the branch, runs every check, opens the PR, reports in the issue and stops |
| `status` | 1 | Shows who does what, the merge queue, what is blocked and what the Gate did |
| `gate` | 1 | Starts the Gate, which tests and merges PRs one at a time without a model |
| `plan` | 2 | Produces the PRD, spec, design, contracts and foundation, and freezes the contracts |
| `tasks` | 2 | Turns the next wave of the plan into issues and checks them for path collisions |
| `propose` | 2 | Turns a member's idea or a request for a change outside their scope into a task |

`status --report` (Phase 3) prints the event's metrics next to the HackYeah baseline. From Phase 3 the Gate also starts the Resolver for conflicts that need judgment.


## 18. Assumptions used in this brief

Quoted from PRD section 18.4. Each is a choice the PRD made because no input settles it; implement it as written. Some lines also name later phases; only their Phase 0 and Phase 1 parts apply here.

| # | Assumption |
| --- | --- |
| A1 | The CLI is a Node.js package installed from npm, with the binary `hackwin`; Node is required on every machine and in CI |
| A2 | Version 1 supports macOS and Linux, and Windows through WSL |
| A3 | CI runs on GitHub Actions |
| A4 | A person is identified by their `gh` login |
| A5 | The Gate, the Planner and the Lead's builder sessions act under the Lead's GitHub account; there is no bot account |
| A6 | File names and places: `hackwin.yml` and `owners.yml` at the repository root, documents under `docs/hackwin/`, local state in the git common directory |
| A7 | The issue body format of section 8.1, what counts as a task issue, and the order of a member's queue |
| A8 | All label names except the four the brief names; the Gate is the only writer of the Gate labels on a PR |
| A9 | Branch names `task/<issue>-<slug>`; worktrees in a sibling directory of the repository |
| A10 | Sub-flags on the 9 commands and the plumbing namespace `hackwin internal` do not count as additional commands |
| A11 | "Shared package cache" means the package manager's own cache for worktrees and an install cache keyed by the lockfile hash in the Gate |
| A12 | `take` has a terminal mode and an in-session mode; `take N` resumes the caller's own task, in progress or handed back, or finishes a `take` that stopped early; `take N --release` returns it to `ready` |
| A13 | `take` links `.env.local` and `CLAUDE.local.md` into each worktree |
| A14 | Personal settings are added to the task prompt so they work in both agents |
| A15 | The role scope is a hard block; a task's allowed paths produce only a warning in `ship` and feed the collision checks |
| A16 | Paths without a matching role belong to the shared role; the `open` list holds paths anyone may edit |
| A17 | Checks read `hackwin.yml` and `owners.yml` from `origin/main`, never from the branch under test. The exceptions work on the branch's own copy: `plan --check` (7.3), `setup --regenerate` (7.1), and in CI the validation of a PR that changes one of the two files and the CLI version of a PR that installs a bug fix release (10.2) |
| A23 | Queue order is first in, first out by the time the head SHA joined the queue, at intake or through `retry` |
| A24 | The definition of "repeated failure" in G23, with a threshold of 2 and including a known flaky test that fails again |
| A26 | The conflict classes and routing of section 9.3, including that a mixed conflict is handed back and that `needs-owner` addresses the PR author |
| A28 | Without a working `claude` CLI on the Lead's laptop the Gate runs without the Resolver |
| A29 | Before a role swap the affected members ship or close their open PRs |
| A31 | A failed Gate run leaves exactly one PR comment, which also names a fix that the Gate pushed in that run; a successful run in which the Gate pushed a fix leaves one comment that says what was resolved; any other successful run leaves none |
| A32 | Protection settings: PR required, check `hackwin` required, force push and branch deletion blocked, rule applied to administrators, "require up to date branches" off; the update restriction of D2 as a rule set of its own |
| A34 | `setup` refuses more than 4 members |
| A35 | A merged task's worktree is removed by the member's next `take` or `join`; the Gate deletes the remote branch; when a PR is closed without a merge, the Gate returns its task to `in-progress` |
| A36 | Numeric defaults without a source: heartbeat stale threshold, CI timeout, step timeout, Resolver turn limit, status issue interval (section 6.3) |
| A37 | Shared artifacts (code, commits, issues, PRs) use one project language, English by default; the answer language is personal |
| A38 | `commands.check` must pass without secrets, as in CI |
| A39 | The template ships one research skill and one research subagent; the command wrappers are generated by `setup` |
| A40 | Deadlines are absolute times inside the event window that `setup` asks for; `status` marks overdue tasks; cutting is a manual label by the Lead |
| A41 | The secret scan uses a built in pattern list plus `gate.secret_patterns`, and rejects added env files |
| A42 | A failed post merge smoke test counts as a repeated failure and raises an attention item |
| A43 | `retry <PR>` typed in the Gate terminal queues a PR's current head SHA again |
| A44 | A semantic conflict is fixed on the queued PR's branch when the change lies in its own files, and by a separate small PR of the owning role otherwise |
| A45 | The way `setup` treats existing files (section 6.5); the manual workflow guide and the task issue template as parts of the template |
| A46 | At `ship` time the session resolves every conflict in the files it changed, the README included; the Resolver handles the conflicts that appear after `ship` |
| A47 | `setup` offers to invite members without write access; `setup` and `join` accept an answers file |
| A48 | The CLI version is pinned in `hackwin.yml`; CI verifies generated files against it (E19); `setup --regenerate` rewrites them; `take` and `ship` check that the hooks are active (E20) |
| A52 | Commands fast forward the main checkout to `origin/main` when it is clean and on the default branch |
| A53 | The secret scan runs at intake, once per head SHA, so that the attention line does not wait for the queue |
| A54 | The closing rules of attention items (9.6); only a secret item needs the Lead's `ack <PR>` |
| A55 | The status issue: title, label `gate-status`, body format, one digest line per PR, a stop time written by `quit`, one edit per `gate.status_issue_seconds`, with extra edits only at a Gate start and at `quit` |
| A56 | Phase boundaries where D8 is silent: the hooks, the branch rules, the five attention types, the status issue, the notification of G26 and the push protection of `setup` belong to Phase 1; the path check of `take` (H3) stays in Phase 1; the interim behaviors I1 to I16 |
| A59 | In the two repositories of Release 1 [D11], the template's README is a skeleton for the team's project, its `AGENTS.md` names no command, and its CI workflow is `.github/workflows/check.yml` with a placeholder check step |
| A60 | The CLI version rule (CM12): the releases of one phase differ only in the patch number, earlier phases keep receiving patch releases, and `status --report` is exempt from the phase check; the bug fix procedure (20.6), in which `setup --regenerate` rewrites the generated files and HackWin's own blocks; the CI exception for a PR that changes `cli_version` (10.2) |
| A61 | Input details of the CLI: a typed confirmation is the word `yes`; the keys of the answers file (CM11); `plan --freeze-at`; `--new` for an empty draft (CM13) |
| A62 | `setup` must be run by the Lead; after refusing `codex` for the Lead it asks again in an interactive terminal and exits 2 with an answers file; it stores each member's agent in `hackwin.yml`; it proposes the path groups of `paths` that are known before planning, of which `manifests` is required; `join` and `take` skip the install while no manifest file exists; the Gate header and `plan --check` give a notice while `paths.gated` is empty |

## 20. Delivery

### 20.1 Phase 0: Release 1

Release 1 is the template and the HackYeah case study, with no call to the CLI. It contains: the README with the case study and the statements of section 17.4; `AGENTS.md` and `CLAUDE.md`; an example `owners.yml`; the preparation guide; the manual workflow guide; the `docs/hackwin/` skeletons; the PR template and the task issue template; the research skill and subagent; the deny rules for env files; a `.gitignore` with the entries of section 6.4 and an empty `.env.example`; a CI workflow that runs only the project's own check. Section 6.4 gives the content of each file.

Layout [D11] `[ASSUMPTION A59]`. Release 1 consists of two repositories: the HackWin repository, which holds the README with the case study and later the CLI, and the template repository, from which a team creates its project and whose own README is a skeleton for that project. The template's `AGENTS.md` states the rules of section 6.4 without naming a command. That text, and the template's content in `CLAUDE.md`, the PR template, the task issue template and `.gitignore`, sits inside the markers `hackwin:begin` and `hackwin:end`, so that `setup` later replaces it instead of adding a second copy (6.5). The template's CI workflow is `.github/workflows/check.yml`, which runs only the project's own check: its check step is a marked placeholder that passes until the team replaces it with the project's install and check commands. Release 1 contains no command wrapper, no hook shim and no `hackwin.yml`; `setup` adds them from Phase 1 on.

With Release 1 a team runs the HackYeah method by hand (I1).

### 20.3 Interim behaviors in Phase 1

Each row is a requirement that leans on a later phase, with the behavior that applies in Phase 1.

| # | Requirement | Arrives with | Behavior in Phase 1 |
| --- | --- | --- | --- |
| I1 | Commands | Phase 1 | In Phase 0 the team follows `docs/hackwin/manual-workflow.md` (6.4) |
| I2 | `take` needs task issues (T2) | Phase 2 (`tasks`, `propose`) | The Lead, or the Lead's planning session through `gh`, writes task issues from the task issue template [D9]. A member with an idea in their own scope writes the issue themselves; for another scope they ask the Lead. `take` and CI validate the data block; a valid task is takeable once its dependencies are closed, and it enters the queue of 8.1. `status` lists task issues with an invalid block |
| I3 | The freeze tag and the release of tasks for work | Phase 2 (`plan --freeze`, `tasks --approve`) | Neither exists. The Lead ships the foundation as an ordinary task of the shared role and writes the other tasks afterwards, as `docs/hackwin/manual-workflow.md` describes for planning by hand. A project that starts on Phase 1 stays on it [D10] |
| I4 | The planning collision check (T8, H4) | Phase 2 | An overlap is caught when the second task is taken (check 4 of `take`, H3) |
| I5 | The contract check in `ship` and in CI (E9) | Phase 2 | Contract files are protected by ownership alone: they belong to the shared role, so only the Lead can change them (E1) |
| I6 | Contract marks in the `take` prompt and in the session start summary | Phase 2 | Both list the files that changed on main, the member's own scope first |
| I7 | Conflict routing to the script and the Resolver (9.3, 9.4) | Phase 3 | Every conflict found at stage 6 gets `gate:failed`, `needs-owner` and the script generated comment of RS11. The PR author resolves it. No model is called |
| I8 | Hotspot warnings (H1, H2) | Phase 3 | None. Check 4 of `take` (H3) prevents most overlaps. Files on the `open` list are exempt (H6), so a conflict in one of them goes to the PR author (I7) |
| I9 | `status --report` and the token count in the `ship` report | Phase 3 | Absent. The data accumulates (section 12), so the report can later be run on a Phase 1 event; token counts then read "not available" |
| I10 | Codex wrappers, the Codex hook configuration, the Codex start in `take`, the Codex hook check in `join` | Phase 3, as a beta [D7] | A Codex user runs the terminal commands. `take` prepares the worktree and prints the prompt file and the command that starts Codex. Every hard rule already applies, because it lives in the git hooks, CI, the Gate and GitHub (P9) |
| I11 | The Resolver model in `setup`; the `claude` CLI check for the Resolver in `join` and `gate` | Phase 3 | Not asked and not checked; `resolver.enabled` is false |
| I12 | The Gate sets dependents from `blocked` to `ready` (G22) | Phase 2 (the labels are set by `tasks`) | Whether a task is takeable is computed from its dependencies (8.3). The Gate still mirrors the labels where they exist |
| I13 | Wrappers and CI steps for all 9 commands | Later phases | `setup` generates wrappers only for the commands its CLI version contains (AC67) |
| I14 | `AGENTS.md`, the `take` prompt, the block messages and the fix of a semantic conflict (9.2) send a member to `propose` | Phase 2 | The generated texts say to ask the Lead, who writes the task (I2) |
| I15 | The freeze state in `status`, rule E21, the task kind `foundation` and `propose --spike` | Phase 2 | `status` shows no freeze state, the foundation is a task of the kind `task` with at least one acceptance test, and a spike branch is created by hand with git. `ship` and CI refuse spike branches (E16) |
| I16 | The path groups of `paths`, which `plan` fills | Phase 2 | `setup` proposes the groups that are known before planning (7.1 step 5). The Lead sets the others, such as `contracts` and `generated`, in the foundation task. While `paths.gated` is empty, the Gate header says that no attention line for a migration or a production config change can be raised (7.5) |

### 20.5 Pre-publication checklist

Before each release is published:

1. Check the npm package name, the domain and the GitHub owner, and replace the placeholders [D6].
2. Verify the comparison table of section 17.2 against the current state of each project; it repeats research of 4 October 2026.
3. Verify the current scope of GitHub Agent HQ before publishing the platform comparison.
4. Record in the release notes the result of every "verify at build time" item of section 5.6 that the release depends on.
5. Confirm the README statements (AC49, section 17.4), including the Codex beta note [D7], and the MIT license (AC50).

### 20.6 Bug fix releases during a project

A project stays on the phase of the CLI it started with; a team uses a later phase from its next project on [D10]. Bug fix releases of an earlier phase therefore continue as patch releases on that phase's own version line after a later phase is released, and the install command of CM12 names the exact pinned version `[ASSUMPTION A60]`. During a project the Lead installs a bug fix release of the same phase in these steps `[ASSUMPTION A60]`:

1. The Lead installs the bug fix release. Until its PR is merged, it works with a warning (CM12).
2. The Lead stops the Gate with `quit` and starts it again, so that it runs the new version.
3. The Lead writes a task of the shared role for the bug fix release (I2), takes it, runs `hackwin setup --regenerate` in its worktree (7.1) and ships it.
4. CI checks the PR with the version the PR names (10.2), and the Gate merges it.
5. From that merge on, an older CLI exits 2 and prints the install command (CM12). Every member installs the new version and runs `join` again.
