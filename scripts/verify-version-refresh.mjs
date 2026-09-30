/**
 * verify-version-refresh.mjs — the next preview must not keep the previous ?v= key.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      loaded = factory((name) => {
        if (name === 'react' || name === 'react/jsx-runtime') return reactStub
        throw new Error(`unexpected require(${name})`)
      })
    },
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  clearTimeout: () => {},
  setTimeout: () => 0,
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, textContent: '' }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

try {
  // eslint-disable-next-line no-eval
  eval(readFileSync(BUNDLE, 'utf8'))
} catch (error) {
  console.error(`evaluating the bundle threw — ${String(error?.message ?? error)}`)
  process.exit(2)
}


if (
  loaded === null ||
  typeof loaded.refreshActiveVersion !== 'function' ||
  typeof loaded.videoSrc !== 'function'
) {
  console.error('verify-version-refresh: required bundle exports are missing')
  process.exit(2)
}

let currentVersion = 'old-key'
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/videos.json')) {
    return { ok: true, json: async () => ({ activeVersion: currentVersion }) }
  }
  return { ok: true, json: async () => ({}) }
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

const failures = []
const check = (ok, label) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
console.log(`bundle: ${BUNDLE}\n`)

loaded.refreshActiveVersion()
await flush()
check(loaded.videoSrc().endsWith('?v=old-key'), 'initial resolve pins the old content key')

currentVersion = 'new-key'
loaded.refreshActiveVersion()
check(
  loaded.videoSrc() === '/dsh-boot-animation/boot.mp4',
  'refresh drops the old key synchronously before the next overlay mount',
)
await flush()
check(loaded.videoSrc().endsWith('?v=new-key'), 're-resolve pins the newly selected content key')
check(!loaded.videoSrc().includes('old-key'), 'old content key is no longer returned')

const bundleText = readFileSync(BUNDLE, 'utf8')
check(
  bundleText.includes('refreshActiveVersion();'),
  'the successful selection path invokes refreshActiveVersion()',
)

if (failures.length === 0) {
  console.log('\nall version-refresh checks passed')
  process.exit(0)
}
console.log(`\n${failures.length} version-refresh check(s) failed`)
process.exit(1)
