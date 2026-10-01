# Claude Code usage tracker mod

A Claude Code mod that shows your usage in a bar above the prompt:

- **ctx**: how full the context window is, with the token count
- **cache**: share of prompt tokens served from the cache
- **5h / 7d**: plan limit bars with time until reset
- **Weekly pace**: the 7d reset time turns green when you're on pace (about 14% a day or less), yellow when you're up to a day ahead, red when you're a day or more ahead
- **Cost** and a small sparkline of context use
- A spinner while a compaction runs

Bars are blue, turn amber at 60% and red at 85%. Type `/dash` for a larger pane with the same numbers.

Works in the Claude Code desktop app (Code tab) and the terminal, on Windows and Mac.

## Install

1. Clone or download this repo somewhere permanent:
   ```bash
   git clone https://github.com/2h5/claude-mod-usage-tracker.git
   ```
2. Open `~/.claude/settings.json` and point `CLAUDE_CODE_PLUGIN_DIRS` at the folder:

   Windows:
   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\claude-mod-usage-tracker" } }
   ```
   Mac / Linux:
   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/claude-mod-usage-tracker" } }
   ```
   If the file already has an `"env"` section, add the line inside it.
3. Restart Claude Code, or run `/reload-plugins`.

Or ask Claude: *"Install the Claude Code mod in this folder by adding it to CLAUDE_CODE_PLUGIN_DIRS in my settings.json."*

## Update

```bash
git pull
```
Then `/reload-plugins`.

## Files

- `.claude-plugin/plugin.json`: the mod's manifest
- `hooks/register.js`: all the mod's code
- `tests/`: tests, run with `claude plugin test`
