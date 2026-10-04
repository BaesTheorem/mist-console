# Phone layout handoff, 2026-10-04

Source: Claude Design project "MIST Console" (see design/claude-design.json),
folder `phone/`, file `Phone.dc.html`. Approved as drafted, with no edits.

- New Chat is a compose button at the top right of every chat and the first
  item in the drawer. The app icon's long-press menu gets a "New chat" item.
- Top bar: menu, full-width title with one status line (model, state), New
  Chat. Context use is a 2px line under the bar.
- No per-message action icons on phones. A long-press opens an action sheet.
- No crystal watermark behind the transcript on phones.
- Tapping the title opens a chat-details sheet with the badge strip contents.
- Drawer rows: title, state dot, time. Pin and archive on swipe. Footer holds
  saved, offline copy and settings.
- Composer: `+` (attach, saved), input, one button that is voice when the
  input is empty and send when it has text.
