// Loaded by Vitest before every test file (vitest.config.js).
//
// - It moves the token of the machine account out of process.env, so no child process of any
//   test inherits HACKWIN_TEST_BUILDER_TOKEN; the harness hands it only to calls of builder1.
// - After the test file it removes every offline fixture the file left behind.

import { afterAll } from 'vitest'
import { captureCredential } from './accounts.js'
import { cleanupFixtures } from './fixture.js'

captureCredential()

afterAll(() => cleanupFixtures())
