import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'session.start'>>[0]

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'
// A first prompt line `model: <alias or id>` picks the subagent's model
const MARKER = /^[ \t]*model:[ \t]*(\S+)[ \t]*\r?\n?/

// undefined: not fetched or the fetch failed, so the description lists no ids
let models: string[] | undefined

// Returns why the list is unavailable, or undefined once it is fetched
async function fetchModels($: Engine) {
  const auth = await $.session.authorize()
  if (!auth) return 'no first-party credential (Bedrock, Vertex, a gateway or no login)'
  const r = await $.http.fetch(MODELS_URL, { auth: auth.handle, headers: { 'anthropic-version': '2023-06-01' } })
  if (!r.ok) return `GET /v1/models answered ${r.status}: ${r.text.slice(0, 200)}`
  models = (JSON.parse(r.text) as { data: { id: string }[] }).data.map(m => m.id)
}

async function refresh($: Engine) {
  models = undefined
  const failure = await fetchModels($).catch((err: Error) => `model list fetch failed: ${err.message}`)
  if (failure) {
    $.ui.log(`model-select: ${failure}. The Agent tool's description lists no model ids.`)
    return
  }
  await $.ui.invalidate('tool.describe')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('tool.describe', { tool: 'Agent' }, async (_, e, next) => {
    const r = await next(e)
    const list = models ? ` Available ids: ${models.join(', ')}.` : ''
    return {
      ...r,
      description: `${r.description}\n\nTo run a subagent on a specific model version, make the first line of \`prompt\` exactly \`model: <full model id>\` and leave \`model\` unset. The line also takes any alias /model takes, such as best or opus[1m]. The line is removed before the subagent sees the prompt. Forks ignore it.${list}`,
    }
  })

  on('agent.spawn', async (_, e, next) => {
    const m = MARKER.exec(e.prompt)
    if (!m || e.workflow) return next(e)
    const id = m[1]!
    if (e.fork) return { deny: `A fork always runs on the parent's model; spawn a named subagent_type to use ${id}.` }
    return next({ ...e, prompt: e.prompt.slice(m[0].length), model: id })
  }).catch((_, e, next) => (next.called ? next(e) : { deny: 'model-select failed to read the model line' }))
}
