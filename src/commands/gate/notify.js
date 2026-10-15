// The operating system notification for a secret (G26) [D16], with the commands that
// docs/verification.md row 18 chose: `osascript` with `display notification` on macOS, and
// `notify-send` on Linux when it is present and succeeds. Windows through WSL offers no built-in
// path. There, as wherever the command is missing or fails, the Gate rings the terminal bell in
// its own terminal instead. Nothing enters an agent conversation (G1).

import { release as osRelease } from 'node:os'
import { exec } from '../../core/runtime/index.js'

/** The longest wait for the notification command. */
const NOTIFY_TIMEOUT_MS = 10_000

/**
 * @typedef {object} Notification
 * @property {string} title
 * @property {string} message
 */

/**
 * @typedef {object} Notified
 * @property {boolean} shown True when the operating system took the notification.
 * @property {string | null} reason Why it was not shown, when it was not.
 */

/** @typedef {(notification: Notification) => Promise<Notified>} Notifier */

/**
 * @typedef {object} NotifyHost
 * @property {string} [platform] `process.platform`
 * @property {string} [release] `os.release()`: the kernel of WSL names Microsoft.
 * @property {Record<string, string | undefined>} [env]
 */

/**
 * The command that shows a notification on this machine.
 * @param {Notification & Required<NotifyHost>} host
 * @returns {{ file: string, args: string[] } | { unsupported: string }}
 */
export function notificationCommand({ title, message, platform, release, env }) {
  if (platform === 'darwin') {
    // The texts are arguments, so no quoting inside AppleScript is needed.
    return {
      file: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        message,
      ],
    }
  }
  if (platform === 'linux') {
    if (/microsoft/i.test(release) || env.WSL_DISTRO_NAME) {
      return { unsupported: 'Windows through WSL offers no notification command' }
    }
    return { file: 'notify-send', args: ['--', title, message] }
  }
  return { unsupported: `HackWin knows no notification command on ${platform}` }
}

/**
 * A notifier that runs the notification command of this machine.
 * @param {NotifyHost} [host]
 * @returns {Notifier}
 */
export function createNotifier(host = {}) {
  const { platform = process.platform, release = osRelease(), env = process.env } = host
  return async ({ title, message }) => {
    const command = notificationCommand({ title, message, platform, release, env })
    if ('unsupported' in command) return { shown: false, reason: command.unsupported }
    try {
      const result = await exec(command.file, command.args, { env, timeoutMs: NOTIFY_TIMEOUT_MS })
      if (result.code === 0) return { shown: true, reason: null }
      const last = result.tail.filter((line) => line.trim() !== '').at(-1)
      const ended = result.timedOut ? 'timed out' : `exited with code ${result.code}`
      return { shown: false, reason: `${command.file} ${ended}${last ? `: ${last.trim()}` : ''}` }
    } catch (error) {
      return { shown: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}
