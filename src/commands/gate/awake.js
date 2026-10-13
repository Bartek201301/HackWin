// Keep the laptop awake while the Gate runs (7.5 step 3, G6), with the commands that
// docs/verification.md row 17 chose: `caffeinate -i -w <Gate pid>` on macOS and `systemd-inhibit`
// on Linux. Both end by themselves when the Gate's process ends, also after a crash. Windows
// through WSL offers no such command, and there, as wherever the command is missing or fails, the
// Gate warns that it cannot prevent sleep (5.6).

import { spawn } from 'node:child_process'
import { release as osRelease } from 'node:os'

/** The name under which `systemd-inhibit --list` shows the Gate's lock. */
export const INHIBITOR_WHO = 'HackWin Gate'

/**
 * @typedef {{ file: string, args: string[] } | { unsupported: string }} KeepAwakeCommand
 */

/**
 * The command that keeps this machine awake until the process `pid` ends.
 * @param {object} host
 * @param {number} host.pid
 * @param {string} host.platform `process.platform`
 * @param {string} host.release `os.release()`: the kernel of WSL names Microsoft.
 * @param {Record<string, string | undefined>} host.env
 * @returns {KeepAwakeCommand}
 */
export function keepAwakeCommand({ pid, platform, release, env }) {
  if (platform === 'darwin') return { file: 'caffeinate', args: ['-i', '-w', String(pid)] }
  if (platform === 'linux') {
    if (/microsoft/i.test(release) || env.WSL_DISTRO_NAME) {
      return { unsupported: 'Windows through WSL offers no command that keeps the laptop awake' }
    }
    return {
      file: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        `--who=${INHIBITOR_WHO}`,
        '--why=The Gate tests and merges pull requests while it runs',
        '--mode=block',
        'sh',
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`,
      ],
    }
  }
  return { unsupported: `HackWin knows no command that keeps a ${platform} machine awake` }
}

/**
 * @typedef {object} KeepAwake
 * @property {boolean} active True while the command runs.
 * @property {string | null} command The command line, when it started.
 * @property {string | null} reason Why the machine is not kept awake, when it is not.
 * @property {() => void} stop Ends the command; the Gate calls it when it stops.
 */

/**
 * @typedef {object} KeepAwakeOptions
 * @property {number} pid The process to outlive: the Gate's.
 * @property {(reason: string) => void} onLost Called when the command ends while the Gate runs.
 * @property {string} [platform]
 * @property {string} [release]
 * @property {Record<string, string | undefined>} [env]
 */

/** @typedef {(options: KeepAwakeOptions) => Promise<KeepAwake>} StartKeepAwake */

/**
 * Start the command that keeps the machine awake. It runs in its own process group, so that
 * stop() ends it together with the command it watches.
 * @type {StartKeepAwake}
 */
export async function startKeepAwake({
  pid,
  onLost,
  platform = process.platform,
  release = osRelease(),
  env = process.env,
}) {
  const command = keepAwakeCommand({ pid, platform, release, env })
  if ('unsupported' in command) {
    return { active: false, command: null, reason: command.unsupported, stop: () => {} }
  }
  const { file, args } = command
  const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (/** @type {string} */ chunk) => {
    stderr = (stderr + chunk).slice(-500)
  })
  const failure = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null))
    child.once('error', resolve)
  })
  if (failure !== null) {
    const reason =
      /** @type {NodeJS.ErrnoException} */ (failure).code === 'ENOENT'
        ? `${file} is not installed`
        : `${file} did not start: ${/** @type {Error} */ (failure).message}`
    return { active: false, command: null, reason, stop: () => {} }
  }

  const keepAwake = {
    active: true,
    command: [file, ...args].join(' '),
    reason: /** @type {string | null} */ (null),
    stop() {
      if (!keepAwake.active) return
      keepAwake.active = false
      try {
        process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM')
      } catch {
        // The command has ended already.
      }
      child.stderr.destroy()
    },
  }
  child.once('close', (code, signal) => {
    if (!keepAwake.active) return
    keepAwake.active = false
    const last = stderr.trim().split('\n').pop()
    keepAwake.reason = `${file} exited with ${code === null ? signal : `code ${code}`}${last ? `: ${last}` : ''}`
    onLost(keepAwake.reason)
  })
  return keepAwake
}
