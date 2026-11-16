// ─── drag-features.js ───────────────────────────────────────────────────────
// 드래그 선택 시 뜨는 검색/치환/빠른수정 필 및 향상된 메시지 삭제.

import { ESC_SPECIAL, smartInsertSpacing } from './utils.js';
import { getChat, editMessage, editTranslatedText, wsSettings, setLastChatSelection, clearLastChatSelection } from './state.js';
import { createPanel, getPanelBody, closePanel, inputBox, btn } from './panel-ui.js';
import { safeHighlight } from './highlight.js';
import { runChange } from './find-change.js';

let _delBtnObserver = null;
let _ensureDeleteExtraButtonsRef = null;

function isEnhancedDeleteActive() {
    return Boolean(wsSettings.enhancedDelete || document.body.classList.contains('ws-dell-active'));
}

export function refreshEnhancedDeleteObserver() {
    if (!_delBtnObserver) return;
    _delBtnObserver.disconnect();
    if (isEnhancedDeleteActive()) {
        const delDialog = document.getElementById('dialogue_del_mes');
        if (delDialog) {
            _delBtnObserver.observe(delDialog, { attributes: true, attributeFilter: ['style', 'class'] });
        }
    }
    _ensureDeleteExtraButtonsRef?.();
}

function exitEnhancedDeleteUI() {
    document.body.classList.remove('ws-dell-active', 'ws-dell-range');
    refreshEnhancedDeleteObserver();
}

export async function turnOnEnhancedDelete() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
        await ctx.executeSlashCommandsWithOptions('/del', { showOutput: false });
    }
    const syncDeleteModeUI = () => {
        const active = isDeleteModeActive();
        document.body.classList.toggle('ws-dell-active', active);
        refreshEnhancedDeleteObserver();
    };
    syncDeleteModeUI();
    setTimeout(syncDeleteModeUI, 50);
}

// ─── 드래그 빠른 수정 (선택 앞뒤 문맥 기반 위치 특정) ─────────────────────────
function getMatchContext(selRange, contextLen = 60) {
    const startEl = selRange.startContainer.nodeType === 1 ? selRange.startContainer : selRange.startContainer.parentElement;
    const mesEl = startEl?.closest('.mes[mesid]');
    if (!mesEl) return null;
    const msgIdx = parseInt(mesEl.getAttribute('mesid'), 10);
    const mesTextEl = mesEl.querySelector('.mes_text');
    if (!mesTextEl) return null;
    const preRange = document.createRange();
    preRange.selectNodeContents(mesTextEl);
    preRange.setEnd(selRange.startContainer, selRange.startOffset);
    const postRange = document.createRange();
    postRange.selectNodeContents(mesTextEl);
    postRange.setStart(selRange.endContainer, selRange.endOffset);
    return {
        msgIdx,
        beforeCtx: preRange.toString().slice(-contextLen),
        afterCtx: postRange.toString().slice(0, contextLen),
    };
}

// 따옴표(직선/스마트), 아포스트로피, HTML 엔티티, 공백, 인라인 마크다운 기호를 유연하게 매칭하는 정규식 빌더
function toFlexiblePattern(str, allowInlineMarkup = false) {
    if (!str) return '';
    let res = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '"' || ch === '“' || ch === '”' || ch === '＂') {
            res += '(?:["“”＂]|&quot;|&#34;)';
        } else if (ch === "'" || ch === '‘' || ch === '’' || ch === '＇') {
            res += "(?:['‘’＇]|&apos;|&#39;)";
        } else if (/\s/.test(ch) || ch === '\u00a0' || ch === '\u200b') {
            res += '(?:\\s|&nbsp;|<br\\s*\\/?>)+';
        } else {
            res += ESC_SPECIAL(ch);
        }
        if (allowInlineMarkup && i < str.length - 1) {
            res += '(?:[*_~`]|<\\/?[a-zA-Z0-9]+[^>]*>){0,10}';
        }
    }
    return res;
}

// 문맥 기반 유일 매칭 위치 탐색 (번역문 우선 시 display_text 먼저 탐색)
function locateRawOffset(msgIdx, beforeCtx, target, afterCtx) {
    const msg = getChat()?.[msgIdx];
    if (!msg) return null;
    const MD_GAP = '(?:[*_~`]|<\\/?[a-zA-Z0-9]+[^>]*>|\\s){0,15}';
    const tryField = (raw, field) => {
        if (raw === undefined) return null;
        for (const allowInline of [false, true]) {
            for (const len of [60, 30, 15, 8, 4, 2, 1, 0]) {
                const b = beforeCtx.slice(Math.max(0, beforeCtx.length - len));
                const a = afterCtx.slice(0, len);
                const pattern = toFlexiblePattern(b, allowInline) + MD_GAP + '(' + toFlexiblePattern(target, allowInline) + ')' + MD_GAP + toFlexiblePattern(a, allowInline);
                let re;
                try { re = new RegExp(pattern, 'gd'); } catch { continue; }
                const matches = [...raw.matchAll(re)];
                if (matches.length === 1 && matches[0].indices?.[1]) {
                    const [s, e] = matches[0].indices[1];
                    return { start: s, end: e, field };
                }
            }
        }
        return null;
    };
    if (wsSettings.translationSearchEnabled) {
        const transText = msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText;
        if (transText) {
            const hit = tryField(transText, 'display_text');
            if (hit) return hit;
        }
    }
    return tryField(msg.mes, 'mes');
}

async function replaceAtOffset(msgIdx, start, end, rep, field = 'mes') {
    const msg = getChat()?.[msgIdx];
    if (!msg) return;
    if (field === 'display_text') {
        const raw = msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? '';
        await editTranslatedText(msgIdx, raw.slice(0, start) + rep + raw.slice(end));
    } else {
        const mes = msg.mes;
        await editMessage(msgIdx, mes.slice(0, start) + rep + mes.slice(end));
    }
    await SillyTavern.getContext().saveChat?.();
}

function highlightQuickReplaceRange(domRange) {
    const mark = document.createElement('mark');
    mark.dataset.wsQr = '1'; mark.classList.add('ws-hl-cur');
    safeHighlight(domRange, mark);
}

function clearQuickReplaceHighlight() {
    document.querySelectorAll('#chat .mes_text mark[data-ws-qr]').forEach(mark => {
        const p = mark.parentNode; if (!p) return;
        while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
        p.removeChild(mark); p.normalize();
    });
}

async function insertAtOffset(msgIdx, pos, text, field = 'mes') {
    const msg = getChat()?.[msgIdx];
    if (!msg) return;
    if (field === 'display_text') {
        const raw = msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? '';
        await editTranslatedText(msgIdx, smartInsertSpacing(raw, pos, text));
    } else {
        await editMessage(msgIdx, smartInsertSpacing(msg.mes, pos, text));
    }
    await SillyTavern.getContext().saveChat?.();
}

function openQuickReplacePanel(msgIdx, beforeCtx, selText, afterCtx, domRange) {
    const PANEL_ID = 'ws-quickreplace-panel';
    clearQuickReplaceHighlight();
    highlightQuickReplaceRange(domRange);
    const panel = createPanel(PANEL_ID, null, () => { closePanel(PANEL_ID); clearQuickReplaceHighlight(); }), body = getPanelBody(panel);
    const input = inputBox('바꿀 단어'); body.appendChild(input);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
    const doReplace = async () => {
        const rep = input.value;
        closePanel(PANEL_ID); clearQuickReplaceHighlight();
        const loc = locateRawOffset(msgIdx, beforeCtx, selText, afterCtx);
        if (!loc) { toastr.error('원문에서 위치를 찾지 못했습니다.', '', { timeOut: 3000 }); return; }
        await replaceAtOffset(msgIdx, loc.start, loc.end, rep, loc.field);
    };
    // ◀/▶: 드래그한 텍스트는 그대로 두고, 그 자리 앞(◀) 또는 뒤(▶)에 입력값만 끼워넣음(치환 아님)
    const insertLeft = document.createElement('div'); insertLeft.style.cssText = 'display:flex;gap:6px;';
    const doInsert = async (before) => {
        const val = input.value; if (!val) return;
        closePanel(PANEL_ID); clearQuickReplaceHighlight();
        const loc = locateRawOffset(msgIdx, beforeCtx, selText, afterCtx);
        if (!loc) { toastr.error('원문에서 위치를 찾지 못했습니다.', '', { timeOut: 3000 }); return; }
        await insertAtOffset(msgIdx, before ? loc.start : loc.end, val, loc.field);
    };
    function iconBtn(faClass, onClick) {
        const b = document.createElement('button'); b.className = 'ws-btn ws-btn-accent';
        b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
        b.innerHTML = `<i class="${faClass}"></i>`;
        b.addEventListener('click', onClick); return b;
    }
    insertLeft.appendChild(iconBtn('fa-solid fa-caret-left', () => doInsert(true)));
    insertLeft.appendChild(iconBtn('fa-solid fa-caret-right', () => doInsert(false)));
    row.appendChild(insertLeft);
    row.appendChild(btn('확인', doReplace, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doReplace(); });
}

// 드래그 선택 텍스트 — pill이 살아있는 동안 유지, 사라지면 초기화
let _wsActiveDragText = '';

// ─── Drag-to-Search ─────────────────────────────────────────────────────────

function initDragSearch() {
    if (window._wsDragSearch) window._wsDragSearch();
    const PILL = 'ws-drag-pill';
    let lastQrClickTime = 0;
    const isQrClick = (target) => {
        return !!target?.closest?.('#qr_bar, .qr--button, .qr-button, .quick-reply-btn, #quick-reply-bar, [data-qr]');
    };
    const removePill = (clearCache = false) => {
        const el = document.getElementById(PILL);
        if (el?._cleanup) el._cleanup();
        el?.remove();
        _wsActiveDragText = '';
        if (clearCache && Date.now() - lastQrClickTime > 1500) {
            clearLastChatSelection();
        }
    };
    function makePillIcon(iconClass, onActivate) {
        const el = document.createElement('span');
        el.className = 'ws-drag-pill-icon';
        const icon = document.createElement('i'); icon.className = iconClass;
        el.appendChild(icon);
        const touch = window.matchMedia('(pointer:coarse)').matches;
        el.addEventListener('mousedown', e => e.preventDefault());
        el.addEventListener('click', e => { e.stopPropagation(); onActivate(); });
        if (touch) {
            el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onActivate(); }, { passive: false });
        }
        return el;
    }
    function showPill(x, y, text, range) {
        removePill(false);
        const pill = document.createElement('div'); pill.id = PILL; pill.className = 'ws-drag-pill';
        // --ws-pill-offset-x/y CSS 변수 기준 오프셋 적용
        const rootStyle = getComputedStyle(document.documentElement);
        const rawOffX = parseFloat(rootStyle.getPropertyValue('--ws-pill-offset-x'));
        const rawOffY = parseFloat(rootStyle.getPropertyValue('--ws-pill-offset-y'));
        const offX = Number.isFinite(rawOffX) ? rawOffX : 20;
        const offY = Number.isFinite(rawOffY) ? rawOffY : 70;
        pill.style.left = `${x + offX}px`;
        pill.style.top = `${y + offY}px`;
        pill.appendChild(makePillIcon('fa-solid fa-wand-magic-sparkles', () => { removePill(false); runChange(text, false, false); }));
        let matchCtx = null;
        try { matchCtx = getMatchContext(range); } catch { }
        if (matchCtx) {
            const rawSelText = range.toString();
            const clonedRange = range.cloneRange();
            pill.appendChild(makePillIcon('fa-solid fa-eraser', () => { removePill(false); openQuickReplacePanel(matchCtx.msgIdx, matchCtx.beforeCtx, rawSelText, matchCtx.afterCtx, clonedRange); }));
        }
        document.body.appendChild(pill);
        requestAnimationFrame(() => {
            if (!pill.isConnected) return;
            const r = pill.getBoundingClientRect();
            if (r.right > window.innerWidth) pill.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
            if (r.bottom > window.innerHeight) pill.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
        });
        const onOut = e => { if (!pill.contains(e.target)) removePill(!isQrClick(e.target)); };
        const outTimer = setTimeout(() => {
            if (!pill.isConnected) return;
            document.addEventListener('pointerdown', onOut);
        }, 100);
        pill._cleanup = () => {
            clearTimeout(outTimer);
            document.removeEventListener('pointerdown', onOut);
        };
    }
    let lastSel = '', endTimer = null;
    const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th';
    // 여러 문단에 걸친 선택인지 판정
    function selectionSpansMultipleParagraphs(range) {
        const frag = range.cloneContents();
        const blocks = frag.querySelectorAll(BLOCK_SELECTOR);
        const withText = Array.from(blocks).filter(el => el.textContent.trim().length > 0);
        return withText.length > 1;
    }
    function onEnd(cx, cy) {
        clearTimeout(endTimer);
        endTimer = setTimeout(() => {
            const active = document.activeElement;
            // 메시지 편집 textarea 제외 (#send_textarea는 허용)
            if (active && (active.id === 'curEditTextarea' || active.classList?.contains('edit_textarea') || active.closest?.('.mes_edit_text, .edit_textarea, #chat .mes_edit'))) {
                removePill();
                return;
            }
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount < 1) {
                removePill();
                lastSel = '';
                return;
            }
            const rawText = sel.toString();
            if (!rawText || rawText.length === 0) {
                removePill();
                lastSel = '';
                return;
            }
            const range = sel.getRangeAt(0);
            if (!document.getElementById('chat')?.contains(range.commonAncestorContainer)) {
                removePill();
                return;
            }
            const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
            if (startEl?.closest('#curEditTextarea, textarea, [contenteditable="true"], .edit_textarea')) {
                removePill();
                return;
            }
            if (selectionSpansMultipleParagraphs(range)) {
                removePill();
                lastSel = '';
                return;
            }

            // 선택 텍스트 전역 저장 (/finds, /change 연동)
            setLastChatSelection(rawText);
            _wsActiveDragText = rawText;

            const existingPill = document.getElementById(PILL);
            if (existingPill && rawText === lastSel) return;
            lastSel = rawText;

            const rect = range.getBoundingClientRect();
            let targetX = cx;
            let targetY = cy;
            if (typeof targetX !== 'number' || isNaN(targetX) || targetX <= 0) {
                targetX = rect.right || rect.left;
            }
            if (typeof targetY !== 'number' || isNaN(targetY) || targetY <= 0) {
                targetY = rect.bottom || rect.top;
            }

            showPill(targetX, targetY, rawText, range);
        }, 50);
    }

    let isPointerDown = false;
    const onPD = (e) => {
        isPointerDown = true;
        if (isQrClick(e.target)) {
            lastQrClickTime = Date.now();
            const sel = window.getSelection();
            const text = sel?.toString()?.trim();
            if (text && !sel.isCollapsed) {
                setLastChatSelection(text);
            }
        }
    };
    const onPU = e => {
        isPointerDown = false;
        if (!isQrClick(e.target)) {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.toString()?.trim()) {
                clearLastChatSelection();
            }
        }
        onEnd(e.clientX, e.clientY);
    };
    const onTE = e => {
        isPointerDown = false;
        const t = e.changedTouches?.[0];
        if (!isQrClick(e.target)) {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.toString()?.trim()) {
                clearLastChatSelection();
            }
        }
        onEnd(t?.clientX, t?.clientY);
    };
    const onCancel = () => { isPointerDown = false; clearTimeout(endTimer); clearTimeout(selChangeTimer); };
    const onPointerUpReset = () => { isPointerDown = false; };

    let selChangeTimer = null;
    const onSC = () => {
        if (isPointerDown) {
            clearTimeout(selChangeTimer);
            return;
        }
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            if (_wsActiveDragText || lastSel) {
                removePill(true);
                lastSel = '';
            }
            return;
        }
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString()?.trim()) {
            if (_wsActiveDragText || lastSel || document.getElementById(PILL)) {
                removePill(true);
                lastSel = '';
            }
            return;
        }
        const rawText = sel.toString();
        if (sel.rangeCount > 0 && document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer)) {
            setLastChatSelection(rawText);
            _wsActiveDragText = rawText;

            clearTimeout(selChangeTimer);
            selChangeTimer = setTimeout(() => {
                if (isPointerDown) return;
                if (!document.getElementById(PILL) && window.getSelection()?.toString()?.trim()) {
                    const r = window.getSelection()?.getRangeAt(0);
                    if (r) {
                        const rect = r.getBoundingClientRect();
                        onEnd(rect.right || rect.left, rect.bottom || rect.top);
                    }
                }
            }, 300);
        }
    };

    document.addEventListener('pointerdown', onPD, { passive: true });
    document.addEventListener('pointerup', onPointerUpReset, { passive: true });
    document.addEventListener('mouseup', onPU);
    document.addEventListener('touchend', onTE);
    document.addEventListener('pointercancel', onCancel, { passive: true });
    document.addEventListener('selectionchange', onSC);

    window._wsDragSearch = () => {
        clearTimeout(endTimer);
        clearTimeout(selChangeTimer);
        removePill();
        document.removeEventListener('pointerdown', onPD);
        document.removeEventListener('pointerup', onPointerUpReset);
        document.removeEventListener('mouseup', onPU);
        document.removeEventListener('touchend', onTE);
        document.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('selectionchange', onSC);
        window._wsDragSearch = null;
    };
}

// ─── 향상된 메시지 삭제 (에딧모드 토글 및 /dell) ─────────────────────────────
function isDeleteModeActive() {
    const anyCheckbox = document.querySelector('#chat .mes .del_checkbox');
    if (!anyCheckbox) return false;
    return getComputedStyle(anyCheckbox).display !== 'none';
}

function groupIntoRanges(sortedIdxs) {
    const ranges = [];
    let start = sortedIdxs[0], prev = sortedIdxs[0];
    for (let i = 1; i < sortedIdxs.length; i++) {
        const cur = sortedIdxs[i];
        if (cur === prev + 1) { prev = cur; continue; }
        ranges.push([start, prev]);
        start = cur; prev = cur;
    }
    ranges.push([start, prev]);
    return ranges;
}

let _isEnhancedDeleting = false;

async function enhancedDeleteSelected() {
    if (_isEnhancedDeleting) return false;
    const selectedEls = Array.from(document.querySelectorAll('#chat .mes.selected'));
    const removedIdxs = selectedEls.map(el => parseInt(el.getAttribute('mesid'), 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (!removedIdxs.length) { toastr.info('선택된 메시지가 없습니다.', '', { timeOut: 3000 }); return false; }

    const ctx = SillyTavern.getContext();
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
        toastr.error('지원하지 않는 SillyTavern 버전입니다.', '', { timeOut: 4000 });
        return false;
    }

    _isEnhancedDeleting = true;
    try {
        const ranges = groupIntoRanges(removedIdxs);
        for (let i = ranges.length - 1; i >= 0; i--) {
            const [s, e] = ranges[i];
            const arg = s === e ? `${s}` : `${s}-${e}`;
            await ctx.executeSlashCommandsWithOptions(`/cut ${arg}`, { showOutput: false });
        }
        toastr.success(`${removedIdxs.length}개 메시지를 삭제했습니다.`, '', { timeOut: 3000 });
        return true;
    } finally {
        _isEnhancedDeleting = false;
    }
}

function clearAllSelected() {
    document.querySelectorAll('#chat .mes.selected').forEach(el => {
        el.classList.remove('selected');
        const cb = el.querySelector(':scope > .del_checkbox'); if (cb) cb.checked = false;
    });
}

function initEnhancedDelete() {
    if (window._wsEnhancedDelete) window._wsEnhancedDelete();

    let rangeMode = false;
    let batchBtn = null;
    let boundOkBtn = null;

    function updateBatchBtnState() {
        if (batchBtn) batchBtn.classList.toggle('armed', rangeMode);
        document.body.classList.toggle('ws-dell-range', rangeMode);
    }

    function resetRangeMode() { rangeMode = false; updateBatchBtnState(); }

    function ensureDeleteExtraButtons() {
        if (!isEnhancedDeleteActive()) {
            document.getElementById('ws-del-batch-btn')?.remove();
            document.getElementById('ws-del-clear-btn')?.remove();
            boundOkBtn = null;
            return;
        }
        const okBtn = document.getElementById('dialogue_del_mes_ok');
        if (!okBtn || !okBtn.parentElement) return;

        let clearBtn = document.getElementById('ws-del-clear-btn');
        if (okBtn !== boundOkBtn) {
            document.getElementById('ws-del-batch-btn')?.remove();
            document.getElementById('ws-del-clear-btn')?.remove();
            boundOkBtn = okBtn;

            function makeStitchBtn(id, label) {
                const b = document.createElement('div');
                b.id = id; b.className = 'ws-stitch-btn';
                b.textContent = label;
                return b;
            }

            batchBtn = makeStitchBtn('ws-del-batch-btn', 'ST');
            batchBtn.addEventListener('click', e => {
                e.stopPropagation();
                rangeMode = !rangeMode;
                updateBatchBtnState();
            });

            clearBtn = makeStitchBtn('ws-del-clear-btn', '해제');
            clearBtn.addEventListener('click', e => {
                e.stopPropagation();
                clearAllSelected();
                resetRangeMode();
            });

            okBtn.insertAdjacentElement('beforebegin', clearBtn);
            clearBtn.insertAdjacentElement('beforebegin', batchBtn);
        }

        requestAnimationFrame(() => requestAnimationFrame(() => {
            const okRect = okBtn.getBoundingClientRect();
            const okFontSize = getComputedStyle(okBtn).fontSize;
            const parentStyle = getComputedStyle(okBtn.parentElement);
            const flexGap = parseFloat(parentStyle.columnGap || parentStyle.gap || '0') || 0;
            let marginPx = null;
            if (flexGap > 0) {
                marginPx = 0;
            } else {
                const cancelBtn = document.getElementById('dialogue_del_mes_cancel');
                if (cancelBtn) {
                    const measured = cancelBtn.getBoundingClientRect().left - okRect.right;
                    if (measured > 0) marginPx = measured;
                }
            }
            [batchBtn, clearBtn].forEach(b => {
                if (!b) return;
                if (okRect.height) b.style.height = `${okRect.height}px`;
                if (okFontSize) b.style.fontSize = okFontSize;
            });
            if (marginPx !== null && clearBtn) {
                const isNarrow = window.matchMedia('(max-width: 480px)').matches;
                if (isNarrow) {
                    clearBtn.style.marginLeft = '50px';
                    clearBtn.style.marginRight = '25px';
                } else {
                    clearBtn.style.marginLeft = `${marginPx}px`;
                    clearBtn.style.marginRight = flexGap > 0 ? '0px' : `${Math.max(0, marginPx - 20)}px`;
                }
            }
        }));
    }

    _delBtnObserver = new MutationObserver(() => ensureDeleteExtraButtons());
    _ensureDeleteExtraButtonsRef = ensureDeleteExtraButtons;
    refreshEnhancedDeleteObserver();

    const onMesClickCapture = e => {
        if (!isEnhancedDeleteActive() || !isDeleteModeActive()) return;
        const mesEl = e.target.closest('#chat .mes'); if (!mesEl) return;
        const checkbox = mesEl.querySelector(':scope > .del_checkbox'); if (!checkbox) return;
        e.stopImmediatePropagation(); e.preventDefault();

        const idx = parseInt(mesEl.getAttribute('mesid'), 10);

        if (rangeMode) {
            const allMes = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
            if (!allMes.length) return;
            const lastIdx = Math.max(...allMes.map(el => parseInt(el.getAttribute('mesid'), 10)));
            clearAllSelected();
            allMes.forEach(el => {
                const n = parseInt(el.getAttribute('mesid'), 10);
                if (n >= idx && n <= lastIdx) {
                    el.classList.add('selected');
                    const cb = el.querySelector(':scope > .del_checkbox'); if (cb) cb.checked = true;
                }
            });
            return;
        }

        const nowChecked = !checkbox.checked;
        checkbox.checked = nowChecked;
        mesEl.classList.toggle('selected', nowChecked);
    };

    const onOkClickCapture = e => {
        if (!isEnhancedDeleteActive() || !isDeleteModeActive()) return;
        if (!e.target.closest('#dialogue_del_mes_ok')) return;
        e.stopImmediatePropagation(); e.preventDefault();
        enhancedDeleteSelected().then(didDelete => {
            if (!didDelete) return;
            resetRangeMode();
            document.getElementById('dialogue_del_mes_cancel')?.click();
            document.body.classList.remove('ws-dell-active');
            setTimeout(() => {
                exitEnhancedDeleteUI();
            }, 50);
        });
    };

    const onCancelClick = e => {
        if (e.target.closest('#dialogue_del_mes_cancel')) {
            resetRangeMode();
            setTimeout(() => {
                exitEnhancedDeleteUI();
            }, 50);
        }
    };

    const onTriggerClick = e => {
        if (!e.target.closest?.('#option_delete_mes, .mes_del')) return;
        if (wsSettings.enhancedDelete) {
            document.body.classList.add('ws-dell-active');
            setTimeout(refreshEnhancedDeleteObserver, 50);
        } else {
            document.body.classList.remove('ws-dell-active');
        }
    };

    document.addEventListener('click', onTriggerClick, true);
    document.addEventListener('click', onMesClickCapture, true);
    document.addEventListener('click', onOkClickCapture, true);
    document.addEventListener('click', onCancelClick, true);
    window._wsEnhancedDelete = () => {
        resetRangeMode();
        document.removeEventListener('click', onTriggerClick, true);
        document.removeEventListener('click', onMesClickCapture, true);
        document.removeEventListener('click', onOkClickCapture, true);
        document.removeEventListener('click', onCancelClick, true);
        _delBtnObserver?.disconnect();
        _delBtnObserver = null;
        _ensureDeleteExtraButtonsRef = null;
        window._wsEnhancedDelete = null;
    };
}

export function initDragFeatures() {
    initDragSearch();
    initEnhancedDelete();
}
