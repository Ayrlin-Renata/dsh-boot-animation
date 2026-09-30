/**
 * Session binding: which conversation is current, and whether it is new.
 *
 * Two pieces of hard-won knowledge live here and must not be lost:
 *
 * 1. `hooks.session` is a `SessionFace` — `ISession & ObservableSnapshot<SessionSnapshot>`
 *    (see `@deepseek-ai/dsh-api-session-controller`) — so "this conversation has
 *    no turns yet" is `getSnapshot().blank`. Before DSH 0.2.0 the flag was a
 *    `blankBit` field directly on the binding. Reading the field that is no
 *    longer there does not throw, it answers `undefined`, so the failure was
 *    silence: auto-play simply stopped happening. Both shapes are read, and the
 *    face is SUBSCRIBED to rather than sampled once, because the flag arrives on
 *    a nested snapshot that can settle after the binding changes.
 *
 * 2. Both the pin and the "already played" record are per session, keyed by
 *    session id, and both live in localStorage. They are client concerns: the
 *    host never learns a session id from this plugin.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { log } from './diagnostics.js'

/** The part of a `SessionFace` this plugin reads. */
export type SessionFaceLike = {
  getSnapshot?: () => { blank?: unknown } | null | undefined
  subscribe?: (onChange: () => void) => unknown
  blankBit?: unknown
}

/** The resolved ui-session binding as the built-in source publishes it. */
export type Binding = {
  key?: unknown
  hooks?: { session?: SessionFaceLike }
  keyedHooks?: unknown
  props?: { sessionId?: unknown }
}

/** The `adapter.current` store, as far as this plugin needs it. */
export type CurrentStore = {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => unknown
}

/**
 * True when the current conversation still has no turns, from whichever shape
 * the running host exposes.
 *
 * Exported so `scripts/verify-blank.mjs` can exercise THIS shipped function
 * rather than a copy of it. The bug it guards against is a silent one — a field
 * that moved answers `undefined` instead of throwing — so a test that only
 * checked "the bundle built" would not have caught it.
 */
export function isBlankSession(session: SessionFaceLike | undefined): boolean {
  if (session === null || session === undefined) return false
  if (typeof session.getSnapshot === 'function') {
    try {
      const snapshot = session.getSnapshot()
      // Trust the snapshot only when the key is actually present: a pre-0.2.0
      // face may not carry it, and an `undefined` there must not shadow the
      // legacy field.
      if (snapshot !== null && typeof snapshot === 'object' && 'blank' in snapshot) {
        return snapshot.blank === true
      }
    } catch {
      /* a face that throws on read falls through to the legacy field */
    }
  }
  return session.blankBit === true
}

const noopSubscribe = () => () => {}

/** Subscribe to the current-conversation store, tolerating its absence. */
export function useCurrentSession(store: CurrentStore | null): {
  sessionId: string | null
  isNewConversation: boolean
} {
  const binding = useSyncExternalStore(
    store === null ? noopSubscribe : store.subscribe,
    store === null ? () => null : store.getSnapshot,
  ) as Binding | null

  const session = binding?.hooks?.session

  // The face is itself an observable, so subscribe to it rather than sampling it
  // once. A session is created blank and its snapshot can settle after the
  // binding changes; judging it only on the render that changed `sessionId` made
  // auto-play depend on which of two stores happened to settle first.
  const subscribeBlank = useCallback(
    (onChange: () => void): (() => void) => {
      if (session === undefined || typeof session.subscribe !== 'function') return () => {}
      const stop = session.subscribe(onChange)
      return typeof stop === 'function' ? (stop as () => void) : () => {}
    },
    [session],
  )
  const isNewConversation = useSyncExternalStore(subscribeBlank, () => isBlankSession(session))

  const sessionId = typeof binding?.props?.sessionId === 'string' ? binding.props.sessionId : null
  return { sessionId, isNewConversation }
}

const SEEN_KEY = 'dsh-boot-animation:played'
const PIN_KEY = 'dsh-boot-animation:pinned'
const MAX_SEEN = 80

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function hasPlayed(sessionId: string): boolean {
  return readSeen().includes(sessionId)
}

export function markPlayed(sessionId: string): void {
  try {
    const seen = readSeen()
    if (!seen.includes(sessionId)) seen.push(sessionId)
    while (seen.length > MAX_SEEN) seen.shift()
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode: it simply replays next time */
  }
}

export function readPinned(): string | null {
  try {
    const value = window.localStorage.getItem(PIN_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

export function writePinned(sessionId: string | null): void {
  try {
    if (sessionId === null) window.localStorage.removeItem(PIN_KEY)
    else window.localStorage.setItem(PIN_KEY, sessionId)
  } catch {
    /* private mode: the pin simply does not persist */
  }
  log('pin written', { sessionId })
}
