<!-- hackwin:begin -->
# Rules for every agent

These rules bind every agent session in this repository, Claude Code or Codex, the Lead's sessions included. Ownership is written in `owners.yml`. The workflow is in `docs/hackwin/manual-workflow.md`.

## Language

The project language is English. Use it for code, commits, issues and pull requests. Answer the human in their own language.

## Scope and ownership

- `owners.yml` gives every directory exactly one ownership role. Your task names one role.
- Change only files inside your role's paths or on the `open` list of `owners.yml`. Every other path belongs to someone else: do not edit it, and do not revert other people's work.
- Shared code, dependencies, contracts and configuration belong to the Lead. If your task needs a change there, stop and ask the Lead for it, with the interface or the diff you need.

## Tasks, branches and worktrees

- One task is one GitHub issue and one pull request.
- Work only in the worktree of your task, on its own short branch that starts from the current `origin/main`.
- Run every command in the directory your instructions name: the worktree of your task. Never run commands in the main checkout or in another worktree.
- Bring main into your branch by merging `origin/main`. Never rebase, never force push.
- Format only the files you changed.

## Never

- Never push to `main`.
- Never merge a pull request, your own included. Only the Lead merges.
- Never read or print `.env.local`.
- Never apply a migration or change production config. Leave every database and production config change to the Lead, including changes made outside the repository.

## Finishing a task

Do these steps in order, each one only after the previous one succeeded: commit; merge `origin/main` into the branch and resolve the conflicts in your own files; run the full project check and the task's acceptance tests; push the branch; open the pull request, not as a draft, from the pull request template, with `Closes #<issue>`.

Then stop. Report the pull request number and the full head SHA, and do nothing more.
<!-- hackwin:end -->

<!-- Project rules: add your own rules below this line, outside the hackwin block. -->
