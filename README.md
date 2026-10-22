# HackWin

HackWin is a workflow and CLI for hackathon teams of 2 to 4 people who each run their own Claude Code or Codex sessions on one GitHub repository. It came out of HackYeah 2026, where four people merged 133 pull requests in about 23 hours and not one merge into main conflicted. HackWin packages what made that possible and removes what hurt. Every directory has one owner. Contracts are frozen before parallel work starts. `/take` hands a task to your agent with no copied prompt. A gate that needs no AI tests and merges pull requests one at a time while your lead keeps planning. The promise is fast delegation without conflicts, so more features work in the demo and people have time for the video and the pitch. Zero conflicts is the proof, not the slogan: a coming command will print your numbers next to ours. Our baseline is a single event with one team, and we say so. Claude Code and the plain terminal are fully supported. Codex support is in beta.

> **0.1.0:** Phase 1 of the CLI: `setup`, `join`, `take`, `ship`, `status` and `gate`. Planning commands and the report come in later phases. Until then the Lead writes the tasks, by hand or with a planning session.

| HackYeah 2026 | Result |
| --- | --- |
| Team and duration | 4 people, about 23 hours: first merge 3 Oct 11:23, last 4 Oct 10:21 (local) |
| Merged PRs | 133 (50, 39, 32, 12 per account), 2 closed unmerged; median 5 files, 262 lines |
| Conflicting merges into main | 0 |
| Branch-side conflict merges, resolved on the branches | 8 |
| Production regressions | None observed after a merge |
| Lead conversation | Busy about 146 min in one night on watcher events; median 1.9, p90 6.8 min each |
| Watcher loop | 54 launches of the watcher loop in one night, most of them manual restarts |
| Tokens per PR event | About 2.4M; context per model call: median 255 thousand, p90 500 thousand |
| Compactions overnight | 3, plus 1 stop at the usage limit |
| PR recipe | 9 of 10 steps needed no model |
| Plan usage in 24 hours | 3 Claude Max limits and about 50% of a Codex plan (200 USD tier) |

## Before you use it

- **HackWin is a tool, not ready project code.** It brings rules and a workflow; your team writes the project at the event.
- **Check your event's rules on code written before the hackathon,** and on AI tools. Some events require all code to be written during the event, and some forbid AI code generation. Make sure that setting up HackWin in advance is allowed.

## Install

Everyone on the team, on their own machine:

```sh
npm install -g hackwin@0.1.0
```

You need Node 22 or newer, git, the GitHub CLI `gh` logged in to your own account, and Claude Code (or Codex, in beta) for your agent sessions. The Lead needs admin rights on the repository, and a `gh` login with the `workflow` scope (`gh auth refresh -s workflow`). A project pins its HackWin version in `hackwin.yml`, and `setup` prints the exact install line for each member.

## Quick start

The Lead, in a clone of the team's GitHub repository:

```sh
hackwin setup    # a few questions, then it configures the repository and GitHub once
hackwin gate     # in a terminal of its own that stays open all event
```

At the end, `setup` prints a message for each member to paste into a chat. It says, for that member:

```sh
npm install -g hackwin@0.1.0          # the version of the team
git clone <repository URL>
cd <repository> && hackwin join        # prepares this machine
```

Then everyone, again and again, in the main checkout of their clone:

```sh
hackwin take     # takes the next task of your roles and starts your agent in its worktree
                 # work with your agent; it commits
hackwin ship     # checks, pushes and opens the pull request; the Gate merges it
hackwin status   # who does what, what waits for the Gate, what is blocked
```

`setup` also writes `docs/hackwin/using-hackwin.md` into the repository: this workflow for your team, in more detail.

## Who does what

- **The Lead** holds the shared role: shared code, dependencies, contracts and configuration. The Lead runs `setup`, plans, writes the tasks and runs the Gate on their laptop.
- **Each member** holds one or more ownership roles. `owners.yml` gives every path exactly one role, so two people never edit the same files. Members take the tasks of their roles and drive their own agent sessions.
- **The agents** work only in the worktree of their task and only on the paths of its role. They never merge, and they never push to main.
- **The Gate** is the only one that merges. It needs no AI.

## The terminals each person keeps open

| Who | Terminal | Where |
| --- | --- | --- |
| The Lead | The planning session: Claude Code, for plans and tasks | The main checkout |
| The Lead | The Gate: `hackwin gate`, open all event | The main checkout |
| Everyone | One agent session per task, as many at a time as `setup` set for you (1 or 2, or 3 as an advanced option) | The task's worktree, `<repository>.worktrees/<N>-<slug>` next to the main checkout |

`hackwin take` in a terminal starts Claude Code in the worktree, in that same terminal. As `/take` inside a Claude Code session, it prints one line to paste into a new terminal instead. Every HackWin message that tells you to run something in a directory gives one line to paste, `cd <directory> && <command>`, which works from any directory.

## The loop

1. **Take.** In the main checkout, `hackwin take` with no number takes the next task of your roles: the first task of your queue that passes every check. It says which tasks it skipped and why. `hackwin take <N>` takes task N. Either way it claims the issue, creates the worktree and its branch `task/<N>-<slug>` from the current main, and starts your agent with a prompt built from the issue.
2. **Work.** Your agent works in the worktree, on the paths of the task's role, and commits.
3. **Ship.** `hackwin ship`, or `/ship` in the session, merges main into the branch, runs every check of the project and the task's acceptance tests, pushes the branch, and opens the pull request with `Closes #<N>`. It fills in the pull request what it checked, reports on the issue and stops. When a check fails, fix it in your own files, commit and ship again.
4. **Merge.** The Gate merges the pull request and the issue closes. Close the session and run `hackwin take` again; it removes the worktree of the merged task.

In Claude Code, `/take`, `/ship`, `/status` and `/gate` run the same commands as the terminal. `/gate` refuses inside a session: the Gate runs only in a terminal of its own.

## The Gate, and why GitHub shows BLOCKED

The Lead starts `hackwin gate` in a terminal of its own and keeps it open all event. The Gate takes ready pull requests one at a time. For each one it checks the task link, the scope, secrets and conflicts, tests the merge with the newest main in a scratch worktree, waits for CI, and merges only the head commit it tested. After a merge it runs the project's smoke test, when the project has one. Each pull request shows its stage as a label: `gate:queued`, `gate:testing`, `gate:waiting-ci`, `gate:merged` or `gate:failed`. When a pull request fails, the Gate comments why. Its author runs `hackwin take <N>`, which gives the agent a fix prompt with that comment. The Lead types `retry <PR>` in the Gate's terminal when a failure lies outside the pull request, such as a CI timeout.

`setup` protects main so that only the Lead's account can update it, where GitHub offers that rule. GitHub then shows every pull request as BLOCKED, the Lead's included. That is expected: only the Gate merges, as the Lead, after its own checks pass. The Gate keeps its state in the issue "HackWin Gate status", so `hackwin status` gives the same answer on every laptop.

## Status

`hackwin status` reads GitHub and shows:

- each member's tasks in progress and their next task, and for you the line to take it;
- the pull requests waiting for the Gate;
- what is blocked and why;
- what the Gate did lately;
- every task issue that is not valid, with the reason.

## When HackWin refuses something

Every refusal names the rule, what it is about and how to resolve it, usually with one line to paste. The exit code says what kind of refusal it is: 1, a rule or a check blocked the action; 2, a precondition is missing, such as `hackwin join` on this machine; 3, GitHub or the network failed, so run the command again later. Every command can be run again after a failure. Never work around a refusal, for example with `--no-verify` or a merge by hand: CI and the Gate check every pull request again.

| Refusal | What to do |
| --- | --- |
| An edit outside your role's paths (E1) | Leave the file. The Lead writes a task for the role that owns it. |
| A push to main (E2) | Run `hackwin ship`. Main changes only through the Gate. |
| A merge of a pull request (E3) | Leave it to the Gate. |
| `ship` with changes that are not committed | Commit them, then ship again. After `/ship`, ask your session to commit the listed files, then type `/ship` again. |
| A failed check in `ship` | Fix it in your own files, commit and ship again. |
| `take` refuses a task | It says why, for example: not your role, dependencies still open, a path collision with a task in progress, or as many tasks in progress as you may run. Without a number, it goes on to the next task of your queue. |
| The Gate fails a pull request | Read its comment, then run `hackwin take <N>` for a fix prompt. |

## Permission mode of the agent sessions

HackWin's rules hold in every permission mode of Claude Code. Its hooks refuse an edit outside your roles, a merge and a push to main before the call runs, and its deny rules refuse reading env files; Claude Code applies both in every mode, bypass permissions included. We recommend auto mode for task sessions. Bypass permissions works too, but Claude Code's documentation recommends it only in an isolated environment, such as a container. With default permissions, the allow list that `setup` writes into `.claude/settings.json` lets the routine steps run without a prompt: the project's install, check, test and format commands, `git status`, `diff`, `log`, `add` and `commit`, and `hackwin status`, `take` and `ship`. Each member chooses the mode on their own machine; `docs/hackwin/using-hackwin.md` says how.

## Writing tasks

A task is one GitHub issue that becomes one small pull request. It is made from the template "HackWin task" (`.github/ISSUE_TEMPLATE/hackwin-task.md`), which `setup` fills with your team's roles and their paths, the end of the event as the default deadline, and one example task. Its data block names the role, the paths the task may change, the issues it depends on, the acceptance tests and a deadline. Write a deadline as `2026-10-24 20:00`, in the event's time zone, or in ISO 8601 with an offset.

Ask your planning session to write the issue: tell it what the task must achieve, for which role, and how a test proves it, and it creates the issue from the template with `gh issue create`. Or write it on GitHub with New issue and the template. Two tasks that may run at the same time must not share a path. `hackwin status` lists every task issue that is not valid, with the reason.

## Phases

A project stays on the phase it started with.

| Command | Phase | What it does |
| --- | --- | --- |
| `setup` | 1, available | Configure the repository once: team, ownership, stack commands, generated files, labels, branch rules |
| `join` | 1, available | Prepare one member's machine: checks, hooks, personal settings |
| `take [N]` | 1, available | Take the next task of your roles, or task N: its worktree, and your agent with a composed prompt |
| `ship` | 1, available | Merge main into the branch, run every check, open the pull request, report in the issue and stop |
| `status` | 1, available | Show who does what, the merge queue, what is blocked and what the Gate did |
| `gate` | 1, available | Start the Gate in its own terminal on the Lead's laptop; it tests and merges pull requests one at a time without a model |
| `plan` | 2, coming | Produce the PRD, spec, design, contracts and foundation, and freeze the contracts |
| `tasks` | 2, coming | Turn the next wave of the plan into issues and check them for path collisions |
| `propose` | 2, coming | Turn a member's idea, or a request for a change outside their scope, into a task |

In Phase 3, `status --report` will print the event's metrics next to the HackYeah baseline, and the Gate will start a resolver for conflicts that need judgment.

## Case study: HackYeah 2026

One team of four in one room, on one shared GitHub repository. One person, the integrator, owned all shared code and was the only one who merged; each of the three others owned one feature directory. Everyone drove their own agent sessions. The numbers at the top come from git history, GitHub data and session logs.

**N = 1.** This is one event, with one team that sat in one room and talked face to face. Nobody knows yet how much of the result came from the method and how much from that room. The busy times are approximations from the session log, and the plan usage row is the team's own statement: no log we have confirms Codex use. We will measure our next hackathon the same way.

**What worked**, in order of importance:

1. Shared code had exactly one author.
2. One role per directory, not one person.
3. Contracts frozen before code, 45 minutes after the start.
4. Small PRs on short branches from current `origin/main`, each in its own worktree.
5. One merger, merges in order, a merge test on current main and CI on every PR.
6. Builder agent sessions had no right to merge.

**What hurt**, the three costly problems, and what HackWin does about each:

1. One blocked integrator session planned, merged and fixed conflicts, and PR events kept that conversation busy. The Gate now merges without a model, so the Lead keeps planning.
2. Prompts for teammates were copied to Discord by hand. `take` now writes each prompt from the task issue.
3. Rules lived by convention, and some broke: a push went out before its checks finished, a migration was applied before review, and main had no branch protection. `setup` now protects main, and hooks, CI and the Gate check the rules.

## Without the CLI: the template

A team that does not install the CLI can follow the method by hand. Create the project from the template repository [Bartek201301/hackwin-template](https://github.com/Bartek201301/hackwin-template). It holds no project code and calls no tool: shared rules for every agent, an example ownership map, the preparation guide, the method by hand, document skeletons, a PR template, a task issue template and a CI check. Start with `docs/hackwin/before-the-event.md`, then follow `docs/hackwin/manual-workflow.md`.

## Requirements and support

- In v1, Claude Code and the plain terminal are the fully supported paths. Codex support is beta.
- The Lead works with Claude Code.
- HackWin needs a GitHub repository, Node 22 or newer, git, the GitHub CLI `gh` and each member's agent.

## License

MIT. See [LICENSE](LICENSE).
