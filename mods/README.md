# mods/

Claude Mods the Console loads into every chat. Each child folder is one plugin
of function hooks (CLI 2.1.287+): a `.claude-plugin/plugin.json` manifest and a
`hooks/hooks.json` naming one TypeScript module that exports `register(on, options)`.

The bridge puts this folder in `CLAUDE_CODE_PLUGIN_DIRS` for every backend it
spawns and sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, so a saved edit reloads the
mod in live chats. `MIST_CONSOLE_MODS_DIR` points the Console at another folder.

What a mod can do here: intercept or react to tool calls and prompts, add
slash commands and tools, run timers, and draw. The Console attaches to each
backend as the `desktop` surface, so a mod's status line (`$.ui.status`),
toasts (`$.ui.toast`), transcript lines (`$.ui.log`), panes (`$.ui.open`), the
band above the prompt, and trees over tool rows and messages all render in the
window (see `static/mods.js`). `Client` elements (plugin-side React modules)
are the one thing not drawn yet.

Check one with `claude plugin validate mods/<name>` and `claude plugin test
mods/<name>`. The `/plugin-authoring` skill is the reference; the API types
land in `<mod>/.claude-plugin/types/` the first time the mod loads.
