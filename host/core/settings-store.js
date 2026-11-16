/**
 * The plugin-wide settings owner.
 *
 * One instance is shared by every engine. It reads the document once on
 * activation, hands out the current value synchronously (engines read it on
 * every event and must not await), persists accepted changes atomically, and
 * notifies subscribers so live engines reconfigure without a restart.
 *
 * A second responsibility was added in V2: a revision counter. The settings
 * page needs to notice a change written by another tab or by the agent, and
 * polling the whole document for that is wasteful once the document grows to
 * tens of kilobytes. The counter turns the poll into a two-field response.
 */

import { dataDir, readJson, writeJsonAtomic } from './store.js'
import { normalize } from './settings.js'

const FILE = () => dataDir('settings.json')

export class SettingsStore {
  /** @type {object} */
  #value

  /** Bumped on every accepted change; persisted so a restart keeps it monotonic. */
  #revision = 0

  /** @type {Set<(next: object, previous: object) => void>} */
  #listeners = new Set()

  /** @type {Promise<void>} */
  #queue = Promise.resolve()

  /** @param value - already-normalised document. */
  constructor(value, revision = 0) {
    this.#value = value
    this.#revision = revision
  }

  /**
   * Load the document from disk, falling back to defaults.
   * @returns the live store.
   */
  static async open() {
    const raw = await readJson(FILE())
    const revision = Number.isFinite(raw?.revision) ? Number(raw.revision) : 0
    return new SettingsStore(normalize(raw), revision)
  }

  /** The current document. Callers must treat it as immutable. */
  get current() {
    return this.#value
  }

  /** Monotonic change counter, cheap to send on every poll. */
  get revision() {
    return this.#revision
  }

  /**
   * Subscribe to accepted changes.
   * @param listener - called with the next and previous documents.
   * @returns unsubscribe.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Merge a patch, validate, persist, then publish.
   *
   * The queue serialises writes so two panels saving at once cannot interleave
   * a read-modify-write and lose the first one.
   *
   * @param patch - partial document from the settings page.
   * @returns the accepted document.
   */
  async update(patch) {
    const run = async () => {
      const previous = this.#value
      const merged = normalize(deepPatch(previous, patch))
      const revision = this.#revision + 1
      // `revision` is written beside the document but is not a settings field,
      // so `normalize` dropping it is expected and harmless.
      await writeJsonAtomic(FILE(), { ...merged, revision })
      this.#value = merged
      this.#revision = revision
      for (const listener of this.#listeners) {
        try {
          listener(merged, previous)
        } catch (error) {
          console.warn(`[dsh-mydsh] settings listener failed: ${error?.message ?? error}`)
        }
      }
      return merged
    }
    const next = this.#queue.then(run, run)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/** Merge objects deeply, replacing arrays and scalars. */
function deepPatch(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] !== null &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepPatch(base[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}
