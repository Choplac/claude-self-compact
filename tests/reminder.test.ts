import { expect, mock, test, type TestBody } from 'claude-code/testing'

// Each hook here stands for the engine beneath the plugin. The clock and the store are in memory.
type On = Parameters<TestBody>[1]
const HOUR = 3_600_000
const MIN = 60_000
type Usage = { tokens: number; percent: number }
const world = (on: On, usage: Usage, stored: Record<string, number> = {}, usageAfterMs = 0) => {
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
  return { seen, clock }
}
const typed = { text: 'next thing please', wait: false, origin: { kind: 'composer' } } as const
const LARGE = { tokens: 400_000, percent: 40 }

test('a large conversation gets one reminder beside the prompt, the next one only 45 minutes later', async ($, on) => {
  const { seen, clock } = world(on, LARGE)
  await $.prompt.submit(typed)
  await $.prompt.submit(typed)
  await clock.advance(44 * MIN)
  await $.prompt.submit(typed)
  await clock.advance(2 * MIN)
  await $.prompt.submit(typed)
  expect(seen.length).toBe(4)
  expect(seen[0]?.context?.length).toBe(1)
  expect(seen[0]?.context?.[0]).toMatch(/compact-at-stop reminder: .*40%/)
  expect(seen[0]?.text).toBe('next thing please')
  expect(seen[1]?.context).toBeUndefined()
  expect(seen[2]?.context).toBeUndefined()
  expect(seen[3]?.context?.length).toBe(1)
})

test('a small conversation is not reminded', async ($, on) => {
  const { seen } = world(on, { tokens: 90_000, percent: 9 })
  await $.prompt.submit(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a session that compacted itself in the last 30 minutes is not reminded', async ($, on) => {
  const { seen } = world(on, LARGE, { 'last:s1': 10 * HOUR - 10 * MIN })
  await $.prompt.submit(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a reminder stored before a reload still counts for its 45 minutes', async ($, on) => {
  const { seen, clock } = world(on, LARGE, { 'nudge:s2': 0, 'nudge:s1': 10 * HOUR - 10 * MIN })
  await $.prompt.submit(typed)
  await clock.advance(36 * MIN)
  await $.prompt.submit(typed)
  expect(seen[0]?.context).toBeUndefined()
  expect(seen[1]?.context?.length).toBe(1)
})

test('a background notification (a finished job, a Stop hook wake-up) is reminded too', async ($, on) => {
  const { seen } = world(on, LARGE)
  await $.prompt.submit({ ...typed, text: 'job done', origin: { kind: 'task-notification' } })
  expect(seen[0]?.context?.[0]).toMatch(/compact-at-stop reminder/)
})

test("a notice the engine queued for itself, and another session's message, are not reminded", async ($, on) => {
  const { seen } = world(on, LARGE)
  await $.prompt.submit({ ...typed, origin: { kind: 'task-notification' }, isMeta: true })
  await $.prompt.submit({ ...typed, origin: { kind: 'peer' } })
  expect(seen.length).toBe(2)
  expect(seen[0]?.context).toBeUndefined()
  expect(seen[1]?.context).toBeUndefined()
})

test('figures that stall do not hold the prompt: it goes on after half a second, unreminded', async ($, on) => {
  const { seen, clock } = world(on, LARGE, {}, HOUR)
  const sent = $.prompt.submit(typed)
  await clock.advance(400)
  expect(seen.length).toBe(0)
  await clock.advance(200)
  await sent
  expect(seen.length).toBe(1)
  expect(seen[0]?.text).toBe('next thing please')
  expect(seen[0]?.context).toBeUndefined()
})
