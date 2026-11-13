# Disable debugger when no rules

## Goal

When `interceptRules` is empty, DevProxy must not attach the Chrome debugger or enable Fetch. Interception is off until at least one rule exists.

## Non-goals

- Treating “all rules toggled off” as disabled (only empty list).
- A separate global `enabled` storage flag.
- Keeping the debugger attached while only calling `Fetch.disable`.

## Behavior

| Event | Rules empty | Rules non-empty |
|-------|-------------|-----------------|
| Service worker start | No attach | Attach active tab |
| Tab activate / navigate | No attach | Attach as today |
| `getStatus` / `ensureAttach` / `getRules` | Do not attach; report idle | Attach / report attached |
| `addRule` / `updateRule` | N/A / if emptied, detach | Attach |
| `deleteRule` / `clearAllRules` | Detach all tracked tabs | Leave attach state |

Definition of empty: `interceptRules.length === 0` only.

## Implementation sketch

1. `hasRules()` → `interceptRules.length > 0`.
2. `syncInterception()` (or equivalent):
   - If no rules: cancel reattach timers; detach every tracked tab; `forgetDebuggee`; return idle `attachResult` (`reason: 'no_rules'`, message that interception is off because there are no rules).
   - If has rules: existing `attachDebugger` / `attachDebuggerToActiveTab` path.
3. Call sync from: message handlers that change rules or query status/rules, `stateReady`, `tabs.onActivated`, `tabs.onUpdated`.
4. `scheduleReattach` / `onDetach` soft-retry: no-op when there are no rules.
5. `getStatus.isEnabled`: `hasRules()` (not hardcoded `true`).
6. Popup: if `attachReason === 'no_rules'`, show neutral/ok idle copy (not the DevTools-conflict warn).

## Error handling

- Detach failures are logged; still clear local tracking so we do not think we are attached.
- Adding the first rule re-attaches via the existing attach path (same failure modes as today).

## Testing

Manual:

1. Load extension with no rules → no “Debugger attached” on a normal https tab; popup shows idle/no-rules status.
2. Add a rule → debugger attaches; interception works.
3. Delete last rule (or clear all) → debugger detaches; banner gone.
4. With rules present, tab switch / navigation still re-enables Fetch as today.
