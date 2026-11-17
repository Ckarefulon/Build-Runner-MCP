/**
 * Minimal GitHub REST client for Build-Runner.
 *
 * Uses global fetch (Node >= 20). Every call carries the GitHub API version
 * header so behaviour never drifts with the API's default.
 */

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'

export class GitHubError extends Error {
  constructor(message, { status, body, url, method, path, upstream, reachable } = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.body = body
    this.url = url
    this.method = method
    this.path = path
    // True when the failure came from a local proxy/gateway rather than GitHub.
    this.upstream = upstream
    // False when the request never got a response at all (socket/TLS failure).
    this.reachable = reachable
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {object} options
 * @param {string} options.token     GitHub token (repo + workflow scopes)
 * @param {string} [options.baseUrl] override for GitHub Enterprise
 */
export function createClient({ token, baseUrl = API } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      '缺少 GitHub token。请设置环境变量 BUILD_RUNNER_TOKEN（需要 repo + workflow 权限）。'
    )
  }

  async function request(method, path, { body, raw = false, redirect = 'follow', accept } = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'build-runner-mcp',
      'X-GitHub-Api-Version': API_VERSION,
      Accept: accept ?? (raw ? '*/*' : 'application/vnd.github+json'),
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    // Which write requests are safe to repeat is a per-endpoint question, and
    // getting it wrong either duplicates objects (commits) or gives up on a
    // transient proxy 502 (ref updates).
    //
    //   GET/HEAD                  — always retried
    //   POST /git/blobs           — content-addressed: same bytes, same SHA
    //   PATCH/POST /git/refs      — sets a ref to a KNOWN sha; idempotent
    //   POST /git/trees,/commits  — creates a new object each time; NOT retried
    const idempotent = method === 'GET' || method === 'HEAD'
    const retryableWrite =
      (method === 'POST' && /\/git\/blobs$/.test(path)) ||
      /\/git\/refs(\/|$)/.test(path)
    const maxAttempts = idempotent ? 4 : retryableWrite ? 3 : 1
    let lastError
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response
      try {
        response = await fetch(url, {
          method,
          headers:
            attempt > 0
              // A retry after a connection-level failure must NOT reuse the
              // pooled socket: through an inspecting proxy that socket is what
              // failed, and undici would hand back the same dead one. Asking for
              // `Connection: close` forces a fresh TCP/TLS handshake.
              ? { ...headers, Connection: 'close' }
              : headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect,
        })
      } catch (error) {
        // No response at all: the socket died before/while sending. Retrying is
        // safe even for non-idempotent writes only when nothing was committed,
        // which we cannot know — so writes still stop here unless explicitly
        // marked retryable above (content-addressed blobs).
        lastError = new GitHubError(
          `${method} ${path} 连接失败：${error.message}` +
            (idempotent || retryableWrite ? '' : '（写操作不重试，避免重复创建）'),
          { url, method, path, reachable: false }
        )
        if (attempt + 1 < maxAttempts) {
          await sleep(600 * (attempt + 1))
          continue
        }
        throw lastError
      }

      if ((idempotent || retryableWrite) && (response.status === 429 || response.status >= 500)) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 700 * (attempt + 1)
        )
        lastError = new GitHubError(`${method} ${path} 返回 ${response.status}`, {
          status: response.status,
          url,
          method,
          path,
        })
        continue
      }

      if (raw) {
        if (!response.ok && response.status !== 302) {
          const text = await response.text().catch(() => '')
          throw new GitHubError(`GitHub 返回 ${response.status}：${text.slice(0, 300)}`, {
            status: response.status,
            body: text,
            url,
          })
        }
        return Buffer.from(await response.arrayBuffer())
      }

      const text = await response.text()
      let parsed = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      if (!response.ok) {
        const message = parsed && typeof parsed === 'object' && parsed.message ? parsed.message : text
        // Distinguish an upstream failure (usually the local inspecting proxy)
        // from a real GitHub answer. Without this the caller only sees
        // "GitHub 返回 502" and cannot tell where to look.
        const upstream =
          typeof message === 'string' && /upstream request failed|bad gateway|gateway time-?out/i.test(message)
        const hint = upstream
          ? `\n→ 这是本地代理/网关返回的，不是 GitHub 的响应。` +
            `重试通常有效；若持续失败，检查代理设置或改用直连。`
          : ''
        throw new GitHubError(
          `${method} ${path} 返回 ${response.status}：${String(message).slice(0, 200)}${hint}`,
          { status: response.status, body: parsed, url, method, path, upstream }
        )
      }
      return parsed
    }
    throw lastError ?? new GitHubError(`${method} ${path} 请求失败`, { url, method, path })
  }

  return {
    request,
    getUser: () => request('GET', '/user'),

    getRepo: (owner, repo) => request('GET', `/repos/${owner}/${repo}`),

    getBranch: (owner, repo, branch) =>
      request('GET', `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`),

    getWorkflow: (owner, repo, file) =>
      request('GET', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}`),

    /** Fire a workflow_dispatch. GitHub answers 204 with no run id. */
    dispatch: (owner, repo, file, { ref, inputs }) =>
      request('POST', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
        body: { ref, inputs: inputs ?? {} },
      }),

    listRuns: (owner, repo, { workflow, branch, createdAfter, perPage = 30 } = {}) => {
      const params = new URLSearchParams({ per_page: String(perPage) })
      if (workflow) params.set('workflow_id', workflow)
      if (branch) params.set('branch', branch)
      if (createdAfter) params.set('created', `>=${createdAfter}`)
      return request('GET', `/repos/${owner}/${repo}/actions/runs?${params}`)
    },

    getRun: (owner, repo, runId) => request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`),

    getRunJobs: (owner, repo, runId) =>
      request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`),

    cancelRun: (owner, repo, runId) =>
      request('POST', `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`),

    /** Raw job log (may be an HTML error page on GitHub's side; caller checks). */
    getJobLog: (owner, repo, jobId) =>
      request('GET', `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, { raw: true }),

    listArtifacts: (owner, repo, runId) =>
      request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`),

    getArtifactDownload: (owner, repo, artifactId) =>
      request('GET', `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
        raw: true,
        redirect: 'follow',
      }),

    createCommitStatus: (owner, repo, sha, { state, context, description }) =>
      request('POST', `/repos/${owner}/${repo}/statuses/${sha}`, {
        body: { state, context, description },
      }),

    /** Read a file's contents from a branch. Returns { sha, text } or null. */
    async getFile(owner, repo, path, ref) {
      try {
        const data = await request(
          'GET',
          `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
        )
        if (Array.isArray(data) || !data || data.type !== 'file') return null
        return { sha: data.sha, text: Buffer.from(data.content ?? '', 'base64').toString('utf8') }
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    },

    /** Create or update a file on a branch — used to publish workspaces. */
    async putFile(owner, repo, path, { text, message, branch, sha }) {
      return request(
        'PUT',
        `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          body: {
            message,
            content: Buffer.from(text, 'utf8').toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
          },
        }
      )
    },

    async ensureBranch(owner, repo, branch, fromBranch) {
      try {
        await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
        return { created: false }
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
      }
      const base = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`)
      await request('POST', `/repos/${owner}/${repo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha: base.object.sha },
      })
      return { created: true, sha: base.object.sha }
    },

    // ---------------------------------------------------------------------
    // Git data API. This is what makes publishing a working tree cheap: a tree
    // is built with `base_tree` pointing at an EXISTING tree object, so only
    // the entries that actually changed are uploaded. GitHub stitches the rest
    // in server-side, without the client ever seeing those files.
    // ---------------------------------------------------------------------

    getRef: (owner, repo, ref) =>
      request('GET', `/repos/${owner}/${repo}/git/ref/${ref.replace(/^\/+/, '')}`),

    /** null when the ref does not exist (the normal case on first use). */
    async tryGetRef(owner, repo, ref) {
      try {
        return await request('GET', `/repos/${owner}/${repo}/git/ref/${ref.replace(/^\/+/, '')}`)
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    },

    getCommit: (owner, repo, sha) => request('GET', `/repos/${owner}/${repo}/git/commits/${sha}`),

    /**
     * Resolve a branch/tag/SHA to a commit object.
     * `/git/commits/{ref}` only accepts a SHA, so a branch name has to go
     * through the refs endpoint first — the difference is a 404 that looks
     * exactly like "repository not found".
     */
    async resolveCommit(owner, repo, ref) {
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        return request('GET', `/repos/${owner}/${repo}/git/commits/${ref}`)
      }
      let sha = null
      try {
        const branchRef = await request(
          'GET',
          `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`
        )
        sha = branchRef.object.sha
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
      }
      if (sha === null) {
        try {
          const tagRef = await request(
            'GET',
            `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(ref)}`
          )
          sha = tagRef.object.sha
        } catch (error) {
          if (!(error instanceof GitHubError) || error.status !== 404) throw error
        }
      }
      if (sha === null) {
        // Fall back to commits API, which also accepts a branch name or short sha.
        const commit = await request(
          'GET',
          `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
        )
        sha = commit.sha
      }
      // A tag ref may point at an annotated tag object; peel it to a real commit.
      const object = await request('GET', `/repos/${owner}/${repo}/git/commits/${sha}`)
      // The Git Data API returns { sha, message, tree: {...}, parents: [...] }.
      if (!object?.tree?.sha) {
        throw new GitHubError(`无法把 "${ref}" 解析成 commit 对象（缺少 tree）`, { body: object })
      }
      return object
    },

    getTree: (owner, repo, sha, { recursive = false } = {}) =>
      request(
        'GET',
        `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`
      ),

    /**
     * Upload one blob. Skipped entirely for unchanged paths, which is why a
     * three-file edit costs three calls regardless of repository size.
     */
    createBlob: (owner, repo, content) =>
      request('POST', `/repos/${owner}/${repo}/git/blobs`, {
        body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
      }),

    /**
     * Build a tree from `baseTree` plus the given entries.
     * An entry with `sha: null` deletes that path from the base tree.
     */
    createTree: (owner, repo, { baseTree, tree }) =>
      request('POST', `/repos/${owner}/${repo}/git/trees`, {
        body: {
          ...(baseTree ? { base_tree: baseTree } : {}),
          tree,
        },
      }),

    createCommit: (owner, repo, { message, tree, parents, author }) =>
      request('POST', `/repos/${owner}/${repo}/git/commits`, {
        body: {
          message,
          tree,
          parents: parents ?? [],
          ...(author
            ? { author, committer: author }
            : {}),
        },
      }),

    /** Create a ref, or move an existing one. Force is required to move. */
    async upsertRef(owner, repo, ref, sha, { force = true } = {}) {
      const branch = ref.replace(/^\/+/, '').replace(/^heads\//, '')
      // Read both "heads/<b>" (current) and the legacy "refs/heads" form through
      // the refs collection: the singular /git/ref/<x> endpoint 404s on some
      // names, and a false 404 here makes the create below fail with
      // "Reference already exists" on every subsequent publish.
      let exists = false
      try {
        await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
        exists = true
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
      }

      if (exists) {
        return request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
          body: { sha, force },
        })
      }
      return request('POST', `/repos/${owner}/${repo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha },
      })
    },

    deleteRef: (owner, repo, ref) =>
      request('DELETE', `/repos/${owner}/${repo}/git/refs/${ref.replace(/^\/+/, '')}`),

    /**
     * Publish a small file to a throwaway branch in THIS repository.
     *
     * `workflow_dispatch` inputs are capped at ~61 KiB (measured), which a real
     * workspace patch easily exceeds — so the patch cannot travel as an input.
     * A transient branch carries it instead; the runner fetches it, and the job
     * deletes the branch when done.
     */
    async publishBlobFile(owner, repo, { branch, path, content, message }) {
      // Each step is retried by `request` where that is safe. A failure part-way
      // leaves an unreferenced blob/tree behind — harmless garbage that GitHub
      // collects, and far better than failing the caller's build because a proxy
      // hiccuped once.
      const head = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`).catch(
        error => {
          if (error instanceof GitHubError && error.status === 404) return null
          throw error
        }
      )
      const blob = await request('POST', `/repos/${owner}/${repo}/git/blobs`, {
        body: {
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
        },
      })
      const tree = await request('POST', `/repos/${owner}/${repo}/git/trees`, {
        body: {
          ...(head ? { base_tree: (await request('GET', `/repos/${owner}/${repo}/git/commits/${head.object.sha}`)).tree.sha } : {}),
          tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
        },
      })
      const commit = await request('POST', `/repos/${owner}/${repo}/git/commits`, {
        body: {
          message: message ?? 'build-runner: transient patch',
          tree: tree.sha,
          parents: head ? [head.object.sha] : [],
        },
      })
      // Ref update retries internally (idempotent): this is the call that most
      // often hits a proxy 502, and repeating it with the same sha is harmless.
      if (head) {
        await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          body: { sha: commit.sha, force: true },
        })
      } else {
        await request('POST', `/repos/${owner}/${repo}/git/refs`, {
          body: { ref: `refs/heads/${branch}`, sha: commit.sha },
        })
      }
      return { branch, sha: commit.sha }
    },

    /**
     * Delete every file under a branch directory prefix. Used to reset the
     * workspace branch so a later run cannot see stale files from an earlier
     * one — otherwise "works in my AI session" stops meaning anything.
     */
    async clearDirectory(owner, repo, dir, branch, message) {
      let removed = 0
      let guard = 0
      for (;;) {
        guard += 1
        if (guard > 100) break
        const entries = await request(
          'GET',
          `/repos/${owner}/${repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`
        ).catch(error => {
          if (error instanceof GitHubError && error.status === 404) return []
          throw error
        })
        const files = (Array.isArray(entries) ? entries : []).filter(item => item.type === 'file')
        if (files.length === 0) break
        for (const file of files) {
          await request('DELETE', `/repos/${owner}/${repo}/contents/${file.path}`, {
            body: { message, sha: file.sha, branch },
          })
          removed += 1
        }
      }
      return removed
    },
  }
}

/** Parse `owner/name` or a full GitHub URL into { owner, repo }. */
export function parseSlug(slug) {
  const value = String(slug ?? '').trim()
  if (value === '') return null
  const urlMatch = value.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') }
  }
  const parts = value.split('/')
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
  }
  return null
}
