# compact-at-stop

A Claude Code mod that lets a session compact its own conversation at a stopping place.

The model calls the tool `mcp__compact-at-stop__compact` as the last call of its turn. Nothing happens
until that turn has ended; then the mod asks Claude Code to compact, the same call `/compact` makes.
Nothing is typed into a terminal, so it does not depend on a terminal program or a tab title.

## Install

In Claude Code:

```
/plugin install compact-at-stop --marketplace Choplac/claude-self-compact
```

From a shell: `claude plugin install compact-at-stop --marketplace Choplac/claude-self-compact`.
Desktop app: + → Plugins → Add marketplace → `Choplac/claude-self-compact`.

## Tool input

- `keep`: what the summary must keep (open questions, state, who waits on whom). Required.
- `resume`: optional prompt that starts the next turn after the compaction. Left out, the session goes idle.
- `cancel: true`: withdraws a request made earlier in the same turn.

## Reminder

A session told to compact "at a stopping place" tends to forget, since nothing tells it when one has come.
So when the person sends a prompt (terminal or phone), or a background notification arrives (a background
command or agent ended, such as a Codex run or a test run; or a Stop hook woke the session with mail or a
relayed chat reply), and the conversation fills at least 30% of its context window (and at
least 150,000 tokens), and the session has not compacted itself in the last 30 minutes, one note rides
beside that prompt. The model reads it; the person does not see it. It says to compact at the end of the
turn if that is a stopping place, and to carry on otherwise. At most one reminder per 45 minutes. A prompt is
never held up for it: the size and the times are read in the background (at session start, at the end of
each turn, after each prompt), and a prompt is judged from the last reading; no reading yet means no reminder.

## Guards

- Helper agents (subagents) and other plugins are refused: only the main session's own model can ask.
- At most one self-compaction per 30 minutes per session.
- A turn that was interrupted, refused or ended in an error drops the request.
- A request never carries over to a later turn or to another session (for example after `/resume`).
- If the session stays busy for about 10 seconds after the turn, the request is given up with a notice.

## Needs

A Claude Code build with hooks modules (plugin mods). Written against 2.1.323. That interface is early
access and may change.
