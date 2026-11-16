// ─── state.js ───────────────────────────────────────────────────────────────
// 채팅 데이터 접근, 설정 저장/로드, 클립보드, 스크롤 등 공용 상태 및 헬퍼.

// 마크다운 파서가 '*'를 이탤릭 마커로 오인하지 않도록 HTML 엔티티 사용
export const SUMMARY = '꒰⍤꒱ ༘&#42; Collapsed';

export const getChat = () => SillyTavern.getContext().chat;

function captureUndo(mesId, beforeText, afterText, isTranslation, name, isUser, swipeId) {
    try {
        if (typeof window !== 'undefined' && typeof window._slashieRecordUndo === 'function') {
            window._slashieRecordUndo({ mesId, beforeText, afterText, isTranslation, name, isUser, swipeId });
        }
    } catch (e) {
        console.warn('[Slashie] Undo snapshot error:', e);
    }
}

export async function editMessage(idx, newMes, skipSave = false) {
    const ctx = SillyTavern.getContext(), chat = getChat();
    const msg = chat?.[idx];
    if (!msg) return;
    if (msg.mes !== newMes) {
        captureUndo(idx, msg.mes, newMes, false, msg.name, msg.is_user, msg.swipe_id);
    }
    msg.mes = newMes;
    const sid = msg.swipe_id ?? 0;
    if (msg.swipes && sid < msg.swipes.length) msg.swipes[sid] = newMes;
    if (typeof ctx.updateMessageBlock === 'function') {
        ctx.updateMessageBlock(idx, msg);
    } else {
        const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
        if (el && ctx.messageFormatting)
            el.innerHTML = ctx.messageFormatting(newMes, msg.name, msg.is_system, msg.is_user, idx);
    }

    if (ctx.eventSource && ctx.event_types?.MESSAGE_UPDATED) {
        ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
    }
    if (!skipSave) {
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        } else if (typeof ctx.saveChatConditional === 'function') {
            await ctx.saveChatConditional();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
        }
    }
}

// 번역 확장(display_text / magic_translation)의 번역문 필드 수정 및 동기화
export async function editTranslatedText(idx, newText, skipSave = false) {
    const ctx = SillyTavern.getContext(), chat = getChat();
    const msg = chat?.[idx];
    if (!msg) return;
    const oldText = msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? '';
    if (oldText !== newText) {
        captureUndo(idx, oldText, newText, true, msg.name, msg.is_user, msg.swipe_id);
    }
    if (!msg.extra) msg.extra = {};
    msg.extra.display_text = newText;
    if (msg.swipe_id !== undefined && msg.extra.swipe_translations?.[msg.swipe_id]) {
        msg.extra.swipe_translations[msg.swipe_id].display_text = newText;
    }
    if (msg.extra.magic_translation) {
        msg.extra.magic_translation.translatedText = newText;
        if (msg.swipe_id !== undefined) {
            msg.extra.magic_translation.swipe_id = msg.swipe_id;
        }
    }
    if (Array.isArray(msg.swipe_info) && msg.swipe_id !== undefined && msg.swipe_info[msg.swipe_id]?.extra && typeof msg.swipe_info[msg.swipe_id].extra === 'object') {
        const swipeExtra = msg.swipe_info[msg.swipe_id].extra;
        swipeExtra.display_text = newText;
        if (swipeExtra.magic_translation) {
            swipeExtra.magic_translation.translatedText = newText;
            if (swipeExtra.magic_translation.swipe_id === undefined) {
                swipeExtra.magic_translation.swipe_id = msg.swipe_id;
            }
        }
    }
    if (typeof ctx.updateMessageBlock === 'function') {
        ctx.updateMessageBlock(idx, msg);
    } else {
        const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
        if (el && ctx.messageFormatting) el.innerHTML = ctx.messageFormatting(newText, msg.name, msg.is_system, msg.is_user, idx);
    }

    if (ctx.eventSource && ctx.event_types?.MESSAGE_UPDATED) {
        ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
    }
    if (!skipSave) {
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        } else if (typeof ctx.saveChatConditional === 'function') {
            await ctx.saveChatConditional();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
        }
    }
}

export function getSearchableText(msg) {
    if (!wsSettings.translationSearchEnabled) return msg.mes;
    return msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? msg.mes;
}

let _scrollTaskToken = 0;
let _loadMessagesChain = Promise.resolve();

function isLoadBtnUsable(lb) {
    if (!lb || lb.disabled || lb.style?.display === 'none') return false;
    try {
        const cs = getComputedStyle(lb);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch { }
    return true;
}

function getFirstDisplayedMesId(chatEl) {
    const raw = chatEl?.querySelector('.mes[mesid]')?.getAttribute('mesid');
    if (raw == null || raw === '') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
}

function nextFrame() {
    return new Promise(r => {
        if (typeof requestAnimationFrame === 'function') {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; r(); } }, 50);
            requestAnimationFrame(() => { if (!done) { done = true; clearTimeout(t); r(); } });
        } else {
            setTimeout(r, 16);
        }
    });
}

function waitOneBatchLoaded(chatEl, lb, batchTimeoutMs = 2000) {
    return new Promise(resolve => {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
        const es = ctx?.eventSource;
        const evt = ctx?.event_types?.MORE_MESSAGES_LOADED;
        const hasEvent = !!(es && evt && typeof es.on === 'function');
        let settled = false;
        let obs = null;
        let domIdleTimer = null;
        let hardTimer = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            obs?.disconnect();
            if (domIdleTimer) clearTimeout(domIdleTimer);
            if (hardTimer) clearTimeout(hardTimer);
            if (hasEvent) {
                try {
                    if (typeof es.removeListener === 'function') es.removeListener(evt, finish);
                    else if (typeof es.off === 'function') es.off(evt, finish);
                } catch { }
            }
            resolve();
        };

        if (hasEvent) {
            try { es.on(evt, finish); } catch { }
        }

        if (typeof MutationObserver === 'function') {
            obs = new MutationObserver(() => {
                if (domIdleTimer) clearTimeout(domIdleTimer);
                domIdleTimer = setTimeout(finish, hasEvent ? 350 : 25);
            });
            obs.observe(chatEl, { childList: true });
        }

        hardTimer = setTimeout(finish, batchTimeoutMs);
        lb.click();
    });
}

/**
 * #show_more_messages 배치를 겹치지 않게 순차 로드해 predicate가 true가 될 때까지 대기.
 * (/goto, /move 등이 동시에 여러 번 클릭해 ST 레이아웃·이벤트가 꼬이는 문제 방지)
 */
export function loadMessagesUntil(predicate, options = {}) {
    const {
        maxBatches = 200,
        timeoutMs = 15000,
        batchTimeoutMs = 2000,
        isCancelled = null,
    } = options;

    try { if (predicate()) return Promise.resolve(true); } catch { return Promise.resolve(false); }

    const run = _loadMessagesChain.then(async () => {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return false;
        const startedAt = Date.now();
        let stagnantCount = 0;

        for (let batch = 0; batch < maxBatches; batch++) {
            if (isCancelled?.() || !chatEl.isConnected) return false;
            if (predicate()) return true;
            if (Date.now() - startedAt >= timeoutMs) break;

            const lb = document.getElementById('show_more_messages');
            if (!isLoadBtnUsable(lb)) break;

            const prevFirst = getFirstDisplayedMesId(chatEl);
            const prevCount = chatEl.querySelectorAll('.mes').length;

            await waitOneBatchLoaded(chatEl, lb, batchTimeoutMs);
            await nextFrame();

            if (isCancelled?.() || !chatEl.isConnected) return false;
            if (predicate()) return true;

            const curFirst = getFirstDisplayedMesId(chatEl);
            const curCount = chatEl.querySelectorAll('.mes').length;
            if (curFirst === prevFirst && curCount === prevCount) {
                stagnantCount++;
                if (stagnantCount >= 2) break;
            } else {
                stagnantCount = 0;
            }
        }
        return !!(!isCancelled?.() && predicate());
    });

    _loadMessagesChain = run.catch(() => false);
    return run;
}

export function loadAndScrollTo(idx) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const token = ++_scrollTaskToken;
    const isCancelled = () => token !== _scrollTaskToken || !chatEl.isConnected;
    const findMes = () => chatEl.querySelector(`[mesid="${idx}"]`);
    const scrollTarget = el => {
        if (!el?.isConnected || isCancelled()) return;
        el.scrollIntoView({ block: 'start', behavior: 'auto' });
    };

    const immediate = findMes();
    if (immediate) { scrollTarget(immediate); return; }

    loadMessagesUntil(() => !!findMes(), {
        maxBatches: 200,
        timeoutMs: 25000,
        isCancelled,
    }).then(found => {
        if (isCancelled()) return;
        const target = found ? findMes() : null;
        if (target) {
            scrollTarget(target);
            requestAnimationFrame(() => {
                if (!isCancelled() && target.isConnected) scrollTarget(target);
            });
        } else if (!isLoadBtnUsable(document.getElementById('show_more_messages'))) {
            chatEl.scrollTo({ top: 0 });
        }
    });
}

export async function copyText(text, showToast = true) {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); ok = true; } catch { } }
    if (!ok) {
        let ta = null;
        try {
            ta = Object.assign(document.createElement('textarea'), { value: text });
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
            document.body.appendChild(ta); ta.focus(); ta.select();
            ok = document.execCommand('copy');
        } catch { } finally {
            if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
        }
    }
    if (showToast) {
        if (ok) toastr.info('Copied!', '', { timeOut: 1500 });
        else toastr.error('Clipboard 접근이 거부되었습니다.', '', { timeOut: 2000 });
    }
    return ok;
}

export async function copyFullChat(stripText, getText = null) {
    const chat = getChat(), ctx = SillyTavern.getContext(), lines = [];
    if (!Array.isArray(chat)) return;
    for (const msg of chat) {
        if (!msg) continue;
        const raw = getText ? getText(msg) : msg.mes;
        lines.push(`${msg.name || (msg.is_user ? ctx.name1 : ctx.name2)}: ${stripText(raw)}`);
    }
    if (!lines.length) return;
    await copyText(lines.join('\n\n\n'));
}

// ── 편집모드 설정 (localStorage, 기기별) ──────────────────────────────────────
import { hexAlphaToRgba } from './utils.js';

const WS_SETTINGS_KEY = 'ws-edit-settings';
const WS_DEFAULT_HL_RGB = '#b1e0b3', WS_DEFAULT_HL_ALPHA = 90;
const WS_DEFAULT_HL_CUR_RGB = '#000000', WS_DEFAULT_HL_CUR_ALPHA = 75;
export const WS_DEFAULT_HL_POSITION_PERCENT = 17;

const WS_DEFAULT_STICKY_RGB = '#FEF2B5', WS_DEFAULT_STICKY_ALPHA = 100;
const WS_DEFAULT_INDEX_RGB = '#FF3399', WS_DEFAULT_INDEX_ALPHA = 90;

function defaultStickyUI() {
    return {
        rgb: WS_DEFAULT_STICKY_RGB, alpha: WS_DEFAULT_STICKY_ALPHA,
        left: null, top: null, width: null, height: null, scrollTop: 0, open: false,
    };
}

function createDefaultWsSettings() {
    return {
        hlEnabled: false, hlRgb: WS_DEFAULT_HL_RGB, hlAlpha: WS_DEFAULT_HL_ALPHA,
        hlCurEnabled: false, hlCurRgb: WS_DEFAULT_HL_CUR_RGB, hlCurAlpha: WS_DEFAULT_HL_CUR_ALPHA,
        hlPositionEnabled: false, hlPositionPercent: WS_DEFAULT_HL_POSITION_PERCENT,
        undoSlots: 0,
        indexRgb: WS_DEFAULT_INDEX_RGB, indexAlpha: WS_DEFAULT_INDEX_ALPHA, indexFontColor: '',
        usdKrwRate: 1420, gbpKrwRate: 1950,
        enhancedDelete: false,
        ignoreReasoningBlocks: false,
        translationSearchEnabled: false,
        sticky: defaultStickyUI(),
    };
}

function loadWsSettings() {
    const validHex = (v, def) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())) ? v.trim() : def;
    const validAlpha = (v, def) => (typeof v === 'number' && Number.isFinite(v)) ? Math.min(100, Math.max(0, v)) : def;
    const validPosNum = (v, def) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : def;
    const validOptNum = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const fallback = createDefaultWsSettings();
    try {
        const raw = localStorage.getItem(WS_SETTINGS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
            hlEnabled: !!parsed.hlEnabled,
            hlRgb: validHex(parsed.hlRgb, WS_DEFAULT_HL_RGB),
            hlAlpha: validAlpha(parsed.hlAlpha, WS_DEFAULT_HL_ALPHA),
            hlCurEnabled: !!parsed.hlCurEnabled,
            hlCurRgb: validHex(parsed.hlCurRgb, WS_DEFAULT_HL_CUR_RGB),
            hlCurAlpha: validAlpha(parsed.hlCurAlpha, WS_DEFAULT_HL_CUR_ALPHA),
            hlPositionEnabled: !!parsed.hlPositionEnabled,
            hlPositionPercent: (typeof parsed.hlPositionPercent === 'number' && Number.isFinite(parsed.hlPositionPercent) && parsed.hlPositionPercent >= 0 && parsed.hlPositionPercent <= 100)
                ? parsed.hlPositionPercent : WS_DEFAULT_HL_POSITION_PERCENT,
            undoSlots: (typeof parsed.undoSlots === 'number' && Number.isFinite(parsed.undoSlots) && parsed.undoSlots >= 0 && parsed.undoSlots <= 5) ? Math.floor(parsed.undoSlots) : 0,
            indexRgb: validHex(parsed.indexRgb, WS_DEFAULT_INDEX_RGB),
            indexAlpha: validAlpha(parsed.indexAlpha, WS_DEFAULT_INDEX_ALPHA),
            indexFontColor: typeof parsed.indexFontColor === 'string' ? parsed.indexFontColor.trim() : '',
            usdKrwRate: validPosNum(parsed.usdKrwRate, 1420),
            gbpKrwRate: validPosNum(parsed.gbpKrwRate, 1950),
            enhancedDelete: !!parsed.enhancedDelete,
            ignoreReasoningBlocks: !!parsed.ignoreReasoningBlocks,
            translationSearchEnabled: !!parsed.translationSearchEnabled,
            sticky: {
                rgb: validHex(parsed.sticky?.rgb, WS_DEFAULT_STICKY_RGB),
                alpha: validAlpha(parsed.sticky?.alpha, WS_DEFAULT_STICKY_ALPHA),
                left: validOptNum(parsed.sticky?.left),
                top: validOptNum(parsed.sticky?.top),
                width: validOptNum(parsed.sticky?.width),
                height: validOptNum(parsed.sticky?.height),
                scrollTop: (typeof parsed.sticky?.scrollTop === 'number' && Number.isFinite(parsed.sticky.scrollTop) && parsed.sticky.scrollTop >= 0) ? parsed.sticky.scrollTop : 0,
                open: !!parsed.sticky?.open,
            },
        };
    } catch { return fallback; }
}

export const wsSettings = loadWsSettings();

export function saveWsSettings() {
    try { localStorage.setItem(WS_SETTINGS_KEY, JSON.stringify(wsSettings)); } catch { }
}

export function resetSlashieLocalStorage() {
    let removedCount = 0;
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key === WS_SETTINGS_KEY || key === 'slashie_undo_history' || key.startsWith('ws-hidden-pin-')) {
                localStorage.removeItem(key);
                removedCount++;
            }
        }
    } catch { }
    Object.assign(wsSettings, createDefaultWsSettings());
    applyWsHlColor();
    applyWsHlCurColor();
    applyWsIndexColor();
    return removedCount;
}

const WS_DEFAULT_HL_COLOR = hexAlphaToRgba(WS_DEFAULT_HL_RGB, WS_DEFAULT_HL_ALPHA);
const WS_DEFAULT_HL_CUR_COLOR = hexAlphaToRgba(WS_DEFAULT_HL_CUR_RGB, WS_DEFAULT_HL_CUR_ALPHA);

export function applyWsHlColor() {
    const color = wsSettings.hlEnabled ? hexAlphaToRgba(wsSettings.hlRgb, wsSettings.hlAlpha) : WS_DEFAULT_HL_COLOR;
    document.documentElement.style.setProperty('--ws-hl-color', color);
}

export function applyWsHlCurColor() {
    const color = wsSettings.hlCurEnabled ? hexAlphaToRgba(wsSettings.hlCurRgb, wsSettings.hlCurAlpha) : WS_DEFAULT_HL_CUR_COLOR;
    document.documentElement.style.setProperty('--ws-hl-cur-bg', color);
}

export function applyWsIndexColor() {
    document.documentElement.style.setProperty('--ws-index-bg', hexAlphaToRgba(wsSettings.indexRgb, wsSettings.indexAlpha));
    document.documentElement.style.setProperty('--ws-index-font', wsSettings.indexFontColor || 'var(--ws-text)');
}

// ── 패널 z-index 관리 (MRU 순서 기반) ─────────────────────────────────────────
function makeRaiser(base) {
    const order = [];
    return function raise(panel) {
        const i = order.indexOf(panel);
        if (i !== -1) order.splice(i, 1);
        order.push(panel);
        for (let idx = order.length - 1; idx >= 0; idx--) {
            if (!order[idx].isConnected) order.splice(idx, 1);
        }
        order.forEach((p, idx) => p.style.setProperty('z-index', String(base + idx), 'important'));
    };
}

export const raiseToTop = makeRaiser(3000);
export const raiseToTopHigh = makeRaiser(999995);

// ── /move 스냅샷 ───────────────────────────────────────────────────────────
let _moveSnapshot = null;
export function getMoveSnapshot() { return _moveSnapshot; }
export function setMoveSnapshot(v) { _moveSnapshot = v; }

export function initMoveSnapshotClearing() {
    const _ctx0 = SillyTavern.getContext();
    const _evtR = _ctx0.event_types?.MESSAGE_RECEIVED ?? 'message_received';
    const _evtS = _ctx0.event_types?.MESSAGE_SENT ?? 'message_sent';
    const _evtD = _ctx0.event_types?.MESSAGE_DELETED ?? 'message_deleted';
    const _evtC = _ctx0.event_types?.CHAT_CHANGED ?? 'chat_id_changed';
    const _evtL = _ctx0.event_types?.CHAT_LOADED ?? 'chatLoaded';
    if (window._wsClearSnapshot) {
        _ctx0.eventSource?.removeListener?.(_evtR, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtS, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtD, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtC, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtL, window._wsClearSnapshot);
    }
    window._wsClearSnapshot = () => { _moveSnapshot = null; };
    _ctx0.eventSource?.on?.(_evtR, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtS, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtD, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtC, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtL, window._wsClearSnapshot);
}

// ── 드래그 선택 텍스트 상태 공유 ──────────────────────────────────────────────
let _lastChatSelection = '';
let _lastChatSelectionTime = 0;

export function setLastChatSelection(text) {
    if (typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed) {
            _lastChatSelection = trimmed;
            _lastChatSelectionTime = Date.now();
            window._wsLastChatSelection = trimmed;
            window._wsLastChatSelectionTime = Date.now();
            window._wsActiveDragText = trimmed;
        }
    }
}

export function clearLastChatSelection() {
    _lastChatSelection = '';
    _lastChatSelectionTime = 0;
    try {
        delete window._wsLastChatSelection;
        delete window._wsLastChatSelectionTime;
        delete window._wsActiveDragText;
    } catch { }
}

export function getLastChatSelection(maxAgeMs = 2000) {
    const sel = window.getSelection();
    const selText = sel?.toString()?.trim();
    if (selText && sel.rangeCount > 0 && !sel.isCollapsed) {
        const inChat = document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer);
        if (inChat) {
            setLastChatSelection(selText);
            return selText;
        }
    }
    const text = window._wsLastChatSelection || window._wsActiveDragText || _lastChatSelection;
    const time = window._wsLastChatSelectionTime || _lastChatSelectionTime;
    if (text && (Date.now() - time < maxAgeMs)) {
        return text;
    }
    return '';
}


