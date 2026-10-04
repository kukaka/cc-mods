export type Stats = { formatted: number; skipped: number; failed: number }

declare module 'claude-code' {
  interface PluginState {
    'cc-code-format-mod': {
      stats: { value: Stats }
    }
  }
}