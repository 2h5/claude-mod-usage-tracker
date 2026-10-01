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
