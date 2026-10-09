# HackWin: Product Requirements Document (v1)

| Field | Value |
| --- | --- |
| Product | HackWin: an open source (MIT) workflow and CLI for hackathon teams of 2 to 4 people in which every member runs their own Claude Code or Codex agent sessions on one shared GitHub repository. Claude Code and the plain terminal are fully supported; Codex support is beta in v1 [D7] |
| Status | Draft for build, revision 3 of 9 October 2026: the team decisions D1 to D8 of 8 October 2026 and D9 to D19 of 9 October 2026 are applied. The build brief for Phases 0 and 1 (`HackWin-build-phase-0-1.md`) is derived from this document; where the two differ, this document wins |
| Reader | A coding agent that builds HackWin from this document, and the team that reviews the result |
| Main promise | Fast delegation of work without conflicts |

## 0. How to read this document

**Sources.** Every fact and decision carries a source tag.

| Tag | Source | Role |
| --- | --- | --- |
| [B] | "Brief: workflow zespołowy z agentami AI", 8 Oct 2026 | Authoritative for decisions. Its sections "Ustalenia szczegółowe" and the decision checklist are final. Later text in the brief wins over earlier text. |
| [W] | hackyeah-workflow-brief.md | Facts: what the team did and what went wrong |
| [P] | hackyeah-pr-gate-postmortem.md | Facts: the background watcher, its cost and the proposed redesign |
| [T] | hackyeah-tooling-inventory.md | Facts: which tools helped and which had no effect |
| [R1] to [R12] | External research, checked against the sources on 8 Oct 2026, listed in section 16.2 | Supporting evidence only |
| [D1] to [D19] | Team decisions on the drafts of this PRD: D1 to D8 on the first draft, received on 8 October 2026; D9 to D19 on revision 2, received on 9 October 2026. Listed below | Final. They override the brief where they differ |

**Team decisions on the drafts.**

| # | Decision | Main places |
| --- | --- | --- |
| D1 | No hold for migrations and production config in v1. The project must not apply migrations automatically on merge, because the Lead applies them by hand | 9.5, G10, 6.4 |
| D2 | `setup` adds a GitHub rule so that only the Lead's account can update the default branch. The exact mechanism is verified at build time; the soft blocks stay as the fallback; the Lead's own agent sessions are not covered | 7.1, 5.6, E3, 10.6 |
| D3 | A secret found by the Gate is a fifth attention type that interrupts the Lead | G12, G18, 9.2, 9.6 |
| D4 | The Gate keeps one pinned status issue with its heartbeat, the open attention items and the digest, updated by editing. `status` reads it on every machine | G25, 9.6, 7.5, 7.6 |
| D5 | An accepted proposal outside its author's scope is completed by the author and implemented by the role that owns the paths | 7.8 |
| D6 | Names stay placeholders. Checking the npm package name, the domain and the GitHub owner is a pre-publication item | 20.5 |
| D7 | Codex support is beta in v1. Claude Code and the plain terminal are the fully supported paths | GO5, 5.5, 17 |
| D8 | v1 is built in four shippable phases, each usable at a real hackathon on its own | 20 |
| D9 | Planning by hand in Phase 1 is accepted; `tasks` stays in Phase 2 | 20.3 I2, I3 |
| D10 | A project stays on the phase of the CLI it started with. During a project only bug fix releases of that phase are installed; there is no move to a later phase | CM12, 7.1, 10.2, 20.6 |
| D11 | Release 1 is two repositories: the HackWin repository and the template repository | 20.1 |
| D12 | The Lead works with Claude Code in v1. `setup` refuses `codex` as the Lead's agent and says why | 7.1, 6.1, 10.6 |
| D13 | The mechanical conflict script stays in Phase 3, with the conflict classification | 9.3, 20.2 |
| D14 | Approvals stored as labels are enough for v1; the gap stays listed | 10.6 |
| D15 | The preparation guide recommends a repository owned by an organization when GitHub offers no update restriction for a repository of a personal account | 6.4, 10.6 |
| D16 | A found secret also raises an operating system notification on the Lead's laptop, with the terminal bell as the fallback. Support per platform is verified at build time | G26, 5.6, 9.6 |
| D17 | The Lead applies and records a migration before `ship` (recommended order; the tool enforces none) | 9.5 |
| D18 | The defaults of revision 2 stay: no tooling for demo data (the Planner writes test data rules into tasks), a hand written README status, the CoProgrammer comparison unused in v1, and the terminal mode of `take` as the primary one | F6, F7, 7.7 |
| D19 | `setup` enables GitHub's secret scanning push protection where GitHub offers it and reads the setting back; availability and the exact setting are verified at build time. HackWin's own secret scans stay as the second layer, and are the only layer where push protection is unavailable | 7.1, 5.6, E6, 10.6 |

**Conventions.**

- "Must" marks a v1 requirement. "Later" marks something the team decided to postpone. Nothing marked "later" may be built in v1.
- `[ASSUMPTION An]` marks a choice made in this PRD because no input settles it. Section 18.4 lists all of them. The build agent implements each assumption as written. The team may overrule any of them.
- "Verify at build time" marks a capability of Claude Code, Codex, GitHub or an operating system that no input confirms. The build agent must check it against current documentation before relying on it and must implement the stated fallback when it does not hold.
- Every number names its source. Design defaults that no source supports are collected in one table (section 6.3) and flagged as assumptions.
- Identifiers are stable and used for cross references: GO goals, P principles, CM common command behavior, T tasks, CC contract change, G Gate, RS Resolver, E enforcement, SF shared files, H hotspots, M metrics, AC acceptance criteria, F HackYeah failures, K risks, Q open questions, C resolved contradictions, A assumptions, S suggestions, R research sources, D team decisions on the drafts, I interim behaviors between phases. An identifier is never reused: a number missing from a list, for example Q1 or A22, was closed by a team decision.
- Example outputs use placeholders such as `<PR>` and `<time>` instead of invented values.

**Contents.**

1. Summary, problem, evidence and value proposition
2. Goals, non-goals and success metrics
3. Roles and team shapes
4. Design principles
5. Architecture and state model
6. Configuration and generated files
7. Command specifications
8. Tasks, labels, lifecycle and contract changes
9. Gate pipeline and Resolver
10. Enforcement matrix
11. Shared files and hotspots
12. Metrics and the generated report
13. Default tooling
14. Acceptance criteria for v1
15. How it works: a 24-hour hackathon with HackWin
16. Evidence and research used
17. Positioning
18. Risks, open questions, resolved contradictions and assumptions
19. Suggestions (not decided)
20. Delivery plan

## 1. Summary, problem, evidence and value proposition

### 1.1 Summary

HackWin turns the method that a 4-person team used at HackYeah 2026 into a repeatable tool. Each member runs their own Claude Code or Codex sessions on one shared GitHub repository. HackWin consists of:

1. a repository template with agent instructions, guides and an example ownership map (its full content: section 20.1),
2. a CLI (`hackwin`) with 9 commands that holds all logic and generates the command wrappers for the agents,
3. git hooks and a CI workflow that enforce the rules for every agent,
4. the Gate: a persistent process without an LLM on the Lead's laptop that tests and merges pull requests one at a time and reports through one pinned status issue,
5. the Resolver: a headless model call in a fresh small context that the Gate starts only when a conflict needs judgment,
6. Claude Code hooks as an extra convenience layer,
7. an automatic metrics report that compares each event with the HackYeah baseline.

Claude Code and the plain terminal are the fully supported paths. Codex support is beta in v1, because no Codex use is confirmed in the HackYeah logs [D7][T]. The Lead works with Claude Code [D12]. The work is delivered in four phases, each usable at a real hackathon on its own (section 20) [D8].

### 1.2 Problem

The HackYeah method produced 133 merged PRs in about 23 hours with zero conflicting merges into main [B]. Conflicts were not the bottleneck. Coordination was: everything passed through one integrator session and through the integrator's clipboard [B]. Three problems were costly.

1. **Blocked brain.** One long-running integrator session planned, merged and fixed conflicts. Background PR events were injected into that conversation and kept it busy for about 146 minutes in one night; each PR event cost about 2.4M tokens because it read the whole conversation again [P].
2. **Integrator as postman.** The integrator session wrote prompts for teammates and the integrator copied them to Discord by hand [B].
3. **Rules by convention.** Most rules had no enforcement, so some broke: a push before checks finished, a migration applied before review, no branch protection [W][P].

### 1.3 Evidence from HackYeah 2026

This is one event with one team in one room (N = 1) [B]. The numbers come from git history, GitHub data and session logs.

| Measure | Value | Source |
| --- | --- | --- |
| Team and duration | 4 people, about 23 hours (first merge 3 Oct 11:23, last merge 4 Oct 10:21, local time) | [B][W] |
| Merged PRs | 133 (per author account: 50, 39, 32, 12); 2 closed without merge | [B][W] |
| Median PR size | 5 files, 262 changed lines | [B] |
| Merges into main that conflicted | 0 | [B] |
| Branch-side conflict merges | 8 | [B][W] |
| Production regressions after a merge | None observed | [B] |
| Lead conversation busy on watcher events | About 146 min in one night; median 1.9 min and p90 6.8 min per event | [P] |
| Launches of the watcher loop in one night | 54, most of them manual restarts | [P] |
| Tokens per PR event | About 2.4M; context per model call median 255 thousand, p90 500 thousand tokens | [P] |
| Conversation compactions overnight | 3, plus 1 stop at the usage limit | [P] |
| Deterministic share of the PR recipe | 9 of 10 steps needed no model | [B] |
| Plan usage in 24 hours | 3 Claude Max limits and about 50% of a Codex plan (200 USD tier) | [B] |

### 1.4 What worked and must be preserved

In order of importance [B]:

1. Shared code had exactly one author. All conflicts landed in that author's files.
2. Directory ownership: one role per directory, not one person. A role swap during the event changed only the label.
3. Contracts before code: OpenAPI, data model and task plan were frozen at H+0:45.
4. Small PRs on short branches from current `origin/main`, each in its own worktree.
5. One merger, merges in order, a merge test on current main and CI on every PR.
6. Builder agent sessions had no right to merge: they opened a PR and stopped.

### 1.5 Failure map

Every failure recorded in the HackYeah documents maps to the requirement that prevents it. "Partly closed" and "deferred" rows follow team decisions.

| # | Failure at HackYeah | Source | Prevented by | v1 status |
| --- | --- | --- | --- | --- |
| F1 | One session planned, merged and fixed conflicts; watcher events kept the Lead's conversation busy for about 146 min in one night | [B][P] | Split roles (section 3); G1, G18; RS2 | Closed |
| F2 | Prompts for teammates were copied to Discord by hand | [B] | Tasks as GitHub issues (T1 to T3); `take` composes the prompt locally (7.7); `propose` (7.8) | Closed |
| F3 | A push went out before its checks finished because commands were chained with `;` (PR #127). The same chaining in the branch refresh of #90 would have pushed after a failed check; that check happened to pass | [W][P] | `ship` step order (7.9); E4 pre-push hook; G8 | Closed |
| F4 | A migration was applied before the reviewer's hold | [W] | SF5, E8, G10: migration paths are Lead only, the Resolver never touches them, and the Gate raises an attention line when a PR changes them (9.5) | Partly closed. The gate with a hold and a manual "apply" is later by decision [B][D1] (18.3 C5) |
| F5 | Production policy was activated by a builder session without the agreed review | [W] | SF6, E8 for config files in the repo; AGENTS.md rule for changes made outside the repo | Partly closed. Same gate as F4, later [B] |
| F6 | Test writes polluted demo data in the shared database | [W] | No v1 tooling by decision. The Planner writes test data rules into tasks by hand [B][D18] | Deferred by decision. Freeze mode rejected [B] |
| F7 | README statuses and one claim drifted from the code | [W] | T5 acceptance criteria as tests; `status` generated from GitHub (7.6) | Partly closed. The README status stays hand written in v1 [D18] (S10) |
| F8 | A command was run in an old checkout that lacked the new script | [W] | "Where to run" in every task prompt and CLI message (7.7); `ship` refuses to run outside a task worktree; session start fetch (E5); every command that runs in the main checkout fast forwards it first (CM10) | Closed |
| F9 | README was the most edited file (26 commits, several authors) | [W] | SF4: everyone may edit; the session merges conflicts at `ship` time and the Resolver those that appear later; H1 warns | Closed |
| F10 | The watcher fired on the integrator's own PRs and on drafts | [W][P] | G7: drafts ignored, own pushes recognized, no session is ever woken | Closed |
| F11 | No branch protection. A protection file existed but was never applied | [W][T] | `setup` applies protection, restricts updates of main to the Lead's account [D2] and reads both back (7.1); in soft mode E2 and E3 rest on hooks and agent permissions | Closed where GitHub accepts the rules; partly closed in the fallback states (10.6) |
| F12 | The watcher loop exited after each event: 54 launches in one night, most of them manual restarts, and monitoring gaps | [P] | G3, G4, G5 | Closed |
| F13 | Early watcher versions ignored PRs from the integrator's own sessions | [P] | G7: every member's PRs are queue items | Closed |
| F14 | Results were injected into the human's conversation and blocked it | [P] | G1 | Closed |
| F15 | Each PR event cost about 2.4M tokens; one usage limit stop; 3 compactions | [P] | G9; RS2; one fresh session per task (7.7) | Closed by design. Measured by M6 |
| F16 | A time dependent test made a correct conflict fix look broken (#88, #96) | [P] | G14: one CI rerun, known flaky list, annotation in the handback | Closed |
| F17 | "Green alone, red together" (#67) | [P] | G13; G20; CI merge test (E13) | Closed |
| F18 | Harness friction: foreground sleep refused, short SHA rejected, commands moved to the background | [P] | G1 (the Gate runs outside any agent harness); G15 full SHA | Closed |
| F19 | The command center conversation was never cleared: 331.7M tokens processed [P] | [P][T] | The Planner carries no merge work; state on GitHub lets any session restart (P4); one fresh session per task | Closed by design |
| F20 | Extra tooling produced noise: false positive injection warnings from user-level hooks | [T] | Section 13: excluded from defaults | Closed |
| F21 | A Codex user would bypass every Claude Code hook | [B] | P9; section 10 places hard enforcement in the CLI, git hooks, CI and GitHub's rules | Closed, except for the two Codex gaps of section 10.6: a merge where GitHub's update restriction does not apply, and reading `.env.local` |
| F22 | The team perceived "one or two" conflicts; git history shows 8 | [W] | M2 and M3 are counted automatically | Closed |
| F23 | Ownership lived in prose plus a warning | [W] | `owners.yml` as data; blocking checks (E1) | Closed |
| F24 | A PR duplicated an endpoint that was already merged (#62 and #57) | [P] | T1, T8; `take` path check (7.7); H1; session start summary | Partly closed. The planning check, the path check and the hotspot warning compare open work only. A duplicate of work that is already merged, as at HackYeah, is caught only when the session uses the summary of what changed on main |
| F25 | Late, half finished branches could collide with release work | [W] | T11 deadlines; `status` shows overdue tasks. The decision to cut stays with the Lead | Closed |

### 1.6 Value proposition

HackWin makes delegation to every teammate's agents fast and free of conflicts. The chain of value is:

1. A task reaches a teammate's agent with one command and no copied prompt.
2. Parallel work lands on main without conflicting merges, because ownership, contracts and the Gate remove the causes.
3. More tasks reach main working, so the demo shows more working features.
4. The Lead's attention and every teammate's waiting time are freed for the demo video, the pitch and the presentation.

Zero conflicts is the proof, not the slogan. Section 2.3 makes each link measurable.

## 2. Goals, non-goals and success metrics

### 2.1 Goals

| # | Goal | Source |
| --- | --- | --- |
| GO1 | Delegation: a planned task becomes a running agent session on the right teammate's laptop with one command, with no prompt copied by hand | [B] |
| GO2 | No conflicts at the gate: zero conflicting merges into main; remaining conflicts surface early on branches and go to the resolver that knows the intent | [B] |
| GO3 | Unblocked Lead: no merge event occupies the Lead's conversation; the Lead is interrupted only for five attention types (migration, production config, scope violation, repeated failure, secret) | [B][D3] |
| GO4 | Cost: no model call for a PR that needs no judgment; the Resolver works in a fresh small context | [B][P] |
| GO5 | Parity: the same commands with identical behavior in Claude Code and in a plain terminal, the fully supported paths. The Codex form is beta in v1 | [B][D7] |
| GO6 | Invisible rules: a member who stays in scope never sees a block | [B] |
| GO7 | Simple start: `setup` asks a few questions and detects the stack commands itself | [B] |
| GO8 | Measurable: one command produces the metrics for the case study | [B] |

### 2.2 Non-goals

| Non-goal | Reason | Source |
| --- | --- | --- |
| Teams larger than 4, or long-lived product teams | v1 targets only hackathon teams of 2 to 4, with 3 or more recommended | [B] |
| Advertising solo use | The solo market is crowded. Solo mode exists as a special case for testing v1 | [B] |
| Orchestrating sessions with a central agent | HackWin competes on ownership rules, task flow and gates, a layer independent of the agent tool | [B] |
| Shipping project code | HackWin is a tool, not ready project code | [B] |
| A freeze mode before the demo | Rejected | [B] |
| Gate takeover by another member | Rejected: one Gate, always on the Lead's laptop | [B] |
| Task state as files in the repo (GNAP style) | Rejected: issues do the same without commits, noise or pull delay | [B] |
| Enforcing a structure for registries such as routing or menus | HackWin must work with every framework | [B] |
| A single owner for README or owned README sections | Rejected: everyone edits, the Resolver merges | [B] |
| A required human review step | HackYeah ran without approval gates or review requests | [W] |
| Dependence on GitHub merge queue | Not available for the repositories HackWin targets; the Gate runs the queue | [B] |
| Moving a running project to the CLI of a later phase | A project stays on the phase it started with; during a project only bug fix releases of that phase are installed (20.6) | [D10] |

Decided as later, not v1 [B][D1]: the database and production config gate (section 9.5); model choice per agent and cost controls; a ban on test writes to the database before the demo (handled by hand in the task plan); the Resolver inside GitHub Actions (it needs an API key); a Discord webhook for the digest; events instead of polling.

### 2.3 Success metrics

All metrics are computed by `hackwin status --report` (section 12). The baseline is HackYeah 2026. No target below is an invented number: a target is either a stated decision, the baseline itself, or "report".

| Promise link | Metric | HackYeah baseline | v1 target |
| --- | --- | --- | --- |
| Fast delegation | M1: time from task creation to merge, with the split created to taken, taken to PR, PR to merged | Not measured (tasks were prompts, not issues) | Report |
| Fast delegation | Prompts relayed by hand | Prompts were copied to Discord by hand [B]; count not measured | 0 by construction |
| No conflicts | M2: conflicting merges into main | 0 [B] | 0 |
| No conflicts | M3: branch-side conflict merges, split by who resolved them | 8 [B] | Report, with the route for each |
| More working features | M4: merged PRs in total and per person | 133; 50, 39, 32, 12 [W] | Report |
| More working features | M5: median PR size | 5 files, 262 changed lines [B] | At or below the task size rule of about 10 files [B] |
| More working features | M10: tasks closed with green acceptance tests; tasks cut | Not measured | Report |
| Human time freed | M7: manual Gate restarts | 54 launches of the watcher loop, most of them manual restarts [P] | 0 [B] |
| Human time freed | Lead conversation time occupied by merge events | About 146 min in one night [P] | 0 by construction (G1) |
| Human time freed | M7: Lead attention items by type | Not measured | Report |
| Cost | M6: model tokens per PR event at the gate | About 2.4M [P] | 0 for PRs without a Resolver call; Resolver calls reported; expected order is the size of the diff [P] |
| Cost | M6: tokens per task | Not measured per task | Report |

### 2.4 Delivery order

The team decided the publication order: first the template and the HackYeah case study, then the tool; the case study with numbers is the heart of the README [B]. The template is Phase 0. The tool follows in Phases 1 to 3, and every phase is usable at a real hackathon on its own [D8]: section 20 gives the content, the interim behaviors and the acceptance criteria of each phase. A team uses one phase for a whole project and a later phase from its next project on [D10]. v1 is tested in solo mode before a hackathon and then measured at the next hackathon against the same metrics [B].

## 3. Roles and team shapes

### 3.1 System roles

The HackYeah integrator is split into roles so that the brain of the operation never waits for a merge and a merge needs no LLM [B]. Only the Lead and the builders are humans. The Lead also builds, so a team of 4 has 4 builders [B].

| Role | Who or what | Responsible for | Never does |
| --- | --- | --- | --- |
| Lead | Human, exactly one per team | Decisions; approving task waves, proposals outside the author's scope and contract changes; applying migrations and production config changes by hand; rotating a secret that the Gate finds [D3]; holds the shared ownership role; runs the Planner session, the Gate terminal and their own builder sessions for shared code and infrastructure [B] | Coding in the Planner session after the freeze [B] (18.3 C9) |
| Planner | The Lead's agent session in the main checkout | PRD, spec, design, contracts and foundation before the freeze; task waves; answers to questions; marking issues and PRs affected by a contract change [B] | Merging; coding after the freeze [B] (see 18.3 C9) |
| Builder | Every member including the Lead: a human with 1 or 2 agent sessions, 3 as an advanced option [B] | Tasks inside their ownership scope; shipping PRs; resolving conflicts in their own files [B] | Editing outside scope; merging [B] |
| Gate | A separate process made of scripts, no LLM, on the Lead's laptop [B] | The whole PR pipeline: scope, secrets, conflict detection, merge test, CI, merge in order, smoke test; hotspot warnings; digest [B]; the status issue [D4] | Injecting anything into an agent conversation [B]; committing on main [B] |
| Resolver | A headless `claude -p` call started by the Gate in a fresh context [B] | Additive conflicts in shared files; handback notes for conflicts in owner files [B] | Changing logic in files owned by others; touching migrations or production config; merging [B] |

### 3.2 Sessions and terminals

| Person | Runs |
| --- | --- |
| Lead | One Planner session (main checkout); 1 or 2 builder sessions (one worktree per task); one Gate terminal |
| Every other member | 1 or 2 builder sessions (one worktree per task) |

The Lead's sessions run in Claude Code [D12]; every other member chooses Claude Code or Codex (beta [D7]). The number of builder sessions per person is chosen in `setup`: 1 or 2, with 3 as an advanced option that prints a warning. `take` never allows more running tasks than the person has disjoint tasks in scope [B].

### 3.3 Who runs which command

| Command | Runner |
| --- | --- |
| `setup` | Lead, once |
| `join` | Every member, once per machine |
| `plan` | Lead with the Planner |
| `tasks` | Lead with the Planner; any member as a substitute when the Lead's plan limit is exhausted [B] |
| `gate` | Lead, in a separate terminal |
| `status` | Everyone |
| `take`, `propose`, `ship` | Builders, the Lead included |

### 3.4 Ownership roles

An ownership role is a named part of the codebase, for example `shared` or `workbench`. `owners.yml` maps path globs to ownership roles; `hackwin.yml` maps members to ownership roles.

- Every directory has exactly one ownership role [B].
- Every ownership role has exactly one holder at a time. A member may hold several roles.
- The Lead holds the role flagged `shared: true`. It covers shared code, infrastructure, contracts, dependencies and configuration [B][W].
- A role swap changes one line in `hackwin.yml`. Ownership stays with the directory [B]. Open tasks follow the role, not the person: `take` checks who holds the role on main (7.7). Before a swap the affected members ship or close their open PRs, because the scope check uses the roles the PR author holds at check time `[ASSUMPTION A29]`.

### 3.5 Supported team shapes

| Members | Shape | Notes |
| --- | --- | --- |
| 1 | Solo: one person is Lead and builder and holds every ownership role | Special case for testing v1 before a hackathon; not advertised [B] |
| 2 | Lead (shared role plus one feature role) and one builder | The merge gate and gated changes stay with one person [W] |
| 3 | Lead (shared role) and 2 feature builders | Recommended minimum [B] |
| 4 | Lead (shared role) and 3 feature builders | The HackYeah shape [W] |

`setup` refuses more than 4 members `[ASSUMPTION A34]`.

These rules do not change with team size [B]:

- exactly one merge mechanism,
- shared code has one author,
- one role per directory,
- every agent session works in its own worktree and has no right to merge,
- database and production config changes go only through the Lead.

In solo mode every rule still applies. The single member runs the Planner session, the builder sessions and the Gate; the Gate serializes merges from that member's parallel sessions and the hotspot detector warns about overlaps between them.

## 4. Design principles

| # | Principle | Source |
| --- | --- | --- |
| P1 | One filter for every feature: does it speed up delegation without conflicts, or does it only add process? | [B] |
| P2 | Rules are invisible until someone breaks them. A builder types `/take 42` and works; a block appears only on leaving scope | [B] |
| P3 | An LLM is used only where judgment is needed. Everything that can be written as a rule runs as a script or in CI | [B] |
| P4 | Project state lives on GitHub, not in repo files and not in one session's context. Any session, including a new one after a reset, can answer "what is happening now" | [B] |
| P5 | One writer per path: one ownership role per directory, and shared code has one author | [B] |
| P6 | Exactly one merge mechanism: the Gate. No agent session merges | [B] |
| P7 | Small PRs on short branches from fresh `origin/main`, one worktree per session | [B] |
| P8 | Contracts before code. Interfaces are frozen before parallel work starts | [B] |
| P9 | Hard enforcement is independent of the agent tool: it lives in the CLI, git hooks, CI and GitHub's rules. Agent hooks are convenience only. Section 10.6 lists the gaps where only an agent hook or an instruction stands | [B][D2] |
| P10 | Reports instead of interrupts: one digest line per PR; the Lead is interrupted only for the five attention types (G18) | [B][D3] |
| P11 | Never commit a fix on main. Textual conflicts are fixed on the PR branch, semantic conflicts in a separate small PR | [B][P] |
| P12 | Fail fast and in order: a step runs only when every earlier step succeeded | [B][P] |
| P13 | Every commitment is measured against the HackYeah baseline | [B] |

## 5. Architecture and state model

### 5.1 Components

| Component | What it is | Uses an LLM | Runs where |
| --- | --- | --- | --- |
| Template repository | Static starting files without any call to the CLI, listed in section 20.1. Published before the tool, together with the HackYeah case study [B] (Phase 0) | No | GitHub |
| CLI `hackwin` | All logic of the 9 commands. Deterministic steps cost no tokens [B] | No | Every member's machine and CI |
| Command wrappers | One skill per command, generated for both agents from one source [B]. A wrapper only calls the CLI and passes the result to the session. The Codex wrappers are beta [D7] | The session that calls it | Agent sessions |
| Git hooks | `pre-commit` and `pre-push` shims that call the CLI | No | Every clone and worktree |
| CI workflow | Scope, secrets, task link, contract and generated file checks, merge test, project checks | No | GitHub Actions `[ASSUMPTION A3]` |
| Gate | Persistent process that tests and merges PRs one at a time [B] | No | The Lead's laptop, own terminal |
| Resolver | Headless `claude -p` call per conflict that needs judgment [B] | Yes, fresh context | The Lead's laptop, started by the Gate |
| Claude Code hooks | `SessionStart`, `PreToolUse`, `PostToolUse` conveniences [B] | No | Claude Code sessions only |
| GitHub | Issues, labels, milestones, PRs, comments, one tag and the Gate's pinned status issue [D4]: the shared state. Branch rules protect main | No | GitHub |

### 5.2 Flow

```
Lead + Planner           GitHub                         Builder (each member)
--------------           ------                         ---------------------
hackwin setup    ->  labels, CI, protection
hackwin plan     ->  docs, contracts, foundation PR
hackwin tasks    ->  task issues (wave)         ->      hackwin take [N]
                                                        worktree + prompt + agent session
                     PR + issue report          <-      hackwin ship
Gate (no LLM):   <-  open PRs
  scope, secrets, conflict detection,
  merge test, CI wait, pinned merge, smoke
  Resolver only on a judgment conflict
                 ->  merged main, labels, comments,
                     pinned status issue        ->      hackwin status (everyone)
```

No arrow leads from the Gate into any agent conversation (G1).

### 5.3 State model

Rule: shared state lives on GitHub, rarely changing documents with one owner live in the repo, personal and machine state lives in local files [B]. Task state is never stored as repo files, because every status change would then be a commit that others see only after the next pull [B].

| State | Lives in | Written by | Read by |
| --- | --- | --- | --- |
| Task: problem, expected result, role, allowed paths, dependencies, acceptance tests, deadline | GitHub issue body and labels | `tasks`, `propose`, `plan` (the Foundation issue); by hand, the only way in Phase 1 (I2) | `take`, `ship`, `tasks`, `propose`, `status`, Gate, CI |
| Task assignment | Issue assignee | `tasks`, `propose`, `plan`, `take` | `take`, `status` |
| Task status | Issue labels and open or closed state | `tasks`, `propose`, `plan`, `take`, `ship`, Gate; the Lead for `cut` | `take`, `ship`, `status`, Gate, CI, report |
| Wave membership | Issue milestone | `tasks` | `status`, report |
| Agent report: PR number, head SHA, checks run, token count | Issue comment | `ship` | The team on GitHub; report |
| Scope change of a task | Issue comment | Planner or Lead; `propose --mark` (CC5) | `take`, session start summary |
| Pull request | GitHub PR | `ship` | Gate, CI, `status`, `take` |
| Gate stage and result per PR | PR labels, and the Gate state file | Gate | `status`, `take` |
| Gate heartbeat, open attention items, digest with one line per PR | The pinned status issue [D4] | Gate | `status` on every machine; report |
| Failure and handback notes | PR comment | Gate, in advise mode with the Resolver's text | PR author, `take` |
| Hotspot warning | PR comment and label | Gate | Both PR authors, `status` |
| Planned contract freeze time | Deadline of the Foundation issue | `plan` | `status` |
| Contract freeze | Git tag `hackwin/contracts-frozen` `[ASSUMPTION A20]` | `plan --freeze` | `take`, `tasks`, `plan`, `ship`, CI, `status` |
| Contract change request, approval and marks | Issue with label `contract-change`, labels and comments on affected issues and PRs | `propose`; `ship` removes a mark (CC8) | `take`, `status`, session start summary, CI |
| Ownership map | `owners.yml` in the repo | Lead, through a PR after bootstrap | CLI, hooks, CI, Gate, Resolver |
| Team, stack commands, Gate and Resolver settings | `hackwin.yml` in the repo | `setup`, later the Lead through a PR | Everything |
| PRD, spec, design, contracts, epics outline, non-code list | `docs/hackwin/` and the contract paths | Planner before the freeze, Lead after | Agents through task prompts |
| Agent rules and command skills | `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/` | `setup` (generated) | Agent sessions |
| Answer language, explanation style, personal notes | Local files, never committed | `join` | The member's own sessions |
| Secrets | `.env.local` on each machine | The human, received from the Lead over a private channel [B] | The application only. Agents never read or print it [B] |
| Green check record per commit | Local, per clone | `ship` | `pre-push` hook |
| Last main commit seen per worktree | Local | `take`, session start summary | `take`, session start summary |
| Time of the member's last `status` call | Local | `status` | `status` |
| Gate queue, per PR state, local heartbeat, full digest history, logs, cache | Local on the Lead's laptop | Gate | Gate after a restart, `status` on the Lead's laptop, report |
| The Lead's log | Local on the Lead's laptop [B] | Planner | Planner |
| Wave and proposal drafts | Local until published | Planner, author | `tasks`, `propose` |
| Metrics | Derived on demand from GitHub and the Gate files | `status --report` | The team, the case study |

`plan --freeze` runs the steps of `ship` (7.3), so it also writes what `ship` writes in this table, in section 6.4 and in section 8.2.

Local state is stored in the git common directory of the clone (`<git-common-dir>/hackwin/`), which every worktree of that clone shares and which git never commits `[ASSUMPTION A6]`.

### 5.4 Identity and permissions

- The CLI identifies the person by the login that `gh` is authenticated with and matches it to `team.members[].github` `[ASSUMPTION A4]`.
- The Gate, the Planner and the Lead's builder sessions all act under the Lead's GitHub account. HackWin uses no bot account `[ASSUMPTION A5]`. Consequence: a check on "who did this" cannot tell the Lead from the Lead's agents, so the approvals that must come from the human (a wave, a proposal outside the author's scope, a contract change) require an interactive terminal and a typed confirmation, which an agent session does not have (CC3).
- Every member needs write access to the repository. `setup` offers to invite members who lack it (section 5.6).
- No agent session has the right to merge or to push to main [B]. Where the update restriction is active (section 5.6), GitHub refuses a merge by every account except the Lead's [D2]. That rule cannot tell the Lead from the Lead's own agent sessions, which share the account, so for them the block is the Claude Code deny rule [D2], present for every Lead because the Lead works with Claude Code [D12]. Section 10 states how each layer enforces the rule and which gaps remain (10.6).

### 5.5 Agent neutrality

The same command exists in three forms with identical behavior [B]. Claude Code and the terminal are the fully supported forms; the Codex form is beta in v1 and arrives in Phase 3 [D7]:

| Where | Form |
| --- | --- |
| Claude Code | `/take 42` |
| Codex (beta) | The skill named `take` |
| Terminal | `hackwin take 42`, which always works |

Claude Code hooks and skills do not work in Codex. A Codex user would bypass every rule that lived only there, so hard enforcement lives in the CLI, the git hooks and CI [B]. A Codex user is therefore bound by every hard rule from Phase 1 on, also while the Codex wrappers do not exist yet (I10). Beta means that the Codex criterion AC68 is tested and reported with each release from Phase 3 on, and that a failure there is named in the release notes instead of blocking the release `[ASSUMPTION A58]`.

### 5.6 Platform prerequisites to verify at build time

No input confirms these beyond the statements cited in the rows. The build agent checks each against current documentation and implements the stated fallback when a capability is missing.

| Capability | Used for | Fallback |
| --- | --- | --- |
| Claude Code exposes a project skill as a slash command with the same name | `/take` and the other 8 commands | Generate `.claude/commands/<name>.md` wrappers |
| Claude Code `SessionStart`, `PreToolUse`, `PostToolUse` hooks and `permissions.deny` rules for Bash commands, including patterns that also cover a merge made through `gh api` | Early feedback for all rules; the block against a merge by the Lead's own sessions [D2]; the block on the approval commands (CC3) | Edit, push and env rules stay enforced by git hooks and CI. For a merge by the Lead's own sessions and for the approval commands only `AGENTS.md` and the typed confirmation remain (10.6) |
| Claude Code headless mode `claude -p` with a model choice, a turn limit, a tool allowlist and machine readable usage output | Resolver | Gate runs without the Resolver (A28) |
| Codex reads `AGENTS.md` and skills in `.agents/skills/<name>/SKILL.md` [B] | Codex wrappers | Members call `hackwin <command>` in the terminal |
| Codex hooks behind a flag that can block Bash commands but not file edits [B], and the path and format of their configuration file | Blocking `gh pr merge` and pushes to main in Codex | The Codex cells of section 10.5 become Guide: `AGENTS.md` rule, `pre-push` hook, GitHub rules |
| Both agent CLIs accept a working directory and an initial prompt at start | `take` in terminal mode | Print the prompt file path and the start command |
| A running agent session can continue its work in another working directory | `take` called inside a session (A12) | The wrapper prints the terminal command instead; the terminal mode is primary anyway [D18] |
| Session logs with token usage per session (HackYeah logs had `usage` fields for Claude Code [P]) | M6 | Report "not available" for that agent |
| GitHub branch protection or rulesets on a public repository of a personal account, including a rule that also binds the repository owner | Full protection | Soft protection [B] |
| A GitHub rule that lets only the Lead's account update the default branch of a public repository owned by a personal account [D2]. The documentation suggests a ruleset rule with a bypass list [R12]. To verify: that the rule exists for this repository type, that it also refuses a merge made through the API, that the bypass does not lift the PR and check requirements for the Lead, and that the rule exists for a public repository owned by an organization on GitHub Free, which the preparation guide recommends as the remedy [D15] | E3 | The soft blocks listed in section 10.6 [D2] |
| Pinning an issue from the command line | Status issue (G25) | The issue is found by its label `gate-status`, and `status` prints its link |
| Editing an issue body sends no notification [D4] | Status issue (G25) | None needed: the content stays correct, and members can mute the issue |
| The largest issue body that GitHub accepts | Status issue (9.6) | The Gate drops the oldest digest lines of merged PRs when GitHub refuses an edit for its size |
| GitHub's limits on write requests. The documentation names 5,000 requests per hour as the primary limit and 500 content generating requests per hour as a secondary one, and does not say whether an issue edit counts toward the second [R12] | Status issue interval, labels, comments | Raise `gate.status_issue_seconds` together with `gate.heartbeat_stale_seconds` (6.1) |
| GitHub issue timeline exposes who added a label | Approval checks in CI | Accept the label without the actor check |
| Inviting a collaborator from the command line with the Lead's token | `setup` step 10 | `setup` prints the instruction to invite the member by hand |
| GitHub offers the file under `.github/ISSUE_TEMPLATE/` when an issue is created | Tasks written by hand (I2) | The body is copied from the template file by hand |
| `gh pr merge --merge --match-head-commit <full SHA>` (worked at HackYeah, needs the full SHA [P]) | Pinned merge | None: required |
| `git merge-tree --write-tree`, the form the post-mortem proposes; plain `git merge-tree` was used at HackYeah [P][T]. The replication package of [R3] names git 2.38 or later | Conflict detection | None: `join` fails on an older git |
| Rerunning the failed jobs of a CI run from the command line | G14 | No rerun: the run fails with the reason `ci-failed` and the Lead may type `retry` |
| The shell of an agent session is not an interactive terminal | Human approvals (CC3) | Deny rules in the Claude Code settings and the rule in `AGENTS.md` |
| A command that keeps the laptop awake while a process runs, per operating system | Gate keep awake | Gate prints a warning that it cannot prevent sleep |
| An operating system notification raised by a terminal process, per supported platform (macOS, Linux, Windows through WSL) [D16] | G26 | The Gate rings the terminal bell in its own terminal |
| GitHub secret scanning push protection [D19]: for which repository types and plans it is available, how the Lead's token enables it from the command line, how the setting is read back, and whether a pusher can bypass a block | `setup` step 13; E6 | HackWin's own secret scans alone (E6); `setup` reports push protection as off |

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
  model: "<model id>"             # strongest model available to the Lead; asked from Phase 3 on (I11)
  max_turns: 30
```

This document writes `main` for the default branch; the CLI uses `project.default_branch` everywhere.

Validation rules. Any violation makes every command exit with code 2 and name the key.

| Rule | Reason |
| --- | --- |
| `team.members` has 1 to 4 entries; exactly one equals `team.lead` | Team shapes [B]; A34 |
| Every role in `owners.yml` is held by exactly one member; every role a member lists exists | One role per directory, one holder [B] |
| The role flagged `shared: true` is held by the Lead | Shared code has one author [B] |
| The Lead's `agent` is `claude` | [D12] |
| With one member, that member holds every role | Solo mode [B] |
| `sessions` is 1, 2 or 3 | Decision checklist [B] |
| `commands.install`, `check`, `test`, `format`, `lockfile_regen` are non-empty | Needed by `ship`, the Gate and the mechanical conflict script |
| Every glob under `paths.contracts`, `generated`, `manifests`, `lockfiles` and `gated` resolves to the shared role in `owners.yml` | These files belong to the Lead (section 11) |
| `paths.manifests` is not empty | `join` and `take` skip the install while no manifest file exists (7.2) |
| `resolver.model` is set when `resolver.enabled` is true | RS3 |
| `gate.status_issue_seconds` is smaller than `gate.heartbeat_stale_seconds` | Otherwise every `status` call would warn about a stale heartbeat (7.6) |

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

Rules:

- A path matches at most one role. `setup` and CI reject overlapping globs.
- A path that matches no role and no `open` entry belongs to the shared role, so every file always has exactly one owner `[ASSUMPTION A16]`.
- `open` exists because the team decided that everyone may edit the README [B]. `setup` puts only `README.md` there.
- The example paths show the HackYeah layout [W]. `setup` proposes globs from the real directory tree and the Lead confirms them.

### 6.3 Defaults and their sources

| Setting | Default | Source |
| --- | --- | --- |
| Team size | 2 to 4, solo allowed | [B] |
| Sessions per person | 1 or 2; 3 advanced with a warning | [B] |
| Task size guidance in the `tasks` wrapper | About one hour of agent work | [B] |
| `tasks.max_files` | 10 | "Up to about 10 files" [B] |
| Wave length guidance in the `tasks` wrapper | 3 to 5 hours | The first wave covers 3 to 5 hours [B] |
| Suggested contract freeze | 45 minutes after `project.event.start` | HackYeah froze at H+0:45 [B]; `plan` asks the Lead to confirm or change it |
| `gate.poll_seconds` | 60 | HackYeah watcher interval [P] |
| `gate.ci_rerun_limit` | 1 | One CI rerun before blaming the PR [B] |
| `gate.repeated_failure_threshold` | 2 | The smallest count at which a failure repeats `[ASSUMPTION A24]` |
| `gate.heartbeat_stale_seconds` | 300 | `[ASSUMPTION A36]`: no input gives a value; the post-mortem only says "N minutes" [P] |
| `gate.status_issue_seconds` | 120 | `[ASSUMPTION A36]`: 30 edits per hour, plus one at each Gate start and stop, far below the limits GitHub documents [R12] (section 5.6) |
| `gate.ci_timeout_minutes` | 20 | `[ASSUMPTION A36]`; for scale, the HackYeah full check took 1.5 to 3 min [P] |
| `gate.step_timeout_minutes` | 20 | `[ASSUMPTION A36]` |
| `resolver.max_turns` | 30 | `[ASSUMPTION A36]`: the brief requires a limit without a value [B]; for scale, the HackYeah recipe used about 8 model calls per PR [P] |

### 6.4 Files and objects that `setup` and `join` create

**Committed to the repository (by `setup`, in one bootstrap commit).**

| Path | Content | Later owner |
| --- | --- | --- |
| `hackwin.yml` | Section 6.1 | Lead |
| `owners.yml` | Section 6.2 | Lead |
| `AGENTS.md` | Short shared rules for every agent: scope and ownership, one task one PR, worktree and branch rules, merge `origin/main` and never rebase or force push, never push to main, never merge, from Phase 2 on never approve a wave, a proposal or a contract change (only the human Lead does), never read or print `.env.local`, format only changed files, where to run commands, request shared changes through `propose` (before Phase 2: from the Lead, I14), stop after `ship`, and leave every database and production config change to the Lead, including applying migrations and changes made outside the repository [B][W]. It also names the project language for code, commits, issues and PRs (English by default), while each member's answer language stays personal `[ASSUMPTION A37]` | Lead |
| `CLAUDE.md` | Imports `AGENTS.md` [W] | Lead |
| `.claude/settings.json` | Hooks (section 10.4) and `permissions.deny` for reading `.env`, `.env.local`, `.env.*.local` [T], for `gh pr merge`, a merge made through `gh api` and pushes to main, and from Phase 2 on for the human approval commands (`tasks --approve`, `propose --accept`, `propose --reject`) | Lead |
| `.claude/skills/<command>/SKILL.md` | One wrapper per command of the installed CLI version, for Claude Code (I13) | Generated |
| `.agents/skills/<command>/SKILL.md` | The same wrappers for Codex, same `SKILL.md` format [B]. Beta, from Phase 3 [D7] | Generated |
| `.claude/skills/research/SKILL.md`, `.agents/skills/research/SKILL.md`, `.claude/agents/research.md` | One research skill for both agents and one research subagent [B] `[ASSUMPTION A39]` | Lead |
| `.githooks/pre-commit`, `.githooks/pre-push` | Shims that call `hackwin internal hook <name>` | Generated |
| The Codex hook configuration (path and format: verify at build time) | Blocks `gh pr merge` and pushes to main in Codex sessions [B]. Beta, from Phase 3 [D7] | Generated |
| `.github/workflows/hackwin.yml` | CI workflow (section 10.2) | Generated |
| `.github/pull_request_template.md` | Task link, owner and scope, shared changes, verification list, migration line, remaining limitations [W] | Lead |
| `.github/ISSUE_TEMPLATE/hackwin-task.md` | The issue body of section 8.1 with empty fields, for tasks written by hand (I2) | Lead |
| `.env.example` | Created empty when missing; belongs to the Lead [B] | Lead |
| `.gitignore` entries | `CLAUDE.local.md`, `.env.local`, `.env.*.local`, `hackwin-report.md`, `hackwin-report.json` | Lead |
| `docs/hackwin/before-the-event.md` | Preparation guide. The template must teach this step, not assume it [B]. It covers: the event's rules on AI tools and on code written before the event [B][R9]; the research, the choice of stack and the accounts that make a fast contract freeze possible [B]; the warning that the project must not apply migrations automatically on merge, which some database integrations do, because in v1 the Lead applies them by hand, with the order that section 9.5 recommends [D1][D17]; the recommendation to create the repository under an organization when GitHub offers no update restriction for a repository of a personal account (5.6) [D15][R12]; the note that user level tools add latency and noise to every session [T] | Static |
| `docs/hackwin/manual-workflow.md` | The HackYeah method by hand, for a team that uses only the template (I1): tasks written as issues from the task issue template; the prompt content of section 7.7 step 6 [W]; the PR recipe [P], run by the Lead in a terminal session that is not the planning conversation; planning by hand, with the foundation first and the other tasks after it (I3) | Static |
| `docs/hackwin/` skeletons | `prd.md`, `spec.md`, `design.md`, `epics.md`, `non-code.md`, filled by `plan` | Lead |

Generated files carry a header naming the CLI version. CI fails when a generated file differs from what the pinned CLI version produces, so nobody edits one copy of a skill by hand (E19) `[ASSUMPTION A48]`.

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
| `CLAUDE.local.md` in the main checkout | `join` | Answer language and explanation style for Claude Code [B] |
| `.env.local` | The human | Secrets. `join` only checks that the file exists [B] |
| `<git-common-dir>/hackwin/checks/<sha>.json` | `ship` | Green check record for one commit |
| `<git-common-dir>/hackwin/sessions/` | `take`, session start summary, `status` | Last main commit seen per worktree; time of the member's last `status` call |
| `<git-common-dir>/hackwin/prompts/<issue>.md` | `take` | The composed prompt of a task |
| `<repo-parent>/<repo-name>.worktrees/<issue>-<slug>/` | `take` | One worktree per task `[ASSUMPTION A9]` |
| `<repo-parent>/<repo-name>.worktrees/spike-<name>/` | `propose --spike` | One worktree per spike |
| `<git-common-dir>/hackwin/gate/` (Lead only) | `gate` | `state.json`, `heartbeat`, `digest.log`, `gate.lock`, `logs/`, `cache/`, and `worktrees/` for the scratch worktrees |
| `<git-common-dir>/hackwin/lead-log.md` (Lead only) | Planner | The Lead's log [B] |
| `<git-common-dir>/hackwin/drafts/` | `tasks`, `propose` | Wave and proposal drafts before publication |

The CLI is a Node.js package installed from npm with the binary name `hackwin`; Node is therefore required on every machine and in CI, also for projects on other stacks `[ASSUMPTION A1]`. The package name, the domain and the GitHub owner stay placeholders until the pre-publication check of section 20.5 [D6]. Version 1 supports macOS and Linux, and Windows through WSL `[ASSUMPTION A2]`. Hooks and CI call a plumbing namespace, `hackwin internal <name>`, that is not a user command and does not add to the 9 commands `[ASSUMPTION A10]`.

### 6.5 Existing files

Section 20 states what each release contains. How `setup` treats a file that already exists, from the template or from the team's own work, is `[ASSUMPTION A45]`:

- `hackwin.yml`: its presence on main means the repository is configured (exit 2).
- `owners.yml`: an existing file is the starting proposal in step 4 of `setup`.
- Generated files (command wrappers, hook shims, the `hackwin` workflow): overwritten.
- The template's own CI workflow (`.github/workflows/check.yml`): removed when it is unchanged; kept, with a notice that the `hackwin` job now runs the project's check, when the team changed it.
- The research skill and subagent files: kept as they are.
- `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, the PR template, the task issue template, `.gitignore`, `.env.example`: existing content is kept. `setup` adds or replaces only its own block, marked `hackwin:begin` and `hackwin:end` (in JSON files: only its own keys and list entries).
- Documents under `docs/hackwin/`: created only when missing.

## 7. Command specifications

### 7.0 Behavior common to all 9 commands

| # | Requirement |
| --- | --- |
| CM1 | Every command is a thin wrapper over the CLI, where all logic lives. `/take` in Claude Code, the skill `take` in Codex and `hackwin take` in a terminal behave identically [B]. The Codex form is beta in v1 [D7]. |
| CM2 | Exit codes: 0 success; 1 a rule or check blocked the action; 2 configuration or precondition error; 3 GitHub or network failure. |
| CM3 | Every command can be rerun after a failure; `setup` is rerun as `setup --resume`. A rerun continues from the first unfinished step and never creates a second copy of an issue, label, PR, comment or worktree. |
| CM4 | Every message that tells a human or an agent to run something names the directory to run it in [B]. |
| CM5 | A block names the rule, the files or objects involved, and the command that resolves it. |
| CM6 | Output is short by default, because long tool output costs tokens in the calling session; `--json` gives the full machine readable result. |
| CM7 | All GitHub access goes through `gh`, all repository access through `git`. Both were essential at HackYeah [T]. |
| CM8 | Except `setup` during bootstrap, no command pushes to the default branch. After that it changes only through the Gate's merges of PRs (G15). |
| CM9 | Commands read `hackwin.yml` and `owners.yml` from `origin/main` after a fetch (A17). |
| CM10 | A command that runs in the main checkout first fast forwards it to `origin/main` when it is on the default branch with a clean tree; otherwise it warns that the checkout is behind. The Planner and the human therefore never work on a stale tree `[ASSUMPTION A52]`. |
| CM11 | `setup` and `join` ask their questions in an interactive terminal, or read the answers from `--answers <file>`, so that a wrapper or a test can drive them `[ASSUMPTION A47]`. `gate` and the human approval commands run only in an interactive terminal. A typed confirmation means that the command prints what it is about to do and proceeds only when the human types `yes`. The answers file is YAML: it uses the key names of `hackwin.yml` for everything stored there, `roles` and `open` in the form of `owners.yml`, `invite` for the invitation question and, for `join`, `language` and `explanation_style` `[ASSUMPTION A61]`. |
| CM12 | Every command compares its own version with `cli_version` on `origin/main`. The releases of one phase differ only in the patch number, so the major and minor numbers name the phase `[ASSUMPTION A60]`. An older CLI, or a CLI of another phase, exits 2 and prints the install command for the pinned version [D10]. A newer bug fix release of the same phase prints a one line warning and continues, which installing a bug fix release needs (20.6). One exception: `status --report` only reads, so a CLI of a later phase runs it on a project of an earlier phase and names that phase in the report header (I9). `setup` pins its own version. |
| CM13 | `tasks` and `propose` also work without an agent session: `--new` writes an empty draft in the format of section 8.1 into the drafts directory and prints its path, for a human to fill in an editor `[ASSUMPTION A61]`. |

Sub-flags named below (for example `plan --freeze`) belong to their command and are not additional commands `[ASSUMPTION A10]`.

### 7.1 `setup`

| | |
| --- | --- |
| Who | The Lead |
| When | Once per project, before the event or at its start, in the main checkout of a clone of the team repository (created from the template, or any existing repository) |
| Phase | 1 |

**Preconditions.** A git repository with a GitHub remote; `gh` authenticated as the Lead, with admin rights on the repository; a clean working tree on the default branch; no `hackwin.yml` on `origin/main`. `--resume` and `--regenerate` run on a configured repository instead (see the failure behavior).

**Steps.**

1. Check the preconditions and the versions of `git`, `gh` and Node.
2. Ask a few questions [B]: number of people (1 to 4); who is the Lead; for each person the name, the GitHub login, the agent (`claude`, or `codex` as a beta [D7]) and the number of sessions (1 or 2; 3 is offered as advanced with a warning [B]). The Lead runs `setup` [B]: when the login named as the Lead differs from the `gh` login, `setup` exits 2 and says so, because the branch rules, the Gate and the approvals are tied to the Lead's account `[ASSUMPTION A62]`. `setup` refuses `codex` as the Lead's agent and says why: the only block against a merge by the Lead's own sessions is the Claude Code deny rule (10.6), and from Phase 3 on the Resolver needs the `claude` CLI on the Lead's laptop [D12]. In an interactive terminal it then asks again; with an answers file it exits 2 `[ASSUMPTION A62]`.
3. Check that each login exists and whether it has write access.
4. Propose ownership roles and path globs from the directory tree. The Lead edits and confirms the role names and globs and assigns each role to one member; the shared role goes to the Lead. In an empty repository the Lead types the roles and globs; the HackYeah layout (one directory per feature role, everything else shared [W]) is shown as an example.
5. Detect the stack commands (install, check, test, format, generate, lockfile regeneration) from the project files and show them for confirmation. The Lead only confirms or edits them [B]. Detection for Node projects is required in v1, because HackWin itself is tested on Node with Tailwind [B]; for any other stack `setup` asks for each command it could not detect. It also asks for an optional smoke test command. It then proposes the path groups of `paths` that are known before planning: manifests and lockfiles from the detected stack and, where the project files show them, the migration directories, the production config files and the ledger. The Lead confirms, edits or leaves a group empty, except `manifests`, which must name at least the manifest of the planned stack; a group can be set later through a PR (I16) `[ASSUMPTION A62]`.
6. Ask for the event start and end and, from Phase 3 on, for the Resolver model: the strongest model available to the Lead [B].
7. Detect the repository visibility. Public is the default recommendation because a public repository gets full branch protection for free [B]. `setup` never changes visibility itself.
8. Generate every committed file of section 6.4, treating files that already exist as section 6.5 states, and validate `hackwin.yml` and `owners.yml`.
9. Create the bootstrap commit on the default branch and push it. This is the only direct push to the default branch in the life of the project; it happens before any protection exists.
10. Create the labels of section 8.2 and, after confirmation, invite the members who lack write access.
11. Apply two sets of rules to the default branch and read both back from GitHub. Protection was the missing piece at HackYeah, where a protection file existed but was never applied [T].
    - Rules for everyone, the repository owner included: changes only through a PR, the CI check `hackwin` required, force pushes and branch deletion blocked `[ASSUMPTION A32]`. "Require branches to be up to date" stays off, because the Gate's merge test on the newest main gives the same guarantee without a new CI run per merged PR (A32).
    - The update restriction: only the Lead's account can update the default branch, so GitHub refuses a merge by any other account [D2]. The exact mechanism is verified at build time (section 5.6). When it works through a bypass list, the restriction is a rule set of its own, so that the bypass does not lift the rules above for the Lead.
12. Fall back where GitHub refuses. Without the update restriction the rules for everyone still apply, and merges by agent sessions are blocked only softly (10.6) [D2]. Without any protection (a private repository on a free plan has none [B]) `setup` switches to soft protection: the `pre-push` hook blocks pushes to main, agent sessions have no right to merge, and the Gate serializes merges [B]. Work continues in both cases.
13. Enable GitHub's secret scanning push protection for the repository where GitHub offers it, and read the setting back [D19]. Availability and the exact setting are verified at build time (5.6). Where GitHub refuses it, `setup` reports push protection as off and continues. HackWin's own secret scans (E6) run in both cases.
14. Run the steps of `join` for the Lead's machine.
15. Print a summary: the protection state, whether push protection is on, the command each member runs (`hackwin join`), the next steps (`hackwin gate` in a separate terminal, then `plan` or, in Phase 1, the first tasks written by hand) and a reminder to send `.env.local` to each member over a private channel [B].

The protection state (full with the update restriction, full without it, or soft) is not stored in a file. `setup` and `gate` read it from GitHub with the Lead's token. The Gate publishes it in the status issue, where `status` reads it on every machine (9.6).

**Outputs.** The committed files, the GitHub labels, the branch rules or a notice of the fallback in use, the push protection setting or the notice that it is off, the Lead's local files, the summary.

**Failure behavior.**

- A failure before the push of step 9 succeeds changes nothing on GitHub; `setup` removes its own commit and files, so the working tree is as it was.
- After that push, `hackwin setup --resume` repeats every step that did not finish.
- More than 4 people: exit 2 (A34).
- A second run on a configured repository: exit 2 with the message that configuration changes go through a PR by the Lead.
- `hackwin setup --regenerate` installs a bug fix release of the same phase (20.6). In the worktree of a task of the shared role it rewrites the generated files and HackWin's own blocks in the kept files (6.5) and sets `cli_version` to its own version, for the Lead to ship. A CLI whose phase differs from that of `cli_version` exits 2 [D10]. On the default branch it exits 2 and names that procedure.

### 7.2 `join`

| | |
| --- | --- |
| Who | Every member, the Lead included (`setup` runs it for the Lead) |
| When | Once per machine, after cloning the repository |
| Phase | 1 |

**Preconditions.** A clone whose `origin/main` contains `hackwin.yml`.

**Steps** [B].

1. Find the person: match the `gh` login to `team.members`.
2. Check `gh` authentication and write access to the repository.
3. Check git (including support for `merge-tree --write-tree`), Node, and the presence of the member's agent CLI. From Phase 3 on, also check on the Lead's machine the `claude` CLI that the Resolver needs.
4. Run `commands.install` in the main checkout. While no file matches `paths.manifests`, as in an empty repository before the foundation, the step is skipped with a notice `[ASSUMPTION A62]`.
5. Activate the git hooks: point `core.hooksPath` of the clone at `.githooks` and run the hooks' self test.
6. Ask for the answer language and the explanation style; write them to `local.yml` and `CLAUDE.local.md`. These are personal settings and never enter the repository [B].
7. Check that `.env.local` exists whenever `.env.example` lists at least one key. The file is never opened [B].
8. From Phase 3 on, for a Codex user (beta): print whether the Codex hook flag is active and how to activate it (verify at build time).
9. Remove worktrees of tasks whose PR is merged (A35).
10. Show the member's queue, as `status` does.

**Outputs.** A checklist with one pass or fail line per step; the local files; active hooks; the queue. A run that exits 0 is recorded in `local.yml`: this record is what "`join` is complete" means in the preconditions of other commands.

**Failure behavior.** A failed check prints its fix and the command continues with the remaining checks; the exit code is 1 when any check failed. The login is not in the team: exit 2 with "ask the Lead to add you to `hackwin.yml`". Missing `.env.local`: exit 1 naming the Lead as the source. Rerunning is always safe.

### 7.3 `plan`

| | |
| --- | --- |
| Who | The Lead with the Planner session, in the main checkout |
| When | At the start of the event, once the challenge is known and before any task exists |
| Phase | 2 |

`plan` produces the PRD, the spec, the design, the contracts and the foundation, and freezes the contracts [B]. The writing is the Planner's work; the CLI scaffolds, validates and freezes.

**Preconditions.** `setup` is complete; no tag `hackwin/contracts-frozen` exists; the working tree is clean.

**Steps.**

1. `hackwin plan` takes the planned freeze time from `--freeze-at <time>`, or asks for it in an interactive terminal, and suggests 45 minutes after the event start, the HackYeah value [B]. The wrapper asks the Lead in the conversation and passes the answer `[ASSUMPTION A61]`. The command creates the task issue "Foundation" with a full data block (kind `foundation`, the shared role, the shared paths, the planned freeze time as its deadline, the Lead as assignee, the label `in-progress`) and the branch `task/<N>-foundation` in the main checkout. The Foundation PR therefore follows the rules of every other PR (section 8.4).
2. The Planner, guided by the wrapper, writes:
   - `docs/hackwin/prd.md`, `spec.md` and `design.md` [B];
   - `docs/hackwin/non-code.md`: the deliverables outside the code (demo video, pitch, presentation, submission) and the external resources the project needs [B];
   - `docs/hackwin/epics.md`: the whole project as an outline of epics, each with an ownership role [B];
   - the contracts under `paths.contracts`: types, API and database schema [B];
   - the foundation: shared types, the installed dependencies, and for every contract that another role consumes a mock, so that consumers can work against types and a mock before the provider exists [B];
   - the keys under `paths` in `hackwin.yml` that `setup` left open, at least `contracts` and `generated` (I16).

   The points of contact must be detailed: types, API, database schema and acceptance criteria. Prose may stay general [B].
3. `hackwin plan --check` reads the branch's own copy of `hackwin.yml`, an exception to CM9 (A17), and validates that the five documents exist and are not empty, that `paths.contracts` matches existing files, that every epic names an existing ownership role, that generated files are current, and that `commands.check` passes on the branch. It warns when `paths.gated` is empty, because the Gate then raises no attention line for migrations or production config (9.5).
4. `hackwin plan --freeze` runs the check and then the same steps as `ship` (section 7.9, steps 3 to 14): scope, secrets, full checks, check record, push, the PR "Foundation" with `Closes #<N>`, and the issue report. It waits until the Gate has merged the PR, then creates and pushes the tag `hackwin/contracts-frozen` on the merge commit `[ASSUMPTION A20]`, switches the main checkout to the updated main and names the next step (`tasks`).

From the freeze on, the Planner session writes no code (18.3 C9), and files under `paths.contracts` change only through the contract change flow (section 8.5).

**Outputs.** The documents, the contracts and the foundation on main; the freeze tag; the closed Foundation issue.

**Failure behavior.**

- The check fails: the command lists what is missing and pushes nothing.
- The Gate is not running: the PR is opened, the command says so and exits 1; after `hackwin gate` is started, `hackwin plan --freeze` resumes at the waiting step.
- The Gate rejects the PR: the command prints the Gate's comment; the Planner fixes the branch and reruns `plan --freeze`.
- The planned freeze time, which is the deadline of the Foundation issue, passes without a tag: `status` shows "contract freeze overdue" to everyone.

### 7.4 `tasks`

| | |
| --- | --- |
| Who | The Lead with the Planner. Any member may run it as a substitute when the Lead's plan limit is exhausted, because all state is on GitHub [B] |
| When | After the freeze for the first wave; then at checkpoints or when someone's queue runs out [B] |
| Phase | 2 |

`tasks` turns the next wave of the plan into issues and checks them for path collisions [B].

**Preconditions.** The freeze tag exists; `docs/hackwin/epics.md` exists.

**Steps.**

1. `hackwin tasks` prints the planning context: the epics outline, open and closed tasks per role, the length of each member's queue, the time left until `project.event.end`, and the task rules of section 8.1.
2. The Planner drafts the wave as a local draft file: a list of tasks in the draft format of section 8.1 (without an agent: CM13). Only this wave becomes issues; the rest of the project stays an outline of epics. The first wave covers 3 to 5 hours [B].
3. `hackwin tasks --check <draft>` validates every task and the wave as a whole:
   - the format is complete (section 8.1);
   - the role exists and every allowed path lies inside that role's scope or on the `open` list;
   - every dependency names an existing issue or a task of the same draft;
   - the deadline lies inside the event;
   - **collision check**: two tasks that can run at the same time (neither depends on the other, directly or through other tasks) must have disjoint allowed paths, inside the draft and against every open task [B]. Paths on the `open` list are exempt;
   - warnings, not errors `[ASSUMPTION A50]`: more allowed files than `tasks.max_files`; a task that depends on a task of another role in the same wave without being an integration task (T9).
4. `hackwin tasks --publish <draft>` runs the check of step 3 again and publishes nothing on an error. Otherwise it creates one milestone for the wave and one issue per task with its labels, assignee (the current holder of the role) and body. Every issue starts with the label `needs-lead` and cannot be taken yet.
5. The Lead approves the wave [B]: `hackwin tasks --approve --wave <n>`, run in a terminal with a typed confirmation (CM11), removes `needs-lead` and sets `blocked` on tasks with open dependencies and `ready` on the others. `hackwin tasks --approve <issue>...` releases tasks written by hand in the same way (I3). It exits 2 for an issue that is not a task issue and skips, with a notice, a task that is already released, in progress or in review. The command needs no model, so it works when the Lead's plan limit is exhausted and when a substitute published the wave `[ASSUMPTION A18]`. When the Lead runs `--publish` in an interactive terminal, the confirmation is asked at once and both steps happen together.
6. The command prints each member's queue.

A scope change of a published task is made by editing the issue body and adding one comment that starts with "Scope change:". Issue comments are used only for scope changes and agent reports [B].

**Outputs.** The milestone, the issues, the printed queues.

**Failure behavior.**

- `--check` reports every problem at once and publishes nothing. A collision names both tasks and the overlapping paths.
- A publish interrupted by a network failure records the issues already created in the draft file; rerunning creates only the missing ones.
- Run before the freeze: exit 2 naming `plan --freeze`.
- `--approve` by anyone but the Lead: exit 2.

### 7.5 `gate`

| | |
| --- | --- |
| Who | The Lead, in a separate terminal on the Lead's laptop [B] |
| When | Started once after `setup`, before the first PR; it runs for the whole event |
| Phase | 1; the Resolver from Phase 3 |

`gate` starts the Gate and, from Phase 3 on, the Resolver with it [B]. Section 9 specifies the pipeline; this section specifies the process.

**Preconditions.** The `gh` login equals `team.lead`; no other Gate holds the lock on this machine; the command runs in an interactive terminal. The `/gate` wrapper inside an agent session never starts the Gate: it prints the instruction to run `hackwin gate` in a separate terminal and says whether a Gate is already running. A Gate started inside a conversation would repeat the HackYeah failure (G1).

**Steps.**

1. Verify the identity. Anyone other than the Lead gets exit 2 with the message that there is one Gate, on the Lead's laptop, and that merges wait while it is down [B].
2. Take the lock file; a lock left by a dead process is replaced. Count the start in the state file: every start after the first is a restart (M7).
3. Start the keep awake mechanism of the operating system so the laptop does not sleep while the Gate runs [B].
4. From Phase 3 on, check that the `claude` CLI works for the Resolver. When it does not, start without the Resolver and say so (A28).
5. Load the state file. A PR that was inside the pipeline restarts at the first stage with its recorded head SHA; scratch worktrees are rebuilt.
6. Find the status issue by its label, or create and pin it at the first start, and write the first heartbeat into it, which clears an earlier stop time (G25).
7. Print the header: protection state, Resolver availability, poll interval, number of queued PRs, link of the status issue and, while `paths.gated` is empty, a notice that no attention line for a migration or a production config change can be raised (9.5).
8. Run the loop of section 9 until the Lead stops it.
9. Accept typed input in the Gate terminal while the loop runs: `retry <PR>`, which queues the PR's current head SHA again, as at intake, after a failure that needs no new commit, such as a CI timeout or a flaky test `[ASSUMPTION A43]`; `ack <PR>`, which closes the secret attention item of that PR once the Lead has rotated the secret (9.6); and `quit`, which stops after the current step and writes the stop time into the status issue.

**Outputs.** The running process; the state file, heartbeat and digest; the status issue [D4]; one digest line per PR in the terminal; labels and comments on PRs; merged PRs; attention lines for the five attention types [D3]; for a secret also an operating system notification (G26) [D16].

**Failure behavior.**

- The Gate never exits because of an event [B]. An unexpected error inside one PR's pipeline marks that PR as failed with the reason `gate-error` and the loop continues with the next PR.
- GitHub or network failure: retry with increasing waits; the local heartbeat keeps recording that the loop is alive and separately when GitHub last answered. The status issue then shows an old heartbeat, which is the right signal for teammates.
- Crash or terminal closed: all progress is in the state file; `hackwin gate` resumes it. No other recovery step exists.
- Laptop asleep or off: merges wait until it returns [B]. No other member can start a Gate [B].

### 7.6 `status`

| | |
| --- | --- |
| Who | Everyone |
| When | At any time. On every machine it shows the Gate's heartbeat, open attention items and digest, read from the status issue [D4] |
| Phase | 1; `--report` from Phase 3 |

`status` answers: who does what, what waits for a merge, what is blocked, and what the Gate did [B]. It is built from GitHub, so it gives the same answer in a new session after a reset and on every laptop [B].

**Preconditions.** A clone with `hackwin.yml` on `origin/main` and a working `gh` login.

**Steps.**

1. Read the open and recently closed issues, the open PRs, their labels, the milestone of the current wave and, from Phase 2 on, the freeze tag from GitHub.
2. Read the status issue: heartbeat time, stop time, protection state, queue order, open attention items and digest [D4]. The Gate stage of each PR comes from its labels [B]. On the Lead's laptop, also read the local heartbeat, which is newer than the issue between two edits.
3. Print the sections below in this order.

**Outputs.** The sections below, in this order.

| Section | Content |
| --- | --- |
| Header | Protection state, as the Gate published it (unknown before the Gate's first start); from Phase 2 on, the contract freeze state (pending, frozen, overdue) (I15); time left to `project.event.end`; Gate liveness: the age of the heartbeat in the status issue, or "stopped by the Lead" after `quit`; the link of the status issue |
| Attention | The open items of the five attention types (migration, production config, scope violation, repeated failure, secret), read from the status issue; they are addressed to the Lead and visible to everyone [D3][D4]. For the Lead also everything labeled `needs-lead`. For any member: their PRs labeled `needs-owner`, `gate:failed`, `scope-violation` or `hotspot`, and their issues labeled `contract-changed` |
| Who does what | Per member: tasks in progress with deadline, overdue tasks marked, the next ready tasks |
| Waiting for merge | The queue in order, each PR with its Gate stage |
| Blocked | Tasks blocked by dependencies, task issues with an invalid data block, from Phase 2 on tasks written by hand that wait for `tasks --approve` (I3), and failed PRs, each with the reason |
| Gate digest | One line per PR processed since this member's previous `status` call, plus every PR that still needs action [B], taken from the status issue [D4] |

**Flags.** `--report` produces the metrics report of section 12 [B]; `--json` prints the data.

**Failure behavior.**

- GitHub unreachable: exit 3; on the Lead's laptop the local heartbeat is still printed.
- Stale heartbeat (older than `gate.heartbeat_stale_seconds`) without a stop time: on every machine the first output line is a warning with the heartbeat age. After `quit` the first line says instead that the Lead stopped the Gate, and when.
- No status issue exists: the header says that the Gate has not been started. This is not an error.

### 7.7 `take [N]`

| | |
| --- | --- |
| Who | A builder, the Lead included |
| When | Whenever one of the member's sessions is free |
| Phase | 1 |

`take` removes the hand copied prompt: it checks the task, prepares an isolated worktree and starts the agent with a prompt composed on the member's machine [B].

**Preconditions.** `join` is complete; from Phase 2 on, the freeze tag exists (I3); with a number, issue N is an open task.

**Checks** (all must pass) [B]:

1. Assignment: the caller holds the task's role in `hackwin.yml` on main, whoever the assignee is, so after a role swap the open tasks of a role belong to its new holder [B].
2. The task is open with a valid data block, is not in progress, in review or cut, and is not labeled `needs-lead`. From Phase 2 on it must also carry `ready` or `blocked`, the labels of a task that went through `tasks` or `propose`; a task written by hand gets them from `tasks --approve <N>` (I3).
3. Every dependency is closed.
4. No open PR changes a file inside the task's allowed paths, and no other task in progress has overlapping allowed paths. Paths on the `open` list are exempt.
5. The caller runs fewer tasks than their `sessions` value. Together with check 4 this guarantees that a member never runs more sessions than they have disjoint tasks in scope [B].

Without a number, `take` picks the first task of the caller's queue (8.1) that passes all checks and prints which tasks it skipped and why [B].

**Steps.**

1. Fetch, verify that the git hooks are active and repair `core.hooksPath` when they are not (E20), and run the checks.
2. Remove the worktrees of the caller's tasks whose PR is merged `[ASSUMPTION A35]`.
3. Print a warning for each of the caller's PRs that waits for them (`needs-owner`, `gate:failed`, `scope-violation`).
4. Set the label `in-progress` in place of `ready` and make the caller the assignee [B], which claims the task before the slower steps, and add the `role:` label when a task written by hand lacks it.
5. Create the branch `task/<N>-<slug>` from the fresh `origin/main` and a worktree for it [B] `[ASSUMPTION A9]`, or reuse both when an earlier `take` left them. Link `.env.local` and `CLAUDE.local.md` from the main checkout into the worktree `[ASSUMPTION A13]`. Run `commands.install` there, unless `join` would skip it (7.2 step 4); worktrees share the package manager's cache [B] `[ASSUMPTION A11]`.
6. Compose the prompt locally from the issue, `AGENTS.md` and the rules of the role [B]. The prompt contains, in this order:
   - the task: problem, expected result, acceptance tests, deadline as the hard stop time, and every "Scope change:" comment;
   - the role, its owned paths, and the statement that every other path must not be touched and that shared changes are requested through `propose` (before Phase 2: from the Lead, I14);
   - where to run: the absolute worktree path and the branch name [B];
   - what changed on main since the main commit last recorded for this worktree by `take` or a session start or, for a new worktree, last recorded anywhere in this clone, with contract changes and the member's own scope first (E5). The first `take` in a clone has no such commit and says so. `take` then records the current main commit for the worktree;
   - the finish rule: commit, run `ship`, then stop with the PR number and head SHA, and never merge [B];
   - the security rules: never read or print `.env.local`, and leave every database and production config change to the Lead, also changes made outside the repository [B];
   - the member's personal settings (answer language, explanation style), so they apply in both agents `[ASSUMPTION A14]`.

   This is the content the HackYeah command center put into every hand written prompt [W].
7. Start the agent. In a terminal, `take` launches the member's configured agent in the worktree with the prompt as the first message, which gives every task a fresh, cheap context; at HackYeah task sessions used 2 to 24M tokens each against 338M for the session that was never cleared [T]. This terminal mode is the primary one [D18]. For a Codex user this start arrives with Phase 3; until then `take` prints the prompt file and the command that starts Codex (I10). Called from inside a running session through `/take` or the skill, it prints the prompt and the session continues in the worktree `[ASSUMPTION A12]` (section 5.6).

**Resuming and releasing** `[ASSUMPTION A12]`.

- `take N` on the caller's own task that is `in-progress`, for example after a crash, a usage limit or a cleared session, reopens its worktree and composes a continue prompt: the seven parts of step 6 plus the state of the branch. When the task has no prompt file yet, because an earlier `take` stopped before step 6, `take N` finishes steps 5 to 7 with the first prompt instead.
- `take N` on the caller's own task that is `in-review` and whose PR is labeled `gate:failed` reopens the worktree, brings the local branch up to the remote branch (the Gate may have pushed a fix to it) and composes a fix prompt: the seven parts of step 6 plus the Gate's comment.
- `take N --release` returns the caller's `in-progress` task to `ready`, frees the session slot and keeps the branch for the next `take`.

For a resume, checks 2, 4 and 5 do not count the task itself or its own PR, and check 2 does not ask for `ready` or `blocked`.

**Outputs.** The worktree and branch, the label and assignee change, the prompt file, the running session.

**Failure behavior.**

- A precondition fails: exit 2 naming the missing step: `hackwin join` or, from Phase 2 on, `plan --freeze`.
- A failed check: exit 1 with the reason and the next action, for example "blocked by #<issue>, still open", "path collision with PR #<PR>: <file>" or "you already run <count> tasks: <list>".
- Empty queue: exit 0 with "queue empty"; the message tells the member to ask the Lead for the next wave, which is due when a queue runs out [B].
- The worktree cannot be created: the label and assignee change is undone, exit 2.
- `commands.install` fails in the worktree: exit 1 with the log. The worktree and the label stay, and a later `take N` finishes the remaining steps.
- The agent cannot be started: the worktree and label stay; the command prints the prompt file path and the start command.

### 7.8 `propose`

| | |
| --- | --- |
| Who | Any member drafts and publishes; the Lead accepts or rejects; the author completes; the Planner or the Lead marks affected work |
| When | A member has an idea of their own, or needs a change in a scope they do not own: another role's code, shared code, global styles, a new dependency, a contract |
| Phase | 2 |

**Preconditions.** `join` is complete.

**Steps.**

1. The session drafts the proposal with the member in the draft format of section 8.1: title, problem, expected result, allowed paths. Without an agent, `propose --new` creates the empty draft (CM13).
2. `hackwin propose --check <draft>` classifies the proposal by its paths: own scope (every path lies inside the author's scope or on the `open` list), foreign scope (any path of another role or of the shared role), or contract change (any path under `paths.contracts`, section 8.5). A draft whose paths span more than one role is rejected with the advice to split it, because one task belongs to one role.
3. **Own scope.** Acceptance is automatic [B]. The author completes the full task format, including acceptance tests and a deadline [B]. `hackwin propose --publish <draft>` runs the collision check of `tasks` and creates the issue with the labels `proposal`, the role label and `ready` (or `blocked` while a dependency is open), assigned to the author, who may `take` it at once [B].
4. **Foreign scope or contract change.** `--publish` creates a short issue (title, problem, expected result, paths; format in section 8.1), so that the Lead can see the proposal before deciding `[ASSUMPTION A19]`, with the labels `proposal` and `needs-lead`, plus `contract-change` for a contract change. The Lead decides [B] in a terminal with a typed confirmation: `hackwin propose --accept <N>` replaces `needs-lead` with `approved`; `hackwin propose --reject <N> "<reason>"` closes the issue.
5. **Completion.** After acceptance the author fills the issue in the full task format [B] with `hackwin propose --complete <N> <draft>`. The command exits 2 unless issue N carries `approved`. It validates the draft, runs the collision check, sets the label of the role that owns the paths, makes that role's holder the assignee, and sets `ready` or `blocked`. The task then follows the normal flow of `take` and `ship` [B]. The owner implements it, so shared code keeps one author [D5].
6. **Marking.** For an approved contract change, the Planner or the Lead runs `hackwin propose --mark <N> <numbers>` (CC5). It requires that issue N carries `contract-change` and `approved`, and exits 2 for a number that is not an open issue or PR.
7. **Experiments.** `hackwin propose --spike <name>` creates the branch `spike/<name>` and a worktree. A spike branch is never merged [B]: `ship` refuses it and CI fails any PR from it (E16).

**Outputs.** One issue per proposal, or a spike branch and worktree.

**Failure behavior.**

- The check finds a collision with an open task: the command names the task and suggests adding it as a dependency; nothing is created.
- A rejected proposal is closed and the Lead's reason is written into the issue body under "Decision".
- `--accept` or `--reject` by anyone but the Lead: exit 2.

### 7.9 `ship`

| | |
| --- | --- |
| Who | The builder's session, or the builder, inside the task worktree |
| When | The work is committed and the acceptance tests pass locally |
| Phase | 1 |

`ship` merges main into the branch, runs the full tests and the acceptance criteria, opens the PR, reports in the issue and stops [B]. It contains only deterministic steps.

**Preconditions.** The current directory is a task worktree on a `task/` branch; the working tree is clean; the task issue is open and `in-progress` or `in-review`.

**Steps.** A step runs only when every earlier step succeeded. This order is the fix for the HackYeah push that went out before its checks had finished [W][P].

1. Fetch `origin/main` and the task branch, read the task issue, and verify that the git hooks are active, repairing `core.hooksPath` when they are not (E20). If the remote branch has commits that the local branch lacks, because the Gate pushed a fix, merge them in first; a conflict there is handled as in step 2.
2. Merge `origin/main` into the branch. Never rebase, never force push [W]. On a conflict, stop and list the files: the session resolves them, because the branch owner knows the intent of the change [B], commits and runs `ship` again. This includes conflicts in the README and, for the Lead, in shared files; the Resolver handles the conflicts that appear after `ship` `[ASSUMPTION A46]`.
3. Scope check on the branch's own changes: a file outside the author's roles and the `open` list blocks; a file inside the role but outside the task's allowed paths only produces a warning `[ASSUMPTION A15]`.
4. Secret scan of the added lines (E6).
5. Format check of the changed files only.
6. Generated file check (E10) and, from Phase 2 on, the contract check (E9).
7. Full checks: `commands.check`.
8. Acceptance tests: every test named in the task exists and passes when run with `commands.test` [B].
9. Write the green check record for the head commit.
10. Push the branch. The `pre-push` hook accepts it because the record exists.
11. Open the PR, not as a draft, from the PR template with `Closes #<N>`, or update the open PR of this task. A PR that was closed without a merge is not reused.
12. From Phase 3 on, print a hotspot notice for every other open PR that changes one of the same files (H2).
13. Comment on the issue: PR number, full head SHA, the checks that ran with their results [B] and, from Phase 3 on, the token count of the task's sessions when it is available `[ASSUMPTION A33]`.
14. Replace the issue label `in-progress` with `in-review`, and remove `contract-changed` when the branch now contains the merged contract change (CC8). The Gate clears the failure labels of an earlier run when it sees the new head SHA (9.2).
15. Print the stop line: `PR #<PR> opened at <SHA>. Do not merge. Stop.` [B]

**Outputs.** The pushed branch, the PR, the issue report, the labels, the stop line.

**Failure behavior.**

- Steps 2 to 9 use only local data and the task issue read in step 1: a failure there exits 1, names the step and its log, and pushes nothing. A failed fetch or GitHub call in step 1 exits 3.
- A failure in steps 10 to 14 exits 3; rerunning continues at the failed step without repeating the checks for the same commit.
- Called outside a task worktree: exit 2 with the paths of the caller's task worktrees. This removes the HackYeah failure of a command run in an old checkout [W].
- Called on a `spike/` branch: exit 1, "spike branches are never merged" [B].

## 8. Tasks, labels, lifecycle and contract changes

### 8.1 Task rules and issue format

| # | Rule | Source |
| --- | --- | --- |
| T1 | One issue is one PR | [B] |
| T2 | Every task is a GitHub issue with a role (label), allowed paths, dependencies, acceptance criteria and a deadline | [B] |
| T3 | The Planner writes a task (problem, expected result, acceptance criteria), not a prompt. `take` composes the prompt | [B] |
| T4 | Size: about one hour of agent work and up to about 10 files. Small PRs are the priority | [B] |
| T5 | Acceptance criteria are written as tests. A task names its test files or test ids; a named test that does not exist counts as a failure | [B] |
| T6 | Larger units are grouped by sub-issues or a milestone, never by a checklist inside one issue | [B] |
| T7 | Planning goes in waves: the whole project as an outline of epics with roles, only the next wave as ready issues, each wave approved by the Lead | [B] |
| T8 | Before publication, tasks that can run in parallel are checked for overlapping paths | [B] |
| T9 | Dependencies between people: a consumer works against the types and the mock from the contract; connecting provider and consumer is a separate integration task at the end of the wave | [B] |
| T10 | Issue comments are used only for scope changes and agent reports | [B] |
| T11 | Every task has a deadline. `status` marks overdue tasks; cutting a task is the Lead's decision (label `cut`) `[ASSUMPTION A40]` | [B][W] |
| T12 | The instruction of every task states where to run: `take` adds the worktree path and branch to every prompt | [B] |

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

A task issue is an issue whose body contains the `# hackwin:task` block; the task commands ignore every other issue, the status issue included. `tasks --check`, `propose --check`, `take` and CI reject a block that is invalid. Three rules apply to the block: every path lies in exactly one role or on the `open` list; `acceptance_tests` may be empty only for the kind `foundation`, whose acceptance is `plan --check`; a deadline is always present. In Phase 1 the same body is written by hand from the task issue template (I2).

A proposal that waits for the Lead (7.8 step 4) is not a task issue yet `[ASSUMPTION A19]`. Its body holds a block `# hackwin:proposal` with the keys `kind` and `paths`, then the headings Problem and Expected result; for a contract change the text states what changes in the interface, why, and which roles consume it (CC2). `propose --complete` replaces the body with the task format, and `propose --reject` adds the heading Decision with the Lead's reason.

A member's queue is the list of open task issues whose role the member holds and that are not in progress, in review or cut. Its order is: wave, with tasks without a wave last; then deadline; then issue number.

**Draft files** `[ASSUMPTION A51]`. `tasks` and `propose` read drafts in one YAML format:

```yaml
wave: <wave number>            # omitted in a proposal draft
tasks:
  - id: <local id>             # used only inside the draft
    title: "<issue title>"
    kind: task
    role: <ownership role>
    paths: [<glob>]
    depends_on: [<issue number or local id>]
    acceptance_tests: [<test file or test id>]
    deadline: "<ISO 8601 with offset>"
    problem: |
      <text>
    expected_result: |
      <text>
    acceptance_criteria: |
      <text>
    out_of_scope: |
      <text>
```

At publication a local id in `depends_on` is replaced by the number of the issue created for it. A proposal draft holds exactly one task.

`docs/hackwin/epics.md` has one level 2 heading per epic, followed by a line `Role: <ownership role>` and free text. `plan --check` and `tasks` read only the headings and the role lines.

### 8.2 Labels

The brief names four labels: `in-progress`, `proposal`, `contract-change` and `needs-owner` [B]. All other names are `[ASSUMPTION A8]`.

| Label | On | Set by | Meaning |
| --- | --- | --- | --- |
| `role:<name>` | Issue | `tasks`, `propose`; `take` for a task written by hand | The ownership role that does the task [B]. It mirrors the `role` field of the data block |
| `ready` | Issue | `tasks`, `propose`, `take --release`, Gate | Released for work and takeable: its dependencies are closed |
| `blocked` | Issue | `tasks`, `propose` | Released for work, waiting for a dependency |
| `in-progress` | Issue | `take`; `plan` for the Foundation issue; the Gate when a PR is closed without a merge | A session works on it [B] |
| `in-review` | Issue | `ship` | A PR exists and waits for the Gate |
| `cut` | Issue | Lead | Dropped by decision of the Lead |
| `proposal` | Issue | `propose` | Came from a member's own idea [B] |
| `needs-lead` | Issue | `tasks`, `propose` | Waits for a decision of the Lead |
| `integration` | Issue | `tasks` | Connects provider and consumer at the end of a wave |
| `contract-change` | Issue | `propose` | Requests a change to a frozen contract [B] |
| `approved` | Issue | Lead, through `propose --accept` | The Lead accepted the proposal or the contract change. The label stays on the issue, and CI reads it for contract changes (CC7) |
| `contract-changed` | Issue, PR | `propose --mark` | An approved contract change affects this work |
| `gate:queued`, `gate:testing`, `gate:waiting-ci`, `gate:merged`, `gate:failed` | PR | Gate | The Gate stage; exactly one at a time, starting with `gate:queued` at intake [B], or with `gate:failed` when the intake scan finds a secret. A new head SHA or a `retry` replaces the labels of the earlier run, `needs-owner` and `scope-violation` included |
| `needs-owner` | PR | Gate | The PR author must act: a conflict in owner files or in gated files, a failed or missing Resolver [B] or, before Phase 3, any conflict (I7). Always together with `gate:failed` |
| `scope-violation` | PR | Gate | The PR changes files outside its author's scope. Always together with `gate:failed` |
| `hotspot` | PR | Gate | Another open PR changes the same file. Removed when the overlap ends |
| `gate-status` | Issue | Gate | Marks the one status issue of the Gate (G25). It is not a task |

### 8.3 Task lifecycle

| From | To | Trigger | Actor |
| --- | --- | --- | --- |
| Draft (local file) | `needs-lead` | `tasks --publish`; `propose --publish` for a foreign scope or a contract change | Planner, substitute, author |
| Draft | `ready` or `blocked` | `propose --publish` in the author's own scope | Author |
| No issue | `in-progress` | `plan` creates the Foundation issue (7.3) | Lead with the Planner |
| Issue written by hand (I2) | Takeable | Phase 1: at once, when the data block is valid. From Phase 2 on: `tasks --approve <issue>`, which sets `ready` or `blocked` (I3) | Nobody in Phase 1; the Lead from Phase 2 on |
| `needs-lead` | `ready` or `blocked` | For a wave: `tasks --approve`. For a proposal: `propose --accept` (label `approved`), then the author's `propose --complete` | Lead, author |
| `needs-lead` | Closed, rejected | `propose --reject` | Lead |
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

`take` and `status` decide whether a task is takeable from the actual state of its dependencies; the `blocked` and `ready` labels mirror that state for the GitHub view.

### 8.4 Pull request rules

- A PR is opened only by `ship`, or by `plan --freeze`, which runs the same steps. It always comes from a `task/` branch and names its task with `Closes #<N>` (T1). CI fails a PR without a valid task link (E11).
- The PR author is the member whose `gh` login pushed it; the scope check uses that login.
- A PR is never opened as a draft; the Gate ignores drafts (G7).
- No one merges by hand. The Gate merges with a merge commit, pinned to the head SHA it tested (G15).

### 8.5 Contract change flow

Contracts are frozen so that parallel work shares one source of truth [B][W]. After the freeze a contract changes only this way [B]:

| # | Step |
| --- | --- |
| CC1 | Once the tag `hackwin/contracts-frozen` exists, a change to any file under `paths.contracts` needs an issue with the label `contract-change` that the Lead approved [B]. |
| CC2 | Request: any member runs `propose`; a draft that touches contract paths is classified as a contract change. The issue states what changes in the interface, why, and which roles consume it. It gets `contract-change` and `needs-lead`. |
| CC3 | Approval: the Lead runs `hackwin propose --accept <N>`, which sets `approved`. The command asks for a typed confirmation and refuses to run without an interactive terminal, and the Claude Code settings deny it to agent sessions, so the approval comes from the human `[ASSUMPTION A21]`. `tasks --approve` and `propose --reject` behave the same way. |
| CC4 | Implementation: the requester completes the issue into a full task with `propose --complete`. It is a task of the shared role, done in one of the Lead's builder sessions, with the contract files and the files generated from them as allowed paths. Only the Lead generates files [B]. |
| CC5 | Marking: after the approval the Planner, or the Lead, marks the affected open issues and PRs with `hackwin propose --mark <N> <numbers>`, which adds the label `contract-changed` and one comment "Scope change: contract change #<N>: <what changes>" to each [B]. The comment has the form of a scope change comment, so it reaches the next `take` prompt and stays within T10. |
| CC6 | Visibility: builders see the marks at the start of a session (in the `take` prompt and in the Claude Code session start summary) and in the Attention section of `status` [B]. |
| CC7 | Enforcement: CI fails a PR that changes contract paths unless its task issue carries `contract-change` and `approved`, with `approved` set by the Lead's account (E9). |
| CC8 | Completion: when the contract PR is merged, every marked PR must take the new main before it can merge; the Gate's merge test on the newest main catches a PR that still relies on the old interface (G13). `ship` removes `contract-changed` from a task once its branch contains the contract merge. |

Why the marks matter: in a benchmark of parallel agents, a short message describing the completed concurrent change recovered 82% of the constructed runs, 97% of which had failed without it [R2]. The session start summary (E5) and the contract marks are HackWin's form of that message.

## 9. Gate pipeline and Resolver

The behavior of the HackYeah gate was good; only its place was wrong. It ran inside the integrator's conversation, so every event woke and blocked that conversation [B][P]. The Gate keeps the recipe and moves it into its own process.

### 9.1 Gate requirements

| # | Requirement | Source |
| --- | --- | --- |
| G1 | The Gate is its own operating system process in its own terminal on the Lead's laptop. It writes to its terminal, its files and GitHub and, for a secret, raises one operating system notification (G26). It never injects anything into an agent conversation | [B][D16] |
| G2 | One Gate per project. Only the Lead's account can start it. No takeover by another member | [B] |
| G3 | The Gate never exits because of an event. It runs until the Lead stops it | [B] |
| G4 | State is kept in a file: per PR the last head SHA, the stage and the result. It is written after every stage, so a restart resumes | [B] |
| G5 | A heartbeat is written at every poll and every stage change. Stage commands run as child processes, so polling, hotspot detection and the heartbeat continue while a stage runs | [B] |
| G6 | The Gate keeps the laptop awake while it runs | [B] |
| G7 | Intake: every open PR that is not a draft is a queue item, whoever its author is, the Lead included; the one exception is a head SHA in which the intake scan finds a secret (G12). Drafts are ignored. A new head SHA sends the PR to the back of the queue. A head SHA that the Gate pushed itself continues that PR's run. No session is woken for anything (18.3 C7) | [P] |
| G8 | A stage runs only when every earlier stage succeeded, the `&&` rule | [B] |
| G9 | No stage uses an LLM. The Resolver is started only at the conflict stage under RS1 | [B] |
| G10 | Gated paths (migrations, production config) are never handled by the Resolver: a conflict in them stops the run for the Lead. A PR that changes them raises an attention line of the type migration or production config and is otherwise processed like any PR. A hold until a manual `apply` is later (9.5) | [B][D1] |
| G11 | Scope check of the PR's own changes against `owners.yml` | [B] |
| G12 | Secret scan of the lines that each head SHA adds. It runs once per head SHA, at intake, so that a finding does not wait for the PR's turn in the queue `[ASSUMPTION A53]`. A finding fails the PR and raises an attention line of the type secret: the repository is public by default, so a secret that reaches the Gate is already exposed on a pushed branch and must be rotated at once, which only the Lead can do | [B][D3] |
| G13 | Merge test on the newest main with a cached dependency install | [B] |
| G14 | Flaky tests: `gate.ci_rerun_limit` CI reruns, by default one, before a PR is blamed, and a list of known time dependent tests | [B] |
| G15 | Merge with `gh pr merge <PR> --merge --match-head-commit <full SHA>`. The full SHA is required; a short SHA was rejected at HackYeah | [B][P] |
| G16 | Smoke test after the merge | [B] |
| G17 | Strictly one PR at a time, first in, first out by the time the current head SHA joined the queue, at intake or through `retry` `[ASSUMPTION A23]` | [B] |
| G18 | Reporting instead of interrupts: one digest line per PR. The Lead gets an attention line only for the five attention types: migration, production config, scope violation, repeated failure and secret | [B][D3] |
| G19 | The Gate never commits on main. A textual conflict is fixed on the PR branch, a semantic conflict by a separate small PR | [B][P] |
| G20 | If main moved after the merge test, conflict detection and the merge test run again before the merge | [P] |
| G21 | A failed run leaves exactly one comment on the PR with the stage, the reason and the next action; when the Gate pushed a fix in that run, the same comment also says what was resolved. A successful run in which the Gate pushed a fix to the PR branch, the script's or the Resolver's, leaves one comment that says what was resolved, so the author knows that the branch moved. Any other successful run leaves none; the label shows it `[ASSUMPTION A31]` | |
| G22 | After a merge the Gate deletes the remote branch, closes the task issue, sets dependents from `blocked` to `ready` and removes its scratch worktree | [B], A35 |
| G23 | Repeated failure means: the same PR fails the same stage on `gate.repeated_failure_threshold` consecutive head SHAs (default two), or that many consecutive queue items fail the same stage, or a known flaky test fails again after its rerun, or the post merge smoke test fails `[ASSUMPTION A24]` `[ASSUMPTION A42]` | [B] |
| G24 | Version 1 polls GitHub every `gate.poll_seconds`. At 60 seconds the HackYeah watcher made about 640 list calls in one night, negligible against GitHub's limit of 5,000 requests per hour [P]. Events instead of polling come later | [B][P] |
| G25 | The Gate keeps one pinned issue, the status issue, whose body holds the heartbeat time, the open attention items and the digest. The Gate updates it by editing the body, never by a comment, so it sends no notification, and on a fixed interval, `gate.status_issue_seconds`. `status` reads it on every machine (9.6) | [D4] |
| G26 | For an attention item of the type secret the Gate also raises one operating system notification on the Lead's laptop when the item opens. Where the platform offers no notification (5.6), it rings the terminal bell in the Gate terminal instead. The other attention types raise neither. Nothing enters an agent conversation (G1) | [D16] |

### 9.2 Pipeline, stage by stage

Intake. At every poll the Gate lists the open PRs. For a PR that is not a draft and whose head SHA is new, it removes the labels that an earlier run left (`gate:failed`, `needs-owner`, `scope-violation`), fetches the head and runs the secret scan at once (G12). With a finding the PR fails as described for stage 4 and does not join the queue. Without one it gets `gate:queued` and joins the back of the queue (G7). A PR that was closed without a merge leaves the queue, and its task, when still open, returns to `in-progress`. The Gate then takes the PR at the head of the queue and runs the stages below in order. "Failed" in the table means: set `gate:failed`, post the comment (G21), write the digest line and leave the queue.

| # | Stage | Action | On failure |
| --- | --- | --- | --- |
| 1 | Fetch | Fetch main and the PR head; record both full SHAs; set `gate:testing` | Retry with increasing waits |
| 2 | Task link | The PR comes from a `task/` branch and names one open task with a valid data block | Failed |
| 3 | Scope | Every changed file lies in a role held by the PR author or on the `open` list (G11) | Failed with `scope-violation`; the comment lists each file with its owning role and holder; attention: scope violation |
| 4 | Secrets | The intake scan found no added line that matches a secret pattern and no added env file other than `.env.example` `[ASSUMPTION A41]`. A head SHA that was not scanned yet, for example after a restart, is scanned here | Failed; the comment gives file, line number and pattern name, never the matched text; attention: secret [D3] |
| 5 | Gated paths | When the diff touches `paths.gated`, raise an attention line of the type migration or production config (G10) | None; the run continues |
| 6 | Conflict detection | `git merge-tree --write-tree origin/main pr/<PR>` [P] | Section 9.3 |
| 7 | Merge test | Scratch worktree with the merge of the PR head and the newest main; dependency install reused from the cache when the lockfile hash matches `[ASSUMPTION A11]`; `commands.check`; the task's acceptance tests, run with `commands.test`. A command that runs longer than `gate.step_timeout_minutes` fails with the reason `step-timeout` | Failed; the comment gives the command and the last lines of the log, and the full log stays in the Gate's log directory |
| 8 | CI | Set `gate:waiting-ci`; wait until the required checks on the exact head SHA succeed | G14; after `gate.ci_timeout_minutes` the run fails with the reason `ci-timeout` |
| 9 | Freshness | Compare main with the SHA tested in stage 7 (G20) | Repeat from stage 6 |
| 10 | Merge | Pinned merge (G15); delete the remote branch | Head moved: requeue with the new SHA. Any other refusal: failed with the reason `merge-refused` |
| 11 | After merge | Set `gate:merged`; close the task issue; update dependents; remove the scratch worktree; write the digest line; run `commands.smoke` on the new main when configured | Smoke failure: attention, repeated failure type. The fix arrives as a separate small PR (G19) |

Flaky handling (G14). When CI fails, the Gate reruns the failed jobs, at most `gate.ci_rerun_limit` times per head SHA, by default once [B]. When the rerun fails too, the Gate searches the failed log for every entry of `gate.known_flaky_tests`. If it finds one, the digest result is `flaky`, the comment states that the PR is not blamed, and an attention item of the repeated failure type asks for a fix of the test. Otherwise the PR is blamed and fails with the reason `ci-failed`. A local merge test whose log names a known flaky test is rerun under the same limit. This prevents the HackYeah case where a time dependent test made a correct conflict fix look broken [P].

Semantic conflicts. Two PRs that each pass alone but fail together are caught by stage 7, because it always tests the merge with the newest main [B]. At HackYeah such a case was caught only by luck, through a CI run on a stale base [P]. Who fixes it depends on where the needed change lies `[ASSUMPTION A44]`. If it lies in the queued PR's own files, the author adapts the PR on its branch (`take N`, fix, `ship`). If it lies outside them, as at HackYeah, where the fix belonged to a file already on main [P], it becomes a separate small PR [B]: the author requests it with `propose`, the owning role implements it, and the queued PR ships again once the fix is merged. In neither case is anything committed on main directly (G19).

### 9.3 Conflict routing

Three kinds of conflict get three reactions [B]:

| Kind | Reaction |
| --- | --- |
| Conflict with main in a builder's own code | The branch owner resolves it, because the owner knows the intent. All 8 branch side conflicts at HackYeah were resolved this way [B]. `ship` surfaces most of them before the PR exists |
| Conflict in shared files | The Resolver, started by the Gate |
| Semantic conflict | The merge test detects it |

Before Phase 3 the Gate does not classify, and the mechanical script does not exist either (I7) [D13]. From Phase 3 on the routing below applies.

When stage 6 reports a conflict, the Gate classifies each conflicted file with rules, without a model `[ASSUMPTION A26]`. The first rule that matches decides:

| Class | Rule |
| --- | --- |
| Gated | The file lies under `paths.gated` |
| Mechanical: lockfile | The file lies under `paths.lockfiles` |
| Mechanical: generated | The file lies under `paths.generated` |
| Mechanical: formatting | The conflict disappears when both sides are formatted with `commands.format` before merging |
| Open | The file is on the `open` list (the README) |
| Additive | A file of the shared role, other than a contract file or one of HackWin's own files (SF8, SF10), in which every conflict hunk consists only of lines inserted by both sides, with no base line changed or removed `[ASSUMPTION A25]` |
| Owner | Anything else: a feature role's file, a contract file, one of HackWin's own files, or a shared file with a conflict that is not additive |

Then one decision for the PR:

| Condition | Action |
| --- | --- |
| Any file is Gated | Stop: `gate:failed` and `needs-owner`. The attention item that stage 5 raised for this PR, of the type migration or production config, now names the conflict. The Resolver is never used for migrations or production config [B] |
| Otherwise, any file is Owner | Resolver in advise mode: a PR comment with the files, the cause and a proposed resolution, and the label `needs-owner` [B]. Nothing is changed on the branch |
| Otherwise: every file is Mechanical, Open or Additive | A script resolves the formatting conflicts without a model, by merging the formatted sides [B]. The Resolver in fix mode (9.4) then resolves the Open and Additive files, when there are any. Last, the script rebuilds conflicted lockfiles with `commands.lockfile_regen` and conflicted generated files with `commands.generate` on the resolved tree, because both derive from other files [B]. The Gate runs the checks of RS7 and pushes to the PR branch |

`needs-owner` always means that the PR author acts: `take <N>` resumes the task, the session merges main, resolves, and runs `ship` (A26).

Most conflicts never reach this routing. `ship` merges main into the branch first, and the session resolves what it finds there (A46). The routing handles the conflicts that appear while a PR waits in the queue.

### 9.4 Resolver

| # | Aspect | Requirement | Source |
| --- | --- | --- | --- |
| RS1 | Trigger | Only the Gate starts it, only at stage 6, only under the routing rules of 9.3. Never from the Lead's conversation | [B] |
| RS2 | Context | A fresh process per conflict. Input: the conflicted files with both sides and the merge base, the PR diff, the ownership map, the rules of this section, the task's problem and expected result, and the titles of the merged PRs that changed the same files. No conversation history. At HackYeah each gate event carried 250 to 500 thousand tokens of history; the saving comes from the small context | [B][P] |
| RS3 | Model | The strongest available model (`resolver.model`), not a weaker one | [B] |
| RS4 | Turn limit | `resolver.max_turns` | [B] |
| RS5 | Tools | Read and edit files in the PR's scratch worktree; local git commands (status, diff, log, add, commit); run the checks | [B] |
| RS6 | Limits | No access to `.env` files; no other branches; no fetch, push or merge; no `gh`. Edits only in the conflicted files. Never migrations or production config. Never a change to the logic of files owned by someone else | [B] |
| RS7 | After a fix | The Gate, not the Resolver, verifies and publishes `[ASSUMPTION A27]`: (a) the resolution commit changes only conflicted files; (b) for Additive files the result contains every line that either side added and every base line that both sides kept (A25); (c) the full checks and the task's acceptance tests pass. Then the Gate pushes to the PR branch and the run restarts at stage 1 with the new head SHA | [B][P] |
| RS8 | Failure | Turn limit reached, process error, a failed guard, failed checks, or the Resolver reporting that the conflict is not additive: the Gate discards the changes, posts a comment with the reason, sets `needs-owner` and does not try again for this head SHA | [B] |
| RS9 | Advise mode | Read only. The output is the text of the handback comment: files, cause, proposed resolution | [B] |
| RS10 | Accounting | The Gate records mode, outcome and token usage of every call in its state and names the token usage in the PR comment (M6, M8) | |
| RS11 | Missing Resolver | When `resolver.enabled` is false or the `claude` CLI does not work on the Lead's laptop, every conflict that would reach the Resolver gets `needs-owner` and a script generated comment with the files and the merged PRs that changed them `[ASSUMPTION A28]`. Before Phase 3 this applies to every conflict (I7) | |

The Resolver's worktree is a fresh checkout that contains no `.env.local`, and the checks pass without secrets, as they must in CI `[ASSUMPTION A38]`.

Why a separate Resolver instead of the builder's agent: a study of AI authored PRs found that 96.1% of merge conflicts were resolved by humans, not by the authoring agent [R3]. HackWin therefore never assumes that a conflict gets resolved on its own: every conflict has a named resolver and a checked result.

### 9.5 Gated changes in version 1

Migrations and production config belong to the Lead, are additive only, and are recorded in a ledger [B]. The gate that holds such a change until a manual `apply` is later: the scope table of the brief says so and the team confirmed it [D1] (18.3 C5). Version 1 does the following:

- Paths under `paths.gated` belong to the shared role, so a builder's PR that touches them fails the scope check (E8).
- A PR of the Lead that touches them raises an attention line in the Gate terminal and in the status issue. The line names the type and, when `paths.ledger` is set, the ledger file to update. The PR is then tested and merged like any other, and the attention item closes when the PR is merged or closed (9.6).
- The Lead reviews the change, applies it by hand outside HackWin and records it in the ledger. The recommended order is to apply and record before running `ship` on the PR: an additive migration is safe ahead of the code that needs it, and many projects deploy main automatically, as HackYeah did [W][P]. The team adopted this order; the tool enforces none [D17]. `AGENTS.md` and every task prompt state that no agent session applies a migration or changes production config.
- A conflict in a gated file is never given to the Resolver (9.3).
- Warning: the project must not apply migrations automatically on merge. Some database integrations do this, and it would bypass the Lead, on whom v1 relies [D1]. The preparation guide repeats the warning.

Later, not in v1 [B][D1]: the gate itself, which means a hold until the Lead's manual `apply`, a machine check for additive only, and ledger automation.

### 9.6 Digest, attention and state

Digest line, one per PR run, written when the run ends, in the Gate terminal and in `digest.log`. The latest line of each PR is published in the status issue, where `status` reads it [B][D4]:

```
<time> #<PR> <author> <result> stage=<stage> <duration> <note>
```

The terminal prints the time as hours and minutes. `digest.log` and the status issue carry the full time, so that `status` can select the lines since a member's previous call (7.6).

Results, with the state each leaves behind:

| Result | Labels on the PR | Comment | Returns to the queue when |
| --- | --- | --- | --- |
| `merged` | `gate:merged` | None, or the resolution note | Never |
| `failed` | `gate:failed` | Stage, reason, next action | A new head SHA arrives, or the Lead types `retry <PR>` |
| `needs-owner` | `gate:failed`, `needs-owner` | From the Resolver: files, cause, proposed resolution. From the script (RS11): files and the merged PRs that changed them | A new head SHA arrives |
| `scope-violation` | `gate:failed`, `scope-violation` | Files with their owners | A new head SHA arrives |
| `flaky` | `gate:failed` | The known flaky test; the PR is not blamed | The Lead types `retry <PR>`, or a new head SHA arrives |
| `requeued` | `gate:queued` | None | At once, at the back of the queue with the new head SHA: the author pushed during the run |

A fix that the Gate pushes, the script's or the Resolver's, does not end a run (G7): the run restarts at stage 1 with the new head SHA, and its final digest line names the fix in the note.

Attention line, only for the five attention types [B][D3]:

```
ATTENTION <migration|production-config|scope-violation|repeated-failure|secret> #<PR>: <what the Lead must do>
```

An attention item stays open in the Gate state, in the status issue and at the top of `status` until it is closed `[ASSUMPTION A54]`:

- Migration and production config: when the PR is merged or closed.
- Scope violation: when a later head SHA of the PR passes stage 3, or the PR is closed.
- Repeated failure: when the stage passes again, for the PR itself with a later head SHA or after `retry`, or for the next queue item when the failure ran across queue items; when the PR is closed; and, after a failed smoke test, when the smoke test passes after a later merge.
- Secret: only when the Lead types `ack <PR>` in the Gate terminal, after rotating the secret. A later head SHA does not close it, because the secret stays in the history of a pushed branch.

For a secret the Gate also raises an operating system notification on the Lead's laptop (G26) [D16]. Version 1 has no other push channel; a Discord webhook may come later [B].

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

The digest in the issue holds one line per PR [B]: the latest run of every PR the Gate has seen. The history of all runs stays in `digest.log` on the Lead's laptop. If the body would exceed the size GitHub accepts (section 5.6), the oldest lines of merged PRs are dropped first.

State file `state.json` (G4):

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

## 10. Enforcement matrix

### 10.1 Layers

Every rule has at least one hard layer that does not depend on the agent tool (P9). For E3 that layer is GitHub's update restriction [D2], with the limits listed in section 10.6. Claude Code hooks give the earliest feedback but are convenience only, because a Codex user would bypass them [B].

| Layer | Acts when | Can be bypassed by | Hard |
| --- | --- | --- | --- |
| CLI | A command runs | Not using the command | For the action it performs |
| Git hooks | Every commit and push, in every clone and worktree, with any agent | `--no-verify`, or a machine where `join` never ran | Yes, with CI as the backstop |
| CI | Every PR and every new head SHA | Nobody who works through PRs | Yes |
| Gate | Every merge | A merge made without it. Where the update restriction is active, GitHub refuses it for every account but the Lead's [D2] | Yes |
| GitHub rules, full mode | Every push and merge to main | Not available in soft mode [B]. The update restriction does not bind the Lead's own agent sessions (10.6) [D2] | Yes |
| Claude Code hooks | At edit time and command time in Claude Code | Using Codex or a plain editor | No |
| Codex (beta [D7]) | Reads `AGENTS.md` and the skills; hooks need a flag and block only Bash commands, not file edits [B] | Not following instructions | No |

The Gate merges only after CI succeeded on the exact head SHA (stage 8), so every CI rule holds for every merge the Gate performs. A merge that goes around the Gate is stopped only by the GitHub rules, where they are active (10.6).

### 10.2 CI workflow

`.github/workflows/hackwin.yml` runs one job named `hackwin` on every PR event that opens a PR or changes its head. It installs the CLI version pinned in `hackwin.yml` on the base branch. When the PR itself changes `cli_version`, it installs the version the PR names instead, so that the PR that installs a bug fix release is checked by the version it introduces (20.6) `[ASSUMPTION A60]`. It then runs `hackwin internal ci`, which executes in order and stops at the first failure:

1. Read `hackwin.yml` and `owners.yml` from the base branch and apply their rules to the PR (A17). When the PR itself changes one of the two files, also validate the proposed version (schema, no overlapping globs, one holder per role, a `cli_version` of the same phase as on the base branch [D10]), so that a broken configuration can never reach main.
2. Task link and branch name (E11, E16).
3. Scope of the PR's own changes (E1).
4. Secret scan (E6).
5. Contract paths (E9), from Phase 2 on.
6. Generated wrappers and hook shims are unmodified (E19).
7. Merge the PR with the current main, install, run `commands.generate` and fail if any tracked file changes [B][T] (E10).
8. Format check of the changed files (E14).
9. `commands.check` and the task's acceptance tests, run with `commands.test`, on the merged tree (E13).

This is the HackYeah `team-check` (install, full check, no uncommitted generated files [T]) extended by the rules that were only conventions there. The scope check always evaluates the branch's own changes: the three dot diff against `origin/main`, or the diff against `MERGE_HEAD` while a merge is in progress, so files that arrive from main never count.

### 10.3 Git hooks

Both hooks are shims that call the CLI. They act on member work and stay out of the way of everything else.

| Hook | Checks | Exempt |
| --- | --- | --- |
| `pre-commit` | On a `task/` branch: the scope check of the staged changes (E1); no env file other than `.env.example` and no secret pattern in added lines (E6). On the default branch: every commit is blocked (E18, E21) | `spike/` branches skip the scope check |
| `pre-push` | A push to the default branch is blocked (E2, E18). A push that rewrites the history of a remote branch is blocked (E12). A push of a `task/` branch needs the green check record for the pushed head commit (E4) | Tags, such as the freeze tag, and `spike/` branches need no check record. Deleting a remote branch is allowed |

The Gate and the Resolver run their git commands with the member hooks switched off; their commits and pushes are covered by the Gate's own stages and by RS7. `plan --freeze` writes the check record itself, so the Foundation push passes the hook.

### 10.4 Claude Code hooks

| Hook | Action | Source |
| --- | --- | --- |
| `SessionStart` | `git fetch`, then a summary of what changed on main since the main commit last recorded for this worktree (7.7 step 6), contract changes and the member's own scope first, plus new scope change comments on the worktree's task, which include the contract marks (CC5), and the member's PRs that wait for them. It then records the current main commit. In the main checkout it also applies CM10 | [B] |
| `PreToolUse` | Block an edit outside the session's role scope; block `gh pr merge`, a merge made through `gh api` and any push to main, together with the deny rules of the settings file (the patterns: verify at build time, section 5.6). This applies to every agent session, the Lead's included; for the Lead's sessions, which always run in Claude Code [D12], it is the only block against a merge outside the queue [D2] | [B][D2] |
| `PostToolUse` | Format only the file that was just changed. At HackYeah this hook together with the "format only changed files" rule left only 5 format check failures in about 177 full checks [T] | [B][T] |

A hook is a deterministic command triggered by an event; it does not change how the model answers [B]. Each one is a single call to `hackwin internal hook`, and only `SessionStart` uses the network.

### 10.5 Matrix

Cell values: **Block** stops the action; **Guide** is an instruction without a mechanism; a dash means the layer does not apply. "CC hooks" are the Claude Code hooks and permission rules. GitHub's own rules are named below the matrix.

| # | Rule | CLI | Git hooks | CI | Gate | CC hooks | Codex (beta) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Edits stay inside the author's ownership scope [B] | Block in `ship` | Block at commit | Block | Block, attention | Block at edit | Guide; caught at commit [B] |
| E2 | No direct push to main [B] | No command does it | Block at push | - | - | Block | Bash hook if the flag is on, else Guide |
| E3 | No agent session merges; only the Gate does [B] | No command does it | Cannot see it | - | Sole merger | Block `gh pr merge` | Bash hook if the flag is on, else Guide |
| E4 | No push without green checks on the pushed commit [B] | `ship` order | Block without a check record | Runs the checks again | Tests again on the newest main | - | - |
| E5 | A session starts from the fresh main and knows what changed [B] | `take` fetches, branches from `origin/main`, adds the summary to the prompt | - | - | - | `SessionStart` summary | Through the `take` prompt |
| E6 | `.env.local` is never read, printed or committed [B]. GitHub's push protection, where it is on, is named below the matrix [D19] | Scan in `ship` | Block env files and secret patterns at commit | Block | Block, attention [D3] | Deny rules for reading env files [T] | Guide (10.6) |
| E7 | New dependencies only through the Lead [B] | As E1: manifests and lockfiles are shared paths | As E1 | As E1 | As E1 | As E1 | As E1 |
| E8 | Migrations and production config only by the Lead; applying them stays a manual act of the Lead [B] | As E1 | As E1 | As E1 | As E1; attention line at stage 5; never the Resolver | As E1 | As E1 |
| E9 | Frozen contracts change only with an approved `contract-change` [B] | `propose` classifies; `ship` checks | - | Block | Through CI | As E1 | As E1 |
| E10 | Generated files are produced only by the Lead and are current [B] | `ship` checks | - | Block | Through CI | - | - |
| E11 | One issue, one PR; the PR names a valid open task [B] | `ship` creates it | - | Block | Block at stage 2 | - | - |
| E12 | Work happens on a `task/` branch in its own worktree; main is merged in, never rebased or force pushed [B][W] | `take` creates, `ship` merges | Block a push that rewrites history | - | - | - | Guide |
| E13 | Merge test on the current main before every merge [B] | `ship` merges main first | - | Block | Block at stages 7 and 9 | - | - |
| E14 | Only changed files are formatted [B][W] | `ship` checks | - | Block | Through CI | Format on edit | Caught by `ship` |
| E15 | Merges are serialized and pinned to the tested SHA [B] | - | - | - | Only mechanism | - | - |
| E16 | `spike/` branches are never merged [B] | `ship` refuses | - | Block | Block at stage 2 | - | Guide |
| E17 | No more running tasks than configured sessions and disjoint tasks [B] | Block in `take` | - | - | - | - | - |
| E18 | No fix is committed directly on main [B] | - | Block at commit and push | - | By design (G19) | Block | Guide |
| E19 | Generated wrappers and hook shims are not edited by hand | `setup --regenerate` | - | Block | Through CI | - | - |
| E20 | Hooks are active on every machine | `take` and `ship` check `core.hooksPath` and repair it | - | Backstop for every hook rule | - | - | - |
| E21 | After the freeze the Planner session writes no code [B] | - | Block commits on the default branch | - | - | Guide in the wrapper | Guide |

GitHub's rules act beside these layers. In full protection mode GitHub blocks E2 and E18 for everyone, the repository owner included, and refuses to merge a PR whose `hackwin` check is not green. With the update restriction it also enforces E3 for every account except the Lead's [D2]. Where push protection is on (7.1 step 13), GitHub's own secret scanning adds a layer to E6 at push time; HackWin's scans in every column above stay in force beside it [D19].

The Resolver is constrained outside this matrix: by its tool allowlist (RS5, RS6) and by the Gate's guards before anything is pushed (RS7).

### 10.6 Known gaps

| Gap | Effect | Mitigation in v1 |
| --- | --- | --- |
| The update restriction does not cover the Lead's own agent sessions, because they share the Lead's account [D2] | One of the Lead's sessions that ignores its instructions can merge a green PR with `gh pr merge`, skipping the queue and the merge test on the newest main | The Claude Code deny rule and the `PreToolUse` block for `gh pr merge` [D2], which every Lead has, because the Lead works with Claude Code [D12]; the stop line of `ship` |
| Where GitHub offers no update restriction for the repository type, E3 has no hard block that is independent of the agent tool | Any session that ignores its instructions can merge a green PR | The soft blocks stay as the fallback [D2]: the Claude Code block, the Codex Bash hook when the flag is on, `AGENTS.md`, the stop line of `ship`. `setup` reports which state applies. The preparation guide recommends a repository owned by an organization for this case [D15] |
| `--no-verify` skips the git hooks | A commit or push that breaks E1, E4 or E6 reaches GitHub | CI and the Gate fail it before any merge |
| In soft protection mode a push to main with `--no-verify` is stopped by no later layer | A commit on main that no PR and no Gate run covered | None beyond the hook and the agent permissions. The brief accepts soft protection where GitHub offers nothing more [B]; a public repository avoids the gap |
| In soft protection mode GitHub requires neither a PR nor the `hackwin` check | A merge that goes around the Gate can land a PR whose checks failed | Only the soft blocks: the Claude Code block, `AGENTS.md`, the stop line of `ship`. The Gate itself never merges such a PR, and M2 counts a bypass merge that conflicts (S4) |
| A merge made by another route than `gh pr merge`, for example through `gh api` | The deny patterns of the Lead's own sessions may not match it | The patterns also cover the merge call of `gh api` where Claude Code can express that (verify at build time, 5.6); the rule in `AGENTS.md` |
| An approval is stored as a label, and a session can change a label through `gh` without the approval command | A session that ignores its instructions could release a wave or mark a proposal as approved | The rule in `AGENTS.md`; the deny rules cover only the approval commands, not a label change through `gh`. For a contract change CI checks that the Lead's account set `approved` (CC7), which stops a builder's session but cannot tell the Lead from the Lead's own sessions (A5). The team accepts this gap for v1 [D14] |
| HackWin cannot stop a Codex session from reading `.env.local` | A secret may enter that session's context | `AGENTS.md` rule; the `pre-commit` scan stops it at commit; where push protection is on, GitHub blocks a push with a secret it recognizes, unless the pusher bypasses the block (verify at build time, 5.6) [D19]; CI and the Gate fail a PR that still carries one (E6) |

## 11. Shared files and hotspots

### 11.1 Rules for shared files

At HackYeah nearly all conflicts and nearly all of the most edited files were shared files owned by the integrator [W]. Each class of shared file therefore has an explicit rule.

| # | File class | Who writes | Rule | Conflicts | Source |
| --- | --- | --- | --- | --- | --- |
| SF1 | Dependency manifests and lockfiles | Lead | New packages only through the Lead; others request them with `propose` | A lockfile conflict is resolved by regenerating the lockfile, by script | [B] |
| SF2 | Global styles | Lead by default | A change, for example a new style or an unusual component, is requested with `propose` | Additive conflicts go to the Resolver. At HackYeah a conflict of two animation blocks in `globals.css` was resolved by keeping both [P] | [B] |
| SF3 | Generated files, for example types from OpenAPI | Lead only | CI checks that they are current | Rebuilt by the script with `commands.generate` (9.3) | [B] |
| SF4 | README | Everyone | It is on the `open` list, because it is tailored to the jury anyway | The Resolver merges them when they appear after `ship`; at `ship` time the session does (A46) | [B] |
| SF5 | Migrations | Lead only | Additive only; recorded in the ledger; an applied migration file is never edited [W]; applied by the Lead by hand, never automatically on merge [D1] | Never the Resolver; the Lead | [B] |
| SF6 | Production config | Lead only | Same rule as migrations (9.5) | Never the Resolver; the Lead | [B] |
| SF7 | `.env.example` | Lead | `.env.local` is never committed | None expected | [B] |
| SF8 | Contracts | Lead | Frozen; changed only through section 8.5 | Handed back to the PR author, the Lead's builder session; the Resolver only advises (9.3) | [B] |
| SF9 | Registries such as routing or menus | The role that owns the file | HackWin enforces no registry structure, because it must work with every framework | As for any file of that role | [B] |
| SF10 | HackWin's own files: `hackwin.yml`, `owners.yml`, `AGENTS.md`, the workflow, the hook shims | Lead | Changed through a PR; generated files only through `setup --regenerate` | Handed back to the PR author, the Lead; the Resolver only advises (9.3) | [B], A48 |

### 11.2 Hotspot detection

A hotspot is a file changed by two open PRs. The detector is a v1 differentiator that the team did not find in this form in other tools [B].

| # | Requirement | Source |
| --- | --- | --- |
| H1 | At every poll the Gate compares the changed files of all open PRs that are not drafts. For every new pair that shares a file, both authors are warned before either PR merges: one comment on each PR that names the other PR and the shared files, and the label `hotspot`. A pair is reported once `[ASSUMPTION A30]` | [B] |
| H2 | `ship` prints the same notice at the moment the PR is opened | A30 |
| H3 | `take` refuses a task whose allowed paths overlap an open PR or a task in progress | [B] |
| H4 | `tasks` and `propose` reject parallel tasks with overlapping paths at planning time | [B] |
| H5 | A hotspot warning never blocks a merge. The queue stays first in, first out; the later PR merges main on its branch or goes through conflict routing. The label `hotspot` is removed when the overlap ends | A30 |
| H6 | Files on the `open` list are reported by H1 and H2 but exempt from H3 and H4, since the Resolver merges their conflicts (before Phase 3 the PR author does, I7) | SF4 |

Evidence from HackYeah. The brief names the hotspot files as `chat.ts`, `ports.ts`, `repository.ts`, `README.md`, `APPLIED.md` and `globals.css` [B]. Branch side conflicts occurred in `chat.ts` (2), `ports.ts` (2), `runs.ts`, `APPLIED.md`, `globals.css` and `ChatPanel.tsx` [W]. The most edited files were `README.md` (26 commits), `repository.ts` (22), `chat.test.ts` (21), `ports.ts` (20) and `APPLIED.md` (14), nearly all of them shared files of the integrator [W]. Two consequences for HackWin:

- Hotspots concentrate in the shared role. The Lead's own parallel builder sessions are the main source of same file overlap: of six branch side conflict merges that the command center never saw, five carried the integrator's git identity (an attribution the post-mortem marks as unsure) [P]. H3 stops the Lead from running two overlapping shared tasks at once.
- The detector is equally useful in solo mode, where every overlap is between one person's sessions.

## 12. Metrics and the generated report

### 12.1 Rules

- Metrics are counted automatically; nobody keeps a tally by hand [B]. At HackYeah the team perceived "one or two" conflicts where git history showed 8 [W].
- Sources: GitHub (issues, PRs, labels, timelines), git history, the report comments that `ship` writes, the status issue, and the Gate files on the Lead's laptop.
- Every metric is shown next to its HackYeah 2026 value, which the CLI holds as constants with their source. The report states that the baseline is one event (N = 1) [B].
- A value that cannot be computed is reported as "not available" with the reason. The report never estimates.
- The report is produced without a model.

### 12.2 Metric definitions

M1 to M6 cover the four metric groups the brief lists [B]. M7 to M12 are added by this PRD, because the same data yields them at no extra cost `[ASSUMPTION A49]`.

| # | Metric | Definition and source | HackYeah baseline |
| --- | --- | --- | --- |
| M1 | Task cycle time [B] | Time from issue creation to the merge of its PR, with three parts: created to taken, taken to PR opened, PR opened to merged. Median and p90, from issue and PR timelines | Not measured |
| M2 | Conflicting merges into main [B] | Merge commits on the first parent history of main whose two parents conflict when merged again with `git merge-tree`. Counted from git, not from Gate logs, so a merge that bypassed the Gate is counted too | 0 [B] |
| M3 | Branch side conflict merges [B] | Merge commits on merged task branches that brought main into the branch and whose parents conflict. Split by who resolved: the branch owner's session, the Resolver, the mechanical script | 8, resolved by the branch owners according to the brief [B]; the post-mortem shows one resolved by the gate session [P] (18.3 C20) |
| M4 | Merged PRs [B] | Total, per person, and PRs closed without a merge | 133; per account 50, 39, 32, 12; 2 closed without merge [W] |
| M5 | PR size [B] | Median files changed and median changed lines per merged PR | 5 files, 262 lines [B] |
| M6 | Token use [B] | Per task: the sum over the task's sessions, as written in the `ship` report (A33); median and total. Per gate event: Resolver tokens per call and in total; the pipeline itself uses none | About 2.4M per PR event at the gate [P]. Per task not measured; task sessions used 2 to 24M each [T] |
| M7 | Gate operation | Restarts (Gate starts minus one, read from the status issue); heartbeat gaps (count and total duration, from `heartbeat_gaps` in the Gate state file); attention items by type with the time each stayed open; Lead conversation time occupied by merge events, which is 0 by construction | 54 launches of the watcher loop, most of them manual restarts; about 146 min of occupied conversation [P] |
| M8 | Resolver | Calls by mode; outcomes (fixed, handed back); mechanical script resolutions | No Resolver existed |
| M9 | Hotspots | Warned PR pairs; files by number of warnings; warned pairs that ended in a conflict | Hotspot files listed in section 11.2 [B][W] |
| M10 | Delivery | Tasks published, closed with green acceptance tests, cut, still open at `project.event.end`; per wave; proposals accepted and rejected | Not measured |
| M11 | Rule events | Scope violations; secret findings; Gate failures by stage | Not measured |
| M12 | Flaky tests | CI reruns; runs with the result `flaky` | One known case (PRs #88 and #96) [P] |

### 12.3 The report

`hackwin status --report` [B] writes `hackwin-report.md` and `hackwin-report.json` into the current directory. It does not commit them.

Contents, in this order:

1. Header: repository, event window, team size, agents per member, protection state, CLI version.
2. One table: metric, this event, HackYeah 2026.
3. Per person: merged PRs, median PR size, tasks done, tokens.
4. Per wave: tasks published, done, cut; cycle time.
5. Hotspot files and conflict routes.
6. Data notes: every value that was not available and why.

Run on the Lead's laptop the report is complete. Elsewhere the values that come from the Gate files read "not available: run the report on the Lead's laptop": the heartbeat gaps and attention times of M7, the Resolver part of M6, the split of M3, and M8, M9, M11 and M12.

The same inputs always produce the same report. Its purpose is the case study that forms the heart of the README [B] and the repeat measurement at the next hackathon, which is the team's answer to the N = 1 risk [B].

## 13. Default tooling

The inventory of the HackYeah build [T] decides what the template and the tool contain by default. The rule: a tool is included when the logs show it helped, optional when its effect was real but depends on the project or was not quantified, and excluded when it showed no effect or caused friction.

### 13.1 Included by default

| Tool or practice | Evidence |
| --- | --- |
| One git worktree per task | Essential: worktrees prevented agents from switching branches under each other [T] |
| `gh` for all GitHub operations, with the head pinned merge | Essential [T] |
| One CI job with the full project check and the generated file diff | Essential: it was the only merge gate GitHub enforced in practice [T] |
| Format on edit hook plus the rule "format only changed files" | Clearly helped: 5 format check failures in about 177 full checks across 29 sessions; it kept whole file reformat churn out of PRs [T] |
| Deny rule for reading env files | Helped: no secret was ever printed in the logs [T] |
| Ownership check as a script | The boundary script fired 4 times and kept ownership real [T]; HackWin turns it into the `owners.yml` scope check |
| A fresh session per task | Helped: task sessions used 2 to 24M tokens each against 338M for the session that was never cleared [T] |
| PR template with owner, scope and verification | Used at HackYeah [T][W] |
| A short `AGENTS.md` for both agents, imported by `CLAUDE.md` | Used at HackYeah [W] |
| A local log for the Lead | Persistent notes helped the command center survive compactions [T]; in HackWin shared state is on GitHub and this log stays local [B] |
| One research skill and one research subagent | Decided: research is a skill or subagent committed to the repo [B] |

### 13.2 Optional, added by the project

HackWin provides the slot, not the content.

| Tool or practice | Evidence | Slot |
| --- | --- | --- |
| Review checklists as skills (database review, security review) | Used 10 and 8 times as checklists before a PR; the impact was not quantified [T] | Project skills next to the HackWin skills |
| Module boundary rules (features never import each other) | Helped at HackYeah [T][W], but the rule depends on the framework and HackWin enforces no structure [B] | Part of `commands.check` |
| Local replay of migrations before applying | Caught SQL problems before apply [T]; specific to the database | Belongs to the later database gate |
| Browser QA script | A hand written headless browser script served 12 sessions [T]; specific to the project | Project script |
| Production check after a merge | 49 such checks ran at HackYeah [P] | `commands.smoke` |
| Explanation style | A personal setting: an output style or a skill, kept local [B] | `join` |

### 13.3 Excluded from the defaults

| Tool | Evidence |
| --- | --- |
| GSD framework | Zero commands and zero skill invocations in 50 transcripts; only its hooks ran; they produced false positive injection warnings and, by an upper bound estimate the inventory marks as unsure, on the order of 10 to 15 minutes of cumulative hook latency [T] |
| ponytail plugin | Ran at 51 session starts; none of its commands was used; no effect could be attributed [T] |
| codegraph MCP server | 5 calls in 3 sessions; marginal, because the work crossed branches that a local index does not reflect [T] |
| Agent Reach | Installed, never used for research [T] |
| Account level connectors | 0 calls [T] |
| caveman | Never installed; it appeared only inside another plugin's text [T] |
| Third party plugins enabled through the committed settings | HackYeah committed one plugin this way, so every teammate was offered it [T]. HackWin's committed settings contain only its own hooks and deny rules |
| A watcher that runs inside an agent session | The cause of the blocked conversation [P]; replaced by the Gate |

Members may install personal tools at user level. HackWin neither requires nor manages them; the template's guide notes that user level hooks add latency and noise to every session [T]. HackWin's own hooks are single local calls without network access, except the fetch at session start.

## 14. Acceptance criteria for v1

Test setup: a sandbox GitHub repository with a small Node project that uses Tailwind (the stack HackWin is tested on [B]), three test accounts (one Lead, two builders) and, for the solo criteria, one account. "Fixture" means a scripted repository state. Every criterion is checked by an automated test unless it says "inspection". Section 20.4 assigns every criterion to the phase in which it must first pass.

### 14.1 Setup and join

| # | Criterion |
| --- | --- |
| AC1 | On a fresh public sandbox repository, `setup` with scripted answers for 3 members creates the committed files of section 6.4 for the commands its CLI version contains and every label of section 8.2. Reading the rules back from GitHub shows: PR required, check `hackwin` required, force push and branch deletion blocked and, where GitHub offers it, updates of the default branch restricted to the Lead's account [D2]. |
| AC2 | On a repository where GitHub refuses protection, `setup` exits 0 and reports soft mode. From a joined clone, `git push origin main` is rejected by the `pre-push` hook. |
| AC3 | For the Node fixture, `setup` proposes the install, check, test and format commands without the user typing them. |
| AC4 | `setup` with 5 members exits 2. A second `setup` on a configured repository exits 2. An `owners.yml` with overlapping globs is rejected by `setup` and fails CI. A fixture whose `hackwin.yml` breaks a validation rule of section 6.1 makes a command exit 2 and name the key. |
| AC5 | `join` on a builder account reports every check as passed, sets `core.hooksPath`, creates the local files and leaves `git status` clean. With a key in `.env.example` and no `.env.local` it exits 1. With an unreadable `.env.local` it still passes, which shows that the file is never opened. |
| AC6 | Running `setup --resume` and `join` a second time creates no duplicate label, file or invitation. A `setup` that fails before the bootstrap push leaves the repository and GitHub unchanged; one that is interrupted after it is completed by `setup --resume`. On a repository created from the template, `setup` keeps the team's own lines in `AGENTS.md`, replaces only its own blocks and the generated files, and removes the template's unchanged `check.yml` (6.5). |
| AC51 | Release 1, the template, contains no call to the CLI: its CI workflow passes on a repository created from it without HackWin installed. |
| AC70 | Where GitHub accepts the rules for everyone but not the update restriction, `setup` exits 0 and reports full protection without the update restriction; the Gate header and the status issue show the same state. |
| AC76 | A CLI older than `cli_version` on main, or of another phase, exits 2 from every command and prints the install command; a newer bug fix release of the same phase prints a warning and continues (CM12). In a repository whose manifest does not exist yet, `join` and `take` skip the install with a notice. `setup` run under an account other than the one named as the Lead exits 2. `setup` with answers that give the Lead the agent `codex` exits 2 and names the reason [D12]. |
| AC80 | On a sandbox repository where GitHub offers push protection, `setup` enables it, and the setting read back from GitHub is on. Where GitHub refuses it, `setup` exits 0 and its summary reports push protection as off. In both cases a test secret that matches a HackWin pattern but no pattern GitHub recognizes is still blocked at commit, in CI and by the Gate (E6) [D19]. |

### 14.2 Planning

| # | Criterion |
| --- | --- |
| AC7 | `plan --check` lists each missing document and exits 1. After `plan --freeze` and a Gate merge, the tag `hackwin/contracts-frozen` points at the merge commit and the Foundation issue is closed. The Foundation PR comes from a `task/` branch, names the Foundation issue and passes every Gate stage. With no Gate running, `plan --freeze` opens the PR and exits 1, and a second run completes after the merge. `status` shows the freeze state as pending before the planned time, overdue after it and frozen once the tag exists. |
| AC8 | `tasks --check` rejects a draft in which two parallel tasks share a path and names both tasks and the path. It accepts the same draft when one task depends on the other. It also rejects a path outside the role's scope, a dependency that does not exist and a deadline outside the event. |
| AC9 | `tasks --publish` creates one issue per task with a valid data block, role label, assignee and milestone. Interrupted halfway and rerun, it creates no duplicate. A draft that fails the check is not published. |
| AC10 | A wave published by a builder, or by any session without an interactive terminal, carries `needs-lead`; `take` refuses its tasks. After `tasks --approve --wave <n>` by the Lead in an interactive terminal with the typed confirmation the tasks are takeable. The same command without an interactive terminal exits 2, and so does the command under a builder's account. |

### 14.3 Take, propose, ship

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
| AC19 | `propose` with paths in the author's scope creates a `ready` issue assigned to the author; a proposal that collides with an open task is not created. With a path in another scope it creates a `needs-lead` issue; `--complete` exits 2 before the acceptance, and after `--accept` and `--complete` the issue is assigned to the holder of the owning role. |
| AC20 | After the freeze, a PR that changes a contract file fails CI unless its task carries `contract-change` and `approved`. `propose --mark` adds the label and the comment to each listed issue and PR, and the next `take` prompt of a marked task contains the change. |
| AC52 | `take <N>` on the caller's own `in-progress` task reopens the worktree with a continue prompt. After a `take` whose install failed, `take <N>` finishes the remaining steps and gives the first prompt. `take <N> --release` returns the task to `ready` and frees the session slot. `take <N>` on a task whose PR is `gate:failed` brings the local branch up to the remote branch, including a commit that reached the remote branch from elsewhere. |
| AC53 | After a role swap is merged on main, the new holder of the role can `take` its open tasks and the previous holder cannot. |
| AC54 | A PR whose generated files are stale fails CI. A push that rewrites the history of a pushed task branch is blocked by the `pre-push` hook. A commit on the default branch is blocked by the `pre-commit` hook. With `core.hooksPath` unset in a joined clone, `take` and `ship` set it again (E20). |
| AC55 | In a Claude Code session an edit outside the role scope is blocked before the file changes, `gh pr merge` is refused, and after an edit only the edited file is reformatted. At session start the summary lists the commits that reached main since the last session. |
| AC65 | A task issue written by hand from the template is taken by `take` and merged through `ship` and the Gate. An issue with an invalid data block is refused by `take` with the reason and listed by `status` as invalid. |
| AC71 | A PR that names no open task with a valid data block fails CI and stage 2 of the Gate, and so does a PR opened by hand from a `spike/` branch. A PR of the Lead that changes a generated wrapper by hand fails CI (E19). |
| AC72 | On a CLI before Phase 3, `take` for a member whose agent is `codex` prepares the worktree, sets the label and prints the path of the prompt file and the command that starts Codex (I10). |
| AC73 | `propose --spike <name>` creates the branch `spike/<name>` and its worktree. `propose --reject <N>` with a reason closes the issue and writes the reason into its body. `propose --accept` under a builder's account exits 2, and so does `propose --accept` without an interactive terminal. |
| AC74 | On a CLI from Phase 2 on, `take` exits 2 while the freeze tag is missing, and refuses a task written by hand until the Lead has run `tasks --approve <issue>` (I3). |

### 14.4 Gate

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

### 14.5 Resolver and hotspots

| # | Criterion |
| --- | --- |
| AC36 | Two PRs of the Lead each append a different block to the same shared stylesheet. For the second PR the Resolver runs in fix mode, the result contains both blocks, the checks pass, the Gate pushes and the PR merges. Mode, outcome and token usage are recorded. |
| AC37 | Two PRs change the same README line. The Resolver merges the README and the PR merges after the checks. |
| AC38 | A conflict in a feature role's file: the branch is unchanged, the PR has one comment with files, cause and proposed resolution and the label `needs-owner`, and no second Resolver call happens for the same head SHA. |
| AC39 | A simulated Resolver result that drops a line added by one side fails the guard: `needs-owner`, nothing pushed. |
| AC40 | A conflict only in the lockfile is resolved and merged with a Resolver call count of 0. |
| AC41 | In a test harness the Resolver process cannot read `.env.local`, cannot push and cannot run `gh`. The input the Gate assembles for it consists only of the parts listed in RS2. |
| AC42 | On a CLI before Phase 3, a conflict found at stage 6, in any file, gets `gate:failed`, `needs-owner` and the script generated comment, and no model is called (I7). |
| AC43 | Two open PRs that change the same file each get exactly one comment naming the other PR and the file, and the label `hotspot`, before either merges. Later polls add no further comment. `ship` of the second PR prints the same notice (H2). |
| AC59 | A conflict that disappears when both sides are formatted is resolved by the script with a Resolver call count of 0. |
| AC69 | A conflict in a migration file produces no Resolver call and no script fix: the PR gets `needs-owner`, and the attention item of the type migration names the conflict. |
| AC75 | With `resolver.enabled` set to false, or with the `claude` CLI unavailable, the Gate starts and says so. A conflict that would reach the Resolver gets `needs-owner` and the script generated comment; a conflict only in the lockfile is still resolved by the script (RS11). |

### 14.6 Status, metrics, parity and delivery

| # | Criterion |
| --- | --- |
| AC44 | For the same GitHub state, `status` on a fresh clone after `join` shows the same attention items and the same "who does what", "waiting for merge" and "blocked" sections as on the Lead's laptop. An overdue task is marked. `status --json` carries the same items. With GitHub unreachable `status` exits 3. |
| AC45 | On a fixture history, `status --report` gives M2 = 0, M3 equal to the number of seeded branch conflicts, per person PR counts equal to GitHub's, and a median PR size equal to an independent computation. With session logs in the fixture, the `ship` report names the token count of the task and the report sums it; without them the value reads "not available". Run on a builder's machine, the values that come from the Gate files read "not available" (12.3). A Phase 3 CLI runs `status --report` on a fixture project pinned to a Phase 1 version and names Phase 1 in the header (CM12). |
| AC46 | Two report runs on unchanged inputs produce identical JSON. |
| AC47 | With the Claude Code hooks disabled, which simulates a Codex user, an edit outside scope is blocked at commit. Committed with `--no-verify` and pushed, it fails CI and the Gate and is not merged. |
| AC48 | Solo mode: with one member the full flow of `setup`, `plan`, `tasks`, `take`, `ship`, Gate merge and `status --report` completes [B]. |
| AC49 | The HackWin README states that HackWin is a tool and not ready project code, tells teams to check their event's rules about code written before the event [B], and shows the HackYeah numbers of section 1.3 with N = 1 named (inspection). |
| AC50 | The repository license is MIT [B] (inspection). |
| AC60 | With the main checkout on the default branch and a clean tree, `status` leaves it at `origin/main`. With local changes it warns and changes nothing. |
| AC64 | Release 1 contains every item that section 20.1 lists for Phase 0, in two repositories laid out as section 20.1 describes [D11]. The preparation guide warns against applying migrations automatically on merge [D1] and recommends a repository owned by an organization where a personal account offers no update restriction [D15]. The README names Claude Code and the plain terminal as fully supported and Codex as beta [D7], states that the Lead works with Claude Code [D12], and presents every command as planned, not as available (17.4). Every item of the checklist in section 20.5 is done [D6] (inspection). |
| AC66 | Solo mode in Phase 1: with one member, `setup`, a task written by hand, `take`, `ship`, a Gate merge and `status` complete. |
| AC67 | The CLI of each phase offers exactly the commands of that phase and of the earlier ones, and `setup` generates wrappers only for those. |
| AC68 | Beta: on the same fixture, `take`, `ship` and `status` called through the Codex wrapper produce the same labels, branch, PR body and exit code as from a terminal. `take` in a terminal starts Codex in the worktree with the prompt, and `join` reports the state of the Codex hook flag [D7]. |
| AC77 | A PR that installs a bug fix release of the same phase, with the output of `setup --regenerate` and the raised `cli_version`, passes CI, which installs the version the PR names (10.2); after its merge an older CLI exits 2. A PR that sets `cli_version` to a release of another phase fails CI, and `setup --regenerate` run with a CLI of another phase exits 2 [D10]. |

## 15. How it works: a 24-hour hackathon with HackWin

The team: a Lead and three builders who own the roles `workbench`, `detection` and `audit`, the shape that ran at HackYeah [W]. The Lead and two builders use Claude Code, one builder uses Codex, which is beta in v1 [D7][D12]. The walkthrough shows the complete v1, after Phase 3.

**The evening before.** The team reads the event rules on AI tools and on code written before the event, because some hackathons restrict both [B][R9]. They work through `docs/hackwin/before-the-event.md`: domain research, the choice of stack, accounts for the external services. A fast contract freeze depends on this preparation [B]. They make sure that no database integration applies migrations automatically on merge [D1]. The Lead creates a public repository from the template.

**H+0, the challenge is announced.** The Lead runs `hackwin setup`. It asks who is on the team, proposes ownership roles from the directory tree, shows the stack commands for confirmation (detected from the project files, or typed by the Lead in an empty repository), pushes the bootstrap commit and applies the branch rules, including, where GitHub offers it, the one that lets only the Lead's account update main [D2]. It also switches on GitHub's secret scanning push protection where GitHub offers it [D19]. Each builder clones the repository and runs `hackwin join`, which checks their tools, installs the hooks, asks for their answer language and confirms that the `.env.local` they received from the Lead over a private channel is in place. The Lead opens a second terminal and starts `hackwin gate`. It will run until the end without a restart, and from now on `status` shows its heartbeat on every laptop, read from the pinned status issue [D4].

**Until the freeze.** The Lead works with the Planner on `plan`: PRD, spec and design in general prose, and the points of contact in detail, meaning types, the API, the database schema and acceptance criteria. The Planner adds shared types, the dependencies and a mock for every contract that another role will consume. The builders use this time for the non-code list: accounts, data, the outline of the pitch. At the planned freeze time, 45 minutes after the start as at HackYeah [B], `hackwin plan --freeze` opens the Foundation PR. The Gate tests and merges it and the freeze tag is set.

**The first wave.** `tasks` gives the Planner the epics outline, and the Planner drafts tasks for the next 3 to 5 hours, each about an hour of agent work. The collision check reports that two parallel tasks would both edit the same component, so the Planner makes one depend on the other. The Lead approves with a typed confirmation and the tasks become takeable, each with role, paths, acceptance tests and deadline.

**Delegation.** Each builder runs `hackwin take` in a terminal. The command checks the assignment, the dependencies and the paths, creates a worktree from the fresh main and starts an agent with a prompt composed on that laptop. Nobody copies a prompt into a chat. A builder with two sessions runs it again in a second terminal and gets the next disjoint task.

**The first merges.** An agent finishes, commits and runs `/ship`: main is merged into the branch, the full checks and the task's acceptance tests run, the PR opens, the issue receives the PR number and head SHA, and the session stops. In the Lead's second terminal a digest line appears for each PR as the Gate works through scope, secrets, conflict detection, the merge test on the newest main, CI and the pinned merge. Meanwhile the Lead is in the Planner session answering a builder's question about the API. Nothing interrupts that conversation.

**An idea and a request.** The `audit` builder wants a small export feature inside their own directory: `/propose` creates the task, accepted automatically, and they take it at once. The `workbench` builder needs a new global style: their proposal lands as `needs-lead`; the Lead accepts it, the builder completes the task description, and one of the Lead's builder sessions implements it, so shared code keeps one author.

**A hotspot.** Two of the Lead's sessions each add a block to the shared stylesheet. Both PRs get a hotspot comment before either merges. The first merges; the second now conflicts. The conflict is additive in a shared file, so the Gate starts the Resolver in a fresh context with the two sides, the ownership map and the rules. It keeps both blocks. The Gate verifies the result, runs the full checks, pushes to the PR branch and merges after CI. The Lead sees one digest line.

**Green alone, red together.** The `detection` builder's PR passes its own CI, but a PR merged a moment earlier changed a function it calls. The Gate's merge test on the newest main fails and the Gate leaves one comment. `status` shows the PR under the builder's name; `take <N>` reopens the task with the comment in the prompt, the agent adapts the call and ships again.

**A contract change.** The `detection` builder needs one more field in a frozen response type. `/propose` classifies the draft as a contract change. The Lead approves it in a terminal, the builder completes the task description, the Planner marks the tasks that consume the type, and one of the Lead's builder sessions changes the contract and regenerates the types. The affected builders see the change at the start of their next session.

**A migration.** One of the Lead's builder sessions writes a migration for a new table. The Lead reviews the SQL, applies it by hand and records it in the ledger before the session ships. When the PR reaches the Gate, an attention line names the migration and the ledger file, and the PR is tested and merged like any other. No agent session applies a migration.

**A secret.** A builder in a hurry pushes a branch by hand with `--no-verify` and opens the PR in the browser, and one commit contains an API key of a kind that GitHub's push protection does not recognize, so the push goes through; a recognized key would have been stopped at the push unless the builder bypassed the block [D19]. The Gate finds the key when it first sees the PR, fails the PR, raises an attention line and an operating system notification on the Lead's laptop [D16]. The Lead rotates the key at once, because the branch is already public, and types `ack <PR>` [D3].

**A step outside scope.** A builder's agent tries to patch a shared helper. In Claude Code the edit is blocked on the spot. In Codex the edit happens, the commit is blocked by the git hook, and the message points to `propose`.

**The night.** A queue runs empty; `take` answers "queue empty" and the Lead runs `tasks` for the next wave. Later the Lead's plan limit is exhausted. A builder runs `/tasks` instead, because the state is on GitHub, and the Lead approves the wave with one command. The Gate keeps the laptop awake.

**The morning.** `status` marks the overdue tasks. The Lead cuts what will not make it. There is no freeze mode: the team decides by hand when feature work stops.

**The last hours.** One person records the demo video and another rehearses the pitch while their agents finish the last tasks. Everyone edits the README for the jury; when two edits collide, the Resolver merges them.

**After the deadline.** `hackwin status --report` prints the event next to HackYeah 2026: cycle time, conflicts into main, branch side conflicts and who resolved them, PRs per person, median PR size, tokens per task, Gate restarts.

## 16. Evidence and research used

### 16.1 HackYeah findings and the requirements they justify

Section 1.5 maps every failure to a requirement. This table covers what worked and what was measured.

| Finding | Source | Requirement |
| --- | --- | --- |
| Shared code had exactly one author, and all conflicts landed in that author's files (18.3 C21) | [B] | P5; the shared role (3.4); SF1 to SF10; D5 |
| Ownership by directory: a role swap changed only the label | [B][W] | `owners.yml` and `team.members[].roles` (6.1, 6.2) |
| Contracts were frozen at H+0:45 before parallel work | [B][W] | `plan --freeze`; section 8.5 |
| Small PRs: median 5 files and 262 changed lines | [B] | T4 |
| One merger, serialized merges, a merge test on current main, CI on every PR | [B][W] | G13, G15, G17; E13 |
| Builder sessions could not merge: they opened a PR and stopped | [B][W] | E3; the stop line of `ship` |
| 9 of 10 steps of the PR recipe were deterministic | [B] | G9 |
| About 2.4M tokens per PR event, because each event read the whole conversation again; context of 255 thousand tokens at the median | [P] | G1; RS2 |
| 54 launches of a loop that exited after each event, most of them manual restarts | [P] | G3, G4 |
| All 8 branch side conflicts were resolved by the branch owner; the post-mortem shows one of them resolved by the gate session (18.3 C20) | [B][W][P] | `ship` step 2; conflict routing (9.3) |
| The agent's own policy: never commit a fix on main | [B][P] | G19; E18 |
| The format hook with "format only changed files": 5 failures in about 177 checks | [T] | E14 |
| Fresh task sessions used 2 to 24M tokens; the session that was never cleared used 338M | [T] | One fresh session per task (7.7) |
| A time dependent test made a correct fix look broken | [P] | G14 |
| Hotspots were shared files, mostly the integrator's | [B][W][P] | H1 to H6 |

### 16.2 External research

Each source was checked on 8 October 2026 against its abstract or official page. Data from early 2025 is treated as historical, because models have improved since.

| # | Source | What it shows | Limits | Used for |
| --- | --- | --- | --- | --- |
| R1 | Xu, Subramanian, Karthik: "AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates", arXiv 2607.04697 | Replaying real merges of concurrently open agent PRs: textual conflicts in 19.8% of same agent pairs (119 of 601) and 41.7% of cross agent pairs (48 of 115). 84.4% of conflicted files are source code, 3.9% manifests and lockfiles. About 42% of conflicts are structural: one side deletes a file the other changes, or both add the same file | Data from December 2024 to July 2025. The agents were not coordinated. "Cross agent" means different agent products. Textual conflicts only, so a lower bound | One owner per directory (P5); `take` path check (H3); hotspots (H1); enforcement that also holds in teams mixing Claude Code and Codex (P9). Since conflicts sit in source code, ownership matters more than the lockfile script (SF1). Since many are structural, allowed paths and the planning collision check cover new files too (T8) |
| R2 | Xia, Wu, Park: "Passes Alone, Fails Together: Benchmarking Semantic Coordination in Parallel LLM-Agent Development", arXiv 2609.25396 | On 36 constructed tasks over 12 Django helpers, GPT-5.5 produced patches that passed alone and failed together in 105 of 108 runs (97%), although they merged without textual conflict. A message describing the completed concurrent change recovered 89 of 108 runs (82%) | The authors state that these constructed rates do not estimate how often the problem occurs in practice: among 834 runs on 417 pairs of reviewed PRs only 1 showed interference. The messages described finished changes | Merge test on the newest main (G13, G20, E13): a clean merge is not a working merge. Informing sessions about completed changes (E5, CC5, CC6). Contracts before code (P8) |
| R3 | Campos Junior, Murta: "How AI Coding Agents Resolve Merge Conflicts: An Empirical Study", SBES 2026 | In 14,960 conflicting internal merge commits of AI authored PRs, 96.1% of conflicts were resolved by humans; self resolution rates differ widely between agents | Checked against the paper's replication package summary, not the full text; the package names git 2.38 or later for `git merge-tree`. It shows what agents do unprompted, not what they can do: at HackYeah the owners' agent sessions resolved all 8 branch side conflicts [B] | Every conflict gets a named resolver and a checked result (9.3, RS7); `ship` tells the session to resolve; M3 and M8 measure who resolved |
| R4 | Duma and others: "These Aren't the Reviews You're Looking For: How Humans Review AI-Generated Pull Requests", arXiv 2605.02273 | Most AI generated PRs receive no review, and where reviews exist they are dominated by AI agents rather than humans | No rate in the abstract. The venue named in the research notes (EASE 2026) was not confirmed | HackWin does not rely on human review: quality rests on deterministic gates and acceptance tests (T5, G11 to G13) |
| R5 | CodeRabbit: "State of AI vs Human Code Generation Report", December 2025 | In 470 open source PRs, AI co-authored PRs had about 1.7 times more issues; logic and correctness issues were 75% more common | Vendor report, small sample, 2025 data. The research notes attributed the logic error finding to LinearB; it traces to this report | Acceptance criteria as tests (T5); full checks in `ship` and again in the Gate |
| R6 | LinearB: "2026 Software Engineering Benchmarks Report" | Across 8.1 million PRs, AI PRs wait 4.6 times longer before review, and their acceptance rate is 32.7% against 84.4% for manual PRs | Vendor report on company teams. The claim from the research notes that AI PRs are larger could not be confirmed on LinearB's public page, so this PRD does not rely on it | The wait before a merge is where agent PRs lose time: an automatic queue (G17) and the "PR opened to merged" part of M1 |
| R7 | Anthropic engineering blog: "How we built our multi-agent research system", June 2025 | Agents use about 4 times the tokens of chat, multi-agent systems about 15 times | A research system, 2025 data | LLM only where judgment is needed (P3); no orchestrating agent (2.2); Gate without a model (G9) |
| R8 | Hackathon judging guides (Reskilll, August 2026; BuilderBase guide) | A common rubric gives technical implementation 20 to 25%, next to innovation, impact, demo and completeness | Secondary sources; rubrics vary by event, and some weight technical work far higher | The value proposition (1.6): human time for demo and pitch; `non-code.md` in `plan`. Teams should read their event's rubric |
| R9 | Published event rules (for example Chakravyuha Fest 2K26, Carnero.Dev, Manus AI For All Hackathon) | Some events forbid AI code generation; some require all code to be written during the event | Examples, not a survey | The README statement [B]; the preparation guide |
| R10 | GitHub Agent HQ and mission control, announced at GitHub Universe in October 2025 | A command center to assign, steer and track several agents, tied to a paid Copilot subscription | An announcement from 2025; verify the current scope before publishing claims | Platform risk (18.1); positioning (17.2) |
| R11 | Ogenrwot, Businge: "AgenticFlict", arXiv 2604.03551 | 27.67% of more than 107 thousand processed agent PRs conflicted with their base branch | Not in the research notes; found while checking R1, which cites it. Supporting context only | Merging main into the branch in `ship` |
| R12 | GitHub documentation, read on 8 October 2026: "About rulesets", "Available rules for rulesets", "About protected branches", "Rate limits for the REST API" | Rulesets are available for public repositories on GitHub Free. A ruleset rule "Restrict updates" lets only accounts with bypass permission push to matching branches. The older setting that restricts who can push is described only for organization repositories. The primary limit is 5,000 requests per hour for an authenticated user; a secondary limit is 500 content generating requests per hour | Documentation, not a test. It does not say whether the restriction also refuses a merge made through the API, whether a bypass lifts the other rules of the same rule set, or whether an issue edit counts as content generation | The update restriction of D2 (7.1, 5.6); the status issue interval (A36) |

### 16.3 What the evidence does not show

- HackYeah is one event with a team that sat in one room. It is unknown how much of the result came from the method and how much from talking face to face [B].
- No data yet shows that HackWin's split of the integrator into Planner, Gate and Resolver keeps the HackYeah result. That is what the report measures at the next event [B].
- The external studies describe agents that were not coordinated. They justify the mechanisms, not a predicted conflict rate for HackWin.
- No log confirms Codex use at HackYeah (18.3 C12), so parity with Codex is untested and Codex support is beta in v1 [D7].
- The CoProgrammer comparison document that the brief recommends reading before design (Beads, MCP Agent Mail, Overstory, agent-deck) [B] was not among the inputs; v1 does not use it [D18].

## 17. Positioning

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

## 18. Risks, open questions, resolved contradictions and assumptions

### 18.1 Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| K1 | N = 1: one hackathon, one well rehearsed team in one room. The share of the result that came from the system is unknown [B] | Test v1 solo, then at the next hackathon, and measure the same metrics (section 12) [B] |
| K2 | GitHub plans: branch protection in a private repository needs a paid plan, and merge queue is not available [B]. The update restriction of D2 may not exist for every repository type | Public repository by default, soft protection otherwise, the Gate runs the queue [B]; the soft blocks as the fallback for the restriction [D2] |
| K3 | Platform risk: Anthropic and GitHub may build similar coordination into their products [B][R10] | Stay in the layer of ownership rules, task flow and gates, independent of the agent tool [B] |
| K4 | Token cost: the Gate without a model and the Resolver in a fresh context should cut the cost per PR event sharply, but this is not measured yet [B] | M6 at the next event [B] |
| K5 | Friction: every safeguard slows people down [B] | Rules stay invisible until broken (P2); M11 counts how often rules fire |
| K6 | Preparation: the fast freeze at HackYeah needed earlier research [B] | `docs/hackwin/before-the-event.md` teaches the step [B] |
| K7 | The Lead is a single point. The Gate runs only on the Lead's laptop, and the Planner, the Resolver and the Lead's builder sessions all draw on the Lead's plan. HackYeah used 3 Claude Max limits in 24 hours [B] | A substitute can run `tasks` [B]; a failed Resolver hands back to the owner (RS8); if the laptop is down, merges wait, by decision [B] |
| K8 | Queue throughput. One PR at a time with a full check each. HackYeah merged 133 PRs in about 23 hours [B], on average one about every 10 minutes (derived), with a full check of 1.5 to 3 minutes [P]. A slower check suite could make the queue the bottleneck | Dependency cache (G13); the "PR opened to merged" part of M1 shows it; suggestion S8 |
| K9 | Several capabilities of Claude Code, Codex and GitHub are unverified (section 5.6), and Codex was not verifiably used at HackYeah [T] | A fallback for each capability. Two have none: the pinned merge, which worked at HackYeah [P], and `git merge-tree --write-tree`, which `join` checks. Hard rules do not depend on a capability of an agent tool (P9), except in the gaps that section 10.6 lists; E3 also rests on an unverified GitHub rule, with its fallback listed there. Codex support is beta in v1 [D7] |
| K10 | A merge outside the queue stays possible for the Lead's own agent sessions, and for every session where GitHub offers no update restriction (10.6) | The Claude Code deny rule for the Lead's sessions and the soft blocks as the fallback [D2]; M2 exposes a bypass merge that conflicts |
| K11 | A public repository exposes mistakes at once, including a pushed secret | Secret scan before push, in CI and in the Gate (E6); GitHub's push protection where GitHub offers it [D19]; `.env.local` is never committed [B]; a secret that reaches the Gate interrupts the Lead with an attention line and an operating system notification (G26), and the Lead rotates it [D3][D16] |
| K12 | The rule for "additive" (A25) may be too strict or too loose | M8 counts fixes and handbacks; the rule is one function |
| K13 | Event rules may forbid AI generated code or tooling prepared in advance [R9] | README statement and preparation guide [B] |
| K14 | A database integration that applies migrations on merge would run a migration that the Lead has not applied by hand [D1] | The warning in the preparation guide and in section 9.5 [D1]; the attention line that names the migration when its PR reaches the Gate (9.5); suggestion S11 |
| K15 | Phased delivery [D8]: Phase 1 runs without the contract freeze, the wave approval and the planning collision check, and Phases 1 and 2 hand every conflict that appears in the queue back to the PR author | The interim behaviors of section 20.3; the path check of `take` (H3) from Phase 1 on; the manual workflow guide for planning by hand, which the team accepts for Phase 1 [D9] |

### 18.2 Open questions

None remains open. The team decided Q1, Q2, Q3, Q5, Q6 and Q12 of the first draft (D2, D6, D3, D4, D1, D5); D7 settles Q4 and D4 settles Q11. Of revision 2, D18 settles Q7 to Q10, D12 settles Q13, D17 Q14, D13 Q15, D15 Q16 and D16 Q17. Ideas that remain undecided are listed as suggestions in section 19.

### 18.3 Contradictions resolved

Precedence: the brief wins over the other inputs, and inside the brief later decisions win over earlier text. The team decisions D1 to D19 override the brief where they differ.

| # | Contradiction | Resolution |
| --- | --- | --- |
| C1 | Team size: 2 to 5 people with a 5 person shape [W] against 2 to 4 [B] | 2 to 4; the 5 person shape is dropped (S9 keeps its idea as a suggestion) |
| C2 | README: one owner or owned sections [W] against "everyone edits, the Resolver merges" [B] | Everyone edits (SF4) |
| C3 | A write freeze before demos [W] and in the brief's failure table, against the later decision "no freeze mode" [B] | No freeze mode; the team decides by hand |
| C4 | Gate location: a supervised daemon, a GitHub Action or GitHub's merge queue [P] against a process in a terminal on the Lead's laptop, with the Resolver in GitHub Actions only later [B] | Terminal process on the Lead's laptop (G1, G2) |
| C5 | The Gate design stops migrations and production config for a manual `apply`; the v1 scope table, later in the brief, lists that gate as later [B] | The later text wins, and the team confirmed it [D1]: v1 has no hold. Gated paths are Lead only, the Resolver never touches them, and the Gate raises an attention line (9.5) |
| C6 | Webhooks if possible [P] against polling now and events later [B] | Polling in v1 (G24) |
| C7 | "Filter by author" as the fix for watcher noise [B][W] against the earlier failure in which an author filter hid the integrator's own sessions [P] and the decision that the Lead also builds [B] | No author filter. Every PR that is not a draft is a queue item; the noise problem is solved by G1, since no session is woken (G7) |
| C8 | The Lead is interrupted at defined gates, yet the digest is shown only through `status` [B] | Attention lines appear in the Gate's own terminal, in the status issue and at the top of `status` [D4]; the only push signal in v1 is the operating system notification for a secret (C27) |
| C9 | The Planner never codes, yet the Planner creates shared types, contracts and dependencies [B] | The Planner writes the foundation before the freeze and no code after it; later shared code comes from the Lead's builder sessions |
| C10 | "1 to 2 sessions" in the role table against "1 or 2, 3 as advanced" in the checklist [B] | The checklist: 1 or 2, 3 with a warning |
| C11 | "Hooks enforcing scope" as a v1 item against "hard enforcement lives in the CLI, git hooks and CI, not in agent hooks" [B] | Git hooks and CI are the hard layer; Claude Code hooks are convenience (section 10) |
| C12 | The brief reports about 50% of a Codex plan used [B]; the inventory found no Codex on the integrator's machine and no certain Codex use by others [T] | The cost figure is kept as the team's statement; this PRD does not claim that Codex was verified in the logs, and Codex support is beta in v1 [D7] |
| C13 | The HackYeah gate sometimes tested several ready PRs in one scratch tree [P] against "one PR at a time" [B] | Strictly one at a time (G17); batching is suggestion S8 |
| C14 | A `shared-change` label as an exception to the scope check [W] against `propose` with a Lead decision [B] | No label exception; shared changes go through `propose` and are implemented by the owner [D5] |
| C15 | The command center session processed 331.7M tokens [P] or 338M [T] | Each figure is cited with its own source; the inputs do not explain the difference |
| C16 | "Status generated from tests" as the fix for documentation drift [B] against a v1 scope that lists only `status` from GitHub [B] | Task state from tests in v1 (T5); the README status is written by hand [D18]; a generated one is suggestion S10 |
| C17 | "Test data per branch" in the brief's failure table against "by hand in the task plan" in the scope table [B] | By hand in v1 [D18] |
| C18 | "Alert if the gate has not polled for N minutes" [P] against "digest only through `status`" [B] | The stale heartbeat warning is shown by `status` on every machine, from the status issue [D4] |
| C19 | The research notes attribute "more logic errors" to LinearB and state that AI PRs are larger | The logic error figure comes from CodeRabbit (R5); the size claim could not be confirmed and is not used (R6) |
| C20 | All 8 branch side conflicts were resolved by the branch owner [B][W]; the post-mortem shows the `globals.css` conflict of PR #88 resolved by the gate session on the owner's branch [P] | The brief's count is kept as the baseline; M3 names the difference |
| C21 | "All conflicts landed in the integrator's files" [B] against "almost every" and a conflict in a builder's `ChatPanel.tsx` [W] | Section 1.4 quotes the brief; the detailed sections say "nearly all" |
| C22 | Prompts were copied to Discord by hand [B] against "no chat messages" [W] | The brief wins: prompts were relayed through Discord. The sentence in the workflow brief concerns approvals and review requests |
| C23 | The brief limits interrupts of the Lead to four types [B]; decision D3 adds a found secret | Five attention types (G18) [D3] |
| C24 | "Digest only through `status`" [B] against a pinned status issue that holds the digest [D4] | The digest is stored in the status issue and shown by `status` on every machine; the issue can also be read on GitHub. No message is pushed to any member; the only push signal is the local notification of G26 (C27) |
| C25 | Identical behavior in both agents as a v1 promise [B] against no confirmed Codex use in the HackYeah logs [T] | Claude Code and the plain terminal are fully supported; Codex support is beta in v1 [D7] |
| C26 | Every member chooses Claude Code or Codex [B][D7] against the decision that the Lead works with Claude Code [D12] | D12 wins for the Lead; every other member still chooses, with Codex as a beta |
| C27 | No push channel in v1 [B] against an operating system notification for a found secret [D16] | The notification is local to the Lead's laptop and covers only the secret type (G26); no message leaves the laptop and nothing enters an agent conversation |
| C28 | A project stays on its phase and an older or other phase CLI exits 2 [D10], against the report that a later CLI runs on an earlier event (I9) | `status --report` only reads and is exempt from the phase check (CM12, A60) |

### 18.4 Assumptions

Each item is a choice made here because no input settles it. The team may overrule any of them. A22 of the first draft became decision D1, and A57 of revision 2 became D17.

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
| A18 | Every wave is published as `needs-lead` and becomes takeable through the Lead's typed approval (`tasks --approve`), whoever published it |
| A19 | A proposal outside the author's scope exists as a short issue before acceptance, in the format of section 8.1, so that the Lead can see it |
| A20 | The freeze is a git tag; the foundation goes through a PR that the Gate merges |
| A21 | Human approvals (`propose --accept`, `propose --reject`, `tasks --approve`) need an interactive terminal and a typed confirmation |
| A23 | Queue order is first in, first out by the time the head SHA joined the queue, at intake or through `retry` |
| A24 | The definition of "repeated failure" in G23, with a threshold of 2 and including a known flaky test that fails again |
| A25 | "Additive" means that every conflict hunk consists only of insertions by both sides, checked before the Resolver runs and guarded after it |
| A26 | The conflict classes and routing of section 9.3, including that a mixed conflict is handed back and that `needs-owner` addresses the PR author |
| A27 | The Gate verifies and pushes the Resolver's commit; the Resolver has no network access to git |
| A28 | Without a working `claude` CLI on the Lead's laptop the Gate runs without the Resolver |
| A29 | Before a role swap the affected members ship or close their open PRs |
| A30 | Overlaps are checked in four places: the Gate (H1), `ship` (H2), `take` (H3), and `tasks` and `propose` (H4); each PR pair is reported once; a warning never blocks a merge (H5) |
| A31 | A failed Gate run leaves exactly one PR comment, which also names a fix that the Gate pushed in that run; a successful run in which the Gate pushed a fix leaves one comment that says what was resolved; any other successful run leaves none |
| A32 | Protection settings: PR required, check `hackwin` required, force push and branch deletion blocked, rule applied to administrators, "require up to date branches" off; the update restriction of D2 as a rule set of its own |
| A33 | Token use per task is read from the agent's session logs per worktree and written into the `ship` report; for Codex it is best effort |
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
| A49 | Metrics M7 to M12 and the Resolver accounting (RS10) go beyond the four metric groups the brief lists |
| A50 | A task that exceeds the size rule, or depends on another role's task inside a wave, produces a warning, not an error |
| A51 | The draft file format for waves and proposals and the heading format of `epics.md` |
| A52 | Commands fast forward the main checkout to `origin/main` when it is clean and on the default branch |
| A53 | The secret scan runs at intake, once per head SHA, so that the attention line does not wait for the queue |
| A54 | The closing rules of attention items (9.6); only a secret item needs the Lead's `ack <PR>` |
| A55 | The status issue: title, label `gate-status`, body format, one digest line per PR, a stop time written by `quit`, one edit per `gate.status_issue_seconds`, with extra edits only at a Gate start and at `quit` |
| A56 | Phase boundaries where D8 is silent: the hooks, the branch rules, the five attention types, the status issue, the notification of G26 and the push protection of `setup` belong to Phase 1; the path check of `take` (H3) stays in Phase 1; the interim behaviors I1 to I16 |
| A58 | Beta, for Codex, means that the Codex criterion AC68 is tested and reported with each release from Phase 3 on, and that a failure there is named in the release notes instead of blocking the release |
| A59 | In the two repositories of Release 1 [D11], the template's README is a skeleton for the team's project, its `AGENTS.md` names no command, and its CI workflow is `.github/workflows/check.yml` with a placeholder check step |
| A60 | The CLI version rule (CM12): the releases of one phase differ only in the patch number, earlier phases keep receiving patch releases, and `status --report` is exempt from the phase check; the bug fix procedure (20.6), in which `setup --regenerate` rewrites the generated files and HackWin's own blocks; the CI exception for a PR that changes `cli_version` (10.2) |
| A61 | Input details of the CLI: a typed confirmation is the word `yes`; the keys of the answers file (CM11); `plan --freeze-at`; `--new` for an empty draft (CM13) |
| A62 | `setup` must be run by the Lead; after refusing `codex` for the Lead it asks again in an interactive terminal and exits 2 with an answers file; it stores each member's agent in `hackwin.yml`; it proposes the path groups of `paths` that are known before planning, of which `manifests` is required; `join` and `take` skip the install while no manifest file exists; the Gate header and `plan --check` give a notice while `paths.gated` is empty |

## 19. Suggestions (not decided)

These are ideas of this PRD, not decisions of the team. None is part of v1 unless the team adopts it. S1 and S2 of the first draft were adopted as D2 and D4; S6 was adopted for the secret type only, as D16.

| # | Suggestion | Reason |
| --- | --- | --- |
| S3 | In the Gate's secret scan, compare added lines with the actual values in the Lead's `.env.local` | It finds the team's real secrets without false positives; the Gate is a script, so no agent reads the file |
| S4 | Report merges that the Gate did not perform and commits pushed to main directly | M2 already counts such merges when they conflict; reporting all of them would expose any use of the gaps in section 10.6 |
| S5 | Ask in `plan` for the event's judging criteria and its rules on AI and prior code, and store them in `non-code.md` | Rubrics and rules differ by event [R8][R9]; the Planner could weigh tasks against the real rubric |
| S6 | The operating system notification of G26 for the other four attention types | The Lead would notice every attention item without watching the Gate terminal, and still nothing would enter an agent conversation |
| S7 | After each merge, post a short note on open PRs whose tasks depend on the changed interfaces | A message about a completed concurrent change recovered 82% of the constructed runs in a benchmark [R2]; this would extend the contract marks to every interface change |
| S8 | An optional batch merge test for several ready PRs | The HackYeah gate did this at times [P]; it would raise throughput if K8 proves real. It conflicts with "one PR at a time" and needs a decision |
| S9 | An ownership role for the deliverables outside the code (README, demo, browser QA) in teams of 4 | HackYeah assigned one free person to presentation and video late in the night [W]; the workflow brief proposed such a role for a fifth person |
| S10 | Generate a status table for the README from the acceptance tests | It would complete the answer to documentation drift, for which v1 keeps a hand written README status [D18]; HackYeah built a matrix of this kind [W] |
| S11 | Keep the attention items for migrations and production config open until the Lead types `ack <PR>` | Without a hold [D1] the item closes when the PR merges. An item that stays open would remind the Lead that a manual act may still be due. It is not in v1, because D1 keeps the default of the first draft, which had no such step |

## 20. Delivery plan

v1 is built and released in four phases [D8]. Every phase is usable at a real hackathon on its own. A later phase adds to the earlier ones; where it tightens earlier behavior, I3 and I5 say so. A project stays on the phase it started with, and during a project only bug fix releases of that phase are installed (20.6) [D10]. Where D8 leaves a boundary open, the choice made here is `[ASSUMPTION A56]`; the mechanical conflict script is placed in Phase 3 by decision [D13].

### 20.1 Phases

| Phase | The release contains | With it a team can | HackYeah problems it removes |
| --- | --- | --- | --- |
| 0 | Release 1, the template and the HackYeah case study, with no call to the CLI [B][D8]: the README with the case study and the statements of section 17.4; `AGENTS.md` and `CLAUDE.md`; an example `owners.yml`; the preparation guide; the manual workflow guide; the `docs/hackwin/` skeletons; the PR template and the task issue template; the research skill and subagent; the deny rules for env files; a `.gitignore` with the entries of section 6.4 and an empty `.env.example`; a CI workflow that runs only the project's own check | Run the HackYeah method by hand, with shared rules, ownership written down and tasks as issues (I1) | Rules that lived only in the integrator's session; the preparation that the fast freeze needed (K6); tooling noise (F20) |
| 1 | The CLI with `setup`, `join`, `take`, `ship`, `status` and `gate` without the Resolver [D8]; the enforcement layers, the branch rules [D2] and push protection [D19]; the five attention types [D3] with the notification for a secret [D16]; the status issue [D4] (20.2) | Hand a task to any member's agent with `take`, and let the Gate test and merge every PR in its own process. Tasks are planned and written by hand (I2, I3) [D9] | Both main problems [D8]: the blocked integrator (F1, F12, F14, F15) and the hand copied prompts (F2). Also F3, F8, F10, F11, F13, F16 to F19, F21, F23 and F25, and in part F4, F5 and F7 |
| 2 | `plan`, `tasks`, `propose` and the contract change flow [D8] (20.2) | Plan in waves with collision checks, freeze the contracts with one command, and settle proposals and contract changes through GitHub | F24 in part; the planning by hand of Phase 1 |
| 3 | The Resolver with conflict classification and the mechanical script, hotspot detection, the metrics report, and Codex parity as a beta [D8][D7] (20.2) | Leave conflicts in shared files to the Resolver, see overlaps before they turn into conflicts, and publish the event's numbers next to HackYeah | F9 and F22; it makes K1 and K4 measurable |

Every failure of section 1.5 appears in the last column, except F6, which is deferred by decision [D18].

Release 1 in detail [D11] `[ASSUMPTION A59]`. It consists of two repositories: the HackWin repository, which holds the README with the case study and later the CLI, and the template repository, from which a team creates its project and whose own README is a skeleton for that project. In Release 1 the template's `AGENTS.md` states the rules of section 6.4 without naming a command. That text, and the template's content in `CLAUDE.md`, the PR template, the task issue template and `.gitignore`, sits inside the markers `hackwin:begin` and `hackwin:end`, so that `setup` later replaces it instead of adding a second copy (6.5). The template's CI workflow is `.github/workflows/check.yml`, which runs only the project's own check: its check step is a marked placeholder that passes until the team replaces it with the project's install and check commands. Release 1 contains no command wrapper, no hook shim and no `hackwin.yml`; `setup` adds them from Phase 1 on.

### 20.2 Requirements by phase

Phase 0 contains no requirement that needs the CLI. For the tool:

| Area | Phase 1 | Phase 2 | Phase 3 |
| --- | --- | --- | --- |
| Commands (section 7) | `setup`, `join`, `take`, `ship`, `status`, `gate` | `plan`, `tasks`, `propose` | `status --report` |
| Tasks (section 8) | Issue format, labels, lifecycle and PR rules (8.1 to 8.4), for tasks written by hand. T7 to T9 are conventions until Phase 2 (I2, I4) | Drafts, waves, approval, proposals; the contract change flow (CC1 to CC8) | |
| Gate (section 9) | G1 to G26; stages 1 to 11, with I7 at stage 6, which gives every conflict the handling of RS11; gated changes (9.5); digest, attention and status issue (9.6) | | Conflict routing (9.3); the Resolver (RS1 to RS11) |
| Enforcement (section 10) | E1 to E8 and E10 to E20; the git hooks; the CI job; the Claude Code hooks; the GitHub rules | E9 and E21 | The Codex column, as a beta |
| Shared files and hotspots (section 11) | SF1 to SF10 as ownership rules; H3, with the exemption of H6 | H4, with the exemption of H6 | H1, H2, H5; the scripts for lockfiles and generated files (SF1, SF3) |
| Metrics (section 12) | The data is recorded | | M1 to M12 and the report |

### 20.3 Dependencies across phases and their interim behavior

Each row is a requirement of an early phase that leans on a later one, with the behavior that applies until then [D8].

| # | Requirement | Needs | Interim behavior |
| --- | --- | --- | --- |
| I1 | Phase 0 has no commands | Phase 1 | The team follows `docs/hackwin/manual-workflow.md`, whose content section 6.4 lists |
| I2 | `take` needs task issues (T2) | `tasks` and `propose` (Phase 2) | In Phase 1 the Lead, or the Lead's planning session through `gh`, writes task issues from the task issue template [D9]. A member with an idea in their own scope writes the issue themselves; for another scope they ask the Lead. `take` and CI validate the data block; a valid task is takeable once its dependencies are closed, and it enters the queue of 8.1. `status` lists task issues with an invalid block |
| I3 | `take` requires the freeze tag and a task that was released for work (7.7) | `plan --freeze` and `tasks --approve` (Phase 2) | Phase 1 has neither. The Lead ships the foundation as an ordinary task of the shared role and writes the other tasks afterwards, as `docs/hackwin/manual-workflow.md` describes for planning by hand. From Phase 2 on `take` requires the freeze tag, and a task written by hand needs `tasks --approve <issue>`. A project that started on Phase 1 stays on it [D10], so it never meets these checks |
| I4 | The planning collision check (T8, H4) | `tasks --check` (Phase 2) | In Phase 1 an overlap is caught when the second task is taken (check 4 of `take`, H3) |
| I5 | The contract check in `ship` and in CI (E9) | The contract change flow (Phase 2) | In Phase 1 contract files are protected by ownership alone: they belong to the shared role, so only the Lead can change them (E1). From Phase 2 on the check applies as soon as the tag exists (CC1) |
| I6 | Contract marks in the `take` prompt and in the session start summary (CC6) | Phase 2 | In Phase 1 both list the files that changed on main, the member's own scope first |
| I7 | Stage 6 of the Gate routes conflicts to the script and the Resolver (9.3, 9.4) | Phase 3 | In Phases 1 and 2 every conflict found at stage 6 gets `gate:failed`, `needs-owner` and the script generated comment of RS11. The PR author resolves it, as the branch owners did at HackYeah [B]. No model is called |
| I8 | Hotspot warnings (H1, H2) | Phase 3 | None before Phase 3. Check 4 of `take` (H3) and, from Phase 2 on, the planning check (H4) prevent most overlaps. Files on the `open` list are exempt from both (H6), so a conflict in one of them goes to the PR author until Phase 3 (I7) |
| I9 | `status --report` and the token count in the `ship` report (section 12, A33) | Phase 3 | Absent before Phase 3. The data accumulates from Phase 1 on (issue and PR timelines, git history, `ship` reports, Gate files), so a Phase 3 CLI can later run the report on an earlier event, as the exception of CM12 allows; token counts then read "not available" |
| I10 | Codex wrappers, the Codex hook configuration, the Codex start in `take`, the Codex hook check in `join` | Phase 3, as a beta [D7] | A Codex user runs the terminal commands. `take` prepares the worktree and prints the prompt file and the command that starts Codex. Every hard rule already applies, because it lives in the git hooks, CI, the Gate and GitHub (P9) |
| I11 | `setup` asks for the Resolver model; `join` and `gate` check the `claude` CLI for the Resolver | Phase 3 | Not asked and not checked before Phase 3; `resolver.enabled` is false in a project set up before Phase 3 |
| I12 | The Gate sets dependents from `blocked` to `ready` (G22) | The labels are set by `tasks` (Phase 2) | In Phase 1 whether a task is takeable is computed from its dependencies (8.3). The Gate still mirrors the labels where they exist |
| I13 | `setup` generates wrappers and CI steps for all 9 commands | Later phases | `setup` generates wrappers only for the commands its CLI version contains (AC67) |
| I14 | `AGENTS.md`, the `take` prompt, the block messages and the fix of a semantic conflict (9.2) send a member to `propose` | `propose` (Phase 2) | Until Phase 2 the generated texts say to ask the Lead, who writes the task (I2) |
| I15 | The freeze state in the header of `status`, rule E21, the task kind `foundation` and `propose --spike` | Phase 2 | Before Phase 2 `status` shows no freeze state, the foundation is a task of the kind `task` with at least one acceptance test, and a spike branch is created by hand with git. `ship` and CI refuse spike branches from Phase 1 on (E16) |
| I16 | The Gate and the validation rules read the path groups of `paths`, which `plan` fills | `plan` (Phase 2) | `setup` proposes the groups that are known before planning (7.1 step 5). In Phase 1 the Lead sets the others, such as `contracts` and `generated`, in the foundation task; from Phase 2 on `plan` fills them. While `paths.gated` is empty, the Gate header says that no attention line for a migration or a production config change can be raised (7.5) |

### 20.4 Acceptance criteria per phase

Every criterion of section 14 belongs to the phase in which it must first pass. A later phase keeps the earlier criteria green, with two exceptions: AC42 and AC72 describe interim behavior and end with Phase 3, and from Phase 2 on every `take` fixture carries the freeze tag and released tasks (I3). AC67 and AC77 are tested again with each later phase. AC68 is the beta criterion: its result is reported and does not block a release (A58). The checklist of section 20.5 is confirmed again, by inspection, before each later release.

| Phase | Criteria |
| --- | --- |
| 0 | AC49, AC50, AC51, AC64 |
| 1 | AC1 to AC6, AC11 to AC18, AC21 to AC35, AC42, AC44, AC47, AC52 to AC58, AC60 to AC63, AC65 to AC67, AC70 to AC72, AC76 to AC80 |
| 2 | AC7 to AC10, AC19, AC20, AC73, AC74 |
| 3 | AC36 to AC41, AC43, AC45, AC46, AC48, AC59, AC68, AC69, AC75 |

### 20.5 Pre-publication checklist

Before each release is published:

1. Check the npm package name, the domain and the GitHub owner, and replace the placeholders [D6][B].
2. Verify the comparison table of section 17.2 against the current state of each project; it repeats research of 4 October 2026 [B].
3. Verify the current scope of GitHub Agent HQ before publishing the platform comparison [R10].
4. Record in the release notes the result of every "verify at build time" item of section 5.6 that the release depends on.
5. Confirm the README statements (AC49, section 17.4), including the Codex beta note [D7], and the MIT license (AC50).

### 20.6 Bug fix releases during a project

A project stays on the phase of the CLI it started with; a team uses a later phase from its next project on [D10]. Bug fix releases of an earlier phase therefore continue as patch releases on that phase's own version line after a later phase is released, and the install command of CM12 names the exact pinned version `[ASSUMPTION A60]`. During a project the Lead installs a bug fix release of the same phase in these steps `[ASSUMPTION A60]`:

1. The Lead installs the bug fix release. Until its PR is merged, it works with a warning (CM12).
2. The Lead stops the Gate with `quit` and starts it again, so that it runs the new version.
3. The Lead writes a task of the shared role for the bug fix release (I2; from Phase 2 on it is released with `tasks --approve <issue>`, I3), takes it, runs `hackwin setup --regenerate` in its worktree (7.1) and ships it.
4. CI checks the PR with the version the PR names (10.2), and the Gate merges it.
5. From that merge on, an older CLI exits 2 and prints the install command (CM12). Every member installs the new version and runs `join` again.
