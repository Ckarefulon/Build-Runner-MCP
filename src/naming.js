/**
 * Artifact naming rules, shared by the client and mirrored in the workflow.
 *
 * The workflow has to do this itself (the packaging runs on the runner), so this
 * module exists to make the rule testable and to keep the two implementations
 * honest. `test/naming.test.js` pins the behaviour.
 */

/**
 * Where a variant suffix belongs.
 *
 * `app.debug.apk` is recognised by Android installers; `app.apk.debug` is not,
 * because the extension must be last. Keeping the rule in one place stops the
 * two call sites from drifting.
 */
export function applySuffix(name, suffix) {
  const clean = String(suffix ?? '').replace(/^\.+/, '').trim()
  const base = String(name ?? '').trim()
  if (clean === '') return base
  // Avoid `app.debug.debug` when the caller already included it.
  if (base.toLowerCase().endsWith(`.${clean.toLowerCase()}`)) return base
  return `${base}.${clean}`
}

/**
 * Decide how an artifact set should be published.
 *
 * @param {object} input
 * @param {string} input.name        base package name (no extension)
 * @param {string} [input.suffix]    variant suffix such as "debug"
 * @param {string[]} input.matched   matched paths
 * @param {boolean} [input.isDirectory] treat the match as a directory
 * @returns {{kind:'single'|'archive', file:string, source?:string}}
 */
export function planPackage({ name, suffix = '', matched = [], isDirectory = false }) {
  const base = applySuffix(name, suffix)

  if (!isDirectory && matched.length === 1) {
    const source = matched[0]
    const filename = source.replace(/\\/g, '/').split('/').pop() ?? ''
    const dot = filename.lastIndexOf('.')
    // A name with no extension (or a dotfile) still needs something concrete.
    const ext = dot > 0 ? filename.slice(dot + 1) : 'bin'
    // If the base already ends with this extension, do not repeat it.
    const file = base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? base : `${base}.${ext}`
    return { kind: 'single', file, source }
  }

  return { kind: 'archive', file: `${base}.zip` }
}
