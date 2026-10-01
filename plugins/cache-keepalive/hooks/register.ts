import type { Engine, Register } from 'claude-code'

// Assumes the 1h cache TTL. On the 5m TTL the first ping misses and the pings stop.
const TTL_MS = 60 * 60_000
const PING_EVERY_MS = TTL_MS - 10 * 60_000
const WRITE_MULT = 2

let timer: { cancel(): void } | undefined
let model = ''
let spent = 0
let budget = 0

// Cache read price over base input price
function readMult(id: string) {
  return /fable|mythos/.test(id) ? 0.025 : /opus-5-5/.test(id) ? 0.05 : 0.1
}

function stop() {
  timer?.cancel()
  timer = undefined
}

async function ping($: Engine) {
  const r = await $.model.fork({ prompt: 'Keep-alive ping. Reply with only: ok' })
  if (!('usage' in r) || !r.usage) return { ok: false, line: `no ping: ${r.reason}` }

  const u = r.usage
  const ctx = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  const hit = u.cache_read_input_tokens / Math.max(ctx, 1)
  spent += readMult(model) * u.cache_read_input_tokens + u.input_tokens
    + WRITE_MULT * u.cache_creation_input_tokens + 5 * u.output_tokens

  return {
    ok: hit > 0.9,
    line: `cache read ${u.cache_read_input_tokens}/${ctx} (${Math.round(hit * 100)}%), spent ${Math.round(spent)} of ${Math.round(budget)} token-equivalents`,
  }
}

function arm($: Engine) {
  stop()
  timer = $.clock.after(PING_EVERY_MS, async () => {
    timer = undefined
    const { ok, line } = await ping($)
    $.ui.log(`keepalive: ${line}`, { to: 'debug' })
    if (!ok) return $.ui.status('keepalive: missed, stopped')
    if (spent >= budget) return $.ui.status('keepalive: budget spent, stopped')
    $.ui.status('keepalive: warm')
    arm($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'keepalive', description: 'Ping the prompt cache now and report the hit rate' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) model = e.usage.model
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stop()
    $.ui.status(undefined)
    return next(e)
  })

  // Arm only when background work will wake the session later
  on('classic.Stop', async ($, e, next) => {
    if (e.background_tasks?.length) {
      const { context } = await $.session.usage()
      spent = 0
      budget = WRITE_MULT * (context.tokens ?? 0)
      $.ui.status(`keepalive: armed, ${e.background_tasks.length} task(s)`)
      arm($)
    }
    return next(e)
  })

  on('command.run', { command: 'keepalive' }, async $ => {
    const { context } = await $.session.usage()
    if (!budget) budget = WRITE_MULT * (context.tokens ?? 0)
    const { ok, line } = await ping($)
    return { text: `${ok ? 'HIT' : 'MISS'}: ${line}` }
  })
}
