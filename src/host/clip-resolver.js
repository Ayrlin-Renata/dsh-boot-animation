/**
 * ClipResolver — ClipId in, exactly one clip out.
 *
 * This is the single decision point for "which clip plays". Every path goes
 * through it:
 *
 *   resolve('builtin:brand')      an explicit clip
 *   resolve('active')             whatever the current mode says
 *   resolveActive()               the same, with the reason attached
 *
 * `how` is returned rather than logged, so `/status.json` can explain WHY a clip
 * is live (selection / random / env / legacy drop-in / library / embedded) and a
 * test can assert it instead of inferring it.
 *
 * The priority chain is the historical one, kept deliberately: an installed copy
 * that relied on `$DSH_HOME/boot-animation/intro.mp4` or on DSH_BOOT_ANIMATION
 * must keep working after this refactor.
 */
import { basename, extname } from 'node:path'
import { ACTIVE_ALIAS, fileClipId, normalizeClipId } from './clip-id.js'
import { ClipError } from './errors.js'

export class ClipResolver {
  /**
   * @param {object} options
   * @param {import('./clip-registry.js').ClipRegistry} options.registry
   * @param {import('./selection-store.js').SelectionStore} options.selection
   * @param {import('./random-controller.js').RandomController} options.random
   * @param {() => string | null} [options.envPath] DSH_BOOT_ANIMATION, read per call
   * @param {{ event: (kind: string, detail?: unknown) => void } | null} [options.diagnostics]
   */
  constructor(options) {
    this.registry = options.registry
    this.selection = options.selection
    this.random = options.random
    this.envPath = options.envPath ?? (() => null)
    this.diagnostics = options.diagnostics ?? null
  }

  /** Every clip that can actually be played right now. */
  playable() {
    return this.registry.list().filter((clip) => clip.bytes > 0)
  }

  /**
   * Resolve one id.
   *
   * @param {string | null | undefined} rawId
   * @returns {{ clip: import('./clip-registry.js').Clip, how: string } | null}
   */
  resolve(rawId) {
    const id = normalizeClipId(rawId)
    if (id === null) {
      this.diagnostics?.event('resolve-rejected', { id: String(rawId) })
      return null
    }
    if (id === ACTIVE_ALIAS) return this.resolveActive()
    const clip = this.registry.get(id)
    if (clip === null) {
      this.diagnostics?.event('resolve-miss', { id })
      return null
    }
    return { clip, how: 'explicit' }
  }

  /**
   * Whatever should play now, and why.
   *
   * @returns {{ clip: import('./clip-registry.js').Clip | null, how: string }}
   */
  resolveActive() {
    const clips = this.registry.list()

    // Random playback wins over a stored selection: it is an explicit mode, and
    // the stored selection is only what it falls back to when switched off.
    if (this.selection.read().randomPlayback) {
      const pool = clips.filter((clip) => clip.bytes > 0)
      const chosen = this.random.pick(pool)
      if (chosen !== null) {
        this.diagnostics?.event('active-random', { id: chosen.id, pool: pool.length })
        return { clip: chosen, how: 'random' }
      }
    }

    const picked = this.selection.read().selectedClipId
    if (picked !== null) {
      // A deleted pick is not an error: fall through rather than show nothing.
      const hit = this.registry.get(picked)
      if (hit !== null) return { clip: hit, how: 'selected' }
      this.diagnostics?.event('selection-stale', { id: picked })
    }

    const envClip = this.#envClip()
    if (envClip !== null) return { clip: envClip, how: 'env' }

    const legacyDropIn = clips.find((clip) => clip.source === 'yours' && clip.legacy)
    if (legacyDropIn !== undefined) return { clip: legacyDropIn, how: 'legacy-dropin' }

    const yours = clips.find((clip) => clip.source === 'yours')
    if (yours !== undefined) return { clip: yours, how: 'library' }

    // Nothing of the user's: a built-in. Embedded, so this cannot come up empty,
    // which is the whole point of embedding them.
    const embedded = clips.find((clip) => clip.source === 'embedded')
    if (embedded !== undefined) return { clip: embedded, how: 'embedded' }

    return { clip: null, how: 'none' }
  }

  /**
   * The DSH_BOOT_ANIMATION clip, adopted into the registry when it points
   * outside the managed directories so it is listed like any other clip.
   */
  #envClip() {
    const raw = this.envPath()
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const target = raw.trim()
    const normalised = target.replace(/\\/g, '/').toLowerCase()
    const known = this.registry.list().find((clip) => clip.path !== null && clip.path.replace(/\\/g, '/').toLowerCase() === normalised)
    if (known !== undefined) return known
    try {
      return this.registry.adopt(target, 'env')
    } catch (cause) {
      const error = cause instanceof ClipError ? cause : new ClipError(`env clip unusable: ${String(cause)}`)
      this.diagnostics?.event('env-clip-error', { message: error.message, name: basename(target, extname(target)) })
      return null
    }
  }

  /** A stable id for a path, without touching the registry. For diagnostics. */
  static idForPath(p) {
    return fileClipId(p)
  }
}
