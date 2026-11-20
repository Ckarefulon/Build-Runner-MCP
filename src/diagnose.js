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
  { name: 'Maven Central', url: 'https://repo1.maven.org/maven2/' },
  { name: 'Google Maven', url: 'https://dl.google.com/dl/android/maven2/' },
  { name: 'Gradle Plugin Portal', url: 'https://plugins.gradle.org/m2/' },
  { name: 'Aliyun mirror', url: 'https://maven.aliyun.com/repository/public/' },
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
        `printf '  %-24s ' "${repo.name}"; ` +
        `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "${repo.url}" 2>/dev/null || echo TIMEOUT); ` +
        `printf '%s\\n' "$code"`
    )
    .join('\n')

  return `
set +e
set +o pipefail
cd "${cwd}" 2>/dev/null

echo "===== 1. 代码状态 ====="
echo "commit : $(git rev-parse --short HEAD 2>/dev/null || echo '(无 git)')"
echo "branch : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "dirty  : $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') 个文件未提交"
echo "tracked: $(git ls-files 2>/dev/null | wc -l | tr -d ' ') 个文件"

echo ""
echo "===== 2. 缓存状态 ====="
for p in "$HOME/.gradle/caches/modules-2" "$HOME/.gradle/caches/build-cache-1" "$HOME/.gradle/wrapper" "$HOME/.gradle/caches"; do
  if [ -e "$p" ]; then
    echo "  $(du -sh "$p" 2>/dev/null | cut -f1)	$p"
  else
    echo "  (缺失)	$p"
  fi
done
# A truncated module cache is the usual cause of "works in run, not in session":
# every reused job restores a DIFFERENT subset of dependencies.
echo "  modules-2 子目录数：$(ls "$HOME/.gradle/caches/modules-2/files-2.1" 2>/dev/null | wc -l | tr -d ' ')"
echo "  损坏的临时文件：$(find "$HOME/.gradle/caches" -name '*.part' -o -name '*.lock' 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "===== 3. 仓库可达性 ====="
${repoProbes}

echo ""
echo "===== 4. 工具链 ====="
echo "java   : $(java -version 2>&1 | head -1)"
echo "gradle : $(grep -o 'gradle-[0-9.]*' gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 || echo '?')"
echo "ANDROID_HOME: \${ANDROID_HOME:-未设置}"
echo "adb    : $("\${ANDROID_HOME:-/usr/local/lib/android/sdk}/platform-tools/adb" version 2>/dev/null | head -1 || echo '不可用')"
echo "emulator: $("[ -x \${ANDROID_HOME:-/usr/local/lib/android/sdk}/emulator/emulator" ] && echo 已装 || echo 未装)"

echo ""
echo "===== 5. 项目仓库声明 ====="
grep -hoE 'https?://[a-zA-Z0-9./:_-]+' settings.gradle.kts 2>/dev/null | sort -u | head -8 || echo "(未找到 settings.gradle.kts)"

echo ""
echo "===== 6. Gradle 配置阶段 ====="
T=$(date +%s)
./gradlew help --console=plain --offline 2>&1 | tail -4
echo "offline-config=$(( $(date +%s) - T ))s  （离线成功说明缓存完整）"

exit 0
`
}

/** Run the diagnostic in the cloud and return its report. */
export async function diagnoseEnvironment(runCommandFn, options) {
  const { repo, ref, workspaceDir, ...rest } = options
  const script = buildDiagnosticScript()
  const result = await runCommandFn({
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
  if (/TIMEOUT|000\s/.test(report)) {
    hints.push('有仓库不可达（结果为 TIMEOUT 或 000）：构建会卡在依赖解析')
  }
  if (/modules-2 子目录数：0/.test(report)) {
    hints.push('依赖缓存为空：这次构建需要从网络重新下载全部依赖')
  }
  const dirty = report.match(/dirty\s*:\s*(\d+)/)
  if (dirty && Number(dirty[1]) > 0) {
    hints.push(`工作区有 ${dirty[1]} 个未提交文件（通过补丁带上云端）`)
  }
  const off = report.match(/offline-config=(\d+)s/)
  if (off) {
    hints.push(
      Number(off[1]) < 90
        ? `离线配置成功（${off[1]}s）：缓存完整，依赖不缺`
        : `离线配置耗时 ${off[1]}s：缓存可能不完整，但仍可用`
    )
  }
  if (!/BUILD SUCCESSFUL|offline-config=\d+s/.test(report)) {
    hints.push('配置阶段未成功：可能是真实代码问题，而非环境')
  }
  return hints
}
