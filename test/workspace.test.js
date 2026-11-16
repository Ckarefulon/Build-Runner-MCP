/**
 * Tests for local change collection.
 *
 * The cases that matter here are the ones that silently corrupt a build:
 * a Chinese filename, a rename, a deletion, and an ignored path. Each of them
 * produces a wrong remote tree without any error, which is worse than failing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { parseStatusZ, parseRemote, isIgnoredByPolicy, collectChanges } from '../src/workspace.js'

test('parses modified, added and deleted entries', () => {
  const raw = [' M a.txt', '?? c.txt', ' D b.txt', ''].join('\u0000')
  const changes = parseStatusZ(raw)
  assert.equal(changes.length, 3)
  assert.deepEqual(
    changes.map(change => [change.path, change.kind]),
    [
      ['a.txt', 'modified'],
      ['c.txt', 'added'],
      ['b.txt', 'deleted'],
    ]
  )
})

test('parses a rename with its source path', () => {
  // `git status -z` emits "R  new\0old\0" — the source arrives as a separate part.
  const raw = ['R  new-name.txt', 'old-name.txt', ''].join('\u0000')
  const changes = parseStatusZ(raw)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'new-name.txt')
  assert.equal(changes[0].from, 'old-name.txt')
  assert.equal(changes[0].kind, 'renamed')
})

test('keeps non-ASCII paths intact', () => {
  // The default `git status` would render this as "\344\270\255..." and a naive
  // parser would upload a file that does not exist. -z gives raw UTF-8.
  const raw = [' M 中文目录/文件.txt', ''].join('\u0000')
  const changes = parseStatusZ(raw)
  assert.equal(changes[0].path, '中文目录/文件.txt')
})

test('path with a space survives', () => {
  const raw = [' M my file.txt', ''].join('\u0000')
  const changes = parseStatusZ(raw)
  assert.equal(changes[0].path, 'my file.txt')
})

test('ignores empty trailing parts', () => {
  const raw = [' M a.txt', '', ''].join('\u0000')
  assert.equal(parseStatusZ(raw).length, 1)
})

test('parses https, ssh and .git remotes', () => {
  const check = (input, owner, repo) => {
    const parsed = parseRemote(input)
    assert.equal(parsed?.owner, owner, `owner of ${input}`)
    assert.equal(parsed?.repo, repo, `repo of ${input}`)
  }
  check('https://github.com/owner/repo.git', 'owner', 'repo')
  check('https://github.com/owner/repo', 'owner', 'repo')
  check('git@github.com:owner/repo.git', 'owner', 'repo')
  check('https://gitlab.com/a/b', 'a', 'b')
  assert.equal(parseRemote(''), null)
  assert.equal(parseRemote('not a url'), null)
})

test('build outputs and .git are refused', () => {
  assert.equal(isIgnoredByPolicy('node_modules/pkg/index.js'), true)
  assert.equal(isIgnoredByPolicy('.git/config'), true)
  assert.equal(isIgnoredByPolicy('src/index.js'), false)
})

test('collectChanges reads only the paths git reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-ws-'))
  const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    run(['init', '-q'])
    run(['config', 'user.email', 't@t.t'])
    run(['config', 'user.name', 't'])
    run(['config', 'commit.gpgsign', 'false'])

    // A real tree with a tracked file and an ignored directory.
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.js'), 'original\n')
    writeFileSync(join(dir, 'src', 'b.txt'), 'b\n')
    run(['add', '-A'])
    run(['commit', '-qm', 'init'])

    // Now make exactly three changes, one of which git must ignore.
    writeFileSync(join(dir, 'src', 'a.js'), 'changed\n')
    writeFileSync(join(dir, 'src', 'new.txt'), 'new\n')
    rmSync(join(dir, 'src', 'b.txt'))
    mkdirSync(join(dir, 'ignored'), { recursive: true })
    writeFileSync(join(dir, 'ignored', 'big.bin'), 'x'.repeat(1000))

    const { changes, head } = collectChanges(dir)
    const paths = changes.map(change => change.path).sort()
    assert.deepEqual(paths, ['src/a.js', 'src/b.txt', 'src/new.txt'])
    assert.equal(changes.find(change => change.path === 'src/a.js').content.toString(), 'changed\n')
    assert.equal(changes.find(change => change.path === 'src/b.txt').kind, 'deleted')
    assert.match(head, /^[0-9a-f]{40}$/)

    // The ignored 1000-byte file must never appear — that is how build outputs
    // and stray secrets stay off the remote.
    assert.equal(
      changes.some(change => change.path.startsWith('ignored/')),
      false
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectChanges on a non-repo fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-norepo-'))
  try {
    assert.throws(() => collectChanges(dir), /不是 git 仓库/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
