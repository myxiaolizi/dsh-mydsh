/**
 * Data hooks.
 *
 * Every tab needs the same three things from the Host — a one-shot fetch, a
 * periodic refresh, and a way to fire an action and see the result — so they are
 * written once here instead of per tab. Two rules make the polling safe:
 *
 * - A hidden tab does not poll. `document.hidden` is checked before every tick,
 *   which is what keeps ten open entries from costing anything while the user is
 *   working in another window.
 * - A slow answer does not stack. Each hook keeps an in-flight flag and skips a
 *   tick while the previous request is still running, so a 90-day usage scan
 *   cannot queue eight more scans behind it.
 */

/**
 * Fetch `path` on mount and every `intervalMs`, re-fetching when any dependency
 * changes. Returns `{ data, error, loading, reload }`.
 *
 * @param path - path below `/api/mydsh`, or `null` to stay idle.
 * @param intervalMs - poll period; 0 disables the timer.
 * @param deps - values that force an immediate re-fetch when they change.
 */
function usePoll(path, intervalMs, deps) {
  const [data, setData] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [loading, setLoading] = useState(path !== null)
  const generation = useRef(0)
  const inflight = useRef(false)
  const signature = JSON.stringify(deps ?? [])

  const load = useCallback(
    (quiet) => {
      if (path === null) {
        setLoading(false)
        return Promise.resolve(undefined)
      }
      if (inflight.current) return Promise.resolve(undefined)
      inflight.current = true
      const mine = generation.current
      if (quiet !== true) setLoading(true)
      return api(path)
        .then((value) => {
          if (generation.current !== mine) return value
          setData(value)
          setError(undefined)
          return value
        })
        .catch((failure) => {
          if (generation.current === mine) setError(failure?.message ?? String(failure))
          return undefined
        })
        .finally(() => {
          inflight.current = false
          if (generation.current === mine) setLoading(false)
        })
    },
    // `signature` is the stringified dependency list, which is what actually
    // makes the callback change when a query parameter changes.
    [path, signature],
  )

  useEffect(() => {
    generation.current += 1
    load(false)
    return () => {
      generation.current += 1
    }
  }, [load])

  useEffect(() => {
    if (intervalMs === 0 || path === null) return undefined
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      load(true)
    }, intervalMs)
    const onVisible = () => {
      if (!document.hidden) load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, intervalMs, path])

  return { data, error, loading, reload: () => load(false) }
}

/**
 * Run one action against the Host and expose its pending and error state.
 * Returns `[run, state]` so a caller can `await run()` in a click handler.
 */
function useAction() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(undefined)
  const [result, setResult] = useState(undefined)

  const run = useCallback(async (path, body) => {
    setPending(true)
    setError(undefined)
    try {
      const value = await api(path, { body })
      setResult(value)
      return value
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return undefined
    } finally {
      setPending(false)
    }
  }, [])

  return [run, { pending, error, result, setError }]
}

/** Today's start in local time, matching the Host's window logic. */
function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** One time range as the Host expects it. */
const RANGE_PRESETS = [
  { value: 'today', key: 'rangeToday', days: 1 },
  { value: '3d', key: 'range3d', days: 3 },
  { value: '7d', key: 'range7d', days: 7 },
  { value: '30d', key: 'range30d', days: 30 },
  { value: '90d', key: 'range90d', days: 90 },
  { value: 'custom', key: 'rangeCustom', days: 0 },
]

/** A range picker that yields the query string fragment the Host parses. */
function RangeBar({ value, onChange, from, to, onFrom, onTo }) {
  const locale = activeLocale()
  const options = RANGE_PRESETS.map((preset) => ({ value: preset.value, label: t()[preset.key] }))
  return h(
    'div',
    { className: 'mydsh-inline' },
    h(Segmented, { value, onChange, options }),
    value !== 'custom'
      ? null
      : h(
          'div',
          { className: 'mydsh-inline' },
          h('input', {
            className: 'mydsh-input',
            type: 'date',
            value: from,
            onChange: (event) => onFrom(event.target.value),
          }),
          h('span', { className: 'mydsh-muted' }, locale === 'zh' ? '至' : 'to'),
          h('input', {
            className: 'mydsh-input',
            type: 'date',
            value: to,
            onChange: (event) => onTo(event.target.value),
          }),
        ),
  )
}

/** Build the `/usage/...` query for one range selection. */
function usageQuery(range, from, to) {
  if (range !== 'custom') return `range=${encodeURIComponent(range)}`
  const fromMs = from === '' ? 0 : new Date(`${from}T00:00:00`).getTime()
  const toMs = to === '' ? 0 : new Date(`${to}T23:59:59`).getTime()
  return `range=custom&from=${fromMs}&to=${toMs}`
}

/** Format a byte pair as "x / y" for estimate rows. */
function estimateLine(estimate) {
  if (estimate === undefined) return '—'
  return `${bytes(estimate.bytes)} · ${exact(estimate.files)}`
}
