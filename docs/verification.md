# Platform verification: section 5.6

| Field | Value |
| --- | --- |
| Task | 1.2, issue #2 |
| Specification | `docs/HackWin-build-phase-0-1.md` section 5.6 (18 rows), under the authority of `docs/HackWin-PRD.md`; plan `docs/build/plan.md` |
| Checked | 2026-10-10 (all times UTC): documentation read, local experiments, GitHub experiments from 23:44 to 23:49 |
| Machine | macOS 26.6.2 (arm64), Claude Code 2.1.296, gh 2.88.1, git 2.53.0, Node 25.8.1; Codex not installed (`codex: command not found`) |
| GitHub account | `Bartek201301`, a personal account in no organization (`gh api user/orgs` is empty). The token's scopes are `gist`, `read:org`, `repo`; they do not show the plan, and GitHub's answers on the private fixture ("Upgrade to GitHub Pro ...") show it is not on Pro |
| Repositories | Settings were changed only on `hackwin-fixture-b` (public) and `hackwin-fixture-private` (private), with the human's agreement in the session, and undone (section 6). Both had `main` at `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` before and after. `hackwin-sandbox` was only read |

Verdicts: **holds**, **partly holds**, **does not hold**, **unknown**. The chosen behavior is the capability itself or the fallback that 5.6 names. Evidence is a page of the current official documentation with the date it was read, or an experiment of section 6 (E1 to E4 on GitHub, L1 to L3 on this machine, R for read-only calls).

## 1. Summary

**Rows whose fallback applies.**

| Row | Where the fallback applies | What it changes, for which task |
| --- | --- | --- |
| 4. A running session continues in another working directory | Everywhere | 1.5b (#16): called with the caller kind `claude-code`, `take` runs steps 1 to 6 as in a terminal and, in place of step 7, prints the prompt file path and the command that starts Claude Code in the worktree, for a new terminal; the session does not move. 1.5c (#17): the same for the continue and fix prompts. 1.4c (#10): the `/take` wrapper passes that output on and does not ask the session to change directory. 1.7c (#28): AC14 still compares labels, branch, PR body and exit code |
| 7. Push protection | Private repositories of personal accounts; private organization repositories without GitHub Secret Protection | 1.4f (#13): `setup` decides on or off from the read back alone, because GitHub can answer the enabling call with 200 and enable nothing (E3); off means HackWin's scans alone and the summary reports push protection as off. 1.7b (#27): the refusing case of AC80 runs on `hackwin-fixture-private` (section 5) |
| 17. Keep awake | Windows through WSL; any machine where the command is missing or fails | 1.6a (#20): the warning that the Gate cannot prevent sleep. AC31's inhibitor check can only pass on macOS and Linux |
| 18. Operating system notification | Windows through WSL; Linux without `notify-send` or a notification server | 1.6c (#22): the terminal bell (G26, AC79) |

**Findings that change a task without a fallback.**

- Rows 6 and 14: while the update restriction is active, GitHub reports every PR into the branch as `BLOCKED`, for the Lead too, so `gh pr merge --merge --match-head-commit <SHA>` is refused by `gh` before any API call. With `--admin` the Lead's merge passes the update restriction and still meets every rule of the rules for everyone (E1). This affects 1.6d (#23), the Gate's merge, and 1.7b (#27), AC63.
- Row 6: on a personal repository the bypass actor is the repository admin role, `{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}` (E1). This affects 1.4f (#13), which writes it, and 1.3e (#7), which reads it.
- Row 10: `gh issue edit` (GraphQL) refuses an issue body above 262,144 UTF-8 bytes, and GitHub documents no limit (E4). This affects 1.6b (#21).
- Row 9: whether a body edit notifies is unknown; a mention added by an edit is documented to notify. 1.6b (#21) keeps `@` mentions out of the status issue body.
- Row 2: deny patterns cover the usual spellings of a merge through `gh api`, not every spelling; the gap of 10.6 stays as written. This affects 1.4c (#10).
- Added row: the Codex start command is `codex --cd <worktree> "<prompt>"`. This affects 1.5b (#16), AC72.

Every other row holds as 5.6 states it, and the capability is used: rows 1, 3, 5, 8, 12, 13, 15 and 16. Row 11 partly holds and keeps the defaults of 6.3.

## 2. Rows at a glance

| # | Capability | Verdict | Chosen behavior | Tasks |
| --- | --- | --- | --- | --- |
| 1 | Project skill as a slash command | Holds | Capability: `.claude/skills/<name>/SKILL.md` | 1.4c (#10), 1.7c (#28) |
| 2 | Claude Code hooks and Bash deny rules, also for a merge through `gh api` | Partly holds | Capability; the 10.6 gap stays | 1.4c (#10), 1.7b (#27) |
| 3 | Claude Code CLI starts with a working directory and an initial prompt | Holds | Capability: `claude "<prompt>"` with the worktree as process directory | 1.5b (#16) |
| 4 | A running session continues in another working directory | Partly holds | Fallback: the terminal command is printed | 1.4c (#10), 1.5b (#16), 1.5c (#17), 1.7c (#28) |
| 5 | Branch rules on a public personal repository that bind the owner | Holds | Capability: a ruleset without bypass | 1.3e (#7), 1.4f (#13), 1.7b (#27) |
| 6 | Update restriction to the Lead's account | Holds | Capability: a ruleset of its own with the admin role as bypass | 1.3e (#7), 1.4f (#13), 1.6a (#20), 1.6b (#21), 1.6d (#23), 1.7b (#27) |
| 7 | Secret scanning push protection | Partly holds | Capability where offered; fallback elsewhere | 1.3d (#6), 1.4f (#13), 1.7b (#27) |
| 8 | Pinning an issue from the command line | Holds | Capability: `gh issue pin` | 1.6b (#21) |
| 9 | Editing an issue body sends no notification | Unknown | Capability as specified (the fallback is "none needed") | 1.6b (#21) |
| 10 | Largest issue body | Holds (measured, not documented) | Capability: at most 262,144 UTF-8 bytes | 1.6b (#21) |
| 11 | Limits on write requests | Partly holds | Capability with the defaults of 6.3 | 1.6b (#21), 1.6c (#22), 1.6d (#23) |
| 12 | Inviting a collaborator from the command line | Holds | Capability: `gh api -X PUT .../collaborators/<login>` | 1.4f (#13) |
| 13 | GitHub offers `.github/ISSUE_TEMPLATE/` files | Holds | Capability | 1.4d (#11) |
| 14 | `gh pr merge --merge --match-head-commit <full SHA>` | Holds | Capability, with `--admin` under the update restriction | 1.6d (#23), 1.7a (#26), 1.7b (#27) |
| 15 | `git merge-tree --write-tree` | Holds | Capability; `join` fails before git 2.38 | 1.4e (#12), 1.6c (#22) |
| 16 | Rerunning failed CI jobs from the command line | Holds | Capability: `gh run rerun <run-id> --failed` | 1.6d (#23) |
| 17 | Keep the laptop awake while a process runs | Partly holds | Capability on macOS and Linux; fallback on WSL | 1.6a (#20) |
| 18 | Operating system notification from a terminal process | Partly holds | Capability on macOS and Linux; fallback on WSL | 1.6c (#22) |
| A | Added by the plan, not part of 5.6: the command that starts Codex in a directory with a prompt | Holds (documentation) | Capability: `codex --cd <dir> "<prompt>"` | 1.5b (#16) |

## 3. Rows in detail

### Row 1. Claude Code exposes a project skill as a slash command with the same name

- **Verdict:** holds.
- **Evidence:**
  - https://code.claude.com/docs/en/skills, read 2026-10-10: "A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way." Existing `.claude/commands/` files keep working; when both define one name, the skill wins. `disable-model-invocation: true` keeps Claude from loading the skill on its own; `$ARGUMENTS` holds the arguments; `allowed-tools` approves tools for the invoking turn, and deny rules still override it.
  - Not run in a real session: the build starts no automated Claude Code session (plan section 9, decision 9); the manual check per release covers it (plan section 6).
- **Chosen behavior:** the capability: one skill per command at `.claude/skills/<name>/SKILL.md`, invoked as `/<name>`. No `.claude/commands/` wrappers.
- **Tasks:** 1.4c (#10), 1.7c (#28).

### Row 2. Claude Code hooks and `permissions.deny` rules for Bash, including a merge through `gh api`

- **Verdict:** partly holds. The hooks and the deny rules hold in every permission mode. Deny patterns match the usual spellings of a merge through `gh api`, not every spelling.
- **Evidence:**
  - https://code.claude.com/docs/en/hooks, read 2026-10-10: `SessionStart` ("When a session begins or resumes"), `PreToolUse` ("Before a tool call executes. Can block it"), `PostToolUse` ("After a tool call succeeds"). A `PreToolUse` hook blocks with exit code 2, its stderr being the message, or with `permissionDecision: "deny"`. It receives the full Bash `command`, the `cwd`, and an absolute `tool_input.file_path` for edits. The plain stdout of a `SessionStart` hook is added to the context. Project hooks live in `.claude/settings.json`.
  - https://code.claude.com/docs/en/permission-modes, read 2026-10-10: "Deny rules block in every mode, including `bypassPermissions`." https://code.claude.com/docs/en/hooks-guide, read 2026-10-10: a `PreToolUse` hook that returns `permissionDecision: "deny"` "blocks the tool even in `bypassPermissions` mode or with `--dangerously-skip-permissions`."
  - https://code.claude.com/docs/en/permissions, read 2026-10-10: "A `*` can go anywhere in the rule: at the start, in the middle, or at the end." `Bash(gh pr merge:*)` and `Bash(gh pr merge *)` are the same rule. Deny rules apply when any subcommand matches, split at `&&`, `||`, `;`, `|`, `&` and newlines, also inside subshells and command substitutions. The same page says "Bash permission patterns that try to constrain command arguments are fragile" and that a deny rule covers the usual invocation and is not a security boundary: its example `Bash(git push *)` does not stop `git -C . push`, an absolute path to the program or `bash -c '...'`.
  - So patterns such as `Bash(gh pr merge *)`, `Bash(gh api *pulls/*/merge*)` and `Bash(gh api *mergePullRequest*)` can cover the usual REST and GraphQL forms. A query read from a file (`-F query=@file`), `sh -c '...'` or an absolute path to `gh` escape them. Whether a `*` at the end of a pattern also matches empty text is not stated. The `PreToolUse` hook receives the same full command string and can apply the same match.
  - Not run in a real session (decision 9).
- **Chosen behavior:** the capability: the hooks of 10.4, deny rules for `gh pr merge`, the usual `gh api` merge forms and pushes to main, and the same match in the `PreToolUse` hook. The part that does not hold is the gap that 10.6 already names ("A merge made by another route than `gh pr merge`"), which stays as written. The fallback of 5.6 (only `AGENTS.md`) does not apply.
- **Tasks:** 1.4c (#10), 1.7b (#27, the deny part of AC63); the manual check per release.

### Row 3. The Claude Code CLI accepts a working directory and an initial prompt at start

- **Verdict:** holds. There is no flag for the working directory; it is the directory of the process.
- **Evidence:**
  - https://code.claude.com/docs/en/cli-reference, read 2026-10-10: "`claude "query"` | Start interactive session with initial prompt". By default Claude has access to the directory where it was launched (https://code.claude.com/docs/en/permissions); the session has no `--cwd` option.
  - `claude --help` (2.1.296): `Usage: claude [options] [command] [prompt]`. `--add-dir` adds directories for file access. `-w, --worktree [name]` creates a worktree under `<repo>/.claude/worktrees/`, not at the path of A9.
  - The prompt is one argument. On this Mac `getconf ARG_MAX` prints `1048576` (bytes for all arguments and the environment together). On Linux one argument is limited to 32 pages, 131,072 bytes with 4 KiB pages (execve(2), https://manpages.debian.org/bookworm/manpages-dev/execve.2.en.html, read 2026-10-10).
  - Not run in a real session (decision 9).
- **Chosen behavior:** the capability: `take` starts `claude "<prompt>"` as a process whose working directory is the worktree.
- **Tasks:** 1.5b (#16).

### Row 4. A running agent session can continue its work in another working directory

- **Verdict:** partly holds.
- **Evidence:**
  - https://code.claude.com/docs/en/tools-reference, read 2026-10-10: a `cd` in the Bash tool carries over only "as long as it stays inside the project directory or an additional working directory"; "If `cd` lands outside those directories, Claude Code resets to the project directory". HackWin's worktrees lie in a sibling directory, `<repo-parent>/<repo-name>.worktrees/<issue>-<slug>/` (A9, 6.4), outside the project directory of a session started in the main checkout.
  - `/add-dir` and `--add-dir` extend file access, but "It doesn't make that directory a full configuration root". Of that directory's `.claude/settings.json` only `enabledPlugins` and `extraKnownMarketplaces` load, so none of its hooks or permission rules; its `CLAUDE.md` loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. `permissions.additionalDirectories` grants file access only (https://code.claude.com/docs/en/permissions, read 2026-10-10).
  - https://code.claude.com/docs/en/worktrees, read 2026-10-10: the `EnterWorktree` tool can move a session into an existing worktree given its path, with that worktree's settings and `CLAUDE.md`. A path outside `.claude/worktrees/` asks the human for approval, which only `bypassPermissions` skips. Inside a worktree session the target must lie under `.claude/worktrees/`, so a second `/take` in the same session cannot move to the next HackWin worktree. `/cd` moves a session with its settings, but only the human can type it.
  - Not run in a real session (decision 9).
- **Chosen behavior:** the fallback of 5.6: the wrapper prints the terminal command instead. Called inside a session, `take` does steps 1 to 6 and prints the prompt file path and the command that starts Claude Code in the worktree, for a new terminal; the session stays where it is. Reason: moving the session needs a model tool call and a human approval, and it cannot reach the second task of a session; the terminal mode is primary [D18].
- **Tasks:** 1.4c (#10), 1.5b (#16), 1.5c (#17), 1.7c (#28).

### Row 5. GitHub branch protection or rulesets on a public repository of a personal account, including a rule that also binds the repository owner

- **Verdict:** holds.
- **Evidence:**
  - https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets, read 2026-10-10: "Rulesets are available in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud." The page about protected branches says the same for classic protection, whose rules bind administrators only with "Do not allow bypassing the above settings" (`enforce_admins`).
  - E1 on `hackwin-fixture-b` (public, personal account): a ruleset with a PR required, the check `hackwin` required, force pushes and deletion blocked and an empty bypass list was accepted and read back. It refused the owner's `git push` (`GH013: Repository rule violations found ... Changes must be made through a pull request. ... Required status check "hackwin" is expected.`), the owner's commit through the contents API (HTTP 409), and the owner's merges without the `hackwin` status, also with `--admin`.
  - Reading back (E1): `GET /repos/{owner}/{repo}/rulesets/{id}` returns the rules, `bypass_actors` and `current_user_can_bypass`; `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns the rules that apply to a branch, each with its `ruleset_id`. On a branch without classic protection, `GET .../branches/main/protection` answers 404 "Branch not protected" (R).
  - The read back of the pull request rule carried a parameter that was not sent, `require_extra_approval_for_unattributed_changes: true`. Its effect was not examined.
- **Chosen behavior:** the capability: the rules for everyone as a repository ruleset with an empty bypass list (full protection, A32).
- **Tasks:** 1.3e (#7), 1.4f (#13), 1.7b (#27); 1.6a (#20) and 1.6b (#21) through 1.3e.

### Row 6. A rule that lets only the Lead's account update the default branch of a public repository owned by a personal account

- **Verdict:** holds. Questions 1 to 3 were answered by experiment, question 4 by documentation only.
- **1. Does the rule exist for this repository type?** Yes. E1 created, on `hackwin-fixture-b`, a ruleset with the single rule `update` (REST name of "Restrict updates") and the bypass actor `{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}`. GitHub accepted it, and the read back gave `current_user_can_bypass: "always"` for the owner. The sent parameter `update_allows_fetch_and_merge: false` read back as `parameters: null`. Documentation (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets, read 2026-10-10): with "Restrict updates", "only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." In a personal repository the owner is the only admin; collaborators get write access (https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository, read 2026-10-10). The organization admin cannot be a bypass actor there (https://docs.github.com/en/rest/repos/rules, read 2026-10-10).
- **2. Does it also refuse a merge made through the API?** Yes. In E1 the bypass list was emptied, so that the Lead's account stood in for a builder, and PR #2 had a green `hackwin` status. REST `PUT /repos/{owner}/{repo}/pulls/2/merge` with the head SHA answered HTTP 405 "Repository rule violations found ... Cannot update this protected ref." GraphQL `mergePullRequest` through `gh pr merge --admin` gave the same message. A builder's own account was not used here; AC63 tests that through the harness.
- **3. Does the bypass leave the PR and check requirements in force for the Lead?** Yes, with the two sets as separate rulesets. In E1 the Lead was on the bypass list of the update restriction. The rules for everyone still refused the Lead's direct push, commit through the API and merges without the `hackwin` check, also with `--admin` ("Required status check "hackwin" is expected."). Documentation (about-rulesets, read 2026-10-10): rules of rulesets that target the same branch "are aggregated". One side effect: while the update restriction is active, GitHub reports the PR as `BLOCKED` for the Lead too. The same PR was `CLEAN` with that ruleset disabled and `BLOCKED` with it active. So `gh pr merge` without `--admin` is refused by `gh` itself, and with `--admin` and the full head SHA the Lead's merge succeeded (row 14).
- **4. Does the rule exist for a public repository owned by an organization on GitHub Free?** Yes, by documentation only: rulesets are available "in public repositories with GitHub Free and GitHub Free for organizations" (about-rulesets, read 2026-10-10), and an organization's bypass lists also accept teams and organization admins (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository, read 2026-10-10). Not tested: the account belongs to no organization.
- **Chosen behavior:** the capability, as 7.1 step 11 and A32 describe: a ruleset of its own with the rule `update` and the repository admin role (`actor_id` 5) as its only bypass actor, beside the rules for everyone without bypass. The protection state is `full-restricted`. The Gate merges with `--admin` (row 14).
- **Tasks:** 1.3e (#7), 1.4f (#13), 1.6a (#20), 1.6b (#21), 1.6d (#23), 1.7b (#27).

### Row 7. GitHub secret scanning push protection

- **Verdict:** partly holds. It is offered for public repositories, and for private organization repositories only with paid GitHub Secret Protection. GitHub refuses it on a private repository of a personal account, and a pusher can bypass a block.
- **Availability per repository type and plan** (https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security and https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning, read 2026-10-10):

  | Repository | Push protection | Evidence |
  | --- | --- | --- |
  | Public, personal account, any plan | Offered | Documentation; E2 turned it off and on, on `hackwin-fixture-b` |
  | Public, organization, any plan | Offered | Documentation ("Public repository without GitHub Secret Protection": push protection yes) |
  | Private, personal account (Free; Pro per documentation) | Refused | Documentation: secret scanning for user-owned repositories only "on GitHub Enterprise Cloud with Enterprise Managed Users"; E3: HTTP 422 "Secret scanning is not available for this repository." |
  | Private, organization on Free | Refused | Documentation |
  | Private, organization on Team or Enterprise Cloud with GitHub Secret Protection | Offered (paid) | Documentation |

  The default differs between sources. The changelog of 2024-03-11 (https://github.blog/changelog/2024-03-11-secret-scanning-and-push-protection-are-enabled-by-default-on-new-public-repositories/) says new public repositories of personal accounts get push protection on by default. The current page https://docs.github.com/en/code-security/concepts/secret-security/push-protection says repository push protection "Is disabled by default". `hackwin-fixture-b` and `hackwin-sandbox` read back `enabled` before any experiment (R); whether by default or by hand was not recorded.
- **How the Lead's token enables it from the command line:** `gh api -X PATCH repos/<owner>/<repo> --input -` with the body `{"security_and_analysis":{"secret_scanning_push_protection":{"status":"enabled"}}}`. The REST reference (https://docs.github.com/en/rest/repos/repos#update-a-repository, read 2026-10-10) requires admin permission; a fine-grained token needs "Administration" write. In E2 the Lead's `gh` token (scopes `gist`, `read:org`, `repo`) turned it off and on again, each answer and read back as expected.
- **How the setting is read back:** `gh api repos/<owner>/<repo> --jq .security_and_analysis.secret_scanning_push_protection.status` gives `enabled` or `disabled`; the block is returned only to admins. On a repository without the feature `security_and_analysis` is `null` (E3). The answer to the enabling call proves nothing. On `hackwin-fixture-private` the same PATCH answered HTTP 200 with `"secret_scanning_push_protection":{"status":"disabled"}`, and the read back stayed `null`; with `secret_scanning` in the same body it answered 422.
- **Can a pusher bypass a block?** Yes. https://docs.github.com/en/code-security/concepts/secret-security/push-protection, read 2026-10-10: "anyone with write access to the repository can bypass push protection by specifying a bypass reason". https://docs.github.com/en/code-security/how-tos/secure-your-secrets/work-with-leak-prevention/push-protection-on-the-command-line, read 2026-10-10: the pusher opens the URL of the error "as the same user that performed the push", picks a reason, and pushes again "within three hours". Delegated bypass, which limits who may bypass, exists only for organization repositories on GitHub Team with Secret Protection (https://docs.github.com/en/code-security/concepts/secret-security/delegated-bypass). Separately, push protection for users is on by default for each user's pushes to public repositories, and the user can bypass it without a reason or switch it off. Push protection also covers commits made in the web interface and through the REST API (push protection page). Not tested: no secret was pushed.
- **Chosen behavior:** the capability where GitHub offers it: `setup` enables it with the call above and decides on or off from the read back alone. Where the read back is not `enabled`, the fallback of 5.6: HackWin's own scans alone (E6), and `setup` reports push protection as off. 10.6 already names the pusher's bypass.
- **Tasks:** 1.4f (#13), 1.7b (#27); 1.3d (#6) for the fixture of the refusing case.

### Row 8. Pinning an issue from the command line

- **Verdict:** holds.
- **Evidence:**
  - E4: `gh issue pin 3 -R Bartek201301/hackwin-fixture-b` printed "Pinned issue", and GraphQL `repository.pinnedIssues` read back one pinned issue, number 3. `gh issue unpin 3` set the count back to 0.
  - `gh issue pin` exists since gh 2.15.0 (https://github.com/cli/cli/releases/tag/v2.15.0, read 2026-10-10) and calls the GraphQL mutation `pinIssue` (https://docs.github.com/en/graphql/reference/issues, read 2026-10-10).
  - https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository, read 2026-10-10: "You can pin up to three important issues"; "People with write access to a repository can pin issue in the repository."
- **Chosen behavior:** the capability: the Gate pins the status issue with `gh issue pin <N>` at its first start. A repository holds at most three pinned issues.
- **Tasks:** 1.6b (#21).

### Row 9. Editing an issue body sends no notification

- **Verdict:** unknown.
- **Evidence:**
  - The documentation does not say whether a body edit notifies watchers or participants. https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax, read 2026-10-10: "People will also receive a notification if you edit a comment to mention their username or team name." The REST reference https://docs.github.com/en/rest/issues/issues, read 2026-10-10, marks "Create an issue" with "This endpoint triggers notifications" and has no such note on "Update an issue".
  - Not tested: it needs the notifications of a second account, and this task used none.
- **Chosen behavior:** the capability as specified (G25): the Gate edits the body and never comments. The fallback of 5.6, "None needed", changes nothing. The body holds no `@` mention, because a mention added by an edit is documented to notify, at least in a comment.
- **Tasks:** 1.6b (#21).

### Row 10. The largest issue body that GitHub accepts

- **Verdict:** holds, by measurement. GitHub documents no maximum.
- **Evidence:**
  - https://docs.github.com/en/rest/issues/issues, read 2026-10-10, describes `body` only as "The contents of the issue." Community posts quote "Body is too long (maximum is 65536 characters)" (https://github.com/orgs/community/discussions/27190); that limit did not apply in E4.
  - E4, GraphQL `updateIssue`, the call `gh issue edit` makes: 262,144 ASCII characters and 131,072 times "é" (262,144 bytes) were accepted. 262,145 ASCII characters and 131,073 times "é" (262,146 bytes) were refused with "GraphQL: Body is too long (updateIssue)". The limit counts UTF-8 bytes.
  - E4, REST `PATCH /repos/{owner}/{repo}/issues/{n}`: every size tried was accepted and read back whole. These were 65,536, 65,537, 131,072, 262,144, 262,145, 524,288 and 1,048,576 ASCII characters, 65,536 times "é", and 40,000 times U+1F600 (80,000 UTF-16 units). Larger sizes were not tried.
- **Chosen behavior:** the capability: the Gate keeps the body at or below 262,144 UTF-8 bytes, the smaller measured limit, and drops the oldest digest lines of merged PRs first (9.6). Because the limit is undocumented, a refusal with "Body is too long" is handled the same way, as the 5.6 fallback says.
- **Tasks:** 1.6b (#21).

### Row 11. GitHub's limits on write requests

- **Verdict:** partly holds. The limits are documented; whether an issue edit is a "content-generating" request is not.
- **Evidence:**
  - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, read 2026-10-10: the primary limit is 5,000 requests per hour. Secondary limits: no more than 100 concurrent requests and 900 points per minute for REST, where most writes cost 5 points. "In general, no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour are allowed." The limits "are subject to change without notice". The term "content-generating" is not defined.
  - "Create an issue" and "Merge a pull request" carry the note "Creating content too quickly using this endpoint may result in secondary rate limiting"; "Update an issue" and "Add labels to an issue" carry no such note (https://docs.github.com/en/rest/issues/issues, https://docs.github.com/en/rest/issues/labels, read 2026-10-10).
  - https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api, read 2026-10-10: make requests serially, and for many `POST`, `PATCH`, `PUT` or `DELETE` requests "wait at least one second between each request".
  - With `gate.status_issue_seconds` at 120 (6.3) the status issue takes 30 edits per hour, 6 percent of 500, even if edits count.
- **Chosen behavior:** the capability with the defaults of 6.3. The fallback of 5.6 (raise `gate.status_issue_seconds` together with `gate.heartbeat_stale_seconds`) stays a configuration change the Lead can make through a PR; it needs no code.
- **Tasks:** 1.6b (#21), 1.6c (#22), 1.6d (#23).

### Row 12. Inviting a collaborator from the command line with the Lead's token

- **Verdict:** holds, by documentation. No invitation was sent in this task.
- **Evidence:**
  - https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator, read 2026-10-10: `PUT /repos/{owner}/{repo}/collaborators/{username}`. "The invitee will receive a notification that they have been invited to the repository, which they must accept or decline." It answers 201 when it creates an invitation and 204 when the user already is a collaborator. `permission` is "Only valid on organization-owned repositories". "You are limited to sending 50 invitations to a repository per 24 hour period." A fine-grained token needs "Administration" write.
  - The classic scope `repo` covers "repository invitations, collaborators" (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps, read 2026-10-10); the Lead's token has it (R). `gh` has no dedicated command (`gh repo --help`).
  - R: `test-bot-builder` holds `write` on both fixtures after the integrator's invitations of 10 October 2026 (issue #31), and `GET /repos/{owner}/{repo}/invitations` lists no pending invitation. How those invitations were sent was not observed.
- **Chosen behavior:** the capability: `setup` step 10 runs `gh api -X PUT repos/<owner>/<repo>/collaborators/<login>`. A member has write access only after accepting; pending invitations are listed by `GET /repos/{owner}/{repo}/invitations`.
- **Tasks:** 1.4f (#13).

### Row 13. GitHub offers the file under `.github/ISSUE_TEMPLATE/` when an issue is created

- **Verdict:** holds.
- **Evidence:**
  - https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates, read 2026-10-10: "Issue templates are stored on the repository's default branch, in a hidden `.github/ISSUE_TEMPLATE` directory. If you create a template in another branch, it will not be available for collaborators to use." Once on the default branch, "the template will be available for contributors to use when they open new issues" (configuring-issue-templates-for-your-repository).
  - R: on `hackwin-fixture-b` GraphQL `repository.issueTemplates` returns the template "HackWin task" from `.github/ISSUE_TEMPLATE/hackwin-task.md`, whose front matter has `name` and `about`.
  - `gh issue create` in an interactive terminal also offers the templates ("Choose a template", in the gh 2.88.1 source `pkg/cmd/pr/shared/templates.go`), and `--template <name>` picks one (`gh issue create --help`).
- **Chosen behavior:** the capability: the template on the default branch, committed with the bootstrap commit.
- **Tasks:** 1.4d (#11).

### Row 14. `gh pr merge --merge --match-head-commit <full SHA>`

- **Verdict:** holds.
- **Evidence:**
  - `gh pr merge --help` (2.88.1): "--match-head-commit SHA   Commit SHA that the pull request head must match to allow merge"; "--admin   Use administrator privileges to merge a pull request that does not meet requirements". gh calls GraphQL `mergePullRequest` with `expectedHeadOid` ("OID that the pull request head ref must match to allow merge", https://docs.github.com/en/graphql/reference/pulls, read 2026-10-10).
  - E1: a wrong full SHA gave "Head branch was modified. Review and try the merge again." A 7 character SHA gave "Could not coerce value "d5914a8" to GitObjectID". The full SHA merged PR #1 (merge commit `e62e06665b94273bcb74893e241f6f9cf3837f78`).
  - E1, with the update restriction active: without `--admin`, `gh` refused before any API call with "Pull request ... is not mergeable: the base branch policy prohibits the merge." and exit 1, although every check was green and the Lead was on the bypass list. GitHub reported the PR as `BLOCKED` while that ruleset was active and `CLEAN` while it was disabled. With `--admin` the Lead's merge passed the update restriction. `--admin` lifted no rule of the rules for everyone: without the `hackwin` status the merge was still refused.
- **Chosen behavior:** the capability: `gh pr merge <PR> --merge --match-head-commit <full SHA>`, with `--admin` added in the protection state `full-restricted`.
- **Tasks:** 1.6d (#23), 1.7a (#26), 1.7b (#27).

### Row 15. `git merge-tree --write-tree` (git 2.38 or later)

- **Verdict:** holds.
- **Evidence:**
  - https://git-scm.com/docs/git-merge-tree, read 2026-10-10: "For a successful, non-conflicted merge, the exit status is 0. When the merge has conflicts, the exit status is 1." Also: "Do NOT interpret an empty Conflicted file info list as a clean merge; check the exit status." The release notes of git 2.38.0 introduce the mode: "git merge-tree" "learned a new mode where it takes two commits and computes a tree that would result in the merge commit" (https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.38.0.adoc, read 2026-10-10).
  - L1 with git 2.53.0: a clean merge printed the tree OID and exited 0. A conflict printed the tree OID, three stage lines for `f.txt` and "CONFLICT (content): Merge conflict in f.txt", and exited 1. `--name-only` printed `f.txt` and exited 1. The working tree stayed unchanged.
- **Chosen behavior:** the capability; `join` fails on git older than 2.38.
- **Tasks:** 1.4e (#12), 1.6c (#22, stage 6).

### Row 16. Rerunning the failed jobs of a CI run from the command line

- **Verdict:** holds, by documentation. Not run: the fixtures had no failed run.
- **Evidence:**
  - `gh run rerun --help` (2.88.1): "--failed   Rerun only failed jobs, including dependencies".
  - https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run, read 2026-10-10: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`; classic tokens need the `repo` scope.
  - https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs, read 2026-10-10: a run can be rerun "up to 30 days after its initial run", at most 50 times, with the original `GITHUB_SHA` and `GITHUB_REF`.
- **Chosen behavior:** the capability: `gh run rerun <run-id> --failed`.
- **Tasks:** 1.6d (#23, G14).

### Row 17. A command that keeps the laptop awake while a process runs, per operating system

- **Verdict:** partly holds. It holds on macOS by experiment and on Linux by documentation. Nothing built in exists on Windows through WSL.
- **Evidence:**
  - macOS: `man caffeinate`: `-i` "Create an assertion to prevent the system from idle sleeping."; `-w` "Waits for the process with the specified pid to exit. Once the the process exits, the assertion is also released." `man pmset`: `-g assertions` "displays a summary of power assertions". L2: `caffeinate -i -w <pid>` showed in `pmset -g assertions` as `PreventUserIdleSystemSleep named: "caffeinate command-line tool"`. When the watched process ended, caffeinate exited 0 and the assertion was gone.
  - Linux: `systemd-inhibit --what=idle:sleep --why=<text> --mode=block <command>` "may be used to execute a program with a shutdown, sleep, or idle inhibitor lock taken", and `systemd-inhibit --list` lists the locks (https://raw.githubusercontent.com/systemd/systemd/main/man/systemd-inhibit.xml, read 2026-10-10). It needs systemd-logind. The default polkit policy allows the sleep and idle locks for active local sessions (`allow_active yes`, https://raw.githubusercontent.com/systemd/systemd/main/src/login/org.freedesktop.login1.policy, read 2026-10-10); distributions may change that. Not tested: no Linux machine.
  - Windows through WSL: no built-in command, and no Microsoft documentation for doing this from WSL. The building blocks are WSL interop (https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop) and `SetThreadExecutionState` (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate), both read 2026-10-10, but they are not documented together. PowerToys Awake is not part of Windows. Not tested.
- **Chosen behavior:** the capability on macOS (`caffeinate -i -w <Gate pid>`) and on Linux (`systemd-inhibit` as above). On Windows through WSL, and wherever the command is missing or fails, the fallback of 5.6: the Gate prints a warning that it cannot prevent sleep.
- **Tasks:** 1.6a (#20).

### Row 18. An operating system notification raised by a terminal process (macOS, Linux, Windows through WSL)

- **Verdict:** partly holds. It holds on macOS and on Linux with a notification server, by documentation; on macOS the command also succeeded. Nothing built in exists on Windows through WSL.
- **Evidence:**
  - macOS: `display notification` of Standard Additions (https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html, read 2026-10-10): "Notifications are shown as alerts or banners, depending on the user's settings". L3: `osascript -e 'display notification "<text>" with title "HackWin verification"'` exited 0. Whether the notification appeared on screen is not confirmed: the human was not watching.
  - Linux: `notify-send {summary} [body]` sends "desktop notifications to the user via a notification daemon" (https://manpages.ubuntu.com/manpages/noble/man1/notify-send.1.html, read 2026-10-10). It needs a notification server on the session bus (Desktop Notifications Specification, https://specifications.freedesktop.org/notification/latest/basic-design.html). Not tested.
  - Windows through WSL: no built-in, documented path from WSL. Windows' `ToastNotificationManager` requires a desktop app with a Start shortcut and an AppUserModelID (https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager, read 2026-10-10). `wsl-notify-send` and BurntToast are third-party tools. Not tested.
- **Chosen behavior:** the capability on macOS (`osascript -e 'display notification ...'`) and on Linux (`notify-send` when present and successful). On Windows through WSL, and wherever the command is missing or fails, the fallback of 5.6: the Gate rings the terminal bell in its own terminal.
- **Tasks:** 1.6c (#22, G26, AC79).

### Row A. Added by the plan, not part of 5.6: the command that starts Codex in a given directory with a prompt

- **Verdict:** holds, by documentation. Not run: Codex is not installed on this machine.
- **Evidence:**
  - https://developers.openai.com/codex/cli/reference redirects (HTTP 308) to https://learn.chatgpt.com/docs/developer-commands?surface=cli, read 2026-10-10. PROMPT: "Optional text instruction to start the session"; `--cd, -C`: "Set the working directory for the agent before it starts processing your request." Running `codex` without a subcommand starts the interactive terminal UI.
  - https://learn.chatgpt.com/docs/agent-configuration/agents-md, read 2026-10-10, shows the form `codex --cd subdir --ask-for-approval never "Show which instruction files are active."` and says "Codex reads `AGENTS.md` files before doing any work", from the project root down to the working directory.
  - https://learn.chatgpt.com/docs/agent-approvals-security, read 2026-10-10: Codex may start read-only "until you explicitly trust the working directory". A new worktree is a new directory.
  - The prompt is one argument, so the limits of row 3 apply. The interactive form documents no way to read the prompt from a file or stdin; `codex exec` does, but it is the non-interactive mode.
- **Chosen behavior:** the capability: for a member whose agent is `codex`, `take` prints the prompt file path and the command `codex --cd <absolute worktree path> "$(cat <absolute prompt file path>)"` (I10, AC72).
- **Tasks:** 1.5b (#16).

## 4. Open questions

Each is left open because it was neither documented nor observed.

1. Row 9: does an edit of an issue body notify watchers? Answering it needs the notifications of a second account.
2. Row 10: the REST limit for an issue body above 1,048,576 characters was not probed.
3. Row 7: is push protection on by default for a new public repository of a personal account? The changelog and the current page differ, and the origin of the `enabled` state on the fixtures was not recorded.
4. Row 5: what does `require_extra_approval_for_unattributed_changes: true` do? GitHub added it to the pull request rule on its own.
5. Row 6: a merge through REST by the Lead as bypass actor was not tried; only GraphQL with `--admin` was.
6. Row 18: did the macOS notification of L3 appear on screen?
7. Row 2: does a `*` at the end of a deny pattern also match empty text?
8. Rows 17 and 18 on Linux and WSL, row 6 question 4 (no organization), row 16 (no failed run) and row A (no Codex) were not tested.

## 5. Cases in which GitHub must refuse

| Criterion | Refusing case | Can a real repository produce it? | Decision |
| --- | --- | --- | --- |
| AC2 | GitHub refuses any branch protection | Yes. On `hackwin-fixture-private` (private, personal account without Pro), listing and creating rulesets and reading classic protection all answer 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." (E3, R) | Real repository: `hackwin-fixture-private`, while the owner account stays without Pro |
| AC70 | GitHub accepts the rules for everyone but refuses the update restriction | No. On a public personal repository GitHub accepted the update restriction with the admin role as bypass (E1). The documentation offers rulesets, with all their branch rules, on every repository type that offers the rules for everyone, and the private fixture refuses both | Tested against the fake GitHub |
| AC80 | GitHub refuses push protection | Yes. On `hackwin-fixture-private` enabling secret scanning answers 422 "Secret scanning is not available for this repository.", and enabling push protection alone answers 200 while the read back stays `null` (E3) | Real repository: `hackwin-fixture-private`. A fake GitHub for this case would have to give both answers, including the 200 that enables nothing |

## 6. Experiment log

`<B>` is `Bartek201301/hackwin-fixture-b`, `<P>` is `Bartek201301/hackwin-fixture-private`. All GitHub calls ran as `Bartek201301` through `gh` 2.88.1. No token was printed.

### R. Read-only calls, 2026-10-10

- `gh api -i user`: header `X-Oauth-Scopes: gist, read:org, repo`. `gh api user`: `plan` is `null`. `gh api user/orgs`: empty.
- `<B>`: `GET rulesets` gave `[]`; `GET branches/main/protection` gave 404 "Branch not protected"; `security_and_analysis` showed secret scanning and push protection `enabled`. Collaborators were `Bartek201301` (admin) and `test-bot-builder` (write), with no pending invitation. GraphQL `issueTemplates` returned "HackWin task".
- `<P>`: `GET rulesets` and `GET branches/main/protection` both gave 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."; `security_and_analysis` was `null`. Collaborators were the same as on `<B>`.
- `Bartek201301/hackwin-sandbox`: `security_and_analysis` showed secret scanning and push protection `enabled`. Nothing else was read or changed.

### E1. Rulesets and the update restriction on `<B>`, 23:44 to 23:47 UTC

Setup. Branches `verify-1-2-base`, `verify-1-2-a` and `verify-1-2-b` at `bf2af03` (`gh api -X POST repos/<B>/git/refs`). One commit each on `-a` (`d5914a8d5ae9520656bb079a154bbd1febdfe574`) and `-b` (`7cdf2aaca27e5d2056240cb475eb080a77569195`) through the contents API. PR #1 (`-a`) and PR #2 (`-b`) into `verify-1-2-base`. `main` was never a target. Two rulesets on `refs/heads/verify-1-2-base`, created with `gh api -X POST repos/<B>/rulesets --input <file>`:

- R1, "rules for everyone", id 24858776: `pull_request` (0 approvals), `required_status_checks` with context `hackwin`, `non_fast_forward`, `deletion`; `bypass_actors: []`.
- R2, "update restriction", id 24858777: `update`; `bypass_actors: [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]`.

| Step | Command | Result |
| --- | --- | --- |
| T0 | `gh api repos/<B>/rulesets/<id>`; `gh api repos/<B>/rules/branches/verify-1-2-base` | R1: `current_user_can_bypass: "never"`; R2: `"always"`. Branch rules: the four of R1 and `update` of R2, each with its `ruleset_id` |
| T1 | `git push origin HEAD:verify-1-2-base` (an empty commit, as the owner) | Rejected: `GH013: Repository rule violations found for refs/heads/verify-1-2-base.`, "Changes must be made through a pull request.", "Required status check "hackwin" is expected." |
| T1b | `gh api -X PUT repos/<B>/contents/verify-1-2/direct.txt ... -f branch=verify-1-2-base` | HTTP 409 with the same two rules |
| T2 | `gh pr merge 1 -R <B> --merge --match-head-commit <full SHA>` without a `hackwin` status | "X Pull request ... is not mergeable: the base branch policy prohibits the merge.", exit 1 |
| T2b | The same with `--admin` | "GraphQL: Repository rule violations found ... Required status check "hackwin" is expected. (mergePullRequest)", exit 1 |
| T2c | `gh api -X PUT repos/<B>/pulls/1/merge -f merge_method=merge -f sha=<full SHA>` | HTTP 405 "Repository rule violations found ... Required status check "hackwin" is expected." |
| T3 | `gh api -X POST repos/<B>/statuses/<SHA of PR #1> -f state=success -f context=hackwin` | Status created. The PR then showed rollup `SUCCESS` (`check` run and `hackwin` status), `mergeable: MERGEABLE`, `mergeStateStatus: BLOCKED` |
| T3b | R2 set to `enforcement: disabled`, then back to `active` (`gh api -X PUT repos/<B>/rulesets/24858777 -f enforcement=...`) | `mergeStateStatus` `CLEAN` while disabled, `BLOCKED` while active |
| T4 | `gh pr merge 1 ... --match-head-commit bf2af037ab756d7051e35bdd7e3f18c92eda45b5` (a wrong full SHA), without and with `--admin` | Without: the refusal of T2. With: "GraphQL: Head branch was modified. Review and try the merge again." |
| T5 | `gh pr merge 1 ... --admin --match-head-commit d5914a8` | "Variable $input of type MergePullRequestInput! was provided invalid value for expectedHeadOid (Could not coerce value "d5914a8" to GitObjectID)" |
| T6 | `gh pr merge 1 -R <B> --merge --admin --match-head-commit <full SHA>` | Exit 0; PR #1 merged at 23:45:52 by `Bartek201301`, merge commit `e62e06665b94273bcb74893e241f6f9cf3837f78` |
| T7 | R2 updated to `bypass_actors: []` (`current_user_can_bypass: "never"`); `hackwin` success set on the head of PR #2 | Setup for the next three calls |
| T7a | `gh api -X PUT repos/<B>/pulls/2/merge -f merge_method=merge -f sha=<full SHA>` | HTTP 405 "Repository rule violations found ... Cannot update this protected ref." |
| T7b | `gh pr merge 2 -R <B> --merge --admin --match-head-commit <full SHA>` | "GraphQL: Repository rule violations found ... Cannot update this protected ref. (mergePullRequest)" |
| T7c | The same without `--admin` | The refusal of T2 |

Undone at 23:46. PR #2 closed with a comment. R1 and R2 deleted. The three branches deleted. Read back: `GET rulesets` gave 0; the only branch is `main` at `bf2af03`. GitHub keeps what cannot be removed: PR #1 merged into the deleted branch, PR #2 closed, the commit statuses on the two unreachable commits, and the runs of the fixture's `check` workflow on both PRs.

### E2. Push protection on `<B>`, 23:46 UTC

| Step | Command | Result |
| --- | --- | --- |
| 1 | `gh api repos/<B> --jq .security_and_analysis...` | `secret_scanning=enabled`, `push_protection=enabled` |
| 2 | `gh api -X PATCH repos/<B> --input -` with `{"security_and_analysis":{"secret_scanning_push_protection":{"status":"disabled"}}}` | Exit 0; read back `disabled` |
| 3 | The same with `"enabled"` | Exit 0; read back `enabled` |

Undone: the end state equals the start state, `enabled`.

### E3. Refusals on `<P>`, 23:46 UTC

| Step | Command | Result |
| --- | --- | --- |
| 1 | `gh api -X PATCH repos/<P> --input -` with `secret_scanning` and `secret_scanning_push_protection` both `enabled` | HTTP 422 "Secret scanning is not available for this repository." |
| 2 | The same with `secret_scanning_push_protection` alone | HTTP 200; the answer's `security_and_analysis` showed every feature `disabled`. Read back: `security_and_analysis` is `null` |
| 3 | `gh api -X POST repos/<P>/rulesets --input <R1 file>` | HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." |
| 4 | `gh api repos/<P>/rulesets` | HTTP 403, the same message |

Nothing changed: the read back stayed `null`, no ruleset exists, and `main` is `bf2af03`.

### E4. Pinning and body size on `<B>`, issue #3, 23:46:49 to 23:48:48 UTC

| Step | Command | Result |
| --- | --- | --- |
| 1 | `gh issue create -R <B> --title "Experiment of task 1.2: pinning and body size" ...` | Issue #3 |
| 2 | `gh issue pin 3 -R <B>`, then GraphQL `pinnedIssues` | "Pinned issue"; one pinned issue, #3 |
| 3 | `gh issue unpin 3 -R <B>`, then GraphQL `pinnedIssues` | "Unpinned issue"; count 0 |
| 4 | `gh api -X PATCH repos/<B>/issues/3 --input <json>` with bodies of 65,536, 65,537, 131,072, 262,144, 262,145, 524,288 and 1,048,576 ASCII characters, 65,536 times "é" and 40,000 times U+1F600 | Each accepted; each read back at full length |
| 5 | `gh issue edit 3 -R <B> --body-file <file>` with 65,537 ASCII characters | Accepted |
| 6 | The same with 1,048,576 ASCII characters | "GraphQL: Body is too long (updateIssue)" |
| 7 | Bisection with `gh issue edit` between 65,537 and 1,048,576 ASCII characters (14 edits), then 262,144 and 262,145 | Largest accepted 262,144; smallest refused 262,145 |
| 8 | `gh issue edit` with 131,073 times "é" (262,146 bytes), then 131,072 times "é" (262,144 bytes) | Refused ("Body is too long"), then accepted |
| 9 | `gh issue edit 3 -R <B> --body "<one line>"`; `gh issue close 3 -R <B> --reason "not planned"` | Body reset; issue closed |

Undone: the issue is unpinned, its body is one line again, and it is closed; GitHub keeps the issue.

### L. Local experiments, 2026-10-10

- **L1** (row 15): a scratch repository in the session's scratchpad with branches `x` and `y` changing the same line of `f.txt`, and `main` adding `g.txt`. `git merge-tree --write-tree main x` printed one tree OID and exited 0. `git merge-tree --write-tree x y` printed the tree OID, the stage 1, 2 and 3 lines of `f.txt`, and "CONFLICT (content): Merge conflict in f.txt", and exited 1. With `--name-only` it printed `f.txt` and exited 1. `git status --short` stayed empty.
- **L2** (row 17): `tail -f /dev/null &` as the watched process, then `caffeinate -i -w <its pid> &`. `pmset -g assertions` listed `pid <caffeinate pid>(caffeinate): ... PreventUserIdleSystemSleep named: "caffeinate command-line tool"`. After the watched process was killed, `caffeinate` exited 0 and its assertion was gone.
- **L3** (row 18): `osascript -e 'display notification "HackWin 1.2 test notification: ..." with title "HackWin verification"'` exited 0. The human could not say whether it appeared.
