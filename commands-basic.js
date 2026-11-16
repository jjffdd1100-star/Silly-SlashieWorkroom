// ─── commands-basic.js ──────────────────────────────────────────────────────
// /collapse /expand /up /down /goto /message-button /message-bottom /message-mb
// /move /undo /clip /word /hidden /hidealarm /swiped /index /indexed
// /convert /edit /dell /fempov /quickau /fonta /fontb /ctrlz /slashie

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '/scripts/slash-commands/SlashCommandEnumValue.js';

import { parseRange, stripText, expandDetails, stripLeadingTagBlock, stripReasoningBlocks } from './utils.js';
import {
    SUMMARY, getChat, editMessage,
    loadMessagesUntil, loadAndScrollTo, copyText, copyFullChat, getSearchableText,
    wsSettings, saveWsSettings, resetSlashieLocalStorage, applyWsHlColor, applyWsHlCurColor, applyWsIndexColor, WS_DEFAULT_HL_POSITION_PERCENT,
    getMoveSnapshot, setMoveSnapshot, raiseToTop, getLastChatSelection,
} from './state.js';
import { createPanel, getPanelBody, makeDraggable, closePanel } from './panel-ui.js';
import { openFontAPanel, lookupFaIcon, openFontBPanel, convertSpecialFont } from './font-tools.js';
import { stickyData, applyStickyColor, persistStickyUI, resetStickyUI } from './sticky.js';
import { setNote, openNoteModal, getAllNotes } from './note.js';
import { refreshEnhancedDeleteObserver, turnOnEnhancedDelete } from './drag-features.js';
import { openCtrlZViewerPanel, syncAllBaselines } from './undo-manager.js';
import { openDifferenceReviewQueue } from './difference.js';

// ─── 이동 엔진 (reload 없이 배열+DOM 직접 패치) ──────────────────────────────
async function ensureRangeLoaded(minIdx, maxIdx) {
    const allPresent = () => {
        for (let i = minIdx; i <= maxIdx; i++) if (!document.querySelector(`#chat [mesid="${i}"]`)) return false;
        return true;
    };
    return loadMessagesUntil(allPresent, { maxBatches: 200, timeoutMs: 12000 });
}

// fromStart~fromEnd를 to 위치로 이동 (실패 시 null)
async function performBlockMove(fromStart, fromEnd, to) {
    const chat = getChat();
    if (!Array.isArray(chat)) return null;
    const len = fromEnd - fromStart + 1;
    const clampedTo = Math.max(0, Math.min(to, chat.length));
    const lo = Math.min(fromStart, clampedTo);
    const hi = Math.max(fromEnd, clampedTo >= chat.length ? chat.length - 1 : clampedTo);

    const loaded = await ensureRangeLoaded(lo, hi);
    if (!loaded) { toastr.error('메시지를 불러오지 못했습니다.', '', { timeOut: 4000 }); return null; }

    // 1) 배열 이동
    const idxs = Array.from({ length: len }, (_, i) => fromStart + i);
    const set = new Set(idxs);
    const msgs = idxs.map(i => chat[i]);
    const rem = chat.filter((_, i) => !set.has(i));
    const before = idxs.filter(i => i < clampedTo).length;
    const adj = Math.max(0, Math.min(clampedTo - before, rem.length));

    // 2) DOM 이동 (원본 mesid 변경 전 앵커 확정)
    const chatEl = document.getElementById('chat');
    const blockNodes = idxs.map(i => chatEl?.querySelector(`[mesid="${i}"]`));
    if (!chatEl || !blockNodes.every(Boolean)) {
        toastr.error('메시지 이동에 실패했습니다.', '', { timeOut: 4000 });
        return null;
    }
    {
        let anchorNode = null;
        if (adj < fromStart) {
            anchorNode = chatEl.querySelector(`[mesid="${adj}"]`);
        } else if (adj < rem.length) {
            const anchorOrigIdx = fromEnd + 1 + (adj - fromStart);
            anchorNode = chatEl.querySelector(`[mesid="${anchorOrigIdx}"]`);
        } // else adj === rem.length → 맨 끝에 append (anchorNode 없음)

        const frag = document.createDocumentFragment();
        blockNodes.forEach(n => frag.appendChild(n));
        if (anchorNode) chatEl.insertBefore(frag, anchorNode);
        else chatEl.appendChild(frag);

        // 3) 영향받은 구간[lo,hi]의 mesid만 새 DOM 순서에 맞춰 재계산
        const zoneNodes = Array.from(chatEl.querySelectorAll('.mes[mesid]')).filter(el => {
            const n = parseInt(el.getAttribute('mesid'), 10);
            return n >= lo && n <= hi;
        });
        zoneNodes.forEach((el, i) => el.setAttribute('mesid', String(lo + i)));
    }

    // 4) 배열 확정 + 즉시 저장 + Undo 베이스라인 동기화
    chat.length = 0; chat.push(...rem.slice(0, adj), ...msgs, ...rem.slice(adj));
    await SillyTavern.getContext().saveChat?.();
    syncAllBaselines();

    return { blockStart: adj, blockEnd: adj + len - 1, target: fromStart };
}

export function registerBasicCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'collapse', helpString: 'Wrap message(s) in details tag. Usage: /collapse 2 or /collapse 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index or range', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_a, value) => {
            const idxs = parseRange(value); if (!idxs) return '';
            for (const idx of idxs) {
                const msg = getChat()?.[idx];
                if (!msg || msg.mes.includes(`<summary>${SUMMARY}</summary>`)) continue;
                await editMessage(idx, `<details>\n<summary>${SUMMARY}</summary>\n\n${msg.mes}\n\n</details>`, true);
            }
            await SillyTavern.getContext().saveChat?.();
            document.querySelector(`[mesid="${idxs[idxs.length - 1]}"]`)?.scrollIntoView({ block: 'start' }); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expand', helpString: 'Unwrap message(s) from details tag. Usage: /expand 2 or /expand 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index or range', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_a, value) => {
            const idxs = parseRange(value); if (!idxs) return '';
            for (const idx of idxs) {
                const msg = getChat()?.[idx];
                if (!msg || !/<details\b[^>]*>/i.test(msg.mes)) continue;
                await editMessage(idx, expandDetails(msg.mes), true);
            }
            await SillyTavern.getContext().saveChat?.();
            document.querySelector(`[mesid="${idxs[idxs.length - 1]}"]`)?.scrollIntoView({ block: 'start' }); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'up', helpString: 'Scroll to top of chat.',
        callback: () => { document.getElementById('chat')?.scrollTo({ top: 0 }); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'down', helpString: 'Scroll to bottom of chat.',
        callback: () => { const c = document.getElementById('chat'); if (c) c.scrollTo({ top: c.scrollHeight }); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-button', helpString: 'Scroll to topmost message and open menu.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            for (const mes of chatEl.querySelectorAll('.mes[mesid]')) {
                if (mes.getBoundingClientRect().bottom > chatRect.top) {
                    mes.scrollIntoView({ block: 'start' });
                    setTimeout(() => {
                        mes.querySelector('div.mes_button.extraMesButtonsHint.fa-solid.fa-ellipsis.interactable')?.click();
                    }, 0);
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-bottom', helpString: 'Scroll to bottommost message.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            const all = chatEl.querySelectorAll('.mes[mesid]');
            for (let i = all.length - 1; i >= 0; i--) {
                const mes = all[i];
                if (mes.getBoundingClientRect().top < chatRect.bottom) {
                    mes.scrollIntoView({ block: 'end' });
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-button', helpString: 'Scroll one step up.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            const all = Array.from(chatEl.querySelectorAll('.mes[mesid]'));
            for (let i = 0; i < all.length; i++) {
                const mes = all[i];
                const mesRect = mes.getBoundingClientRect();
                if (mesRect.bottom > chatRect.top + 4) {
                    const currentIdx = parseInt(mes.getAttribute('mesid'), 10);
                    // 1) 메시지의 중간을 보고 있다면(상단이 위로 잘려있음) -> 해당 메시지 상단으로 정렬
                    if (mesRect.top < chatRect.top - 6) {
                        mes.scrollIntoView({ block: 'start' });
                    } else if (!isNaN(currentIdx) && currentIdx > 0) {
                        // 2) 이미 상단에 맞춰져 있다면 -> 이전 메시지의 상단으로 이동
                        const prevEl = chatEl.querySelector(`[mesid="${currentIdx - 1}"]`);
                        if (prevEl) {
                            prevEl.scrollIntoView({ block: 'start' });
                        } else {
                            loadAndScrollTo(currentIdx - 1);
                        }
                    }
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-bottom', helpString: 'Scroll one step down.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            const all = Array.from(chatEl.querySelectorAll('.mes[mesid]'));
            const chat = getChat();
            if (!Array.isArray(chat)) return '';
            for (let i = all.length - 1; i >= 0; i--) {
                const mes = all[i];
                const mesRect = mes.getBoundingClientRect();
                if (mesRect.top < chatRect.bottom - 4) {
                    const currentIdx = parseInt(mes.getAttribute('mesid'), 10);
                    // 1) 메시지의 중간을 보고 있다면(하단이 아래로 잘려있음) -> 해당 메시지 하단으로 정렬
                    if (mesRect.bottom > chatRect.bottom + 6) {
                        mes.scrollIntoView({ block: 'end' });
                    } else if (!isNaN(currentIdx) && currentIdx < chat.length - 1) {
                        // 2) 이미 하단에 맞춰져 있다면 -> 다음 메시지의 하단으로 이동
                        const nextEl = chatEl.querySelector(`[mesid="${currentIdx + 1}"]`);
                        if (nextEl) {
                            nextEl.scrollIntoView({ block: 'end' });
                        } else {
                            loadAndScrollTo(currentIdx + 1);
                        }
                    }
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-mb', helpString: 'Scroll to Memory Books boundary and get its message index.',
        callback: () => {
            const divider = document.querySelector('div.stmb_memory_boundary_divider');
            divider?.scrollIntoView({ block: 'start' });
            return getMessageMbIndex();
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'goto', helpString: 'Scroll to message by index. Usage: /goto 5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: true })],
        callback: (_a, value) => {
            const idx = parseInt(value, 10); if (isNaN(idx)) return '';
            const chat = getChat();
            if (!Array.isArray(chat) || !chat.length) { toastr.warning('채팅 메시지가 없습니다.'); return ''; }
            if (idx < 0 || idx >= chat.length) { toastr.warning(`0~${chat.length - 1} 사이의 숫자를 입력해 주세요.`); return ''; }
            loadAndScrollTo(idx); return '';
        },
    }));

    // ─── /move ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'move', helpString: 'Move message(s) to target index. Usage: /move 2 10',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Source index or range, then target index', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_a, value) => {
            const parts = String(value).trim().split(/\s+/);
            if (parts.length !== 2) return '';
            const idxs = parseRange(parts[0]);
            if (!idxs || !idxs.length || !/^\d+$/.test(parts[1])) return '';
            const to = parseInt(parts[1], 10);
            const chat = getChat();
            const fromStart = idxs[0], fromEnd = idxs[idxs.length - 1];
            if (!Array.isArray(chat) || fromStart < 0 || fromEnd >= chat.length || to < 0 || to > chat.length) {
                toastr.error('메시지 범위를 벗어났습니다.', '', { timeOut: 3000 });
                return '';
            }
            if ((to >= fromStart && to <= fromEnd) || to === fromEnd + 1) { toastr.error('올바르지 않은 요청입니다.', '', { timeOut: 3000 }); return ''; }
            const result = await performBlockMove(fromStart, fromEnd, to);
            if (!result) return '';
            setMoveSnapshot(result);
            loadAndScrollTo(result.blockStart);
            return '';
        },
    }));

    // ─── /undo ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'undo', helpString: 'Undo the last move.',
        callback: async () => {
            const snap = getMoveSnapshot();
            if (!snap) { toastr.warning('되돌릴 작업이 없습니다.'); return ''; }
            const len = snap.blockEnd - snap.blockStart + 1;
            const undoTarget = snap.blockStart >= snap.target ? snap.target : snap.target + len;
            const result = await performBlockMove(snap.blockStart, snap.blockEnd, undoTarget);
            if (!result) return '';
            setMoveSnapshot(null);
            loadAndScrollTo(result.blockStart);
            return '';
        },
    }));

    // ─── /clip ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clip', helpString: 'Copy messages, text, or selection to clipboard. Usage: /clip, /clip 2, /clip 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index, range, or literal text. Omit for selection/input/full chat.', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: async (_a, value) => {
            const trimmed = String(value ?? '').trim();
            if (trimmed && !parseRange(trimmed)) {
                await copyText(stripReasoningBlocks(trimmed));
                return '';
            }
            if (!trimmed) {
                // 1) 화면에 드래그 선택(또는 최근 선택 캐시)이 있으면: 선택 텍스트 복사
                const sel = window.getSelection();
                const selText = sel?.toString().trim() || getLastChatSelection();
                if (selText) {
                    await copyText(stripReasoningBlocks(selText));
                    return '';
                }
                // 2) 인풋창에 글이 있으면: 인풋창 텍스트 복사
                const sendTa = document.getElementById('send_textarea');
                const sendVal = sendTa?.value?.trim();
                if (sendVal) {
                    await copyText(stripReasoningBlocks(sendVal));
                    return '';
                }
                // 3) 둘 다 비어있을 때만: 전체 채팅 복사
                await copyFullChat(text => stripText(stripReasoningBlocks(text)), getSearchableText);
                return '';
            }
            const chat = getChat(), idxs = parseRange(trimmed);
            if (!Array.isArray(chat)) return '';
            const ctx = SillyTavern.getContext(), lines = [];
            for (const idx of idxs) {
                const msg = chat[idx];
                if (!msg) continue;
                lines.push(`${msg.name || (msg.is_user ? ctx.name1 : ctx.name2)}: ${stripText(stripReasoningBlocks(getSearchableText(msg)))}`);
            }
            if (!lines.length) return '';
            await copyText(lines.join('\n\n\n'));
            return '';
        },
    }));

    // ─── /word ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'word', helpString: 'Count characters. Usage: /word, /word 2, /word 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index or range. Omit for full chat.', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: (_a, value) => {
            const trimmed = String(value ?? '').trim();
            let withSpaces = 0, noSpaces = 0, words = 0;
            const addText = text => {
                withSpaces += text.length;
                noSpaces += text.replace(/\s/g, '').length;
                const w = text.trim();
                if (w) words += w.split(/\s+/).filter(Boolean).length;
            };
            if (trimmed && !parseRange(trimmed)) {
                addText(stripText(stripReasoningBlocks(trimmed)));
            } else {
                const chat = getChat();
                if (!Array.isArray(chat)) return '';
                const idxs = trimmed ? parseRange(trimmed) : chat.map((_, i) => i);
                for (const i of idxs) {
                    const msg = chat[i];
                    if (!msg) continue;
                    addText(stripText(stripReasoningBlocks(getSearchableText(msg))));
                }
            }
            toastr.info(`공백 포함: ${withSpaces.toLocaleString()}<br>공백 제외: ${noSpaces.toLocaleString()}<br>단어: ${words.toLocaleString()}`, '', { timeOut: 12000, escapeHtml: false });
            return '';
        },
    }));

    // ─── /hidden 스크롤 고정(핀) 저장 (채팅별 localStorage) ────────────────
    function getHiddenPinKey() {
        try {
            const ctx = SillyTavern.getContext();
            return 'ws-hidden-pin-' + (ctx.chatId ?? ctx.characterId ?? 'default');
        } catch { return 'ws-hidden-pin-default'; }
    }
    function loadHiddenPinRatio() {
        try {
            const raw = localStorage.getItem(getHiddenPinKey());
            if (raw === null) return null;
            const n = parseFloat(raw);
            return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : null;
        } catch { return null; }
    }
    function saveHiddenPinRatio(ratio) {
        try {
            if (ratio === null) localStorage.removeItem(getHiddenPinKey());
            else localStorage.setItem(getHiddenPinKey(), String(ratio));
        } catch { }
    }

    // ─── /hidden ──────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hidden', helpString: 'List hidden messages.',
        callback: () => {
            const PANEL_ID = 'ws-hidden-panel';
            if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return ''; }
            const chat = getChat();
            if (!Array.isArray(chat)) return '';
            const hiddenIdxs = chat.map((msg, idx) => msg?.is_system ? idx : null).filter(idx => idx !== null);
            const protectedIdxs = chat.map((msg, idx) => (msg?.extra?.wsHideProof && !msg.is_system) ? idx : null).filter(idx => idx !== null);
            if (!hiddenIdxs.length && !protectedIdxs.length) { toastr.info('숨겨진 메시지가 없습니다.', '', { timeOut: 5000 }); return ''; }
            let pinnedRatio = loadHiddenPinRatio();
            let lastPinSourceIdx = null;
            const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
            let list = null;
            if (hiddenIdxs.length) {
                const titleRow = document.createElement('div'); titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;';
                const title = document.createElement('div'); title.style.cssText = 'font-weight:600;';
                title.textContent = `숨김 메시지 ${hiddenIdxs.length}개`;
                const pinIcon = document.createElement('i'); pinIcon.className = 'fa-solid fa-map-pin';
                pinIcon.title = '탭: 현재 스크롤 위치 고정/해제';
                pinIcon.style.cssText = 'font-size:13px;flex-shrink:0;cursor:pointer;';
                const updatePinIcon = () => {
                    pinIcon.style.opacity = pinnedRatio !== null ? '1' : '0.3';
                    pinIcon.style.color = pinnedRatio !== null ? 'var(--ws-pin-color)' : 'var(--ws-text2)';
                };
                updatePinIcon();
                function setPin(sourceIdx) {
                    const maxScroll = list.scrollHeight - list.clientHeight;
                    pinnedRatio = maxScroll > 0 ? list.scrollTop / maxScroll : 0;
                    lastPinSourceIdx = sourceIdx;
                    saveHiddenPinRatio(pinnedRatio);
                    updatePinIcon();
                }
                function clearPin() {
                    pinnedRatio = null; lastPinSourceIdx = null;
                    saveHiddenPinRatio(null);
                    updatePinIcon();
                }
                pinIcon.addEventListener('click', () => { pinnedRatio !== null ? clearPin() : setPin(null); });
                titleRow.appendChild(title); titleRow.appendChild(pinIcon);
                body.appendChild(titleRow);
                list = document.createElement('div'); list.className = 'ws-thin-scroll'; list.style.cssText = 'max-height:400px;overflow-y:auto;margin-bottom:14px;';
                hiddenIdxs.forEach(idx => {
                    if (!chat?.[idx]) return;
                    const plain = stripText(stripLeadingTagBlock(chat[idx].mes || ''));
                    const item = document.createElement('div'); item.className = 'ws-result-item';
                    item.style.cssText = 'display:flex;align-items:center;gap:6px;';
                    const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;min-width:3em;font-size:11px;cursor:pointer;'; num.textContent = `#${idx}`;
                    num.title = '클릭: 현재 스크롤 위치 고정/해제(다른 번호를 누르면 덮어쓰기)';
                    num.addEventListener('click', e => {
                        e.stopPropagation();
                        (pinnedRatio !== null && lastPinSourceIdx === idx) ? clearPin() : setPin(idx);
                    });
                    const txt = document.createElement('span'); txt.style.cssText = 'color:var(--ws-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    txt.textContent = plain.slice(0, 46) + (plain.length > 46 ? '…' : '');
                    let isHidden = !!chat[idx].is_system;
                    const ghost = document.createElement('i'); ghost.className = 'fa-solid fa-ghost'; ghost.title = '숨김 토글';
                    ghost.style.cssText = 'flex-shrink:0;font-size:13px;padding:4px 7px;border-radius:6px;cursor:pointer;background:transparent;';
                    const upd = () => { ghost.style.opacity = isHidden ? '0.85' : '0.22'; ghost.style.color = isHidden ? 'var(--ws-text)' : 'var(--ws-text2)'; };
                    upd();
                    ghost.addEventListener('pointerenter', () => { ghost.style.background = 'rgba(255,255,255,0.25)'; });
                    ghost.addEventListener('pointerleave', () => { ghost.style.background = 'transparent'; });
                    ghost.addEventListener('click', async e => {
                        e.stopPropagation();
                        const ctx = SillyTavern.getContext();
                        if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
                            toastr.error('지원하지 않는 SillyTavern 버전입니다.', '', { timeOut: 4000 });
                            return;
                        }
                        isHidden = !isHidden; upd();
                        await ctx.executeSlashCommandsWithOptions(`/${isHidden ? 'hide' : 'unhide'} ${idx}`, { showOutput: false });
                    });
                    item.appendChild(num); item.appendChild(txt); item.appendChild(ghost);
                    item.addEventListener('click', () => loadAndScrollTo(idx));
                    list.appendChild(item);
                });
                body.appendChild(list);
            }

            if (protectedIdxs.length) {
                const proofTitle = document.createElement('div');
                proofTitle.style.cssText = 'font-size:10.5px;color:var(--ws-text2);margin:2px 0 4px;';
                proofTitle.textContent = '숨김 알림 지정됨';
                body.appendChild(proofTitle);
                const proofRow = document.createElement('div');
                proofRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:10px;';
                protectedIdxs.forEach(idx => {
                    const n = document.createElement('span');
                    n.textContent = `#${idx}`;
                    n.style.cssText = 'font-size:10.5px;color:var(--ws-text2);cursor:pointer;';
                    n.addEventListener('click', () => loadAndScrollTo(idx));
                    proofRow.appendChild(n);
                });
                body.appendChild(proofRow);
            }

            requestAnimationFrame(() => {
                if (pinnedRatio === null || !list) return;
                const maxScroll = list.scrollHeight - list.clientHeight;
                list.scrollTop = maxScroll * pinnedRatio;
            });
            return '';
        },
    }));

    // ─── /swiped ─────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swiped', helpString: 'List messages with swipes.',
        callback: () => {
            const PANEL_ID = 'ws-swipelist-panel';
            if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return ''; }
            renderSwipedPanel();
            return '';
        },
    }));

    registerFempovCommand();
    registerQuickAuCommand();
    registerEditModeCommand();
    registerDellCommand();
    registerConvertCommand();
    registerFontCommands();
    registerNoteCommands();
    registerHideAlarmCommand();
    registerSlashieCommand();
}

// ─── /hidealarm ────────────────────────────────────────────────────────────
function registerHideAlarmCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hidealarm', helpString: 'Notify when message is hidden. Usage: /hidealarm 5 or /hidealarm 0-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index or range, e.g. 5 or 0-5', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: (_a, value) => {
            const idxs = parseRange(String(value ?? '').trim());
            const chat = getChat();
            if (!idxs || !Array.isArray(chat)) return '';
            const valid = idxs.filter(idx => chat[idx]);
            if (!valid.length) return '';
            valid.forEach(idx => {
                if (!chat[idx].extra) chat[idx].extra = {};
                chat[idx].extra.wsHideProof = true;
            });
            SillyTavern.getContext().saveChat?.();
            ensureHideAlarmWatcher();
            const label = valid.length === 1 ? `${valid[0]}번 메시지가` : `${valid.length}개 메시지가`;
            toastr.success(`${label} 숨겨지면 알려드릴게요.`, '', { timeOut: 3000 });
            return '';
        },
    }));
}

// ─── 숨김 알림 감지 (지정 대상이 있을 때만 활성) ──────────────────────────
let _hideAlarmObserver = null;

function checkHideAlarmBreaches() {
    const chat = getChat();
    if (!Array.isArray(chat)) return;
    let changed = false;
    let remaining = 0;
    chat.forEach((msg, idx) => {
        if (!msg) return;
        if (msg.extra?.wsHideProof) {
            if (msg.is_system) {
                delete msg.extra.wsHideProof;
                changed = true;
                toastr.warning(`${idx}번 메시지가 숨겨졌습니다.`, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false });
            } else {
                remaining++;
            }
        }
    });
    if (changed) SillyTavern.getContext().saveChat?.();
    if (remaining === 0 && _hideAlarmObserver) {
        _hideAlarmObserver.disconnect();
        _hideAlarmObserver = null;
    }
}

function ensureHideAlarmWatcher() {
    if (_hideAlarmObserver) return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; checkHideAlarmBreaches(); });
    };
    _hideAlarmObserver = new MutationObserver(schedule);
    _hideAlarmObserver.observe(chatEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['is_system'] });
}

let _hideAlarmChatHooked = false;
export function initHideAlarmWatcher() {
    const chat = getChat();
    const hasAny = Array.isArray(chat) && chat.some(msg => msg?.extra?.wsHideProof);
    if (hasAny) {
        ensureHideAlarmWatcher();
    } else if (_hideAlarmObserver) {
        _hideAlarmObserver.disconnect();
        _hideAlarmObserver = null;
    }
    if (!_hideAlarmChatHooked) {
        _hideAlarmChatHooked = true;
        const ctx = SillyTavern.getContext();
        const evtChatChanged = ctx?.event_types?.CHAT_CHANGED ?? 'chat_id_changed';
        const evtChatLoaded = ctx?.event_types?.CHAT_LOADED ?? 'chatLoaded';
        ctx?.eventSource?.on?.(evtChatChanged, () => initHideAlarmWatcher());
        ctx?.eventSource?.on?.(evtChatLoaded, () => initHideAlarmWatcher());
    }
}

function renderSwipedPanel() {
    const PANEL_ID = 'ws-swipelist-panel';
    const chat = getChat();
    if (!Array.isArray(chat)) return;
    const swipeIdxs = chat.map((msg, idx) => (msg?.swipes && msg.swipes.length > 1) ? idx : null).filter(idx => idx !== null);
    if (!swipeIdxs.length) { closePanel(PANEL_ID); toastr.info('스와이프가 있는 메시지가 없습니다.', '', { timeOut: 5000 }); return; }
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:10px;';
    title.textContent = `스와이프 메시지 ${swipeIdxs.length}개`;
    body.appendChild(title);
    const list = document.createElement('div'); list.className = 'ws-thin-scroll'; list.style.cssText = 'max-height:400px;overflow-y:auto;';
    swipeIdxs.forEach(idx => {
        const msg = chat[idx];
        const plain = stripText(stripLeadingTagBlock(msg.mes));
        const item = document.createElement('div'); item.className = 'ws-result-item';
        item.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;';
        const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;min-width:3em;font-size:11px;'; num.textContent = `#${idx}`;
        const txt = document.createElement('span'); txt.style.cssText = 'color:var(--ws-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        txt.textContent = plain.slice(0, 46) + (plain.length > 46 ? '…' : '');
        const count = document.createElement('span'); count.style.cssText = 'color:var(--ws-text2);flex-shrink:0;font-size:11px;';
        count.textContent = `${(msg.swipe_id ?? 0) + 1}/${msg.swipes.length}`;
        item.appendChild(num); item.appendChild(txt); item.appendChild(count);
        item.addEventListener('click', () => loadAndScrollTo(idx));
        list.appendChild(item);
    });
    body.appendChild(list);
}

function registerNoteCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'index', helpString: 'Add or edit message index. Usage: /index 5 [text]',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index, then index text (optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: (_a, value) => {
            const str = String(value ?? '').trim();
            const m = str.match(/^(\d+)\s*(.*)$/s);
            if (!m) return '';
            const idx = parseInt(m[1], 10), text = m[2];
            if (!getChat()?.[idx]) {
                toastr.warning(`#${idx} 메시지를 찾을 수 없습니다.`, '', { timeOut: 3000 });
                return '';
            }
            if (text) { setNote(idx, text); toastr.success(`#${idx} 인덱스를 저장했습니다.`, '', { timeOut: 2500 }); }
            else openNoteModal(idx);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'indexed', helpString: 'List all indexed messages.',
        callback: () => {
            const PANEL_ID = 'ws-notelist-panel';
            if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return ''; }
            const notes = getAllNotes();
            if (!notes.length) { toastr.info('작성된 인덱스가 없습니다.', '', { timeOut: 5000 }); return ''; }
            const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:10px;';
            title.textContent = `메시지 인덱스 ${notes.length}개`;
            body.appendChild(title);
            const list = document.createElement('div'); list.className = 'ws-thin-scroll'; list.style.cssText = 'max-height:400px;overflow-y:auto;margin-bottom:14px;';
            notes.forEach(({ idx, text }) => {
                const item = document.createElement('div'); item.className = 'ws-result-item';
                item.style.cssText = 'display:flex;align-items:center;gap:6px;';
                const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;min-width:3em;font-size:11px;'; num.textContent = `#${idx}`;
                const txt = document.createElement('span'); txt.style.cssText = 'color:var(--ws-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                txt.textContent = text.slice(0, 40) + (text.length > 40 ? '…' : '');
                item.appendChild(num); item.appendChild(txt);
                item.addEventListener('click', () => loadAndScrollTo(idx));
                list.appendChild(item);
            });
            body.appendChild(list);
            return '';
        },
    }));
}

// ─── /convert — 단위 변환기 (첫 번째 키 = 기본 왼쪽 입력 단위) ─────────────
const WS_UNIT_DEFS = {
    weight: {
        units: {
            lbs: { label: 'lbs', toBase: v => v * 0.45359237, fromBase: v => v / 0.45359237 },
            kg: { label: 'kg', toBase: v => v, fromBase: v => v },
        }
    },
    length: {
        units: {
            in: { label: 'in', toBase: v => v * 2.54, fromBase: v => v / 2.54 },
            cm: { label: 'cm', toBase: v => v, fromBase: v => v },
        }
    },
    temp: {
        units: {
            f: { label: '°F', toBase: v => (v - 32) * 5 / 9, fromBase: v => v * 9 / 5 + 32 },
            c: { label: '°C', toBase: v => v, fromBase: v => v },
        }
    },
    speed: {
        units: {
            mph: { label: 'mph', toBase: v => v * 1.609344, fromBase: v => v / 1.609344 },
            kmh: { label: 'km/h', toBase: v => v, fromBase: v => v },
        }
    },
    volume: {
        units: {
            floz: { label: 'fl oz', toBase: v => v * 29.5735295625, fromBase: v => v / 29.5735295625 },
            ml: { label: 'ml', toBase: v => v, fromBase: v => v },
            l: { label: 'L', toBase: v => v * 1000, fromBase: v => v / 1000 },
            gal: { label: 'gal', toBase: v => v * 3785.411784, fromBase: v => v / 3785.411784 },
        }
    },
};

// $, £ 탭 — 사용자 고정 환율 (localStorage 저장)
const CURRENCY_DEFS = {
    usd: { symbol: '$', code: 'USD', rateKey: 'usdKrwRate', defaultRate: 1420 },
    gbp: { symbol: '£', code: 'GBP', rateKey: 'gbpKrwRate', defaultRate: 1950 },
};

function formatNum(n) {
    if (!isFinite(n)) return '';
    return (Math.round(n * 100) / 100).toString();
}

// 한글 숫자 읽기 (4자리 만 단위 그룹)
function koreanNumberWords(numIn) {
    let num = Math.floor(Math.abs(numIn));
    if (!isFinite(num)) return '';
    if (num === 0) return '영';
    const digits = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
    const smallUnits = ['', '십', '백', '천'];
    const bigUnits = ['', '만', '억', '조', '경', '해', '자', '양'];
    const groups = [];
    while (num > 0) { groups.push(num % 10000); num = Math.floor(num / 10000); }
    if (groups.length > bigUnits.length) return Math.floor(Math.abs(numIn)).toLocaleString();
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g === 0) continue;
        let groupStr = '';
        for (let j = 3; j >= 0; j--) {
            const d = Math.floor(g / Math.pow(10, j)) % 10;
            if (d === 0) continue;
            groupStr += (d === 1 && j > 0 ? '' : digits[d]) + smallUnits[j];
        }
        parts.push(groupStr + bigUnits[i]);
    }
    return parts.join(' ');
}

// 영어 숫자 읽기(seven hundred forty million 스타일) — 3자리(천 단위)씩 끊어서 처리.
function englishNumberWords(numIn) {
    let num = Math.floor(Math.abs(numIn));
    if (!isFinite(num)) return '';
    if (num === 0) return 'zero';
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const scales = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];
    function threeDigits(n) {
        let s = '';
        if (n >= 100) { s += ones[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) s += ' '; }
        if (n >= 20) { s += tens[Math.floor(n / 10)]; if (n % 10) s += '-' + ones[n % 10]; }
        else if (n > 0) { s += ones[n]; }
        return s;
    }
    const groups = [];
    while (num > 0) { groups.push(num % 1000); num = Math.floor(num / 1000); }
    if (groups.length > scales.length) return Math.floor(Math.abs(numIn)).toLocaleString();
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
        if (groups[i] === 0) continue;
        parts.push(threeDigits(groups[i]) + (scales[i] ? ' ' + scales[i] : ''));
    }
    return parts.join(' ');
}

function registerConvertCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'convert', helpString: 'Open unit converter panel.',
        callback: () => {
            const PANEL_ID = 'ws-convert-panel';
            if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return ''; }
            const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
            body.style.textAlign = 'center'; // 전체 중앙정렬

            const title = document.createElement('div');
            title.style.cssText = 'font-weight:600;margin-bottom:10px;display:flex;align-items:center;justify-content:center;font-size:13px;letter-spacing:-0.2px;';
            title.innerHTML = '<span><i class="fa-solid fa-pen-ruler" style="margin-right:6px;color:var(--SmartThemeQuoteColor, var(--ws-text2));"></i>단위 변환기</span>';
            body.appendChild(title);

            // 카테고리 탭 — 키 | 길이 | 무게 | 온도 | 속도 | 부피 | 나이 | D-day | $ | £
            const tabRow = document.createElement('div'); tabRow.style.cssText = 'display:flex;justify-content:center;gap:3px;margin-bottom:12px;flex-wrap:wrap;';
            body.appendChild(tabRow);

            const content = document.createElement('div');
            body.appendChild(content);

            const CATS = [
                { key: 'height', label: '키' }, { key: 'length', label: '길이' }, { key: 'weight', label: '무게' },
                { key: 'temp', label: '온도' }, { key: 'speed', label: '속도' }, { key: 'volume', label: '부피' },
                { key: 'age', label: '나이' }, { key: 'dday', label: 'D-day' }, { key: 'usd', label: '$' }, { key: 'gbp', label: '£' },
            ];
            // 탭을 오가도 패널을 닫기 전까지는 입력 상태가 남아있게 — 카테고리별 스냅샷
            const catState = {};

            function numInput(width) {
                const i = document.createElement('input'); i.type = 'text'; i.inputMode = 'decimal';
                i.autocomplete = 'off'; i.autocorrect = 'off'; i.autocapitalize = 'off'; i.spellcheck = false;
                i.style.cssText = `width:${width}px;height:26px;line-height:26px;box-sizing:border-box;padding:0 6px;font-size:13px;border:1px solid var(--ws-border) !important;border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;text-align:right;`;
                return i;
            }
            function unitSelect(defs, selected) {
                const s = document.createElement('select');
                s.style.cssText = 'padding:5px 6px;font-size:12px;border:1px solid var(--ws-border) !important;border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;';
                Object.entries(defs).forEach(([key, def]) => {
                    const o = document.createElement('option'); o.value = key; o.textContent = def.label;
                    if (key === selected) o.selected = true;
                    s.appendChild(o);
                });
                return s;
            }
            // 단위가 하나로 고정인 카테고리(무게/길이/온도/속도)용 — 드롭다운 대신 그냥 라벨
            function unitLabel(text) {
                const s = document.createElement('span'); s.textContent = text;
                s.style.cssText = 'color:var(--ws-text2);flex-shrink:0;font-size:12px;';
                return s;
            }
            // 양방향 아이콘
            function arrowSpan() {
                const s = document.createElement('span'); s.innerHTML = '<i class="fa-solid fa-right-left"></i>';
                s.style.cssText = 'color:var(--ws-text2);flex-shrink:0;font-size:13px;margin:0 4px;';
                return s;
            }
            function clearButton() {
                const b = document.createElement('button'); b.className = 'ws-btn'; b.title = '입력값 지우기';
                b.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i>';
                b.style.cssText = 'padding:5px 10px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;';
                return b;
            }
            function wordsLine(maxWidth) {
                const d = document.createElement('div');
                d.style.cssText = `font-size:9px;color:var(--SmartThemeQuoteColor, var(--ws-text2));max-width:${maxWidth}px;` +
                    'text-align:center;line-height:1.3;min-height:1.1em;margin-top:2px;word-break:keep-all;';
                return d;
            }

            // ── 무게/길이/온도/속도 — 단위 두 개 고정, 양쪽 다 입력 가능(양방향 계산) ──
            function renderFixedPair(catKey) {
                const cat = WS_UNIT_DEFS[catKey];
                const keys = Object.keys(cat.units);
                const fromDef = cat.units[keys[0]], toDef = cat.units[keys[1]];
                content.innerHTML = '';
                const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;';
                content.appendChild(row);
                const saved = catState[catKey] || {};

                const leftInput = numInput(56), leftLbl = unitLabel(fromDef.label);
                const arrow = arrowSpan();
                const rightInput = numInput(56), rightLbl = unitLabel(toDef.label);
                const clearBtn = clearButton();
                row.appendChild(leftInput); row.appendChild(leftLbl); row.appendChild(arrow);
                row.appendChild(rightInput); row.appendChild(rightLbl); row.appendChild(clearBtn);

                let updating = false, lastSide = saved.lastSide || 'left';
                function persist() { catState[catKey] = { leftVal: leftInput.value, rightVal: rightInput.value, lastSide }; }
                function fromLeft() {
                    const v = parseFloat(leftInput.value);
                    updating = true;
                    rightInput.value = isNaN(v) ? '' : formatNum(toDef.fromBase(fromDef.toBase(v)));
                    updating = false; persist();
                }
                function fromRight() {
                    const v = parseFloat(rightInput.value);
                    updating = true;
                    leftInput.value = isNaN(v) ? '' : formatNum(fromDef.fromBase(toDef.toBase(v)));
                    updating = false; persist();
                }
                leftInput.addEventListener('input', () => { lastSide = 'left'; if (!updating) fromLeft(); });
                rightInput.addEventListener('input', () => { lastSide = 'right'; if (!updating) fromRight(); });
                clearBtn.addEventListener('click', () => { leftInput.value = ''; rightInput.value = ''; persist(); leftInput.focus(); });

                if (saved.lastSide === 'right' && saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
                else if (saved.leftVal) { lastSide = 'left'; leftInput.value = saved.leftVal; fromLeft(); }
                else if (saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
            }

            // ── 부피 — 단위 4개라 드롭다운 유지, 양쪽 다 입력 가능(마지막으로 건드린 쪽 기준 재계산) ──
            function renderStandard(catKey) {
                const cat = WS_UNIT_DEFS[catKey];
                content.innerHTML = '';
                const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;';
                content.appendChild(row);
                const keys = Object.keys(cat.units);
                const saved = catState[catKey] || {};

                const leftInput = numInput(56);
                const fromSel = unitSelect(cat.units, saved.fromUnit ?? keys[0]); // 미국 단위가 항상 왼쪽 디폴트
                const arrow = arrowSpan();
                const rightInput = numInput(56);
                const toSel = unitSelect(cat.units, saved.toUnit ?? keys[1] ?? keys[0]);
                const clearBtn = clearButton();
                row.appendChild(leftInput); row.appendChild(fromSel); row.appendChild(arrow);
                row.appendChild(rightInput); row.appendChild(toSel); row.appendChild(clearBtn);

                let updating = false, lastSide = saved.lastSide || 'left';
                function persist() { catState[catKey] = { leftVal: leftInput.value, rightVal: rightInput.value, fromUnit: fromSel.value, toUnit: toSel.value, lastSide }; }
                function fromLeft() {
                    const v = parseFloat(leftInput.value);
                    const fromDef = cat.units[fromSel.value], toDef = cat.units[toSel.value];
                    updating = true;
                    rightInput.value = isNaN(v) ? '' : formatNum(toDef.fromBase(fromDef.toBase(v)));
                    updating = false; persist();
                }
                function fromRight() {
                    const v = parseFloat(rightInput.value);
                    const fromDef = cat.units[fromSel.value], toDef = cat.units[toSel.value];
                    updating = true;
                    leftInput.value = isNaN(v) ? '' : formatNum(fromDef.fromBase(toDef.toBase(v)));
                    updating = false; persist();
                }
                leftInput.addEventListener('input', () => { lastSide = 'left'; if (!updating) fromLeft(); });
                rightInput.addEventListener('input', () => { lastSide = 'right'; if (!updating) fromRight(); });
                fromSel.addEventListener('change', () => { lastSide === 'left' ? fromLeft() : fromRight(); });
                toSel.addEventListener('change', () => { lastSide === 'left' ? fromLeft() : fromRight(); });
                clearBtn.addEventListener('click', () => { leftInput.value = ''; rightInput.value = ''; persist(); leftInput.focus(); });

                if (saved.lastSide === 'right' && saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
                else if (saved.leftVal) { lastSide = 'left'; leftInput.value = saved.leftVal; fromLeft(); }
                else if (saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
            }

            // ── 키 — ft+in ↔ cm, 셋 다 입력 가능(양방향) ──
            function renderHeight() {
                content.innerHTML = '';
                const saved = catState.height || {};
                const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;';
                content.appendChild(row);

                const ft = numInput(34), inch = numInput(38);
                const ftLbl = document.createElement('span'); ftLbl.textContent = "'"; ftLbl.style.color = 'var(--ws-text2)';
                const inLbl = document.createElement('span'); inLbl.textContent = '"'; inLbl.style.color = 'var(--ws-text2)';
                const arrow = arrowSpan();
                const cm = numInput(56), cmLbl = unitLabel('cm');
                const clearBtn = clearButton();
                row.appendChild(ft); row.appendChild(ftLbl); row.appendChild(inch); row.appendChild(inLbl);
                row.appendChild(arrow); row.appendChild(cm); row.appendChild(cmLbl); row.appendChild(clearBtn);

                let updating = false, lastSide = saved.lastSide || 'ftin';
                function persist() { catState.height = { ftVal: ft.value, inVal: inch.value, cmVal: cm.value, lastSide }; }
                function fromFtIn() {
                    const f = parseFloat(ft.value) || 0, i = parseFloat(inch.value) || 0;
                    updating = true;
                    cm.value = (!ft.value && !inch.value) ? '' : formatNum((f * 12 + i) * 2.54);
                    updating = false; persist();
                }
                function fromCm() {
                    const v = parseFloat(cm.value);
                    updating = true;
                    if (isNaN(v)) { ft.value = ''; inch.value = ''; }
                    else {
                        const totalIn = v / 2.54;
                        let f = Math.floor(totalIn / 12), i = Math.round((totalIn - f * 12) * 100) / 100;
                        if (i >= 12) { f += 1; i -= 12; }
                        ft.value = f; inch.value = i.toFixed(2);
                    }
                    updating = false; persist();
                }
                ft.addEventListener('input', () => { lastSide = 'ftin'; if (!updating) fromFtIn(); });
                inch.addEventListener('input', () => { lastSide = 'ftin'; if (!updating) fromFtIn(); });
                cm.addEventListener('input', () => { lastSide = 'cm'; if (!updating) fromCm(); });
                clearBtn.addEventListener('click', () => { ft.value = ''; inch.value = ''; cm.value = ''; persist(); ft.focus(); });

                if (saved.lastSide === 'cm' && saved.cmVal) { lastSide = 'cm'; cm.value = saved.cmVal; fromCm(); }
                else if (saved.ftVal || saved.inVal) { lastSide = 'ftin'; ft.value = saved.ftVal || ''; inch.value = saved.inVal || ''; fromFtIn(); }
                else if (saved.cmVal) { lastSide = 'cm'; cm.value = saved.cmVal; fromCm(); }
            }

            // ── $ / £ — 원화 환율(사용자 입력, 로컬 저장) 양방향 + 한글/영어 숫자 읽기 ──
            function renderCurrency(catKey) {
                const def = CURRENCY_DEFS[catKey];
                content.innerHTML = '';
                const saved = catState[catKey] || {};
                const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;';
                content.appendChild(wrap);

                // 환율 입력 줄 — 아주 작은 글씨, 사용자가 직접 값 조정, 로컬 저장(wsSettings).
                // 계산 영역보다 위에 둠.
                const rateRow = document.createElement('div'); rateRow.style.cssText = 'font-size:10px;color:var(--ws-text2);display:flex;align-items:center;gap:4px;';
                const rateLbl1 = document.createElement('span'); rateLbl1.textContent = `1 ${def.code} =`;
                const rateInput = document.createElement('input'); rateInput.type = 'text'; rateInput.inputMode = 'decimal';
                rateInput.style.cssText = 'width:56px;height:18px;line-height:18px;box-sizing:border-box;padding:0 4px;font-size:10px;border:1px solid var(--ws-border) !important;border-radius:4px;background:var(--ws-panel2);color:var(--ws-text);outline:none;text-align:right;';
                rateInput.value = wsSettings[def.rateKey] ?? def.defaultRate;
                const rateLbl2 = document.createElement('span'); rateLbl2.textContent = 'KRW';
                rateRow.appendChild(rateLbl1); rateRow.appendChild(rateInput); rateRow.appendChild(rateLbl2);
                wrap.appendChild(rateRow);

                const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:flex-start;justify-content:center;gap:8px;flex-wrap:wrap;';
                wrap.appendChild(row);

                const leftCol = document.createElement('div'); leftCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;';
                const leftInput = numInput(72), leftLbl = unitLabel(`${def.symbol} ${def.code}`);
                const leftWords = wordsLine(120);
                leftCol.appendChild(leftInput); leftCol.appendChild(leftLbl); leftCol.appendChild(leftWords);

                const arrow = arrowSpan(); arrow.style.marginTop = '9px';

                const rightCol = document.createElement('div'); rightCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;';
                const rightInput = numInput(82), rightLbl = unitLabel('₩ KRW');
                const rightWords = wordsLine(140);
                rightCol.appendChild(rightInput); rightCol.appendChild(rightLbl); rightCol.appendChild(rightWords);

                const clearBtn = clearButton(); clearBtn.style.marginTop = '2px';
                row.appendChild(leftCol); row.appendChild(arrow); row.appendChild(rightCol); row.appendChild(clearBtn);

                let updating = false, lastSide = saved.lastSide || 'left';
                function persist() { catState[catKey] = { leftVal: leftInput.value, rightVal: rightInput.value, lastSide }; }
                function currentRate() { return parseFloat(rateInput.value) || def.defaultRate; }
                function fromLeft() {
                    const v = parseFloat(leftInput.value), rate = currentRate();
                    if (isNaN(v)) { updating = true; rightInput.value = ''; updating = false; leftWords.textContent = ''; rightWords.textContent = ''; persist(); return; }
                    updating = true; rightInput.value = formatNum(v * rate); updating = false;
                    leftWords.textContent = englishNumberWords(v);
                    rightWords.textContent = koreanNumberWords(parseFloat(rightInput.value) || 0) + '원';
                    persist();
                }
                function fromRight() {
                    const v = parseFloat(rightInput.value), rate = currentRate();
                    if (isNaN(v)) { updating = true; leftInput.value = ''; updating = false; leftWords.textContent = ''; rightWords.textContent = ''; persist(); return; }
                    updating = true; leftInput.value = formatNum(v / rate); updating = false;
                    rightWords.textContent = koreanNumberWords(v) + '원';
                    leftWords.textContent = englishNumberWords(parseFloat(leftInput.value) || 0);
                    persist();
                }
                leftInput.addEventListener('input', () => { lastSide = 'left'; if (!updating) fromLeft(); });
                rightInput.addEventListener('input', () => { lastSide = 'right'; if (!updating) fromRight(); });
                rateInput.addEventListener('input', () => {
                    const r = parseFloat(rateInput.value);
                    if (!isNaN(r) && r > 0) { wsSettings[def.rateKey] = r; saveWsSettings(); }
                    if (lastSide === 'left') fromLeft(); else fromRight();
                });
                clearBtn.addEventListener('click', () => {
                    leftInput.value = ''; rightInput.value = ''; leftWords.textContent = ''; rightWords.textContent = ''; persist(); leftInput.focus();
                });

                if (saved.lastSide === 'right' && saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
                else if (saved.leftVal) { lastSide = 'left'; leftInput.value = saved.leftVal; fromLeft(); }
                else if (saved.rightVal) { lastSide = 'right'; rightInput.value = saved.rightVal; fromRight(); }
            }

            function dateInputBox() {
                const i = document.createElement('input');
                i.type = 'date';
                i.style.cssText = 'height:28px;line-height:28px;box-sizing:border-box;padding:0 6px;font-size:12px;border:1px solid rgba(0,0,0,0.28) !important;border-radius:6px;background:#fff;outline:none;color:#111;';
                return i;
            }
            function parseIsoDate(str) {
                const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str ?? '').trim());
                if (!m) return null;
                const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
                const dt = new Date(Date.UTC(y, mo - 1, d));
                if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
                return { y, m: mo, d };
            }
            function formatIsoDate(y, m, d) {
                return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
            function todayIsoString() {
                const now = new Date();
                return formatIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
            }

            // ── 나이 — 생년월일 입력 → 만 나이 / 한국식 나이 계산 ──
            function renderAge() {
                content.innerHTML = '';
                const saved = catState.age || {};
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;';
                content.appendChild(wrap);

                const inputRow = document.createElement('div');
                inputRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
                wrap.appendChild(inputRow);

                const lbl = document.createElement('span');
                lbl.textContent = '생년월일';
                lbl.style.cssText = 'font-size:12px;color:var(--ws-text2);';

                const dateInput = dateInputBox();
                dateInput.style.padding = '0 8px';
                dateInput.style.fontSize = '13px';

                const clearBtn = clearButton();
                clearBtn.style.padding = '4px 8px';
                inputRow.appendChild(lbl);
                inputRow.appendChild(dateInput);
                inputRow.appendChild(clearBtn);

                const resultBox = document.createElement('div');
                resultBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:2px;';
                wrap.appendChild(resultBox);

                const primaryAge = document.createElement('div');
                primaryAge.style.cssText = 'font-size:16px;font-weight:700;color:var(--SmartThemeQuoteColor, currentColor);min-height:24px;';
                resultBox.appendChild(primaryAge);

                const detailLine = document.createElement('div');
                detailLine.style.cssText = 'font-size:11.5px;color:var(--ws-text2);min-height:16px;';
                resultBox.appendChild(detailLine);

                function calculate() {
                    const val = dateInput.value;
                    catState.age = { dateStr: val };
                    if (!val) {
                        primaryAge.textContent = '생일을 선택하거나 입력하세요';
                        primaryAge.style.fontSize = '12px';
                        primaryAge.style.fontWeight = 'normal';
                        primaryAge.style.opacity = '0.6';
                        detailLine.textContent = '';
                        return;
                    }
                    primaryAge.style.fontSize = '16px';
                    primaryAge.style.fontWeight = '700';
                    primaryAge.style.opacity = '1';

                    const parsed = parseIsoDate(val);
                    if (!parsed) {
                        primaryAge.textContent = '올바른 날짜를 입력하세요';
                        detailLine.textContent = '';
                        return;
                    }
                    const { y, m, d } = parsed;

                    const today = new Date();
                    const cy = today.getFullYear();
                    const cm = today.getMonth() + 1;
                    const cd = today.getDate();

                    const bdayPassed = (cm > m) || (cm === m && cd >= d);
                    const manAge = cy - y - (bdayPassed ? 0 : 1);
                    const koreanAge = cy - y + 1; // 전통 한국식 세는나이

                    primaryAge.textContent = `${koreanAge}세 (만 ${manAge}세)`;

                    // 띠 계산
                    const animals = ['원숭이', '닭', '개', '돼지', '쥐', '소', '호랑이', '토끼', '용', '뱀', '말', '양'];
                    const animal = animals[((y % 12) + 12) % 12];

                    // 별자리 계산
                    const zodiacs = [
                        { name: '염소자리 (Capricorn)', m: 1, d: 19 },
                        { name: '물병자리 (Aquarius)', m: 2, d: 18 },
                        { name: '물고기자리 (Pisces)', m: 3, d: 20 },
                        { name: '양자리 (Aries)', m: 4, d: 19 },
                        { name: '황소자리 (Taurus)', m: 5, d: 20 },
                        { name: '쌍둥이자리 (Gemini)', m: 6, d: 21 },
                        { name: '게자리 (Cancer)', m: 7, d: 22 },
                        { name: '사자자리 (Leo)', m: 8, d: 22 },
                        { name: '처녀자리 (Virgo)', m: 9, d: 23 },
                        { name: '천칭자리 (Libra)', m: 10, d: 22 },
                        { name: '전갈자리 (Scorpio)', m: 11, d: 22 },
                        { name: '사수자리 (Sagittarius)', m: 12, d: 24 },
                        { name: '염소자리 (Capricorn)', m: 12, d: 31 }
                    ];
                    let zodiac = '염소자리 (Capricorn)';
                    for (const z of zodiacs) {
                        if (m < z.m || (m === z.m && d <= z.d)) { zodiac = z.name; break; }
                    }

                    // 다음 생일 D-day 계산 (DST 오차 방지 UTC 자정 기준, 윤년 2/29 생일 처리)
                    const isLeapYear = yr => (yr % 4 === 0 && yr % 100 !== 0) || (yr % 400 === 0);
                    let nextYear = cy;
                    if (m === 2 && d === 29) {
                        if (cm > 2 || (cm === 2 && (isLeapYear(cy) ? cd > 29 : true))) {
                            nextYear += 1;
                        }
                        while (!isLeapYear(nextYear)) nextYear += 1;
                    } else if (cm > m || (cm === m && cd > d)) {
                        nextYear += 1;
                    }
                    const oneDay = 24 * 60 * 60 * 1000;
                    const diffDays = Math.round((Date.UTC(nextYear, m - 1, d) - Date.UTC(cy, cm - 1, cd)) / oneDay);
                    const dDayStr = (cm === m && cd === d) ? '오늘 생일 🎂' : `생일 D-${diffDays}`;

                    detailLine.textContent = `${animal}띠 · ${zodiac} · ${dDayStr}`;
                }

                dateInput.addEventListener('input', calculate);
                dateInput.addEventListener('change', calculate);
                clearBtn.addEventListener('click', () => {
                    dateInput.value = '';
                    catState.age = { dateStr: '' };
                    calculate();
                    dateInput.focus();
                });

                if (saved.dateStr) {
                    dateInput.value = saved.dateStr;
                }
                calculate();
            }

            // ── D-day — 기준일(기본 오늘) ↔ 대상일 계산 + 일수(+/-) 역산 ──
            function renderDday() {
                content.innerHTML = '';
                const ONE_DAY = 24 * 60 * 60 * 1000;
                const saved = catState.dday || {};
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;';
                content.appendChild(wrap);

                // 상단: [기준일] ↔ [대상일] + 초기화
                const dateRow = document.createElement('div');
                dateRow.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;gap:6px;flex-wrap:wrap;';
                wrap.appendChild(dateRow);

                function makeDateCol(labelText, extraBtn = null) {
                    const col = document.createElement('div');
                    col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;';
                    const head = document.createElement('div');
                    head.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--ws-text2);';
                    const lbl = document.createElement('span');
                    lbl.textContent = labelText;
                    head.appendChild(lbl);
                    if (extraBtn) head.appendChild(extraBtn);
                    const inp = dateInputBox();
                    col.appendChild(head);
                    col.appendChild(inp);
                    return { col, inp };
                }

                const todayBtn = document.createElement('button');
                todayBtn.type = 'button';
                todayBtn.className = 'ws-btn';
                todayBtn.textContent = '오늘';
                todayBtn.title = '기준일을 오늘로 맞추기';
                todayBtn.style.cssText = 'padding:1px 5px;font-size:9.5px;line-height:1.2;border-radius:4px;';

                const { col: baseCol, inp: baseInput } = makeDateCol('기준일', todayBtn);
                const arrow = arrowSpan();
                arrow.style.marginBottom = '5px';
                const { col: targetCol, inp: targetInput } = makeDateCol('대상일');

                const clearBtn = clearButton();
                clearBtn.style.cssText += 'height:28px;padding:0 9px;box-sizing:border-box;';

                dateRow.appendChild(baseCol);
                dateRow.appendChild(arrow);
                dateRow.appendChild(targetCol);
                dateRow.appendChild(clearBtn);

                // 중단: 기준일 대비 일수 입력 (+100, -50 등)
                const offsetRow = document.createElement('div');
                offsetRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
                wrap.appendChild(offsetRow);

                const offsetInput = document.createElement('input');
                offsetInput.type = 'text';
                offsetInput.autocomplete = 'off'; offsetInput.autocorrect = 'off'; offsetInput.autocapitalize = 'off'; offsetInput.spellcheck = false;
                offsetInput.style.cssText = 'width:76px;height:26px;line-height:26px;box-sizing:border-box;padding:0 6px;font-size:12.5px;border:1px solid var(--ws-border) !important;border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;text-align:right;';

                const unitDay = unitLabel('일');
                offsetRow.appendChild(offsetInput);
                offsetRow.appendChild(unitDay);

                // 하단: D-day 결과
                const primaryLine = document.createElement('div');
                primaryLine.style.cssText = 'font-size:16px;font-weight:700;color:var(--SmartThemeQuoteColor, currentColor);min-height:24px;margin-top:2px;';
                wrap.appendChild(primaryLine);

                let lastSide = saved.lastSide || 'dates';
                baseInput.value = saved.baseStr || todayIsoString();
                targetInput.value = saved.targetStr || '';
                offsetInput.value = saved.offsetStr || '';

                function syncTodayBtn() {
                    const isToday = baseInput.value === todayIsoString();
                    todayBtn.style.opacity = isToday ? '0.45' : '1';
                }
                function persist() {
                    catState.dday = {
                        baseStr: baseInput.value,
                        targetStr: targetInput.value,
                        offsetStr: offsetInput.value,
                        lastSide,
                    };
                }
                function setHint(text) {
                    primaryLine.textContent = text;
                    primaryLine.style.fontSize = '12px';
                    primaryLine.style.fontWeight = 'normal';
                    primaryLine.style.opacity = '0.6';
                }
                function renderResult(diffDays) {
                    primaryLine.style.fontSize = '16px';
                    primaryLine.style.fontWeight = '700';
                    primaryLine.style.opacity = '1';
                    primaryLine.textContent = diffDays === 0
                        ? 'D-Day'
                        : (diffDays > 0 ? `D-${diffDays}` : `D+${Math.abs(diffDays)}`);
                }

                function calcFromDates() {
                    syncTodayBtn();
                    const base = parseIsoDate(baseInput.value);
                    const target = parseIsoDate(targetInput.value);
                    if (!targetInput.value || !base) {
                        offsetInput.value = '';
                        setHint('날짜나 일수를 입력하세요');
                        persist();
                        return;
                    }
                    if (!target) {
                        setHint('올바른 날짜를 입력하세요');
                        persist();
                        return;
                    }
                    const diffDays = Math.round(
                        (Date.UTC(target.y, target.m - 1, target.d) - Date.UTC(base.y, base.m - 1, base.d)) / ONE_DAY
                    );
                    offsetInput.value = String(diffDays);
                    renderResult(diffDays);
                    persist();
                }

                function calcFromOffset() {
                    syncTodayBtn();
                    const raw = offsetInput.value.trim();
                    if (!raw) {
                        targetInput.value = '';
                        setHint('날짜나 일수를 입력하세요');
                        persist();
                        return;
                    }
                    if (raw === '-' || raw === '+') {
                        persist();
                        return;
                    }
                    if (!/^[+-]?\d+$/.test(raw)) {
                        setHint('정수 일수를 입력하세요');
                        persist();
                        return;
                    }
                    const base = parseIsoDate(baseInput.value);
                    if (!base) {
                        targetInput.value = '';
                        setHint('기준일을 먼저 선택하세요');
                        persist();
                        return;
                    }
                    const offset = parseInt(raw, 10);
                    const targetDt = new Date(Date.UTC(base.y, base.m - 1, base.d + offset));
                    const ty = targetDt.getUTCFullYear();
                    const tm = targetDt.getUTCMonth() + 1;
                    const td = targetDt.getUTCDate();
                    if (ty < 1 || ty > 9999) {
                        targetInput.value = '';
                        setHint('표시 가능한 날짜 범위를 벗어났습니다');
                        persist();
                        return;
                    }
                    targetInput.value = formatIsoDate(ty, tm, td);
                    renderResult(offset);
                    persist();
                }

                targetInput.addEventListener('input', () => { lastSide = 'dates'; calcFromDates(); });
                targetInput.addEventListener('change', () => { lastSide = 'dates'; calcFromDates(); });
                baseInput.addEventListener('input', () => { lastSide === 'offset' ? calcFromOffset() : calcFromDates(); });
                baseInput.addEventListener('change', () => { lastSide === 'offset' ? calcFromOffset() : calcFromDates(); });
                offsetInput.addEventListener('input', () => { lastSide = 'offset'; calcFromOffset(); });
                todayBtn.addEventListener('click', () => {
                    baseInput.value = todayIsoString();
                    lastSide === 'offset' ? calcFromOffset() : calcFromDates();
                });
                clearBtn.addEventListener('click', () => {
                    baseInput.value = todayIsoString();
                    targetInput.value = '';
                    offsetInput.value = '';
                    lastSide = 'dates';
                    calcFromDates();
                });

                if (lastSide === 'offset' && offsetInput.value.trim()) calcFromOffset();
                else calcFromDates();
            }

            function renderCategory(catKey) {
                Array.from(tabRow.children).forEach(b => b.classList.toggle('ws-btn-accent', b.dataset.cat === catKey));
                if (catKey === 'height') renderHeight();
                else if (catKey === 'volume') renderStandard(catKey);
                else if (catKey === 'age') renderAge();
                else if (catKey === 'dday') renderDday();
                else if (catKey === 'usd' || catKey === 'gbp') renderCurrency(catKey);
                else renderFixedPair(catKey);
            }

            CATS.forEach(({ key, label }) => {
                const b = document.createElement('button'); b.className = 'ws-btn'; b.textContent = label; b.dataset.cat = key;
                b.style.cssText = 'padding:3px 5px;font-size:11px;';
                b.addEventListener('click', () => renderCategory(key));
                tabRow.appendChild(b);
            });
            renderCategory('height');
            return '';
        },
    }));
}

// ─── /edit ──────────────────────────────────────────────────────────────────
// 왼쪽 사이드, find 첫 패널(createPanel 기본 위치)과 같은 y값에 고정으로 뜨는 패널
function closeEditModePanel() { document.getElementById('ws-editmode-panel')?.remove(); }

function openEditModePanel() {
    closeEditModePanel();
    const panel = document.createElement('div'); panel.id = 'ws-editmode-panel'; panel.className = 'popup ws-panel';
    panel.style.cssText = `position:fixed;left:14px;top:0;
        background:var(--ws-panel);color:var(--ws-text);
        border:1px solid var(--ws-border);border-radius:var(--ws-radius);
        box-shadow:0 4px 16px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.04);
        display:flex;flex-direction:column;max-height:72vh;
        font-size:13px;font-family:inherit;width:160px;opacity:0;overflow:hidden;`;

    // 패널 내 클릭이 ST 드로어 바깥 클릭 닫힘을 유발하지 않도록 차단
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });
    panel.addEventListener('pointerdown', () => raiseToTop(panel));

    const header = document.createElement('div');
    header.style.cssText = 'position:relative;display:flex;align-items:center;gap:6px;padding:12px 10px 4px;cursor:grab;touch-action:none;min-height:26px;';

    const mkHeaderLine = () => {
        const s = document.createElement('span');
        s.style.cssText = 'flex:1;border-top:1px dotted var(--ws-border);opacity:0.55;';
        return s;
    };
    const titleText = document.createElement('span');
    titleText.textContent = '채팅검색';
    titleText.style.cssText = 'font-size:10px;color:var(--ws-text2);opacity:0.6;letter-spacing:0.02em;white-space:nowrap;';

    const rightLine = mkHeaderLine();
    rightLine.style.marginRight = '16px';

    header.appendChild(mkHeaderLine());
    header.appendChild(titleText);
    header.appendChild(rightLine);

    const closeBtn = document.createElement('button'); closeBtn.textContent = '✕';
    closeBtn.style.cssText = `position:absolute;right:6px;top:8px;background:var(--ws-panel);border:none;color:var(--ws-text2);
        font-size:12px;font-family:inherit;cursor:pointer;width:20px;height:20px;z-index:2;
        display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;`;
    closeBtn.addEventListener('pointerenter', () => { closeBtn.style.background = 'rgba(0,0,0,0.05)'; });
    closeBtn.addEventListener('pointerleave', () => { closeBtn.style.background = 'var(--ws-panel)'; });
    closeBtn.addEventListener('pointerdown', e => e.stopPropagation());
    closeBtn.addEventListener('click', () => closeEditModePanel());
    header.appendChild(closeBtn);
    panel.appendChild(header);
    makeDraggable(panel, header);

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:2px 10px 14px;flex:1;min-height:0;overflow-y:auto;';
    panel.appendChild(body);

    function makeRow(labelText) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        lbl.style.whiteSpace = 'nowrap';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode(labelText));
        body.appendChild(lbl); return chk;
    }

    function makeSectionDivider(label) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0 0;';
        const mkLine = () => { const s = document.createElement('span'); s.style.cssText = 'flex:1;border-top:1px dotted var(--ws-border);opacity:0.55;'; return s; };
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-size:10px;color:var(--ws-text2);opacity:0.6;letter-spacing:0.02em;white-space:nowrap;';
        lbl.textContent = label;
        row.appendChild(mkLine()); row.appendChild(lbl); row.appendChild(mkLine());
        body.appendChild(row);
        return row;
    }

    // ─── 채팅 검색 전역 옵션 ─────────────────────────────────────────────────
    const reasoningChk = makeRow('추론 블럭 무시');
    reasoningChk.checked = wsSettings.ignoreReasoningBlocks;
    reasoningChk.addEventListener('change', () => { wsSettings.ignoreReasoningBlocks = reasoningChk.checked; saveWsSettings(); });

    const translationChk = makeRow('번역문 우선');
    translationChk.checked = wsSettings.translationSearchEnabled;
    translationChk.addEventListener('change', () => { wsSettings.translationSearchEnabled = translationChk.checked; saveWsSettings(); });

    // ─── 하이라이트 ─────────────────────────────────────────────────────────
    makeSectionDivider('하이라이트');

    const FOCUS_HL_STYLE = 'background:var(--ws-hl-cur-bg);color:var(--ws-hl-cur-color);padding:0 2px;border-radius:2px;';
    const NORMAL_HL_STYLE = 'background:var(--ws-hl-color);color:inherit;padding:0 2px;border-radius:2px;';

    const posRow = document.createElement('div');
    posRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px;';
    const posLbl = document.createElement('label'); posLbl.className = 'ws-label';
    posLbl.style.cssText = 'gap:4px;white-space:nowrap;';
    const posChk = document.createElement('input'); posChk.type = 'checkbox'; posChk.className = 'ws-check';
    const posHlWord = document.createElement('span'); posHlWord.textContent = '하이라이트'; posHlWord.style.cssText = FOCUS_HL_STYLE;
    posLbl.appendChild(posChk); posLbl.appendChild(posHlWord);
    const posInput = document.createElement('input'); posInput.type = 'text';
    posInput.className = 'ws-range-input';
    posInput.autocomplete = 'off'; posInput.autocorrect = 'off'; posInput.autocapitalize = 'off'; posInput.spellcheck = false;
    posInput.style.cssText = 'width:32px;box-sizing:border-box;padding:2px 4px;font-size:11px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border:1px solid var(--ws-border);border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;flex-shrink:0;text-align:right;';
    if (Number.isInteger(WS_DEFAULT_HL_POSITION_PERCENT)) posInput.placeholder = String(WS_DEFAULT_HL_POSITION_PERCENT);
    posInput.value = wsSettings.hlPositionEnabled ? String(wsSettings.hlPositionPercent) : '';
    posChk.checked = wsSettings.hlPositionEnabled;
    posChk.addEventListener('change', () => {
        wsSettings.hlPositionEnabled = posChk.checked;
        posInput.value = wsSettings.hlPositionEnabled ? String(wsSettings.hlPositionPercent) : '';
        saveWsSettings();
    });
    posInput.addEventListener('input', () => {
        const raw = posInput.value.trim();
        if (!/^\d+(\.\d+)?$/.test(raw)) return;
        const n = Number(raw);
        if (n < 0 || n > 100) return;
        wsSettings.hlPositionPercent = n;
        saveWsSettings();
    });
    posRow.appendChild(posLbl); posRow.appendChild(posInput);
    body.appendChild(posRow);

    const hlCurLbl = document.createElement('label'); hlCurLbl.className = 'ws-label';
    hlCurLbl.style.cssText = 'gap:4px;white-space:nowrap;';
    const hlCurChk = document.createElement('input'); hlCurChk.type = 'checkbox'; hlCurChk.className = 'ws-check';
    const hlCurWord = document.createElement('span'); hlCurWord.textContent = '하이라이트'; hlCurWord.style.cssText = FOCUS_HL_STYLE;
    hlCurLbl.appendChild(hlCurChk); hlCurLbl.appendChild(hlCurWord); hlCurLbl.appendChild(document.createTextNode(' 변경'));
    body.appendChild(hlCurLbl);
    hlCurChk.checked = wsSettings.hlCurEnabled;
    hlCurChk.addEventListener('change', () => { wsSettings.hlCurEnabled = hlCurChk.checked; applyWsHlCurColor(); saveWsSettings(); });

    const hlCurRgbaRow = document.createElement('div');
    hlCurRgbaRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const hlCurColorInput = document.createElement('input'); hlCurColorInput.type = 'color';
    hlCurColorInput.value = wsSettings.hlCurRgb;
    hlCurColorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const hlCurAlphaInput = document.createElement('input'); hlCurAlphaInput.type = 'range'; hlCurAlphaInput.min = '0'; hlCurAlphaInput.max = '100';
    hlCurAlphaInput.value = String(wsSettings.hlCurAlpha);
    hlCurAlphaInput.style.cssText = 'flex:1;';
    const onHlCurColorChange = () => {
        wsSettings.hlCurRgb = hlCurColorInput.value; wsSettings.hlCurAlpha = parseInt(hlCurAlphaInput.value, 10);
        applyWsHlCurColor(); saveWsSettings();
    };
    hlCurColorInput.addEventListener('input', onHlCurColorChange);
    hlCurAlphaInput.addEventListener('input', onHlCurColorChange);
    hlCurRgbaRow.appendChild(hlCurColorInput); hlCurRgbaRow.appendChild(hlCurAlphaInput);
    body.appendChild(hlCurRgbaRow);

    const hlLbl = document.createElement('label'); hlLbl.className = 'ws-label';
    hlLbl.style.cssText = 'gap:4px;white-space:nowrap;';
    const hlChk = document.createElement('input'); hlChk.type = 'checkbox'; hlChk.className = 'ws-check';
    const hlWord = document.createElement('span'); hlWord.textContent = '하이라이트'; hlWord.style.cssText = NORMAL_HL_STYLE;
    hlLbl.appendChild(hlChk); hlLbl.appendChild(hlWord); hlLbl.appendChild(document.createTextNode(' 변경'));
    body.appendChild(hlLbl);
    hlChk.checked = wsSettings.hlEnabled;
    hlChk.addEventListener('change', () => { wsSettings.hlEnabled = hlChk.checked; applyWsHlColor(); saveWsSettings(); });

    const rgbaRow = document.createElement('div');
    rgbaRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const colorInput = document.createElement('input'); colorInput.type = 'color';
    colorInput.value = wsSettings.hlRgb;
    colorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const alphaInput = document.createElement('input'); alphaInput.type = 'range'; alphaInput.min = '0'; alphaInput.max = '100';
    alphaInput.value = String(wsSettings.hlAlpha);
    alphaInput.style.cssText = 'flex:1;';
    const onColorChange = () => {
        wsSettings.hlRgb = colorInput.value; wsSettings.hlAlpha = parseInt(alphaInput.value, 10);
        applyWsHlColor(); saveWsSettings();
    };
    colorInput.addEventListener('input', onColorChange);
    alphaInput.addEventListener('input', onColorChange);
    rgbaRow.appendChild(colorInput); rgbaRow.appendChild(alphaInput);
    body.appendChild(rgbaRow);

    // ─── 스티키 노트 ────────────────────────────────────────────────────────
    makeSectionDivider('스티키 노트');
    const stickyRow = document.createElement('div');
    stickyRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const stickyColorInput = document.createElement('input'); stickyColorInput.type = 'color';
    stickyColorInput.value = stickyData.rgb;
    stickyColorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const stickyAlphaInput = document.createElement('input'); stickyAlphaInput.type = 'range'; stickyAlphaInput.min = '0'; stickyAlphaInput.max = '100';
    stickyAlphaInput.value = String(stickyData.alpha);
    stickyAlphaInput.style.cssText = 'flex:1;';
    const onStickyColorChange = () => {
        stickyData.rgb = stickyColorInput.value; stickyData.alpha = parseInt(stickyAlphaInput.value, 10);
        applyStickyColor();
    };
    // 조작 중엔 미리보기만 갱신하고, 확정(change) 시 저장
    stickyColorInput.addEventListener('input', onStickyColorChange);
    stickyAlphaInput.addEventListener('input', onStickyColorChange);
    stickyColorInput.addEventListener('change', () => persistStickyUI());
    stickyAlphaInput.addEventListener('change', () => persistStickyUI());
    stickyRow.appendChild(stickyColorInput); stickyRow.appendChild(stickyAlphaInput);
    body.appendChild(stickyRow);

    // ─── 인덱스 노트 ────────────────────────────────────────────────────────
    makeSectionDivider('인덱스 노트');
    const indexRow = document.createElement('div');
    indexRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const indexFontColorInput = document.createElement('input'); indexFontColorInput.type = 'text';
    indexFontColorInput.placeholder = '폰트 색상';
    indexFontColorInput.value = wsSettings.indexFontColor || '';
    indexFontColorInput.autocomplete = 'off'; indexFontColorInput.autocorrect = 'off'; indexFontColorInput.autocapitalize = 'off'; indexFontColorInput.spellcheck = false;
    indexFontColorInput.style.cssText = 'flex:0 1 60px;min-width:0;box-sizing:border-box;padding:4px 6px;font-size:10.5px;color:var(--ws-text2);' +
        'border:1px solid var(--ws-border);border-radius:6px;background:var(--ws-panel2);outline:none;';
    const indexColorInput = document.createElement('input'); indexColorInput.type = 'color';
    indexColorInput.value = wsSettings.indexRgb;
    indexColorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const indexAlphaInput = document.createElement('input'); indexAlphaInput.type = 'range'; indexAlphaInput.min = '0'; indexAlphaInput.max = '100';
    indexAlphaInput.value = String(wsSettings.indexAlpha);
    indexAlphaInput.style.cssText = 'flex:1;min-width:40px;';
    const onIndexColorChange = () => {
        wsSettings.indexRgb = indexColorInput.value; wsSettings.indexAlpha = parseInt(indexAlphaInput.value, 10);
        applyWsIndexColor(); saveWsSettings();
    };
    indexColorInput.addEventListener('input', onIndexColorChange);
    indexAlphaInput.addEventListener('input', onIndexColorChange);
    indexFontColorInput.addEventListener('input', () => {
        const v = indexFontColorInput.value.trim();
        if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) return;
        wsSettings.indexFontColor = v; applyWsIndexColor(); saveWsSettings();
    });
    indexRow.appendChild(indexColorInput); indexRow.appendChild(indexAlphaInput); indexRow.appendChild(indexFontColorInput);
    body.appendChild(indexRow);

    // ─── 메시지 삭제 ────────────────────────────────────────────────────────
    makeSectionDivider('메시지 삭제');
    const delLbl = document.createElement('label'); delLbl.className = 'ws-label';
    delLbl.style.cssText = 'gap:5px;white-space:nowrap;';
    const delChk = document.createElement('input'); delChk.type = 'checkbox'; delChk.className = 'ws-check';
    const delText = document.createElement('span');
    delText.textContent = '선택 삭제 모드';
    const delIcon = document.createElement('i');
    delIcon.className = 'fa-solid fa-flask';
    delIcon.style.cssText = 'margin-left:2px;font-size:11px;opacity:0.75;color:var(--ws-text2);';
    delLbl.appendChild(delChk);
    delLbl.appendChild(delText);
    delLbl.appendChild(delIcon);
    body.appendChild(delLbl);

    delChk.id = 'ws-enhanced-delete-chk';
    delChk.checked = !!wsSettings.enhancedDelete;
    delChk.addEventListener('change', () => {
        wsSettings.enhancedDelete = delChk.checked;
        saveWsSettings();
        refreshEnhancedDeleteObserver();
        if (!wsSettings.enhancedDelete) {
            document.body.classList.remove('ws-dell-active');
        }
    });

    document.body.appendChild(panel);
    raiseToTop(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const ph = panel.offsetHeight;
        // find 첫 패널(createPanel 기본 위치)과 정확히 같은 y값
        const top = Math.max(10, Math.min((window.innerHeight - ph) / 2 - 25, window.innerHeight - ph - 10));
        panel.style.top = `${Math.round(top)}px`;
        panel.style.opacity = '1';
    }));
}

function registerEditModeCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'edit', helpString: 'Toggle edit settings panel.',
        aliases: ['editmode'],
        callback: () => {
            if (document.getElementById('ws-editmode-panel')) closeEditModePanel();
            else openEditModePanel();
            return '';
        },
    }));
}

function registerDellCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dell',
        helpString: 'Enter enhanced message delete mode with custom buttons.',
        callback: async () => {
            await turnOnEnhancedDelete();
            return '';
        },
    }));
}

// ─── /fempov ─────────────────────────────────────────────────────────────
// generateRaw()로 AnyPOV 설명/인사말을 FemPOV로 변환 후 /difference에서 검토·반영.
// {{user}}/{{char}}는 전송 전 플레이스홀더로 보호했다가 응답 수신 후 복원.
const FEMPOV_USER_PLACEHOLDER = '@@USERNAME@@';
const FEMPOV_CHAR_PLACEHOLDER = '@@CHARNAME@@';
const protectMacros = text => text
    .replace(/\{\{user\}\}/gi, FEMPOV_USER_PLACEHOLDER)
    .replace(/\{\{char\}\}/gi, FEMPOV_CHAR_PLACEHOLDER);
const restoreMacros = text => text
    .split(FEMPOV_USER_PLACEHOLDER).join('{{user}}')
    .split(FEMPOV_CHAR_PLACEHOLDER).join('{{char}}');

const FEMPOV_MACRO_NOTE = `Note: the placeholders ${FEMPOV_USER_PLACEHOLDER} and ${FEMPOV_CHAR_PLACEHOLDER} represent the user's name and the character's name respectively — treat each grammatically as a person's name, and copy them through unchanged wherever they appear.`;

const FEMPOV_RULES = `Rules:
- This conversion is for a female user. The text may contain gender-neutral pronouns (they/their/them) referring to the user — convert these to she/her/hers.
- Beyond pronouns, make only the minimal edits needed where the surrounding context or wording specifically depends on gender (e.g. gendered nouns, idioms). Do not rewrite or rephrase anything else.
- If the text describes the character's sexual orientation as bisexual/pansexual (often written that way just to accommodate a player of any gender), and nothing else in the text strongly implies genuine attraction to multiple genders once converted to FemPOV, change that description to heterosexual instead. Leave it as-is if there's clear, independent evidence of actual bi/pansexuality.
- Preserve all original formatting exactly, including line breaks, markdown, punctuation, and any {{double-curly-brace}} placeholders.`;

// 단일 텍스트 변환용 시스템 프롬프트
function buildFempovSingleSystemPrompt(promptSubject) {
    return `You will be given a ${promptSubject} written from an AnyPOV (gender-neutral) perspective, using pronouns like "they/their/them" for the user. Rewrite it as FemPOV (female perspective).

${FEMPOV_MACRO_NOTE}

${FEMPOV_RULES}
- Output ONLY the converted text. No preamble, no explanation, no quotation marks around the output.`;
}

// 다중 섹션 파싱용 시스템 프롬프트
function buildFempovCombinedSystemPrompt(markers) {
    const markerList = markers.map(m => `"${m}"`).join(', ');
    return `You will be given one or more character sections (description and/or greetings), written from an AnyPOV (gender-neutral) perspective using pronouns like "they/their/them" for the user. Convert each to FemPOV (female perspective).

${FEMPOV_MACRO_NOTE}

${FEMPOV_RULES}
- The input is divided into sections, each starting with a line that is exactly one of these markers: ${markerList}. Only sections present in the input should appear in your output.
- Reproduce the exact same marker line(s) in your output, each immediately followed by that section's converted text and nothing else. Do not add any other text, headers, or explanation.`;
}

const FEMPOV_SECTION_DESC = '===FEMPOV_DESCRIPTION===';
const FEMPOV_SECTION_MSG = '===FEMPOV_FIRST_MESSAGE===';
const FEMPOV_SECTION_GREETING = n => `===FEMPOV_GREETING_${n}===`;

// 텍스트를 "마커\n내용" 형태로 이어붙임 — generateRaw에 보낼 하나의 prompt를 구성.
function buildFempovSections(sections) {
    return sections.map(s => `${s.marker}\n${protectMacros(s.text)}`).join('\n\n');
}

// 위 마커들을 기준으로 응답을 다시 섹션별로 나눔. 예상한 마커가 하나라도 누락되면 null(파싱 실패로 간주).
function parseFempovSections(raw, markers) {
    const found = markers
        .map(m => ({ m, idx: raw.indexOf(m) }))
        .filter(x => x.idx !== -1)
        .sort((a, b) => a.idx - b.idx);
    if (found.length < markers.length) return null;
    const result = {};
    for (let i = 0; i < found.length; i++) {
        const start = found[i].idx + found[i].m.length;
        const end = i + 1 < found.length ? found[i + 1].idx : raw.length;
        result[found[i].m] = raw.slice(start, end).trim();
    }
    return result;
}

// 검토 창에서 반영 버튼을 누르기 전까지 사용자가 다른 캐릭터로 전환하거나 생성 모드로 이동했을 때
// 엉뚱한 캐릭터 카드를 덮어쓰지 않도록 요청 시점의 대상 캐릭터 식별자를 스냅샷·검증함.
function captureFempovTargetOrigin(ctx) {
    const charId = ctx.characterId;
    const char = charId !== undefined ? ctx.characters?.[charId] : null;
    return {
        menuType: ctx.menuType,
        charId,
        charAvatar: char?.avatar ?? null,
    };
}

function verifyFempovTargetOrigin(origin) {
    const curCtx = SillyTavern.getContext();
    if (origin.menuType === 'create') {
        if (curCtx.menuType !== 'create') {
            toastr.error('캐릭터가 변경되어 취소했습니다.', '', { timeOut: 3500 });
            return null;
        }
        return curCtx;
    }
    if (curCtx.menuType === 'create') {
        toastr.error('캐릭터가 변경되어 취소했습니다.', '', { timeOut: 3500 });
        return null;
    }
    if (origin.charId !== undefined) {
        const curChar = curCtx.characters?.[curCtx.characterId];
        if (curCtx.characterId !== origin.charId
            || (origin.charAvatar && curChar?.avatar !== origin.charAvatar)) {
            toastr.error('캐릭터가 변경되어 취소했습니다.', '', { timeOut: 3500 });
            return null;
        }
    } else if (curCtx.characterId !== undefined) {
        toastr.error('캐릭터가 변경되어 취소했습니다.', '', { timeOut: 3500 });
        return null;
    }
    return curCtx;
}

function applyFempovTextareaField(selector, cachedEl, origin, fieldLabel, newText) {
    if (!verifyFempovTargetOrigin(origin)) return false;
    const liveEl = cachedEl?.isConnected ? cachedEl : document.querySelector(selector);
    if (!liveEl) {
        toastr.error(`${fieldLabel} 입력칸을 찾을 수 없습니다.`, '', { timeOut: 3000 });
        return false;
    }
    liveEl.value = newText;
    liveEl.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

async function applyFempovAltGreeting(origin, greetingNum, newText) {
    const curCtx = verifyFempovTargetOrigin(origin);
    if (!curCtx) return false;

    const idx = greetingNum - 1;
    if (origin.menuType === 'create') {
        const arr = curCtx.createCharacterData?.alternate_greetings;
        if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) {
            toastr.error(`대체 인사말 #${greetingNum}을 찾을 수 없습니다.`, '', { timeOut: 3000 });
            return false;
        }
        arr[idx] = newText;
    } else {
        const char = curCtx.characters?.[curCtx.characterId];
        const arr = char?.data?.alternate_greetings;
        if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) {
            toastr.error(`대체 인사말 #${greetingNum}을 찾을 수 없습니다.`, '', { timeOut: 3000 });
            return false;
        }
        arr[idx] = newText;
        if (Array.isArray(char.alternate_greetings) && idx < char.alternate_greetings.length) {
            char.alternate_greetings[idx] = newText;
        }
    }

    // 대체 인사말 편집 팝업이 현재 열려 있다면 해당 입력칸 DOM도 함께 동기화
    const liveAltTa = document.getElementById(`alternate_greeting_${idx}`);
    if (liveAltTa) {
        liveAltTa.value = newText;
        liveAltTa.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (origin.menuType !== 'create') {
        try {
            const stMod = await import('/script.js');
            if (typeof stMod?.saveCharacterDebounced === 'function') {
                stMod.saveCharacterDebounced();
            } else {
                document.getElementById('create_button')?.click();
            }
        } catch {
            document.getElementById('create_button')?.click();
        }
    }
    return true;
}

function makeFempovTextareaReviewItem({ label, applyLabel, selector, cachedEl, origin, before, after }) {
    return {
        label,
        applyLabel,
        before,
        after,
        onApply: (finalText) => applyFempovTextareaField(selector, cachedEl, origin, label, finalText),
    };
}

function makeFempovAltReviewItem({ n, before, after, origin }) {
    const label = `대체 인사말 #${n}`;
    return {
        label,
        applyLabel: `${label}에 반영`,
        before,
        after,
        onApply: (finalText) => applyFempovAltGreeting(origin, n, finalText),
    };
}

function fallbackFempovToSendInput(rawResult) {
    const sendTa = document.querySelector('#send_textarea');
    if (sendTa) {
        sendTa.value = restoreMacros(rawResult.trim());
        sendTa.dispatchEvent(new Event('input', { bubbles: true }));
        sendTa.focus();
    }
    toastr.warning('결과를 입력창으로 전송합니다.', '', { timeOut: 4000 });
}

async function runFempovGenerate(ctx, systemPrompt, prompt, cmdName = '/fempov') {
    let result;
    try {
        result = await ctx.generateRaw({ systemPrompt, prompt });
    } catch (err) {
        console.error(`[WS] ${cmdName} generateRaw failed:`, err);
        result = null;
    }
    if (!result || !result.trim()) {
        toastr.error('응답을 받지 못했습니다.', '', { timeOut: 4000 });
        return null;
    }
    return result;
}

// 대체 인사말은 팝업 DOM 대신 캐릭터 데이터(alternate_greetings)에서 직접 읽음
async function confirmFempovSend(ctx) {
    const bodyHtml = '<div style="text-align:center;">'
        + '<p style="margin:0;">연결된 API 로 내용을 전송합니다.</p>'
        + '</div>';
    if (ctx.Popup && ctx.POPUP_TYPE?.CONFIRM) {
        try {
            const popup = new ctx.Popup(bodyHtml, ctx.POPUP_TYPE.CONFIRM, '', { okButton: '확인', cancelButton: '취소' });
            const result = await popup.show();
            return ctx.POPUP_RESULT ? result === ctx.POPUP_RESULT.AFFIRMATIVE : !!result;
        } catch (err) {
            console.error('[WS] /fempov confirm popup failed:', err);
        }
    }
    if (ctx.Popup?.show?.confirm) {
        const result = await ctx.Popup.show.confirm('', '연결된 API 로 내용을 전송합니다.');
        return ctx.POPUP_RESULT ? result === ctx.POPUP_RESULT.AFFIRMATIVE : !!result;
    }
    return window.confirm('연결된 API 로 내용을 전송합니다.');
}

// 연결 프로필 선택 및 적용:
// 1) Connection Manager extensionSettings / DOM(#connection_profiles) / /profile-list 에서 프로필 목록 추출
// 2) 프로필이 존재하면 /buttons 로 [프로필 1, 2, ..., '취소'] 팝업을 띄워 선택받고 실제 /profile 전환 실행
// 3) 프로필이 없으면 기존 confirmFempovSend(확인 팝업)으로 안전하게 폴백
async function selectAndApplyConnectionProfile(ctx) {
    let profiles = [];

    // 1) SillyTavern Connection Manager extension settings (camelCase: connectionManager)
    const cm = ctx.extensionSettings?.connectionManager;
    if (cm && Array.isArray(cm.profiles)) {
        profiles.push(...cm.profiles.map(p => p?.name || p?.id).filter(Boolean));
    }

    // 2) DOM dropdown: #connection_profiles (ST Connection Manager UI)
    const select = document.getElementById('connection_profiles')
        || document.querySelector('select#connection_profiles, select[id*="connection_profile"]');
    if (select && select.options) {
        const selectProfiles = Array.from(select.options)
            .map(o => (o.text || o.value || '').trim())
            .filter(v => v && v !== '<None>' && v !== 'default');
        profiles.push(...selectProfiles);
    }

    // 3) /profile-list 슬래시 커맨드 fallback
    if (!profiles.length && typeof ctx.executeSlashCommandsWithOptions === 'function') {
        try {
            const listRes = await ctx.executeSlashCommandsWithOptions('/profile-list');
            const listRaw = Array.isArray(listRes) ? listRes : (listRes?.pipe ?? listRes);
            if (listRaw) {
                const parsed = typeof listRaw === 'string' ? (listRaw.trim() ? JSON.parse(listRaw) : []) : listRaw;
                if (Array.isArray(parsed)) profiles.push(...parsed.filter(Boolean));
            }
        } catch { }
    }

    profiles = Array.from(new Set(profiles)).filter(Boolean);

    // 연결 프로필 목록이 없으면 기존 전송 확인 팝업으로 안전하게 폴백
    if (!profiles.length || typeof ctx.executeSlashCommandsWithOptions !== 'function') {
        return await confirmFempovSend(ctx);
    }

    try {
        // SillyTavern 공식 /buttons: labels=[...] 형식
        const labelsStr = JSON.stringify(profiles);
        const choice = await ctx.executeSlashCommandsWithOptions(`/buttons labels=${labelsStr} "연결 프로필을 선택하세요"`);
        // executeSlashCommandsWithOptions returns SlashCommandClosureResult object; the clicked button label is in .pipe
        const raw = (choice && typeof choice === 'object') ? (choice.pipe ?? '') : choice;
        const chosen = String(raw ?? '').trim();
        if (!chosen || chosen === '취소' || chosen === 'cancel') {
            return false;
        }

        // 선택한 프로필로 실제 전환 (/profile await=true "<chosen>") — named arg는 unnamed arg 앞에 와야 함
        let switchedByCmd = false;
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            try {
                const escapedChosen = String(chosen).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                await ctx.executeSlashCommandsWithOptions(`/profile await=true "${escapedChosen}"`);
                switchedByCmd = true;
            } catch (switchErr) {
                console.warn('[WS] /profile slash command fallback:', switchErr);
            }
        }

        if (select) {
            const opt = Array.from(select.options).find(o => (o.text || o.value) === chosen);
            const curOpt = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
            const curName = curOpt ? (curOpt.text || curOpt.value) : '';
            if (opt && (!switchedByCmd || (curName !== chosen && select.value !== opt.value))) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        await new Promise(r => setTimeout(r, 150));
        return true;
    } catch (err) {
        console.warn('[WS] profile selection aborted or failed:', err);
        return false;
    }
}

function makeEnumValue(value, description) {
    const EnumClass = typeof SlashCommandEnumValue === 'function'
        ? SlashCommandEnumValue
        : SillyTavern?.getContext?.()?.SlashCommandEnumValue;
    return typeof EnumClass === 'function' ? new EnumClass(value, description) : value;
}

function parseFemPovArgs(rawValue) {
    const rawStr = Array.isArray(rawValue)
        ? rawValue.map(v => String(v ?? '').trim()).filter(Boolean).join(' ')
        : String(rawValue ?? '').trim();
    if (!rawStr) return { target: 'both', rangeStr: '' };
    const match = rawStr.match(/^(desc|grt|both)(?:\s+([\s\S]*))?$/i);
    if (match) {
        return {
            target: match[1].toLowerCase(),
            rangeStr: String(match[2] ?? '').trim(),
        };
    }
    return { target: null, rangeStr: rawStr };
}

function registerFempovCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fempov',
        helpString: 'Convert character description and/or greeting(s) to FemPOV. Usage: /fempov [desc|grt|both] [1|1-3]',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Target: both (default), desc, or grt',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: [
                    makeEnumValue('both', 'Description and first greeting (default)'),
                    makeEnumValue('desc', 'Description only'),
                    makeEnumValue('grt', 'First greeting only'),
                ],
            }),
            SlashCommandArgument.fromProps({
                description: 'Alt-greeting number or range from 1 (e.g. 1 or 1-3)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        callback: async (_a, value) => {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.generateRaw !== 'function') {
                toastr.error('지원하지 않는 SillyTavern 버전입니다.', '', { timeOut: 4000 });
                return '';
            }

            const { target, rangeStr } = parseFemPovArgs(value);

            let altItems = [];
            if (rangeStr) {
                const idxs = parseRange(rangeStr);
                if (!idxs || idxs.some(n => n < 1)) {
                    toastr.warning('번호를 다시 확인해 주세요.', '', { timeOut: 3000 });
                    return '';
                }
                const char = ctx.characters?.[ctx.characterId];
                const greetings = ctx.menuType === 'create'
                    ? (ctx.createCharacterData?.alternate_greetings ?? [])
                    : (char?.data?.alternate_greetings ?? char?.alternate_greetings ?? []);
                altItems = idxs
                    .map(n => ({ n, text: greetings[n - 1] }))
                    .filter(({ text }) => text !== undefined && text !== null && String(text).trim());
                if (!altItems.length) {
                    toastr.warning('번호를 다시 확인해 주세요.', '', { timeOut: 3000 });
                    return '';
                }
            }

            const entries = [];
            const descTa = document.querySelector('#description_textarea');
            const msgTa = document.querySelector('#firstmessage_textarea');

            if (target === 'desc' || target === 'both') {
                const descText = descTa?.value ?? '';
                if (descText.trim()) {
                    entries.push({
                        kind: 'desc',
                        label: '캐릭터 설명',
                        applyLabel: '캐릭터 설명에 반영',
                        selector: '#description_textarea',
                        cachedEl: descTa,
                        marker: FEMPOV_SECTION_DESC,
                        promptSubject: 'character description',
                        text: descText,
                    });
                }
            }
            if (target === 'grt' || target === 'both') {
                const msgText = msgTa?.value ?? '';
                if (msgText.trim()) {
                    entries.push({
                        kind: 'grt',
                        label: '첫 번째 메시지',
                        applyLabel: '첫 번째 메시지에 반영',
                        selector: '#firstmessage_textarea',
                        cachedEl: msgTa,
                        marker: FEMPOV_SECTION_MSG,
                        promptSubject: 'character greeting message',
                        text: msgText,
                    });
                }
            }
            for (const { n, text } of altItems) {
                entries.push({
                    kind: 'alt',
                    n,
                    marker: FEMPOV_SECTION_GREETING(n),
                    promptSubject: 'character greeting message',
                    text,
                });
            }

            if (!entries.length) {
                toastr.warning('내용이 없습니다.', '', { timeOut: 3000 });
                return '';
            }

            const origin = captureFempovTargetOrigin(ctx);
            if (!(await selectAndApplyConnectionProfile(ctx))) return '';

            const buildReviewItem = (entry, afterText) => entry.kind === 'alt'
                ? makeFempovAltReviewItem({ n: entry.n, before: entry.text, after: afterText, origin })
                : makeFempovTextareaReviewItem({
                    label: entry.label,
                    applyLabel: entry.applyLabel,
                    selector: entry.selector,
                    cachedEl: entry.cachedEl,
                    origin,
                    before: entry.text,
                    after: afterText,
                });

            if (entries.length === 1) {
                const entry = entries[0];
                const result = await runFempovGenerate(
                    ctx,
                    buildFempovSingleSystemPrompt(entry.promptSubject),
                    protectMacros(entry.text),
                );
                if (!result) return '';
                openDifferenceReviewQueue([buildReviewItem(entry, restoreMacros(result.trim()))], { titlePrefix: 'FemPOV 결과 검토' });
                return '';
            }

            const markers = entries.map(e => e.marker);
            const systemPrompt = buildFempovCombinedSystemPrompt(markers);
            const result = await runFempovGenerate(ctx, systemPrompt, buildFempovSections(entries));
            if (!result) return '';

            const parsed = parseFempovSections(result, markers);
            if (!parsed) {
                fallbackFempovToSendInput(result);
                return '';
            }

            const reviewItems = entries
                .map(entry => {
                    const converted = parsed[entry.marker];
                    return converted !== undefined ? buildReviewItem(entry, restoreMacros(converted)) : null;
                })
                .filter(Boolean);
            if (!reviewItems.length) {
                toastr.error('응답을 받지 못했습니다.', '', { timeOut: 4000 });
                return '';
            }
            openDifferenceReviewQueue(reviewItems, { titlePrefix: 'FemPOV 결과 검토' });
            return '';
        },
    }));
}

// ─── /quickau ───────────────────────────────────────────────────────────────
// 캐릭터 설명 / 첫 번째 메시지를 사용자가 요청한 AU나 설정 변경에 맞게 유동적으로 각색한 뒤,
// /difference 순차 검토 창으로 비포/애프터를 확인하고 반영할 수 있게 함.
// /quickau [desc|grt|both] {string} (대상 생략 시 기본값 desc, 변경 내용 생략 시 입력 팝업)
const QUICKAU_MARKER_REQUEST = '===QUICKAU_CHANGE_REQUEST===';
const QUICKAU_MARKER_SOURCE = '===QUICKAU_SOURCE_TEXT===';
const QUICKAU_SECTION_DESC = '===QUICKAU_DESCRIPTION===';
const QUICKAU_SECTION_MSG = '===QUICKAU_FIRST_MESSAGE===';

const QUICKAU_FIELD_META = {
    desc: {
        label: '캐릭터 설명',
        applyLabel: '캐릭터 설명에 반영',
        selector: '#description_textarea',
        marker: QUICKAU_SECTION_DESC,
        promptSubject: 'character description',
    },
    grt: {
        label: '첫 번째 메시지',
        applyLabel: '첫 번째 메시지에 반영',
        selector: '#firstmessage_textarea',
        marker: QUICKAU_SECTION_MSG,
        promptSubject: 'opening greeting message',
    },
};

const QUICKAU_RULES = `Adaptation guidelines:
- Gauge the scope of the change flexibly from the user's request:
  * Subtle or targeted shifts (e.g., changing a bully into someone secretly harbouring a crush, shifting attitude/dynamics, tweaking a trope): preserve unaffected lore, setting, formatting, and details, while naturally rewriting motives, inner subtext, behavior, and dialogue lines that contradict the requested shift so no jarring remnants clash with it.
  * Broad AU, species, or universe overhauls (e.g., modern human into a male gumiho, historical/fantasy/mafia/sci-fi AU, major role reversal): reimagine setting, backstory, species/traits, attire, abilities, speech register, and opening scene details cohesively throughout the text so incompatible original-world elements do not leak through, while keeping the character's core charm/identity and bond with ${FEMPOV_USER_PLACEHOLDER}.
- Keep the original language, narrative POV, and tense unless the change request explicitly asks to change them.
- Preserve structural formatting and card conventions (headings, bullet lists, markdown/tags, quotation/action delimiters, paragraph rhythm) where compatible, along with any {{double-curly-brace}} placeholders.`;

function parseQuickAuArgs(rawValue) {
    const joined = Array.isArray(rawValue)
        ? rawValue.filter(v => v !== undefined && v !== null && String(v).trim() !== '').join(' ')
        : String(rawValue ?? '');
    const trimmed = joined.trim();
    if (!trimmed) return { target: 'desc', instruction: '' };
    const match = trimmed.match(/^(desc|grt|both)(?:\s+([\s\S]*))?$/i);
    if (!match) return { target: 'desc', instruction: trimmed };
    return { target: match[1].toLowerCase(), instruction: String(match[2] ?? '').trim() };
}

async function promptQuickAuInstruction(ctx, target) {
    const targetLabel = target === 'both'
        ? '캐릭터 설명 + 첫 번째 메시지'
        : QUICKAU_FIELD_META[target].label;
    await new Promise(r => setTimeout(r, 10));

    const headerHtml = '<div style="text-align:left;">'
        + '<div style="font-weight:600;margin-bottom:4px;">QuickAU 설정 변경 입력</div>'
        + `<div style="font-size:12px;opacity:0.8;">대상: ${targetLabel} · 원하는 AU 를 입력하세요.</div>`
        + '</div>';

    let result;
    if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.INPUT !== undefined) {
        result = await ctx.callGenericPopup(headerHtml, ctx.POPUP_TYPE.INPUT, '', {
            rows: 4,
        });
    } else if (ctx.Popup?.show?.input) {
        result = await ctx.Popup.show.input('QuickAU 설정 변경 입력', `대상: ${targetLabel}`, '');
    } else {
        result = window.prompt(`QuickAU 설정 변경 (${targetLabel}):`, '');
    }

    if (result === false || result === null || result === undefined) return null;
    const trimmed = String(result).trim();
    if (!trimmed) {
        toastr.warning('내용을 입력해 주세요.', '', { timeOut: 3000 });
        return null;
    }
    return trimmed;
}

function buildQuickAuSingleSystemPrompt(promptSubject) {
    return `You will be given a change request (${QUICKAU_MARKER_REQUEST}) and an original character ${promptSubject} (${QUICKAU_MARKER_SOURCE}). Rewrite the source text to fulfill the requested change/AU naturally.

${FEMPOV_MACRO_NOTE}

${QUICKAU_RULES}
- Output ONLY the rewritten text itself. Do NOT output section markers (${QUICKAU_MARKER_REQUEST}, ${QUICKAU_MARKER_SOURCE}), explanations, notes, or surrounding quotation marks.`;
}

function buildQuickAuCombinedSystemPrompt(markers) {
    const markerList = markers.map(m => `"${m}"`).join(', ');
    return `You will be given a change request (${QUICKAU_MARKER_REQUEST}) followed by a character's description and/or first message divided into sections. Adapt every provided section to fulfill the requested change/AU consistently.

${FEMPOV_MACRO_NOTE}

${QUICKAU_RULES}
- Ensure all rewritten sections remain mutually consistent with one another under the new setting/AU.
- The input text after ${QUICKAU_MARKER_REQUEST} is divided into sections starting with exact marker lines: ${markerList}. Only sections present in the input should appear in your output.
- Reproduce the exact same section marker line(s) in your output (${markerList}), each immediately followed by that section's rewritten text and nothing else. Do NOT echo ${QUICKAU_MARKER_REQUEST} or add extra commentary.`;
}

function registerQuickAuCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'quickau',
        helpString: 'Rewrite character description or greeting for an AU. Usage: /quickau [desc|grt|both] [prompt]',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Target: desc (default), grt, or both',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: [
                    makeEnumValue('desc', 'Description only (default)'),
                    makeEnumValue('grt', 'First greeting only'),
                    makeEnumValue('both', 'Description and first greeting'),
                ],
            }),
            SlashCommandArgument.fromProps({
                description: 'AU prompt (omit to open input popup)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        callback: async (_a, value) => {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.generateRaw !== 'function') {
                toastr.error('지원하지 않는 SillyTavern 버전입니다.', '', { timeOut: 4000 });
                return '';
            }

            const { target, instruction: initialInstruction } = parseQuickAuArgs(value);
            const targetKeys = target === 'both' ? ['desc', 'grt'] : [target];
            const activeEntries = targetKeys
                .map(key => {
                    const meta = QUICKAU_FIELD_META[key];
                    const el = document.querySelector(meta.selector);
                    return { key, meta, el, text: el?.value ?? '' };
                })
                .filter(item => item.text.trim().length > 0);

            if (!activeEntries.length) {
                toastr.warning('내용이 없습니다.', '', { timeOut: 3000 });
                return '';
            }

            const origin = captureFempovTargetOrigin(ctx);
            const instruction = initialInstruction || await promptQuickAuInstruction(ctx, target);
            if (!instruction) return '';

            if (!(await selectAndApplyConnectionProfile(ctx))) return '';

            const protectedReq = protectMacros(instruction);
            if (activeEntries.length === 1) {
                const entry = activeEntries[0];
                const systemPrompt = buildQuickAuSingleSystemPrompt(entry.meta.promptSubject);
                const prompt = `${QUICKAU_MARKER_REQUEST}\n${protectedReq}\n\n${QUICKAU_MARKER_SOURCE}\n${protectMacros(entry.text)}`;
                const result = await runFempovGenerate(ctx, systemPrompt, prompt, '/quickau');
                if (!result) return '';

                let singleOut = result;
                const srcIdx = singleOut.indexOf(QUICKAU_MARKER_SOURCE);
                if (srcIdx !== -1) singleOut = singleOut.slice(srcIdx + QUICKAU_MARKER_SOURCE.length);
                singleOut = singleOut.replace(/^\s*===QUICKAU_[A-Z_]+===\s*/i, '').trim();
                if (!singleOut) {
                    toastr.error('응답을 받지 못했습니다.', '', { timeOut: 4000 });
                    return '';
                }

                openDifferenceReviewQueue([makeFempovTextareaReviewItem({
                    label: entry.meta.label,
                    applyLabel: entry.meta.applyLabel,
                    selector: entry.meta.selector,
                    cachedEl: entry.el,
                    origin,
                    before: entry.text,
                    after: restoreMacros(singleOut),
                })], { titlePrefix: 'QuickAU 결과 검토' });
                return '';
            }

            const markers = activeEntries.map(e => e.meta.marker);
            const sectionsBody = buildFempovSections(activeEntries.map(e => ({ marker: e.meta.marker, text: e.text })));
            const prompt = `${QUICKAU_MARKER_REQUEST}\n${protectedReq}\n\n${sectionsBody}`;
            const systemPrompt = buildQuickAuCombinedSystemPrompt(markers);
            const result = await runFempovGenerate(ctx, systemPrompt, prompt, '/quickau');
            if (!result) return '';

            const parsed = parseFempovSections(result, markers);
            if (!parsed) {
                fallbackFempovToSendInput(result);
                return '';
            }

            const reviewItems = activeEntries
                .map(entry => {
                    const converted = parsed[entry.meta.marker];
                    if (converted === undefined) return null;
                    return makeFempovTextareaReviewItem({
                        label: entry.meta.label,
                        applyLabel: entry.meta.applyLabel,
                        selector: entry.meta.selector,
                        cachedEl: entry.el,
                        origin,
                        before: entry.text,
                        after: restoreMacros(converted),
                    });
                })
                .filter(Boolean);
            if (!reviewItems.length) {
                toastr.error('응답을 받지 못했습니다.', '', { timeOut: 4000 });
                return '';
            }

            openDifferenceReviewQueue(reviewItems, { titlePrefix: 'QuickAU 결과 검토' });
            return '';
        },
    }));
}

// ─── Memory Books 경계선 인덱스 조회 ─────────────────────────────────────────
function getMessageMbIndex() {
    const divider = document.querySelector('div.stmb_memory_boundary_divider');
    if (!divider) return '';
    const mes = divider.closest('.mes[mesid]');
    if (mes) return mes.getAttribute('mesid') || '';
    let el = divider.nextElementSibling;
    while (el) {
        if (el.matches?.('.mes[mesid]')) return el.getAttribute('mesid') || '';
        el = el.nextElementSibling;
    }
    el = divider.previousElementSibling;
    while (el) {
        if (el.matches?.('.mes[mesid]')) return el.getAttribute('mesid') || '';
        el = el.previousElementSibling;
    }
    return '';
}

// ─── /fonta, /fontb 명령어 등록 ─────────────────────────────────────────────
function registerFontCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fonta', helpString: 'Search FontAwesome icon name or unicode. Usage: /fonta heart or /fonta f004',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'FontAwesome icon name or hex code', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: async (_a, value) => {
            const query = String(value ?? '').trim();
            if (!query) {
                openFontAPanel();
                return '';
            }
            const found = lookupFaIcon(query);
            if (!found) {
                toastr.warning('일치하는 아이콘이 없습니다.', '', { timeOut: 2000 });
                return '';
            }
            const ok = await copyText(found.result, false);
            if (ok) toastr.success(found.display, '', { timeOut: 1500 });
            else toastr.error('Clipboard 접근이 거부되었습니다.', '', { timeOut: 2000 });
            return found.result;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fontb', helpString: 'Open special font converter panel or convert text. Usage: /fontb [style] [text]',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: '[style] text or text alone (e.g. bold Hello or script World)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: async (_a, value) => {
            const trimmed = String(value ?? '').trim();
            if (!trimmed) {
                openFontBPanel();
                return '';
            }
            const m = trimmed.match(/^([a-zA-Z]+)\s+(.*)$/s);
            const knownStyles = [
                'bold', 'italic', 'bolditalic', 'script', 'boldscript', 'fraktur', 'boldfraktur',
                'doublestruck', 'sans', 'sansbold', 'sansitalic', 'sansbolditalic', 'mono', 'smallcaps',
                'circled', 'bubbleblack', 'squared', 'squaredblack', 'upsidedown', 'strike',
                'underline', 'doubleunderline', 'superscript', 'subscript', 'parenthesized', 'fullwidth'
            ];
            let style = 'bold', text = trimmed;
            if (m && knownStyles.includes(m[1].toLowerCase())) {
                style = m[1].toLowerCase();
                text = m[2];
            }
            const converted = convertSpecialFont(text, style);
            await copyText(converted);
            return converted;
        },
    }));

    // ─── /ctrlz (alias: /ctrlzviewer) ───────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctrlz',
        aliases: ['ctrlzviewer'],
        helpString: 'Open message edit history viewer to inspect diffs and restore previous edits.',
        callback: () => {
            openCtrlZViewerPanel();
            return '';
        },
    }));
}

// ─── /slashie (슬래시 커맨드 목록 패널) ─────────────────────────────────────
const SLASHIE_COMMAND_CATEGORIES = [
    {
        category: '검색 · 치환 · 비교',
        items: [
            { cmd: '/finds', desc: '채팅 내 키워드 검색 및 하이라이트 점프' },
            { cmd: '/change', desc: '채팅 내 단어 검토 및 일괄 치환' },
            { cmd: '/difference', desc: '텍스트·메시지·스와이프 Diff 비교 및 편집' },
        ],
    },
    {
        category: '메시지 편집 · 복구',
        items: [
            { cmd: '/ctrlz', desc: '최근 수정·삭제 기록 확인 및 복구' },
            { cmd: '/move', desc: '메시지 또는 범위를 지정 인덱스로 이동' },
            { cmd: '/undo', desc: '방금 /move로 옮긴 메시지 순서 되돌리기' },
            { cmd: '/dell', desc: '범위·일괄 선택 삭제 모드 켜기' },
            { cmd: '/collapse', desc: '지정 메시지를 접기(<details>) 태그로 감싸기' },
            { cmd: '/expand', desc: '접기(<details>) 태그 해제' },
        ],
    },
    {
        category: '메모 · 상태 관리',
        items: [
            { cmd: '/sticky', desc: '화면 위 포스트잇 메모장 열기/닫기' },
            { cmd: '/index', desc: '메시지에 인덱스 메모 스티커 추가·수정' },
            { cmd: '/indexed', desc: '인덱스가 달린 메시지 목록 조회' },
            { cmd: '/hidden', desc: '숨김 처리된 메시지 목록 조회' },
            { cmd: '/hidealarm', desc: '지정 메시지 숨김 변경 시 알림 표시' },
            { cmd: '/swiped', desc: '스와이프가 여러 개인 메시지 목록 조회' },
        ],
    },
    {
        category: '채팅 탐색',
        items: [
            { cmd: '/goto', desc: '지정 번호의 메시지로 바로 이동' },
            { cmd: '/up', desc: '채팅 최상단으로 스크롤' },
            { cmd: '/down', desc: '채팅 최하단으로 스크롤' },
            { cmd: '/chat-button', desc: '채팅 화면을 한 스텝 위로 스크롤' },
            { cmd: '/chat-bottom', desc: '채팅 화면을 한 스텝 아래로 스크롤' },
            { cmd: '/message-button', desc: '현재 화면 맨 위 메시지 경계로 이동 후 메뉴 열기' },
            { cmd: '/message-bottom', desc: '현재 화면 맨 아래 메시지 경계로 이동' },
            { cmd: '/message-mb', desc: 'Memory Books 경계선 이동 및 인덱스 반환' },
        ],
    },
    {
        category: '캐릭터 각색 · 유틸리티',
        items: [
            { cmd: '/fempov', desc: '캐릭터 설명·인사말을 FemPOV로 변환 후 검토' },
            { cmd: '/quickau', desc: '캐릭터 설명·첫 메시지를 원하는 AU로 각색' },
            { cmd: '/naming', desc: '오프라인 한국어·영어 랜덤 이름 생성기' },
            { cmd: '/convert', desc: '단위·나이·D-day·환율($/£) 변환기' },
            { cmd: '/clip', desc: '선택 텍스트·입력창·메시지·전체 채팅 복사' },
            { cmd: '/word', desc: '채팅·지정 범위 글자 수 및 단어 수 계산' },
            { cmd: '/fonta', desc: 'FontAwesome 아이콘·유니코드 검색 및 복사' },
            { cmd: '/fontb', desc: '특수 유니코드 폰트 변환기' },
        ],
    },
    {
        category: '설정 · 안내',
        items: [
            { cmd: '/edit', desc: 'Slashie 세부 설정 패널 열기/닫기' },
            { cmd: '/slashie', desc: 'Slashie 슬래시 커맨드 목록 보기' },
            { cmd: '/deleteSlashielocalStorage', desc: '브라우저 localStorage 내 Slashie 데이터 삭제 및 기본값 초기화' },
        ],
    },
];

function openSlashieCommandsPanel() {
    const PANEL_ID = 'ws-slashie-panel';
    if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return; }

    const panel = createPanel(PANEL_ID);
    panel.style.width = 'min(420px, 92vw)';
    const body = getPanelBody(panel);

    const allItems = SLASHIE_COMMAND_CATEGORIES.flatMap(g => g.items);
    let sortMode = 'category'; // 'category' | 'alpha'

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;';

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;';
    titleWrap.innerHTML = `<i class="fa-solid fa-terminal" style="font-size:12px;color:var(--ws-text2);"></i><span>커맨드</span><span style="font-size:11px;font-weight:400;color:var(--ws-text2);">${allItems.length}개</span>`;

    const seg = document.createElement('div');
    seg.className = 'ws-diff-seg';
    const catBtn = document.createElement('button');
    catBtn.type = 'button';
    catBtn.textContent = '분류순';
    const alphaBtn = document.createElement('button');
    alphaBtn.type = 'button';
    alphaBtn.textContent = 'A–Z';
    seg.appendChild(catBtn);
    seg.appendChild(alphaBtn);

    header.appendChild(titleWrap);
    header.appendChild(seg);
    body.appendChild(header);

    const list = document.createElement('div');
    list.className = 'ws-thin-scroll';
    list.style.cssText = 'max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;';
    body.appendChild(list);

    function createCommandRow({ cmd, desc }) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:7px;background:var(--ws-panel2);border:1px solid var(--ws-border);overflow:hidden;';

        const cmdCol = document.createElement('span');
        cmdCol.style.cssText = 'min-width:116px;flex-shrink:0;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--ws-text);white-space:nowrap;';
        cmdCol.textContent = cmd;

        const descCol = document.createElement('span');
        descCol.className = 'ws-slashie-desc';
        descCol.style.cssText = 'flex:1;min-width:0;text-align:left;font-size:11.5px;line-height:1.4;color:var(--ws-text2);white-space:nowrap;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none;touch-action:pan-x pan-y;';
        descCol.textContent = desc;

        row.appendChild(cmdCol);
        row.appendChild(descCol);
        return row;
    }

    function renderList() {
        catBtn.classList.toggle('active', sortMode === 'category');
        alphaBtn.classList.toggle('active', sortMode === 'alpha');
        list.innerHTML = '';

        if (sortMode === 'category') {
            SLASHIE_COMMAND_CATEGORIES.forEach((group, idx) => {
                const catLabel = document.createElement('div');
                catLabel.style.cssText = `font-size:11px;font-weight:600;color:var(--ws-text2);padding:${idx === 0 ? '2px' : '8px'} 2px 3px;`;
                catLabel.textContent = group.category;
                list.appendChild(catLabel);
                group.items.forEach(item => list.appendChild(createCommandRow(item)));
            });
        } else {
            const sorted = [...allItems].sort((a, b) => a.cmd.localeCompare(b.cmd, 'en'));
            sorted.forEach(item => list.appendChild(createCommandRow(item)));
        }
        list.scrollTop = 0;
    }

    catBtn.addEventListener('click', () => {
        if (sortMode === 'category') return;
        sortMode = 'category';
        renderList();
    });
    alphaBtn.addEventListener('click', () => {
        if (sortMode === 'alpha') return;
        sortMode = 'alpha';
        renderList();
    });

    renderList();
}

function registerSlashieCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'slashie',
        helpString: 'Open Slashie command list panel.',
        callback: () => {
            openSlashieCommandsPanel();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deleteSlashielocalStorage',
        aliases: ['deleteslashielocalstorage'],
        helpString: 'Delete all Slashie data in browser localStorage and reset settings to defaults.',
        callback: async () => {
            const ctx = SillyTavern.getContext();
            const message = '저장된 설정과 /hidden 핀 위치 등 Slashie의 localStorage 데이터를 모두 삭제하고 기본값으로 되돌릴까요?';
            let confirmed = false;
            if (ctx?.Popup?.show?.confirm) {
                const res = await ctx.Popup.show.confirm('Slashie 로컬 스토리지 초기화', message);
                confirmed = ctx.POPUP_RESULT ? res === ctx.POPUP_RESULT.AFFIRMATIVE : !!res;
            } else {
                confirmed = window.confirm(message);
            }
            if (!confirmed) return '';

            resetSlashieLocalStorage();
            resetStickyUI();
            closeEditModePanel();
            closePanel('ws-hidden-panel');
            closePanel('ws-convert-panel');
            document.body.classList.remove('ws-dell-active', 'ws-dell-range');
            refreshEnhancedDeleteObserver();
            document.getElementById('ws-ctrlzviewer-panel')?._wsRender?.();
            toastr.success('Slashie 로컬 스토리지를 초기화했습니다.', '', { timeOut: 3000 });
            return '';
        },
    }));
}
