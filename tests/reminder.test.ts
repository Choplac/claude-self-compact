import { expect, test } from 'claude-code/testing'

// Each hook here stands for the engine beneath the plugin.
const world = (on: Parameters<Parameters<typeof test>[1]>[1], usage: { tokens: number; percent: number }, now: number, last?: number) => {
  const seen: { context?: readonly string[] }[] = []
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: now }))
  on('store.get', () => ({ value: last }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...usage, window: 1_000_000 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => {
    seen.push({ context: e.context })
    return { text: e.text }
  })
  return seen
}
const HOUR = 3_600_000
const typed = { text: 'next thing please', wait: false, origin: { kind: 'composer' } } as const

test('a large conversation gets one reminder beside the prompt, then none for a while', async ($, on) => {
  const seen = world(on, { tokens: 400_000, percent: 40 }, 10 * HOUR)
  await $.prompt.submit(typed)
  await $.prompt.submit(typed)
  expect(seen.length).toBe(2)
  expect(seen[0]?.context?.length).toBe(1)
  expect(seen[0]?.context?.[0]).toMatch(/compact-at-stop reminder: .*40%/)
  expect(seen[1]?.context).toBeUndefined()
})

test('a small conversation is not reminded', async ($, on) => {
  const seen = world(on, { tokens: 90_000, percent: 9 }, 10 * HOUR)
  await $.prompt.submit(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a session that compacted itself in the last 30 minutes is not reminded', async ($, on) => {
  const seen = world(on, { tokens: 400_000, percent: 40 }, 10 * HOUR, 10 * HOUR - 10 * 60_000)
  await $.prompt.submit(typed)
  expect(seen[0]?.context).toBeUndefined()
})

test('a background notification (a finished job, a Stop hook wake-up) is reminded too', async ($, on) => {
  const seen = world(on, { tokens: 400_000, percent: 40 }, 10 * HOUR)
  await $.prompt.submit({ ...typed, text: 'job done', origin: { kind: 'task-notification' } })
  expect(seen[0]?.context?.[0]).toMatch(/compact-at-stop reminder/)
})

test('a notice the engine queued for itself, and another session\'s message, are not reminded', async ($, on) => {
  const seen = world(on, { tokens: 400_000, percent: 40 }, 10 * HOUR)
  await $.prompt.submit({ ...typed, origin: { kind: 'task-notification' }, isMeta: true })
  await $.prompt.submit({ ...typed, origin: { kind: 'peer' } })
  expect(seen.length).toBe(2)
  expect(seen[0]?.context).toBeUndefined()
  expect(seen[1]?.context).toBeUndefined()
})
