import type { Register } from 'claude-code'

// A session asks for its own compaction at a stopping place; it runs once the turn has ended,
// through the engine's own compaction call (what /compact does). Nothing is typed into a terminal.

const NAME = 'compact'
const FULL = /^mcp__compact-at-stop__compact$/ // a pattern: the tool is this plugin's own, so no type lists its name
const MIN_GAP_MS = 30 * 60_000 // between two self-compactions of one session
const MAX_TEXT = 4000
const TRIES = 10 // the engine refuses a compaction while a turn still runs
const TRY_EVERY_MS = 1000

// The reminder. A session asked to compact "at a stopping place" forgets to: nothing tells it when one
// has come. So when the person sends a prompt, or something the session waited for reports back, and the
// conversation is large and has gone a while without compacting itself, one note rides beside that
// prompt. The model reads it; the person never sees it.
// Prompts that carry it: the person's own (terminal, phone bridge) and a background notification: a
// background command or agent that ended (a Codex run, a test run, a timer) and what a Stop hook
// delivers to wake the session (mail from another session, the person's reply relayed from Discord).
// Measured 2026-11-19 on Claude Code 2.1.328: all of those arrive as `task-notification`, and a note
// attached there reaches the model.
const NUDGE_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'task-notification'])
const NUDGE_PERCENT = 30 // share of the context window in use, and
const NUDGE_TOKENS = 150_000 // tokens in use: both must be reached (a small window is not nagged early)
const NUDGE_GAP_MS = 45 * 60_000 // between two reminders of one session

type Job = { keep: string; resume?: string; turnId: string; sessionId: string }

// Module variables start over on a hot reload; that only ever drops a request, never invents one.
// The time of the last compaction is kept in $.store, per session, so the 30-minute gap survives
// a reload and a restart.
let activeTurn: string | undefined // the main loop's running turn
let pending: Job | undefined // asked for in `activeTurn`, not yet at its end
let scheduled: object | undefined // token of the one compaction waiting to run; a new turn drops it

// In-memory copy of the last compaction time per session id: set the moment a compaction succeeds,
// so the gap holds in this process even when $.store fails. $.store carries it over a reload or restart.
const lastMem = new Map<string, number>()
let writes: Promise<unknown> = Promise.resolve() // stored-time writes, in order
const lastNudge = new Map<string, number>() // time of the last reminder per session id; starts over on a reload

const nudge = (percent: number): string =>
  `compact-at-stop reminder: this conversation fills about ${percent}% of its context window and has not ` +
  'compacted itself for a while. When the work of this turn ends at a stopping place (its result is reported ' +
  'or handed off, and nothing of yours is still running), write the handoff where a later session finds it ' +
  'and call the compact tool as the last call of the turn. If this turn does not end at a stopping place, ' +
  'carry on and leave this reminder unmentioned.'

const clean = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, MAX_TEXT) : undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: NAME,
      isDeferred: false,
      description:
        'Compacts THIS conversation once your turn has ended (the same as the person typing /compact). ' +
        'Call it only at a stopping place: work landed or handed off, nothing of yours running, ' +
        'handoff written to memory. Make it the last call of your turn, then end the turn. ' +
        '`keep`: what the summary must keep (open asks, state, who waits on whom). ' +
        '`resume`: optional prompt that starts your next turn after the compaction; leave it out to go idle. ' +
        '`cancel: true` withdraws a request made earlier in this turn.',
      inputSchema: {
        type: 'object',
        properties: {
          keep: { type: 'string' },
          resume: { type: 'string' },
          cancel: { type: 'boolean' },
        },
      },
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Not a slash command, not a notice the engine queued for itself (isMeta), not another plugin's
    // or another session's prompt.
    if (!NUDGE_ORIGINS.has(e.origin.kind) || e.command !== undefined || e.isMeta === true) return next(e)
    let note: string | undefined
    try {
      const sessionId = await $.session.id()
      const now = await $.clock.now()
      const { context } = await $.session.usage()
      const percent = context.percent ?? 0
      const last = Math.max(Number((await $.store.get(`last:${sessionId}`)) ?? 0), lastMem.get(sessionId) ?? 0)
      const isLarge = percent >= NUDGE_PERCENT && (context.tokens ?? 0) >= NUDGE_TOKENS
      if (isLarge && last + MIN_GAP_MS <= now && (lastNudge.get(sessionId) ?? 0) + NUDGE_GAP_MS <= now) {
        lastNudge.set(sessionId, now)
        note = nudge(percent)
      }
    } catch {
      // Figures that cannot be read mean no reminder; the prompt goes on as typed.
    }
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  on('session.end', ($, e, next) => {
    // The process may go on under another session (/resume, /clear): nothing asked here follows it.
    activeTurn = undefined
    pending = undefined
    scheduled = undefined
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      // A new main turn: whatever was asked for or waiting belongs to an earlier turn.
      activeTurn = e.turnId
      pending = undefined
      if (scheduled !== undefined) {
        scheduled = undefined
        $.ui.toast('compact-at-stop: a new turn started first; compaction request dropped')
      }
    }
    return next(e)
  })

  on('tool.call', { tool: FULL }, async ($, e, next) => {
    const input = e as unknown as { agentId?: string; keep?: unknown; resume?: unknown; cancel?: unknown }
    if (next.origin.plugin !== 'engine') {
      return { deny: 'Only the session itself may ask for its compaction, not another plugin.' }
    }
    if (input.agentId !== undefined) {
      return { deny: 'Only the main session may ask for its compaction, not a helper agent.' }
    }
    const turn = activeTurn // the turn this call belongs to, read before anything is awaited
    if (turn === undefined) {
      return { deny: 'No running turn is known (the plugin was just reloaded); ask again in your next turn.' }
    }
    if (input.cancel === true) {
      const had = pending !== undefined
      pending = undefined
      return { result: had ? 'Compaction request withdrawn.' : 'No compaction request was open.' }
    }
    const keep = clean(input.keep)
    if (keep === undefined) return { deny: '`keep` is required: say what the summary must keep.' }
    const sessionId = await $.session.id()
    const last = Math.max(Number((await $.store.get(`last:${sessionId}`)) ?? 0), lastMem.get(sessionId) ?? 0)
    const wait = last + MIN_GAP_MS - (await $.clock.now())
    if (wait > 0) {
      return {
        deny: `This session compacted itself less than 30 minutes ago; try again in ${Math.ceil(wait / 60_000)} min.`,
      }
    }
    if (activeTurn !== turn || next.signal.aborted) {
      return { deny: 'The turn that asked has ended; nothing was recorded.' }
    }
    pending = { keep, resume: clean(input.resume), turnId: turn, sessionId }
    return { result: 'Recorded. The compaction runs when this turn ends. End your turn now; call nothing else.' }
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId !== undefined) return answer
    if (activeTurn === e.turnId) activeTurn = undefined
    if (pending === undefined) return answer
    const job = pending
    pending = undefined
    if (job.turnId !== e.turnId) return answer
    if (e.reason !== 'answer') {
      $.ui.toast('compact-at-stop: the turn did not end normally; compaction request dropped')
      return answer
    }
    const token = {}
    scheduled = token
    const key = `last:${job.sessionId}`
    let left = TRIES
    const attempt = (): void => {
      void (async () => {
        if (scheduled !== token) return
        let res
        let now = 0
        try {
          if ((await $.session.id()) !== job.sessionId) {
            if (scheduled === token) scheduled = undefined
            return
          }
          // The gap is judged again here, when the compaction runs, not only when it was asked for.
          now = await $.clock.now()
          const last = Math.max(Number((await $.store.get(key)) ?? 0), lastMem.get(job.sessionId) ?? 0)
          if (last + MIN_GAP_MS > now) {
            if (scheduled === token) scheduled = undefined
            return
          }
          if (scheduled !== token) return
          res = await $.session.compact({ instructions: job.keep })
        } catch {
          // The engine refuses while it is still busy with the turn that just ended.
          if (scheduled !== token) return
          left -= 1
          if (left > 0) $.clock.after(TRY_EVERY_MS, attempt)
          else {
            scheduled = undefined
            $.ui.toast('compact-at-stop: could not compact (the session stayed busy); ask again later')
          }
          return
        }
        // From here the request is used up, whatever fails below.
        if (scheduled === token) scheduled = undefined
        if ('skip' in res && res.skip !== undefined) {
          $.ui.toast(`compact-at-stop: compaction skipped: ${res.skip}`)
          return
        }
        // The time counts from the start of the attempt that compacted. The in-memory copy is set
        // at once and cannot fail; the stored copy follows, one write at a time, always the newest.
        lastMem.set(job.sessionId, Math.max(lastMem.get(job.sessionId) ?? 0, now))
        writes = writes
          .then(() => $.store.set(key, lastMem.get(job.sessionId) ?? now))
          .catch(() => $.ui.toast('compact-at-stop: compacted, but the time could not be saved'))
        if (job.resume === undefined) return
        await writes // the stored time is in place before the resume prompt can start a turn
        try {
          if ((await $.session.id()) !== job.sessionId) return
        } catch {
          return
        }
        void $.prompt.submit({ text: job.resume })
      })()
    }
    $.clock.after(300, attempt)
    return answer
  })
}
