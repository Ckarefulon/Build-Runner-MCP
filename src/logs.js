/**
 * Turn a raw GitHub Actions job log into a build-runner result.
 *
 * GitHub's log endpoint returns every step's output with timestamp prefixes
 * ("2024-01-01T00:00:00.0000000Z ") and `##[group]` / `::group::` markers. The
 * calling AI only wants what the command itself printed, so we isolate the
 * region between our own begin/end sentinels and strip the rest.
 */

const TS_PREFIX = /^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/

export const MARKERS = {
  begin: '--- BUILD-RUNNER-OUTPUT-BEGIN ---',
  end: '--- BUILD-RUNNER-OUTPUT-END ---',
  exitCode: /BUILD-RUNNER-EXIT-CODE=(-?\d+)/,
  duration: /BUILD-RUNNER-DURATION-SECONDS=(\d+)/,
  shell: /BUILD-RUNNER-SHELL=(\S+)/,
  report: '================ BUILD-RUNNER-REPORT-V1 ================',
  releaseReport: '================ BUILD-RUNNER-RELEASE-REPORT-V1 ================',
}

function stripTimestamps(line) {
  let out = line.replace(/\r$/, '')
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(TS_PREFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

// GitHub colors step output; the escape codes are noise in a tool result.
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g
// The runner interleaves its own "File sync" bookkeeping lines into a step's
// stdout on some images; they are never part of the command's output.
const SYNC_LINE = /^##\[(group|endgroup|debug|warning|error|command|section)\]/

function stripSyncLines(lines) {
  const out = []
  for (const line of lines) {
    if (SYNC_LINE.test(line.trim())) continue
    out.push(line.replace(ANSI, ''))
  }
  // Trim the blank lines the wrapper itself emits around the section markers.
  while (out.length > 0 && out[0].trim() === '') out.shift()
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * @param {Buffer|string} raw complete job log
 * @returns {{output:string, exitCode:number|null, durationSeconds:number|null,
 *            shell:string|null, report:Record<string,string>, hasSection:boolean,
 *            lines:number, bytes:number}}
 */
export function parseJobLog(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  const rawLines = text.split('\n')
  const lines = rawLines.map(stripTimestamps)

  // GitHub echoes every step's own script into the log before running it, so a
  // line reading `echo "--- BUILD-RUNNER-OUTPUT-BEGIN ---"` appears BEFORE the
  // real marker that the executed shell prints. Taking the first match captures
  // the echoed script; the genuine stream is the LAST begin marker that still
  // has an end marker after it.
  const beginCandidates = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(MARKERS.begin)) beginCandidates.push(i)
  }

  let beginAt = -1
  let endAt = -1
  for (let i = beginCandidates.length - 1; i >= 0; i -= 1) {
    const candidate = beginCandidates[i]
    const endIndex = lines.findIndex(
      (line, index) => index > candidate && line.includes(MARKERS.end)
    )
    if (endIndex !== -1) {
      beginAt = candidate
      endAt = endIndex
      break
    }
  }

  const hasSection = beginAt !== -1 && endAt !== -1
  const output = hasSection ? stripSyncLines(lines.slice(beginAt + 1, endAt)).join('\n') : ''

  const joined = lines.join('\n')
  const exitMatch = joined.match(MARKERS.exitCode)
  const durationMatch = joined.match(MARKERS.duration)
  const shellMatch = joined.match(MARKERS.shell)

  // The Report step prints `key=value` pairs; collect them so the caller can
  // prove which revision actually ran. GitHub echoes the step script first, so
  // anchor on the LAST occurrence of the report banner — the printed one.
  // The release workflow uses a distinct banner, so try both.
  const report = {}
  let reportAt = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(MARKERS.releaseReport) || lines[i].includes(MARKERS.report)) {
      reportAt = i
      break
    }
  }
  if (reportAt !== -1) {
    for (let i = reportAt + 1; i < lines.length; i += 1) {
      const line = lines[i].replace(ANSI, '').trim()
      // The closing banner is a run of '=' with no key in front of it.
      if (/^=+$/.test(line) || line.startsWith('====')) break
      const eq = line.indexOf('=')
      if (eq > 0) report[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }

  return {
    output,
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    durationSeconds: durationMatch ? Number(durationMatch[1]) : null,
    shell: shellMatch ? shellMatch[1] : null,
    report,
    hasSection,
    lines: output === '' ? 0 : output.split('\n').length,
    bytes: Buffer.byteLength(output, 'utf8'),
  }
}

/**
 * Keep the head and the tail of a long log — errors live at the end, but the
 * opening lines usually name the failing target.
 */
export function clip(text, { maxChars = 24000, headChars = 6000 } = {}) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return { text, truncated: false }
  }
  const tailChars = Math.max(maxChars - headChars, 1000)
  const head = text.slice(0, headChars)
  const tail = text.slice(-tailChars)
  const omitted = text.length - head.length - tail.length
  return {
    text: `${head}\n\n... [build-runner: 省略了 ${omitted} 个字符 / ${(
      omitted / 1024
    ).toFixed(1)} KiB 中间输出] ...\n\n${tail}`,
    truncated: true,
    omitted,
  }
}

/** Pull a concise failure summary out of raw log text. */
export function summarizeFailure(output) {
  if (!output) return null
  const lines = output.split('\n')
  const patterns = [
    /\berror(\s*\[?[A-Z]+\d*\]?)?:/i,
    /^FAIL(ED)?\b/i,
    /^\s*E\s{2,}/,
    /Exception|Traceback|panic:/,
    /cannot find|not found|No such file/i,
    /npm ERR!/,
    /BUILD FAILED|BUILD SUCCESSFUL/,
  ]
  const hits = []
  for (const line of lines) {
    if (line.trim() === '') continue
    if (patterns.some(re => re.test(line))) {
      hits.push(line.trim())
      if (hits.length >= 12) break
    }
  }
  return hits.length > 0 ? hits : null
}
