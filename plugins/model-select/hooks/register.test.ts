import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const IDS = ['claude-opus-5-5', 'claude-mythos-5-1']
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as never

// Stands in for the engine: a credential, a /v1/models answer, and a spawn that echoes the model and prompt it got.
function engine(on: On, ids: string[] | null) {
  const seen = { prompts: [] as string[] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }) as never)
  on('http.fetch', () => ({
    value: ids
      ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: ids.map(id => ({ id })) }) }
      : { status: 401, ok: false, headers: {}, text: 'no' },
  }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('agent.spawn', (_, e) => (seen.prompts.push(e.prompt), { model: e.model ?? 'inherit', agentId: 'a1' }))
  return seen
}

const spawn = (prompt: string, fork = false) => ({
  tool_use_id: 't', prompt, description: 'd', subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork,
}) as never

test('a listed id, with or without [1m], becomes the model and the line is removed', async ($, on) => {
  const seen = engine(on, IDS)
  await $.session.start(START)
  const r = await $.agent.spawn(spawn('model: claude-mythos-5-1\nRead README.md'))
  expect(r.model).toBe('claude-mythos-5-1')
  expect(seen.prompts.at(-1)).toBe('Read README.md')
  expect((await $.agent.spawn(spawn('model: claude-opus-5-5[1m]\nx'))).model).toBe('claude-opus-5-5[1m]')
})

test('any name passes through, a fork is denied, no marker is untouched', async ($, on) => {
  engine(on, IDS)
  await $.session.start(START)
  expect((await $.agent.spawn(spawn('model: best\nx'))).model).toBe('best')
  expect((await $.agent.spawn(spawn('model: mythos\nx'))).model).toBe('mythos')
  expect((await $.agent.spawn(spawn('model: claude-opus-5-5\nx', true))).deny).toContain('fork')
  expect((await $.agent.spawn(spawn('just do it'))).model).toBe('inherit')
})

test('without a model list the line still works', async ($, on) => {
  engine(on, null)
  await $.session.start(START)
  expect((await $.agent.spawn(spawn('model: claude-anything\nx'))).model).toBe('claude-anything')
})
