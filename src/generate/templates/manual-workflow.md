# The HackYeah method by hand

This guide runs the method of HackYeah 2026 with nothing but this template, GitHub issues, `git`, `gh` and each member's agent. Read `before-the-event.md` first.

The method in one paragraph: every directory has one ownership role, and every role has one holder. The Lead holds the shared role and plans. Work is written as task issues; each builder turns a task into a prompt on their own machine and runs it in a fresh agent session in its own worktree. A finished task becomes one small pull request. Only the Lead merges, one pull request at a time, after a merge test on the newest main, from a terminal that is not the planning conversation.

In every command below, `<repo>` is the name of your repository directory. The text before each command says which directory to run it in.

## 1. Roles

| Who | Does | Never does |
| --- | --- | --- |
| Lead (exactly one) | Holds the shared role: shared code, contracts, dependencies, configuration, CI. Plans and writes task issues. Runs the pull request recipe of section 7 and is the only one who merges. Applies migrations and production config changes by hand. Rotates a secret that reaches GitHub | Runs the recipe inside the planning conversation |
| Builder (every member, the Lead included) | Takes tasks of the roles they hold and finishes them as pull requests, with 1 or 2 agent sessions, one task per session | Edits outside their roles; merges |
| Agent session | Works on one task in one worktree, opens the pull request, stops | Merges; pushes to main; reads `.env.local`; applies a migration |

`owners.yml` maps paths to roles. Who holds which role is written in the Team section of `README.md`. The Lead's planning conversation runs in the main checkout; it plans, answers questions and writes task issues. It never runs the merge recipe: at HackYeah, pull request events handled inside the integrator's conversation kept it busy for about 146 minutes in one night.

## 2. Planning by hand: the foundation first

1. **Documents.** The Lead and the planning conversation fill `docs/hackwin/`: `prd.md`, `spec.md`, `design.md`, `non-code.md` and `epics.md`. Prose may stay general. The points of contact must be detailed: types, API, database schema and acceptance criteria.
2. **The foundation task.** The Lead writes one task of the shared role (kind `task`, with at least one acceptance test). It contains the contracts (types, API, database schema), the shared types, the installed dependencies, a mock for every contract that another role consumes, the real project check in `.github/workflows/check.yml` in place of the placeholder step, the final `owners.yml` and the Team section of `README.md`. The Lead takes and finishes it like any task (sections 4 to 6) and merges it with the recipe (section 7). HackYeah froze its contracts 45 minutes after the start.
3. **After the foundation is merged,** the contracts are fixed. They belong to the shared role, so only the Lead changes them, through a task of the shared role.
4. **The other tasks, in waves.** `epics.md` outlines the whole project; only the next wave becomes issues. The first wave covers 3 to 5 hours. Each task is about one hour of agent work and touches up to about 10 files. Small pull requests are the priority.
5. **Before publishing a wave,** compare the paths of the tasks that can run at the same time. Two parallel tasks must not share a path; if they do, make one depend on the other.
6. **Across roles,** a consumer works against the contract's types and mock. Connecting provider and consumer is a separate integration task at the end of the wave.
7. **When a member's queue runs empty,** they ask the Lead for the next wave.

## 3. Writing a task issue

- **Who.** The Lead, or the Lead's planning conversation through `gh`. A member with an idea inside their own role writes the issue themselves; for any other scope they ask the Lead.
- **How.** On GitHub choose New issue, then the "HackWin task" template. From a terminal, fill a copy of the template body and run `gh issue create --title "<title>" --body-file <file>`.
- **The data block.** `role` is one ownership role. Every glob under `paths` lies inside that role or on the `open` list. `depends_on` lists issue numbers. `acceptance_tests` names test files or test ids: acceptance criteria are written as tests, and a named test that does not exist counts as a failure. `deadline` is always set, inside the event.
- **Larger units** are grouped by a milestone or by sub-issues, never by a checklist inside one issue.
- **A member's queue** is the open tasks of the roles they hold that nobody has taken yet, ordered by wave (tasks without a wave last), then deadline, then issue number.

## 4. Taking a task (builder)

Check first. All five must hold:

1. You hold the task's role (Team section of `README.md`).
2. The task is open, nobody is assigned, and no pull request exists for it.
3. Every issue in `depends_on` is closed.
4. No open pull request changes a file inside the task's `paths`, and no other task in progress has overlapping `paths`. Files on the `open` list are exempt. List the open pull requests with `gh pr list --state open` and their files with `gh pr diff <PR> --name-only`.
5. You run fewer tasks than your sessions (1 or 2).

Then, in the main checkout:

```sh
git fetch origin \
  && git worktree add --no-track -b task/<N>-<slug> ../<repo>.worktrees/<N>-<slug> origin/main \
  && ln -s "$PWD/.env.local" ../<repo>.worktrees/<N>-<slug>/.env.local \
  && gh issue edit <N> --add-assignee @me \
  && git rev-parse origin/main
```

The assignment claims the task. Note the printed commit: it is where this worktree started, and your next prompt lists what changed on main since then. Install the dependencies in the worktree (`cd ../<repo>.worktrees/<N>-<slug>` and your install command). Then start a fresh agent session in the worktree and give it the prompt of section 5 as its first message. One task, one fresh session: at HackYeah task sessions used 2 to 24M tokens each, the integrator's session that was never cleared 338M.

## 5. The task prompt

The builder composes the prompt on their own machine from the issue. Nobody copies a prompt into a chat. It holds seven parts, in this order. This is what the HackYeah integrator put into every prompt it wrote by hand.

```text
Task: issue #<N>, "<title>". Read it with `gh issue view <N> --comments`:
the problem, the expected result, the acceptance tests and every comment
that starts with "Scope change:". Hard stop: <deadline>.

Role: <role>. You may change only <owned paths of the role> and the files on
the open list of owners.yml. Do not touch any other path. If you need a
change outside them, stop and tell me; I will ask the Lead.

Where to run: the worktree <absolute worktree path>, branch
task/<N>-<slug>. Run every command there.

Changed on main since my last task: <the files from
`git diff --stat <commit noted last time> origin/main`, my own paths first>.
(For the first task in this clone: nothing recorded yet.)

Finish: commit; merge origin/main into the branch (never rebase, never force
push) and resolve the conflicts in your own files; run the full check and
the acceptance tests; push the branch; open the pull request, not as a
draft, from the template with "Closes #<N>"; comment on the issue with the
pull request number, the full head SHA and the checks that ran. Each step
only after the previous one succeeded. Then stop with the pull request
number and the full head SHA. Never merge.

Security: never read or print .env.local. Leave every database and
production config change to the Lead, also changes made outside the
repository.

Answer me in <language>, <explanation style>.
```

To resume a task after a crash, a usage limit or a cleared session, start a fresh session in the same worktree with the same prompt plus the state of the branch. To fix a pull request that the Lead handed back, add the Lead's comment to the prompt.

## 6. Finishing a task

The session follows the finish line of its prompt and `AGENTS.md`. The order matters: at HackYeah a push went out before its checks had finished, because the commands were chained with `;`. Chain with `&&`, never with `;`. In the task worktree:

```sh
<check command> && <test command> <acceptance tests> && git push -u origin task/<N>-<slug>
```

A merge of `origin/main` that conflicts stops the finish: the session resolves the conflicts in its own files, the README included, commits and starts the finish again. At HackYeah all 8 branch side conflicts were resolved on the branches, and no merge into main conflicted.

The pull request is opened with `gh pr create`, never as a draft. The issue comment is the agent's report: pull request number, full head SHA, checks run. Issue comments are used only for such reports and for scope changes.

## 7. The pull request recipe (the Lead)

The Lead runs this in a separate terminal in the main checkout, never in the planning conversation and never as a watcher inside an agent session. Nine of the ten steps of the HackYeah recipe needed no model. The merge itself is typed by the Lead; no agent session merges.

**The queue.** Look at the open pull requests at a steady interval (the HackYeah watcher polled every 60 seconds):

```sh
gh pr list --state open --json number,headRefOid,isDraft,author,title
```

Drafts are ignored. Every other pull request is a queue item, the Lead's own included. When a pull request shows a head SHA you have not seen, run the secret check of stage 4 at once, then put it at the back of the queue. Work strictly one pull request at a time, first in, first out. A new head SHA sends the pull request to the back.

**The stages.** Each stage runs only when every earlier stage passed. With `PR` set to the pull request number:

| # | Stage | How | When it fails |
| --- | --- | --- | --- |
| 1 | Fetch | `git fetch origin && git fetch origin "+pull/$PR/head:pr/$PR"`, then note both full SHAs with `git rev-parse origin/main pr/$PR` | Retry |
| 2 | Task link | `gh pr view $PR --json headRefName,body`: the branch starts with `task/`, the body says `Closes #<N>`, and issue N is open with a valid data block | Fail |
| 3 | Scope | `gh pr view $PR --json author` and `git diff --name-only origin/main...pr/$PR`: every file lies in a role the author holds or on the `open` list | Fail; list each file with its role and holder |
| 4 | Secrets | The two commands under "Secret check" below both print nothing | Fail; the Lead rotates the secret at once |
| 5 | Migrations and production config | Does the diff touch them? Only the Lead's pull requests may; it should already be applied and recorded in the ledger | A builder's pull request fails at stage 3 |
| 6 | Conflicts | `git merge-tree --write-tree --name-only origin/main pr/$PR`: exit code 0 is clean; 1 lists the conflicted files | Fail and hand back; see below |
| 7 | Merge test | See below: the pull request merged with the newest main, then install, full check and the task's acceptance tests | Fail; give the command and the last lines of its log |
| 8 | CI | `gh pr checks $PR --watch` until the checks on this head succeed | Rerun the failed jobs once (`gh run rerun <run id> --failed`) before blaming the pull request |
| 9 | Freshness | `git fetch origin && git rev-parse origin/main`: still the SHA tested in stage 7? | Repeat from stage 6 |
| 10 | Merge | `gh pr merge $PR --merge --match-head-commit <full head SHA>`, then `git push origin --delete <head branch>` | Head moved: back of the queue with the new SHA |
| 11 | After the merge | The issue closes through `Closes #<N>`; tasks that depended on it can be taken; remove the scratch worktree and `pr/$PR`; run the project's production check, if it has one | A failed production check is fixed by a separate small pull request |

The merge test of stage 7, in the main checkout:

```sh
git worktree add --detach ../<repo>.worktrees/pr-$PR pr/$PR \
  && cd ../<repo>.worktrees/pr-$PR \
  && git merge --no-edit origin/main \
  && <install command> \
  && <check command> \
  && <test command> <acceptance tests of the task>
```

Afterwards, back in the main checkout: `git worktree remove --force ../<repo>.worktrees/pr-$PR`.

**Secret check**, in the main checkout. The first command searches the added lines for secret patterns, the second lists every added env file other than `.env.example`:

```sh
git diff origin/main...pr/$PR | grep '^+' | grep -n -i -E '<patterns>'
git diff --name-only --diff-filter=A origin/main...pr/$PR | grep -E '(^|/)\.env' | grep -v -E '(^|/)\.env\.example$'
```

Use the key formats of your services as `<patterns>`. The HackYeah check searched for its database provider's key prefixes, for tokens that start with `eyJ`, and for passwords assigned in code, for example `eyJ[A-Za-z0-9_-]{20}|password[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}`. A finding means the secret is already public on a pushed branch: the Lead rotates it at once, and a later commit does not undo that. The failure comment names the file, the line number and the pattern, never the matched text.

**Details.**

- The merge is pinned to the full head SHA you tested. A short SHA is rejected.
- **A failure** leaves exactly one comment on the pull request with the stage, the reason and the next action (`gh pr comment $PR --body "..."`), and the pull request leaves the queue until its author pushes a new head SHA. After a failure that needs no new commit, such as a CI timeout or a flaky test, the Lead may run the same head SHA again from the start.
- **Flaky tests.** Keep a list of tests known to depend on time. When CI fails twice and the log names one of them, the pull request is not blamed; the test is fixed in a separate small pull request. At HackYeah a time dependent test made a correct conflict fix look broken.
- **Conflicts** found at stage 6 go back to the pull request's author, in every file. The comment lists the conflicted files and the commits on main that changed each one: `git log --oneline $(git merge-base origin/main pr/$PR)..origin/main -- <file>`. The author resumes the task in its worktree, merges `origin/main`, resolves, finishes again and pushes.
- **Green alone, red together.** Stage 7 always tests with the newest main, so it catches two pull requests that pass alone and fail together. If the needed change lies in the pull request's own files, its author adapts it. If it lies elsewhere, it becomes a separate small pull request of the owning role: the author asks the Lead, who writes that task, and the first pull request is finished again once the fix is merged.
- **Never commit a fix on main.** A textual conflict is fixed on the pull request's branch, a semantic conflict by a separate small pull request.

## 8. Migrations and production config

They belong to the Lead. Migrations are additive only, an applied migration file is never edited, and every applied migration is recorded in a ledger file. The Lead reviews a migration, applies it by hand and records it in the ledger before opening the pull request that contains it. No agent session applies a migration or changes production config, also not outside the repository, and the project never applies migrations automatically on merge.

## 9. Changes during the event

- **Scope change.** Edit the issue body and add one comment that starts with "Scope change:". The next prompt for the task includes it.
- **Shared change.** A builder who needs a change outside their role asks the Lead, who writes a task of the owning role. Shared code keeps one author.
- **Role swap.** The affected members first finish or close their open pull requests. Then one line of the Team section changes. Ownership stays with the directory, and open tasks follow the role.
- **Deadlines and cuts.** Every task has a deadline. Cutting a task is the Lead's decision: the Lead closes the issue as not planned.
