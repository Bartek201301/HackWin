// The `gh` that a hackwin child process meets in the parity scenarios. It sends its arguments,
// its stdin and GH_REPO to the bridge of the test process (world.js), which answers through the
// test's executor: the fake GitHub offline, or the harness's guarded executor of the Lead on a
// fixture repository. It prints the answer as gh would and exits with gh's exit code, so the
// child process of a wrapper reaches GitHub only as the in-process commands of the test do.

import { connect } from 'node:net'

const address = process.env.HACKWIN_TEST_GH_BRIDGE ?? ''
const [host, port] = address.split(':')
if (!host || !port) {
  process.stderr.write('gh of the parity scenarios: HACKWIN_TEST_GH_BRIDGE is not set\n')
  process.exit(1)
}

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

const request = {
  args: process.argv.slice(2),
  input: input === '' ? undefined : input,
  env: process.env.GH_REPO ? { GH_REPO: process.env.GH_REPO } : {},
}

const answer = await new Promise((resolve, reject) => {
  let text = ''
  const socket = connect({ host, port: Number(port) }, () => {
    socket.end(`${JSON.stringify(request)}\n`)
  })
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => (text += chunk))
  socket.on('error', reject)
  socket.on('end', () => {
    try {
      resolve(JSON.parse(text))
    } catch (error) {
      reject(error)
    }
  })
}).catch((error) => ({
  code: 1,
  stdout: '',
  stderr: `gh of the parity scenarios: the bridge at ${address} did not answer: ${error.message}\n`,
}))

process.stdout.write(answer.stdout ?? '')
process.stderr.write(answer.stderr ?? '')
process.exitCode = answer.code ?? 1
