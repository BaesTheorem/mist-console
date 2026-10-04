# Conversation mode handoff, 2026-10-03

Source: Claude Design project "MIST Console" (see design/claude-design.json),
file `Conversation Mode.dc.html`, turn 1.

Decisions made in chat:
- Layout **1c**: a side column beside the chat. The composer stays, the full
  chat stays readable.
- The crystal in the column is the live animated crystal, the same clips and
  state machine the header crystal uses (idle, listening, thinking, speaking,
  error), not a still.
- Voice is hybrid: "Live" is the fast macOS system voice, "MIST" is her own
  XTTS voice (slower than real time, shows a "rendering" state).
- The state vocabulary for the column comes from the "Every state" section of
  the 1a strip: one-word state in its color, a caption, one live element.
