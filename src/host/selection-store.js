/**
 * SelectionStore — the ONE place the user's choices live.
 *
 * `$DSH_HOME/boot-animation/selection.json` holds settings and nothing else:
 *
 *   { "version": 2, "selectedClipId": "builtin:brand",
 *     "randomPlayback": false, "fitMode": "cover" }
 *
 * Three rules, each of which is a bug this file exists to prevent:
 *
 * 1. NO MEDIA PATHS. Earlier shapes stored an id that could be a path, so a
 *    machine-specific absolute path ended up in a file that is meant to be
 *    portable and hand-editable. A ClipId is now validated on the way in, and
 *    a path fails validation (it contains a separator) and is dropped.
 *
 * 2. A CORRUPT FILE IS NOT A STARTUP FAILURE. Any parse error, any wrong type,
 *    any unknown version resolves to defaults. The plugin must still load; the
 *    worst acceptable outcome is that the user's pick is forgotten, and that is
 *    reported through diagnostics rather than thrown.
 *
 * 3. MIGRATION IS A PURE FUNCTION. `migrate()` takes whatever was on disk and
 *    returns a valid, current-schema selection — no I/O, no globals — so it can
 *    be exercised directly by tests instead of being inferred from behaviour.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeClipId } from './clip-id.js'
import { ClipError } from './errors.js'

/** Current on-disk schema. Bump and extend `migrate` together. */
export const SELECTION_VERSION = 2

/** Fit modes the client understands; anything else falls back to the default. */
export const FIT_MODES = ['cover', 'contain']
export const DEFAULT_FIT = 'cover'

/** A fresh selection. Every field is spelled out so the shape is greppable. */
export function defaultSelection() {
  return {
    version: SELECTION_VERSION,
    selectedClipId: null,
    randomPlayback: false,
    fitMode: DEFAULT_FIT,
  }
}

function coerceFit(value) {
  return typeof value === 'string' && FIT_MODES.includes(value) ? value : DEFAULT_FIT
}

function coerceBoolean(value) {
  return value === true
}

/**
 * Any historical or damaged shape to a valid current selection.
 *
 * Pure. Accepts:
 *   - `{ version: 2, ... }`            current
 *   - `{ id: "builtin:brand" }`        v1 (0.1.x - 0.2.x): the id field was bare
 *   - `{ selectedClipId: "..." }`      v2 without a version stamp
 *   - `null`, `undefined`, garbage     defaults
 *
 * @param {unknown} raw
 * @returns {{ selection: ReturnType<typeof defaultSelection>, migrated: boolean, reason: string }}
 */
export function migrate(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { selection: defaultSelection(), migrated: false, reason: 'no usable value on disk' }
  }
  const source = /** @type {Record<string, unknown>} */ (raw)
  const declared = typeof source.version === 'number' ? source.version : null

  // The 0.1.x/0.2.x shape: { id, at }. Kept because it is what every installed
  // copy has on disk right now, and the pick is the one thing worth carrying over.
  const legacyId = typeof source.id === 'string' ? source.id : null
  const modernId = typeof source.selectedClipId === 'string' ? source.selectedClipId : null
  const rawId = modernId ?? legacyId

  const selectedClipId = rawId === null ? null : normalizeClipId(rawId)
  const next = {
    version: SELECTION_VERSION,
    selectedClipId,
    randomPlayback: coerceBoolean(source.randomPlayback),
    fitMode: coerceFit(source.fitMode ?? source.fit),
  }

  const migrated = declared !== SELECTION_VERSION
  const reason = migrated
    ? declared === null
      ? 'no version stamp; read as the legacy shape'
      : `version ${String(declared)} -> ${String(SELECTION_VERSION)}`
    : ''
  return { selection: next, migrated, reason }
}

/**
 * Reads, validates, migrates and writes the selection file.
 *
 * Never throws out of `read()`: a selection store that can fail a boot is
 * exactly the class of defect this refactor exists to remove.
 */
export class SelectionStore {
  /**
   * @param {string} file absolute path to selection.json
   * @param {{ diagnostics?: { event: (kind: string, detail?: unknown) => void } }} [options]
   */
  constructor(file, options = {}) {
    this.file = file
    this.diagnostics = options.diagnostics ?? null
    /** @type {{ signature: string, selection: ReturnType<typeof defaultSelection> } | null} */
    this.cache = null
  }

  /** Signature of the file's current state, or null when it does not exist. */
  #signature() {
    try {
      const stats = statSync(this.file)
      return `${String(stats.size)}@${String(Math.round(stats.mtimeMs))}`
    } catch {
      return null
    }
  }

  /**
   * The current selection. Always a valid v2 object.
   * @returns {ReturnType<typeof defaultSelection>}
   */
  read() {
    const signature = this.#signature()
    if (this.cache !== null && this.cache.signature === signature) return this.cache.selection
    if (signature === null) {
      // No file yet: the defaults, and do not cache a negative so the first
      // write is picked up without an invalidation dance.
      this.cache = null
      return defaultSelection()
    }

    let parsed = null
    let parseFailed = false
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      parseFailed = true
      this.diagnostics?.event('selection-unreadable', { reason: String(error?.message ?? error) })
    }

    const { selection, migrated, reason } = migrate(parseFailed ? null : parsed)
    if (parseFailed) {
      this.diagnostics?.event('selection-reset', { reason: 'file could not be parsed; defaults restored' })
      // REPAIR, not just tolerate. "A corrupt file does not stop the plugin" is
      // only half the requirement; the other half is that the file comes back
      // valid, so the next read is an ordinary one and a hand-edit habit does
      // not leave the store permanently degraded.
      try {
        this.#write(selection)
      } catch (error) {
        this.diagnostics?.event('selection-reset-write-failed', { reason: String(error?.message ?? error) })
      }
    } else if (migrated) {
      this.diagnostics?.event('selection-migrated', { reason })
      // Persist the migration so the next start is a plain v2 read. A failure
      // here must not stop the plugin: the in-memory value is already correct.
      try {
        this.#write(selection)
      } catch (error) {
        this.diagnostics?.event('selection-migrate-write-failed', { reason: String(error?.message ?? error) })
      }
    }
    this.cache = { signature: this.#signature(), selection }
    return selection
  }

  /**
   * Merge a patch into the selection and persist it.
   *
   * Only known fields are accepted; an unknown key is a programming error and
   * throws a ClipError rather than silently writing junk into the file.
   *
   * @param {{ selectedClipId?: string | null, randomPlayback?: boolean, fitMode?: string }} patch
   * @returns {ReturnType<typeof defaultSelection>}
   */
  write(patch) {
    const current = this.read()
    /** @type {ReturnType<typeof defaultSelection>} */
    const next = { ...current }
    if (Object.prototype.hasOwnProperty.call(patch, 'selectedClipId')) {
      const raw = patch.selectedClipId
      if (raw === null) next.selectedClipId = null
      else {
        const id = normalizeClipId(raw)
        if (id === null || id === 'active') {
          throw new ClipError(`selectedClipId must be a real ClipId, got: ${String(raw)}`)
        }
        next.selectedClipId = id
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'randomPlayback')) {
      next.randomPlayback = coerceBoolean(patch.randomPlayback)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'fitMode')) {
      next.fitMode = coerceFit(patch.fitMode)
    }
    for (const key of Object.keys(patch)) {
      if (!['selectedClipId', 'randomPlayback', 'fitMode'].includes(key)) {
        throw new ClipError(`selection has no field "${key}"`)
      }
    }
    this.#write(next)
    this.cache = { signature: this.#signature(), selection: next }
    return next
  }

  /** Atomic-ish replace: a half-written file would silently reset the pick. */
  #write(selection) {
    mkdirSync(dirname(this.file), { recursive: true })
    const payload = JSON.stringify(selection, null, 2) + '\n'
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, payload, 'utf8')
    try {
      renameSync(tmp, this.file)
    } catch {
      writeFileSync(this.file, payload, 'utf8')
    }
  }
}
