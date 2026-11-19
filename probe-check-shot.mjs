import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = parseSlug('Ckarefulon/Build-Runner')
const issue = process.argv[2] ?? '6'

const comments = await client.request(
  'GET',
  `/repos/${engine.owner}/${engine.repo}/issues/${issue}/comments?per_page=100`
)

for (const comment of comments) {
  const body = comment.body ?? ''
  const first = body.split('\n')[0]
  if (!first.includes('BR-RESULT')) continue
  const fence = body.indexOf('```json')
  if (fence === -1) {
    console.log(first, '| 无 json 块')
    continue
  }
  const start = body.indexOf('\n', fence) + 1
  const end = body.indexOf('```', start)
  const json = body.slice(start, end)
  try {
    const parsed = JSON.parse(json)
    console.log(
      first,
      '| exit=', parsed.exitCode,
      '| image=', parsed.image ? `${parsed.image.bytes}B` : 'NONE',
      '| out=', String(parsed.output ?? '').slice(0, 220).replace(/\n/g, ' ')
    )
  } catch (error) {
    console.log(first, '| JSON 解析失败:', error.message)
  }
}
