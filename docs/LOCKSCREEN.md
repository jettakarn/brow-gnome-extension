# Lock screen evaluation

Question: can Brow follow the user onto the lock screen (`session-modes: ["user", "unlock-dialog"]`), as a first step toward GDM?

## What `unlock-dialog` does

- Without it, the Shell disables every extension when the screen locks and enables them again on unlock. Brow's actors are destroyed and rebuilt each time.
- With it, `enable()` is not called again on lock. The extension keeps running while the lock dialog is up, and `metadata.json` must declare `"session-modes": ["user", "unlock-dialog"]`.
- extensions.gnome.org reviewers require a written reason for this mode, and they check that nothing sensitive is reachable while locked.

## Findings

1. Placement. Brow draws on `Main.layoutManager.uiGroup`. During lock, the lock dialog lives in `Main.layoutManager.screenShieldGroup` and covers `uiGroup`. The island would be hidden behind the shield. To show it, the actor has to be re-parented to `screenShieldGroup` (or `lockDialogGroup`) on lock and moved back on unlock.
2. Safe content. Only read-only pieces make sense on the lock screen: clock, date, battery, and now playing with transport controls through `playerctl`. These need no new permissions.
3. Unsafe content. These must be unreachable while locked:
   - Search (opens the browser).
   - Shortcuts (launches apps and sites).
   - Settings and Tools tabs.
   - Notification click actions (they activate apps).
   - Expanding the island at all, since the expanded view hosts all of the above.
4. Notifications. The Shell hides banners on the lock screen for privacy. The island notice must follow `org.gnome.desktop.notifications show-lock-screen`, or be turned off while locked.
5. Weather. It uses network lookups; no reason to run it while locked.
6. GDM. The greeter session mode is `gdm`, not `unlock-dialog`, and extensions are not loaded for the GDM user. Reaching it needs a separate packaged component, which stays out of scope here.

## Recommendation

Do not add `unlock-dialog` to `metadata.json` yet. If it is built later, do it in this order:

1. Add `LockMode` to the extension: on `Main.sessionMode` `updated` signal, when `currentMode === 'unlock-dialog'`, set a flag, collapse the island, hide the search, shortcuts, settings, and tools tabs, disable hover-to-expand, and re-parent the hit area to `Main.layoutManager.screenShieldGroup`.
2. Show only the notch with clock, battery, and media quick strip.
3. On unlock, re-parent back and clear the flag.
4. Test on GNOME 45 to 49. Lock and unlock repeatedly and confirm no leaked actors (`disable()` must still tear down everything).
5. Add the `unlock-dialog` mode to `metadata.json` and a short justification to the README for reviewers.
