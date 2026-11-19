import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = parseSlug('Ckarefulon/Build-Runner')
const issue = process.argv[2] ?? '22'

const comments = await client.request(
  'GET',
  `/repos/${engine.owner}/${engine.repo}/issues/${issue}/comments?per_page=100`
)

// Show the Gradle failure detail that preceded the screenshot list.
for (const comment of comments) {
  const body = comment.body ?? ''
  if (!body.includes('BR-RESULT')) continue
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    const out = String(parsed.output ?? '')
    if (!out.includes('BUILD FAILED')) continue
    const idx = out.indexOf('BUILD FAILED')
    console.log(out.slice(Math.max(0, idx - 2200), idx + 80))
  } catch {
    /* ignore */
  }
}
