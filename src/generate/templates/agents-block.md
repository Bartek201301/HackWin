<!-- hackwin:begin -->
# Rules for every agent

These rules bind every agent session in this repository, Claude Code or Codex, the Lead's sessions included. Ownership is written in `owners.yml`; who holds each role, and the project's commands, are in `hackwin.yml`. Some rules are also checked: by HackWin's git hooks and CI, by its Claude Code hooks in Claude Code sessions only, by the Gate, and on `{{branch}}` by GitHub's branch rules where GitHub offers them. Other rules, such as never reading `.env.local` in a Codex session, are checked by nothing. Every rule binds you whether or not a check catches it.

## Language

The project language is {{language}}. Use it for code, commits, issues and pull requests. Answer the human in their own language.

## Scope and ownership

- `owners.yml` gives every path exactly one ownership role: a path that no role names belongs to the shared role. Your task names one role.
- Change only files inside your role's paths or on the `open` list of `owners.yml`. Every other path belongs to someone else: do not edit it, and do not revert other people's work.
- Shared code, dependencies, contracts and configuration belong to the Lead. If your task needs a change there, stop and ask the Lead for it, with the interface or the diff you need. The Lead writes a task for it.

## Tasks, branches and worktrees

- One task is one GitHub issue and one pull request.
- `hackwin take <issue>` creates the worktree of a task, on its own branch `task/<issue>-<slug>` from the current `origin/{{branch}}`. Work only in that worktree.
- Run every command in the directory your instructions name. A session that works on a task stays in the worktree of that task: never in the main checkout, never in another worktree. Only the Lead's planning session works in the main checkout. Every HackWin message that tells you to run something names the directory.
- Bring `{{branch}}` into your branch by merging `origin/{{branch}}`. Never rebase, never force push.
- Format only the files you changed.

## Never

- Never push to `{{branch}}`.
- Never merge a pull request, your own included. The Gate merges, one pull request at a time.
- Never read or print `.env.local`.
- Never apply a migration or change production config. Leave every database and production config change to the Lead, including applying migrations and changes made outside the repository.

## Finishing a task

Commit your work, then run `hackwin ship` in the worktree of your task. It merges `origin/{{branch}}` into the branch, runs every check, pushes the branch, opens the pull request with `Closes #<issue>` and reports in the issue. When it stops on a conflict or a failed check, fix it in your own files, commit and run `hackwin ship` again.

Then stop. Report the pull request number and the full head SHA, and do nothing more.

## Pull requests on GitHub

While the update restriction on `{{branch}}` is active, GitHub shows every pull request as `BLOCKED`, the Lead's included. This is expected: the Gate merges it. Do not try to fix a `BLOCKED` pull request.
<!-- hackwin:end -->
