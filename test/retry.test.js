/**
 * Tests for the retry policy.
 *
 * The rule that matters: repeating a write must not corrupt state.
 *   - a blob is content-addressed, so repeating is safe;
 *   - a ref update sets a KNOWN sha, so repeating is safe;
 *   - a commit creates a NEW object each time, so repeating is NOT safe.
 *
 * A proxy 502 ("Upstream request failed") is what triggered the field bug: the
 * ref update was not retried, so a single hiccup failed the caller's build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, GitHubError } from '../src/github.js'

/** Replace global fetch for one test, recording every attempt. */
function withFetch(handler, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {} })
    return handler(url, options, calls.length)
  }
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original
  })
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('a GET is retried on 502 and succeeds', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    (url, options, n) => {
      if (n === 1) return json({ message: 'Upstream request failed for api.github.com.' }, 502)
      return json({ ok: true })
    },
    async calls => {
      const result = await client.getUser()
      assert.equal(result.ok, true)
      assert.equal(calls.length, 2, 'should retry once')
    }
  )
})

test('a blob upload is retried because it is content-addressed', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    (url, options, n) => {
      if (n === 1) return json({ message: 'Upstream request failed' }, 502)
      return json({ sha: 'blobsha' }, 201)
    },
    async calls => {
      const blob = await client.createBlob('o', 'r', 'hello')
      assert.equal(blob.sha, 'blobsha')
      assert.equal(calls.length, 2)
    }
  )
})

test('a ref PATCH is retried — one 502 must not fail the caller', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    (url, options, n) => {
      // First the existence probe, then a 502 on the PATCH, then success.
      if (String(url).endsWith('/git/ref/heads/dev') || /\/git\/ref\/heads\/dev$/.test(String(url))) {
        return json({ object: { sha: 'oldsha' } })
      }
      if (n <= 2) return json({ message: 'Upstream request failed for api.github.com.' }, 502)
      return json({ object: { sha: 'newsha' } })
    },
    async calls => {
      await client.upsertRef('o', 'r', 'dev', 'newsha', { force: true })
      const patches = calls.filter(c => c.method === 'PATCH')
      assert.equal(patches.length, 2, 'the PATCH should be attempted twice')
    }
  )
})

test('a ref CREATION (POST /git/refs) is retried too', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    (url, options, n) => {
      if (String(url).includes('/git/ref/heads/')) return json({ message: 'Not Found' }, 404)
      if (n === 2) return json({ message: 'Upstream request failed' }, 502)
      return json({ ref: 'refs/heads/new' }, 201)
    },
    async calls => {
      await client.upsertRef('o', 'r', 'new', 'sha1', { force: true })
      const posts = calls.filter(c => c.method === 'POST' && String(c.url).endsWith('/git/refs'))
      assert.equal(posts.length, 2)
    }
  )
})

test('a commit is NOT retried, so a lost response cannot duplicate it', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    () => json({ message: 'Upstream request failed' }, 502),
    async calls => {
      await assert.rejects(
        () =>
          client.createCommit('o', 'r', {
            message: 'm',
            tree: 'treesha',
            parents: ['parent'],
          }),
        error => {
          assert.ok(error instanceof GitHubError)
          return true
        }
      )
      const posts = calls.filter(c => c.method === 'POST' && String(c.url).endsWith('/git/commits'))
      assert.equal(posts.length, 1, 'a commit must be attempted exactly once')
    }
  )
})

test('the error message identifies an upstream proxy failure', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    () => json({ message: 'Upstream request failed for api.github.com.' }, 502),
    async () => {
      await assert.rejects(
        () => client.createCommit('o', 'r', { message: 'm', tree: 't', parents: [] }),
        error => {
          assert.match(error.message, /本地代理|网关/, 'must say who returned the 502')
          assert.equal(error.upstream, true)
          return true
        }
      )
    }
  )
})

test('a 404 is surfaced immediately without retrying', async () => {
  const client = createClient({ token: 'x' })
  await withFetch(
    () => json({ message: 'Not Found' }, 404),
    async calls => {
      await assert.rejects(() => client.getBranch('o', 'r', 'nope'), /Not Found|404/)
      assert.equal(calls.length, 1)
    }
  )
})
