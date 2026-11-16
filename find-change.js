// ─── find-change.js ─────────────────────────────────────────────────────────
// /find, /change 슬래시 커맨드와 그 검색/치환 패널.

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';

import { escapeHTML, buildAllMatches, applyWholeWord, applyFiller, maskTags, maskReasoningBlocks, parseChangeRangeInput, parseRangeInputFlexible } from './utils.js';
import { getChat, editMessage, editTranslatedText, wsSettings, getLastChatSelection } from './state.js';
import { createPanel, getPanelBody, closePanel, centerOf, keepCenter, btn, inputBox, searchOptions, renderList, makeFollowChk } from './panel-ui.js';
import { applyDOMHighlights, clearDOMHighlights, updateCurrentMark, scrollToMark } from './highlight.js';

// find/change 패널 상호배타 처리 — 같은 종류가 이미 열려있으면 토글로 닫히고,
// 다른 종류가 열려있으면 기존 패널과 하이라이트를 정리한 뒤 새 패널을 연다.
function forceClosePanel(type) {
    const id = `ws-${type}-panel`;
    if (!document.getElementById(id)) return;
    clearDOMHighlights();
    if (type === 'change') SillyTavern.getContext().saveChat?.();
    closePanel(id);
}
function resolvePanelOpenAttempt(myType) {
    if (document.getElementById(`ws-${myType}-panel`)) { forceClosePanel(myType); return false; }
    const otherType = myType === 'find' ? 'change' : 'find';
    if (document.getElementById(`ws-${otherType}-panel`)) {
        forceClosePanel(otherType);
    }
    return true;
}

// 선택된 항목을 스크롤 목록 중앙에 배치
function centerActiveInList(fb) {
    requestAnimationFrame(() => {
        const scrollEl = fb.querySelector('.ws-thin-scroll');
        const activeEl = scrollEl?.querySelector('.ws-result-item.active');
        if (scrollEl && activeEl) scrollEl.scrollTop = Math.max(0, activeEl.offsetTop - scrollEl.clientHeight / 2 + activeEl.clientHeight / 2);
    });
}

// 검색 범위 제한 입력창 ("12-45", "3,5,20-30")
function rangeLimitRow() {
    const input = document.createElement('input'); input.type = 'text';
    input.className = 'ws-range-input';
    input.placeholder = '검색 범위';
    input.autocomplete = 'off'; input.autocorrect = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
    input.style.cssText = 'width:66px;padding:4px 8px;font-size:12px;border:1px solid var(--ws-border);border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;';
    return { el: input, getRange: () => parseRangeInputFlexible(input.value) };
}

// ─── /find ────────────────────────────────────────────────────────────────
function openFindKeywordPanel(useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('find')) return;
    const PANEL_ID = 'ws-find-panel';
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const rangeUI = rangeLimitRow();
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
    row.appendChild(rangeUI.el);
    const doFind = () => {
        const kw = input.value; if (!kw) return;
        const range = rangeUI.getRange();
        if (range === 'invalid') { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut: 3000 }); return; }
        const center = centerOf(panel); closePanel(PANEL_ID);
        runFind(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center, range.idxs, useTranslation);
    };
    row.appendChild(btn('찾기', doFind, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });
}

function runFind(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null, allowedIdxs = null, useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('find')) return;
    const PANEL_ID = 'ws-find-panel', chat = getChat();
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? 'g' : 'gi';
    const getText = useTranslation
        ? (msg => msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? msg.mes)
        : null;
    const ignoreReasoningEffective = !!wsSettings.ignoreReasoningBlocks;
    const allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut: 3000 }); return; }

    const matchCountPerMsg = {};
    allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
    const uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
    let current = 0, showingList = false, followScroll = true;

    applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord, jumpToMatch);
    const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); closePanel(PANEL_ID); }, true), fb = getPanelBody(panel);
    const FIND_H = '105px';

    function setFixed() {
        Object.assign(fb.style, { display: 'block', flex: 'none', height: FIND_H, maxHeight: '', overflowY: 'auto', padding: '4px 16px 12px' });
    }

    function navigate(newIdx, forceScroll = false) {
        current = newIdx; updateCurrentMark(current); render();
        const m = allMatches[current];
        if (followScroll) scrollToMark(current, m.msgIdx, true);
        else if (forceScroll) scrollToMark(current, m.msgIdx, false);
    }

    // 마크 직접 탭 시 스크롤은 유지하고 현재 위치만 갱신
    function jumpToMatch(idx) {
        showingList = false;
        current = idx; updateCurrentMark(current); render();
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;
        if (showingList) {
            const items = uniqueIdxs.map(msgIdx => {
                const isCur = allMatches[current].msgIdx === msgIdx;
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (isCur ? ' active' : '');
                const cnt = matchCountPerMsg[msgIdx];
                item.innerHTML = `<span style="color:var(--ws-text2);margin-right:8px;font-size:11px">#${msgIdx}</span>${cnt > 1 ? `<span style="color:var(--ws-text2);font-size:12px">(${cnt}회)</span>` : ''}`;
                item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx), true); showingList = false; render(); });
                return item;
            });
            renderList(fb, items, () => { showingList = false; render(); });
            centerActiveInList(fb);
        } else {
            setFixed(); fb.innerHTML = '';
            const m = allMatches[current];
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:20px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;white-space:nowrap;flex-shrink:0;';
            titleEl.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;white-space:nowrap;margin-left:auto;flex-shrink:0;';
            posEl.textContent = `#${m.msgIdx} (${current + 1}/${allMatches.length})`;
            header.appendChild(titleEl); header.appendChild(makeFollowChk(() => followScroll, v => { followScroll = v; })); header.appendChild(posEl);
            fb.appendChild(header);
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
            const navL = document.createElement('div'); navL.style.cssText = 'display:flex;gap:6px;';
            navL.appendChild(btn('◀ 이전', () => { if (current === 0) { toastr.info('처음입니다.', '', { timeOut: 2000 }); return; } navigate(current - 1); }));
            navL.appendChild(btn('다음 ▶', () => { if (current < allMatches.length - 1) navigate(current + 1); else toastr.info('마지막입니다.', '', { timeOut: 2000 }); }));
            const navR = document.createElement('div'); navR.style.cssText = 'display:flex;gap:6px;';
            navR.appendChild(btn('목록', () => { showingList = true; render(); }));
            row.appendChild(navL); row.appendChild(navR); fb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    render(); scrollToMark(0, allMatches[0].msgIdx, followScroll);
}

// ─── /change ──────────────────────────────────────────────────────────────
function openChangeKeywordPanel(useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('change')) return;
    const PANEL_ID = 'ws-change-panel';
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const rangeUI = rangeLimitRow();
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
    row.appendChild(rangeUI.el);
    const doChange = () => {
        const kw = input.value; if (!kw) return;
        const range = rangeUI.getRange();
        if (range === 'invalid') { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut: 3000 }); return; }
        const center = centerOf(panel); closePanel(PANEL_ID);
        runChange(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center, range.idxs, useTranslation);
    };
    row.appendChild(btn('찾기', doChange, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doChange(); });
}

export function runChange(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null, allowedIdxs = null, useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('change')) return;
    const PANEL_ID = 'ws-change-panel', chat = getChat();
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
    const flags = caseSensitive ? 'g' : 'gi';
    const getText = useTranslation
        ? (msg => msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? msg.mes)
        : null;
    const ignoreReasoningEffective = !!wsSettings.ignoreReasoningBlocks;
    let allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut: 3000 }); return; }

    let uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
    let matchCountPerMsg = {};
    allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
    let current = 0, mode = 'menu', listReturnMode = 'one', lastReplace = '', lastRangeInput = '', followScroll = true;

    applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord, jumpToMatch);
    const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); SillyTavern.getContext().saveChat?.(); closePanel(PANEL_ID); }, true), cb = getPanelBody(panel);
    function setFixed() {
        Object.assign(cb.style, { display: 'block', flex: 'none', height: '', maxHeight: '', overflowY: 'visible', padding: '4px 16px 16px' });
    }
    function navigate(newIdx, forceScroll = false) {
        current = newIdx; updateCurrentMark(current); render();
        const m = allMatches[current];
        if (followScroll) scrollToMark(current, m.msgIdx, true);
        else if (forceScroll) scrollToMark(current, m.msgIdx, false);
    }
    // 마크 직접 탭 시 스크롤은 유지하고 현재 위치만 갱신
    function jumpToMatch(idx) {
        mode = 'one';
        current = idx; updateCurrentMark(current); render();
    }
    function buildReFlags() {
        let f = flags.includes('g') ? flags : flags + 'g';
        if (wholeWord && !f.includes('u')) f += 'u';
        if (!f.includes('d')) f += 'd';
        return f;
    }
    // 마스킹된 텍스트와 오프셋이 동일한 원본 텍스트를 직접 잘라 치환
    const getRaw = msgIdx => {
        const msg = chat?.[msgIdx];
        if (!msg) return null;
        if (!useTranslation) return msg.mes;
        return msg.extra?.display_text ?? msg.extra?.magic_translation?.translatedText ?? msg.mes;
    };
    const setRaw = (msgIdx, val, skipSave = false) => {
        const msg = chat?.[msgIdx];
        if (!msg) return;
        if (!useTranslation) return editMessage(msgIdx, val, skipSave);
        // 번역문 필드가 없으면 원문에 반영
        const hasTrans = msg.extra?.display_text !== undefined || msg.extra?.magic_translation !== undefined;
        return hasTrans ? editTranslatedText(msgIdx, val, skipSave) : editMessage(msgIdx, val, skipSave);
    };
    async function doReplaceOne(msgIdx, matchIdx, rep) {
        const raw = getRaw(msgIdx);
        if (raw === null || raw === undefined) { toastr.warning('대상 메시지를 찾을 수 없습니다.', '', { timeOut: 2500 }); return; }
        let searchText = raw;
        if (ignoreReasoningEffective) searchText = maskReasoningBlocks(searchText);
        if (ignoreTags) searchText = maskTags(searchText);
        const re = new RegExp(re_esc, buildReFlags());
        const matches = [...searchText.matchAll(re)];
        const m = matches[matchIdx];
        if (!m?.indices) return;
        const [s, e] = m.indices[0];
        await setRaw(msgIdx, raw.slice(0, s) + rep + raw.slice(e));
    }
    async function doReplaceAll(msgIdx, rep, skipSave = false) {
        const raw = getRaw(msgIdx);
        if (raw === null || raw === undefined) return;
        let searchText = raw;
        if (ignoreReasoningEffective) searchText = maskReasoningBlocks(searchText);
        if (ignoreTags) searchText = maskTags(searchText);
        const re = new RegExp(re_esc, buildReFlags());
        const matches = [...searchText.matchAll(re)];
        if (!matches.length) return;
        let result = raw;
        for (let i = matches.length - 1; i >= 0; i--) {
            if (!matches[i].indices) continue;
            const [s, e] = matches[i].indices[0];
            result = result.slice(0, s) + rep + result.slice(e);
        }
        await setRaw(msgIdx, result, skipSave);
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;
        if (mode === 'list') {
            const items = uniqueIdxs.map(msgIdx => {
                const isCur = allMatches[current]?.msgIdx === msgIdx;
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (isCur ? ' active' : '');
                const cnt = matchCountPerMsg[msgIdx];
                item.innerHTML = `<span style="color:var(--ws-text2);margin-right:8px;font-size:11px">#${msgIdx}</span>${cnt > 1 ? `<span style="color:var(--ws-text2);font-size:12px">(${cnt}회)</span>` : ''}`;
                item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx), true); mode = 'one'; render(); });
                return item;
            });
            renderList(cb, items, () => { mode = listReturnMode; render(); });
            centerActiveInList(cb);

        } else if (mode === 'menu') {
            setFixed(); cb.innerHTML = '';
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
            title.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            if (caseSensitive) { const b = document.createElement('span'); b.style.cssText = 'font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent = '대소문자 구분'; title.appendChild(b); }
            if (ignoreSpace) { const b = document.createElement('span'); b.style.cssText = 'font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent = '띄어쓰기 무시'; title.appendChild(b); }
            // 범위 지정 ("3-10" 또는 "1,3,5")
            const rangeWrap = document.createElement('span');
            rangeWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;';
            const rangeInput = document.createElement('input'); rangeInput.type = 'text';
            rangeInput.className = 'ws-range-input';
            rangeInput.placeholder = '범위 지정';
            rangeInput.value = lastRangeInput;
            rangeInput.autocomplete = 'off'; rangeInput.autocorrect = 'off'; rangeInput.autocapitalize = 'off'; rangeInput.spellcheck = false;
            rangeInput.style.cssText = 'width:56px;padding:2px 6px;font-size:11px;font-weight:400;border:1px solid var(--ws-border);border-radius:6px;background:var(--ws-panel2);color:var(--ws-text);outline:none;';
            rangeInput.addEventListener('input', () => { lastRangeInput = rangeInput.value; });
            rangeWrap.appendChild(rangeInput);
            title.appendChild(rangeWrap);
            cb.appendChild(title);
            const allRow = document.createElement('div'); allRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;';
            const repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.cssText = 'flex:1;';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; });
            allRow.appendChild(repInput);
            cb.appendChild(allRow);
            const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const menuLeft = document.createElement('div'); menuLeft.style.cssText = 'display:flex;gap:6px;';
            menuLeft.appendChild(btn('하나씩 검토', () => { mode = 'one'; render(); scrollToMark(current, allMatches[current].msgIdx, followScroll); }));
            menuLeft.appendChild(btn('목록', () => { listReturnMode = 'menu'; mode = 'list'; render(); }));
            row2.appendChild(menuLeft);
            row2.appendChild(btn('모두 바꾸기', async () => {
                lastReplace = repInput.value;
                let targetIdxs = uniqueIdxs;
                const rangeStr = rangeInput.value.trim();
                if (rangeStr) {
                    const parsed = parseChangeRangeInput(rangeStr);
                    if (!parsed) { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut: 4000 }); return; }
                    const parsedSet = new Set(parsed);
                    targetIdxs = uniqueIdxs.filter(idx => parsedSet.has(idx));
                    if (!targetIdxs.length) { toastr.info('수정할 메시지가 없습니다.', '', { timeOut: 3000 }); return; }
                }
                for (const msgIdx of targetIdxs) await doReplaceAll(msgIdx, repInput.value, true);
                await SillyTavern.getContext().saveChat?.();
                toastr.success(`${targetIdxs.length}개 메시지를 수정했습니다.`, '', { timeOut: 3000 });
                clearDOMHighlights(); closePanel(PANEL_ID);
            }, 'ws-btn-accent'));
            cb.appendChild(row2);

        } else { // one
            setFixed(); cb.innerHTML = '';
            const m = allMatches[current]; if (!m) { clearDOMHighlights(); closePanel(PANEL_ID); return; }
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;white-space:nowrap;flex-shrink:0;';
            titleEl.innerHTML = `"${escapeHTML(keyword)}" 검토`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;white-space:nowrap;margin-left:auto;flex-shrink:0;';
            posEl.textContent = `#${m.msgIdx} (${current + 1}/${allMatches.length})`;
            header.appendChild(titleEl); header.appendChild(makeFollowChk(() => followScroll, v => { followScroll = v; })); header.appendChild(posEl);
            cb.appendChild(header);
            const repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.marginBottom = '20px';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; }); cb.appendChild(repInput);
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:6px;';
            left.appendChild(btn('◀ 이전', () => { if (current === 0) { toastr.info('처음입니다.', '', { timeOut: 2000 }); return; } navigate(current - 1); }));
            left.appendChild(btn('다음 ▶', () => { if (current < allMatches.length - 1) navigate(current + 1); else toastr.info('마지막입니다.', '', { timeOut: 2000 }); }));
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:6px;';
            right.appendChild(btn('목록', () => { listReturnMode = 'one'; mode = 'list'; render(); }));
            right.appendChild(btn('바꾸기', async () => {
                const rep = repInput.value;
                lastReplace = rep;
                await doReplaceOne(m.msgIdx, m.matchIdx, rep);
                await SillyTavern.getContext().saveChat?.();
                allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
                uniqueIdxs = [...new Set(allMatches.map(am => am.msgIdx))];
                matchCountPerMsg = {}; allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
                if (!allMatches.length) { toastr.success('단어 수정이 완료되었습니다.', '', { timeOut: 3000 }); clearDOMHighlights(); closePanel(PANEL_ID); return; }
                const minOffset = m.charIdx + rep.length;
                const nextIdx = allMatches.findIndex(am =>
                    am.msgIdx > m.msgIdx || (am.msgIdx === m.msgIdx && am.charIdx >= minOffset)
                );
                current = nextIdx >= 0 ? nextIdx : allMatches.length - 1;
                applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, current, wholeWord, jumpToMatch);
                render(); scrollToMark(current, allMatches[current].msgIdx, followScroll);
            }, 'ws-btn-accent'));
            row.appendChild(left); row.appendChild(right); cb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    render(); scrollToMark(0, allMatches[0].msgIdx, followScroll);
}

export function registerFindChangeCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'finds', helpString: 'Search messages in chat. Usage: /finds',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Search keyword (omit to type in popup)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: (_a, value) => {
            const rawVal = String(value || '').trim();
            const keyword = rawVal || getLastChatSelection();
            if (!keyword) { openFindKeywordPanel(); return ''; }
            runFind(keyword, false, false); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'change', helpString: 'Find and replace messages in chat. Usage: /change',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Search keyword (omit to type in popup)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: (_a, value) => {
            const rawVal = String(value || '').trim();
            const keyword = rawVal || getLastChatSelection();
            if (!keyword) { openChangeKeywordPanel(); return ''; }
            runChange(keyword, false, false); return '';
        },
    }));

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const evtChatChanged = ctx?.eventTypes?.CHAT_CHANGED ?? ctx?.event_types?.CHAT_CHANGED ?? 'chat_id_changed';
    if (ctx?.eventSource) {
        ctx.eventSource.on(evtChatChanged, () => {
            clearDOMHighlights();
            closePanel('ws-find-panel');
            closePanel('ws-change-panel');
        });
    }
}
