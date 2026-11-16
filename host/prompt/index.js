/**
 * Budget guard and prompt-section helpers that stayed on the Host.
 *
 * The personalization text itself moved to `host/personalize/` in V2, because
 * assembling five sections from four independent features no longer fits in a
 * file whose other job is refusing a model step. What remains here is the one
 * piece that must run at `agent/pre-step`: the budget circuit breaker, plus the
 * tiny helper that turns an over-budget evaluation into a refusal.
 *
 * The refusal shape matters. Returning `deny` closes the step cleanly — the
 * turn ends with the message the user sees and no half-written assistant
 * message is appended — which is why a paused budget does not corrupt the
 * session log.
 */

/**
 * Register the budget circuit breaker.
 * @param ctx - plugin context.
 * @param usage - the usage engine (`overBudgetContext`, `isPaused`).
 * @param getSettings - reads the live settings document.
 * @param onNotice - pushes a notice into the settings page.
 * @returns the disposer, or `undefined` when the event surface is absent.
 */
export function createBudgetGuard(ctx, usage, getSettings, onNotice) {
  if (typeof ctx?.on !== 'function') return undefined

  /** Budgets already reported, so one breach does not spam the notice list. */
  const reported = new Set()

  return ctx.on('agent/pre-step', async (payload, next) => {
    const settings = getSettings()
    if (settings?.usage?.enabled !== true) return next()
    const pauseBudgets = (settings.usage.budgets ?? []).filter((budget) => budget.enabled !== false && budget.action === 'pause')
    if (pauseBudgets.length === 0) return next()

    let status
    try {
      status = await usage.budgets()
    } catch {
      // A failed evaluation must never block work: the budget is a guard, not a
      // dependency, so an unreadable ledger degrades to "no breach".
      return next()
    }

    const breached = (status?.evaluation ?? []).filter(
      (entry) => entry.state === 'over' && pauseBudgets.some((budget) => budget.id === entry.id),
    )
    if (breached.length === 0) return next()

    for (const entry of breached) {
      if (reported.has(entry.id)) continue
      reported.add(entry.id)
      onNotice?.({
        tone: 'warn',
        title: '预算已用尽',
        message: `${entry.label === '' ? entry.scope : entry.label} 已超出 ${entry.period === 'day' ? '当日' : entry.period === 'week' ? '本周' : '本月'}预算，已暂停新的模型请求。可在 用量与计费 中提高上限或改为仅提醒。`,
      })
    }

    const first = breached[0]
    return {
      deny: true,
      reason: `用量预算已用尽（${first.label === '' ? first.scope : first.label}），本步未向模型发送请求。`,
    }
  })
}
