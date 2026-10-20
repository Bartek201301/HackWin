// Step 10 of `setup` (7.1), its second half: the members without write access are invited, after
// a typed confirmation (CM11, A47), with `gh api -X PUT repos/{owner}/{repo}/collaborators/<login>`
// (docs/verification.md row 12). A member who can write, or whose invitation waits to be
// accepted, is never invited again (CM3). Where GitHub refuses an invitation, setup prints the
// instruction to invite the member by hand (5.6).

import { RemoteError } from '../../core/runtime/index.js'
import { YES, listText } from './questions.js'
import { writersOf } from './team.js'

/** @import { GitHub } from '../../core/github/index.js' */
/** @import { Questions } from './questions.js' */

/**
 * @typedef {object} Invitations
 * @property {string[]} invited Invited now; each must accept before they can write.
 * @property {string[]} waiting Invited earlier; the invitation waits to be accepted.
 * @property {string[]} declined Without write access, and not invited: the answer was no.
 * @property {Array<{ login: string, reason: string }>} refused GitHub refused the invitation.
 */

/**
 * Invite the members who lack write access, when the Lead confirms it.
 * @param {Questions} questions
 * @param {GitHub} github
 * @param {object} options
 * @param {Array<{ name: string, github: string }>} options.members `team.members`.
 * @param {string} options.repository `owner/name`.
 * @returns {Promise<Invitations>}
 */
export async function inviteMembers(questions, github, { members, repository }) {
  const writers = await writersOf(github)
  const pending = await pendingInvitees(github)
  const lacking = members.filter((member) => !writers.has(member.github.toLowerCase()))
  const waiting = lacking.filter((member) => pending.has(member.github.toLowerCase()))
  const uninvited = lacking.filter((member) => !pending.has(member.github.toLowerCase()))
  /** @type {Invitations} */
  const result = {
    invited: [],
    waiting: waiting.map((member) => member.github),
    declined: [],
    refused: [],
  }
  if (uninvited.length === 0) return result
  if (!(await confirmInvitations(questions, uninvited, repository))) {
    result.declined = uninvited.map((member) => member.github)
    return result
  }
  for (const { github: login } of uninvited) {
    try {
      await github.api(`repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}`, {
        method: 'PUT',
      })
      result.invited.push(login)
    } catch (error) {
      // A refusal (4xx) has the fallback of 5.6; a network or server failure is for --resume.
      if (!(error instanceof RemoteError) || !isClientError(error.status)) throw error
      result.refused.push({ login, reason: error.message })
    }
  }
  return result
}

/**
 * The logins, in lower case, whose invitation to the repository waits to be accepted. An expired
 * invitation does not count: it can no longer be accepted.
 * @param {GitHub} github
 * @returns {Promise<Set<string>>}
 */
async function pendingInvitees(github) {
  const invitations = await github.apiPages('repos/{owner}/{repo}/invitations')
  return new Set(
    invitations
      .filter((invitation) => invitation?.expired !== true && invitation?.invitee?.login)
      .map((invitation) => String(invitation.invitee.login).toLowerCase()),
  )
}

/**
 * The confirmation of the invitations: `invite` of the answers file, or, in a terminal, a typed
 * `yes` after setup has said what it is about to do. Without either, setup invites nobody.
 * @param {Questions} questions
 * @param {Array<{ name: string, github: string }>} members
 * @param {string} repository
 * @returns {Promise<boolean>}
 */
async function confirmInvitations(questions, members, repository) {
  // checkLaterAnswers has made sure that a given answer is true or false.
  if (questions.has('invite')) return questions.given('invite') === true
  if (!questions.interactive) return false
  const who = listText(members.map((member) => `${member.github} (${member.name})`))
  questions.say(
    `setup can invite ${who} to ${repository} with write access; GitHub sends each an invitation to accept`,
  )
  const answer = await questions.ask('Type yes to invite them, or no', {
    fallback: 'no',
    check: () => null,
  })
  return answer.toLowerCase() === YES
}

/**
 * @param {number | undefined} status
 * @returns {boolean}
 */
function isClientError(status) {
  return status !== undefined && status >= 400 && status < 500
}
