// Plugin state contract for cc-file-history-mod.
//
// The engine uses this file to type every `$.state.get` / `$.state.set` call
// in hooks/register.tsx (and to verify each value's key on plugin load via
// `claude plugin validate`). This plugin declares no `$.state` values — all
// state (edits, expanded set, diff cache, paneOpen) is module-local and
// resets on hot reload.

declare module 'claude-code' {
  interface PluginState {
    'cc-file-history-mod': {
      // intentionally empty: no persisted state
    }
  }
}