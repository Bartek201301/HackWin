# Using HackWin

This guide is the daily workflow of this repository with the HackWin CLI: who does what, which terminals stay open, and what to do when HackWin refuses something. Read `before-the-event.md` first. `documents.md` covers the planning documents. `manual-workflow.md` describes the same method without the CLI; a team that uses the CLI does not need it.

The method in one paragraph: every path has one ownership role, and every role has one holder. The Lead holds the shared role and plans. Work is written as task issues. A member takes a task with `hackwin take`, which starts an agent session in the task's own worktree with a composed prompt. The session works, commits and runs `hackwin ship`, which opens one small pull request. Nobody merges by hand: the Gate tests each pull request on the newest main and merges it, one at a time.

## 1. Roles

| Who | Does | Never does |
| --- | --- | --- |
| Lead (exactly one) | Holds the shared role: shared code, contracts, dependencies, configuration, CI. Plans with the planning session and writes task issues. Runs the Gate. Applies migrations and production config changes by hand. Rotates a secret that reaches GitHub. Builds too | Merges by hand |
| Builder (every member, the Lead included) | Takes tasks of the roles they hold and ships each one as a pull request, with as many sessions at a time as `sessions` in `hackwin.yml` allows (1 or 2) | Edits outside their roles; merges |
| Agent session | Works on one task in its worktree, commits, runs `hackwin ship` and stops | Merges; pushes to the default branch; reads `.env.local`; applies a migration |
| The Gate | A process without a model on the Lead's laptop. Tests each pull request on the newest main, then merges it | Commits on the default branch; talks to an agent session |

`owners.yml` maps paths to ownership roles; a path that no role names belongs to the shared role. `hackwin.yml` says who holds each role, the project's commands and the time of the event. You may change the files of your roles and the files on the `open` list of `owners.yml`. For a change anywhere else, ask the Lead, who writes a task for the role that owns it.

## 2. The terminals

| Who | Terminal | Directory | What runs there |
| --- | --- | --- | --- |
| Lead | The planning session | The main checkout | `claude`: plans, writes task issues, answers questions. It never works on a task and never runs the Gate |
| Lead | The Gate | The main checkout | `hackwin gate`, for the whole event. Type `retry <PR>`, `ack <PR>` or `quit` there |
| Every member, the Lead included | One terminal per task, 1 or 2 at a time | Start in the main checkout | `hackwin take`, which creates the task's worktree beside the repository, `<repo>.worktrees/<issue>-<slug>`, and starts Claude Code there |

So the Lead keeps three or four terminals open: the planning session, the Gate and one or two tasks. Every other member keeps one or two. Each task gets a fresh session: it costs far fewer tokens than one long session.

Run `hackwin join` once on each machine before the first `take`. When the Lead's laptop sleeps or the Gate stops, merges wait until it runs again; nobody else can start a Gate.

## 3. The loop

1. **Take.** In the main checkout, run `hackwin take`. With no number it takes the next task of your roles: the first one of your queue that passes every check, for example that its dependencies are closed and that no open pull request or other task touches its paths. It prints the tasks it skipped and why. `hackwin take <issue>` takes one task by its number. Either way it claims the task on GitHub, creates the branch `task/<issue>-<slug>` and its worktree from the newest main, installs the dependencies, and starts Claude Code in the worktree with the task as its first message.
2. **Work.** The session works in the worktree and asks you when it needs a decision. It changes only the files of your roles.
3. **Commit.** The session commits its work.
4. **Ship.** The session runs `hackwin ship` in the worktree. It merges main into the branch, runs every check and the task's acceptance tests, pushes the branch, opens the pull request with `Closes #<issue>`, reports in the issue and prints `PR #<PR> opened at <SHA>. Do not merge. Stop.`
5. **Next.** Close the session; the terminal is back in the main checkout. Run `hackwin take` again. The worktree of a merged task is removed by your next `take`.

More forms of `take`, each run in the main checkout:

- `hackwin take <issue>` on your own task in progress continues it after a crash, a usage limit or a cleared session.
- `hackwin take <issue>` on your task whose pull request the Gate failed reopens the worktree with a fix prompt that holds the Gate's comment.
- `hackwin take <issue> --release` gives the task back, so that it can be taken again; the branch stays.
- `/take` inside a running Claude Code session prints the command that starts the task in a new terminal. A Codex user (beta) gets the command that starts Codex.

When the queue is empty, `take` says so: ask the Lead for the next tasks.

## 4. The Gate, and why pull requests show BLOCKED

The Gate runs in its own terminal on the Lead's laptop. For each pull request, in order, it checks the task link, the scope and the added lines for secrets, merges the newest main into it, runs the install, the full check and the task's acceptance tests, waits for CI, and merges it pinned to the head commit it tested. It then closes the issue. Its stage shows as a label on the pull request: `gate:queued`, `gate:testing`, `gate:waiting-ci`, `gate:merged` or `gate:failed`.

While the update restriction on the default branch is active, GitHub shows every pull request as `BLOCKED`, the Lead's included. This is expected: only the Lead's account may update the default branch, and the Gate merges under that account. Do not try to fix a `BLOCKED` pull request; look at its Gate label.

## 5. `hackwin status`

Run `hackwin status` at any time, in any checkout of the repository, or `/status` in Claude Code. It reads GitHub, so it gives the same answer on every laptop. It shows:

- the protection state, the time left until the end of the event, and how long ago the Gate last reported (a warning when it stopped reporting);
- what needs attention: for the Lead, migrations, secrets and scope violations; for you, your pull requests that the Gate failed;
- who works on which task, with deadlines and overdue tasks;
- the merge queue, in order, with each pull request's Gate stage;
- what is blocked, and why: open dependencies, task issues with an invalid data block, failed pull requests;
- what the Gate did since your previous `status`.

## 6. When HackWin refuses

Every refusal names the rule, the files or objects involved and what resolves it, with the directory to run it in:

```text
hackwin <command>: blocked: <what was refused>
  rule: <the rule>
  - <a file or object>
  to resolve: run `cd <directory> && <command>`
```

Do what `to resolve` says. Every command can be run again after a failure. The exit code says what kind of refusal it is: 1, a rule or check blocked the action; 2, a precondition is missing, such as `hackwin join` on this machine or the CLI version that `hackwin.yml` pins; 3, GitHub or the network failed, so run the command again once GitHub answers.

| Refusal | What to do |
| --- | --- |
| `take`: the task is not of your roles, a dependency is still open, a path collides with an open pull request or a task in progress, or you already run as many tasks as your sessions | Take another task (`hackwin take` with no number picks one that passes), finish a running task first, or wait for the dependency |
| `take`: the task's data block is invalid | The Lead corrects the issue body as the message says |
| `ship` stops on a conflict with main | The session resolves the conflicts in its own files, commits and runs `hackwin ship` again |
| `ship` stops on a failed check: scope, secret, format, generated files, the full check or an acceptance test | The session fixes it in its own files, commits and runs `hackwin ship` again |
| A file outside your roles: in `ship`, at commit or at an edit in Claude Code | Undo that change. If the task needs it, ask the Lead for a task of the role that owns the file |
| In Claude Code, `hackwin: blocked` for `gh pr merge`, a merge through `gh api` or a push to the default branch | Nothing to fix: the Gate merges, and only through pull requests. Run `hackwin ship` |
| At commit or push: a commit on the default branch, an env file or a secret, or a push without green checks | Work on the task branch, remove the secret or env file, and push with `hackwin ship`, which pushes after the checks |
| The Gate fails your pull request (`gate:failed`, with `needs-owner` for a conflict or `scope-violation`) | Read the Gate's comment on the pull request, then run `hackwin take <issue>` in the main checkout: the fix prompt holds the comment. The session fixes, commits and runs `hackwin ship` |
| The Gate failed for a reason outside the pull request, such as a CI timeout or a flaky test | The Lead types `retry <PR>` in the Gate terminal |
| The Gate found a secret | The Lead rotates the secret at once, then types `ack <PR>` in the Gate terminal. A later commit does not undo a pushed secret |

Never work around a refusal, for example with `--no-verify`, another spelling of a command or a merge by hand. CI and the Gate check every pull request again before any merge.

## 7. Writing a task

A task is one GitHub issue that becomes one pull request: about one hour of agent work and up to about 10 files. It can be taken as soon as its data block is valid.

- **Ask the planning session.** Tell the Lead's planning session what the task must achieve, for which role, and how a test proves it. It fills in the task issue template and creates the issue with `gh issue create`. Read the issue before anyone takes it.
- **On GitHub.** Choose New issue, then the template "HackWin task". Its comments name your roles and their paths, its deadline is the end of the event, and it ends with a filled example task. Fill in the data block and the four headings, and delete the comments.
- **From a terminal.** Fill in a copy of `.github/ISSUE_TEMPLATE/hackwin-task.md` without its first four lines, then run `gh issue create --title "<title>" --body-file <file>` in the main checkout.

The data block: `role` is one ownership role; every glob under `paths` lies inside that role or on the `open` list; `depends_on` lists issue numbers; `acceptance_tests` names at least one test file or test id, which `hackwin ship` and the Gate run with the project's test command, and a named test that does not exist fails; `deadline` is a date and time in the event's time zone, such as `2026-10-24 20:00`, or a time with its offset, such as `2026-10-24T20:00:00+02:00`. Two tasks that may run at the same time must not share a path: make one depend on the other. `hackwin status` lists every task issue whose data block is invalid.

## 8. Permission mode of the agent sessions

**Recommended for task sessions: auto mode, or bypass permissions.** With Claude Code's default permissions (Manual mode) the session asks you before each file edit and each command that is not read-only, unless a rule allows it. The allow list that setup writes into `.claude/settings.json` covers the routine steps: the project's install, check, test and format commands, `git status`, `git diff`, `git log`, `git add`, `git commit`, and `hackwin status`, `take` and `ship`. Every other command and every file edit still asks. Claude Code applies a project's allow list only after you accept the folder's trust dialog.

`hackwin take` starts `claude` without a permission flag, so the session starts in the mode of your own settings. Recent versions of Claude Code start a terminal session in auto mode. If yours starts in Manual mode, press Shift+Tab in the session to switch, or set the mode in your own `~/.claude/settings.json`:

```json
{
  "permissions": {
    "defaultMode": "auto"
  }
}
```

Write `"bypassPermissions"` there for bypass permissions. Claude Code ignores both values in a project's `.claude/settings.json`, so each member chooses the mode on their own machine.

**Why HackWin's hooks keep these sessions safe.** HackWin's rules are enforced outside the permission mode:

- Claude Code applies deny rules and `PreToolUse` hook refusals in every permission mode, bypass permissions included, and no allow rule overrides them.
- The `PreToolUse` hook of `.claude/settings.json` refuses an edit outside your roles, `gh pr merge`, a merge through `gh api` and a push to the default branch, before the call runs.
- The deny rules refuse reading `.env`, `.env.local` and `.env.*.local`, and the same merges and pushes.
- Behind them, the git hooks check every commit and push, `hackwin ship` runs every check before it pushes, and CI and the Gate check every pull request before any merge.

These guards hold HackWin's rules, not every action a session can take on your machine. In auto mode a classifier still reviews each action before it runs. Bypass permissions skips that review, and Claude Code's documentation recommends it only in an isolated environment such as a container or a virtual machine. Choose auto mode unless you accept that.
