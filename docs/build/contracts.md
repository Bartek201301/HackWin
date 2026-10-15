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
| `config` | `Config` | From task 1.3b: `hackwin.yml` and `owners.yml` from `origin/main` (section 4.4). Absent for `setup` on an unconfigured repository, and for `internal hook` and `internal ci`, which load what they need themselves (section 3.6) |
| `identity` | `Identity` | From task 1.3b: the caller's login and team member (section 4.4). Absent where `config` is |

**The result** (`CommandResult`):

| Field | Type | Content |
| --- | --- | --- |
| `exitCode` | 0 or 1 | 0 by default. 1 when the command finished but a check failed, as `join` does after its checklist. Exit codes 2 and 3 are always thrown errors |
| `lines` | string[] | The short output (CM6), printed one per line without `--json` |
| `data` | any | The full machine readable result, printed with `--json` |

**When GitHub is unreachable** (#71). A user command's module may also export a second function, `CommandUnreachable` in `src/cli/context.js`:

```js
/** @import { CommandContext, UnreachableResult } from '../../cli/context.js' */
/** @import { RemoteError } from '../../core/runtime/errors.js' */

/**
 * @param {CommandContext} ctx Without `config` and `identity`.
 * @param {RemoteError} error The error of the preparation.
 * @returns {Promise<UnreachableResult | void>}
 */
export async function unreachable(ctx, error) {}
```

- The runner calls it only when preparing the context (section 3.6, step 4) throws a `RemoteError`: the fetch of `origin`, or `gh api user` for the identity. It then loads the module although the preparation failed and calls `unreachable`; `run` is not called.
- `ctx` is the context the runner built, without `config` and `identity`, also when the configuration was loaded before `gh api user` failed. The function reads only local state.
- It returns `{ lines, data }`, both optional, or nothing. Without `--json` the runner prints the lines on stdout, then the error on stderr as for any error. With `--json` the one document is the error's, with the lines and data added (section 3.3). The exit code is 3, the `RemoteError`'s.
- GitHub unreachable exits 3 (7.6), also when the import of the module or the function throws. The runner then reports the `RemoteError` as without the function, after one warning (section 3.3) that says why: `the local information of hackwin <command> could not be shown: <message>`. With `--json` the warning is in `warnings`, and the document has no `lines` and no `data`.
- The error alone is printed, as for any error, when the module does not export `unreachable`, when it does not exist yet (the `RemoteError`, not `not built yet`), for a plumbing command (which the runner does not prepare, section 3.6), and for a `RemoteError` that `run` throws after the preparation succeeded.
- `status` exports it to print the local heartbeat on the Lead's laptop while GitHub is unreachable (7.6, #25).

### 3.3 Output

- Short by default (CM6): the runner prints `result.lines` on stdout. With `--json` stdout carries exactly one JSON document:

  ```json
  { "command": "take", "ok": true, "exitCode": 0, "lines": ["..."], "data": {}, "warnings": [] }
  { "command": "take", "ok": false, "exitCode": 1, "error": { "kind": "blocked", "message": "...", "rule": "...", "objects": ["..."], "resolve": { "command": "...", "dir": "..." } }, "warnings": [] }
  ```

  `command` is null when the command line itself is wrong. The fields of `error` are those of section 3.4. After an `unreachable` function that returned (section 3.2) the error's document also has `lines` (empty when it returned none) and `data` (null when it returned none), before `error`:

  ```json
  { "command": "status", "ok": false, "exitCode": 3, "lines": ["..."], "data": {}, "error": { "kind": "remote", "message": "...", "details": { "status": null, "tail": ["..."] } }, "warnings": [] }
  ```
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

Every error has `message`, `exitCode`, `kind` and optional `resolve` and `details`, and `toJSON()` gives its JSON form. `exitCodeOf(error)` returns the exit code of any thrown value. A command that finishes with a failed check returns `exitCode: 1` instead of throwing (section 3.2). A Claude Code `PreToolUse` hook is the one exception to "a block exits 1": it blocks with exit 0 (section 3.6).

### 3.5 Caller kind

`detectCallerKind({ env, stdinIsTTY, stdoutIsTTY })` in `src/core/runtime/caller.js`, available as `ctx.caller`:

| Kind | When | Used by |
| --- | --- | --- |
| `claude-code` | `HACKWIN_CALLER=claude-code` is set. The command wrappers of task 1.4c set it | `take` does steps 1 to 6 of 7.7, then prints the prompt file and the command that starts the agent in the worktree, for a new terminal: Claude Code with the worktree as its directory (`docs/verification.md` row 3), or Codex with `--cd` (row A). The session never moves to another directory (the scope change on #16, row 4). `gate` starts nothing and prints the instruction to run `hackwin gate` in a separate terminal (AC58) |
| `terminal` | Otherwise, when stdin and stdout are both terminals | `take` starts the agent; `gate` runs |
| `non-interactive` | Otherwise: hooks, CI, scripts, tests | `take` prints the start command instead of starting the agent (PR #49); `gate` refuses to start; questions come from `--answers <file>` (CM11) |

Any other value of `HACKWIN_CALLER` is ignored. With `--json`, `take` also prints the start command and starts no agent, in every caller kind, because stdout carries the one JSON document (PR #49).

### 3.6 What the runner does

1. Parse the command line. A wrong command line exits 2.
2. `--version` prints the version; `--help` prints the help. Both exit 0.
3. Build the context: the top-level directory (outside a git checkout: exit 2), the git common directory, and the GitHub repository from the URL of `origin` (`owner/name`, passed to gh as `GH_REPO`; none for a local remote).
4. Prepare the context (`prepareContext` in `src/cli/main.js`, filled by task 1.3b): fetch and read `hackwin.yml` and `owners.yml` from `origin/main` (CM9, A17) and validate them (exit 2 naming the key), and the version check (CM12), both through `loadCheckedConfig` of `src/core/config` (section 4.4); the caller's identity (5.4); the fast-forward of the main checkout (CM10). The fetch prunes, so a branch deleted on GitHub leaves no remote-tracking ref for the command to act on, such as the base of a new task branch in `take`. `setup` on a repository without `hackwin.yml` on `origin/main` skips this step; its check for `hackwin.yml` fetches with pruning as well.

   When this step throws a `RemoteError`, the runner loads the command's module all the same and, when it exports `unreachable(ctx, error)`, calls it with the context without `config` and `identity`, prints its lines before the error and exits 3 (section 3.2).

   The runner prepares the six user commands only. `internal hook` and `internal ci` get no prepared config, identity, version check or fast-forward, because every hook except `SessionStart` must stay offline (10.4) and in CI the caller is GitHub's token, not a member. Each internal command loads what it needs through `src/core/config` itself: a hook from the local `origin/main` without a fetch, with the member's login recorded locally by `join` (section 5.1); `internal ci` from the base branch and the proposed copy as 10.2 step 1 says, with the pull request's author. 1.4a (#8) decided how a hook applies CM12 without the network: against `cli_version` on the local `origin/main`. `loadCheckedConfig(git, { fetch: false, ... })` of section 4.4 does exactly that, so the hooks and the runner can share one loader.
5. Load the command's module, run it, print the result or the error, and return the exit code.

**The exit code of a Claude Code `PreToolUse` hook.** Claude Code treats exit 1 of a `PreToolUse` hook as a non-blocking error: the tool runs anyway. So `hackwin internal hook pre-tool-use` (1.4c, #10) blocks a tool call with exit 0 and a JSON permission decision `deny` on stdout, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<the block as the runner prints it>"}}` (PR #58). The review of #58 checked this in Claude Code's hooks reference on 15 October 2026. It is the one exception to "a block exits 1" of section 3.4.

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

**Calls of one lane.** A call that only one lane makes goes through `ctx.github.run` or `ctx.github.api` from inside that lane's directory: branch rules, rule sets, push protection and invitations (lane A; reading the protection state goes through section 4.11); `gh pr ready <N>`, which marks a draft pull request of the branch ready in `ship` step 11 (lane B, PR #48); the pinned merge `gh pr merge <PR> --merge --match-head-commit <full SHA>`, branch deletion, issue pinning, check runs and CI reruns (lane C).

### 4.4 `src/core/config` (1.3b)

The parsed objects keep the key names of the files (`cli_version`, `team.members[].github`, `gate.poll_seconds`), so a `ConfigError` names the key exactly as the file spells it.

| Export | Inputs | Output and errors |
| --- | --- | --- |
| `loadConfig(git, { ref, fetch })` | `ref` is `origin/main` by default; `fetch` true by default (CM9): `git fetch --prune origin` | `Config`: `{ hackwin, owners, ref, sha }`. `RemoteError` when the fetch fails; `PreconditionError` when `hackwin.yml` is missing on the ref ("not configured", resolve: `hackwin setup` in the main checkout); `ConfigError` naming the key for every broken rule |
| `loadCheckedConfig(git, { ref, fetch, running, repositoryUrl, out })` | `ref` is `mainRef(git)` by default; `fetch` true by default, false in a hook; `running` the version of the CLI; `repositoryUrl` `repository.url` of `package.json`; `out` an `Output` for the warning, or null | `Config`, after the version check of `enforceVersion`. When the configuration is invalid, `cli_version` is read from the raw `hackwin.yml` first, so a CLI of another phase gets the `PreconditionError` with the version to install, not the `ConfigError` of a key it does not know. The runner (section 3.6, step 4) calls it; the hooks call it with `fetch: false`, through `loadHookConfig` of `src/internal/hook/config.js` (#61, PR #62). Errors: those of `loadConfig` and `enforceVersion` |
| `mainRef(git)` | | The remote-tracking ref of the default branch: what `origin/HEAD` points to, or `origin/main` |
| `enforceVersion({ running, pinned, repositoryUrl, out })` | Two versions; `out` as above | The `VersionStatus`. `older` and `other-phase` are a `PreconditionError` (exit 2) whose resolve is the install command of the pinned version (section 6.3) in any directory; `newer-patch` warns on `out` and continues. No hook calls it directly: the hooks load through `loadCheckedConfig` (#61, PR #62). `src/cli/main.js` still exports `enforceVersion({ running, pinned, out, repositoryUrl })` with `repository.url` of this package as default; only `test/cli/prepare.test.js` imports it |
| `pinnedVersionOf(text)` | The text of `hackwin.yml` | Its `cli_version`, read without validating the rest, or null when it has no valid version |
| `HACKWIN_FILE`, `OWNERS_FILE` | | `hackwin.yml`, `owners.yml`: the two files at the repository root |
| `parseHackwinConfig(text)` | The text of `hackwin.yml` | The object of 6.1 with the defaults of 6.3, or `ConfigError` |
| `parseOwners(text)` | The text of `owners.yml` | `{ schema, roles: { <role>: { shared, paths } }, open }`, or `ConfigError` (exactly one shared role; overlapping globs) |
| `validateConfig(hackwin, owners)` | | Nothing, or `ConfigError` naming the key: every rule of 6.1 and 6.2 |
| `loadProposedConfig(git, { ref, base })` | A branch's own copy, for CI (10.2 step 1) and `setup --regenerate` | As `loadConfig`, plus: a `cli_version` of another phase than on `base` is a `ConfigError` on `cli_version` |
| `ownerOf(config, path)` | | `{ role, holder, open }`: the matching role, or the shared role for a path without one (A16); `open` when the path is on the `open` list |
| `holderOf(config, role)` | | The login of the member who holds the role, or null when no member does |
| `rolesOf(config, login)` | | The roles the member holds |
| `scopeCheck(config, { login, files, taskPaths })` | Paths of the change; the task's allowed paths, optional | `{ violations: [{ path, role, holder }], outsideTask: [path] }`. A violation is a path that is not open and whose role the login does not hold (E1); `outsideTask` lists paths inside the roles but outside `taskPaths`, a warning only (A15) |
| `resolveIdentity(config, login)` | The gh login | `Identity`: `{ login, member, roles, isLead }`. A login outside the team is a `PreconditionError` with the resolve "ask the Lead to add you to `hackwin.yml`" (7.2) |
| `checkVersion({ running, pinned })` | Two versions | `{ status }`: `same`, `newer-patch` (same phase, newer), `older` or `other-phase`. Phase is major and minor; older and newer follow semver precedence with pre-release identifiers (section 6.2) |
| `installCommand(version, repositoryUrl)` | The pinned version; `repository.url` of `package.json` | The install command of section 6.3 |
| `fastForwardMainCheckout(git, { defaultBranch })` | Run in the main checkout | `{ status }`: `fast-forwarded`, `up-to-date`, `behind` (local changes or another branch: nothing changes) or `not-main-checkout` (a task worktree) |
| `createMatcher(globs)` | Globs of the syntax below | A function that is true for a path, relative to the repository root, that matches any of the globs; dot files included |
| `samplePath({ inside, alsoInside, outside })` | Globs of the syntax below | A path that matches a glob of `inside`, also a glob of `alsoInside` when given, and no glob of `outside`, or null when there is none. Two globs share a path: `{ inside: [a], alsoInside: [b] }`; a glob reaches a path outside a list: `{ inside: [a], outside: list }` |

The runner (section 3.6, step 4) turns `older` and `other-phase` into a `PreconditionError` that prints the install command of the pinned version, a `newer-patch` into a one-line warning, and `behind` into the warning that the checkout is behind `origin/main`.

- **Task paths.** A task's paths lie inside the task's own role or on the `open` list (the block comment of 8.1, the `tasks --check` rule and AC8 of the PRD). This is stricter than "exactly one role" of 8.1 alone. A path of another role makes the task block invalid (`parseTaskBlock`, section 4.5).
- **Glob syntax.** The globs of `owners.yml`, of the `paths` groups of `hackwin.yml` and of task paths support literal characters, backslash escapes, `?`, `*`, `**` and brace lists (`{a,b}`). Character classes, groups, extglobs and negation are a `ConfigError` naming the key, and make a task block invalid, so that matching and the overlap check read every glob the same way.

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
| `WAITING_LABELS` | | The labels on a pull request that wait for its author, in the order of 7.7 step 3: `['needs-owner', 'gate:failed', 'scope-violation']` |
| `SCOPE_CHANGE` | | `Scope change:`, the start of an issue comment that changes the scope of a task (8.1) |
| `roleLabel(role)` | | `role:<role>` |
| `setTaskStatus(github, number, status)` | `ready`, `in-progress`, `in-review` | Removes the other status labels of the issue and adds this one; a label edit only (8.3) |

`take` (`WAITING_LABELS` in `src/commands/take/index.js`, `HANDBACK_LABELS` in `src/commands/take/resume.js`, `SCOPE_CHANGE` in `src/commands/take/prompt.js`) and the SessionStart hook (`src/internal/hook/session-start.js`) still define their own copies of these two values. Each lane switches to `WAITING_LABELS` and `SCOPE_CHANGE` of `src/core/tasks` in its first task that starts after #60 is merged; #57 and #61 may start earlier.

### 4.6 `src/core/secrets` (1.3b)

| Export | Inputs | Output |
| --- | --- | --- |
| `BUILTIN_PATTERNS` | | `[{ name, regex }]`, the built-in list (A41) |
| `scanAddedLines(lines, { extraPatterns })` | `AddedLine[]` from `git.addedLines`; `gate.secret_patterns` | `Finding[]`: `{ path, line, pattern }`, never the matched text. A match inside the integrity hash of a package in a lockfile (`<algorithm>-<base64>`) is not a finding |
| `scanAddedFiles(files)` | `ChangedFile[]` | A finding with the pattern `env-file` for every added env file except `.env.example` |
| `scanDiff(git, range, { extraPatterns })` | | Both scans of one diff |
| `formatFinding(finding)` | | `<path>:<line>: <pattern>` |

### 4.7 `src/core/state` (1.3c)

Local state of a clone lives in `<gitCommonDir>/hackwin/`, shared by every worktree (A6). The formats are in section 5. Writes are atomic: a temporary file, then a rename. A missing or unreadable local record counts as no record: its read returns null.

| Export | Inputs | Output |
| --- | --- | --- |
| `statePaths(gitCommonDir)` | | `{ root, local, checks, sessions, prompts, gate, logs }`, absolute |
| `readLocal(dir)`, `writeLocal(dir, record)` | `dir` is `gitCommonDir` | The record of 5.1, or null |
| `isJoinComplete(record, login)` | | True when the record has `join` and its `login` equals the caller's |
| `readCheckRecord(dir, sha)`, `writeCheckRecord(dir, record)` | | The record of 5.2, or null |
| `isGreen(record, sha)` | | True when the record is for this full SHA, holds each check of `CHECK_NAMES`, and every check passed, `generated` also `skipped` (E4, section 5.2). A record that lacks one of the six checks is not green |
| `CHECK_NAMES`, `SKIPPABLE_CHECKS` | | The six checks that `ship` records, `scope`, `secrets`, `format`, `generated`, `check` and `acceptance` (section 5.2); the checks that may be `skipped`, `generated` alone |
| `readMainSeen(dir, worktree)`, `latestMainSeen(dir)`, `writeMainSeen(dir, worktree, sha, time)` | An absolute worktree path | `{ main_sha, recorded_at }` for the worktree, or the latest of any worktree, or null |
| `readLastStatus(dir)`, `writeLastStatus(dir, time)` | | ISO 8601 time or null |
| `promptPath(dir, issue)`, `gateDir(dir)` | | `prompts/<issue>.md` (lane B writes it); `gate/` (lane C owns its content) |
| `shipLogPath(dir, issue, step)` | A check name such as `check` or `acceptance` | `logs/ship/<issue>/<step>.log` (section 5.6; lane B writes it) |
| `writeAtomic(file, text)`, `readText(file)`, `parseJson(text)` | Any file, for example a lane's own file under `gate/` | Writes through a temporary file in the same directory and a rename, creating the directory; the text, or null when the file or a directory on its path does not exist or the path is a directory; the parsed JSON, or null when the text is not JSON |

### 4.8 `src/core/worktrees` (1.3c)

| Export | Inputs | Output |
| --- | --- | --- |
| `mainCheckout(git)` | | The path of the main checkout |
| `taskWorktreePath(mainCheckout, issue, slug)` | | `<repo-parent>/<repo-name>.worktrees/<N>-<slug>` (A9) |
| `currentTask(git)` | | `{ issue, branch, path }` when the current worktree is on a `task/` branch, else null |
| `taskWorktrees(git)` | | `[{ issue, branch, path }]` of every task worktree of the clone |
| `removeMergedWorktrees(git, github)` | | `{ removed: [path], kept: [{ path, reason, merged }] }`: removes the worktree of every task whose pull request is merged (A35). `merged` is true for a kept worktree whose task's pull request is merged (the current worktree, a locked one, or one with changes), false for a task whose pull request is not merged, so a caller need not read `reason` |
| `checkHooksPath(git)`, `repairHooksPath(git)` | | `{ ok, value }`; sets `core.hooksPath` to `.githooks` in the clone's config and returns `{ changed }` (E20) |

### 4.9 `src/core/project` (1.3c)

Each run returns `ProjectRun`: `{ ok, command, code, timedOut, tail, durationMs, logFile }`. A run without `timeoutMs` has the default timeout of 20 minutes (`PROJECT_TIMEOUT_MS`). Every run takes `env`, the whole environment of every process the run starts, `process.env` by default (as `execShell`, section 4.1): a caller that must keep a variable from the project's code, such as `internal ci` with the token of its run, passes an environment without it. That covers git as well: the `git ls-files` of `runInstall` that looks for a manifest, and the git calls of `generatedFileCheck`, which with `env` run with it in place of the environment of the `git` passed in, and without `env` keep that environment.

| Export | Inputs | Output |
| --- | --- | --- |
| `runInstall({ cwd, config, timeoutMs, logFile, env })` | | `ProjectRun`, or `{ skipped: true, notice }` while no file matches `paths.manifests` (A62) |
| `runCheck({ cwd, config, timeoutMs, logFile, env })` | | `ProjectRun` of `commands.check` |
| `runAcceptanceTests({ cwd, config, files, timeoutMs, logFile, env })` | The task's `acceptance_tests` | `{ ok, missing: [entry], run }`. Every entry is a file path; an entry that is not an existing file fails before anything runs (T5); otherwise `commands.test` runs with the files appended. An empty list passes with nothing run: `{ ok: true, missing: [], run: null }` |
| `formatCheck({ cwd, config, files, env })` | The changed files | `{ ok, unformatted: [path], run }`: runs `commands.format` on the files and compares their content before and after, restoring the original (E14). It takes no timeout and no log file: it runs with the default timeout of 20 minutes |
| `generatedFileCheck({ cwd, config, git, env })` | | `{ ok, changed: [path], run }`: runs `commands.generate` and fails when it changes a tracked file (E10); `ok` when `commands.generate` is null. Only the changes that `commands.generate` made count: changes in the checkout before the run do not. It restores every tracked file it changed. It takes no timeout and no log file: it runs with the default timeout of 20 minutes |

### 4.10 `src/core/changes` (1.3c)

| Export | Inputs | Output |
| --- | --- | --- |
| `changesOnMain(git, { from, to, ownPaths })` | A recorded main commit or null; `origin/main` by default; the globs of the member's roles | `{ from, to, files: [{ path, status, own }] }` with the member's own scope first (E5, I6). With `from` null the list is empty and `from` stays null: the first `take` in a clone says that no commit was recorded |

### 4.11 `src/core/protection` (1.3e)

| Export | Inputs | Output |
| --- | --- | --- |
| `readProtection(github, { branch })` | The Lead's client; the branch, the repository's default branch when not given | `{ state, rules }`, `state` one of section 5.4. `rules`: `pullRequestRequired`, `requiredChecks`, `checkRequired`, `checkPinned`, `forcePushBlocked`, `deletionBlocked`, `appliesToAdmins`, `updateRestricted`, `bypassable`. `requiredChecks` is `[{ context, integrationId }]`, with `integrationId` null for a check that names no app; `bypassable` is `[{ type, ruleset }]`, the rule and the name of its rule set; the others are booleans. A `RemoteError` (exit 3) when GitHub fails, except the refusal of section 5.4, which reads `soft` |
| `PROTECTION_STATES`, `REQUIRED_CHECK`, `ACTIONS_APP_ID`, `ADMIN_ROLE_ID` | | `['full-restricted', 'full', 'soft']`; `hackwin`; `15368`; `5`: the values of the rule sets of section 5.4 |

How the reader decides, according to `docs/verification.md` rows 5 and 6:

- A rule is in force when GitHub lists it for the branch: `GET repos/{owner}/{repo}/rules/branches/<branch>` returns the rules of the active rule sets, each with its `ruleset_id`. The reader then reads each of those rule sets with `GET repos/{owner}/{repo}/rulesets/<id>` for `bypass_actors` and `current_user_can_bypass`. It goes by the rules and the bypass lists, not by the names of the rule sets. Classic branch protection is not read.
- `pullRequestRequired`, `checkRequired` (the check `hackwin`), `forcePushBlocked` and `deletionBlocked`: the rules `pull_request`, `required_status_checks` naming `hackwin`, `non_fast_forward` and `deletion` are in force, from any rule set.
- `appliesToAdmins`: each of those four rules that is in force comes from at least one rule set without bypass actors, so it binds every account, the owner included. False when none is in force. A rule set whose `bypass_actors` GitHub does not return counts as having bypass actors.
- `updateRestricted`: a rule `update` is in force from a rule set whose only bypass actors are the repository admin role (`RepositoryRole`, `actor_id` 5), and its `current_user_can_bypass` for the reading account is not `never`.
- `checkPinned`: a required check `hackwin` with `integrationId` 15368 is in force. It is only reported: until the next PRD revision it does not change the state (issue #7).
- `bypassable`: every rule in force that the reading account can bypass, its rule set's `current_user_can_bypass` being other than `never` or not returned, except the rule `update` of the update restriction. A rule other than `update` inside the update restriction's own rule set is listed. Empty when the Lead's account can skip no rule on the branch but the update restriction. It does not change the state. Whenever the update restriction is active (`rules.updateRestricted`), in any protection state, the Gate reads `rules.bypassable`, never the rule sets: at start (1.6a, #20) and before each merge with `--admin` (1.6d, #23).

The fake GitHub of the test harness holds rule sets and answers both reads (section 4.12), so a test that calls `readProtection` against it gives the rule sets to `createFakeGitHub({ rulesets, rulesetsOffered })` or `addRuleset`. `test/core/protection/rulesets.js` has the bodies of the two rule sets of section 5.4, and `serveRulesets(fake, rulesets, { offered })`, which only gives the rule sets to that fake, for the tests that already import it.

### 4.12 `test/harness` (1.3d)

| Export | Output |
| --- | --- |
| `createFixture(options)` | An offline fixture: a temporary bare origin and its main checkout, with its own HOME and git configuration; scripted states (files, commits, branches, task worktrees, a team of 1, 3 or 4 members, a joined clone); `cleanup()`. With `nodeProject: true` its `main` starts from the Node fixture |
| `cleanupFixtures()` | Removes every fixture a test file left behind; `test/harness/setup.js` calls it after each file |
| `isolatedEnv(home, base)` | The environment of a fixture's child processes, from `base` (`process.env` by default): `HOME` and the git and gh configuration of its own, no system git configuration, no inherited `GIT_*` variable, no GitHub token or `GH_*` variable that names a host, repository or configuration, no `HACKWIN_CALLER`, and none of the variables of a CI runner (`GITHUB_*`, `RUNNER_*`, `CI`), so that no test reads the run that tests this repository |
| `FIXTURE_IDENTITY` | `{ name, email }` of every commit a fixture makes |
| `createFakeGitHub(state)` | `{ executor, state, on(request, handler), as, calls, unhandled, find, addCheckRun, setBranch, addRuleset }`: an in-memory repository behind the executor seam that answers the requests of section 4.3, and the rule set requests in the form `docs/verification.md` recorded (rows 5 and 6): `GET` and `POST repos/{owner}/{repo}/rulesets` (the list leaves out the rules), `GET`, `PUT` and `DELETE repos/{owner}/{repo}/rulesets/<id>`, and `GET repos/{owner}/{repo}/rules/branches/<branch>`. `state.rulesets` holds the rule sets, given as `rulesets` at creation; with `rulesetsOffered: false` every rule set request answers HTTP 403 with `RULESETS_NOT_OFFERED`, as on `hackwin-fixture-private`. A rule set read gives `current_user_can_bypass` as the rule set sets it, else `always` for an admin of the repository when the admin role is a bypass actor, and `never` otherwise. A pull request of the state takes `headRepo`: the fake's repository by default, a fork's `owner/name`, or null for a deleted fork (`head.repo` null); the head of a fork's pull request does not follow the fake's branch of the same name. A lane registers handlers for its own calls from its own test files. The other members are in the table below |
| `httpError(status, message)`, `rawResult({ code, stdout, stderr })`, `FakeGitHubError` | For a handler: throw an HTTP error, as gh prints it; return gh's exact output; the class of `httpError` |
| `DEFAULT_FAKE_REPO`, `RULESETS_NOT_OFFERED` | `hackwin-test/app`, the repository of a fake whose state names none; GitHub's message where it offers no rule sets (`docs/verification.md` E3) |
| `withFixtureRepo(name, scenario, options)` | Runs a scenario on a fixture repository (section 6.4) under its lock, after the reset, and returns the scenario's result. `options`: `lockTimeoutMs`, how long to wait for another session's lock; `stateDir`, where the locks and run logs live; `logFile`, the run log in place of `<stateDir>/logs/<repository>.log`. The run log records every gh call, with gh's whole error output for a failed one, and a failed run's full error (stack, status, gh's output, causes). Before a run writes its log, it keeps the log of an earlier run that did not pass, failed or interrupted, as `<log name>.failed-<start of that run>.log` in the same directory; the log of a passed run is replaced. `executors`, `{ lead, builder1 }` in place of the real gh, for the harness's own tests against the fake GitHub; `accounts`, the accounts the scenario acts as, `['lead', 'builder1']` by default. Only these are checked before the reset, so a scenario with `accounts: ['lead']` needs only the Lead's gh login and no `HACKWIN_TEST_BUILDER_TOKEN`, and acting as builder1 in it throws; `logins.builder1` is then the name of `accounts.builder1`, not checked |
| `inspectFixtureRepo(name, options)` | Reads the state of a fixture repository as the Lead, under its lock and through the guard, without a reset and without changing anything: `{ state, problems, calls }`, where `problems` lists what differs from the state a reset leaves. `options`: `lockTimeoutMs`, `stateDir` and `executors`, as for `withFixtureRepo` |
| `nodeProjectFiles()` | The files of the Node fixture, each path relative to the project root with its content. The Node fixture is every file of the tree of the reset commit (section 6.4), kept as one text file, `test/harness/node-project.yml`, so that none of its files, such as `CLAUDE.md` or `.claude/`, acts as agent instructions or settings inside this repository |
| `writeNodeProject(dir)` | Writes every file of the Node fixture into `dir`, a test's own directory |
| `packNodeProject(dir)` | The text of `node-project.yml` for the files of `dir`, which must all be UTF-8 text: it makes the file again from a checkout of a new reset commit |
| `NODE_PROJECT_FILE` | The absolute path of `test/harness/node-project.yml` |
| `accounts` | `lead`, `builder1`, `builder2`, `solo` (section 6.4), each `{ key, login, live, description }`; `live` is true when a test may act as the account on real GitHub |
| `accountOf(key)` | The account of a key, or an error that names the known keys |
| `builderToken()`, `TOKEN_VARIABLE` | The token of `builder1`, or null when it was not set; `HACKWIN_TEST_BUILDER_TOKEN`, the variable it comes from (section 6.1). `test/harness/setup.js` moves the token out of `process.env` before each test file |
| `redact(text, token)` | The text with the token of `builder1` replaced by `[HACKWIN_TEST_BUILDER_TOKEN]` |
| `BUILDER3_LOGIN`, `NAME_ONLY_LOGINS` | `hackwin-test-builder3`; `[maljul, hackwin-test-builder3]`, the logins used only as names, which the guard never lets a real call invite, assign or mention (section 6.4) |
| `teamConfig(size)`, `TEAM_SIZES` | The team configuration of a fixture of 1, 3 or 4 members (`TEAM_SIZES`): `{ size, hackwin, owners, members, answers, files }`, with `answers` for `setup --answers` (CM11) and `files` as YAML text |
| `teamMembers(size)`, `hackwinObject(size)`, `ownersObject()` | The members of a team of this size; `hackwin.yml` of the Node fixture for it, pinned to the running version; `owners.yml` of the Node fixture; all as objects |
| `yaml(value)` | The YAML text of a value |
| `FIXTURE_REPOS`, `fixtureRepo(name)` | The four fixture repositories of section 6.4, each `{ name, repo, visibility, resetSha, usedBy, protectionRefused }`; the one of a name, given with or without the owner, and an error for any other repository, `hackwin-sandbox` above all |
| `FIXTURE_OWNER`, `RESET_SHA`, `RESET_TREE`, `SANDBOX` | `Bartek201301`; the reset commit of section 6.4; its tree, which the Node fixture copies; `hackwin-sandbox`, which no automated test touches |

The members of the fake GitHub besides `executor`, `state` and `on`:

| Member | Content |
| --- | --- |
| `as(login)` | An executor that calls as another login, for example `accounts.builder2.login` |
| `calls` | Every call, in order: `{ login, args, method, endpoint, body, code }`, with gh's exit code |
| `unhandled` | The calls that no handler answered |
| `find(number)` | The issue or pull request with this number, or undefined |
| `addCheckRun(sha, run)` | Adds a check run for a commit |
| `setBranch(branch, sha)` | Points a branch at a commit, as a push does |
| `addRuleset(body)` | Adds a rule set as `POST .../rulesets` creates it, with an `id` when the body has none, and returns it |

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

The check names are steps 3 to 8 of `ship`, listed as `CHECK_NAMES` in `src/core/state`: `scope`, `secrets`, `format`, `generated`, `check` and `acceptance`. Every result is `passed`, except that `generated` is `skipped` when `hackwin.yml` sets no `commands.generate` (`SKIPPABLE_CHECKS`). A record never holds a failed check. A record is green (`isGreen`) only when it holds all six checks with these results, so a record that lacks one, for example one with a single passed check, does not let the `pre-push` hook pass.

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

`setup` creates the rules for everyone as the rule set `hackwin-branch-rules` and the update restriction as its own rule set `hackwin-update-restriction` (A32). `docs/verification.md` (rows 5 and 6) confirmed this mechanism, so the names stay. Both rule sets target the default branch (`conditions.ref_name.include: ["~DEFAULT_BRANCH"]`) with `enforcement: active`:

| Rule set | Rules | `bypass_actors` |
| --- | --- | --- |
| `hackwin-branch-rules` | `pull_request` with 0 required approvals; `required_status_checks` with `[{"context": "hackwin", "integration_id": 15368}]` and `strict_required_status_checks_policy: false`; `non_fast_forward`; `deletion` | `[]` |
| `hackwin-update-restriction` | `update` with `update_allows_fetch_and_merge: false` | `[{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]` |

The reader (section 4.11) computes the state from the rules in force, not from these names:

| State | When |
| --- | --- |
| `full-restricted` | The conditions of `full`, and `updateRestricted` |
| `full` | `pullRequestRequired`, `checkRequired`, `forcePushBlocked`, `deletionBlocked` and `appliesToAdmins` |
| `soft` | Anything less. Also where GitHub offers no rule sets: on `hackwin-fixture-private`, a private repository of a personal account without GitHub Pro, `GET .../rules/branches/main` answered HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." (12 October 2026). The reader reads an HTTP 403 whose message contains "make this repository public to enable this feature" as `soft` |

### 5.5 Pull request body and task link

- `ship` builds the body from the project's `.github/pull_request_template.md`: it replaces the first line that is exactly `Closes #` (trailing spaces allowed) with `Closes #<N>`. Without such a line it puts `Closes #<N>` and an empty line before the template; without a template the body is `Closes #<N>`.
- The task link parser (`src/core/tasks`) accepts a body with exactly one line that matches `^Closes #(\d+)\s*$`, whose number equals the issue of the branch `task/<N>-<slug>`, and no other GitHub closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved) followed by an issue reference anywhere in the body, so that a merge closes exactly the task (T1, E11).
- A branch that starts with `spike/` is refused (E16).

### 5.6 Other local paths

`prompts/<issue>.md` belongs to lane B (`take`); everything under `gate/` belongs to lane C (6.4). `src/core/state` only names these paths.

`logs/` (`statePaths(dir).logs`) holds the logs of the project commands that a command runs, one directory per command. `ship` writes the logs of its steps 7 and 8 to `logs/ship/<issue>/check.log` and `logs/ship/<issue>/acceptance.log` (`shipLogPath(dir, issue, step)`), replaced on each run; they belong to lane B. The git common directory belongs to the member, so these logs are in no directory that other users of the machine share. `ship` writes them there since #57 (PR #68), no longer under `$TMPDIR/hackwin-ship/`.

### 5.7 Gate comment marker

The Gate, the Lead and the Lead's builder sessions all write on GitHub as the Lead's account (A5), so the author of a comment does not tell the Gate's comments from the Lead's. Every comment the Gate writes on a pull request (G21, A31) therefore starts with a marker line that names the pull request, the full head SHA, the stage and the result (scope change on #22, PR #64). The Gate (lane C) writes it; `take` (lane B) and the Gate itself read it.

```text
<!-- hackwin:gate-comment pr=<N> sha=<full head SHA> stage=<stage> result=<result> -->
```

- `pr`: the pull request's number. `sha`: the full head SHA of the run, 40 lower-case hex digits, or 64 in a SHA-256 repository. `stage`: the stage where the run failed, by its name in `STAGES` of `src/commands/gate/stages.js`. `result`: the digest result of 9.6 that the run ended with. A stage and a result are lower-case words joined by single hyphens.
- The Gate writes a comment only when a run fails (`endFailed` in `src/commands/gate/pulls.js`), so a marker carries one of these stages and results today, since #23 (PR #69):

  | `stage` | Stage | `result` |
  | --- | --- | --- |
  | `task-link` | 2 | `failed` |
  | `scope` | 3 | `scope-violation` |
  | `secrets` | 4, and the scan at intake | `failed` |
  | `conflicts` | 6 | `needs-owner` |
  | `merge-test` | 7 | `failed`; `flaky` when a known flaky test still fails after its reruns; `needs-owner` when the merge conflicts although stage 6 found no conflict |
  | `ci` | 8 | `failed`, also after `gate.ci_timeout_minutes`; `flaky` when a known flaky test fails after the last rerun |
  | `merge` | 10 | `failed` |

  The other stages of `STAGES` end no run with a failure, so no marker names them: `fetch` (1) and `freshness` (9) try their fetch again until it succeeds or the run stops; `after-merge` (11) tries its GitHub calls again the same way and reports every other problem as an attention item; `gated-paths` (5) raises attention items and the run goes on. The digest's other results, `merged` and `requeued`, come with no comment. `parseGateMarker` accepts any stage and result of the form above, so a reader keeps working when the Gate adds one.
- GitHub does not render an HTML comment, and the API returns the body as written.
- Only the exact marker counts: at the very start of the body, with no space, tab, byte order mark or other character before it; the four keys once each, in this order, with single spaces; nothing else up to the end of its line (`\n`, `\r\n` or the end of the body). A reply that quotes a Gate comment, or a marker in a code block, is no Gate comment.

`src/commands/gate/comment.js` exports:

| Export | Inputs | Output and errors |
| --- | --- | --- |
| `MARKER_NAME` | | `hackwin:gate-comment` |
| `formatGateMarker({ pr, sha, stage, result })` | A `GateMarker` | The marker line, without a line end. `TypeError` when `pr` is not a positive integer of at most 10 digits, `sha` is not a full SHA, or `stage` or `result` is not such a word |
| `parseGateMarker(body)` | A comment body, or null or undefined | The `GateMarker` `{ pr, sha, stage, result }` with `pr` a number, or null when the body does not start with the exact marker. It takes time linear in the body's length |
| `latestGateComment(comments, { pr, lead })` | `Comment[]` oldest first, as `listComments` returns them (section 4.3); the pull request's number; `lead` is `team.lead` of `hackwin.yml` | `{ comment, marker }` of the newest comment whose author is `lead`, compared without case, and whose marker names `pr`; or null. A marker in a comment of any other account never counts |

The module's `failureComment` builds the whole body of a failed run's comment, marker first; only the Gate uses it.

- **Whose marker.** A marker is the Gate's only when the comment's author is `team.lead`. A marker that the Lead types by hand under that account cannot be told apart from the Gate's (A5). A caller that acts on a Gate comment therefore also compares `marker.sha` with the head SHA it acts on.
- **Who reads it.** `take` (#57, lane B) reads the Gate's comment of a pull request with `latestGateComment`, in `gateComment` of `src/commands/take/resume.js` (PR #68), and uses it only when `marker.sha` is the pull request's current head SHA (scope change on #57). Otherwise its fix prompt quotes no Gate comment and tells the session to ask the Lead what the Gate reported. The Gate's restart (#24, lane C) recognizes its own comments the same way, so that no comment is repeated (AC22): by the marker in comments by `team.lead` (`latestGateComment`, or `parseGateMarker` with the same author check), never by the author alone or by a marker in another account's comment, and it compares `marker.sha` with the head SHA where it acts on one.

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

- Before a test run the harness resets a fixture repository as the Lead (`test/harness/reset.js`), in this order: it deletes every rule set of the repository (an HTTP 403 is accepted on `hackwin-fixture-private` only, where GitHub offers no rule sets), deletes every branch rule on every pattern, closes every open pull request and then every open issue, unpins every pinned issue, deletes every branch but `main`, deletes every label, and resets `main` to the recorded commit `bf2af037ab756d7051e35bdd7e3f18c92eda45b5` (all four; read back from GitHub on 10 October 2026), creating `main` when it is missing. The rules go first, so that no rule blocks a branch deletion or the reset of `main`. A deletion that GitHub answers with HTTP 404 counts as done, for a rule set, a branch or a label: the object is gone, as after an earlier attempt whose answer was lost. So does HTTP 422 "Reference does not exist" for a branch, the fake GitHub's answer for a branch that does not exist. Each such deletion is named in the report's `accepted`. A gh call of the reset that fails without an HTTP status (a network error, a timeout, a cut response such as "unexpected end of JSON input") or with a 5xx is made again, up to 4 times in all, after waits of 1, 2 and 4 seconds (`RESET_ATTEMPTS`, `RETRY_DELAY_MS`); a refusal of the guard and every other status fail at once. Then it reads the whole state back and fails when it does not hold: `main` at the recorded commit as the only branch, and no open issue or pull request, label, rule set, branch rule or pinned issue. The reset does not touch repository settings: secret scanning push protection, the default branch, collaborators and invitations stay as they are. A lock per repository keeps two sessions off the same repository.
- No repository is ever deleted, and the `delete_repo` scope is never requested. Automated tests never touch `hackwin-sandbox`; it is for the human's live tests.
- Accounts: `lead` is the gh login of the machine; `builder1` is `test-bot-builder`, with the token of section 6.1; `builder2` is `maljul`, a real teammate's account used only as a name in team configurations: it is never invited to any repository, and nobody acts as it on real GitHub, so every scenario in which it acts runs against the fake GitHub (plan section 9, decision 2; `AGENTS.md`, "GitHub repositories"); `solo` is the Lead's account.
- `hackwin-test-builder3` is the third builder of a team of four, a name only like `maljul`: it is never invited, assigned or mentioned on real GitHub, and every scenario in which it acts runs against the fake GitHub (plan section 9, decision 2). GitHub answered 404 for this login on 12 October 2026 (PR #40), so nobody owns it today and anyone may register it later. The harness guard refuses, before gh runs, any call that would invite, assign or mention either name-only login (`NAME_ONLY_LOGINS` in `test/harness/accounts.js`).
