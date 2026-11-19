import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = parseSlug('Ckarefulon/Build-Runner')
const issue = process.argv[2] ?? '6'

const comments = await client.request(
  'GET',
  `/repos/${engine.owner}/${engine.repo}/issues/${issue}/comments?per_page=100`
)

console.log(`issue #${issue} 共 ${comments.length} 条评论`)
for (const comment of comments) {
  const first = (comment.body ?? '').split('\n')[0]
  console.log(` ${comment.created_at} | ${first}`)
}

// Also show the latest session workflow run and its conclusion.
const runs = await client.listRuns(engine.owner, engine.repo, {
  workflow: 'session.yml',
  perPage: 5,
})
for (const run of runs.workflow_runs ?? []) {
  console.log(`run ${run.id} ${run.display_title} -> ${run.status}/${run.conclusion ?? '-'}`)
}
