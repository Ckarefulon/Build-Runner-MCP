/**
 * Tests for the two-transport patch publish.
 *
 * The field failure: `POST /git/blobs` returned 502 on every attempt from
 * inside the MCP process, while the identical request succeeded from a
 * standalone script. Whatever the cause (proxy shape, connection reuse), the
 * tool must not be single-point-of-failure on one endpoint — so a second,
 * differently-shaped transport is tried before giving up.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishPatchToEngine } from '../src/patch.js'

const OWNER = 'o'
const REPO = 'r'
const BRANCH = 'br-patch/o-r'
const PATCH = Buffer.from('diff --git a/x b/x\nnew file mode 100644\n+hello\n')

/** Client whose git-data path fails the way the proxy does. */
function clientWithGitDataFailure({ contentsWorks = true } = {}) {
  const calls = []
  return {
    calls,
    resolveCommit: async () => {
      calls.push('resolveCommit')
      return { sha: 'c'.repeat(40), tree: { sha: 't'.repeat(40) } }
    },
    publishBlobFile: async () => {
      calls.push('publishBlobFile')
      const error = new Error('POST /repos/o/r/git/blobs 返回 502：Upstream request failed')
      error.status = 502
      throw error
    },
    upsertRef: async (_o, _r, branch, sha) => {
      calls.push(`upsertRef:${branch}`)
      return { branch, sha }
    },
    putFile: async (_o, _r, path, { text, branch }) => {
      calls.push(`putFile:${path}:${branch}`)
      if (!contentsWorks) {
        const error = new Error('putFile 502：Upstream request failed')
        error.status = 502
        throw error
      }
      // Contents transport carries base64 text.
      assert.match(text, /^[A-Za-z0-9+/=]+$/, 'contents transport must send base64')
      assert.equal(Buffer.from(text, 'base64').toString(), PATCH.toString())
      return { commit: { sha: 'k'.repeat(40) } }
    },
  }
}

test('uses the git-data transport when it works', async () => {
  const client = {
    publishBlobFile: async () => ({ branch: BRANCH, sha: 'a'.repeat(40) }),
    resolveCommit: async () => ({ sha: 'c'.repeat(40) }),
    upsertRef: async () => ({}),
    putFile: async () => {
      throw new Error('contents transport must not be used as the happy path')
    },
  }

  const result = await publishPatchToEngine(client, {
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    patch: PATCH,
  })

  assert.equal(result.transport, 'git-data')
  assert.equal(result.branch, BRANCH)
})

test('falls back to the contents transport when git-data 502s', async () => {
  const client = clientWithGitDataFailure()

  const result = await publishPatchToEngine(client, {
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    patch: PATCH,
  })

  assert.equal(result.transport, 'contents', 'must switch transport')
  assert.equal(result.encoded, true, 'contents transport stores base64')
  assert.ok(
    client.calls.includes(`putFile:.build-runner/workspace.patch:${BRANCH}`),
    'must write through the contents API on the same branch'
  )
  // The branch must exist before a file can be put on it.
  assert.ok(
    client.calls.some(c => c.startsWith('upsertRef:')),
    'must create/reset the branch first'
  )
})

test('reports both failures with actionable advice', async () => {
  const client = clientWithGitDataFailure({ contentsWorks: false })

  await assert.rejects(
    () =>
      publishPatchToEngine(client, {
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        patch: PATCH,
      }),
    error => {
      assert.match(error.message, /两种传输方式都失败了/)
      assert.match(error.message, /git-data:/, 'must name the first attempt')
      assert.match(error.message, /contents:/, 'must name the second attempt')
      assert.match(error.message, /代理|直连/, 'must suggest what to try next')
      return true
    }
  )
})

test('a non-502 git-data failure still triggers the fallback', async () => {
  // Any failure on the primary path should try the alternative; the caller's
  // build matters more than which endpoint ends up carrying the bytes.
  const client = {
    publishBlobFile: async () => {
      throw new Error('boom')
    },
    resolveCommit: async () => ({ sha: 'c'.repeat(40) }),
    upsertRef: async () => ({}),
    putFile: async () => ({ commit: { sha: 'k'.repeat(40) } }),
  }

  const result = await publishPatchToEngine(client, {
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    patch: PATCH,
  })
  assert.equal(result.transport, 'contents')
})
