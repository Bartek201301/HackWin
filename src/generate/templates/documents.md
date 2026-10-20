# The project documents

Six documents under `docs/hackwin/` hold the plan of the project. This guide says what each one holds, why it matters, who writes it and when, with suggested headings. `setup` creates only this guide: the Lead or the planning session creates each document when they start writing it.

| Document | Holds | Write it |
| --- | --- | --- |
| `prd.md` | What you build, for whom, and what the demo shows | First |
| `spec.md` | The points of contact in detail | Before the foundation task |
| `architecture.md` | The parts, who owns which directory, the contracts and mocks | Before the foundation task |
| `design.md` | The visual design | Before the foundation task; skipped without a user interface |
| `epics.md` | The whole project as epics, one ownership role each | Before the foundation task, updated before each wave |
| `non-code.md` | The deliverables outside the code and the external resources | At the start, kept current until the submission |

Two rules hold for all six:

- **The Lead owns every document.** The Lead writes them with the planning session. A builder who needs a change asks the Lead.
- **Prose may stay general. The points of contact must be detailed**: types, API, database schema and acceptance criteria. They go into `spec.md`.

## `prd.md`: product requirements

**What it holds.** The challenge, the problem and the users, what the demo shows, and what you will not build.

**Why it matters.** Every other document and every task follows from it. The list of what is out of scope settles arguments about new features before they cost time.

**Who writes it.** The Lead, with the planning session.

**When.** First, right after the start, before the foundation task. General prose is enough here; the points of contact belong in `spec.md`.

**Suggested headings.**

- Challenge: the challenge as the event states it.
- Problem and users
- What the demo shows: the steps of the demo, in order.
- Out of scope

## `spec.md`: specification

**What it holds.** The points of contact between the roles, in detail: types, API, database schema and acceptance criteria.

**Why it matters.** Parallel work depends on it. Each role builds against these contracts, and against a mock of the other side, before the other side exists. A point of contact left vague breaks when the parts meet.

**Who writes it.** The Lead, with the planning session. The contract files themselves live in the repository and belong to the shared role.

**When.** Before the foundation task, which turns it into contract files. Once the foundation is merged, the contracts are fixed: only the Lead changes them, through a task of the shared role.

**Suggested headings.**

- Types: every field with its type.
- API: every endpoint or function with its input, its output and its errors.
- Database schema: every table with its columns and keys.
- Acceptance criteria: what a test checks for each feature.

## `architecture.md`: architecture

**What it holds.** How the parts fit together: the architecture, the directory layout and ownership, and the contracts and mocks. General prose is enough; the contracts themselves are in `spec.md`.

**Why it matters.** Every directory has one ownership role, so builders work in parallel without editing the same files. The mocks let a role that consumes a contract start before the role that provides it has finished.

**Who writes it.** The Lead, with the planning session.

**When.** Before the foundation task, together with `spec.md`. The foundation task sets the final `owners.yml` from it.

**Suggested headings.**

- Architecture: the parts and how they talk to each other.
- Directory layout and ownership: one ownership role per directory, and what each role builds. The map itself is `owners.yml`.
- Contracts and mocks: where the contract files live, and the mock each consuming role works against until the provider exists.

A project made from an earlier HackWin template has this content in `design.md`. HackWin never moves or rewrites a document, so it stays there.

## `design.md`: visual design

**What it holds.** How the product looks and reads: the colors, the fonts, the style of components, the tone of the text, and reference images or links.

**Why it matters.** Every builder's agent builds screens on its own. Without one written design, each screen looks different and the demo looks stitched together.

**Who writes it.** The Lead, with the planning session. A member with an eye for design may make the choices; the Lead writes them down.

**When.** Before the foundation task. The visual tokens (colors, fonts, sizes, spacing) go into shared code in the foundation task, so that every role uses the same ones. After that, a change to them is a task of the shared role.

A project without a user interface skips this file.

**Suggested headings.**

- Colors: the name, the value and the use of each one.
- Fonts: the families, sizes and weights.
- Components: the style of buttons, inputs, cards and lists; spacing, corners and shadows.
- Tone of the text: how the product talks to its users, and words to use or avoid.
- References: images or links that show the look you want.

## `epics.md`: epics

**What it holds.** The whole project as an outline of epics, each with one ownership role.

**Why it matters.** It is the plan of the whole event on one page. Only the next wave becomes task issues; the rest stays here as an outline, so the plan can change without closing issues.

**Who writes it.** The Lead, with the planning session.

**When.** Before the foundation task, so that the roles of the final `owners.yml` fit the epics. Update it before each new wave.

**Suggested headings.** One level 2 heading per epic, then a line `Role: <ownership role>`, then free text. Example:

```markdown
## Epic name
Role: workbench

What this epic delivers, in a few sentences.
```

## `non-code.md`: outside the code

**What it holds.** The deliverables outside the code and the external resources the project needs: accounts, services and data.

**Why it matters.** The judges see the demo video, the pitch and the submission. Written down at the start, each one gets a person and a time before the last hour.

**Who writes it.** The Lead, with the planning session.

**When.** At the start, with `prd.md`. The external resources come from your preparation (`before-the-event.md`). Keep it current until the submission.

Name keys only: secret values go into `.env.local`, never into this file. This file is committed, and a public repository shows it to everyone.

**Suggested headings.**

- Deliverables: the demo video, the pitch, the presentation and the submission, each with who makes it and by when.
- External resources: the accounts, services and data, with the names of their keys.
