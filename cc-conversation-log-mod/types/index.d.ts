// Plugin state contract for cc-conversation-log-mod.
//
// The engine uses this file to type every `$.state.get` / `$.state.set` call
// in hooks/register.tsx (and to verify each value's key on plugin load via
// `claude plugin validate`). This plugin declares no `$.state` values — all
// state (paneOpen, windowSize, expandedTools) is module-local and resets on
// hot reload and at session boundaries (`session.start`, the /clear / /resume
// / /branch hooks).

declare module 'claude-code' {
  interface PluginState {
    'cc-conversation-log-mod': {
      // intentionally empty: no persisted state
    }
  }
}
