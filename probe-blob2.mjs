import { createClient } from './src/github.js'

// Exercise the REAL publishBlobFile path, not a hand-rolled fetch, so any
// difference between the module's request() and a plain fetch shows up.
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const OWNER = 'Ckarefulon'
const REPO = 'Build-Runner'
const BRANCH = 'br-patch/Ckarefulon-Build-Runner-MCP'

const patch = Buffer.alloc(37006, 0x41)
const attempts = []

for (let i = 0; i < 3; i += 1) {
  try {
    const r = await client.createBlob(OWNER, REPO, patch)
    attempts.push(`ok   blob=${String(r.sha).slice(0, 8)}`)
  } catch (error) {
    attempts.push(`FAIL ${error.message.split('\n')[0].slice(0, 140)}`)
  }
}
console.log(attempts.join('\n'))

// And the full publish, which is what the tool actually runs.
try {
  const r = await client.publishBlobFile(OWNER, REPO, {
    branch: BRANCH,
    path: '.build-runner/workspace.patch',
    content: patch,
    message: 'probe',
  })
  console.log('publishBlobFile ok:', r.sha.slice(0, 8))
} catch (error) {
  console.log('publishBlobFile FAIL:', error.message.split('\n')[0].slice(0, 160))
}
