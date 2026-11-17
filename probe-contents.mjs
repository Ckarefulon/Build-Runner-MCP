import { createClient } from './src/github.js'

// Fallback transport under test: PUT /contents/<path> on a branch. Different
// endpoint, different body shape — if a proxy is choking on POST /git/blobs
// specifically, this path should still work.
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const OWNER = 'Ckarefulon'
const REPO = 'Build-Runner'
const BRANCH = `br-probe/contents-${Date.now().toString(36)}`

const patch = Buffer.alloc(37_006, 0x41)

// 1) bind a branch to an existing commit
const main = await client.resolveCommit(OWNER, REPO, 'main')
await client.upsertRef(OWNER, REPO, BRANCH, main.sha, { force: true })
console.log('branch ready at', main.sha.slice(0, 7))

// 2) write the file through the contents API
try {
  const res = await client.putFile(OWNER, REPO, '.build-runner/workspace.patch', {
    text: patch.toString('base64'),
    message: 'probe contents transport',
    branch: BRANCH,
  })
  console.log('putFile ok, commit:', String(res.commit?.sha).slice(0, 8))
} catch (error) {
  console.log('putFile FAIL:', error.message.split('\n')[0].slice(0, 140))
}

// 3) read it back through the raw endpoint the runner uses
try {
  const raw = await client.request(
    'GET',
    `/repos/${OWNER}/${REPO}/contents/.build-runner/workspace.patch?ref=${encodeURIComponent(BRANCH)}`,
    { accept: 'application/vnd.github.raw' }
  )
  console.log('read back bytes:', Buffer.byteLength(String(raw)))
} catch (error) {
  console.log('read back FAIL:', error.message.split('\n')[0].slice(0, 140))
}

await client.deleteRef(OWNER, REPO, `heads/${BRANCH}`).catch(() => {})
console.log('cleaned')
