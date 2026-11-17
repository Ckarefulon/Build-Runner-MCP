const t = process.env.BUILD_RUNNER_TOKEN

const r = await fetch(
  'https://api.github.com/repos/yeliqin666/xjtu-toolbox-android/contents/app/build.gradle.kts',
  { headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'br' } }
)
const s = await r.text()
const i = s.indexOf('hasProperty("debugSuffix")')
console.log(s.slice(i - 200, i + 600))
