import { expect, test } from 'claude-code/testing'

// In-memory stand-ins for what Claude Code would answer
function stubs(on) {
  const store = new Map()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return store
}

test('/dash band toggles the band and remembers it', async ($, on) => {
  const store = stubs(on)
  const off = await $.command.run({ command: 'dash', args: 'band' })
  expect(off.text).toBe('Usage band off')
  expect(store.get('band')).toBe(false)
  const back = await $.command.run({ command: 'dash', args: 'band' })
  expect(back.text).toBe('Usage band on')
})

test('/dash opens the pane', async ($, on) => {
  stubs(on)
  const r = await $.command.run({ command: 'dash', args: '' })
  expect(r).toEqual({})
})

test('cache hit counts every model request', async ($, on) => {
  stubs(on)
  // Answer each model request in Claude Code's place with fixed usage
  on('turn.step', async function* () {
    return {
      turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, model: 'm' },
    }
  })
  // A streaming event: read it to the end, then take its result
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) step = await stream.next()
  const r = step.value
  // The mod's hook passes the response through unchanged
  expect(r.usage.cache_read_input_tokens).toBe(90)
})

test('toggling autocompact re-reads the compaction threshold, estimated locally', async ($, on) => {
  stubs(on)
  const asked = []
  on('session.usage', (_$, e) => {
    asked.push(e.breakdown)
    return { value: { context: { window: 200_000, tokens: 80_000, percent: 40 }, rateLimits: [] } }
  })
  on('config.set', (_$, e) => ({ value: e.value }))
  await $.config.set({ key: 'autoCompact', value: false })
  expect(asked).toEqual(['summary'])
})

test('the band\'s Compact button compacts the session', async ($, on) => {
  stubs(on)
  on('session.usage', () => ({ value: { context: { window: 200_000, tokens: 80_000, percent: 40 }, rateLimits: [] } }))
  const triggers = []
  on('session.compact', (_$, e) => (triggers.push(e.trigger), { skip: 'test' }))
  // Nothing else draws in the band, as with no other mods
  on('ui.render', ($, e) => ($.ui.resolve(e).Box({ children: [] })))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-dash', surface, component: 'AbovePrompt', props: {} })
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }
  expect(triggers.length).toBe(2)
})

test('Compact hides while a turn runs and comes back after', async ($, on) => {
  stubs(on)
  on('session.usage', () => ({ value: { context: { window: 200_000, tokens: 80_000, percent: 40 }, rateLimits: [] } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('turn.start', (_$, e) => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  const ui = await $.ui.mount({ plugin: 'usage-dash', surface: 'terminal', component: 'AbovePrompt', props: {} })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await $.turn.start({ prompt: 'hi' })
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  await $.turn.complete({ turnId: 't' })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('where compact has no direct call, the button runs the /compact command', async ($, on) => {
  stubs(on)
  on('session.usage', () => ({ value: { context: { window: 200_000, tokens: 80_000, percent: 40 }, rateLimits: [] } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('session.compact', () => { throw new Error('not available in a headless session') })
  const sent = []
  on('ui.toast', (_$, e) => (sent.push('toast: ' + e.text), {}))
  on('command.run', { command: 'compact' }, (_$, e) => (sent.push('/' + e.command), { text: '' }))
  const ui = await $.ui.mount({ plugin: 'usage-dash', surface: 'desktop', component: 'AbovePrompt', props: {} })
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(sent).toEqual(['/compact'])
})
