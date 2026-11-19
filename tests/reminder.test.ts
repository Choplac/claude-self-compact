import { expect, mock, test, type TestBody } from 'claude-code/testing'

// Each hook here stands for the engine beneath the plugin. The clock and the store are in memory.
// The plugin judges a prompt from figures it read in the background after the prompt before it, so
// each test first sends one prompt that can carry no reminder (another session's) and lets it settle.
type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type Usage = { tokens: number; percent: number }
const HOUR = 3_600_000
const MIN = 60_000
const typed = { text: 'next thing please', wait: false, origin: { kind: 'composer' } } as const
const peer = { text: 'hello from another session', wait: false, origin: { kind: 'peer' } } as const
const LARGE = { tokens: 400_000, percent: 40 }

const world = async ($: Engine, on: On, usage: Usage, stored: Record<string, number> = {}, usageAfterMs = 0) => {
  const seen: { text: string; context?: readonly string[] }[] = []
  const clock = mock.clock(on, { now: 10 * HOUR })
  mock.store(on, stored)
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', async () => {
    if (usageAfterMs > 0) await clock.sleep(usageAfterMs)
    return { value: { startedAt: 0, context: { ...usage, window: 1_000_000 }, rateLimits: [] } }
  })
  on('prompt.submit', (_, e) => {
    seen.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  // One prompt, then let the reading behind it finish; `send` does the same for every later prompt.
  const send = async (prompt: Parameters<Engine['prompt']['submit']>[0]) => {
    await $.prompt.submit(prompt)
    await clock.settle()
  }
  await send(peer)
  seen.length = 0
  return { seen, clock, send }
}

test('a large conversation gets one reminder beside the prompt, the next one only 45 minutes later', async ($, on) => {
  const { seen, clock, send } = await world($, on, LARGE)
  await send(typed)
  await send(typed)
  await clock.advance(44 * MIN)
  await send(peer) // a reading at 44 minutes
  await send(typed)
  await clock.advance(2 * MIN)
  await send(peer) // a reading at 46 minutes
  await send(typed)
  const mine = seen.filter(s => s.text === typed.text)
  expect(mine.length).toBe(4)
  expect(mine[0]?.context?.length).toBe(1)
  expect(mine[0]?.context?.[0]).toMatch(/compact-at-stop reminder: .*40%/)
  expect(mine[1]?.context).toBeUndefined()
  expect(mine[2]?.context).toBeUndefined()
  expect(mine[3]?.context?.length).toBe(1)
})

test('a small conversation is not reminded', async ($, on) => {
  const { seen, send } = await world($, on, { tokens: 90_000, percent: 9 })
  await send(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a session that compacted itself in the last 30 minutes is not reminded', async ($, on) => {
  const { seen, send } = await world($, on, LARGE, { 'last:s1': 10 * HOUR - 10 * MIN })
  await send(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a reminder stored before a reload still counts for its 45 minutes', async ($, on) => {
  const { seen, clock, send } = await world($, on, LARGE, { 'nudge:s1': 10 * HOUR - 10 * MIN })
  await send(typed)
  await clock.advance(36 * MIN)
  await send(peer)
  await send(typed)
  const mine = seen.filter(s => s.text === typed.text)
  expect(mine[0]?.context).toBeUndefined()
  expect(mine[1]?.context?.length).toBe(1)
})

test('a background notification (a finished job, a Stop hook wake-up) is reminded too', async ($, on) => {
  const { seen, send } = await world($, on, LARGE)
  await send({ ...typed, text: 'job done', origin: { kind: 'task-notification' } })
  expect(seen[0]?.context?.[0]).toMatch(/compact-at-stop reminder/)
})

test("a notice the engine queued for itself, and another session's message, are not reminded", async ($, on) => {
  const { seen, send } = await world($, on, LARGE)
  await send({ ...typed, origin: { kind: 'task-notification' }, isMeta: true })
  await send(peer)
  expect(seen.length).toBe(2)
  expect(seen[0]?.context).toBeUndefined()
  expect(seen[1]?.context).toBeUndefined()
})

test('figures that never arrive hold no prompt up: it goes on at once, unreminded', async ($, on) => {
  const { seen } = await world($, on, LARGE, {}, HOUR)
  await $.prompt.submit(typed) // resolves with no clock movement: the hook waited for nothing
  expect(seen.length).toBe(1)
  expect(seen[0]?.text).toBe('next thing please')
  expect(seen[0]?.context).toBeUndefined()
})

test('a store that refuses to save the reminder time breaks nothing', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const clock = mock.clock(on, { now: 10 * HOUR })
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => {
    throw new Error('disk full')
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...LARGE, window: 1_000_000 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  await $.prompt.submit(peer)
  await clock.settle()
  await $.prompt.submit(typed)
  await clock.settle()
  await $.prompt.submit(typed)
  expect(seen[1]?.length).toBe(1)
  expect(seen[2]).toBeUndefined()
})

test('the prompt is handed on before the plugin calls the engine for anything', async ($, on) => {
  const order: string[] = []
  const clock = mock.clock(on, { now: 10 * HOUR })
  on('session.id', () => {
    order.push('session.id')
    return { value: 's1' }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => {
    order.push('store.set')
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...LARGE, window: 1_000_000 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => {
    order.push(e.context === undefined ? 'prompt' : 'prompt+reminder')
    return { text: e.text }
  })
  await $.prompt.submit(peer)
  await clock.settle()
  order.length = 0
  await $.prompt.submit(typed)
  await clock.settle()
  expect(order[0]).toBe('prompt+reminder')
  expect(order).toContain('store.set')
  expect(order).toContain('session.id')
})
