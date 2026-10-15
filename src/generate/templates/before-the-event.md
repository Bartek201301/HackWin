# Before the event

Preparation decides how fast your team can freeze its contracts and start parallel work. At HackYeah 2026 the contracts were frozen 45 minutes after the start, and that was possible only because research had been done before. Work through this guide the evening before the event, or earlier. The checklist at the end sums it up.

## 1. Read the event's rules

- **AI tools.** Some events forbid AI code generation. Check what your event allows.
- **Code written before the event.** Some events require all code to be written during the event. Check whether this template, your notes and anything else you prepare count as such code. When the rules are unclear, ask the organizers before you start.

HackWin is a tool, not ready project code. It gives the team rules and a workflow; the project's code is written at the event.

## 2. Research, stack and accounts

A fast contract freeze needs these answers before the clock starts:

- **Research.** Learn the problem domain and the services and data you are likely to use. The research skill and the research subagent in this repository answer one question at a time with dated sources.
- **Stack.** Choose the language, framework, database and hosting. Decide the project's install, check, test and format commands. The full check must pass without secrets, because CI and a merge test run without them.
- **Accounts.** Create the accounts for every external service (hosting, database, APIs) and collect the keys. The Lead keeps the secret values in `.env.local`, which is never committed, lists only the key names in `.env.example`, and sends `.env.local` to each member over a private channel.
- **Tools on every machine.** git (the merge recipe needs `git merge-tree --write-tree`, so git 2.38 or later), the GitHub CLI `gh` logged in, write access to the repository, and the member's agent.

## 3. Migrations are never applied on merge

**Warning: the project must not apply migrations automatically on merge.** Some database integrations do this. In this workflow the Lead applies every migration by hand, and an automatic apply would bypass the Lead. Before the event, check every database integration and deployment setting of your stack and switch such behavior off.

The rules for migrations and production config:

- They belong to the Lead. They are additive only, an applied migration file is never edited, and every applied migration is recorded in a ledger file.
- No agent session applies a migration or changes production config, also not outside the repository.
- Recommended order: the Lead reviews the migration, applies it by hand and records it in the ledger, and only then opens the pull request that contains it. An additive migration is safe ahead of the code that needs it, and many projects deploy main automatically, as HackYeah did.

## 4. Where the repository lives

- **Public by default.** The Lead creates the team's repository from this template. A public repository gets GitHub's branch rules for free. Remember that a public repository also exposes a pushed secret at once.
- **Only the Lead's account updates main.** GitHub's documentation ("About rulesets", "Available rules for rulesets") describes a ruleset rule, "Restrict updates", that lets only accounts with bypass permission update a branch. The older setting that restricts who can push is documented only for repositories owned by an organization. Check in the repository's ruleset settings whether GitHub offers you a rule that lets only the Lead's account update main for a repository owned by a personal account. **If it does not, create the repository under an organization** and check there.

## 5. Keep user level tools out of the way

Tools installed at user level (plugins, hooks, frameworks) run in every session of the member who installed them, and they add latency and noise to each one. At HackYeah one framework installed at user level ran only its hooks: none of its commands was used in 50 session transcripts, its hooks raised only false warnings, and an upper bound estimate put its cumulative hook latency at 10 to 15 minutes. This template's committed settings contain only the deny rules for env files. Keep it that way: never enable third party plugins through the committed settings, and install a personal tool only when you know it helps.

## Checklist

- [ ] The event's rules on AI tools and on code written before the event are read, and the team may use this template.
- [ ] The domain is researched; the stack is chosen; the install, check, test and format commands are known.
- [ ] Every account exists; `.env.local` is ready to send; `.env.example` lists the key names.
- [ ] No database integration applies migrations on merge.
- [ ] The repository is created from the template, public, under an account or organization where only the Lead's account can update main.
- [ ] Every member has git, `gh` with write access, and their agent.
- [ ] No third party plugin is enabled through the committed settings.
