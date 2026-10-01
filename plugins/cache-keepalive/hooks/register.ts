import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.start'>>[0]

// Assumes the 1h cache TTL. Overage switches to the 5m TTL, so the mod stays off while any
// rate-limit window is at 100%. A 5m TTL it fails to infer makes the first ping miss and stop the pings.
const PING_EVERY_MS = 50 * 60_000
const WRITE_MULT = 2
const OUTPUT_MULT = 5

// Compaction cost per context token and summary size over context, used until a compaction is measured
const COMPACT_COST_GUESS = 0.6
const SUMMARY_RATIO_GUESS = 0.15

let timer: { cancel(): void } | undefined
let generation = 0
let compactOnCap = false
let compacting = false
let spent = 0
let budget = 0
let context = 0

// Cache read price over base input price
function readMult(model: string) {
  const id = model.toLowerCase()
  return /fable|mythos/.test(id) ? 0.025 : /opus[- ]?5[-. ]5/.test(id) ? 0.05 : 0.1
}

// Bumping the generation also stops a ping already in flight from rearming
function stop() {
  generation++
  timer?.cancel()
  timer = undefined
}

// Mods see only the account-wide windows, not model-scoped limits such as Fable's weekly one
function inOverage(limits: { percentUsed: number }[]) {
  return limits.some(l => l.percentUsed >= 100)
}

// Input-token equivalents a call cost, reads priced for the session's model
function cost(u: { input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number }, r: number) {
  return r * u.cache_read_input_tokens + u.input_tokens
    + WRITE_MULT * u.cache_creation_input_tokens + OUTPUT_MULT * u.output_tokens
}

async function ping($: Engine) {
  const r = await $.model.fork({ prompt: 'Keep-alive ping. Reply with only: ok' })
  if (!('usage' in r)) return { ok: false, line: `no ping: ${r.reason}` }

  const u = r.usage
  context = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  const hit = u.cache_read_input_tokens / Math.max(context, 1)
  spent += cost(u, readMult(await $.session.model()))

  return {
    ok: hit > 0.9,
    line: `cache read ${u.cache_read_input_tokens}/${context} (${Math.round(hit * 100)}%), spent ${Math.round(spent)} of ${Math.round(budget)} token-equivalents`,
  }
}

// Compacting pays when its own cost plus re-caching the summary is below re-caching the whole context
async function compactPays($: Engine) {
  const perToken = (await $.store.get('compactCost') as number | undefined) ?? COMPACT_COST_GUESS
  const ratio = (await $.store.get('summaryRatio') as number | undefined) ?? SUMMARY_RATIO_GUESS
  return perToken + WRITE_MULT * ratio < WRITE_MULT
}

async function compact($: Engine) {
  compacting = true
  try {
    const r = await $.session.compact({ instructions: 'Also keep the background tasks\' IDs, output paths, and what to do when they finish.' })
    if (r.skip !== undefined) return `compaction skipped: ${r.skip}`

    const before = r.tokensBefore ?? context
    if (r.usage && before) {
      await $.store.set('compactCost', cost(r.usage, readMult(await $.session.model())) / before)
      if (r.tokensAfter) await $.store.set('summaryRatio', r.tokensAfter / before)
    }
    const read = r.usage ? `${r.usage.cache_read_input_tokens} read from cache, ${r.usage.output_tokens} output` : 'no usage reported'
    return `compacted ${before} → ${r.tokensAfter ?? '?'} tokens (${read})`
  } catch (err) {
    return `compaction refused: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    compacting = false
  }
}

function arm($: Engine) {
  stop()
  const armedAt = generation
  timer = $.clock.after(PING_EVERY_MS, async () => {
    timer = undefined
    const { ok, line } = await ping($)
    if (generation !== armedAt) return
    $.ui.log(`keepalive: ${line}`, { to: 'debug' })
    if (!ok) return $.ui.status('keepalive: missed, stopped')
    if (spent < budget) {
      $.ui.status('keepalive: warm')
      return arm($)
    }

    if (!compactOnCap || !(await compactPays($))) return $.ui.status('keepalive: budget spent, stopped')
    $.ui.status('keepalive: compacting')
    const result = await compact($)
    $.ui.log(`keepalive: ${result}`, { to: 'debug' })
    $.ui.status(`keepalive: ${result.split(' (')[0]}`)
  })
}

export const register: Register = (on, options) => {
  compactOnCap = options.compactOnCap === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'keepalive', description: 'Ping the prompt cache now and report the hit rate' })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stop()
    if (!compacting) $.ui.status(undefined)
    return next(e)
  })

  // Arm only when background work will wake the session later
  on('classic.Stop', async ($, e, next) => {
    if (e.background_tasks?.length && !compacting) {
      const { context: ctx, rateLimits } = await $.session.usage()
      if (inOverage(rateLimits)) {
        $.ui.status('keepalive: off in overage')
        return next(e)
      }
      spent = 0
      budget = WRITE_MULT * (ctx.tokens ?? 0)
      $.ui.status(`keepalive: armed, ${e.background_tasks.length} task(s)`)
      arm($)
    }
    return next(e)
  })

  // Other sessions can push the account into overage during the wait
  on('session.measure', async ($, e, next) => {
    if (timer && e.changed.includes('rateLimits') && inOverage(e.rateLimits)) {
      stop()
      $.ui.status('keepalive: overage, stopped')
    }
    return next(e)
  })

  on('command.run', { command: 'keepalive' }, async $ => {
    const { context: ctx } = await $.session.usage()
    if (!budget) budget = WRITE_MULT * (ctx.tokens ?? 0)
    const { ok, line } = await ping($)
    return { text: `${ok ? 'HIT' : 'MISS'}: ${line}` }
  })
}
