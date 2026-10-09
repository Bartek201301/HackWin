# HackWin PRD: changelog of revision 3

Revision 2 (9 October 2026) to revision 3 (9 October 2026). Inputs: the team decisions on revision 2, applied as D9 to D19, and two additions (GitHub push protection, a build brief for Phases 0 and 1).

## Size

| Document | Words |
| --- | --- |
| `HackWin-PRD.md`, revision 2 | 40,998 |
| `HackWin-PRD.md`, revision 3 | 41,957 |
| `HackWin-build-phase-0-1.md`, new | 24,656 |

The PRD grew by 959 words although the cross-phase upgrade rules and the open question table were removed. The growth comes from the eleven new decision rows, three new acceptance criteria parts (AC79, AC80, the AC45 addition), G26, two rows in 5.6, setup step 13, and C26 to C28.

## Decisions applied

| # | Decision | Sections changed |
| --- | --- | --- |
| D9 | Planning by hand in Phase 1 is accepted; `tasks` stays in Phase 2 | 0, 20.1, 20.3 I2, K15 |
| D10 | A project stays on the phase it started with; only bug fix releases of that phase during a project | 0, 2.2 (new non-goal), 2.4, 5.3 (freeze row), CM12, 7.1 (`--regenerate`), 7.7 (failure), 10.2, 18.3 C28, 18.4 A17 and A60, 20 intro, 20.3 I3, I11, I13, 20.6 (rewritten), AC45, AC76, AC77 |
| D11 | Release 1 is two repositories | 0, 20.1, 18.4 A59 (reduced to the template details), AC64 |
| D12 | The Lead works with Claude Code; `setup` refuses `codex` for the Lead | 0, 1.1, 3.2, 5.4, 6.1 (schema comment, validation rule), 7.1 step 2, 10.4, 10.6 (Codex Lead gap removed), 15, 17.4, 18.3 C26, A62, AC64, AC76 |
| D13 | Mechanical conflict script stays in Phase 3 | 0, 9.3, 20 intro, A56 |
| D14 | Approvals as labels are enough for v1 | 0, 10.6 (gap row kept and marked accepted) |
| D15 | Preparation guide recommends an organization owned repository | 0, 5.6 (verify item), 6.4, 10.6, AC64 |
| D16 | Operating system notification for a found secret, terminal bell as fallback | 0, 5.6, G1, G26 (new), 7.5, 9.6, K11, 15, 18.3 C8, C24, C27, 19 S6 (narrowed), A56, AC35, AC79 (new) |
| D17 | Migration applied and recorded before `ship` (recommended) | 0, 6.4, 9.5; A57 removed |
| D18 | Q7 to Q10 keep their defaults; terminal mode of `take` is primary | 0, 1.5 F6 and F7, 5.6, 7.7 step 7, 16.3, 18.3 C16 and C17, 19 S10, 20.1 |
| D19 | `setup` enables GitHub secret scanning push protection where offered | 0, 5.6, 6.4, 7.1 step 13 (new) and outputs, 10.5 E6 and the paragraph below the matrix, 10.6, K11, 15, A56, AC80 (new) |

Section 18.2 now states that no question remains open and which decision closed each one. The decision tag convention in section 0 now covers D1 to D19.

## Removed as obsolete

- Every rule that served only a move from one phase's CLI to the next: the freeze tag pushed by hand (5.3, 7.7, I3, 20.6 step 3), the regenerate behavior that added new commands, keys and the Resolver model (7.1), the upgrade sentences of I11 and I13, the cross-phase parts of AC77 and A60.
- The Codex Lead row content of 10.6 and the Codex Lead warning of 7.1 step 2.
- The open question table Q7 to Q17 (18.2) and every reference to it (1.5, 5.6, 9.5, 10.6, 18.3, 19, 20).
- Assumption A57, now decision D17.

## New assumptions the team may overrule

| # | What | Why it was needed |
| --- | --- | --- |
| A60 (extended) | Releases of one phase differ only in the patch number; earlier phases keep receiving patch releases; `status --report` is exempt from the phase check | D10 needs a way for the CLI to tell phases apart. Without the report exception, D10 would contradict I9, which runs the Phase 3 report on an earlier event (C28) |
| A62 (extended) | After refusing `codex` for the Lead, `setup` asks again in an interactive terminal and exits 2 with an answers file | D12 says "refuses and says why" but not what happens next |
| AC79 test method | The notification is observed through a stubbed notifier; its display per platform is checked by inspection | An automated test cannot see a desktop notification on every platform |

## Review findings and fixes

Two reviewers who had not seen the edits checked the work: one compared revision 2 with revision 3 against the decisions, the other compared the build brief with the PRD. Scripted checks: no em or en dashes in either file; every AC from AC1 to AC80 sits in exactly one phase of 20.4; every new identifier is defined once; every reference to a `setup` step number resolves.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | G1 and AC35 said the Gate writes only to its terminal, its files and GitHub, which G26 contradicts | G1 and AC35 now name the notification of G26 |
| 2 | The phase check of CM12 would block the Phase 3 report on an earlier project, which I9 promises | Exception for `status --report` in CM12, I9, A60; new C28; AC45 tests it |
| 3 | Push protection was described as a hard refusal, but a pusher may be able to bypass it | 5.6 adds "whether a pusher can bypass a block"; 10.6 and section 15 say "unless the pusher bypasses the block" |
| 4 | AC80 could not pass: a secret GitHub recognizes never reaches CI or the Gate | AC80 uses a test secret that only HackWin's patterns match |
| 5 | D15 assumed the update restriction exists for organization repositories without a verify item | 5.6 adds that check; 6.4 cites R12 |
| 6 | The `resolver.enabled` comment implied a later switch to true, against D10 | Comment now says false in a project set up before Phase 3 |
| 7 | D10 implied fixes for earlier phases without saying so | 20.6 and A60 state that earlier phases keep patch releases |
| 8 | C24 claimed "no message leaves the Lead's laptop" with a wrong source | Reworded to "no message is pushed to any member" |
| 9 | 1.1 read as if the Lead's tool were a reason for the Codex beta | Split into two sentences |
| 10 | 1.5 still referred to open questions | Clause removed |
| 11 | AC79 covered only intake, while G26 also fires at stage 4 | AC79 covers both and states the test method |
| 12 | Small items: 7.1 outputs lacked push protection, wording of `--regenerate`, E6, D19, validation tag, the lost CoProgrammer context | Fixed; the CoProgrammer note moved to 16.3 |
| 13 | Brief: the manual workflow recipe listed steps the PRD does not state | Now points to the Gate stages of 9.2 |
| 14 | Brief: a Phase 2 exception (empty tests for `foundation`) read as a Phase 1 rule | Marked as arriving with Phase 2 (I15) |
| 15 | Brief: the "later" convention and the non-goals were missing | Added to section 0 and as section 2 |
| 16 | Brief: the migration order read as a rule, not a recommendation | PRD wording restored |
| 17 | Brief: source tags in quoted parts had no legend; [B] could be read as the build brief | Legend added to section 0 |
| 18 | Brief: A38 and A56 missing; A8 attached to the wrong claim; a few PRD phrases cut without reason; the Phase 0 reading list lacked 1.3 and 6.5 | All restored or corrected |
| 19 | Brief: the README command overview is not in the PRD | Kept and labeled as a non-normative aid |

## The build brief

`HackWin-build-phase-0-1.md` keeps the PRD's section numbers and identifiers, quotes the Phase 0 and Phase 1 acceptance criteria and the used assumptions word for word from the PRD, and states that the PRD wins on any difference. It leaves out the source tags outside quoted parts and everything that the PRD places in Phase 2 or Phase 3.

## Remaining questions

None that the inputs cannot settle. The three assumptions in the table above are the points the team should glance at.

## Correction after the Phase 0 build (9 October 2026)

The Phase 0 build agent found that the post-mortem counts 54 launches of the watcher loop, most of them manual restarts, not 54 manual restarts. Sections 1.3, 1.5 (F12), 2.3, 12.2 (M7) and 16.1 of the PRD and section 1.3 of the build brief now say so. No requirement changed.
