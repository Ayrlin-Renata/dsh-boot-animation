/**
 * client-bundle.mjs — load the SHIPPED browser bundle outside a browser.
 *
 * The client half is a factory `window.__ModuleLoader__.load({ id, factory })`,
 * which is exactly what makes it testable: give it a stub loader and a stub
 * React, and the real module body evaluates — the same code the GUI runs.
 *
 * These tests deliberately do NOT test the React components (that needs a DOM and
 * a real browser, which `verify-letterbox.mjs` and `verify-boot-animation.mjs`
 * already cover end to end). They test the STORE, which is where the clip
 * identity rules live: preview must not select, a switch must change the URL, and
 * the URL must name one clip.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUNDLE = join(HERE, '..', '..', 'lib', 'client.js')

/** Enough React for module evaluation; nothing here renders. */
export const reactStub = {
  Fragment: Symbol.for('react.fragment'),
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * Evaluate `lib/client.js` and return its module exports.
 *
 * @returns {Record<string, any>}
 */
export function loadClientBundle() {
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
    localStorage: (() => {
      const map = new Map()
      return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
      }
    })(),
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    fullscreenElement: null,
  }
  try {
    // eslint-disable-next-line no-eval
    eval(readFileSync(BUNDLE, 'utf8'))
  } catch (error) {
    throw new Error(`could not evaluate lib/client.js: ${String(error?.message ?? error)}`)
  }
  if (loaded === null) throw new Error('lib/client.js did not call the module loader')
  return loaded
}

/**
 * A fetch stub that answers the plugin's routes from a fixed catalog.
 *
 * `?session=` is honoured the way the real host honours it: a pin answers for
 * its own conversation, and a pin write answers with the pin AND NOTHING ELSE —
 * no settings fields at all. That last detail is modelled deliberately, because
 * "a conversation write must not blank the global settings" is exactly the bug
 * this shape would otherwise hide.
 *
 * @param {{ clips: Array<any>, selectedClipId?: string | null, randomPlayback?: boolean, fitMode?: string, resolvedClipId?: string | null, conversationOverrides?: Record<string, string> }} options
 */
export function makeFetchStub(options) {
  const calls = []
  /** @type {Record<string, string>} */
  const overrides = { ...(options.conversationOverrides ?? {}) }
  const state = {
    selectedClipId: options.selectedClipId ?? null,
    randomPlayback: options.randomPlayback ?? false,
    fitMode: options.fitMode ?? 'cover',
    conversationOverrides: overrides,
  }
  /** The `?session=` of a request URL, or null. */
  const sessionOf = (url) => new URL(String(url), 'http://stub.invalid').searchParams.get('session')
  /** The pin in effect for the session a URL names. */
  const pinnedFor = (url) => {
    const session = sessionOf(url)
    return session !== null && overrides[session] !== undefined ? overrides[session] : null
  }
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
    const respond = (payload) => ({
      ok: true,
      status: 200,
      json: async () => payload,
    })
    const text = String(url)
    if (text.includes('/select')) {
      const patch = init.body === undefined ? {} : JSON.parse(String(init.body))
      if (patch.scope === 'conversation') {
        const session = String(patch.sessionId ?? '')
        if (patch.id === null || patch.id === undefined || patch.id === '') delete overrides[session]
        else overrides[session] = String(patch.id)
        return respond({
          ok: true,
          scope: 'conversation',
          conversationClipId: overrides[session] ?? null,
          name: 'stub',
        })
      }
      if (patch.selectedClipId !== undefined) state.selectedClipId = patch.selectedClipId
      if (patch.randomPlayback !== undefined) state.randomPlayback = patch.randomPlayback
      if (patch.fitMode !== undefined) state.fitMode = patch.fitMode
      return respond({
        ok: true,
        selectedClipId: state.selectedClipId,
        randomPlayback: state.randomPlayback,
        fitMode: state.fitMode,
        name: 'stub',
      })
    }
    if (text.includes('/resolve.json')) {
      const pinned = pinnedFor(text)
      if (pinned !== null) return respond({ clipId: pinned, how: 'conversation', version: 'v1', mediaUrl: null })
      return respond({ clipId: options.resolvedClipId ?? state.selectedClipId, how: 'selected', version: 'v1', mediaUrl: null })
    }
    return respond({
      videos: options.clips,
      userDir: '/tmp/videos',
      accepts: ['.mp4'],
      selectedClipId: state.selectedClipId,
      randomPlayback: state.randomPlayback,
      fitMode: state.fitMode,
      conversationClipId: pinnedFor(text),
      conversationOverrideCount: Object.keys(overrides).length,
      sessionKnown: sessionOf(text) !== null,
    })
  }
  return { fetchStub, calls, state }
}

/** The four built-in clips as the host lists them. */
export function builtinClips() {
  return [
    { id: 'builtin:brand', name: '品牌', file: null, ext: '.mp4', source: 'embedded', bytes: 1308725, version: 'aaaa1111', mediaUrl: '/dsh-boot-animation/media/builtin%3Abrand' },
    { id: 'builtin:cyberpunk', name: '赛博朋克', file: null, ext: '.mp4', source: 'embedded', bytes: 1856280, version: 'bbbb2222', mediaUrl: '/dsh-boot-animation/media/builtin%3Acyberpunk' },
    { id: 'builtin:awakening', name: '苏醒', file: null, ext: '.mp4', source: 'embedded', bytes: 2600325, version: 'cccc3333', mediaUrl: '/dsh-boot-animation/media/builtin%3Aawakening' },
    { id: 'builtin:startup', name: '启动', file: null, ext: '.mp4', source: 'embedded', bytes: 3305269, version: 'dddd4444', mediaUrl: '/dsh-boot-animation/media/builtin%3Astartup' },
  ]
}
