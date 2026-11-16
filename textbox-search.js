// ─── textbox-search.js ──────────────────────────────────────────────────────
// 텍스트박스(사용자 정의 CSS / 캐릭터 설명 / 첫 메시지 / 페르소나 / 로어북) 찾기 및 바꾸기.

import { createPanel, getPanelBody, closePanel, centerOf, keepCenter, btn, inputBox, searchOptions, renderList } from './panel-ui.js';
import { escapeHTML, applyFiller, applyWholeWord, maskTags, ESC_SPECIAL } from './utils.js';

const GROUPS = [
    {
        key: 'customCSS',
        selector: '#customCSS, textarea#customCSS',
        readOnly: true,
    },
    {
        key: 'description',
        selector: '#description_textarea, textarea#description_textarea',
        readOnly: false,
    },
    {
        key: 'firstMessage',
        selector: '#firstmessage_textarea, #firstMessage_textarea, #first_message_textarea, #first_message',
        readOnly: false,
    },
    {
        key: 'persona',
        selector: '#persona_description, textarea#persona_description',
        readOnly: false,
    },
    {
        key: 'worldEntry',
        selector: 'textarea[id^="world_entry_content_"]',
        readOnly: false,
    },
];

function getGroupElements(group) {
    if (group.targetEl && group.targetEl.isConnected) return [group.targetEl];
    const el = document.querySelector(group.selector);
    return el ? [el] : [];
}

// ─── 오버레이(빨간 밑줄) ────────────────────────────────────────────────
const OVERLAY_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'textAlign', 'textIndent', 'tabSize',
    'whiteSpace', 'wordWrap', 'wordBreak',
];

function syncOverlayGeometry(ta, overlay) {
    const cs = getComputedStyle(ta);
    OVERLAY_STYLE_PROPS.forEach(p => { overlay.style[p] = cs[p]; });
    const hasScrollbar = ta.scrollHeight > ta.clientHeight + 1;
    const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const scrollbarW = Math.max(0, ta.offsetWidth - ta.clientWidth - borderX);
    overlay.style.width = `${ta.offsetWidth - (hasScrollbar ? scrollbarW : 0)}px`;
    overlay.style.height = `${ta.offsetHeight}px`;
    overlay.style.top = `${ta.offsetTop}px`;
    overlay.style.left = `${ta.offsetLeft}px`;
    overlay.style.margin = '0';
}

function ensureOverlay(ta) {
    if (!ta || !ta.isConnected) return null;
    if (ta._wsOverlay) return ta._wsOverlay;
    const parent = ta.parentElement;
    if (!parent) return null;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.className = 'ws-textbox-overlay';
    overlay.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;'
        + 'white-space:pre-wrap;word-wrap:break-word;word-break:break-word;'
        + 'color:transparent;background:transparent;z-index:2;margin:0;';
    parent.insertBefore(overlay, ta.nextSibling);
    syncOverlayGeometry(ta, overlay);

    const syncScroll = () => {
        overlay.scrollTop = ta.scrollTop;
        overlay.scrollLeft = ta.scrollLeft;
    };
    const onResize = () => {
        syncOverlayGeometry(ta, overlay);
        syncScroll();
    };
    window.addEventListener('resize', onResize, { passive: true });
    ta.addEventListener('scroll', syncScroll, { passive: true });
    syncScroll();

    const onMarkClick = e => {
        const mark = e.target.closest('mark[data-idx]');
        if (!mark) return;
        e.stopPropagation();
        overlay._wsOnMarkClick?.(parseInt(mark.dataset.idx, 10));
    };
    overlay.addEventListener('click', onMarkClick);
    ta._wsOverlay = overlay;
    ta._wsOverlayCleanup = () => {
        window.removeEventListener('resize', onResize);
        ta.removeEventListener('scroll', syncScroll);
        overlay.removeEventListener('click', onMarkClick);
        overlay.remove();
        ta._wsOverlay = null;
        ta._wsOverlayCleanup = null;
    };
    return overlay;
}

function removeOverlay(ta) { ta._wsOverlayCleanup?.(); }
function clearOverlays(elements) { elements.forEach(removeOverlay); }

function renderOverlayContent(ta, matchesForEl, currentGlobalIdx) {
    const overlay = ensureOverlay(ta);
    if (!overlay) return;
    syncOverlayGeometry(ta, overlay);
    const text = ta.value;
    if (!matchesForEl.length) { overlay.innerHTML = escapeHTML(text); return; }
    let html = '', pos = 0;
    for (const m of matchesForEl) {
        html += escapeHTML(text.slice(pos, m.start));
        html += `<mark data-idx="${m.globalIdx}" class="${m.globalIdx === currentGlobalIdx ? 'ws-tb-cur' : ''}">${escapeHTML(text.slice(m.start, m.end))}</mark>`;
        pos = m.end;
    }
    html += escapeHTML(text.slice(pos));
    overlay.innerHTML = html;
}

// ─── 매치 탐색 ────────────────────────────────────────────────────────────
function buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags) {
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
    let re_flags = flags.includes('g') ? flags : flags + 'g';
    if (wholeWord && !re_flags.includes('u')) re_flags += 'u';
    if (!re_flags.includes('d')) re_flags += 'd';
    const all = [];
    elements.forEach((el, elIdx) => {
        const searchText = ignoreTags ? maskTags(el.value) : el.value;
        const re = new RegExp(re_esc, re_flags);
        let m;
        while ((m = re.exec(searchText)) !== null) {
            if (m.index === re.lastIndex) { re.lastIndex++; continue; }
            const [s, e] = m.indices[0];
            all.push({ elIdx, start: s, end: e });
        }
    });
    all.forEach((m, i) => { m.globalIdx = i; });
    return all;
}

function buildSnippet(text, start, end, leftPad = 25, rightPad = 40) {
    const left = text.slice(Math.max(0, start - leftPad), start);
    const right = text.slice(end, end + rightPad);
    const rightEllipsis = end + rightPad < text.length ? '…' : '';
    return `${escapeHTML(left)}<b>${escapeHTML(text.slice(start, end))}</b>${escapeHTML(right)}${rightEllipsis}`;
}

function centerActiveInScroll(scrollEl) {
    requestAnimationFrame(() => {
        const activeEl = scrollEl?.querySelector('.ws-result-item.active');
        if (!scrollEl || !activeEl) return;
        scrollEl.scrollTop = Math.max(0, activeEl.offsetTop - scrollEl.clientHeight / 2 + activeEl.clientHeight / 2);
    });
}

// ─── 패널 상태 관리(토글용) ─────────────────────────────────────────────────
const PANEL_ID = 'ws-tbchange-panel';
let _tbCloseFn = null;
let _tbTargetEl = null;

function closeTextboxPanel() { _tbCloseFn?.(); _tbCloseFn = null; _tbTargetEl = null; }

function toggleTextboxPanel(group, el) {
    if (document.getElementById(PANEL_ID)) {
        const switchedTarget = Boolean(el && _tbTargetEl && el !== _tbTargetEl);
        closeTextboxPanel();
        if (!switchedTarget) return;
    }
    openTextboxKeywordPanel(group, el);
}

function openTextboxKeywordPanel(group, targetEl) {
    const target = targetEl || document.querySelector(group.selector);
    _tbTargetEl = target;
    createPanel(PANEL_ID, null, () => _tbCloseFn?.(), true);
    _tbCloseFn = () => { closePanel(PANEL_ID); _tbCloseFn = null; _tbTargetEl = null; };
    const panel = document.getElementById(PANEL_ID);
    const body = getPanelBody(panel);
    body.innerHTML = '';
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;';
    const doSearch = () => {
        const kw = input.value; if (!kw) return;
        runTextboxChange(panel, group, kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), target);
    };
    row.appendChild(btn('찾기', doSearch, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}

function runTextboxChange(panel, group, keyword, caseSensitive, ignoreSpace, wholeWord, ignoreTags, targetEl = null) {
    const readOnly = !!group.readOnly;
    const elements = (targetEl && targetEl.isConnected && targetEl.tagName === 'TEXTAREA') ? [targetEl] : getGroupElements(group);
    if (!elements.length) { toastr.info('텍스트박스를 찾을 수 없습니다.', '', { timeOut: 3000 }); return; }
    const escaped = ESC_SPECIAL(keyword);
    const flags = caseSensitive ? 'g' : 'gi';
    let allMatches = buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut: 3000 }); return; }

    let current = 0, mode = readOnly ? 'one' : 'menu', listReturnMode = mode, lastReplace = '';

    function redrawOverlays() {
        const byEl = new Map();
        allMatches.forEach(m => { if (!byEl.has(m.elIdx)) byEl.set(m.elIdx, []); byEl.get(m.elIdx).push(m); });
        elements.forEach((el, i) => {
            renderOverlayContent(el, byEl.get(i) || [], allMatches[current]?.globalIdx);
            if (el._wsOverlay) el._wsOverlay._wsOnMarkClick = idx => {
                mode = 'one'; current = idx; redrawOverlays(); render();
            };
        });
    }

    let inputDebounceTimer = null;
    let _matchesDirty = false;
    let _suppressInput = false;
    let _closed = false;
    const flushDirtyMatches = () => {
        if (!_matchesDirty) return true;
        clearTimeout(inputDebounceTimer);
        _matchesDirty = false;
        rebuildMatches();
        elements.forEach(el => { if (el._wsOverlay) el._wsOverlay.style.opacity = '1'; });
        if (!allMatches.length) {
            toastr.info('검색 결과가 없습니다.', '', { timeOut: 2500 });
            cleanupAndClose();
            return false;
        }
        if (current >= allMatches.length) current = allMatches.length - 1;
        return true;
    };
    const onInput = () => {
        if (_suppressInput) return;
        _matchesDirty = true;
        elements.forEach(el => { if (el._wsOverlay) el._wsOverlay.style.opacity = '0.35'; });
        clearTimeout(inputDebounceTimer);
        inputDebounceTimer = setTimeout(() => {
            if (_closed) return;
            _matchesDirty = false;
            rebuildMatches();
            elements.forEach(el => { if (el._wsOverlay) el._wsOverlay.style.opacity = '1'; });
            if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut: 2500 }); cleanupAndClose(); return; }
            if (current >= allMatches.length) current = allMatches.length - 1;
            redrawOverlays(); render();
        }, 400);
    };
    elements.forEach(el => el.addEventListener('input', onInput));

    // 패널 닫기 및 리소스 정리
    function cleanupAndClose() {
        if (_closed) return;
        _closed = true;
        clearTimeout(inputDebounceTimer);
        elements.forEach(el => el.removeEventListener('input', onInput));
        clearOverlays(elements);
        closePanel(PANEL_ID);
        _tbCloseFn = null;
        _tbTargetEl = null;
    }
    _tbCloseFn = () => cleanupAndClose();

    const cb = getPanelBody(panel);

    function rebuildMatches() {
        allMatches = buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
    }

    function focusCurrentMatch() {
        const m = allMatches[current]; if (!m) return;
        const el = elements[m.elIdx]; if (!el) return;
        // focus/setSelectionRange 대신 투명 오버레이 마크로만 포커스 표시 (모바일 선택 영역 생성 방지)
        try {
            const curMark = el._wsOverlay?.querySelector('.ws-tb-cur');
            if (curMark) {
                const markTop = curMark.offsetTop;
                const targetScrollTop = Math.max(0, markTop - Math.round(el.clientHeight / 2) + Math.round(curMark.offsetHeight / 2));
                el.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
                return;
            }
            const cs = getComputedStyle(el);
            const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.25) || 20;
            const linesBefore = (el.value.slice(0, m.start).match(/\n/g) || []).length;
            const targetScrollTop = Math.max(0, (linesBefore - 2) * lineH);
            el.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        } catch { }
    }

    function navigate(idx) {
        current = idx;
        redrawOverlays();
        render();
        focusCurrentMatch();
    }

    function doReplaceOne(m, repText) {
        const el = elements[m.elIdx]; if (!el) return;
        const v = el.value;
        _suppressInput = true;
        try {
            el.value = v.slice(0, m.start) + repText + v.slice(m.end);
            try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { }
            try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch { }
        } finally {
            _suppressInput = false;
        }
    }

    function doReplaceAll(repText) {
        const touchedEls = new Set();
        const lastEditedStartByEl = new Map();
        _suppressInput = true;
        try {
            for (let i = allMatches.length - 1; i >= 0; i--) {
                const m = allMatches[i];
                const el = elements[m.elIdx];
                if (!el) continue;
                const prevStart = lastEditedStartByEl.get(m.elIdx) ?? Infinity;
                if (m.end > prevStart) continue;
                const v = el.value;
                el.value = v.slice(0, m.start) + repText + v.slice(m.end);
                lastEditedStartByEl.set(m.elIdx, m.start);
                touchedEls.add(el);
            }
            for (const el of touchedEls) {
                try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { }
                try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch { }
            }
        } finally {
            _suppressInput = false;
        }
    }

    function setFixed() {
        Object.assign(cb.style, { display: 'block', flex: 'none', height: '', maxHeight: '', overflowY: 'visible', padding: '4px 16px 16px' });
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;

        if (mode === 'list') {
            const items = allMatches.map((m, i) => {
                const el = elements[m.elIdx];
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (i === current ? ' active' : '');
                item.style.cssText = 'display:flex;gap:8px;white-space:nowrap;overflow:hidden;align-items:center;';
                const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);font-size:11px;min-width:20px;flex-shrink:0;';
                num.textContent = `${i + 1}.`;
                const snip = document.createElement('span'); snip.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;';
                snip.innerHTML = buildSnippet(el.value, m.start, m.end);
                item.appendChild(num); item.appendChild(snip);
                item.addEventListener('click', () => { mode = 'one'; navigate(i); });
                return item;
            });
            renderList(cb, items, () => { mode = listReturnMode; render(); });
            centerActiveInScroll(cb.querySelector('.ws-thin-scroll'));

        } else if (mode === 'menu') {
            setFixed(); cb.innerHTML = '';
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
            title.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            if (caseSensitive) { const b = document.createElement('span'); b.style.cssText = 'font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent = '대소문자 구분'; title.appendChild(b); }
            if (ignoreSpace) { const b = document.createElement('span'); b.style.cssText = 'font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent = '띄어쓰기 무시'; title.appendChild(b); }
            cb.appendChild(title);
            const allRow = document.createElement('div'); allRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;';
            const repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.cssText = 'flex:1;';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; });
            allRow.appendChild(repInput);
            cb.appendChild(allRow);
            const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const menuLeft = document.createElement('div'); menuLeft.style.cssText = 'display:flex;gap:6px;';
            menuLeft.appendChild(btn('하나씩 검토', () => { if (!flushDirtyMatches()) return; mode = 'one'; navigate(current); }));
            menuLeft.appendChild(btn('목록', () => { if (!flushDirtyMatches()) return; listReturnMode = 'menu'; mode = 'list'; render(); }));
            row2.appendChild(menuLeft);
            row2.appendChild(btn('모두 바꾸기', () => {
                if (!flushDirtyMatches()) return;
                lastReplace = repInput.value;
                const count = allMatches.length;
                doReplaceAll(repInput.value);
                toastr.success(`${count}개를 수정했습니다.`, '', { timeOut: 3000 });
                cleanupAndClose();
            }, 'ws-btn-accent'));
            cb.appendChild(row2);

        } else { // one
            setFixed(); cb.innerHTML = '';
            const m = allMatches[current]; if (!m) { cleanupAndClose(); return; }
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;white-space:nowrap;flex-shrink:0;';
            titleEl.innerHTML = readOnly ? `"${escapeHTML(keyword)}"` : `"${escapeHTML(keyword)}" 검토`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;white-space:nowrap;margin-left:auto;flex-shrink:0;';
            posEl.textContent = `(${current + 1}/${allMatches.length})`;
            header.appendChild(titleEl); header.appendChild(posEl); cb.appendChild(header);
            let repInput = null;
            if (!readOnly) {
                repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.marginBottom = '20px';
                repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
                repInput.addEventListener('input', () => { lastReplace = repInput.value; }); cb.appendChild(repInput);
            }
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:6px;';
            left.appendChild(btn('◀ 이전', () => { if (!flushDirtyMatches()) return; if (current === 0) { toastr.info('처음입니다.', '', { timeOut: 2000 }); return; } navigate(current - 1); }));
            left.appendChild(btn('다음 ▶', () => { if (!flushDirtyMatches()) return; if (current < allMatches.length - 1) navigate(current + 1); else toastr.info('마지막입니다.', '', { timeOut: 2000 }); }));
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:6px;';
            right.appendChild(btn('목록', () => { if (!flushDirtyMatches()) return; listReturnMode = 'one'; mode = 'list'; render(); }));
            if (!readOnly) {
                right.appendChild(btn('바꾸기', () => {
                    if (!flushDirtyMatches()) return;
                    const curM = allMatches[current];
                    if (!curM) { cleanupAndClose(); return; }
                    const val = repInput ? repInput.value : lastReplace;
                    lastReplace = val;
                    const nextMinStart = curM.start + val.length;
                    doReplaceOne(curM, val);
                    _matchesDirty = false; clearTimeout(inputDebounceTimer);
                    rebuildMatches();
                    if (!allMatches.length) { toastr.success('수정이 완료되었습니다.', '', { timeOut: 3000 }); cleanupAndClose(); return; }
                    const nextIdx = allMatches.findIndex(am =>
                        am.elIdx > curM.elIdx || (am.elIdx === curM.elIdx && am.start >= nextMinStart)
                    );
                    current = nextIdx >= 0 ? nextIdx : allMatches.length - 1;
                    redrawOverlays(); render(); focusCurrentMatch();
                }, 'ws-btn-accent'));
            }
            row.appendChild(left); row.appendChild(right); cb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    redrawOverlays();
    render();
    focusCurrentMatch();
}

// ─── 플로팅 미니 버튼 (focusin/click 기반) ─────────────────────────────────

const FLOAT_BTN_SIZE = 23;
let _floatingBtn = null;
let _floatingGroup = null;
let _floatingTarget = null;
let _hideTimeout = null;
let _btnHovered = false;
let _scrollFollowAttached = false;

function findGroupForElement(el) {
    if (!el || (el.nodeType && el.nodeType !== 1) || el.tagName !== 'TEXTAREA') return null;
    // 확대 모달창(data-for, .maximized_textarea 등)은 배제하고 본 텍스트 상자만 타겟팅
    try {
        if (el.classList?.contains?.('maximized_textarea') || el.closest?.('#expression_holder') || el.closest?.('.zoomed_avatar') || el.closest?.('.notes_popup')) {
            return null;
        }
    } catch { }
    const id = el.id || '';
    if (id === 'customCSS') return GROUPS.find(g => g.key === 'customCSS');
    if (id === 'description_textarea') return GROUPS.find(g => g.key === 'description');
    if (id === 'firstmessage_textarea' || id === 'firstMessage_textarea' || id === 'first_message_textarea' || id === 'first_message') {
        return GROUPS.find(g => g.key === 'firstMessage');
    }
    if (id === 'persona_description') return GROUPS.find(g => g.key === 'persona');
    if (id.startsWith('world_entry_content_')) {
        return {
            key: 'worldEntry',
            selector: `#${id}`,
            readOnly: false,
            targetEl: el,
        };
    }

    const name = el.getAttribute('name') || '';
    if (name === 'description') return GROUPS.find(g => g.key === 'description');
    if (name === 'first_mes') return GROUPS.find(g => g.key === 'firstMessage');
    if (name === 'persona_description') return GROUPS.find(g => g.key === 'persona');

    for (const g of GROUPS) {
        try {
            if (el.matches(g.selector)) return g;
        } catch { }
    }
    return null;
}

let _syncRafId = null;
let _frameRafId = null;
let _syncTimerIds = [];
let _clipTarget = null;
let _clipContainers = null;
let _appliedTop = null;
let _appliedLeft = null;
let _fixedOffsetY = 0;
let _fixedOffsetX = 0;

function resetPositionCache() {
    _clipTarget = null;
    _clipContainers = null;
    _appliedTop = null;
    _appliedLeft = null;
    _fixedOffsetY = 0;
    _fixedOffsetX = 0;
}

function cancelFloatingSync() {
    if (_frameRafId !== null) {
        cancelAnimationFrame(_frameRafId);
        _frameRafId = null;
    }
    if (_syncRafId !== null) {
        cancelAnimationFrame(_syncRafId);
        _syncRafId = null;
    }
    if (_syncTimerIds.length) {
        _syncTimerIds.forEach(id => clearTimeout(id));
        _syncTimerIds = [];
    }
}

const CLIP_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay', 'hidden', 'clip']);

function getViewportBounds() {
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const left = vv ? vv.offsetLeft : 0;
    const height = vv ? vv.height : window.innerHeight;
    const width = vv ? vv.width : (document.documentElement.clientWidth || window.innerWidth);
    return { top, bottom: top + height, left, right: left + width };
}

function getClipContainers(ta) {
    if (_clipTarget === ta && _clipContainers) return _clipContainers;
    const containers = [];
    let el = ta?.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        const isPanelContainer = el.classList.contains('drawer-content')
            || el.id === 'character_popup'
            || el.id === 'world_popup'
            || el.classList.contains('popup');
        const clipY = isPanelContainer || CLIP_OVERFLOW_VALUES.has(cs.overflowY);
        const clipX = isPanelContainer || CLIP_OVERFLOW_VALUES.has(cs.overflowX);
        if (clipX || clipY) {
            containers.push({ el, clipX, clipY });
        }
        el = el.parentElement;
    }
    _clipTarget = ta;
    _clipContainers = containers;
    return containers;
}

function getInnerClipSpan(outerStart, outerEnd, fullSize, clientStart, clientSize, layoutSize) {
    if (clientSize <= 0) return [outerStart, outerEnd];
    const scale = layoutSize > 0 ? fullSize / layoutSize : 1;
    const innerStart = outerStart + clientStart * scale;
    return [innerStart, innerStart + clientSize * scale];
}

function getClipBounds(ta) {
    const vp = getViewportBounds();
    let clipTop = vp.top;
    let clipBottom = vp.bottom;
    let clipLeft = vp.left;
    let clipRight = vp.right;
    for (const { el, clipX, clipY } of getClipContainers(ta)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        // 테두리와 스크롤바 트랙을 제외한 실제 내부 가시 영역으로 클램프
        if (clipY) {
            const [innerTop, innerBottom] = getInnerClipSpan(rect.top, rect.bottom, rect.height, el.clientTop, el.clientHeight, el.offsetHeight);
            clipTop = Math.max(clipTop, innerTop);
            clipBottom = Math.min(clipBottom, innerBottom);
        }
        if (clipX) {
            const [innerLeft, innerRight] = getInnerClipSpan(rect.left, rect.right, rect.width, el.clientLeft, el.clientWidth, el.offsetWidth);
            clipLeft = Math.max(clipLeft, innerLeft);
            clipRight = Math.min(clipRight, innerRight);
        }
    }
    return { clipTop, clipBottom, clipLeft, clipRight };
}

function positionFloatingBtn(btn, ta, taRect = null, bounds = null) {
    if (!ta || !btn) return;
    const rect = taRect || ta.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // 1) Read-only 단계: 현재 오프셋 드리프트가 있다면 스타일 쓰기 전에 먼저 측정 (강제 리플로우 방지)
    const isVisible = btn.classList.contains('ws-tb-float-visible');
    if (isVisible && _appliedTop !== null && _appliedLeft !== null) {
        const btnRect = btn.getBoundingClientRect();
        if (btnRect.width > 0) {
            const nextOffsetY = Math.round(_appliedTop - btnRect.top);
            const nextOffsetX = Math.round(_appliedLeft - btnRect.left);
            _fixedOffsetY = Math.abs(nextOffsetY) >= 1 ? nextOffsetY : 0;
            _fixedOffsetX = Math.abs(nextOffsetX) >= 1 ? nextOffsetX : 0;
        }
    }

    // 2) textarea 내부 우측 상단 모서리 목표 좌표 계산 (드로어/뷰포트 상하·좌우 가시 범위 내 클램프)
    const { clipTop, clipBottom, clipLeft, clipRight } = bounds || getClipBounds(ta);
    const rawTop = Math.round(rect.top + 6);
    const clipMinTop = Math.round(clipTop + 6);
    const clipMaxTop = Math.round(clipBottom - FLOAT_BTN_SIZE - 4);
    let wantedTop = clipMinTop;
    if (clipMaxTop >= clipMinTop) {
        const maxTop = Math.min(clipMaxTop, Math.round(rect.bottom - FLOAT_BTN_SIZE - 4));
        wantedTop = maxTop >= clipMinTop
            ? Math.max(clipMinTop, Math.min(rawTop, maxTop))
            : clipMinTop;
    }

    const rawLeft = Math.round(rect.right - FLOAT_BTN_SIZE - 8);
    const clipMinLeft = Math.round(clipLeft + 6);
    const clipMaxLeft = Math.round(clipRight - FLOAT_BTN_SIZE - 8);
    let wantedLeft = clipMinLeft;
    if (clipMaxLeft >= clipMinLeft) {
        const minLeft = Math.max(clipMinLeft, Math.round(rect.left + 4));
        wantedLeft = minLeft <= clipMaxLeft
            ? Math.max(minLeft, Math.min(rawLeft, clipMaxLeft))
            : clipMaxLeft;
    }

    // 3) Write-only 단계: 실제 값이 바뀔 때만 스타일 갱신
    const nextTop = wantedTop + _fixedOffsetY;
    const nextLeft = wantedLeft + _fixedOffsetX;
    if (btn.style.position !== 'fixed') btn.style.position = 'fixed';
    if (_appliedTop !== nextTop) {
        btn.style.top = `${nextTop}px`;
        _appliedTop = nextTop;
    }
    if (_appliedLeft !== nextLeft) {
        btn.style.left = `${nextLeft}px`;
        _appliedLeft = nextLeft;
    }
    const sizePx = `${FLOAT_BTN_SIZE}px`;
    if (btn.style.width !== sizePx) btn.style.width = sizePx;
    if (btn.style.height !== sizePx) btn.style.height = sizePx;
}

const syncFloatingNow = () => {
    if (!_floatingBtn || !_floatingTarget || !_floatingBtn.classList.contains('ws-tb-float-visible')) {
        detachScrollFollow();
        return;
    }
    if (!_floatingTarget.isConnected) {
        hideFloatingBtn();
        return;
    }
    const taRect = _floatingTarget.getBoundingClientRect();
    const bounds = getClipBounds(_floatingTarget);
    const minNeedY = Math.min(Math.max(4, taRect.height - 2), FLOAT_BTN_SIZE + 4);
    const minNeedX = Math.min(Math.max(4, taRect.width - 2), FLOAT_BTN_SIZE + 6);
    // 텍스트박스가 화면/컨테이너(상하·좌우) 가시 영역 밖으로 벗어났을 때 숨김
    if (taRect.width === 0 || taRect.height === 0
        || taRect.bottom <= bounds.clipTop + minNeedY
        || taRect.top >= bounds.clipBottom - minNeedY
        || taRect.right <= bounds.clipLeft + minNeedX
        || taRect.left >= bounds.clipRight - minNeedX) {
        // 포커스가 살아있으면(가상키보드 전환 중 일시적 가려짐 등) 감시 유지하며 시각만 숨김
        if (document.activeElement === _floatingTarget && taRect.width > 0 && taRect.height > 0) {
            _floatingBtn.style.visibility = 'hidden';
            _floatingBtn.style.pointerEvents = 'none';
        } else {
            hideFloatingBtn();
        }
    } else {
        if (_floatingBtn.style.visibility) _floatingBtn.style.visibility = '';
        if (_floatingBtn.style.pointerEvents) _floatingBtn.style.pointerEvents = '';
        positionFloatingBtn(_floatingBtn, _floatingTarget, taRect, bounds);
    }
};

// 스크롤·입력·뷰포트 이동은 프레임당 최대 1회로 병합해 불필요한 계산 방지
const requestSyncFrame = () => {
    if (_frameRafId !== null) return;
    _frameRafId = requestAnimationFrame(() => {
        _frameRafId = null;
        syncFloatingNow();
    });
};

const onViewportResize = () => {
    requestSyncFrame();
    if (_floatingTarget && _floatingBtn?.classList.contains('ws-tb-float-visible')) {
        scheduleFloatingSync(_floatingTarget);
    }
};

function scheduleFloatingSync(ta) {
    cancelFloatingSync();
    const resync = () => {
        if (!_floatingBtn || !_floatingTarget || _floatingTarget !== ta || !_floatingTarget.isConnected) return;
        if (!_floatingBtn.classList.contains('ws-tb-float-visible')) return;
        syncFloatingNow();
    };
    _syncRafId = requestAnimationFrame(() => {
        _syncRafId = null;
        resync();
    });
    // 가상키보드 애니메이션 완료 시점에 맞춰 짧게 재동기화
    for (const ms of [150, 380]) {
        _syncTimerIds.push(setTimeout(resync, ms));
    }
}

function attachScrollFollow() {
    if (_scrollFollowAttached) return;
    _scrollFollowAttached = true;
    window.addEventListener('scroll', requestSyncFrame, { capture: true, passive: true });
    window.addEventListener('resize', onViewportResize, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportResize, { passive: true });
        window.visualViewport.addEventListener('scroll', requestSyncFrame, { passive: true });
    }
}

function detachScrollFollow() {
    cancelFloatingSync();
    if (!_scrollFollowAttached) return;
    _scrollFollowAttached = false;
    window.removeEventListener('scroll', requestSyncFrame, { capture: true });
    window.removeEventListener('resize', onViewportResize);
    if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onViewportResize);
        window.visualViewport.removeEventListener('scroll', requestSyncFrame);
    }
}

function cancelHide() {
    if (_hideTimeout) {
        clearTimeout(_hideTimeout);
        _hideTimeout = null;
    }
}

function scheduleHideFloatingBtn() {
    cancelHide();
    _hideTimeout = setTimeout(() => {
        if (_btnHovered) return;
        // 커서가 여전히 해당 텍스트박스 안에 있다면 숨기지 않음
        if (document.activeElement && findGroupForElement(document.activeElement)) {
            return;
        }
        hideFloatingBtn();
    }, 400);
}

function hideFloatingBtn() {
    cancelHide();
    _btnHovered = false;
    detachScrollFollow();
    resetPositionCache();
    if (_floatingBtn) {
        _floatingBtn.classList.remove('ws-tb-float-visible');
        _floatingBtn.style.visibility = '';
        _floatingBtn.style.pointerEvents = '';
    }
    _floatingGroup = null;
    _floatingTarget = null;
}

function createFloatingBtn() {
    const b = document.createElement('button');
    b.id = 'ws-tb-float-btn';
    b.type = 'button';
    // ST 드로어 닫힘 감지 화이트리스트(.popup) 클래스 부여
    b.className = 'popup ws-tb-float-trigger';
    b.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
    b.title = '텍스트 검색/수정';
    b.setAttribute('aria-label', '텍스트 검색/수정');

    let _lastTriggerTime = 0;
    function onTrigger(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
        const now = Date.now();
        if (now - _lastTriggerTime < 300) return;
        _lastTriggerTime = now;

        const grp = _floatingGroup;
        const tgt = _floatingTarget || (grp ? document.querySelector(grp.selector) : null);
        if (grp && tgt) {
            hideFloatingBtn();
            toggleTextboxPanel(grp, tgt);
        }
    }

    // 마우스/터치 다운 시 포커스 강탈 방지 및 ST 드로어 닫힘 전파 차단
    ['pointerdown', 'mousedown', 'touchstart'].forEach(evt => {
        b.addEventListener(evt, e => {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            if (evt !== 'touchstart' && e.pointerType !== 'touch') {
                _btnHovered = true;
            }
            cancelHide();
        }, { passive: false });
    });

    // 클릭 / 터치 완료 시 트리거 (터치 취소 시 hover 상태 잔류 방지)
    b.addEventListener('click', onTrigger);
    b.addEventListener('touchend', e => { _btnHovered = false; onTrigger(e); }, { passive: false });
    b.addEventListener('touchcancel', () => { _btnHovered = false; });
    b.addEventListener('pointercancel', () => { _btnHovered = false; });
    b.addEventListener('pointerup', e => { if (e.pointerType === 'touch') _btnHovered = false; });

    b.addEventListener('mouseenter', () => { _btnHovered = true; cancelHide(); });
    b.addEventListener('mouseleave', () => { _btnHovered = false; });

    return b;
}

function showFloatingBtn(group, ta) {
    if (!group || !ta) return;
    if (document.getElementById(PANEL_ID)) return; // 검색 패널이 열려있으면 패스

    cancelHide();

    if (!_floatingBtn) {
        _floatingBtn = createFloatingBtn();
        document.body.appendChild(_floatingBtn);
    } else if (_floatingBtn.parentElement !== document.body) {
        document.body.appendChild(_floatingBtn);
    }

    if (_floatingTarget !== ta) resetPositionCache();
    _floatingGroup = group;
    _floatingTarget = ta;

    _floatingBtn.style.visibility = '';
    _floatingBtn.style.pointerEvents = '';
    _floatingBtn.classList.add('ws-tb-float-visible');
    syncFloatingNow();

    // 모달/드로어 열림 및 모바일 가상키보드 애니메이션 완료까지 위치 재동기화
    attachScrollFollow();
    scheduleFloatingSync(ta);
}

// ─── 이벤트 리스너 등록 ────────────────────────────────────────────────────
let _delegateAttached = false;

function attachFocusDelegate() {
    if (_delegateAttached) return;
    _delegateAttached = true;

    const onUserActivate = e => {
        const group = findGroupForElement(e.target);
        if (group) {
            cancelHide();
            showFloatingBtn(group, e.target);
        }
    };

    const onDocInput = e => {
        if (_floatingTarget && e.target === _floatingTarget && _floatingBtn?.classList.contains('ws-tb-float-visible')) {
            cancelHide();
            requestSyncFrame();
            return;
        }
        onUserActivate(e);
    };
    const onDocFocusOut = e => {
        const group = findGroupForElement(e.target);
        if (group) {
            scheduleHideFloatingBtn();
        }
    };
    const onDocPointerDown = e => {
        if (!_floatingBtn || !_floatingBtn.classList.contains('ws-tb-float-visible')) return;
        if (e.target === _floatingBtn || _floatingBtn.contains(e.target)) return;
        if (e.target === _floatingTarget || findGroupForElement(e.target)) return;
        hideFloatingBtn();
    };
    const onDocKeyDown = e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            const active = document.activeElement;
            const group = findGroupForElement(active);
            if (group) {
                e.preventDefault();
                e.stopPropagation();
                hideFloatingBtn();
                toggleTextboxPanel(group, active);
            }
        }
    };

    document.addEventListener('pointerdown', onUserActivate, { passive: true });
    document.addEventListener('focusin', onUserActivate, { passive: true });
    document.addEventListener('input', onDocInput, { passive: true });
    document.addEventListener('focusout', onDocFocusOut, { passive: true });
    document.addEventListener('pointerdown', onDocPointerDown, { passive: true });
    document.addEventListener('keydown', onDocKeyDown, { capture: true });

    return () => {
        _delegateAttached = false;
        document.removeEventListener('pointerdown', onUserActivate);
        document.removeEventListener('focusin', onUserActivate);
        document.removeEventListener('input', onDocInput);
        document.removeEventListener('focusout', onDocFocusOut);
        document.removeEventListener('pointerdown', onDocPointerDown);
        document.removeEventListener('keydown', onDocKeyDown, { capture: true });
    };
}

export function initTextboxSearch() {
    if (window._wsTextboxSearch) window._wsTextboxSearch();

    const detachListeners = attachFocusDelegate();

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const evtChatChanged = ctx?.event_types?.CHAT_CHANGED ?? ctx?.eventTypes?.CHAT_CHANGED ?? 'chat_id_changed';
    const onChatChanged = () => {
        closeTextboxPanel();
        hideFloatingBtn();
    };
    ctx?.eventSource?.on?.(evtChatChanged, onChatChanged);

    // 현재 이미 textarea에 포커스가 들어가 있는 상태라면 즉시 표시
    if (document.activeElement) {
        const g = findGroupForElement(document.activeElement);
        if (g) showFloatingBtn(g, document.activeElement);
    }

    window._wsTextboxSearch = () => {
        detachListeners?.();
        try {
            if (typeof ctx?.eventSource?.removeListener === 'function') {
                ctx.eventSource.removeListener(evtChatChanged, onChatChanged);
            } else if (typeof ctx?.eventSource?.off === 'function') {
                ctx.eventSource.off(evtChatChanged, onChatChanged);
            }
        } catch { }
        closeTextboxPanel();
        hideFloatingBtn();
        if (_floatingBtn) {
            _floatingBtn.remove();
            _floatingBtn = null;
        }
        window._wsTextboxSearch = null;
    };
}
