// Prompt-cache totals for the session, kept across mod reloads
export type CacheTotals = { read: number; prompt: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-dash': { cache: CacheTotals }
  }
}
