// ─── undo-manager.js ────────────────────────────────────────────────────────
// 메시지 수정 및 삭제 내역을 실시간 캡처하여 ST user/files(slashie-undo-history.json)에 저장하고,
// /ctrlz (수정/삭제 내역 뷰어 및 선택 복원)를 제공합니다.

import { createPanel, getPanelBody, closePanel } from './panel-ui.js';
import { getChat, wsSettings, saveWsSettings } from './state.js';
import { escapeHTML } from './utils.js';

const UNDO_FILE_NAME = 'slashie-undo-history.json';
const UNDO_FILE_PATH = `user/files/${UNDO_FILE_NAME}`;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let _undoHistory = [];
let _isLoaded = false;
let _loadPromise = null;
let _persistQueue = Promise.resolve();
let _serverFileExists = null;
let _pendingDeleteContext = null;
let _isRestoring = false;
let _isRestoreBusy = false;
let _lastChatSnapshot = [];

// 메시지 상태 캐시 (mesId -> 마지막 확인된 mes 텍스트)
const _chatBaseline = new Map();
const _editingInitialText = new Map();

function normalizeForCompare(str) {
    return String(str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

// ── 24시간 만료 체크 ────────────────────────────────────────────────────────
function pruneExpiredSnapshots() {
    if (!Array.isArray(_undoHistory) || !_undoHistory.length) return;
    _undoHistory = _undoHistory.filter(item => item && typeof item === 'object');
    if (!_undoHistory.length) return;
    const now = Date.now();
    for (const item of _undoHistory) {
        if (typeof item.timestamp !== 'number' || isNaN(item.timestamp) || item.timestamp <= 0) {
            item.timestamp = now;
        }
    }
    const newest = _undoHistory[0];
    if (newest && (now - newest.timestamp > TWENTY_FOUR_HOURS_MS)) {
        _undoHistory = [];
        return;
    }
    _undoHistory = _undoHistory.filter(item => (now - item.timestamp) <= TWENTY_FOUR_HOURS_MS);
}

// ── 영구 저장소 (ST user/files/slashie-undo-history.json) ──────────────────
function getAuthHeaders(ctx) {
    return typeof ctx?.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
}

async function checkUndoFileExists(ctx) {
    try {
        const res = await fetch('/api/files/verify', {
            method: 'POST',
            headers: getAuthHeaders(ctx),
            body: JSON.stringify({ urls: [UNDO_FILE_PATH] }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return !!data?.[UNDO_FILE_PATH];
    } catch {
        return null;
    }
}

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

async function writeUndoHistoryFile() {
    pruneExpiredSnapshots();
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    if (!ctx) return;

    if (!_undoHistory.length) {
        if (_serverFileExists === false) return;
        try {
            const res = await fetch('/api/files/delete', {
                method: 'POST',
                headers: getAuthHeaders(ctx),
                body: JSON.stringify({ path: UNDO_FILE_PATH }),
            });
            if (res.ok || res.status === 404) {
                _serverFileExists = false;
            }
        } catch (err) {
            console.warn('[Slashie Undo] File delete error:', err);
        }
        return;
    }

    try {
        const base64Data = encodeBase64Utf8(JSON.stringify(_undoHistory, null, 2));
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getAuthHeaders(ctx),
            body: JSON.stringify({
                name: UNDO_FILE_NAME,
                data: base64Data,
            }),
        });
        if (res.ok) {
            _serverFileExists = true;
        } else {
            console.warn('[Slashie Undo] File upload failed:', res.status);
        }
    } catch (err) {
        console.warn('[Slashie Undo] File upload error:', err);
    }
}

async function loadUndoHistory() {
    if (_isLoaded) return _undoHistory;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
        let loadedCount = 0;
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
        if (ctx) {
            const exists = await checkUndoFileExists(ctx);
            _serverFileExists = exists;
            if (exists === true) {
                try {
                    const res = await fetch(`/${UNDO_FILE_PATH}?t=${Date.now()}`, { cache: 'no-store' });
                    if (res.ok) {
                        const parsed = await res.json();
                        if (Array.isArray(parsed)) {
                            _undoHistory = parsed;
                            loadedCount = parsed.length;
                        }
                    }
                } catch (e) {
                    console.warn('[Slashie Undo] Failed to read undo file:', e);
                }
            }
        }
        pruneExpiredSnapshots();
        if (_undoHistory.length !== loadedCount) {
            await writeUndoHistoryFile();
        }
        _isLoaded = true;
        return _undoHistory;
    })().finally(() => {
        _loadPromise = null;
    });

    return _loadPromise;
}

function saveUndoHistory() {
    _persistQueue = _persistQueue
        .then(() => writeUndoHistoryFile())
        .catch(err => console.warn('[Slashie Undo] Save error:', err));
    return _persistQueue;
}

function getMaxUndoSlots() {
    const rawSlots = Number(wsSettings?.undoSlots);
    return (Number.isFinite(rawSlots) && rawSlots >= 0 && rawSlots <= 5) ? Math.floor(rawSlots) : 0;
}

function pushUndoSnapshot(snapshot, isDuplicateFn = null) {
    if (getMaxUndoSlots() === 0 || !snapshot) return;
    _persistQueue = _persistQueue.then(async () => {
        await loadUndoHistory();
        pruneExpiredSnapshots();
        const maxSlots = getMaxUndoSlots();
        if (maxSlots === 0) return;
        if (isDuplicateFn && _undoHistory.length > 0 && isDuplicateFn(_undoHistory[0])) return;

        _undoHistory.unshift(snapshot);
        if (_undoHistory.length > maxSlots) {
            _undoHistory = _undoHistory.slice(0, maxSlots);
        }

        await writeUndoHistoryFile();

        const panel = document.getElementById('ws-ctrlzviewer-panel');
        if (panel && typeof panel._wsRender === 'function') {
            panel._wsRender();
        }
    }).catch(err => console.warn('[Slashie Undo] Snapshot record error:', err));
}

// ── 텍스트 수정 스냅샷 기록 ──────────────────────────────────────────────────
function recordUndoSnapshot({ mesId, beforeText, afterText, isTranslation = false, name = '', isUser = false, swipeId = undefined }) {
    if (getMaxUndoSlots() === 0) return;

    // 변경 없음 필터링
    if (normalizeForCompare(beforeText) === normalizeForCompare(afterText)) return;

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const chatId = ctx?.chatId || ctx?.characterId || 'default';
    const now = Date.now();

    const snapshot = {
        id: `undo_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'edit',
        timestamp: now,
        chatId,
        mesId: Number(mesId),
        name: name || (isUser ? 'User' : 'Character'),
        isUser: !!isUser,
        isTranslation: !!isTranslation,
        swipeId: typeof swipeId === 'number' ? swipeId : undefined,
        beforeText: String(beforeText ?? ''),
        afterText: String(afterText ?? ''),
    };

    if (!isTranslation && !isNaN(Number(mesId))) {
        const afterStr = String(afterText ?? '');
        _chatBaseline.set(Number(mesId), afterStr);
        _editingInitialText.set(Number(mesId), afterStr);
    }

    pushUndoSnapshot(snapshot, last => (
        last.type === 'edit' &&
        last.mesId === snapshot.mesId &&
        normalizeForCompare(last.beforeText) === normalizeForCompare(snapshot.beforeText) &&
        normalizeForCompare(last.afterText) === normalizeForCompare(snapshot.afterText) &&
        (now - last.timestamp < 1500)
    ));
}

// ── 단일 메시지 전체 삭제 스냅샷 기록 ───────────────────────────────────────
function recordDeleteSnapshot({ mesId, msg }) {
    if (getMaxUndoSlots() === 0 || !msg) return;

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const chatId = ctx?.chatId || ctx?.characterId || 'default';
    const now = Date.now();

    const snapshot = {
        id: `undo_del_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'deleted_message',
        timestamp: now,
        chatId,
        mesId: Number(mesId),
        name: msg.name || (msg.is_user ? 'User' : 'Character'),
        isUser: !!msg.is_user,
        isTranslation: false,
        messageData: JSON.parse(JSON.stringify(msg)),
        beforeText: String(msg.mes || ''),
        afterText: '',
    };

    pushUndoSnapshot(snapshot);
}

// ── 단일 스와이프 삭제 스냅샷 기록 ──────────────────────────────────────────
function recordDeleteSwipeSnapshot({ mesId, deletedSwipeText, name = '', isUser = false }) {
    if (getMaxUndoSlots() === 0 || !deletedSwipeText) return;

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const chatId = ctx?.chatId || ctx?.characterId || 'default';
    const now = Date.now();

    const snapshot = {
        id: `undo_delswipe_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'deleted_swipe',
        timestamp: now,
        chatId,
        mesId: Number(mesId),
        name: name || (isUser ? 'User' : 'Character'),
        isUser: !!isUser,
        deletedSwipeText: String(deletedSwipeText || ''),
        beforeText: String(deletedSwipeText || ''),
        afterText: '',
    };

    pushUndoSnapshot(snapshot);
}

if (typeof window !== 'undefined') {
    window._slashieRecordUndo = recordUndoSnapshot;
}

// ── 되돌리기 실행 ───────────────────────────────────────────────────────────
let _restoreResetTimer = null;

async function removeSnapshotAndSave(snapshotId) {
    const fIdx = _undoHistory.findIndex(s => s.id === snapshotId);
    if (fIdx !== -1) {
        _undoHistory.splice(fIdx, 1);
        await saveUndoHistory();
    }
}

async function restoreSnapshot(snapshot) {
    if (!snapshot || _isRestoreBusy) return false;
    const ctxPre = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    if (!ctxPre) return false;
    const currentChatId = ctxPre.chatId || ctxPre.characterId || 'default';
    if (snapshot.chatId && snapshot.chatId !== currentChatId) {
        toastr.warning('다른 채팅방의 기록입니다.', '', { timeOut: 3000 });
        return false;
    }
    if (_restoreResetTimer) {
        clearTimeout(_restoreResetTimer);
        _restoreResetTimer = null;
    }
    _isRestoreBusy = true;
    _isRestoring = true;
    try {
        const ctx = ctxPre;

        const chat = getChat();
        const idx = snapshot.mesId;

        // ── A) 단일 메시지 전체 삭제 복구 ──
        if (snapshot.type === 'deleted_message') {
            if (!chat || !snapshot.messageData) {
                toastr.warning('되돌릴 메시지를 찾을 수 없습니다.', '', { timeOut: 3000 });
                return false;
            }
            const targetIdx = Math.max(0, Math.min(idx, chat.length));
            const restoredMsg = JSON.parse(JSON.stringify(snapshot.messageData));
            chat.splice(targetIdx, 0, restoredMsg);

            _chatBaseline.set(targetIdx, restoredMsg.mes);
            _editingInitialText.set(targetIdx, restoredMsg.mes);

            try {
                if (typeof ctx.saveChat === 'function') await ctx.saveChat();
                else if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
            } catch (saveErr) {
                console.warn('[Slashie Undo] saveChat error:', saveErr);
            }

            try {
                if (typeof ctx.reloadCurrentChat === 'function') {
                    await ctx.reloadCurrentChat();
                }
            } catch (reloadErr) {
                console.warn('[Slashie Undo] reloadCurrentChat error:', reloadErr);
            }

            syncAllBaselines();

            await removeSnapshotAndSave(snapshot.id);

            toastr.success(`#${idx} 메시지를 복구했습니다.`, '');
            return true;
        }

        // Restore deleted swipe
        if (snapshot.type === 'deleted_swipe') {
            const msg = chat?.[idx];
            if (!msg) {
                toastr.warning('되돌릴 메시지를 찾을 수 없습니다.', '', { timeOut: 3000 });
                return false;
            }

            if (!Array.isArray(msg.swipes)) {
                msg.swipes = [msg.mes];
            }

            // 맨 마지막 스와이프로 추가 (ST swipe_info 배열 길이 동기화 포함)
            msg.swipes.push(snapshot.deletedSwipeText);
            if (!Array.isArray(msg.swipe_info) && !msg.is_user && !msg.extra?.isSmallSys) {
                msg.swipe_info = [];
            }
            if (Array.isArray(msg.swipe_info)) {
                while (msg.swipe_info.length < msg.swipes.length) {
                    msg.swipe_info.push({
                        send_date: msg.send_date,
                        gen_started: msg.gen_started,
                        gen_finished: msg.gen_finished,
                        extra: {},
                    });
                }
            }
            msg.swipe_id = msg.swipes.length - 1;
            msg.mes = snapshot.deletedSwipeText;

            _chatBaseline.set(idx, msg.mes);
            _editingInitialText.set(idx, msg.mes);

            if (typeof ctx.updateMessageBlock === 'function') {
                ctx.updateMessageBlock(idx, msg);
            }

            if (ctx.eventSource && ctx.event_types?.MESSAGE_UPDATED) {
                await ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
            }

            try {
                if (typeof ctx.saveChat === 'function') await ctx.saveChat();
                else if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
            } catch (saveErr) {
                console.warn('[Slashie Undo] saveChat error:', saveErr);
            }

            syncAllBaselines();

            await removeSnapshotAndSave(snapshot.id);

            toastr.success(`#${idx} 삭제된 스와이프를 복구했습니다.`, '');
            return true;
        }

        // ── C) 텍스트 수정 되돌리기 ──
        const msg = chat?.[idx];
        if (!msg) {
            toastr.warning('되돌릴 메시지를 찾을 수 없습니다.', '', { timeOut: 3000 });
            return false;
        }

        if (snapshot.isTranslation) {
            const targetSwipeId = typeof snapshot.swipeId === 'number' ? snapshot.swipeId : msg.swipe_id;
            const syncSwipeInfoExtra = (sid) => {
                const swipeExtra = sid !== undefined ? msg.swipe_info?.[sid]?.extra : null;
                if (swipeExtra && typeof swipeExtra === 'object') {
                    swipeExtra.display_text = snapshot.beforeText;
                    if (swipeExtra.magic_translation) {
                        swipeExtra.magic_translation.translatedText = snapshot.beforeText;
                    }
                }
            };
            if (typeof snapshot.swipeId === 'number' && typeof msg.swipe_id === 'number' && msg.swipe_id !== snapshot.swipeId) {
                const hasSwipeTrans = !!(msg.extra?.swipe_translations?.[snapshot.swipeId] || msg.swipe_info?.[snapshot.swipeId]?.extra);
                if (hasSwipeTrans) {
                    if (msg.extra?.swipe_translations?.[snapshot.swipeId]) {
                        msg.extra.swipe_translations[snapshot.swipeId].display_text = snapshot.beforeText;
                    }
                    syncSwipeInfoExtra(snapshot.swipeId);
                } else {
                    toastr.warning('현재 스와이프가 달라 복구할 수 없습니다.');
                    return false;
                }
            } else {
                if (!msg.extra) msg.extra = {};
                msg.extra.display_text = snapshot.beforeText;
                if (targetSwipeId !== undefined && msg.extra.swipe_translations?.[targetSwipeId]) {
                    msg.extra.swipe_translations[targetSwipeId].display_text = snapshot.beforeText;
                }
                if (msg.extra.magic_translation) {
                    msg.extra.magic_translation.translatedText = snapshot.beforeText;
                }
                syncSwipeInfoExtra(targetSwipeId);
            }
        } else {
            if (typeof snapshot.swipeId === 'number' && snapshot.swipeId >= 0) {
                if (Array.isArray(msg.swipes) && snapshot.swipeId < msg.swipes.length) {
                    msg.swipes[snapshot.swipeId] = snapshot.beforeText;
                    msg.swipe_id = snapshot.swipeId;
                } else if (Array.isArray(msg.swipes) && msg.swipes.length > 0) {
                    toastr.warning('해당 스와이프가 삭제되어 복구할 수 없습니다.');
                    return false;
                }
            }
            msg.mes = snapshot.beforeText;
        }

        _chatBaseline.set(idx, msg.mes);
        _editingInitialText.set(idx, msg.mes);

        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(idx, msg);
        } else {
            const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
            if (el && ctx.messageFormatting) {
                const txt = snapshot.isTranslation ? (msg.extra?.display_text || msg.mes) : msg.mes;
                el.innerHTML = ctx.messageFormatting(txt, msg.name, msg.is_system, msg.is_user, idx);
            }
        }

        if (ctx.eventSource && ctx.event_types?.MESSAGE_UPDATED) {
            await ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
        }

        try {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            else if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
        } catch (saveErr) {
            console.warn('[Slashie Undo] saveChat error:', saveErr);
        }

        syncAllBaselines();

        await removeSnapshotAndSave(snapshot.id);

        toastr.success(`#${idx} 메시지를 되돌렸습니다.`, '');
        return true;
    } finally {
        _isRestoreBusy = false;
        _restoreResetTimer = setTimeout(() => { _isRestoring = false; _restoreResetTimer = null; }, 400);
    }
}

// ── LCS 토큰 Diff 및 하이라이팅 (/difference 스타일: 삭제 빨간색, 추가 초록색) ─
function tokenize(text) {
    return text.match(/[\s]+|[\w\uAC00-\uD7A3]+|[^\s\w\uAC00-\uD7A3]+/g) || [text];
}

function diffTokensUnified(beforeTokens, afterTokens) {
    const n = beforeTokens.length;
    const m = afterTokens.length;

    let prefix = 0;
    while (prefix < n && prefix < m && beforeTokens[prefix] === afterTokens[prefix]) prefix++;
    let suffix = 0;
    while (suffix < (n - prefix) && suffix < (m - prefix) && beforeTokens[n - 1 - suffix] === afterTokens[m - 1 - suffix]) suffix++;

    const head = beforeTokens.slice(0, prefix).map(t => ({ token: t, type: 'same' }));
    const tail = suffix > 0 ? beforeTokens.slice(n - suffix).map(t => ({ token: t, type: 'same' })) : [];
    const midB = beforeTokens.slice(prefix, n - suffix);
    const midA = afterTokens.slice(prefix, m - suffix);
    const mn = midB.length, mm = midA.length;

    if (mn === 0 && mm === 0) return head.concat(tail);
    if (mn > 65000 || mm > 65000 || mn * mm > 100000) {
        return head.concat(
            midB.map(t => ({ token: t, type: 'deleted' })),
            midA.map(t => ({ token: t, type: 'added' })),
            tail
        );
    }

    const dp = Array.from({ length: mn + 1 }, () => new Uint16Array(mm + 1));
    for (let i = 0; i < mn; i++) {
        for (let j = 0; j < mm; j++) {
            if (midB[i] === midA[j]) {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
    }

    let i = mn, j = mm;
    const midResult = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && midB[i - 1] === midA[j - 1]) {
            midResult.unshift({ token: midB[i - 1], type: 'same' });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            midResult.unshift({ token: midA[j - 1], type: 'added' });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            midResult.unshift({ token: midB[i - 1], type: 'deleted' });
            i--;
        }
    }
    return head.concat(midResult, tail);
}

function formatUnifiedDiffHtml(beforeText, afterText) {
    const beforeTokens = tokenize(beforeText);
    const afterTokens = tokenize(afterText);
    const diff = diffTokensUnified(beforeTokens, afterTokens);

    return diff.map(d => {
        const escaped = escapeHTML(d.token);
        if (d.type === 'deleted' && d.token.trim().length > 0) {
            return `<mark class="ws-diff-del" style="text-decoration:line-through;text-decoration-color:rgba(198,40,40,0.5);">${escaped}</mark>`;
        }
        if (d.type === 'added' && d.token.trim().length > 0) {
            return `<mark class="ws-diff-add">${escaped}</mark>`;
        }
        return escaped;
    }).join('');
}

// ─── /ctrlz 패널 UI (상단 우측에 0 / [드롭다운] 탑재) ─────────────────────────
export async function openCtrlZViewerPanel() {
    const PANEL_ID = 'ws-ctrlzviewer-panel';
    if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return; }
    await loadUndoHistory();
    if (document.getElementById(PANEL_ID)) return;
    pruneExpiredSnapshots();

    const panel = createPanel(PANEL_ID);
    const body = getPanelBody(panel);
    panel.style.width = '380px';

    function renderContent() {
        pruneExpiredSnapshots();
        body.innerHTML = '';

        const currentMax = getMaxUndoSlots();

        // 헤더 행: 타이틀 + "0 / [드롭다운]"
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'font-weight:600;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;';

        const titleSpan = document.createElement('span');
        titleSpan.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="margin-right:6px;"></i>메시지 수정 내역';

        const slotControl = document.createElement('div');
        slotControl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ws-text2);font-weight:normal;';

        const countSpan = document.createElement('span');
        countSpan.textContent = String(_undoHistory.length);

        const slashSpan = document.createElement('span');
        slashSpan.textContent = '/';

        const slotSelect = document.createElement('select');
        slotSelect.className = 'ws-range-input';
        slotSelect.style.cssText = 'width:34px;height:20px;padding:0;font-size:11px;border:1px solid var(--ws-border);border-radius:4px;background:var(--ws-panel3);color:var(--ws-text);text-align:center;text-align-last:center;cursor:pointer;outline:none;line-height:18px;';
        [0, 1, 2, 3, 4, 5].forEach(num => {
            const opt = document.createElement('option');
            opt.value = String(num);
            opt.textContent = String(num);
            if (num === currentMax) opt.selected = true;
            slotSelect.appendChild(opt);
        });

        slotSelect.addEventListener('change', () => {
            const val = parseInt(slotSelect.value, 10) || 0;
            wsSettings.undoSlots = val;
            saveWsSettings();
            if (_undoHistory.length > val) {
                _undoHistory = _undoHistory.slice(0, val);
                saveUndoHistory();
            }
            renderContent();
        });

        slotControl.appendChild(countSpan);
        slotControl.appendChild(slashSpan);
        slotControl.appendChild(slotSelect);

        headerRow.appendChild(titleSpan);
        headerRow.appendChild(slotControl);
        body.appendChild(headerRow);

        const hint = document.createElement('div');
        hint.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ws-text2);margin-bottom:10px;';
        hint.innerHTML = '<span class="ws-diff-pill-del">− 삭제</span><span class="ws-diff-pill-add">+ 추가</span>';
        body.appendChild(hint);

        if (!_undoHistory.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align:center;color:var(--ws-text2);font-size:12px;padding:32px 0;background:var(--ws-panel2);border-radius:8px;border:1px solid var(--ws-border);';
            empty.innerHTML = '<i class="fa-solid fa-clock-rotate-left" style="font-size:24px;margin-bottom:8px;display:block;opacity:0.4;"></i>저장된 데이터가 없습니다.';
            body.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'ws-thin-scroll';
        list.style.cssText = 'max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;';

        _undoHistory.forEach((item) => {
            const card = document.createElement('div');
            card.style.cssText = 'padding:10px 12px;border-radius:8px;background:var(--ws-panel2);border:1px solid var(--ws-border);display:flex;flex-direction:column;gap:8px;';

            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--ws-text2);';

            const dateStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const swipeLabel = typeof item.swipeId === 'number' ? ` <span style="opacity:0.7;">(S#${item.swipeId + 1})</span>` : '';

            if (item.type === 'deleted_message') {
                header.innerHTML = `<span style="font-weight:600;color:var(--ws-text);"><i class="fa-solid fa-trash-can" style="margin-right:4px;color:#c62828;"></i>#${item.mesId} ${escapeHTML(item.name)} <span style="color:#c62828;font-size:10.5px;font-weight:600;">(삭제)</span></span>` +
                    `<span>${dateStr}</span>`;
            } else if (item.type === 'deleted_swipe') {
                header.innerHTML = `<span style="font-weight:600;color:var(--ws-text);"><i class="fa-solid fa-trash-can" style="margin-right:4px;color:#b45309;"></i>#${item.mesId} ${escapeHTML(item.name)} <span style="color:#b45309;font-size:10.5px;font-weight:600;">(스와이프 삭제)</span></span>` +
                    `<span>${dateStr}</span>`;
            } else {
                header.innerHTML = `<span style="font-weight:600;color:var(--ws-text);"><i class="fa-solid fa-message" style="margin-right:4px;"></i>#${item.mesId} ${escapeHTML(item.name)}${swipeLabel}${item.isTranslation ? ' <span style="color:#15803d;">(번역)</span>' : ''}</span>` +
                    `<span>${dateStr}</span>`;
            }
            card.appendChild(header);

            const isDeletedItem = item.type === 'deleted_message' || item.type === 'deleted_swipe';
            const contentBox = document.createElement('div');
            contentBox.style.cssText = isDeletedItem
                ? 'font-size:12.5px;color:var(--ws-text);max-height:120px;overflow-y:auto;line-height:1.5;padding:6px 8px;background:#fff1f2;border-radius:6px;border:1px solid rgba(239,68,68,0.28);white-space:pre-wrap;word-break:break-word;'
                : 'font-size:12.5px;color:var(--ws-text);max-height:120px;overflow-y:auto;line-height:1.5;padding:6px 8px;background:var(--ws-panel);border-radius:6px;border:1px solid var(--ws-border);white-space:pre-wrap;word-break:break-word;';

            if (isDeletedItem) {
                contentBox.textContent = item.beforeText;
            } else {
                contentBox.innerHTML = formatUnifiedDiffHtml(item.beforeText, item.afterText);
            }
            card.appendChild(contentBox);

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:2px;';

            const delBtn = document.createElement('button');
            delBtn.className = 'ws-btn';
            delBtn.style.cssText = 'padding:4px 8px;font-size:11.5px;display:flex;align-items:center;background:var(--ws-panel3);color:var(--ws-text2);cursor:pointer;';
            delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            delBtn.title = '이 기록 삭제';
            delBtn.addEventListener('click', () => {
                const fIdx = _undoHistory.findIndex(s => s.id === item.id);
                if (fIdx !== -1) {
                    _undoHistory.splice(fIdx, 1);
                    saveUndoHistory();
                    renderContent();
                }
            });

            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'ws-btn';
            restoreBtn.style.cssText = 'padding:4px 10px;font-size:11.5px;display:flex;align-items:center;gap:5px;background:var(--ws-panel3);cursor:pointer;';
            restoreBtn.innerHTML = (item.type === 'deleted_message' || item.type === 'deleted_swipe')
                ? '<i class="fa-solid fa-clock-rotate-left"></i> 복구'
                : '<i class="fa-solid fa-clock-rotate-left"></i> 되돌리기';
            restoreBtn.addEventListener('click', async () => {
                restoreBtn.disabled = true;
                try {
                    const ok = await restoreSnapshot(item);
                    if (ok) renderContent();
                } finally {
                    if (restoreBtn.isConnected) restoreBtn.disabled = false;
                }
            });

            btnRow.appendChild(delBtn);
            btnRow.appendChild(restoreBtn);
            card.appendChild(btnRow);
            list.appendChild(card);
        });

        body.appendChild(list);
    }

    panel._wsRender = renderContent;
    renderContent();
}

// ── 핵심 실시간 감지 엔진 (State-Diffing Engine) ───────────────────────────
let _watcherInited = false;

function buildChatSnapshot(chat) {
    if (!Array.isArray(chat)) return [];
    return chat.map(msg => msg ? {
        ref: msg,
        name: msg.name,
        is_user: !!msg.is_user,
        swipes: Array.isArray(msg.swipes) ? msg.swipes.slice() : [msg.mes ?? ''],
    } : null);
}

export function syncAllBaselines() {
    const chat = getChat();
    if (!Array.isArray(chat)) return;
    _chatBaseline.clear();
    _editingInitialText.clear();
    chat.forEach((msg, idx) => {
        if (msg) {
            _chatBaseline.set(idx, msg.mes);
            _editingInitialText.set(idx, msg.mes);
        }
    });
    _lastChatSnapshot = buildChatSnapshot(chat);
}

export function initUndoWatcher() {
    if (_watcherInited) return;
    _watcherInited = true;

    loadUndoHistory();
    syncAllBaselines();

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;

    // A) 채팅방 전환 / 로드 / 스와이프 / 새 메시지 시 베이스라인 갱신
    const evtChatChanged = ctx?.event_types?.CHAT_CHANGED ?? 'chat_id_changed';
    const evtChatLoaded = ctx?.event_types?.CHAT_LOADED ?? 'chatLoaded';
    const evtReceived = ctx?.event_types?.MESSAGE_RECEIVED ?? 'message_received';
    const evtSent = ctx?.event_types?.MESSAGE_SENT ?? 'message_sent';
    const evtSwiped = ctx?.event_types?.MESSAGE_SWIPED ?? 'message_swiped';

    if (ctx?.eventSource) {
        ctx.eventSource.on(evtChatChanged, () => {
            _chatBaseline.clear();
            _editingInitialText.clear();
            _pendingDeleteContext = null;
            syncAllBaselines();
        });
        ctx.eventSource.on(evtChatLoaded, () => {
            _editingInitialText.clear();
            syncAllBaselines();
        });
        ctx.eventSource.on(evtReceived, () => {
            syncAllBaselines();
        });
        ctx.eventSource.on(evtSent, () => {
            syncAllBaselines();
        });
        ctx.eventSource.on(evtSwiped, () => {
            _editingInitialText.clear();
            syncAllBaselines();
        });
    }

    // B) 메시지 편집 시작 캡처 (보조)
    const registerEditStart = (mesId) => {
        if (mesId === null || mesId === undefined || isNaN(Number(mesId))) return;
        const id = Number(mesId);
        const chat = getChat();
        const msg = chat?.[id];
        if (!msg) return;

        const currentText = msg.mes ?? '';
        _editingInitialText.set(id, currentText);
        if (!_chatBaseline.has(id)) {
            _chatBaseline.set(id, currentText);
        }
    };

    document.addEventListener('click', e => {
        const editBtn = e.target.closest?.('.mes_edit');
        if (editBtn) {
            const mesEl = editBtn.closest('.mes[mesid]');
            registerEditStart(mesEl?.getAttribute('mesid'));
        }
    }, true);

    document.addEventListener('focusin', e => {
        const ta = e.target.closest?.('.edit_textarea, #curEditTextarea, textarea[name="edit_textarea"]');
        if (ta) {
            const mesEl = ta.closest('.mes[mesid]');
            registerEditStart(mesEl?.getAttribute('mesid'));
        }
    }, true);

    // C) 공식 완료 버튼 클릭 시 즉시 캡처 (보조)
    document.addEventListener('click', e => {
        const doneBtn = e.target.closest?.('.mes_edit_done, .edit_done, #editor_done');
        if (!doneBtn) return;
        try {
            const mesEl = doneBtn.closest('.mes[mesid]');
            if (!mesEl) return;
            const mesId = Number(mesEl.getAttribute('mesid'));
            const ta = mesEl.querySelector('.edit_textarea, #curEditTextarea, textarea');
            const chat = getChat();
            const msg = chat?.[mesId];

            const beforeText = _editingInitialText.has(mesId) ? _editingInitialText.get(mesId) : _chatBaseline.get(mesId);
            const afterText = ta ? ta.value : msg?.mes;

            if (beforeText !== undefined && afterText !== undefined && normalizeForCompare(beforeText) !== normalizeForCompare(afterText)) {
                recordUndoSnapshot({
                    mesId,
                    beforeText,
                    afterText,
                    name: msg?.name,
                    isUser: !!msg?.is_user,
                    swipeId: msg?.swipe_id,
                });
                _chatBaseline.set(mesId, afterText);
                _editingInitialText.set(mesId, afterText);
            }
        } catch (err) {
            console.warn('[Slashie Undo] Edit done capture error:', err);
        }
    }, true);

    // D) Ctrl+Enter 완료 시 즉시 캡처 (보조)
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            const ta = e.target.closest?.('.edit_textarea, #curEditTextarea, textarea');
            if (!ta) return;
            try {
                const mesEl = ta.closest('.mes[mesid]');
                if (!mesEl) return;
                const mesId = Number(mesEl.getAttribute('mesid'));
                const chat = getChat();
                const msg = chat?.[mesId];

                const beforeText = _editingInitialText.has(mesId) ? _editingInitialText.get(mesId) : _chatBaseline.get(mesId);
                const afterText = ta.value;

                if (beforeText !== undefined && normalizeForCompare(beforeText) !== normalizeForCompare(afterText)) {
                    recordUndoSnapshot({
                        mesId,
                        beforeText,
                        afterText,
                        name: msg?.name,
                        isUser: !!msg?.is_user,
                        swipeId: msg?.swipe_id,
                    });
                    _chatBaseline.set(mesId, afterText);
                    _editingInitialText.set(mesId, afterText);
                }
            } catch (err) {
                console.warn('[Slashie Undo] Keydown capture error:', err);
            }
        }
    }, true);

    // E) ST MESSAGE_UPDATED 이벤트 수신
    if (ctx?.eventSource && ctx.event_types?.MESSAGE_UPDATED) {
        ctx.eventSource.on(ctx.event_types.MESSAGE_UPDATED, (mesId) => {
            const id = Number(mesId);
            if (isNaN(id)) return;
            const chat = getChat();
            const msg = chat?.[id];
            if (!msg) return;

            // 되돌리기 실행 중 발생한 이벤트는 신규 스냅샷 기록 제외 (루프 방지)
            if (_isRestoring) {
                _chatBaseline.set(id, msg.mes);
                _editingInitialText.set(id, msg.mes);
                return;
            }

            const beforeText = _editingInitialText.has(id) ? _editingInitialText.get(id) : _chatBaseline.get(id);
            const afterText = msg.mes;

            if (beforeText !== undefined && afterText !== undefined && normalizeForCompare(beforeText) !== normalizeForCompare(afterText)) {
                recordUndoSnapshot({
                    mesId: id,
                    beforeText,
                    afterText,
                    name: msg?.name,
                    isUser: !!msg?.is_user,
                    swipeId: msg?.swipe_id,
                });
            }

            _chatBaseline.set(id, afterText);
            _editingInitialText.set(id, afterText);
            if (chat) {
                _lastChatSnapshot = buildChatSnapshot(chat);
            }
        });
    }

    // F) 삭제 버튼 클릭/터치 시 메시지 원본 상태 임시 보관
    function capturePendingDelete(targetEl) {
        try {
            const delBtn = targetEl?.closest?.('.mes_edit_delete, .mes_delete, [data-action="delete"], .delete_message_button, .fa-trash, .fa-trash-can');
            if (!delBtn) return;
            const mesEl = delBtn.closest('.mes[mesid]');
            let mesId = mesEl ? mesEl.getAttribute('mesid') : null;
            if (mesId === null || mesId === undefined) {
                const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
                mesId = window.this_edit_mes_id ?? ctx?.this_edit_mes_id;
            }
            if (mesId === null || mesId === undefined) return;
            const id = Number(mesId);
            const chat = getChat();
            const msg = chat?.[id];
            if (!msg) return;

            _pendingDeleteContext = {
                mesId: id,
                msg: JSON.parse(JSON.stringify(msg)),
                swipes: Array.isArray(msg.swipes) ? msg.swipes.slice() : [msg.mes],
                name: msg.name,
                isUser: !!msg.is_user,
                timestamp: Date.now(),
            };
        } catch (err) {
            console.warn('[Slashie Undo] Delete button capture error:', err);
        }
    }
    document.addEventListener('pointerdown', e => capturePendingDelete(e.target), true);

    // G) ST 공식 이벤트: MESSAGE_SWIPE_DELETED (단일 스와이프 삭제 시)
    if (ctx?.eventSource && ctx.event_types?.MESSAGE_SWIPE_DELETED) {
        ctx.eventSource.on(ctx.event_types.MESSAGE_SWIPE_DELETED, (data) => {
            const messageId = Number(data?.messageId);
            const swipeId = Number(data?.swipeId);
            if (isNaN(messageId) || isNaN(swipeId)) return;

            const snapEntry = Array.isArray(_lastChatSnapshot) ? _lastChatSnapshot[messageId] : null;
            const pendingMatch = (_pendingDeleteContext && _pendingDeleteContext.mesId === messageId && (Date.now() - _pendingDeleteContext.timestamp < 60000))
                ? _pendingDeleteContext
                : null;

            let deletedText = '';
            if (pendingMatch && pendingMatch.swipes?.[swipeId] !== undefined) {
                deletedText = pendingMatch.swipes[swipeId];
            } else if (snapEntry && snapEntry.swipes?.[swipeId] !== undefined) {
                deletedText = snapEntry.swipes[swipeId];
            }

            if (deletedText !== '') {
                recordDeleteSwipeSnapshot({
                    mesId: messageId,
                    deletedSwipeText: deletedText,
                    name: pendingMatch?.name ?? snapEntry?.name,
                    isUser: pendingMatch?.isUser ?? snapEntry?.is_user,
                });
            }
            _pendingDeleteContext = null;
            syncAllBaselines();
        });
    }

    // H) ST 공식 이벤트: MESSAGE_DELETED (메시지 전체 삭제 시 - User, Assistant, System 불문 100% 캡처)
    if (ctx?.eventSource && ctx.event_types?.MESSAGE_DELETED) {
        ctx.eventSource.on(ctx.event_types.MESSAGE_DELETED, () => {
            const chat = getChat();
            const pendingValid = (_pendingDeleteContext && (Date.now() - _pendingDeleteContext.timestamp < 60000))
                ? _pendingDeleteContext
                : null;
            _pendingDeleteContext = null;

            const targets = [];
            if (Array.isArray(_lastChatSnapshot) && Array.isArray(chat) && _lastChatSnapshot.length > chat.length) {
                const survivingRefs = new Set(chat);
                for (let i = 0; i < _lastChatSnapshot.length; i++) {
                    const entry = _lastChatSnapshot[i];
                    if (!entry?.ref) continue;
                    if (!survivingRefs.has(entry.ref)) {
                        if (pendingValid && pendingValid.mesId === i) {
                            targets.push(pendingValid);
                        } else {
                            targets.push({
                                mesId: i,
                                msg: entry.ref,
                            });
                        }
                    }
                }
            }

            // 참조 기반 diff로 못 찾았을 때(배열 교체 등) pendingValid fallback
            if (!targets.length && pendingValid?.msg) {
                targets.push(pendingValid);
            }

            for (const target of targets) {
                if (target?.msg) recordDeleteSnapshot(target);
            }

            syncAllBaselines();
        });
    }
}
