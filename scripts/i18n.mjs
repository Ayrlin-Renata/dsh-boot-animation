/**
 * i18n.mjs — the whole of this fork, and it lives OUTSIDE src/ on purpose.
 *
 * THE PROBLEM
 * Upstream (NativeDog1/dsh-boot-animation) writes code, comments and identifiers
 * in English and ships the user-facing strings in Chinese. Localizing the UI the
 * obvious way — editing src/client/ui.ts — makes that 623-line file diverge from
 * upstream forever, and since ui.ts is the file upstream edits most, every future
 * `git merge upstream/main` becomes a hand-resolved conflict in the one place you
 * can least afford to get wrong.
 *
 * THE APPROACH
 * Never touch src/. Instead, treat it as read-only input:
 *
 *     src/client/**.ts  --(i18n/en.json)-->  build/i18n/client/**.ts  -->  tsdown
 *
 * The mapping is a flat dictionary from the exact source literal to its English
 * replacement. tsdown compiles the staged copy (see tsdown.config.ts), so the
 * shipped bundle is English while the tracked source stays byte-identical to
 * upstream. A `git merge upstream/main` therefore has nothing to conflict over;
 * the entire cost of an update is "run the build, translate whatever is new".
 *
 * WHY A PARSER, NOT A REGEX
 * The unit of translation is a whole string literal, because UI text here is
 * stitched together: '这一段在磁盘上有 ' + n + ' 份相同的副本…'. Matching Chinese
 * *runs* would translate half a sentence. So the unit has to be the literal, and
 * finding literals reliably means parsing. typescript is already a devDependency,
 * so this costs no new dependency and no lexer risk.
 *
 * FAIL-CLOSED
 * A staging step that silently skips an unknown string is worse than no
 * localization at all: the build would succeed and ship Chinese. So an unmapped
 * literal, a translation that still contains CJK, or a CJK literal surviving in
 * the staged output each abort the build with a report. Silent leaks are the
 * only unacceptable outcome here.
 *
 * Usage
 *   node scripts/i18n.mjs report   list untranslated + stale entries (exit 0)
 *   node scripts/i18n.mjs check    stage + assert, also scan lib/client.js
 *   node scripts/i18n.mjs stage    stage into build/i18n (used by tsdown.config)
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_CLIENT = join(ROOT, 'src', 'client')
const STAGE = join(ROOT, 'build', 'i18n', 'client')
const MAP_FILE = join(ROOT, 'i18n', 'en.json')
const BUNDLE = join(ROOT, 'lib', 'client.js')

/** Repo-relative, forward-slashed: what tsdown.config.ts compiles. */
export const CLIENT_ENTRY = 'build/i18n/client/index.ts'

/**
 * CJK ideographs, CJK punctuation (corner brackets, ideographic comma) and
 * fullwidth forms — the blocks that mean "this string is Chinese UI text".
 *
 * Deliberately NOT "any non-ASCII": the ellipsis, the middle dot, the warning
 * sign and the play triangle all appear inside strings that are already English,
 * and flagging those would demand translations for punctuation. Ideographs and
 * CJK punctuation are the actual signal.
 *
 * The ranges are numeric rather than literal characters on purpose. A literal
 * character class is unreviewable — no reader can tell the intended start of a
 * range from its end by eye — and one mistyped code point silently widens it.
 * That is not hypothetical: U+8C48 written where U+F900 was meant turned this
 * into `8C48-FAFF`, which swallows the entire surrogate block and so matched
 * every emoji, including the three the plugin uses as button glyphs. Numbers
 * cannot be mistyped this way, and each range is named where it is defined.
 *
 * Note the top range stops at U+9FFF, below the surrogate block, so no BMP-only
 * class can accidentally match an astral character.
 */
const CJK_RANGES = [
  [0x2e80, 0x303f], // CJK Radicals Supplement, Kangxi Radicals, CJK Symbols and Punctuation
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
]
const CJK = new RegExp(
  '[' + CJK_RANGES.map(([lo, hi]) => String.fromCharCode(lo) + '-' + String.fromCharCode(hi)).join('') + ']',
)

/**
 * The single definition of "this text is Chinese and must be translated".
 *
 * Note what this does NOT reject: ▶ ⚠ ✓ 🎲, the em dash, the ellipsis, the
 * middle dot and curly quotes are all fine, because the plugin's own UI already
 * uses that typography and an English UI should keep it. Only CJK is a bug.
 */
export const isChinese = (text) => CJK.test(text)

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/** Source literals that need an English text, in source order. */
function collect(fileAbs) {
  const text = readFileSync(fileAbs, 'utf8')
  const sf = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, false)
  const found = []

  const take = (node, kind) => {
    if (!CJK.test(node.text)) return
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    found.push({
      text: node.text,
      kind,
      file: rel(fileAbs),
      line: line + 1,
      column: character + 1,
      start: node.getStart(sf),
      end: node.getEnd(),
    })
  }

  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
        take(node, 'string')
        break
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        take(node, 'template')
        break
      case ts.SyntaxKind.TemplateHead:
        take(node, 'head')
        break
      case ts.SyntaxKind.TemplateMiddle:
        take(node, 'middle')
        break
      case ts.SyntaxKind.TemplateTail:
        take(node, 'tail')
        break
      default:
        break
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Every file under src/client, recursively — modules and assets alike. */
function clientTree(dir = SRC_CLIENT, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) clientTree(full, out)
    else out.push(full)
  }
  return out
}

/**
 * Only TypeScript carries translatable literals. Everything else must still be
 * copied verbatim: staging is a drop-in replacement for src/client, so omitting
 * an asset upstream adds later (a .css or .json a module imports) would break
 * the build on a file this fork never knew existed.
 */
const isModule = (path) => /\.(ts|tsx)$/.test(path)
const modulesIn = (dir) => clientTree(dir).filter(isModule)

/** Render an English string as the JS literal that replaces `kind`. */
function render(text, kind) {
  const q = (s) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
  // In a template quasi an unescaped `${` would open a substitution, so `$` is
  // escaped too. Backticks would close the literal.
  const t = (s) => q(s).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  switch (kind) {
    case 'string':
      return `'${q(text)}'`
    case 'template':
      return `\`${t(text)}\``
    case 'head':
      return `\`${t(text)}\${`
    case 'middle':
      return `}${t(text)}\${`
    case 'tail':
      return `}${t(text)}\``
    default:
      throw new Error(`i18n: unknown literal kind ${kind}`)
  }
}

function loadMap() {
  if (!existsSync(MAP_FILE)) {
    throw new Error(`i18n: ${rel(MAP_FILE)} is missing — the fork has no translations`)
  }
  const parsed = JSON.parse(readFileSync(MAP_FILE, 'utf8'))
  const strings = parsed?.strings
  if (typeof strings !== 'object' || strings === null) {
    throw new Error(`i18n: ${rel(MAP_FILE)} must have a "strings" object`)
  }
  return strings
}

/**
 * Stage the localized copy of src/client.
 *
 * @param {{ quiet?: boolean }} [options]
 * @returns {{ total: number, replaced: number, stale: string[] }}
 * @throws when a literal has no translation, or a translation is not English.
 */
export function stageClient({ quiet = false } = {}) {
  const map = loadMap()
  const tree = clientTree()
  const sources = tree.filter(isModule)
  if (sources.length === 0) {
    throw new Error('i18n: src/client has no TypeScript sources — refusing to stage an empty plugin')
  }

  // Every run replaces the tree wholesale. A file deleted upstream must not
  // survive as a stale module that tsdown would still bundle.
  rmSync(join(ROOT, 'build', 'i18n'), { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })

  const found = sources.flatMap(collect)
  const seen = new Map()
  for (const item of found) {
    if (!seen.has(item.text)) seen.set(item.text, item)
  }

  const unmapped = [...seen.values()].filter((item) => !Object.hasOwn(map, item.text))
  const badValues = Object.entries(map).filter(([, value]) => typeof value !== 'string' || CJK.test(value))
  const stale = Object.keys(map).filter((key) => !seen.has(key))

  if (unmapped.length > 0 || badValues.length > 0) {
    console.error('')
    console.error('i18n: the English overlay is out of date — refusing to build a mixed-language UI.')
    console.error('')
    if (unmapped.length > 0) {
      console.error(`${String(unmapped.length)} source string(s) have no entry in ${rel(MAP_FILE)}:`)
      for (const item of unmapped) {
        console.error(`  ${item.file}:${String(item.line)}:${String(item.column)}  (${item.kind})`)
        console.error(`    ${JSON.stringify(item.text)}`)
      }
      console.error('')
      console.error('  Paste this into the "strings" object and fill in the English:')
      const seed = {}
      for (const item of unmapped) seed[item.text] = ''
      console.error(JSON.stringify(seed, null, 2).split('\n').map((l) => '  ' + l).join('\n'))
      console.error('')
    }
    if (badValues.length > 0) {
      console.error(`${String(badValues.length)} entry/entries in ${rel(MAP_FILE)} are not English:`)
      for (const [key, value] of badValues) console.error(`  ${JSON.stringify(key)} -> ${JSON.stringify(value)}`)
      console.error('')
    }
    throw new Error('i18n: untranslated strings (see the report above)')
  }

  for (const abs of tree) {
    const dest = join(STAGE, relative(SRC_CLIENT, abs))
    mkdirSync(dirname(dest), { recursive: true })
    // Assets pass through untouched; only modules are rewritten.
    if (!isModule(abs)) {
      cpSync(abs, dest)
      continue
    }
    const original = readFileSync(abs, 'utf8')
    const items = found.filter((item) => item.file === rel(abs))
    // Back to front, so each splice leaves the earlier offsets valid.
    const edits = items
      .map((item) => ({ start: item.start, end: item.end, text: render(map[item.text], item.kind) }))
      .sort((a, b) => b.start - a.start)
    let out = original
    for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    writeFileSync(dest, out, 'utf8')
  }

  // Re-parse what we just wrote. The pre-check can only see literals that held
  // CJK; this catches anything that reached a literal by concatenation.
  for (const abs of modulesIn(STAGE)) {
    for (const item of collect(abs)) {
      throw new Error(`i18n: untranslated string survived staging at ${rel(abs)}:${String(item.line)}: ${JSON.stringify(item.text)}`)
    }
  }

  if (!quiet) {
    console.log(
      `i18n: staged ${String(sources.length)} file(s), ${String(found.length)} string(s) localized` +
        (stale.length > 0 ? ` (${String(stale.length)} stale entr${stale.length === 1 ? 'y' : 'ies'} — see 'report')` : ''),
    )
  }
  return { total: found.length, replaced: found.length, stale }
}

function report() {
  const map = loadMap()
  const sources = modulesIn(SRC_CLIENT)
  const seen = new Map()
  for (const abs of sources) for (const item of collect(abs)) if (!seen.has(item.text)) seen.set(item.text, item)

  const unmapped = [...seen.values()].filter((item) => !Object.hasOwn(map, item.text))
  const stale = Object.keys(map).filter((key) => !seen.has(key))
  const badValues = Object.entries(map).filter(([, value]) => typeof value !== 'string' || CJK.test(value))

  console.log(`${rel(MAP_FILE)}: ${String(Object.keys(map).length)} entr(ies); ${String(seen.size)} distinct string(s) in src/client`)
  console.log('')
  if (unmapped.length > 0) {
    console.log(`${String(unmapped.length)} UNTRANSLATED:`)
    for (const item of unmapped) console.log(`  ${item.file}:${String(item.line)}  ${JSON.stringify(item.text)}`)
  } else {
    console.log('0 untranslated — the overlay is complete')
  }
  if (badValues.length > 0) {
    console.log('')
    console.log(`${String(badValues.length)} entry/entries that are not English:`)
    for (const [key, value] of badValues) console.log(`  ${JSON.stringify(key)} -> ${JSON.stringify(value)}`)
  }
  if (stale.length > 0) {
    console.log('')
    console.log(`${String(stale.length)} STALE (upstream no longer uses these; safe to delete):`)
    for (const key of stale) console.log(`  ${JSON.stringify(key)}`)
  }
  return unmapped.length === 0 && badValues.length === 0
}

/**
 * Every distinct string in src/client that needs an English text, keyed by the
 * literal itself. Exported so tooling (and the one-off bootstrap that authored
 * en.json) reads the same inventory the build enforces, rather than a regex of
 * its own that could drift from it.
 *
 * @returns {Map<string, {file: string, line: number, column: number, kind: string, uses: number}>}
 */
export function inventory() {
  const seen = new Map()
  for (const abs of modulesIn(SRC_CLIENT)) {
    for (const item of collect(abs)) {
      const hit = seen.get(item.text)
      if (hit) hit.uses += 1
      else seen.set(item.text, { file: item.file, line: item.line, column: item.column, kind: item.kind, uses: 1 })
    }
  }
  return seen
}

function check() {
  stageClient({ quiet: true })
  if (!existsSync(BUNDLE)) {
    console.error('i18n: lib/client.js is missing — run the build first')
    process.exit(1)
  }
  const bundle = readFileSync(BUNDLE, 'utf8')
  if (CJK.test(bundle)) {
    const at = bundle.search(CJK)
    const line = bundle.slice(0, at).split('\n').length
    console.error(`i18n: lib/client.js still contains CJK at line ${String(line)}:`)
    console.error('  ' + JSON.stringify(bundle.slice(Math.max(0, at - 60), at + 60)))
    console.error('The shipped bundle must be English-only. Stage a fresh copy and rebuild.')
    process.exit(1)
  }
  console.log('i18n: src/client stages cleanly and lib/client.js is CJK-free')
  return true
}

/**
 * Only dispatch when this file IS the entry point.
 *
 * tsdown.config.ts imports stageClient() from here, and an unguarded
 * top-level `if (command === ...)` would fire on that import too — re-running
 * the staging pass in the middle of the build under tsdown's argv, where argv[2]
 * is a tsdown flag rather than a subcommand. Comparing against argv[1] is the
 * only reliable test that node ran *this* file.
 */
const entry = process.argv[1] ? resolve(process.argv[1]) : null
if (entry === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'check'
  if (command === 'stage') stageClient()
  else if (command === 'report') report()
  else if (command === 'check') check()
  else {
    console.error(`i18n: unknown command '${command}' (expected stage, report or check)`)
    process.exit(2)
  }
}
