// ─────────────────────────────────────────────────────────────────────────
// Character Sheet Edit Guard
// Prevents SillyTavern from reloading/re-rendering the chat on every keystroke
// when editing character fields (description, personality, scenario, notes, etc.)
// if only the initial greeting message is present and greeting itself hasn't changed.
// ─────────────────────────────────────────────────────────────────────────

export function initCharSheetGuard() {
    if (window._wsCharGuardCleanup) window._wsCharGuardCleanup();

    let lastGreetingVal = null;
    let lastCharName = null;
    let restoreTimer = null;
    let taintedBackup = null;

    function syncLastValues() {
        const greetingEl = document.getElementById('firstmessage_textarea');
        const nameEl = document.getElementById('character_name_pole');
        if (greetingEl) lastGreetingVal = greetingEl.value;
        if (nameEl) lastCharName = nameEl.value;
    }

    function restoreTaintedIfPending() {
        if (restoreTimer) {
            clearTimeout(restoreTimer);
            restoreTimer = null;
        }
        if (taintedBackup) {
            const { meta, wasTainted } = taintedBackup;
            taintedBackup = null;
            if (meta) meta.tainted = wasTainted;
        }
    }

    const context = SillyTavern?.getContext?.();
    const evtTypes = context?.event_types;
    const registeredListeners = [];
    if (context?.eventSource && evtTypes) {
        const resetEvents = new Set([evtTypes.CHAT_CHANGED, evtTypes.CHAT_LOADED, evtTypes.CHARACTER_PAGE_LOADED].filter(Boolean));
        const events = [
            evtTypes.APP_READY,
            evtTypes.CHARACTER_PAGE_LOADED,
            evtTypes.CHAT_CHANGED,
            evtTypes.CHAT_LOADED,
            evtTypes.CHARACTER_EDITOR_OPENED,
            evtTypes.CHARACTER_FIRST_MESSAGE_SELECTED,
        ].filter(Boolean);

        events.forEach(ev => {
            try {
                const handler = () => {
                    restoreTaintedIfPending();
                    if (resetEvents.has(ev)) {
                        lastGreetingVal = null;
                        lastCharName = null;
                    }
                    setTimeout(syncLastValues, 50);
                };
                context.eventSource.on(ev, handler);
                registeredListeners.push([ev, handler]);
            } catch {}
        });

        // Lazy baseline initialization on first focus only (never overwrite baseline on input keystrokes)
        if (typeof $ === 'function') {
            $(document).off('.wsCharGuard').on('focus.wsCharGuard', '#firstmessage_textarea, #character_name_pole', function () {
                const greetingEl = document.getElementById('firstmessage_textarea');
                const nameEl = document.getElementById('character_name_pole');
                if (greetingEl && lastGreetingVal === null) lastGreetingVal = greetingEl.value;
                if (nameEl && lastCharName === null) lastCharName = nameEl.value;
            });
        }

        // Intercept CHARACTER_EDITED right before ST checks shouldRegenerateMessage
        if (evtTypes.CHARACTER_EDITED) {
            const onCharEdited = () => {
                try {
                    const ctx = SillyTavern.getContext();
                    const chat = ctx?.chat;
                    const meta = ctx?.chatMetadata;

                    // Only applies when chat has at most the initial greeting message
                    if (Array.isArray(chat) && chat.length <= 1 && (chat.length === 0 || (!chat[0]?.is_user && !chat[0]?.is_system))) {
                        if (meta && !meta.tainted) {
                            const currentGreetingEl = document.getElementById('firstmessage_textarea');
                            const currentNameEl = document.getElementById('character_name_pole');
                            const currentGreetingVal = currentGreetingEl ? currentGreetingEl.value : null;
                            const currentCharName = currentNameEl ? currentNameEl.value : null;

                            const activeId = document.activeElement?.id;
                            const isGreetingOrNameActive = (activeId === 'firstmessage_textarea' || activeId === 'character_name_pole');

                            const greetingChanged =
                                (lastGreetingVal !== null && currentGreetingVal !== null && currentGreetingVal !== lastGreetingVal) ||
                                (lastCharName !== null && currentCharName !== null && currentCharName !== lastCharName) ||
                                (lastGreetingVal === null && lastCharName === null && isGreetingOrNameActive);

                            if (!greetingChanged) {
                                // Temporarily set tainted to true so ST skips clearChat() & printMessages()
                                if (!taintedBackup || taintedBackup.meta !== meta) {
                                    taintedBackup = { meta, wasTainted: meta.tainted };
                                }
                                meta.tainted = true;
                                if (restoreTimer) clearTimeout(restoreTimer);
                                restoreTimer = setTimeout(restoreTaintedIfPending, 50);
                            } else {
                                lastGreetingVal = currentGreetingVal;
                                lastCharName = currentCharName;
                            }
                        }
                    }
                } catch (err) {
                    console.error('[CharSheetGuard] Error in CHARACTER_EDITED handler:', err);
                }
            };
            context.eventSource.on(evtTypes.CHARACTER_EDITED, onCharEdited);
            registeredListeners.push([evtTypes.CHARACTER_EDITED, onCharEdited]);
        }
    }

    window._wsCharGuardCleanup = () => {
        registeredListeners.forEach(([ev, fn]) => {
            try { context?.eventSource?.removeListener?.(ev, fn); } catch {}
        });
        if (typeof $ === 'function') $(document).off('.wsCharGuard');
        restoreTaintedIfPending();
        window._wsCharGuardCleanup = null;
    };

    if (context?.characterId !== undefined) {
        syncLastValues();
    }
}

