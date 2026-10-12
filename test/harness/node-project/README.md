# Project name

<!-- One sentence: what the project does and for whom. Everyone may edit this README (it is on the open list of owners.yml). Write it for the jury. -->

## What it does

## Demo

<!-- Link to the demo video and the live deployment. -->

## How to run

<!-- The install, check and run commands. Secrets come from .env.local, which is never committed; .env.example lists the keys. -->

Node 24, as in CI.

| Command | What it does |
| --- | --- |
| `npm ci` | Clean install from the lockfile |
| `npm run check` | Full check: lint, types, tests, build. Needs no secrets |
| `npm test -- <files>` | Runs only the given test files (all tests without arguments) |
| `npm run format -- <files>` | Formats only the given files |
| `npm run dev` | Starts the dev server |

## Status

<!-- Written by hand: what works and what does not work yet. Keep it true to the code. -->

## Team

<!-- Who holds which ownership role of owners.yml. Exactly one holder per role; the Lead holds the shared role. A role swap changes one line here. -->

| Name | GitHub | Ownership roles |
| --- | --- | --- |
|  |  | shared (Lead) |
|  |  |  |

## How we work

This repository was created from the HackWin template. The rules for every agent are in `AGENTS.md`, the ownership map is `owners.yml`, and the workflow is in `docs/hackwin/`: start with `before-the-event.md`, then `manual-workflow.md`.

License: choose one for your project.
