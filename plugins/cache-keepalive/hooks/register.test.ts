import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const task = { id: 'b1', type: 'shell', status: 'running', description: 'build' }

// Stands in for the engine: a 1M-token context, cache hits on every fork, records statuses and forks.
// The timer fires only on `fire(at)`, so a test sets the wall time it fires at, as a machine that slept would.
function engine(on: On) {
  const seen = { statuses: [] as (string | undefined)[], forks: 0 }
  let now = Date.UTC(2026, 9, 7, 12)
  let resolve = () => {}
  on('clock.now', () => ({ value: now }) as never)
  on('clock.after', () => new Promise(r => { resolve = () => r({ value: undefined }) }) as never)
  const clock = { async fire(minutes: number) { now += minutes * MIN; resolve(); for (let i = 0; i < 1000; i++) await Promise.resolve() } }
  on('classic.Stop', () => ({}) as never)
  on('session.usage', () => ({ value: { context: { tokens: 1_000_000, window: 1_000_000, percent: 100 }, rateLimits: [] } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('model.fork', () => (seen.forks++, { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } } }) as never)
  on('ui.status', (_, e) => (seen.statuses.push(e.text), { value: undefined }) as never)
  return { seen, clock }
}

test('pings while warm and names the expiry', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 task(s), warm until')
  await clock.fire(50)
  expect(seen.forks).toBe(1)
  expect(seen.statuses.at(-1)).toMatch(/^keepalive: warm until \d+:\d\d$/)
})

test('a timer that fires after the TTL does not ping and says expired', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(80)
  expect(seen.forks).toBe(0)
  expect(seen.statuses.at(-1)).toBe('keepalive: expired, stopped')
})
