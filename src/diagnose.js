/**
 * Environment diagnosis: separate "the cloud environment is broken" from
 * "the code is broken".
 *
 * The reported pain was that failures took many rounds to attribute: a missing
 * dependency, a stale cache, a repository hiccup and an actual compile error all
 * look the same from a truncated Gradle log. This module answers the environment
 * questions up front, so a failing command can be attributed immediately.
 */

/** Repositories a Gradle build in this project is likely to need. */
const KNOWN_REPOS = [
  // Probe a REAL ARTIFACT path, not the repository root.
  //
  // `dl.google.com/dl/android/maven2/` and `maven.aliyun.com/repository/public/`
  // answer 404 to a bare directory listing while serving artifacts perfectly —
  // probing the root reported two healthy repositories as broken.
  { name: 'Maven Central', url: 'https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/maven-metadata.xml' },
  { name: 'Google Maven', url: 'https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml' },
  { name: 'Gradle Plugin Portal', url: 'https://plugins.gradle.org/m2/org/jetbrains/kotlin/jvm/org.jetbrains.kotlin.jvm.gradle.plugin/maven-metadata.xml' },
  { name: 'Aliyun mirror', url: 'https://maven.aliyun.com/repository/public/org/jetbrains/kotlin/kotlin-stdlib/maven-metadata.xml' },
]

/**
 * Build a diagnostic command to run in the cloud.
 *
 * Kept as a shell script (not many round trips) so one call answers everything:
 * cache state, repository reachability, tool versions, and whether the checkout
 * actually matches the commit under test.
 */
export function buildDiagnosticScript({ cwd = '.', repos = KNOWN_REPOS } = {}) {
  const repoProbes = repos
    .map(
      repo =>
        `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "${repo.url}" 2>/dev/null || echo TIMEOUT); ` +
        `printf 'REPO %-22s %s\\n' "${repo.name}" "$code"`
    )
    .join('\n')

  return `
set +e
set +o pipefail
cd "${cwd}" 2>/dev/null
export LC_ALL=C.UTF-8 2>/dev/null || true

# Section headers are pure ASCII on purpose: the report travels through shell,
# JSON and a GitHub comment, and a non-ASCII heading came back mojibake — which
# made the section boundaries unmatchable.
echo "===== [1] CODE ====="
echo "commit : $(git rev-parse --short HEAD 2>/dev/null || echo '(no git)')"
echo "branch : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "dirty  : $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') files uncommitted"
echo "tracked: $(git ls-files 2>/dev/null | wc -l | tr -d ' ') files"

echo ""
echo "===== [2] CACHE ====="
for p in "$HOME/.gradle/caches/modules-2" "$HOME/.gradle/caches/build-cache-1" "$HOME/.gradle/wrapper" "$HOME/.gradle/caches"; do
  if [ -e "$p" ]; then
    echo "  $(du -sh "$p" 2>/dev/null | cut -f1)	$p"
  else
    echo "  MISSING	$p"
  fi
done
# A truncated module cache is the usual cause of "works in run, not in session":
# each job restores a different subset of dependencies.
echo "groups: $(ls "$HOME/.gradle/caches/modules-2/files-2.1" 2>/dev/null | wc -l | tr -d ' ')"
echo "stale : $(find "$HOME/.gradle/caches" -name '*.part' -o -name '*.lock' 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "===== [3] REPOS ====="
${repoProbes}

echo ""
echo "===== [4] TOOLCHAIN ====="
echo "java    : $(java -version 2>&1 | head -1)"
echo "gradle  : $(grep -o 'gradle-[0-9.]*' gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 || echo '?')"
echo "sdk     : \${ANDROID_HOME:-unset}"
echo "adb     : $("\${ANDROID_HOME:-/usr/local/lib/android/sdk}/platform-tools/adb" version 2>/dev/null | head -1 || echo 'unavailable')"
echo "emulator: $("[ -x \${ANDROID_HOME:-/usr/local/lib/android/sdk}/emulator/emulator" ] && echo installed || echo missing)"
echo "cjk     : $(fc-list :lang=zh 2>/dev/null | wc -l | tr -d ' ') fonts"

echo ""
echo "===== [5] DECLARED REPOS ====="
grep -hoE 'https?://[a-zA-Z0-9./:_-]+' settings.gradle.kts 2>/dev/null | sort -u | head -8 || echo "(none)"

echo ""
echo "===== [6] OFFLINE CONFIG ====="
T=$(date +%s)
./gradlew help --console=plain --offline 2>&1 | tail -4
echo "offline-config=$(( $(date +%s) - T ))s"

exit 0
`
}

/** Run the diagnostic in the cloud and return its report. */
export async function diagnoseEnvironment(runCommandFn, options) {
  const { client, repo, ref, workspaceDir, ...rest } = options
  const script = buildDiagnosticScript()
  // runCommand's signature is (client, options) — the client comes first.
  const result = await runCommandFn(client, {
    repo,
    ref,
    workspaceDir,
    command: script,
    wait: true,
    maxWaitMs: 10 * 60 * 1000,
    ...rest,
  })
  return {
    report: String(result.output ?? ''),
    succeeded: result.succeeded,
    runUrl: result.runUrl,
    // A quick verdict so the caller does not have to read the whole report.
    hints: extractHints(String(result.output ?? '')),
  }
}

/** Pull the actionable lines out of a diagnostic report. */
export function extractHints(report) {
  const hints = []

  // Repository probes print `REPO <name> <code>`. Only a non-2xx status counts
  // as a problem — matching the bare word TIMEOUT anywhere would also fire on
  // `--max-time` inside the echoed script.
  const probes = [...report.matchAll(/^REPO\s+(\S+(?:\s\S+)*?)\s+(\d{3}|TIMEOUT)$/gm)].map(m => ({
    name: m[1].trim(),
    code: m[2],
  }))
  const bad = probes.filter(p => p.code === 'TIMEOUT' || p.code === '000' || /^[45]\d\d$/.test(p.code))
  if (bad.length > 0) {
    hints.push(
      `有 ${bad.length} 个仓库不可用：` +
        bad.map(p => `${p.name}(${p.code})`).join('、') +
        ' —— 依赖解析会变慢或失败'
    )
  } else if (probes.length > 0) {
    hints.push(`${probes.length} 个仓库全部可达`)
  }

  const groups = report.match(/groups:\s*(\d+)/)
  if (groups) {
    const n = Number(groups[1])
    if (n === 0) {
      hints.push('依赖缓存为空：这次构建需要从网络重新下载全部依赖')
    } else if (n < 100) {
      hints.push(`依赖缓存偏小（${n} 个 group）：很可能被截断，构建会补下载`)
    } else {
      hints.push(`依赖缓存完整（${n} 个 group）`)
    }
  }

  const dirty = report.match(/dirty\s*:\s*(\d+)\s+files uncommitted/)
  if (dirty && Number(dirty[1]) > 0) {
    hints.push(`工作区有 ${dirty[1]} 个未提交文件（通过补丁带上云端）`)
  }

  const off = report.match(/offline-config=(\d+)s/)
  if (off) {
    hints.push(
      Number(off[1]) < 90
        ? `离线配置成功（${off[1]}s）：缓存自洽，不依赖网络`
        : `离线配置耗时 ${off[1]}s：缓存可用但不完整`
    )
  } else {
    hints.push('离线配置未成功：缓存缺依赖，或项目必须联网解析')
  }

  const stale = report.match(/stale\s*:\s*(\d+)/)
  if (stale && Number(stale[1]) > 20) {
    hints.push(`有 ${stale[1]} 个残留锁/临时文件：可能中断过，必要时清理`)
  }

  return hints
}
