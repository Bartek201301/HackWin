# HackWin

HackWin is a workflow and a planned CLI for hackathon teams of 2 to 4 people who each run their own Claude Code or Codex sessions on one GitHub repository. It came out of HackYeah 2026, where four people merged 133 pull requests in about 23 hours and not one merge into main conflicted. HackWin packages what made that possible and removes what hurt. Every directory has one owner. Contracts are frozen before parallel work starts. The planned `/take` command will hand a task to your agent with no copied prompt. A planned gate that needs no AI will test and merge pull requests one at a time while your lead keeps planning. The promise is fast delegation without conflicts, so more features work in the demo and people have time for the video and the pitch. Zero conflicts is the proof, not the slogan: a planned command will print your numbers next to ours. Our baseline is a single event with one team, and we say so. Claude Code and the plain terminal are fully supported. Codex support is in beta.

> **Release 1:** case study and template. No CLI yet: every command here is planned, not available.

| HackYeah 2026 | Result |
| --- | --- |
| Team and duration | 4 people, about 23 hours: first merge 3 Oct 11:23, last 4 Oct 10:21 (local) |
| Merged PRs | 133 (50, 39, 32, 12 per account), 2 closed unmerged; median 5 files, 262 lines |
| Conflicts | 0 merges into main conflicted; 8 branch-side conflict merges |
| Production regressions | None observed after a merge |
| Lead conversation | Busy about 146 min in one night on watcher events; median 1.9, p90 6.8 min each |
| Watcher loop | 54 launches of the watcher loop in one night, most of them manual restarts |
| Tokens per PR event | About 2.4M; context per model call: median 255 thousand, p90 500 thousand |
| Compactions overnight | 3, plus 1 stop at the usage limit |
| PR recipe | 9 of 10 steps needed no model |
| Plan usage in 24 hours | 3 Claude Max limits and about 50% of a Codex plan (200 USD tier) |

## Case study: HackYeah 2026

One team of four in one room, on one shared GitHub repository. One person, the integrator, owned all shared code and was the only one who merged; each of the three others owned one feature directory. Everyone drove their own agent sessions. The numbers above come from git history, GitHub data and session logs.

**N = 1.** This is one event, with one team that sat in one room and talked face to face. Nobody knows yet how much of the result came from the method and how much from that room. The busy times are approximations from the session log, and the plan usage row is the team's own statement: no log we have confirms Codex use. We will measure our next hackathon the same way.

**What worked**, in order of importance:

1. Shared code had exactly one author.
2. One role per directory, not one person.
3. Contracts frozen before code, 45 minutes after the start.
4. Small PRs on short branches from current `origin/main`, each in its own worktree.
5. One merger, merges in order, a merge test on current main and CI on every PR.
6. Builder agent sessions had no right to merge.

**What hurt**, the three costly problems:

1. One blocked integrator session planned, merged and fixed conflicts, and PR events kept that conversation busy.
2. Prompts for teammates were copied to Discord by hand.
3. Rules lived by convention, and some broke: a push went out before its checks finished, a migration was applied before review, and main had no branch protection.

## Before you use it

- **HackWin is a tool, not ready project code.** It brings rules and a workflow; your team writes the project at the event.
- **Check your event's rules on code written before the hackathon,** and on AI tools. Some events require all code to be written during the event, and some forbid AI code generation. Make sure a template prepared in advance is allowed.

## Use it today: the template

Create your project from the template repository [Bartek201301/hackwin-template](https://github.com/Bartek201301/hackwin-template). It holds no project code and calls no tool.

| Part | What it gives you |
| --- | --- |
| `AGENTS.md`, imported by `CLAUDE.md` | Shared rules for every agent: stay in your scope, one task one PR, one worktree per task, never merge, never push to main, never read `.env.local` |
| `owners.yml` | An example ownership map: one role per directory |
| `docs/hackwin/before-the-event.md` | The preparation guide: event rules, research, stack, accounts, migrations, where the repository lives |
| `docs/hackwin/manual-workflow.md` | The HackYeah method by hand: planning, tasks as issues, the task prompt, the merge recipe |
| `docs/hackwin/` skeletons | PRD, spec, design, epics, deliverables outside the code |
| `.github/` | A PR template, a task issue template, and a CI check whose placeholder step you replace with your project's check |
| `.claude/`, `.agents/` | One research skill for both agents, one research subagent, and rules that stop Claude Code from reading env files |

Start with the preparation guide, then follow the manual workflow.

## The planned CLI

Nothing in this section exists yet. The CLI will arrive in phases, each usable at a real hackathon on its own. A project stays on the phase it started with.

| Command | Phase | What it will do |
| --- | --- | --- |
| `setup` | 1 | Configure the repository once: team, ownership, stack commands, generated files, labels, branch rules |
| `join` | 1 | Prepare one member's machine: checks, hooks, personal settings |
| `take [N]` | 1 | Check a task, create its worktree and start the member's agent with a composed prompt |
| `ship` | 1 | Merge main into the branch, run every check, open the PR, report in the issue and stop |
| `status` | 1 | Show who does what, the merge queue, what is blocked and what the Gate did |
| `gate` | 1 | Start the Gate in its own terminal on the Lead's laptop; it will test and merge PRs one at a time without a model |
| `plan` | 2 | Produce the PRD, spec, design, contracts and foundation, and freeze the contracts |
| `tasks` | 2 | Turn the next wave of the plan into issues and check them for path collisions |
| `propose` | 2 | Turn a member's idea, or a request for a change outside their scope, into a task |

In Phase 3, `status --report` will print the event's metrics next to the HackYeah baseline, and the Gate will start the Resolver for conflicts that need judgment.

## Requirements and support

- In v1, Claude Code and the plain terminal are the fully supported paths. Codex support is beta.
- The Lead works with Claude Code.
- The template needs a GitHub repository, git, the GitHub CLI `gh` and each member's agent.

## License

MIT. See [LICENSE](LICENSE).
