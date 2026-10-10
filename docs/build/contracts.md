# HackWin build contracts: Phase 1

| Field | Value |
| --- | --- |
| Written by | Task 1.3a (#3), the foundation |
| Specification | `docs/HackWin-build-phase-0-1.md` (the brief), under the authority of `docs/HackWin-PRD.md` |
| Plan | `docs/build/plan.md`; section 3 lists the interfaces this file fixes |
| Changes | After task 1.3a is merged, the interfaces and formats below change only through an integrator task (P8) |

This file fixes the tooling, the command registry, the command module contract, the caller kind, the test id convention, the interface of every shared module of plan section 3, the data formats that more than one lane reads or writes, and the decisions of plan section 9 that other tasks build on. Section 4 marks which task implements each module. A lane that needs an interface or a format that is missing here stops and asks the integrator.

## 1. Tooling

| Item | Choice |
| --- | --- |
| Language | JavaScript as ES modules (`"type": "module"`), with types written as JSDoc comments. No build step: the tests and the installed package run the source files |
| Node | 22 or later (`engines` in `package.json`, `.nvmrc`). CI runs Node 22 and 24 |
| Type check | TypeScript 5.9 checks `bin/` and `src/` (`tsc`, `checkJs`, `strict` except `noImplicitAny` and `useUnknownInCatchVariables`, no output) as the first step of `npm test`. Tests are not type checked. Shared types are imported with `/** @import { CommandContext } from '../../cli/context.js' */` |
| Test runner | Vitest 4.1 |
| Formatter | Prettier 3.9, configured in `.prettierrc.json`: no semicolons, single quotes, line width 100. Markdown is not formatted (`.prettierignore`), so the documents keep their compact tables |
| Package | Name `hackwin`; binary `hackwin` is `bin/hackwin.js`, which only calls `src/cli/main.js`; the package ships `bin/` and `src/` |

Dependencies, with exact versions in `package.json`. A lane that needs another one asks the integrator.

| Package | For |
| --- | --- |
| `yaml` | `hackwin.yml`, `owners.yml`, task blocks, answers files (CM11), `local.yml`, the status issue block |
| `picomatch` | Path globs: `owners.yml`, the `paths` groups of `hackwin.yml`, the allowed paths of a task |
| `semver` | The version check (CM12) |
| `vitest`, `typescript`, `prettier`, `@types/node`, `@types/picomatch`, `@types/semver` | Development only |

## 2. npm scripts and tests

| Command | What it does |
| --- | --- |
| `npm test` | The type check, then the full offline suite: every `test/**/*.test.js` except `*.fixture.test.js`. CI runs exactly this |
| `npm run test:ac -- <id>...` | The tests with these ids (section 2.2), the tests on fixture repositories included. It prints how many tests of each id passed and failed, and fails when a test fails or when an id has no test that ran. Without an id it fails |
| `npm run format -- <file>...` | `prettier --write` on the named files only |
| `npm run typecheck` | The type check alone |

### 2.1 Test files

- A test file is `*.test.js` under the test directory of its owner (plan section 2). Vitest finds it by glob; no lane edits a shared index.
- A test that runs on a fixture repository (section 6.4) is `*.fixture.test.js`. `npm test` and CI leave it out; `npm run test:ac` runs it, and it fails, not skips, when the fixture repository or the credential is missing (task 1.3d).
- `test/harness/setup.js` (task 1.3d) is loaded before every test file once it exists. `vitest.config.js` already names it.
- Tests reach GitHub accounts only through the test harness.

### 2.2 Test ids

A test's name, or the name of its outermost `describe` block, starts with its id and a colon: `test('1.3a/registry: an unknown command exits 2', ...)`. The id of a test is the text before the first colon of its full name (its `describe` names and its own name). The forms are:

| Form | Use |
| --- | --- |
| `AC<n>` | A whole acceptance criterion of section 14, for example `AC11` |
| `AC<n>/<part>` | The part of a criterion that one task delivers, for example `AC54/hooks` |
| `<step>/<topic>` | Any other test of a task, for example `1.3a/registry` |

`npm run test:ac -- X` runs every test whose id is `X` or starts with `X/`: `AC54` also runs `AC54/hooks` and `AC54/ci`. A test without an id runs only in `npm test`. A task names the ids of its acceptance tests in its issue.

These ids are a convention of this build. In the product, every `acceptance_tests` entry of a task block is a file path, and an entry that is not an existing file fails (plan section 9, decision 8).

## 3. The CLI

### 3.1 Command registry

`src/cli/registry.js` maps every command to a fixed entry module in its owner's directory. The runner loads a module only when its command runs. A lane adds its command by creating the module; no lane edits the registry. A new command, flag or hook changes the registry and is an integrator task.

| Command | Entry module | Owner | Arguments and flags |
| --- | --- | --- | --- |
| `setup` | `src/commands/setup/index.js` | lane-a | `--resume`, `--regenerate`, `--answers <file>` |
| `join` | `src/commands/join/index.js` | lane-a | `--answers <file>` |
| `take` | `src/commands/take/index.js` | lane-b | `[N]`, `--release` |
| `ship` | `src/commands/ship/index.js` | lane-b | none |
| `status` | `src/commands/status/index.js` | lane-c | none |
| `gate` | `src/commands/gate/index.js` | lane-c | none |
| `internal hook pre-commit` | `src/internal/hook/pre-commit.js` | lane-a | none |
| `internal hook pre-push` | `src/internal/hook/pre-push.js` | lane-a | `<remote> <url>` as git passes them; the ref lines on stdin |
| `internal hook session-start` | `src/internal/hook/session-start.js` | lane-a | none; the hook event as JSON on stdin |
| `internal hook pre-tool-use` | `src/internal/hook/pre-tool-use.js` | lane-a | none; the hook event as JSON on stdin |
| `internal hook post-tool-use` | `src/internal/hook/post-tool-use.js` | lane-a | none; the hook event as JSON on stdin |
| `internal ci` | `src/internal/ci/index.js` | lane-a | none |

- Global flags, accepted by every command anywhere before `--`: `--json`, `--help` (also `-h`), `--version`.
- `hackwin --help` lists exactly the six commands of Phase 1 (AC67) and never the plumbing namespace `hackwin internal` (A10). `hackwin <command> --help` prints the command's usage from the registry without loading its module.
- A command whose module does not exist yet exits 2 with `hackwin <command>: not built yet: <module> does not exist`. A module without a `run` export exits 2 as well.
- An unknown command, hook or flag, a missing hook name and too many positional arguments exit 2. `take N` is checked for being a number by `take` itself.

### 3.2 Command module contract

Every entry module exports one function:

```js
/** @import { CommandContext, CommandResult } from '../../cli/context.js' */

/**
 * @param {CommandContext} ctx
 * @returns {Promise<CommandResult | void>}
 */
export async function run(ctx) {}
```

It returns a result or throws a typed error (section 3.4). It never calls `process.exit`, never writes to `process.stdout` or `process.stderr` itself (it uses `ctx.out`; a child process such as the agent that `take` starts may inherit the terminal), reads the time only through `ctx.clock`, and runs git and gh only through `ctx.git`, `ctx.github` or the modules of section 4.

**The context** (`CommandContext`, `src/cli/context.js`):

| Field | Type | Content |
| --- | --- | --- |
| `command` | string | The command name, for example `take` or `internal hook pre-push` |
| `args` | string[] | The positional arguments after the command name |
| `flags` | object | The command's own flags, parsed: `{ release: true }`, `{ answers: 'answers.yml' }` |
| `json` | boolean | `--json` was given |
| `cwd` | string | The directory the command started in |
| `repoRoot` | string | The top-level directory of the current checkout or worktree. Outside a git checkout every command exits 2 before its module loads |
| `gitCommonDir` | string | The absolute git common directory; local state lives in `<gitCommonDir>/hackwin/` (section 5) |
| `out` | `Output` | Output lines and warnings (section 3.3) |
| `clock` | `Clock` | `now()` and `sleep(ms)` |
| `caller` | `CallerKind` | `terminal`, `claude-code` or `non-interactive` (section 3.5) |
| `env` | object | The environment |
| `git` | `Git` | Git, run in `repoRoot` (section 4.2) |
| `github` | `GitHub` | GitHub through gh, for the repository of the remote `origin` (section 4.3) |
| `version` | string | The version of the running CLI |
| `stdin` | stream | Interactive input (CM11, the Gate's typed commands) |
| `readStdin()` | `Promise<string>` | All of stdin, read once; empty when stdin is a terminal |
| `config` | `Config` | From task 1.3b: `hackwin.yml` and `owners.yml` from `origin/main` (section 4.4). Absent for `setup` on an unconfigured repository |
| `identity` | `Identity` | From task 1.3b: the caller's login and team member (section 4.4). Absent where `config` is |

**The result** (`CommandResult`):

| Field | Type | Content |
| --- | --- | --- |
| `exitCode` | 0 or 1 | 0 by default. 1 when the command finished but a check failed, as `join` does after its checklist. Exit codes 2 and 3 are always thrown errors |
| `lines` | string[] | The short output (CM6), printed one per line without `--json` |
| `data` | any | The full machine readable result, printed with `--json` |

### 3.3 Output

- Short by default (CM6): the runner prints `result.lines` on stdout. With `--json` stdout carries exactly one JSON document:

  ```json
  { "command": "take", "ok": true, "exitCode": 0, "lines": ["..."], "data": {}, "warnings": [] }
  { "command": "take", "ok": false, "exitCode": 1, "error": { "kind": "blocked", "message": "...", "rule": "...", "objects": ["..."], "resolve": { "command": "...", "dir": "..." } }, "warnings": [] }
  ```

  `command` is null when the command line itself is wrong. The fields of `error` are those of section 3.4.
- `ctx.out.line(text)` prints a progress or report line while the command runs: on stdout, or on stderr with `--json`. `ctx.out.write(text)` prints raw text on the same stream, for a question. `ctx.out.warn(text)` prints `warning: <text>` on stderr and adds the text to `warnings`.
- The runner prints an error on stderr as `hackwin <command>: <message>`, followed by indented lines: for a block the rule, one line per object and `to resolve: ...`; for a configuration error the key; for a remote error the last lines of gh's or git's output; and `to resolve: ...` whenever the error has one. An unexpected error prints `internal error: <message>`; with `HACKWIN_DEBUG=1` also its stack.
- CM4: every message that tells someone to run something names the directory. `runIn(command, dir)` returns ``run `<command>` in <dir>`` and refuses an empty directory. An error's `resolve` is either `{ command, dir }` or a plain instruction that names no command, such as "ask the Lead to add you to `hackwin.yml`". `dir` is an absolute path, or "any directory" when the place does not matter.
- CM5: a `BlockedError` cannot be created without the rule, at least one file or object, and `resolve`.

### 3.4 Exit codes and error types

All in `src/core/runtime/errors.js`. The runner maps each to its exit code of CM2.

| Error | Exit | `kind` | When | Extra fields |
| --- | --- | --- | --- | --- |
| (none) | 0 | | Success | |
| `BlockedError` | 1 | `blocked` | A rule or check blocked the action | `rule`, `objects`, `resolve` (all required) |
| `ConfigError` | 2 | `config` | `hackwin.yml` or `owners.yml` breaks a rule | `key`, dotted, for example `team.members` |
| `PreconditionError` | 2 | `precondition` | A precondition does not hold: `join` not completed, wrong directory, git too old, gh not logged in | `resolve` |
| `UsageError` | 2 | `usage` | Unknown command, hook or flag; too many arguments | |
| `NotBuiltError` | 2 | `not-built` | The command's module does not exist yet | `details.command`, `details.module` |
| `GitError` | 2 | `git` | A local git command failed | `details.args`, `details.code`, `details.tail` |
| `RemoteError` | 3 | `remote` | GitHub or the network failed: a gh call, a fetch, a push | `status` (HTTP status or none), `details.tail` |
| Any other error | 2 | `internal` | A bug in hackwin | |

Every error has `message`, `exitCode`, `kind` and optional `resolve` and `details`, and `toJSON()` gives its JSON form. `exitCodeOf(error)` returns the exit code of any thrown value. A command that finishes with a failed check returns `exitCode: 1` instead of throwing (section 3.2).

### 3.5 Caller kind

`detectCallerKind({ env, stdinIsTTY, stdoutIsTTY })` in `src/core/runtime/caller.js`, available as `ctx.caller`:

| Kind | When | Used by |
| --- | --- | --- |
| `claude-code` | `HACKWIN_CALLER=claude-code` is set. The command wrappers of task 1.4c set it | `take` prints the prompt for the running session (A12); `gate` starts nothing and prints the instruction to run `hackwin gate` in a separate terminal (AC58) |
| `terminal` | Otherwise, when stdin and stdout are both terminals | `take` starts the agent; `gate` runs |
| `non-interactive` | Otherwise: hooks, CI, scripts, tests | `gate` refuses to start; questions come from `--answers <file>` (CM11) |

Any other value of `HACKWIN_CALLER` is ignored.

### 3.6 What the runner does

1. Parse the command line. A wrong command line exits 2.
2. `--version` prints the version; `--help` prints the help. Both exit 0.
3. Build the context: the top-level directory (outside a git checkout: exit 2), the git common directory, and the GitHub repository from the URL of `origin` (`owner/name`, passed to gh as `GH_REPO`; none for a local remote).
4. Prepare the context (`prepareContext` in `src/cli/main.js`, filled by task 1.3b): fetch and read `hackwin.yml` and `owners.yml` from `origin/main` (CM9, A17) and validate them (exit 2 naming the key); the version check (CM12); the caller's identity (5.4); the fast-forward of the main checkout (CM10). `setup` on a repository without `hackwin.yml` on `origin/main` skips this step.
5. Load the command's module, run it, print the result or the error, and return the exit code.

`main(argv, options)` takes the process from `options` where given (`cwd`, `env`, `stdin`, `stdout`, `stderr`, `clock`, `ghExecutor`, `moduleRoot`), so tests run commands in-process.

## 4. Shared modules

Each module is imported from its `index.js`, for example `src/core/git/index.js`. Errors are those of section 3.4. A module of task 1.3a exists with this interface; the others are fixed here and built by the named task.

### 4.1 `src/core/runtime` (1.3a)

| Export | Inputs | Output and errors |
| --- | --- | --- |
| `EXIT` | | `{ OK: 0, BLOCKED: 1, PRECONDITION: 2, REMOTE: 3 }` |
| Error classes, `exitCodeOf` | | Section 3.4 |
| `createOutput` | `{ stdout, stderr, json }` | `Output`: `line`, `write`, `warn`, `warnings`, `json` |
| `runIn` | `command`, `dir` | `` run `<command>` in <dir> ``; TypeError without a directory |
| `formatResolve`, `formatError` | a `resolve`; an error and `{ command, stack }` | The text the runner prints |
| `exec` | `file`, `args`, `ExecOptions` | `ExecResult`. Never rejects for a non-zero exit; a missing program or directory is a `PreconditionError` |
| `execShell` | `commandLine`, `ExecOptions` | As `exec`, through `sh -c`, for the commands of `hackwin.yml` |
| `quoteShellArg` | `arg` | The argument quoted for a POSIX shell, for appending files to a command |
| `systemClock`, `createFakeClock` | a start time for the fake | `Clock`: `now()`, `sleep(ms)`; the fake also has `advance(ms)` and `set(time)`, and its `sleep` returns at once |
| `detectCallerKind`, `CALLER_ENV` | section 3.5 | |

`ExecOptions`: `cwd`; `env` (the whole environment, `process.env` by default); `input` (stdin text); `timeoutMs` (then the child's process group gets SIGTERM, and SIGKILL 5 seconds later); `tailLines` (20 by default); `logFile` (receives the whole output). `ExecResult`: `code` (null after a signal), `signal`, `stdout`, `stderr`, `tail` (the last lines of both streams in arrival order), `timedOut`, `durationMs`.

### 4.2 `src/core/git` (1.3a)

All repository access goes through git (CM7). `createGit({ cwd, env, hooksOff, timeoutMs })` returns a `Git`; `git.with({ ... })` returns a copy with other options, for example another worktree. `hooksOff: true` runs every command with the member hooks switched off (10.3, for the Gate). Every command runs with `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`.

| Method | Output | Errors |
| --- | --- | --- |
| `run(args, { input, allowFailure, timeoutMs })` | `ExecResult` | `GitError` on a non-zero exit unless `allowFailure`. The way to make a call that has no helper |
| `version()`, `requireMergeTree()` | `{ major, minor, patch, text }`; nothing | `PreconditionError` from `requireMergeTree` when git is older than 2.38 |
| `topLevel()` | Top-level directory of the checkout or worktree | `PreconditionError` outside a checkout |
| `commonDir()` | Absolute git common directory | |
| `revParse(rev)`, `tryRevParse(rev)` | Full commit SHA; `tryRevParse` gives null when it does not exist | `GitError` from `revParse` |
| `showFile(ref, path)` | The file's content at the ref, or null when the file does not exist there | `GitError` when the ref does not exist |
| `fetch({ remote, refspecs, prune })` | | `RemoteError` (exit 3) |
| `push({ refspecs, remote, setUpstream })` | Never forces | `RemoteError` (exit 3), also when a hook or the remote refuses; the tail holds git's reason |
| `remoteUrl(remote)` | URL, or null when the remote does not exist | |
| `currentBranch()` | Branch name, or null when detached | |
| `isClean()` | True without changes and untracked files | |
| `isAncestor(a, b)`, `mergeBase(a, b)` | Boolean; SHA or null | |
| `changedFiles(range)` | `[{ status, path, oldPath }]`, status one letter of `git diff --name-status` | |
| `addedLines(range)` | `[{ path, line, text }]`: the added lines with their line numbers in the new file | |
| `mergeTree(ours, theirs)` | `{ clean, tree, conflicts }`, without touching any checkout | `PreconditionError` before git 2.38; `GitError` for a bad ref |
| `merge(ref, { ffOnly, noFastForward, message })` | `{ status, conflicts, head, message }`; status `up-to-date`, `fast-forward`, `merged`, `conflict` (the merge stays in progress) or `not-possible` (a refused fast-forward with `ffOnly`) | `GitError` for any other failure. Never rebases |
| `mergeAbort()`, `conflictedFiles()` | Nothing; the paths with unresolved conflicts | |
| `worktreeAdd(path, { branch, createBranch, startPoint, detach })` | A new branch is created at `startPoint` without tracking | `GitError` |
| `worktreeList()` | `[{ path, head, branch, bare, detached, locked, prunable }]`, the main checkout first | |
| `worktreeRemove(path, { force })` | | `GitError` for a worktree with changes, unless `force` |
| `configGet(key)`, `configSet(key, value)` | Value or null; sets it in the repository's own config | |

A `range` is `{ base, head, staged, threeDot }`: without `base` and `head` the working tree against the index; `staged` the index against `base` or HEAD (the staged changes of a commit); `threeDot` only the changes on `head` (HEAD by default) since its merge base with `base`, the diff that the scope check uses (10.2).

### 4.3 `src/core/github` (1.3a)

All GitHub access goes through gh (CM7) behind one executor seam.

**The executor.** `GhExecutor` is `(args, { input, env, cwd }) => Promise<{ code, stdout, stderr }>`; `env` holds only the extra variables of one call. `createGhExecutor({ env, timeoutMs })` is the real one: it runs the `gh` on PATH with `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1` and `NO_COLOR=1`, with a timeout of 120 seconds per call. A failure is a non-zero `code`, never a rejection, except a missing gh (`PreconditionError`). Tests replace it: in-process with `main(argv, { ghExecutor })` or `createGitHub({ executor })`; in a child process (a git hook calling `hackwin`) by putting a fake `gh` first on PATH.

**The requests.** Every typed helper sends `gh api --method <METHOD> <endpoint>`, with `--input -` and a JSON body on stdin when it writes. Endpoints start with `repos/{owner}/{repo}/`, which gh fills from `GH_REPO` in the call's `env`; a list adds `per_page=100&page=<n>` and the helper reads pages until one has fewer than 100 items. gh prints the JSON response on stdout; a failure exits non-zero with `(HTTP <status>)` on stderr when GitHub answered. A fake GitHub (task 1.3d) answers exactly these requests.

`createGitHub({ executor, repo, cwd })` returns a `GitHub`; `repo` is `owner/name`. `ctx.github` is one, for the repository of `origin`. `parseGitHubRemote(url)` gives the repository of a remote URL, or null.

| Method | Output |
| --- | --- |
| `run(args, { input })` | `{ code, stdout, stderr }`. Any gh call, for calls without a helper |
| `api(endpoint, { method, body, query })` | The parsed JSON response, or null when empty |
| `apiPages(endpoint, { query, maxPages })` | Every item of a paginated list |
| `login()` | The login gh is authenticated with (5.4, A4), asked once per client |
| `repository()` | `{ nameWithOwner, defaultBranch, visibility, url, permissions: { admin, maintain, push, triage, pull } }` of the caller |
| `getIssue(n)` | `Issue`, or null when it does not exist |
| `listIssues({ state, labels, since, assignee })` | `Issue[]` without pull requests |
| `createIssue({ title, body, labels, assignees })`, `updateIssue(n, { title, body, state, stateReason })` | `Issue` |
| `addLabels(n, labels)`, `removeLabel(n, label)` | The labels afterwards; removing a label the issue lacks is no error |
| `addAssignees(n, logins)`, `removeAssignees(n, logins)` | |
| `listComments(n)`, `createComment(n, body)`, `updateComment(id, body)` | `Comment[]`, oldest first; `Comment` |
| `listLabels()`, `createLabel({ name, color, description })`, `updateLabel(name, { newName, color, description })`, `deleteLabel(name)` | `Label[]`; `Label`; false when it did not exist |
| `getPullRequest(n)` | `PullRequest`, or null |
| `listPullRequests({ state, head, base })` | `PullRequest[]`; `head` is a branch name |
| `createPullRequest({ title, head, base, body })` | `PullRequest`, never a draft (8.4) |
| `updatePullRequest(n, { title, body, state, base })` | `PullRequest` |
| `listPullRequestFiles(n)` | `[{ path, status, previousPath }]` |

Labels, assignees and comments of a pull request use the issue helpers with its number. The types: `Issue` is `{ number, title, body, state, stateReason, labels, assignees, author, url, createdAt, updatedAt, closedAt, isPullRequest }` with label names and logins as strings; `PullRequest` is `{ number, title, body, state, draft, merged, mergedAt, mergeCommitSha, headRef, headSha, headRepo, baseRef, labels, author, url, createdAt, updatedAt, closedAt }`; `Comment` is `{ id, body, author, url, createdAt, updatedAt }`; `Label` is `{ name, color, description }`.

**Errors.** A failed call is a `RemoteError` (exit 3) with the HTTP status when gh printed one; gh exit code 4 or a request to run `gh auth login` is a `PreconditionError` (exit 2). `nullWhenNotFound(lookup)` turns a 404 into null.

**Calls of one lane.** A call that only one lane makes goes through `ctx.github.run` or `ctx.github.api` from inside that lane's directory: branch rules, rule sets, push protection and invitations (lane A); the pinned merge `gh pr merge <PR> --merge --match-head-commit <full SHA>`, branch deletion, issue pinning, check runs and CI reruns (lane C).

### 4.4 `src/core/config` (1.3b)

The parsed objects keep the key names of the files (`cli_version`, `team.members[].github`, `gate.poll_seconds`), so a `ConfigError` names the key exactly as the file spells it.

| Export | Inputs | Output and errors |
| --- | --- | --- |
| `loadConfig(git, { ref, fetch })` | `ref` is `origin/main` by default; `fetch` true by default (CM9) | `Config`: `{ hackwin, owners, ref, sha }`. `RemoteError` when the fetch fails; `PreconditionError` when `hackwin.yml` is missing on the ref ("not configured", resolve: `hackwin setup` in the main checkout); `ConfigError` naming the key for every broken rule |
| `parseHackwinConfig(text)` | The text of `hackwin.yml` | The object of 6.1 with the defaults of 6.3, or `ConfigError` |
| `parseOwners(text)` | The text of `owners.yml` | `{ schema, roles: { <role>: { shared, paths } }, open }`, or `ConfigError` (exactly one shared role; overlapping globs) |
| `validateConfig(hackwin, owners)` | | Nothing, or `ConfigError` naming the key: every rule of 6.1 and 6.2 |
| `loadProposedConfig(git, { ref, base })` | A branch's own copy, for CI (10.2 step 1) and `setup --regenerate` | As `loadConfig`, plus: a `cli_version` of another phase than on `base` is a `ConfigError` on `cli_version` |
| `ownerOf(config, path)` | | `{ role, holder, open }`: the matching role, or the shared role for a path without one (A16); `open` when the path is on the `open` list |
| `rolesOf(config, login)` | | The roles the member holds |
| `scopeCheck(config, { login, files, taskPaths })` | Paths of the change; the task's allowed paths, optional | `{ violations: [{ path, role, holder }], outsideTask: [path] }`. A violation is a path that is not open and whose role the login does not hold (E1); `outsideTask` lists paths inside the roles but outside `taskPaths`, a warning only (A15) |
| `resolveIdentity(config, login)` | The gh login | `Identity`: `{ login, member, roles, isLead }`. A login outside the team is a `PreconditionError` with the resolve "ask the Lead to add you to `hackwin.yml`" (7.2) |
| `checkVersion({ running, pinned })` | Two versions | `{ status }`: `same`, `newer-patch` (same phase, newer), `older` or `other-phase`. Phase is major and minor; older and newer follow semver precedence with pre-release identifiers (section 6.2) |
| `installCommand(version, repositoryUrl)` | The pinned version; `repository.url` of `package.json` | The install command of section 6.3 |
| `fastForwardMainCheckout(git, { defaultBranch })` | Run in the main checkout | `{ status }`: `fast-forwarded`, `up-to-date`, `behind` (local changes or another branch: nothing changes) or `not-main-checkout` (a task worktree) |

The runner (section 3.6, step 4) turns `older` and `other-phase` into a `PreconditionError` that prints the install command of the pinned version, a `newer-patch` into a one-line warning, and `behind` into the warning that the checkout is behind `origin/main`.

### 4.5 `src/core/tasks` (1.3b)

| Export | Inputs | Output |
| --- | --- | --- |
| `parseTaskBlock(body, config)` | An issue body | `{ isTask: false }` without a `# hackwin:task` block; otherwise `{ isTask: true, valid: true, block }` or `{ isTask: true, valid: false, errors: [reason] }`. `block` keeps the keys of 8.1: `kind`, `role`, `wave`, `paths`, `depends_on`, `acceptance_tests`, `deadline`. The three rules of 8.1 make a block invalid |
| `toTask(issue, config)` | An `Issue` | `Task`: `{ number, title, state, labels, assignees, status, block, valid, errors }`, `status` one of `ready`, `blocked`, `in-progress`, `in-review`, `cut`, `closed` or `open` (no status label) |
| `queueOf(tasks, roles)` | Open tasks; the member's roles | The member's queue of 8.1: their roles, not in progress, in review or cut; ordered by wave (none last), deadline, number |
| `dependenciesOf(task, issues)` | The task; issues by number | `{ takeable, open: [number] }`: takeable when every dependency is closed (8.3, I12) |
| `slugOf(title)` | | The first four words of the title, lower case, every run of characters other than `a` to `z` and `0` to `9` replaced by one hyphen |
| `branchName(number, title)`, `parseBranch(name)` | | `task/<N>-<slug>` (A9); `{ kind: 'task', issue }`, `{ kind: 'spike' }` or `{ kind: 'other' }` |
| `parseTaskLink({ branch, body })` | Branch and pull request body | `{ ok: true, issue }` or `{ ok: false, reason }` with the reasons `no-task-branch`, `spike-branch`, `no-closes-line`, `several-closing-references`, `branch-issue-mismatch` (section 5.5) |
| `checkTaskLink(github, config, pull)` | A `PullRequest` | As `parseTaskLink`, plus `issue-not-open` and `invalid-task-block` (E11, E16) |
| `LABELS` | | The catalogue of 8.2: `[{ name, color, description }]`, every label except the `role:` labels |
| `roleLabel(role)` | | `role:<role>` |
| `setTaskStatus(github, number, status)` | `ready`, `in-progress`, `in-review` | Removes the other status labels of the issue and adds this one; a label edit only (8.3) |

### 4.6 `src/core/secrets` (1.3b)

| Export | Inputs | Output |
| --- | --- | --- |
| `BUILTIN_PATTERNS` | | `[{ name, regex }]`, the built-in list (A41) |
| `scanAddedLines(lines, { extraPatterns })` | `AddedLine[]` from `git.addedLines`; `gate.secret_patterns` | `Finding[]`: `{ path, line, pattern }`, never the matched text. A match inside the integrity hash of a package in a lockfile (`<algorithm>-<base64>`) is not a finding |
| `scanAddedFiles(files)` | `ChangedFile[]` | A finding with the pattern `env-file` for every added env file except `.env.example` |
| `scanDiff(git, range, { extraPatterns })` | | Both scans of one diff |
| `formatFinding(finding)` | | `<path>:<line>: <pattern>` |

### 4.7 `src/core/state` (1.3c)

Local state of a clone lives in `<gitCommonDir>/hackwin/`, shared by every worktree (A6). The formats are in section 5. Writes are atomic: a temporary file, then a rename.

| Export | Inputs | Output |
| --- | --- | --- |
| `statePaths(gitCommonDir)` | | `{ root, local, checks, sessions, prompts, gate }`, absolute |
| `readLocal(dir)`, `writeLocal(dir, record)` | `dir` is `gitCommonDir` | The record of 5.1, or null |
| `isJoinComplete(record, login)` | | True when the record has `join` and its `login` equals the caller's |
| `readCheckRecord(dir, sha)`, `writeCheckRecord(dir, record)` | | The record of 5.2, or null |
| `isGreen(record, sha)` | | True when the record is for this full SHA and no check failed (E4) |
| `readMainSeen(dir, worktree)`, `latestMainSeen(dir)`, `writeMainSeen(dir, worktree, sha, time)` | An absolute worktree path | `{ main_sha, recorded_at }` for the worktree, or the latest of any worktree, or null |
| `readLastStatus(dir)`, `writeLastStatus(dir, time)` | | ISO 8601 time or null |
| `promptPath(dir, issue)`, `gateDir(dir)` | | `prompts/<issue>.md` (lane B writes it); `gate/` (lane C owns its content) |

### 4.8 `src/core/worktrees` (1.3c)

| Export | Inputs | Output |
| --- | --- | --- |
| `mainCheckout(git)` | | The path of the main checkout |
| `taskWorktreePath(mainCheckout, issue, slug)` | | `<repo-parent>/<repo-name>.worktrees/<N>-<slug>` (A9) |
| `currentTask(git)` | | `{ issue, branch, path }` when the current worktree is on a `task/` branch, else null |
| `taskWorktrees(git)` | | `[{ issue, branch, path }]` of every task worktree of the clone |
| `removeMergedWorktrees(git, github)` | | `{ removed: [path], kept: [{ path, reason }] }`: removes the worktree of every task whose pull request is merged (A35) |
| `checkHooksPath(git)`, `repairHooksPath(git)` | | `{ ok, value }`; sets `core.hooksPath` to `.githooks` in the clone's config and returns `{ changed }` (E20) |

### 4.9 `src/core/project` (1.3c)

Each run returns `ProjectRun`: `{ ok, command, code, timedOut, tail, durationMs, logFile }`.

| Export | Inputs | Output |
| --- | --- | --- |
| `runInstall({ cwd, config, timeoutMs, logFile })` | | `ProjectRun`, or `{ skipped: true, notice }` while no file matches `paths.manifests` (A62) |
| `runCheck({ cwd, config, timeoutMs, logFile })` | | `ProjectRun` of `commands.check` |
| `runAcceptanceTests({ cwd, config, files, timeoutMs, logFile })` | The task's `acceptance_tests` | `{ ok, missing: [entry], run }`. Every entry is a file path; an entry that is not an existing file fails before anything runs (T5); otherwise `commands.test` runs with the files appended |
| `formatCheck({ cwd, config, files })` | The changed files | `{ ok, unformatted: [path], run }`: runs `commands.format` on the files and compares their content before and after, restoring the original (E14) |
| `generatedFileCheck({ cwd, config, git })` | | `{ ok, changed: [path], run }`: runs `commands.generate` and fails when a tracked file changes (E10); `ok` when `commands.generate` is null |

### 4.10 `src/core/changes` (1.3c)

| Export | Inputs | Output |
| --- | --- | --- |
| `changesOnMain(git, { from, to, ownPaths })` | A recorded main commit or null; `origin/main` by default; the globs of the member's roles | `{ from, to, files: [{ path, status, own }] }` with the member's own scope first (E5, I6). With `from` null the list is empty and `from` stays null: the first `take` in a clone says that no commit was recorded |

### 4.11 `src/core/protection` (1.3e)

| Export | Inputs | Output |
| --- | --- | --- |
| `readProtection(github, { branch })` | The Lead's client; the default branch | `{ state, rules: { pullRequestRequired, requiredChecks, forcePushBlocked, deletionBlocked, appliesToAdmins, updateRestricted } }`, `state` one of section 5.4, according to `docs/verification.md` |

### 4.12 `test/harness` (1.3d)

| Export | Output |
| --- | --- |
| `createFixture(options)` | An offline fixture: a temporary bare origin and its main checkout, with its own HOME and git configuration; scripted states (files, commits, branches, task worktrees, a team of 1, 3 or 4 members, a joined clone); `cleanup()` |
| `createFakeGitHub(state)` | `{ executor, state, on(request, handler) }`: an in-memory repository behind the executor seam that answers the requests of section 4.3. A lane registers handlers for its own calls from its own test files |
| `withFixtureRepo(name, scenario)` | Runs a scenario on a fixture repository (section 6.4) under its lock, after the reset |
| `accounts` | `lead`, `builder1`, `builder2`, `solo` (section 6.4) |

## 5. Data formats

Times are ISO 8601 with an offset. Files written by hackwin carry `schema: 1`.

### 5.1 `<gitCommonDir>/hackwin/local.yml`

Written by `join` (lane A), read by every command that requires a completed `join`.

```yaml
schema: 1
login: "<gh login>"
language: "<answer language>"
explanation_style: "<explanation style>"
join:                          # the record of the last join that exited 0; absent before
  completed_at: "<time>"
  cli_version: "<version>"
```

"`join` is complete" means: `join` is present and `login` equals the caller's gh login.

### 5.2 `<gitCommonDir>/hackwin/checks/<sha>.json`

The green check record of one commit, named by its full SHA. `ship` writes it after step 8 when every check passed (lane B); the `pre-push` hook requires it for the pushed head of a `task/` branch (lane A, E4).

```json
{
  "schema": 1,
  "sha": "<full sha>",
  "branch": "task/<N>-<slug>",
  "issue": 0,
  "created_at": "<time>",
  "cli_version": "<version>",
  "checks": [
    { "name": "scope", "result": "passed" },
    { "name": "secrets", "result": "passed" },
    { "name": "format", "result": "passed" },
    { "name": "generated", "result": "skipped" },
    { "name": "check", "result": "passed", "duration_ms": 0 },
    { "name": "acceptance", "result": "passed", "duration_ms": 0 }
  ]
}
```

The check names are steps 3 to 8 of `ship`. A result is `passed`, or `skipped` when the project has no such command. A record never holds a failed check.

### 5.3 `<gitCommonDir>/hackwin/sessions/`

| File | Content | Written by | Read by |
| --- | --- | --- | --- |
| `main-seen/<key>.json` | `{ "schema": 1, "worktree": "<absolute path>", "main_sha": "<sha>", "recorded_at": "<time>" }`; `<key>` is the first 16 hex digits of the SHA-256 of the worktree path | `take`, `SessionStart` | `take`, `SessionStart` |
| `status.json` | `{ "schema": 1, "last_status_at": "<time>" }` | `status` | `status` |

One file per worktree keeps two sessions from writing the same file. The commit "last recorded anywhere in this clone" (7.7 step 6) is the record with the latest `recorded_at`.

### 5.4 Protection state

| Value | Meaning (7.1 steps 11 and 12) |
| --- | --- |
| `full-restricted` | The rules for everyone and the update restriction |
| `full` | The rules for everyone, without the update restriction |
| `soft` | No protection from GitHub; the soft blocks of 10.6 |

`setup` creates the rules for everyone as the rule set `hackwin-branch-rules` and the update restriction as its own rule set `hackwin-update-restriction` (A32). Task 1.3e changes these names in this file if `docs/verification.md` shows another mechanism.

### 5.5 Pull request body and task link

- `ship` builds the body from the project's `.github/pull_request_template.md`: it replaces the first line that is exactly `Closes #` (trailing spaces allowed) with `Closes #<N>`. Without such a line it puts `Closes #<N>` and an empty line before the template; without a template the body is `Closes #<N>`.
- The task link parser (`src/core/tasks`) accepts a body with exactly one line that matches `^Closes #(\d+)\s*$`, whose number equals the issue of the branch `task/<N>-<slug>`, and no other GitHub closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved) followed by an issue reference anywhere in the body, so that a merge closes exactly the task (T1, E11).
- A branch that starts with `spike/` is refused (E16).

### 5.6 Other local paths

`prompts/<issue>.md` belongs to lane B (`take`); everything under `gate/` belongs to lane C (6.4). `src/core/state` only names these paths.

## 6. Decisions of plan section 9

### 6.1 The machine account's credential

`HACKWIN_TEST_BUILDER_TOKEN` holds the token of `test-bot-builder`. The human sets it locally. Only the test harness reads it, and it reaches a child process only through that process's environment (as `GH_TOKEN`); it is never printed, logged or written to a file. CI of this repository holds no such credential and runs only `npm test`; the tests on fixture repositories run locally through `npm run test:ac`.

### 6.2 Version scheme

- The major and minor numbers name the phase: Phase 1 is `0.1`. The releases of one phase differ only in the patch number (A60).
- Before release 0.1.0, every installable version is a GitHub pre-release of this repository with the tag `v<version>` and the asset `hackwin-<version>.tgz`, the output of `npm pack`. Builds are `0.1.0-pre.<n>`. For AC77 the same code is also packed as `0.1.1-pre.<n>`, a bug fix of the same phase that differs in the patch number, and as `0.2.0-pre.<n>`, another phase; those two packs come from the same commit with only the version in `package.json` changed.
- `package.json` on main carries `0.1.0-pre.0` until the first pre-release. The integrator creates a pre-release only when the human asks.
- CM12 compares the major and minor numbers for the phase, and semver precedence, pre-release identifiers included, for older and newer: `0.1.0-pre.2` < `0.1.0-pre.10` < `0.1.1-pre.1` < `0.1.1`. No npm release from step 1.8 on shares a version with a pre-release.

### 6.3 Install command

| Version | Install command |
| --- | --- |
| With a pre-release identifier, for example `0.1.0-pre.3` | `npm install -g <URL of the .tgz>`, with the URL built from `repository.url` in `package.json`: `npm install -g https://github.com/Bartek201301/HackWin/releases/download/v0.1.0-pre.3/hackwin-0.1.0-pre.3.tgz` |
| Without, for example `0.1.0` | `npm install -g hackwin@0.1.0` |

### 6.4 Fixture repositories and accounts

| Repository | Visibility | Used by |
| --- | --- | --- |
| `Bartek201301/hackwin-fixture-a` | Public | Lane A, and the integration tasks |
| `Bartek201301/hackwin-fixture-b` | Public | Lane B, the experiments of step 1.2, and the integration tasks |
| `Bartek201301/hackwin-fixture-c` | Public | Lane C, and the integration tasks |
| `Bartek201301/hackwin-fixture-private` | Private | The cases where GitHub refuses protection (AC2) and, if step 1.2 confirms it, push protection (AC80); the experiments of step 1.2 |

- Before a test run the harness resets a fixture repository: it closes every open issue and pull request, deletes every label, branch rule and rule set, and resets `main` to the recorded commit `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` (all four; read back from GitHub on 10 October 2026). A lock per repository keeps two sessions off the same repository.
- No repository is ever deleted, and the `delete_repo` scope is never requested. Automated tests never touch `hackwin-sandbox`; it is for the human's live tests.
- Accounts: `lead` is the gh login of the machine; `builder1` is `test-bot-builder`, with the token of section 6.1; `builder2` is a teammate's login, used only as a name in team configurations with invitations off, so every scenario in which it acts runs against the fake GitHub (its login is still open, plan section 9); `solo` is the Lead's account.
