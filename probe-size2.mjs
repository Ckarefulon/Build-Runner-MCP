import { createClient } from './src/github.js'

// A real patch can reach several hundred KB; base64 inflates it by ~4/3.
// If the proxy rejects large POST bodies, the failure would look exactly like
// the report: GET fine, POST blob 502 every time.
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const OWNER = 'Ckarefulon'
const REPO = 'Build-Runner'

const sizes = [37_006, 150_000, 347_687, 700_000, 1_400_000]

for (const size of sizes) {
  const payload = Buffer.alloc(size, 0x41)
  const b64len = Math.ceil(size / 3) * 4
  try {
    const r = await client.createBlob(OWNER, REPO, payload)
    console.log(`ok    raw=${String(size).padStart(8)}  b64=${String(b64len).padStart(8)}  ${String(r.sha).slice(0, 8)}`)
  } catch (error) {
    console.log(`FAIL  raw=${String(size).padStart(8)}  b64=${String(b64len).padStart(8)}  ${error.message.split('\n')[0].slice(0, 110)}`)
  }
}
