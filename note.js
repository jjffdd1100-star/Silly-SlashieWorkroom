// ─── note.js ───────────────────────────────────────────────────────────────
// /index — 메시지별 짧은 인덱스 스티커 및 모달 관리.

import { createPanel, getPanelBody, closePanel, centerOf } from './panel-ui.js';
import { getChat, applyWsIndexColor } from './state.js';

function getNote(idx) {
    const chat = getChat();
    const msg = chat?.[idx];
    if (!msg) return '';
    if (msg.extra?.wsNoteText) return msg.extra.wsNoteText;
    const sid = msg.swipe_id ?? 0;
    let fromSwipe = msg.swipe_info?.[sid]?.extra?.wsNoteText;
    if (!fromSwipe && Array.isArray(msg.swipe_info)) {
        const hit = msg.swipe_info.find(s => s?.extra?.wsNoteText);
        if (hit) fromSwipe = hit.extra.wsNoteText;
    }
    return fromSwipe || '';
}

export async function setNote(idx, text) {
    const chat = getChat();
    const msg = chat?.[idx];
    if (!msg) return false;

    const trimmed = (text || '').trim();
    if (!msg.extra) msg.extra = {};
    if (trimmed) {
        msg.extra.wsNoteText = trimmed;
        if (Array.isArray(msg.swipe_info)) {
            msg.swipe_info.forEach(si => {
                if (si && typeof si === 'object') {
                    if (!si.extra) si.extra = {};
                    si.extra.wsNoteText = trimmed;
                }
            });
        }
    } else {
        delete msg.extra.wsNoteText;
        if (Array.isArray(msg.swipe_info)) {
            msg.swipe_info.forEach(si => {
                if (si?.extra) delete si.extra.wsNoteText;
            });
        }
    }

    refreshNoteStickers();

    const ctx = SillyTavern.getContext();
    try {
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        } else if (typeof ctx.saveChatConditional === 'function') {
            await ctx.saveChatConditional();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
        }
    } catch (e) {
        console.warn('[Slashie] setNote saveChat error:', e);
    }

    return true;
}

export function getAllNotes() {
    const chat = getChat();
    const notes = [];
    if (!Array.isArray(chat)) return notes;
    for (let idx = 0; idx < chat.length; idx++) {
        const text = getNote(idx);
        if (text) {
            notes.push({ idx, text });
        }
    }
    return notes;
}

export function openNoteModal(idx, anchorEl = null) {
    const PANEL_ID = 'ws-note-modal';
    const panel = createPanel(PANEL_ID, anchorEl ? centerOf(anchorEl) : null);
    const body = getPanelBody(panel);

    const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:10px;';
    title.textContent = `#${idx} 메시지 인덱스`;
    body.appendChild(title);

    const textarea = document.createElement('textarea');
    textarea.value = getNote(idx);
    textarea.placeholder = '인덱스 내용을 입력하세요';
    textarea.autocomplete = 'off'; textarea.autocorrect = 'off'; textarea.autocapitalize = 'off'; textarea.spellcheck = false;
    textarea.style.cssText = 'width:100%;min-height:120px;box-sizing:border-box;padding:8px;border:1px solid var(--ws-border);' +
        'border-radius:8px;background:var(--ws-panel2);color:inherit;font:inherit;font-size:13px;resize:vertical;margin-bottom:10px;';
    body.appendChild(textarea);

    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const delBtn = document.createElement('button'); delBtn.className = 'ws-btn'; delBtn.textContent = '삭제';
    const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:8px;';
    const closeBtn = document.createElement('button'); closeBtn.className = 'ws-btn'; closeBtn.textContent = '닫기';
    const saveBtn = document.createElement('button'); saveBtn.className = 'ws-btn ws-btn-accent'; saveBtn.textContent = '저장';
    delBtn.addEventListener('click', async () => {
        delBtn.disabled = true; saveBtn.disabled = true;
        try { await setNote(idx, ''); } finally { closePanel(PANEL_ID); }
    });
    closeBtn.addEventListener('click', () => closePanel(PANEL_ID));
    saveBtn.addEventListener('click', async () => {
        delBtn.disabled = true; saveBtn.disabled = true;
        try { await setNote(idx, textarea.value); } finally { closePanel(PANEL_ID); }
    });
    btnRow.appendChild(closeBtn); btnRow.appendChild(saveBtn);
    row.appendChild(delBtn); row.appendChild(btnRow);
    body.appendChild(row);
    setTimeout(() => textarea.focus(), 50);
}

function getMesIdx(mesEl) {
    return parseInt(mesEl.getAttribute('mesid'), 10);
}

function buildSticker(mesEl, note) {
    const s = document.createElement('div'); s.className = 'ws-note-sticker';
    s.innerHTML = `<span></span>`;
    s.querySelector('span').textContent = note;
    s.addEventListener('click', e => {
        e.stopPropagation();
        const currentIdx = getMesIdx(mesEl);
        if (!isNaN(currentIdx)) openNoteModal(currentIdx, s);
    });
    return s;
}

function ensureIndexButton(mesEl) {
    const container = mesEl.querySelector('.extraMesButtons');
    if (!container || container.querySelector('.ws-index-btn')) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button ws-index-btn fa-solid fa-note-sticky interactable';
    btn.title = '메시지 인덱스';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            btn.click();
        }
    });
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const currentIdx = getMesIdx(mesEl);
        if (!isNaN(currentIdx)) openNoteModal(currentIdx);
    });
    const bmBtn = container.querySelector('.mes_bookmark_btn');
    const editBtn = container.querySelector('.mes_edit');
    if (bmBtn && bmBtn.nextSibling) {
        container.insertBefore(btn, bmBtn.nextSibling);
    } else if (editBtn) {
        container.insertBefore(btn, editBtn);
    } else {
        container.appendChild(btn);
    }
}

function refreshNoteStickers() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(mesEl => {
        const idx = getMesIdx(mesEl);
        if (isNaN(idx)) return;
        ensureIndexButton(mesEl);
        const note = getNote(idx);
        const existing = mesEl.querySelector('.ws-note-sticker');
        if (!note) { existing?.remove(); return; }
        if (existing) {
            const sp = existing.querySelector('span');
            if (sp) sp.textContent = note;
            return;
        }
        const mesText = mesEl.querySelector('.mes_text');
        if (!mesText || !mesText.parentElement) return;
        mesText.parentElement.insertBefore(buildSticker(mesEl, note), mesText);
    });
}

let _observerStarted = false;
export function initMessageNote() {
    if (_observerStarted) return;
    _observerStarted = true;
    applyWsIndexColor();

    let timer = null;
    const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            refreshNoteStickers();
        }, 120);
    };

    const attachChatObserver = () => {
        const chatEl = document.getElementById('chat');
        if (!chatEl || chatEl._wsNoteObserved) return;
        chatEl._wsNoteObserved = true;
        new MutationObserver(schedule).observe(chatEl, { childList: true, subtree: false });
    };

    attachChatObserver();

    const ctx = SillyTavern.getContext();
    if (ctx.eventSource) {
        const et = ctx.event_types || {};
        const evtChatChanged = et.CHAT_CHANGED ?? 'chat_id_changed';
        ctx.eventSource.on(evtChatChanged, () => { attachChatObserver(); schedule(); });
        ctx.eventSource.on(et.CHAT_LOADED ?? 'chatLoaded', () => { attachChatObserver(); schedule(); });
        ctx.eventSource.on(et.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered', () => schedule());
        ctx.eventSource.on(et.USER_MESSAGE_RENDERED ?? 'user_message_rendered', () => schedule());
        ctx.eventSource.on(et.MESSAGE_DELETED ?? 'message_deleted', () => schedule());
        ctx.eventSource.on(et.MESSAGE_UPDATED ?? 'message_updated', () => schedule());
        ctx.eventSource.on(et.MESSAGE_EDITED ?? 'message_edited', () => schedule());
        ctx.eventSource.on(et.MESSAGE_SWIPED ?? 'message_swiped', () => schedule());
    }

    schedule();
}
