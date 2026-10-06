# MIST Console

A terminal-style desktop app for talking to Claude, built **from the ground up** so we own the entire UI. Instead of skinning the closed-source `claude` TUI, the Console runs the official `claude` binary **headlessly** and renders every pixel of the interface ourselves.

## Why this architecture

`claude`'s interactive TUI is a compiled binary we can't restyle. But the CLI exposes a full bidirectional streaming protocol:

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
```

So we run Claude as a long-lived subprocess that emits structured JSON events (init/capabilities, token-level text + thinking deltas, tool calls, tool results, usage, rate limits) and we render them however we want. The **brain stays Anthropic's** (we never reimplement it), so capability and correctness come for free, and we get total control of the surface.

This hits the design criteria:
- **Fewest catastrophic errors**: leans on the official engine; one runtime; pure Python + web.
- **All the CLI capabilities**: tools, MCP servers, skills, slash commands, `/resume`, persona, all flow through the subprocess.
- **Easy to bolt features on**: Flask + plain web UI.
- **Low RAM**: one Python process + the system WebView (WKWebView). No Chromium, no Node. ~60–100MB vs Electron's 250MB+.

## Architecture

```
┌────────────────────┐     POST /send      ┌──────────┐   stdin (stream-json)   ┌────────────┐
│  WKWebView UI       │ ──────────────────▶ │  Flask   │ ─────────────────────▶ │  claude    │
│  (static/, app.js)  │ ◀── SSE /stream ─── │  app.py  │ ◀── stdout (events) ─── │  (headless)│
└────────────────────┘                      │ bridge.py│                         └────────────┘
                                            └──────────┘
```

- `bridge.py`, holding `ClaudeSession`: spawns and owns one headless `claude` process (cwd = Exobrain harness, MIST persona appended via `--append-system-prompt-file`), parses its stdout JSON, fans events out to subscribers. Owns the subprocess lifecycle and fails loudly.
- `app.py`: Flask. `POST /send` writes a user turn to claude's stdin; `GET /stream` is Server-Sent Events of the live event stream; `POST /new` restarts the session.
- `static/`: the UI we fully control: `index.html`, `style.css` (flat/sharp MIST Cloud theme), `app.js` (renders streaming text, collapsible thinking, tool cards + results, capabilities panel, usage).
- `desktop.py`: native macOS window via pywebview/WKWebView. `uv run --script desktop.py`.
- `make-app.sh`: builds `~/Desktop/Apps/MIST Console.app`.

## Run

```sh
# native window
uv run --script desktop.py
# or browser dev mode
uv run --with flask python app.py   # http://127.0.0.1:5014
```

Port: **5014**.

**Watchdog.** `launchd/com.exobrain.mist-console-watch.plist` runs `bin/console-watch` every minute and at login: if nothing answers on :5014 it runs `open -a "MIST Console"`, so a crash or a reboot never leaves the phone without a Mac to reach. A deliberate quit (red button or Cmd+Q) sticks: `desktop.py` drops `/tmp/mist-console-quit.last` from pywebview's `closing` event, the watcher stays out while that file exists, and every launch of the app removes it. A marker older than the last boot is treated as stale, so login recovery is unaffected.

## Install on Windows (no build needed)

A self-contained Windows build lives at [`releases/MIST Console.exe`](releases/)
(~35 MB, produced by [the Windows workflow](.github/workflows/windows-exe.yml)).
Download it and run it: a first-run wizard installs Claude Code, signs you in
with your Claude subscription, and sets up a workspace; when it finishes, MIST
introduces herself out loud and demos the Ctrl+Alt+Space quick-entry overlay.
Windows SmartScreen warns on unsigned exes: choose "More info", then
"Run anyway". Port details and gotchas in [`windows/README.md`](windows/README.md).

## Auth: subscription, not API

The Console spawns the official `claude` binary, which authenticates with the **Claude subscription via OAuth** (`apiKeySource: none`, no `ANTHROPIC_API_KEY`, API overage disabled). No Anthropic API key, no per-token API billing. The usage numbers below are the subscription's own rate-limit windows, the same data the statusline shows, so displaying them costs nothing.

## Tabs (multi-session) + persistence

The left rail is a stacked list of independent conversations, each backed by its own headless `claude` process. `+ new chat` spawns one; `×` closes it (deletes its data); the `◆/◇` toggle pins it; clicking switches. Typing **`/new`** in the composer (and Enter) does the same as `+ new chat` from the keyboard; `/new <text>` opens a fresh chat and seeds it with that first message. It's a Console-local command, intercepted in `sendActive()` and never forwarded to Claude (distinct from the harness `slash_commands`, which do reach claude).

- **Sorted newest-first**, pinned conversations on top (with a divider).
- **Archive.** The hover `archive` icon on a row (or `/archive` in the composer) hides a finished chat in a collapsed **archived** section at the very bottom of the rail, below the paging fold, so it never reaches the fold's page limit. The chat keeps its transcript, search hits and resume link; `unarchive` (or `/archive` again from inside it) puts it back in its date bucket. Archiving unpins, pinning unarchives, and the section starts collapsed on every launch. Archiving the chat on screen moves you to the top of the rail. Backend: `POST /sessions/<id>/archive` (no body toggles, `{"archived": bool}` sets), persisted as `archived` + `archived_at` in `sessions.json`. The server-side condense tier below used to save its flag under the same `archived` key; rows written before the split migrate to `condensed` on load.
- **Persistent.** Every event is recorded to `data/<id>.jsonl`; metadata (title, pinned, last_activity, claude session id) to `data/sessions.json`. On connect, `/stream/<id>` replays the full transcript, so reload / tab-switch / app-restart all show history. The in-memory replay window is the newest `bridge.HISTORY_CAP` (8000) raw events; everything older is condensed on load (`bridge.fold_history`, same shape as the archive tier below) rather than dropped, so a long chat still replays from its first message. Before this, a chat over the cap opened part-way through and could not scroll to its start (the FRI work trial chat: 38,893 events for 9 turns; 138 chats in `data/` were over the cap).
- **Dormant revival.** On restart, conversations load as dormant (transcript visible, *no* process). The claude process spawns lazily on the first send, with `--resume <claude_session_id>` so the model's context is restored too (verified: a revived chat still remembers earlier turns). A watchdog retries fresh if a resumed session fails to start.
- The user bubble is rendered from a broadcast `user_text` event (not optimistically), so live and replayed transcripts are identical.

Backend: `/sessions` GET/POST, `/sessions/<id>` DELETE, `/sessions/<id>/pin` POST, `/sessions/<id>/archive` POST, `/stream/<id>`, `/send/<id>`. `data/` is gitignored (personal conversation history).

## Usage metrics (top bar)

- **ctx %**: context window used for the *active* tab, computed live in `bridge.py` from the latest assistant message's usage (`input + cache_read + cache_creation`) ÷ the model's `contextWindow`, broadcast as a `context` event. Uses the per-message usage (a single API call = current context occupancy), not the `result` event's turn-cumulative total, which sums every internal tool-call round trip and reads past 100%. Subagent (sidechain) messages, those with a `parent_tool_use_id`, are skipped: they carry the subagent's context, not the session's.
- **ctx %** is clickable: the card shows the CLI's own context breakdown (`get_context_usage` over the control channel: system prompt, tools, MCP tools, memory, skills, messages) with a **compact now** button.
- **5h %** and **7d %**: the **%** comes live from `GET api.anthropic.com/api/oauth/usage` — a free, read-only account endpoint (authenticated with Claude Code's own subscription OAuth token from Keychain) that reports per-window utilization and reset times without sending a message, consuming tokens, or opening a rate-limit window (verified: consecutive reads return identical numbers). `bridge.start_rate_poller` reads it every 60s while any Console window is open (600s idle), plus immediately after each turn's `rate_limit_event`, so the badge is at most ~1 minute behind even when the usage is being spent elsewhere (interactive CLI, phone, a background routine). The **blocked status** still arrives live from `rate_limit_event`s in the stream; the old statusline cache (`~/.claude/usage-cache.json`) remains as a last-resort fallback. The badge tooltip says which source the % came from and how old it is. (This replaces the old probe, which paid a real 1-token haiku call and could only fire right after a turn.) The endpoint rate-limits its readers, so the poll interval is adaptive: a 429 doubles it and a success walks it back down, never below a step above the spacing that last 429'd (a fixed 60s poll failed every other call).

## Composer & boot

- **Full text editing**: a native macOS Edit menu (built in `desktop.py` via pyobjc) wires Cmd+X/C/V/A/Z and the right-click menu to the web view. Click-drag selection works natively. (WKWebView has no clipboard shortcuts without this menu.)
- **File picker**: the `file` button opens the native open dialog (`window.pywebview.api.pick_file`) and inserts the chosen absolute path(s) into the input, so MIST can `Read` them. Browser dev mode falls back to a hidden file input (filenames only).
- **Spoken boot greeting**: on launch MIST speaks one of several in-character greetings (`GREETINGS` in `app.py`) in her cloned voice, and shows it in the log. The greetings are **pre-rendered** to `greetings/greet_N.wav` so playback is instant (no ~28s TTS cold start). To change them: edit `GREETINGS`, start the voice service, and re-render the WAVs (index-aligned).

## Permissions (interactive cards)

New chats default to **bypassPermissions** (`--dangerously-skip-permissions`), so MIST runs unprompted. The autonomous routines and quick-entry flows depend on that, and it stays byte-for-byte the old behavior.

Switch a chat to **default / acceptEdits / plan** via the perm badge and the Console now renders real **Allow / Allow-for-session / Deny** cards, just like the TUI. Mechanism (all confirmed against the live `claude` binary):

- In a non-bypass mode the session spawns with `--permission-prompt-tool stdio` and sends an `initialize` control_request at start. That makes the CLI route every "ask" decision back over the control protocol as a `can_use_tool` control_request.
- `bridge.py` catches it (`_handle_control_request`), re-broadcasts it as a `permission_request` event, and the UI renders a card showing **what** the tool will do: a red/green **diff** for Edit/Write/MultiEdit, the **plan** for ExitPlanMode, the **command** for Bash, a **checklist** for TodoWrite.
- The answer is relayed via `POST /sessions/<id>/permission-response` → `respond_permission()` → a `control_response` (`{behavior:"allow", updatedInput}` or `{behavior:"deny"}`). "Allow, don't ask again" returns the CLI's own `permission_suggestions` as `updatedPermissions` (e.g. auto-accept edits for the session).
- **Clarifying questions work in these modes too.** `AskUserQuestion` arrives over the same channel (a `can_use_tool` with `requires_user_interaction`), and the bridge re-broadcasts it as a `question_request`. The UI renders a form card: option buttons (radio or checkbox per `multiSelect`) with an "Other" box, a textarea for `kind:"text"`, a number field for `kind:"number"`. "Send answers" POSTs `{answers: {question text: label or typed text}}` to the same `permission-response` route and it goes back as `updatedInput.answers` (multi-select joined with `", "`); "Dismiss" denies without interrupting the turn. The banner offers the options as buttons when there is one plain choice question with two or three options, and otherwise just raises the Console. Confirmed end to end against claude 2.1.261.
- **bypassPermissions still spawns with `--disallowed-tools AskUserQuestion`.** There is no prompt tool in that mode and no TTY, so the picker would auto-dismiss with no answer; disabling it makes the model ask in plain text instead.

### Live switching

The **model** badge switches a running chat over the control channel (`set_model`, what the TUI's `/model` sends): no restart, no cold MCP boot, prompt cache kept. **Permission mode** switches live between default / acceptEdits / plan (`set_permission_mode`); any switch into or out of bypass still restarts the backend on the next message, because a process started with `--dangerously-skip-permissions` has no prompt tool wired up and the CLI refuses to enter bypass on one that wasn't. **Thinking depth** (`--effort`) has no control request, so it still applies on the next message. The notice under the badge says which happened.

### MCP panel

Settings → **mcp servers** lists the active chat's servers with their live state (`mcp_status`) and the actions the TUI's `/mcp` screen has: **reconnect**, **disable/enable** for this chat (`mcp_toggle`), and **auth** for an OAuth connector (`mcp_authenticate`). A dormant chat shows its last-known set; an action wakes it (a resume, no tokens). **MCP elicitation** (a server asking the user for input) renders as a schema-driven form card instead of being auto-declined.

### Compaction

The CLI's auto-compact does run headlessly, and `/compact` typed as input works over stream-json, so the context-cost notices (60% warn, 80% soft gate) now offer **compact now** next to **new chat**. The boundary renders as a divider with the before/after token counts, and the ctx badge is restated from the boundary's `post_tokens`.

### Message actions (edit / regenerate / branch)

Hover a message (or right-click it) for **edit & resend**, **regenerate**, **branch from here** and **copy**. Edit and regenerate rewind THIS chat in place: the transcript is truncated at that user message and the next spawn resumes the CLI session truncated at the same point (`--resume-session-at <uuid of the last assistant entry before it> --fork-session`, confirmed against claude 2.1.278). The tail is gone for good, so the message shows a confirm strip first. Branch creates a new chat holding the conversation up to that point (through a MIST reply, or up to a user message with its text pre-filled in the composer) and leaves the original untouched; a branch at the end is a plain `--fork-session`. Limits, all reported inline: the CLI only addresses entries after the last compaction (a compaction summary is a valid anchor, so "regenerate the first reply after compacting" works), and the CLI's session file must still hold the anchor.

### Bookmarks

Hover a message (or right-click it) and hit the **bookmark** icon; the message gets a small marker in its header and lands in the **bookmarks** panel (the bookmark button in the composer, count badge included). The panel has two scopes: **this chat**, in transcript order, and **all chats**, newest first and grouped by chat. Clicking a bookmark jumps to the message, switching chats first if it lives elsewhere and waiting for that chat's replay to finish, then flashes it; the × on a row removes it.

A message is addressed by `<role>:<seq>`: a user message's own `user_text` seq, or the seq of the first top-level `assistant` event rendered into a MIST bubble. That is the one address that survives everything a chat goes through (`bookmarks.py` explains why: the condenser keeps `user_text` verbatim and gives each `mist_msg` the seq of the assistant event it came from). A rewind prunes the bookmarks on the discarded tail; deleting a chat drops its bookmarks. Store: `data/bookmarks.json`. Routes: `GET /bookmarks`, `GET|POST /sessions/<id>/bookmarks`, `DELETE /sessions/<id>/bookmarks/<role>/<seq>`.

### Task checkboxes

Markdown task lines (`- [ ] item`, `- [x] done`) render as real checkboxes, and a tick is saved per message (`data/checks.json`, `GET|POST /sessions/<id>/checks`, keyed by the same address and the box's position among that message's checkboxes). Boxes the user never touched keep whatever the markdown said. `bridge.CHECKLIST_PROMPT` tells MIST when a list should be one: things for Alex to do (recommended edits, a to-do list, manual steps, items to review), never her own work, never pre-ticked. A message with no address yet (a reply still streaming) can't save a tick; the box reverts with a notice.

### Interrupt

Press **Esc** (or click the send button, which becomes **stop** while a turn runs and the composer is empty) to cancel an in-flight turn. This sends an `interrupt` control_request. The process is **not** killed, so context is preserved and the next message just continues (unlike the old kill/restart).

**Pause** (the ⏸ button left of send while a turn runs, **Shift+Esc**, or `/pause`) is the graceful cousin of stop. Nothing is interrupted: the bridge sends a mid-turn user message (`bridge.PAUSE_PROMPT`) asking MIST to finish the tool call in flight, write a short checkpoint (done / in progress / next step) and end the turn, so it lands at the model's next step rather than instantly. The echo shows as a small control chip (a `user_text` event with `kind: "pause"`), the status reads *pausing…*, and when the result arrives the bridge broadcasts `paused`: the status turns amber, the same button becomes **▶ resume** (`/resume` too), which sends `RESUME_PROMPT`. Any other message also clears the pause. If a minute passes without the turn ending, a notice points at stop, which is still one Esc away. Routes: `POST /sessions/<id>/pause` (`state`: `ok` / `idle`), `POST /sessions/<id>/resume`.

### Background tasks (the "running in background" panel)

The CLI reports subagents and backgrounded shells as `system` events (`task_started`, `task_progress`, `task_notification`). The panel lists them and the rail dot goes amber while any run. A task's **✕** sends a `stop_task` control request; the bridge turns the ack into a synthesized `task_updated(status=killed)`, so the row resolves even when the CLI never emits its own terminal event.

The bridge also keeps a ledger of every open task id per backend (`_open_tasks`). When the process exits, for any reason (crash, idle reap, model or mode switch, window close), it broadcasts the same synthesized `killed` event for each one still open, and records it, so a replay agrees. Without this, three agents killed by a session restart sat in the panel as "running" for an hour: no process was alive, but nothing had ever said so. The frontend does the same prune on `process_exit` as a fallback, and `replay_done` still drops any task with no terminal event in the log. `tests/test_bg_task_ledger.py` covers the ledger.

## Look: theme, font, text size

Settings carries three appearance controls, all persisted **twice** — localStorage
so they apply before first paint, and server-side (`data/*.json`) so a wiped
WebView store still opens the way you left it.

- **Text size** scales the whole window via `zoom` on the root, 70–200% in steps
  of 5. `⌘+` / `⌘−` / `⌘0` work too; a WebView has no browser chrome, so nothing
  binds those unless we do. Scaling only the message text would leave tiny chrome
  around big text, which is worse than either.
- **Font**: system faces plus ten vendored OFL families (see
  [`static/fonts/README.md`](static/fonts/README.md)). Each row previews itself.
- **Terminal wallpaper** is MIST's mark on black. The asset is `mist-wall.png`,
  the logo with its blown-out white core compressed back into its own blue: the
  core is what capped brightness, since at high opacity it drowned the dim
  timestamp text long before body text suffered. With no hotspot the mark runs 4×
  brighter (`--wp-opacity: .40`) and still measures 12:1 for body text and 4.9:1
  for the dimmest chrome text. To brighten further, regenerate the asset with a
  lower cap rather than raising the opacity.

## Recipe cards + cooking mode

A ```` ```recipe ```` fence (JSON — schema in `bridge.RECIPE_PROMPT`, which teaches
the model to emit one whenever it gives a real recipe) renders as an interactive
card: title/serves/times, a tap-to-check ingredient list (grouped or flat), and
numbered steps with **inline clickable timers** — claude.ai style — wherever a
step declares `"timer": seconds` or its text mentions a duration ("simmer 10
minutes"; ranges start at the lower bound). Click a chip to start; click again to
pause; ✕ resets; done turns red, pulses, and plays a short WebAudio chime (user-
started, so it's asked-for sound; the context is unlocked on the starting click,
which WebKit requires).

**cooking mode** opens a full-screen step-at-a-time view: arm's-length type, the
step's timer front and center, an ingredients drawer, ←/→/space to step, Esc to
exit (captured before the composer's interrupt Esc), and a best-effort screen
wake lock. Timer and checklist state live in registries keyed by recipe slug +
index — not in the DOM — so they survive the transcript's per-delta re-renders
and are shared between the card and the overlay (a timer started in one is
already ticking in the other). A parse failure falls back to a plain code block;
a still-streaming recipe shows a "plating…" stub instead of raw JSON.

## Progress bars (in-place, not a scroll of ticks)

A download, upload, or install renders as **one element that updates in place**: a
label, a filling bar, and a line of "1.2 GB / 2.9 GB · 12.4 MB/s · ~3m left · 1m12s
elapsed". A long silent wait is indistinguishable from a hang, and that was the
thing to fix.

- **Driving it**: `bin/mist-progress`, on PATH inside every session.
  `mist-progress run --label "Downloading model" -- curl -L -O <url>` runs the
  command, passes its output through byte-for-byte, and parses the command's own
  meter (curl, wget, pip, git, rsync, anything printing a percentage or a byte
  pair) into the bar. It gives the command a **pty** by default, since most tools
  only print a meter when they think a human is watching. `start` / `set` / `done`
  drive a bar you compute yourself; `pipe` reads a stream you already have.
- **Wiring**: `POST /progress/<sid>` with `{id, label, pct, current, total, unit,
  detail, rate, eta, status}`. `id` is the caller's key — post the same id again
  and the SAME element moves. Every session's shell gets `$MIST_CONSOLE_SESSION`
  and `$MIST_CONSOLE_URL`, so a script started from a chat reports back into that
  chat with nothing to configure. Outside the Console the CLI stays silent and
  still runs the command, so wrapping something in it never breaks it.
- **No percentage, still no dead end**: a bar with nothing but a label renders
  indeterminate, with an elapsed clock and whatever detail line it's given.
- **Cost**: ticks are broadcast live but only a bar's first and last frames are
  persisted (`bridge.PROGRESS_MIN_INTERVAL` coalesces the rest), so a 10-minute
  install doesn't bury the replayed transcript in thousands of dead updates. A bar
  whose process died mid-run replays as **interrupted** rather than as one that
  still looks live.
- **The dock**: scroll away from a running bar and it re-appears as a one-line
  echo at the bottom-left of the conversation; click it to jump back. It hides
  whenever the real bar is on screen.
- Reduce Motion is respected: the indeterminate sweep becomes a static hatched
  fill and jump-to-bar scrolling is instant.

## Notifications (settings section + inline reply)

The Console is the receiving end of the full-featured notification pipeline
(`mist-notifier/` in the harness repo builds `/Applications/MIST Notifier.app`,
which posts native banners for `mist-notify`):

- **A tap lands in a chat, always.** A banner sent from inside a chat links
  `console:<sid>` and `/focus?sid=` stashes that chat for the window to claim.
  A banner from a headless sender (a launchd watcher, a scheduled routine)
  links `console:notif.<nid>`: `/focus` then opens a NEW chat (or reuses the
  one a previous tap opened) whose first message is the whole notification,
  the sender's `context`, and "Alex wants to chat about this" (`notifchat.py`
  builds it from the history line; `_open_notification_chat` in app.py owns
  the session). Nothing is created until the tap, so an ignored banner costs
  nothing. The source link the sender passed rides along as an "Open link"
  button and in the seed.
- **`POST /notify-reply`** `{sid?, text}`: inline reply typed into a macOS
  banner. Lands in the target chat like a composer send (sid → active chat →
  newest chat). A `notif.<nid>` sid opens the notification's chat with the
  reply as the seed's last line. No context gate: there's no composer to
  restore held text into.
- **`POST /notifications/chat`** `{nid}`: the bell panel's version of the tap
  on a `console:notif.<nid>` entry; answers `{sid}` and the page switches there.
- **`GET /notifications`**: tail of `~/Library/Logs/exobrain/notifications-history.jsonl`
  (mist-notify appends every banner it sends, whichever route delivered it).
- **`POST /notifications/open`** `{link}`: re-fires a click target from the
  bell panel (URLs/paths/`cmd:`; `console:*` targets are handled client-side by
  switching chats).
- **The feed** lives as the top section of the settings panel (the dedicated
  top-bar bell was crowding the actions row), newest first; unread state tints
  the settings gear instead (`notifSeen` timestamp in localStorage).

Why the Console doesn't post banners itself: usernoted validates a UN-API
caller's main executable against its bundle record, and the Console's
script→python launch chain can never pass (UNErrorDomain Code=1). Details and
the other macOS 26 landmines live in the harness `mist-notifier/README.md`.

## Inline media (versioned embeds)

A reply embeds a local file as `![alt](/abs/path.png)`; the page loads it through
`GET /file?path=...` (allowlisted roots and extension rules in `embeds.py`).
Two kinds of root: full roots (Downloads, the vault's Attachments, the harness)
serve any non-hidden, non-credential file, and media-only roots (`~/Documents`,
the vault, Desktop, Pictures, Movies) serve only what a bubble or the
artifacts drawer can show: images, audio, video, 3D models, PDF, HTML, SVG. So
a render saved in any project folder embeds as is, and a private document
there stays unreachable. The phone loads the same route, so it gets the same
rule.
Because that lookup happens when the bubble renders, a file overwritten in a
later turn (the same image edited five times, always saved to one name) used to
rewrite every earlier bubble and lightbox on reload, and the phone always loads
fresh. So `bridge._record` snapshots every media file an assistant message
embeds into `data/embeds/<sha1[:12]>-<name>` (content-addressed, so an
unchanged file is stored once) and appends `{path, ts, snap}` to
`data/embeds/index.jsonl`. Each text block renders with `md(text, ts)` and the
image URL carries that stamp (`&at=<ts>`); `/file` and `/save-to-downloads`
serve the first snapshot taken at or after it, which is the one made for that
message, and fall back to the live file when there is none (chats older than
this, files over 64 MB).

### Gapless loops (`#loop`)

An audio embed plays as a seamless loop when its path ends in a loop fragment:

- `![Title](/abs/path/song.mp3#loop)` loops the full decoded file.
- `![Title](/abs/path/song.mp3#loop=START,END)` loops the window from START to END, in seconds (decimals are permitted). Playback starts at START. The loop does not include the sample at END.

The `#loop=START,END` embed is for MP3. An MP3 decoder adds samples at the start and the end of the file (encoder delay and padding). Thus the file edges are not part of the period. The author puts periodic pre-roll and post-roll around one complete period and sets the window on a period in the middle. Then the decoder offset has no effect on the loop.

The player uses the Web Audio API, not `<audio loop>`. The `<audio>` element does not loop MP3 continuously: each time it starts the file again, the sound stops for a short time. The first click on play downloads the file through `/file`, decodes it into an `AudioBuffer` and plays it through an `AudioBufferSourceNode` with `loop = true`. The wrap is where the loop goes from END back to START. At the wrap, the audio engine plays the first sample of the window directly after the last sample. The decode uses the sample rate in the file header (WAV, FLAC, MP3), thus no resampler changes the file edges. A resampled whole-file loop makes a click at each wrap.

When playback starts, the `GainNode` value goes from 0 to 1 in 30 ms. Before playback stops, the value goes from 1 to 0 in 30 ms. This occurs at each start, pause and stop, and at each change of position, thus these controls do not make a click. The wrap has no ramp.

The row shows play and pause, a loop glyph and a bar that shows and sets the position in the window. It also shows the time and a "pass" counter. "pass 1" is the first time through the loop, and the counter increases by one at each wrap. When a loop starts, the loop that plays stops. A loop that plays counts as audio for the crystal, which then shows its "speaking" animation.

The player keeps its data in a registry (`loopPlayers` in `app.js`) and not in the DOM. The registry identifies each player by its file and its window. Thus a player continues through the stream re-renders and the history replays. The embed changes to a plain `<audio controls loop>` in three conditions: Web Audio is not available, the file does not decode, or the file is larger than 64 MB. A share snapshot replaces the player with a stub.

`embeds.py` does not make a snapshot of a `#loop` embed, because its extension test sees the fragment. Thus a loop embed always plays the live file.

### 3D models

`![name](/abs/path.stl)` renders an inline 3D viewer. The extensions are `.stl`, `.3mf`, `.obj`, `.glb` and `.gltf` (`MODEL_EXTS` in `embeds.py`). `static/model.js` finds each `.genmodel-wrap` the markdown pass emits, loads `static/vendor/three.js` on first use, and draws the part as a slow turntable. Drag orbits, the wheel zooms, a double-click resets the view, and two buttons on the frame reset the view and toggle wireframe. The caption shows the measured size in mm and the triangle count.

Each viewer renders straight into its own WebGL canvas. WebKit permits approximately 16 live contexts and a long chat can hold more embeds than that, so at most four viewers hold a context at one time. A viewer takes a context when it enters the viewport and gives it back when it leaves, when the pool is full, or after 20 seconds without a frame. A parked viewer shows a PNG still of its last frame. The turntable runs at 30 frames per second for 8 seconds after load or a reset, at pixel ratio 1 while it moves, then stops and draws one frame at full device resolution. An idle page draws nothing. Units are read as millimetres. STL and 3MF are Z-up; OBJ and glTF are Y-up and are rotated onto the same floor. A share snapshot replaces the viewer with a PNG of its current view (`window.MistModel.snapshotPNG`).

### Artifacts drawer

The `perm_media` button in the top bar opens a drawer of everything MIST made in the active chat: every image, audio clip, video, 3D model, HTML page and other file she embedded with `![name](/abs/path)`. `static/artifacts.js` reads the chat's own bubbles (the `.genimg-wrap`, `.genaudio-wrap`, `.genvideo-wrap`, `.genmodel-wrap` and `.genfile` elements the markdown pass emits), so the drawer needs no server state, follows the active chat, and stays correct through stream re-renders and replays (a `MutationObserver` on the transcript schedules a rescan). One tile per distinct file, newest first, with a filter row by kind and a count on the button.

A tile's thumbnail opens the artifact: a lightbox for an image, a preview for an HTML page, the message itself for the rest. Its buttons jump to the message and save the file. A 3D tile shows the viewer's current frame (`MistModel.snapshotPNG`).

HTML previews go through `GET /preview?path=...&at=...`, which serves `.html`, `.htm` and `.svg` with a CSP `sandbox` header (no `allow-same-origin`), inside an iframe that carries its own `sandbox` attribute. The page thus runs in an opaque origin: no Console cookies, no localStorage, and its requests arrive with `Origin: null`, which `_remote_guard` in `app.py` refuses for any state-changing method, from loopback too. `/file` keeps serving these types as attachments. Tests: `tests/test_preview.py`.

On a phone the same panel is full width. It opens from the chat-details sheet (tap the title, then **Artifacts**) or with a swipe in from the right edge; a save there goes to the phone (see the iPhone section).

## Conversation mode (talk to MIST, hear her answer)

The sound-wave button in the composer opens a column beside the chat (design:
`design/handoff/2026-10-03`, layout 1c) with the live crystal, a one-word
state, a caption and the controls. The chat stays the record: each spoken turn
is a normal message, and MIST's reply is read aloud sentence by sentence as it
streams. Typing still works at any time, and a typed send cuts her off the same
way speech does.

- **Listening.** `static/vendor/vad/` holds Silero VAD on onnxruntime-web; the
  page finds the end of each utterance itself. `hands-free` keeps the mic open,
  `hold` is push-to-talk (Space with an empty composer, or the mic button held).
  Real speech while she talks is a barge-in: her audio stops and the rest of
  that reply's queue is dropped (the text still lands in the chat). Esc does the
  same from the keyboard.
- **Speech to text** runs on this Mac: `POST /voice/stt` (voice.py) feeds a 16 kHz
  WAV to whisper.cpp. The first call starts a resident `whisper-server` on
  :8089; until it is up, `whisper-cli` answers. The model is the best one in
  `models/` (gitignored): `ggml-large-v3-turbo.bin` (1.6 GB, about 1.8 s per
  utterance) over `ggml-small.en.bin` (0.5 GB, about 0.5 s), or
  `MIST_WHISPER_MODEL` pins one. `bin/fetch-whisper-model [name]` downloads a
  model and `brew install whisper-cpp` provides the binaries. Every request
  carries a vocabulary prompt (MIST, Plaud, Supernote and other words whisper
  has not met; "Hi MIST" came back as "I missed" without it). Add private terms
  such as people's names to `models/stt-vocab.txt`, one per line, gitignored.
  The prompt is capped at 12 terms: past about a dozen, extra terms dilute the
  others and stopped helping in tests. The last 20 utterances and their
  transcripts are kept in `data/stt/` (local, gitignored; `MIST_STT_KEEP=0`
  turns it off) so models and prompts can be tested on the real microphone.
- **Voice.** `Live voice` is the web view's own speechSynthesis (instant, with
  word boundaries for the caption); when it has no voices the server's `say`
  stands in. `MIST voice` is her XTTS clone from the harness voice service
  (`mist-voice/scripts/serve.py`, :8087): slower than real time, so the pane
  shows `rendering` while the next sentence is not ready, and the first pick
  starts the service (about 80 s cold) and uses the live voice until it answers.
- **The model hears the difference.** A spoken turn is sent with `voice: true`;
  `app.py` appends `voice.VOICE_HINT` for the model and shows only what was said.
- **Microphone.** WKWebView asks its UI delegate before `getUserMedia` resolves;
  `desktop.py` `_grant_microphone()` adds that answer to pywebview's delegate
  (mic only, local page only). macOS also needs `NSMicrophoneUsageDescription`
  in the .app, which `make-app.sh` writes, so a rebuild is required once
  (`bin/rebuild-app-when-quit` does it the next time the Console is closed).
- **System audio.** Tools MIST runs from a chat (the harness `govee-music`, which
  taps one app's audio through a Core Audio process tap) are attributed to the
  Console, so the .app also carries `NSAudioCaptureUsageDescription`. Without it
  macOS never prompts and the tap records silence. The first run after a rebuild
  asks once (System Settings > Privacy & Security > Screen & System Audio Recording).
  Nothing plays until the mode is switched on.

## Share links (public read-only snapshots)

The **share** button in the top bar emulates claude.ai's "share chat": it
publishes a read-only snapshot of the active conversation at an unguessable,
revocable URL. Capture is client-side (`buildShareSnapshot` in app.js): the
transcript DOM is cloned, everything interactive is stripped (buttons become
inert spans, audio/video become labeled stubs), local images are inlined as
data URIs (3 MB cap each), and the stylesheet + wallpaper ride along inline, so
the result is one self-contained HTML file. Thinking and tool cards stay
collapsible for free — they're native `<details>` elements. The icon font
doesn't ship; a small override swaps the chevron/check glyphs for plain
characters.

- **Storage**: `share.py`. Canonical copy at `data/shares/<token>.html`
  (`token` = 24 url-safe random chars, minted once per chat — updating a share
  keeps its URL). Served locally at `/share/<token>` with a
  scripts-forbidden CSP.
- **Publishing**: a read-only Cloudflare Worker (`mist-share`) serving the
  snapshot out of Workers KV at
  `https://mist-share.<subdomain>.workers.dev/s/<token>`, plus the preview card
  at `/s/<token>/card.png`. `noindex` rides in the `X-Robots-Tag` header rather
  than a `<meta>` so search engines stay out while unfurlers still build a
  preview; `no-store` on the HTML keeps revocation instant. The Worker accepts
  only GET/HEAD; publish and revoke go from `share.py` straight to the KV REST
  API. Deploy is lazy and
  idempotent (first publish, or when the embedded worker source changes) and
  needs a token with **Workers Scripts:Edit + Workers KV Storage:Edit** saved
  as `CF_SHARE_API_TOKEN` in the harness `.env` (the mist-image token is
  Workers AI-only). Without it, sharing still works local-only and the share
  panel says exactly what to mint.
- **Link previews**: every snapshot carries Open Graph + Twitter-card tags, so
  the link unfurls in Discord, Slack, iMessage and the rest with the chat's
  title, its opening prompt as the description, and a 1200x630 card. The card
  is drawn in the live page (`shareCardPNG` in app.js) on a canvas that reads
  the current theme's CSS variables, so it matches the skin the chat was read
  in; it's posted as base64 alongside the HTML and stored at
  `data/shares/<token>.png`. `og:url`/`og:image` are absolute or absent, which
  means the Worker is deployed *before* the snapshot bytes are assembled. A
  local-only share still gets title and description tags. The share panel shows
  the card back to you, so you see what a recipient will see before you paste.
- **UI states**: create (with a plain-language "anyone with the link" warning),
  manage (copy / open / update snapshot / stop sharing), and
  unpublished-with-reason. New messages are never auto-published; "update
  snapshot" re-captures explicitly.

## MCP parity with the CLI

The session loads **all** MCP scopes (no `--strict-mcp-config`), exactly like the interactive `claude` CLI: things3, fitbit, withings, linkedin, and the claude.ai connectors (Gmail/Calendar/Drive/MyChart). 8 servers, ~90 MCP tools.

**Important:** `init` (with the server/tool list) doesn't fire until the **first user message**, because claude's stream-json mode is request-driven. So a brand-new chat shows `—` for model/MCP until you send something; after the first message everything populates (and the settings panel caches the last-known set). This is normal, not a hang.

## Claude Mods (plugins of function hooks)

Claude Code 2.1.287 added **mods**: plugins whose `hooks/hooks.json` names a TypeScript module exporting `register(on, options)`. A hook can intercept tool calls and prompts, add commands and tools, run timers, and draw UI. The Console loads them and draws them.

- **Loading.** `bridge.py` puts the repo's `mods/` folder (or `MIST_CONSOLE_MODS_DIR`) in `CLAUDE_CODE_PLUGIN_DIRS` for every backend it spawns, which the CLI loads exactly as `--plugin-dir` would, headless included, and sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` so a saved edit reloads the module in live chats. The in-chat "Enable hot reloading?" flow is off under `-p` (nobody can be asked), so mods for the Console are written from a terminal session or straight into `mods/`. `mods/console-pulse` is the starter: a status line, a toast, a `/pulse` pane with buttons and a text field.
- **Status lines, toasts, log lines** (`$.ui.status`, `$.ui.toast`, `$.ui.log`) arrive on stdout as `system` messages with subtypes `ui_status` / `ui_toast` / `ui_log` (verified against 2.1.287). Status lines draw as chips in a strip above the composer, per chat; toasts stack under the top bar; log lines are dim transcript lines. Status and toasts are live only, never recorded.
- **Panes, the band, and trees over rows** need a drawing surface. The CLI accepts a remote surface named `desktop`, `mobile` or `vscode`; after each `init` the bridge sends `ui_attach` (surface `desktop`, client id `mist-console`, the viewport in character cells, and the asks it answers) and the page asks `ui_render` for each site: a `Pane` per entry in the pane roster (`ui_panes` pushes), `AbovePrompt` for the band, and `ToolUse` / `UserMessage` / `AssistantMessage` for live transcript rows. `static/mods.js` turns the tree the hooks answer (Box, Text, Button, Input, Select, Link, Code, Markdown, Svg; `engine` nodes stand for the Console's own row) into DOM and relays presses, typed text and picks back as `ui_press` / `ui_input` / `ui_select`. `hooked: false` on a render answer stops further asks for that component until the next `ui_invalidate`. `Client` elements (plugin-side React modules) are not drawn yet; the spec allows a surface to draw nothing for them.
- **Asks from the engine** (`$.ui.copy`, `$.prompt.read` / `fill` / `suggest`) reach the page as `ui_ask` events; it answers over `POST /sessions/<id>/ui/answer`, and the bridge answers the default shape itself when no page replies within 4.5 s (the CLI waits 5 s).
- **Settings → mods** lists the loaded plugins (from `init.plugins`), their status lines and load errors, with **reload mods** (`reload_plugins`) and **open mods folder**. The pane dock on the right is resizable; a pane tab closes with its ×, Escape returns the keyboard to the composer, a Button's hotkey works while the pane holds focus.

Routes: `POST /sessions/<id>/ui/attach|render|press|input|select|panes|pane-show|pane-focus|pane-close|answer`, `GET /sessions/<id>/mods`, `POST /sessions/<id>/mods/reload`, `POST /mods/reveal`.

## Other CLI features wired in alongside mods

- **Dialogs** (`request_user_dialog`). `initialize` now declares `supportedDialogKinds: ["refusal_fallback_prompt"]`, so an API refusal offers **Retry on &lt;fallback&gt; / Edit prompt / Cancel** as a card (and banner buttons) instead of ending in the refusal error. A kind the Console did not declare is deliberately left unanswered, as the protocol requires; the CLI settles it on its own deadline.
- **Prompt suggestions** (`--prompt-suggestions`, on by default under settings → claude flags): the predicted next prompt shows as the composer placeholder while it is empty; **Tab** takes it. A mod's `$.prompt.suggest` lands in the same slot.
- **Hook events** (`--include-hook-events`): each turn gets one collapsed "N hooks" card listing `hook_response`s; a failed hook (the guard hook's denials, for one) turns it amber and shows the stderr.
- **Subagent text** (`--forward-subagent-text`): a subagent's own messages, which carry `parent_tool_use_id`, no longer touch the main bubble; they collect in a "subagent" fold inside the Agent tool card.
- **Permission modes** `auto` and `dontAsk` join the picker (`manual` is the CLI's alias of default).
- **Usage card**: the 5h / 7d badges open `get_usage`: every plan window the CLI knows (Opus, Sonnet, apps...) with reset times, plus this chat's cost by model.
- **Live model catalog**: the model card reads `list_models` from a live backend (display names, descriptions) and the thinking-depth card hides effort levels the chosen model does not support; the binary-grep list remains the dormant fallback.
- **Workspace diff**: settings → workspace, or `/diff` in the composer, opens `get_workspace_diff` for the chat's folder, files with +/- counts and hunks.
- **Ratings**: thumbs up / down on a reply send `message_rated` with the CLI's own message uuid.
- **Restore files**: the "history" action on a user message runs `rewind_files` (dry run first, then a confirm strip naming the files), the TUI's /rewind "restore code" without touching the chat.
- **Session names**: backends spawn with `--name <chat title>` and a rail rename sends `rename_session`, so `claude --resume` and `claude agents` show the Console's titles.
- **Claude flags** (settings section, `data/flags.json`, `bridge.FLAGS`): the three toggles above, `--chrome`, `--fallback-model`, `--autocompact`, `--max-budget-usd`. A change applies when a chat's backend next starts.

Not wired, on purpose: `--bg` background sessions and `claude agents` (the Console's rail already is that list), `--cloud` / `--teleport` / `--remote-control` (cloud sessions), `--brief` (the model's text already reaches the person here), `--replay-user-messages` (the Console renders its own user bubbles).

## Quick access (always-on, even when MIST is closed)

Double-tap the **Option (⌥)** key to summon the glowing quick-entry overlay from anywhere; type + Enter starts a new chat. Attach the current page **URL** (🔗) or a **screenshot** selection (⛶), and use the **conversation picker** (⤷, or press ↓ on an empty input) to drop the message + attachments into an existing chat instead of a new one. The overlay grows upward to show a searchable, pinned-first list, and the main window slides straight into the chosen conversation.

The gesture is owned by a tiny windowless background agent (`mist-hotkey-agent.py`), **not** by MIST herself, so it works even when MIST is fully quit. On the gesture: if MIST is running it POSTs `/show-quick`; if she's closed it `open`s her, waits for her to bind, then summons the overlay. The agent runs as a LaunchAgent (`com.exobrain.mist-hotkey-agent`, RunAtLoad + KeepAlive) installed by `install-agent.sh`: always on, starts at login.

- Needs macOS **Accessibility** permission for the agent (global modifier monitoring). The agent self-requests it on first run.
- The overlay joins all Spaces / floats over fullscreen apps, so it appears on whatever Space you're on.
- Enable/disable + the gesture live in MIST **settings → quick access** (the agent re-reads the config every 10s).
- Uninstall: `launchctl unload ~/Library/LaunchAgents/com.exobrain.mist-hotkey-agent.plist`.

## Roadmap (bolt-on order)

- [x] **Interactive permissions**: Allow/Deny/Allow-for-session cards over the control protocol (see above).
- [x] **Slash-command palette**: `/` autocomplete from the init `slash_commands` list.
- [x] **Interrupt / stop**: Esc / stop button cancels an in-flight turn (`interrupt` control_request, no restart).
- [x] **Diff viewer**: Edit/Write/MultiEdit render as red/green diffs; TodoWrite as a checklist.
- [x] **Image paste**: clipboard + drag-drop attachments.
- [x] **Session list / resume**: dormant revival via `--resume <session_id>`.
- [ ] **@-file mentions**: `@` path autocomplete in the composer.
- [ ] **MIST voice**: speak responses via `mist-voice`; reactive avatar.
- [x] **Runtime model/mode switch**: `set_model` / `set_permission_mode` control_requests instead of kill/restart (effort still restarts: no control request for it).
- [x] **MCP panel**: live status + reconnect / toggle / authenticate; elicitation cards.
- [x] **Message actions**: edit & resend, regenerate, branch (truncating fork resume).
- [x] **Compaction**: compact-now on the cost notices and the ctx card; boundary divider.

## iPhone app (ios/)

`ios/` is a native iPhone shell (SwiftUI + WKWebView) around this same web UI,
served by the Mac: pair it once, and every chat is there, live, because they
are the same chats. Nothing runs on the phone, so the Mac has to be awake with
the Console open. It ships Lock Screen and Home Screen widgets (open the
Console, or open it in a new chat) and keeps a read-only text copy of every
chat on the phone (`/sessions/<id>/transcript`, `transcript.py`) for when the
Mac is out of reach. Build and pairing steps are in
[`ios/README.md`](ios/README.md).

What changed on the server for it (`remote.py`, the `/remote/*` routes):

- **The server binds every interface**, and a `before_request` guard decides
  each request: a loopback request with no proxy headers is trusted exactly as
  before (the window, `mist-progress`, notification replies, scripts inside a
  chat); anything else needs **remote access switched on** (settings, phone)
  **and the pairing token**, as the `mist_remote` cookie from `POST
  /remote/login` or a `Bearer` header. Off means every non-local request is
  refused. Only `/remote/ping` and `/remote/login` answer without the token,
  and the login is rate-limited per address. A browser landing on `/` without
  the cookie gets a small login page instead of the app.
- **Pairing**: the phone section shows a QR (`mist://pair?d=<base64url
  json>`: addresses, token, discovery URL). The token lives in
  `data/remote.json` (mode 600, gitignored with the rest of `data/`); the
  cookie carries an HMAC of it, so rotating the token logs every phone out.
- **Addresses**: every IPv4 address on an up interface (Wi-Fi first, then
  the other `en*` so USB tethering counts, bridges, tunnels) and
  `<hostname>.local` on this port, plus two off-LAN lanes: a supervised
  **cloudflared quick tunnel** (`tunnel: true` keeps one up and restarts it
  after a crash) and a **user-entered address** (Tailscale MagicDNS, a named
  tunnel). The tunnel's origin is a second, loopback-only listener on
  `ORIGIN_PORT` (port + 1000) that the guard treats as never local, so a
  tunneled request can never inherit loopback trust, a VPN's LAN rules never
  touch it, and the public URL survives a network hop. The Mac publishes its
  whole current address list as a tiny JSON document in the share Worker's KV
  (`/s/remote-<discovery id>`, URLs only, never the token) and republishes
  within ~15 s of the list changing; the phone reads it when nothing it
  remembers answers, which is how it finds the Mac on the phone's own hotspot.
- **macOS firewall**: the first bind on `0.0.0.0` makes macOS ask whether
  "MIST Console" may accept incoming connections. Allow it; Deny blocks the
  phone until the rule is changed in System Settings, Network, Firewall.
- `MIST_CONSOLE_PORT` tells `remote.py` which port a test instance answers
  on, so its tunnel points at itself and not at the live Console.

### Parity with the Mac

The phone is the same page, so a feature is on the phone the moment it ships, unless the phone layout hides it or it depends on a Mac-only affordance (hover, a native window, the Mac's file system). **Every change to the Console ships with its phone path in the same commit**, and this table is where that path is recorded. A row with "gap" is a known hole, not a decision.

| Feature | Mac | Phone (under 760px, or the iOS shell) |
| --- | --- | --- |
| Chat list | rail | drawer (menu button, swipe from the left edge) |
| Model, permissions, thinking, usage, share, diff, rename, pin, delete | top-bar badges and cards | chat-details sheet (tap the title) |
| Message actions | hover icons | long-press sheet |
| Bookmarks | composer button | drawer footer, **Saved** |
| Settings | gear | drawer footer, **Settings** |
| Artifacts drawer | top-bar button | chat-details sheet, **Artifacts**, or swipe from the right edge |
| Inline images, audio, video, recipe cards, task checkboxes, progress bars | inline | inline, same markup |
| 3D models | drag orbits, wheel zooms, double-click resets, tools on hover | one finger orbits, pinch zooms, double-tap resets, tools always shown (`@media (hover: none)`) |
| Save a file | copies into the Mac's `~/Downloads` | the shell downloads it over the pairing token and opens the share sheet (`ArtifactSaver.swift`, `shellSave` in app.js) |
| HTML preview | sandboxed frame, plus "Open in browser" | sandboxed frame only (Safari has no cookie) |
| Conversation mode | column beside the chat | gap: the pane is hidden on phones |
| Mod panes | dock beside the chat | gap: the dock is hidden on phones |
| Repo switching | repo badge | gap: needs a folder picker |
| Quick access (double-tap Option) | always-on agent | widgets and the icon's long-press menu |

## Archive tier (data/ growth)

`data/` reached 2.9 GB across 1374 chats (14 files over 20 MB). Chats that are unpinned, dormant, unwatched and untouched for `archive.ARCHIVE_AFTER_DAYS` (90) are **condensed** by a daily server thread (`archive.py`): stream deltas, tool-result sidecars, task and progress ticks go; every assistant API message becomes one `mist_msg` event (text / thinking / tool blocks, the same shape imported chats use), `user_text` and the last `context` event stay, `seq`/`ts` stamps and the CLI `uuid` are preserved so ordering, timestamps, search and rewind anchors still work. Measured: a 41 MB chat condenses to 2.5 MB in about a second. Condensed chats fold into a collapsed **long ago** section near the bottom of the rail (above Alex's own **archived** section) and stay fully searchable and resumable. Their flag is `condensed` in `sessions.json`. Pinned chats are never touched. `compact_boundary` dividers are kept too. The same `Condenser` bounds the in-memory replay window of every chat (see Persistent above). `MIST_CONSOLE_DATA_DIR` points a test instance at its own data dir.

## Expired CLI transcripts (replay) and pinned chats

Claude Code deletes a session transcript (`~/.claude/projects/<slug>/<id>.jsonl`) when its mtime is older than `cleanupPeriodDays` (default 30, set to 60 on this machine in `~/.claude/settings.json`). The Console keeps its own log of each chat, so the text survives, but a `--resume` of a deleted id fails with "No conversation found with session ID". Before 2026-10-02 the Console then started an empty session, and the window continued to show the full chat.

Replay (`replay.py`). Before a spawn, `ClaudeSession._transcript_gone()` looks for the CLI file in all project folders. If it is gone, the backend starts a new session and the next send carries the earlier conversation as one text block in front of the message: Alex's messages and MIST's replies, a one-line marker for each tool call, no tool output or thinking. Above 160k characters, the first message and the newest turns stay. A notice in the chat says that the context came from the Console log. If the CLI reports a missing session after this check (a race with its own sweep), `_watch` reseeds and sends the message again. The replay is in the new CLI transcript, so all subsequent `--resume` starts keep it.

Pinned chats (`retention.py`). A pinned chat's countdown is suspended. At 10-minute intervals the server moves the mtime of each file of the chat's CLI session (the transcript, its sidecars, the `<id>/` folder) forward by the time since the last tick. A file written since then keeps its actual time. After an unpin the countdown continues from where it stopped. The server keeps the clocks in `data/retention.json`.

## Dependencies

- `claude` CLI (provides the stream-json protocol). The path is resolved at
  import by `bridge._find_claude()`, which checks `~/.local/bin` (native
  installer), the npm-global prefix, then Homebrew, then `PATH`. Do not hardcode
  an install path -- the CLI has migrated homes before and took every pinned
  caller down with it.
- `uv` (self-installs `flask`, `pywebview`/`pyobjc` on first run).
- Reuses `mist-terminal/mist-persona.md` from the harness for MIST's voice.

## Privacy / legibility

No personal data in this project. The session runs in the Exobrain harness (which has its own privacy rules); this app is just transport + UI.
