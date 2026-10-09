# Rules for every session that builds HackWin

These rules bind every agent session in this repository: the integrator's and every builder's. The task plan is `docs/build/plan.md`, the ownership map is `owners.yml`, and the specification is `docs/HackWin-build-phase-0-1.md` under the authority of `docs/HackWin-PRD.md`.

## Language

Use English for code, comments, commits, issues and pull requests. Answer the human in the language they write in.

## Ownership

- `owners.yml` gives every path exactly one role: `integrator`, `lane-a`, `lane-b` or `lane-c`. A path that matches no role belongs to `integrator`.
- Your task issue names one role. Change only files inside that role's paths. Never edit, move, delete or revert a file of another role, not even to fix a typo or a failing test.
- Shared code, package files, CI and the test harness belong to the integrator. When your task needs a change there, stop and tell the human which interface or change you need.

## One task, one branch, one worktree

- One task is one GitHub issue and one pull request.
- Each task has its own worktree and branch, created from the current `origin/main` in the main checkout:
  `git fetch origin && git worktree add --no-track -b task/<N>-<slug> ../HackWin.worktrees/<N>-<slug> origin/main`
  `<N>` is the issue number, `<slug>` two to four lowercase words of the title joined by hyphens.
- Run every command inside your task's worktree. Never work in the main checkout or in another worktree. The integrator uses the main checkout only to plan and to merge.
- Bring main into your branch with `git merge origin/main`. Never rebase, never force push, never amend a pushed commit.
- Never push to `main`. Never merge a pull request, your own included. Only the integrator merges, and only when the human asks.

## Checks

- Format only the files you changed: `npm run format -- <files>`.
- Before you open a pull request, run the full test suite, `npm test`, and the task's acceptance tests, `npm run test:ac -- <ids>`, on the commit you push. Both must pass.
- Chain these commands with `&&`, never with `;`.
- While `package.json` does not exist on your branch, these commands do not exist yet. Say so in the pull request.

## Secrets

Never read, print or copy a secret or token: no `.env` file other than `.env.example`, no `gh auth token`, no credential store, and no token value in code, tests, logs, commits, issues or pull requests. Tests get GitHub accounts only through the test harness.

## Finishing a task

Do these steps in order, each one only after the previous one succeeded:

1. Commit.
2. `git fetch origin && git merge origin/main`, resolving conflicts in your own files only.
3. Run `npm test` and the task's acceptance tests.
4. Push the branch: `git push -u origin task/<N>-<slug>`.
5. Open the pull request, not as a draft, from `.github/pull_request_template.md`, with `Closes #<N>`.

Then stop. Report the pull request number and the full head SHA, and do nothing more.
