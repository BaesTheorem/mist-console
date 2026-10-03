import type { Register } from 'claude-code'

// console-pulse: a small mod that touches every surface the MIST Console
// draws, so it doubles as the live check of the remote-surface plumbing.
//   - status line: tools this turn and the turn's running time
//   - toast: when a turn ran longer than LONG_TURN_MS
//   - /pulse: a pane with per-tool counts, a reset button, a note field
//   - ui.log: one line when the module loads (visible in the transcript)
const LONG_TURN_MS = 90_000
const PANE = 'console-pulse'

type Counts = Record<string, number>
type Pulse = { turnStart: number; turnTools: number; counts: Counts; notes: string[] }

function showStatus($: any, p: Pulse) {
  if (!p.turnStart) { $.ui.status(undefined); return }
  const secs = Math.round((Date.now() - p.turnStart) / 1000)
  $.ui.status(`turn ${secs}s · ${p.turnTools} tool${p.turnTools === 1 ? '' : 's'}`)
}

export const register: Register = (on) => {
  const p: Pulse = { turnStart: 0, turnTools: 0, counts: {}, notes: [] }
  let tick: { cancel(): void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: 'Open the console-pulse pane (tool counts, notes)' })
    $.ui.log('console-pulse loaded')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    p.turnStart = Date.now()
    p.turnTools = 0
    showStatus($, p)
    tick?.cancel()
    tick = $.clock.every(1000, () => showStatus($, p))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const took = Date.now() - p.turnStart
    tick?.cancel()
    tick = undefined
    p.turnStart = 0
    showStatus($, p)
    if (took > LONG_TURN_MS) $.ui.toast(`that turn took ${Math.round(took / 1000)}s and ${p.turnTools} tool calls`)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    p.turnTools++
    p.counts[e.tool] = (p.counts[e.tool] ?? 0) + 1
    showStatus($, p)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'pulse' })
    return { text: 'console-pulse pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // The mobile app draws no text field yet; every other surface has Input.
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const rows = Object.entries(p.counts).sort((a, b) => b[1] - a[1])
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>tool calls this session</Text>
        {rows.length === 0
          ? <Text dimColor>none yet</Text>
          : <Box flexDirection="column">
              {rows.map(([tool, n]) => <Text>{`${String(n).padStart(4)}  ${tool}`}</Text>)}
            </Box>}
        <Box flexDirection="row" gap={2}>
          <Button key="reset" label="reset counts" hotkey="r" onPress={() => { p.counts = {}; $.ui.invalidate('ui.render') }} />
          <Button key="close" label="close" role="dismiss" onPress={() => { void $.ui.close({ id: PANE }) }} />
        </Box>
        {Input && <Input key="note" label="note" placeholder="type and press Enter" submitLabel="add"
               onSubmit={(v: string) => { if (v.trim()) { p.notes = [...p.notes, v.trim()]; $.ui.invalidate('ui.render') } }} />}
        {p.notes.length > 0 && <Markdown text={p.notes.map((n) => `- ${n}`).join('\n')} />}
      </Box>
    )
  })
}
