// ─── panel-ui.js ────────────────────────────────────────────────────────────
// 드래그 가능한 패널, 버튼, 입력창 등 여러 기능이 공유하는 UI 빌더.

import { raiseToTop, raiseToTopHigh } from './state.js';

export function getViewportBounds() {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv && vv.width > 0 && vv.height > 0) {
        return {
            left: Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0,
            top: Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0,
            width: vv.width,
            height: vv.height,
        };
    }
    return {
        left: 0,
        top: 0,
        width: (typeof window !== 'undefined' && window.innerWidth) || 0,
        height: (typeof window !== 'undefined' && window.innerHeight) || 0,
    };
}

function clampPanelToViewport(panel) {
    if (!panel?.isConnected) return;
    const vp = getViewportBounds();
    const availW = Math.max(220, Math.floor(vp.width - 12));
    const availH = Math.max(160, Math.floor(vp.height - 20));
    panel.style.maxWidth = `${availW}px`;
    panel.style.maxHeight = `${availH}px`;

    const pw = panel.offsetWidth || Math.min(400, availW);
    const ph = panel.offsetHeight || Math.min(200, availH);
    const rect = panel.getBoundingClientRect();
    let left = Number.isFinite(parseFloat(panel.style.left)) ? parseFloat(panel.style.left) : rect.left;
    let top = Number.isFinite(parseFloat(panel.style.top)) ? parseFloat(panel.style.top) : rect.top;

    const minLeft = vp.left + 6;
    const maxLeft = Math.max(minLeft, vp.left + vp.width - pw - 6);
    const minTop = vp.top + 10;
    const maxTop = Math.max(minTop, vp.top + vp.height - ph - 10);

    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(minTop, Math.min(top, maxTop));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
}

function positionPanelInViewport(panel, posCenter = null) {
    if (!panel?.isConnected) return;
    const vp = getViewportBounds();
    const availW = Math.max(220, Math.floor(vp.width - 12));
    const availH = Math.max(160, Math.floor(vp.height - 20));
    panel.style.maxWidth = `${availW}px`;
    panel.style.maxHeight = `${availH}px`;

    const pw = panel.offsetWidth || Math.min(400, availW);
    const ph = panel.offsetHeight || Math.min(200, availH);
    let left, top;
    if (posCenter) {
        left = posCenter.cx - pw / 2;
        top = posCenter.cy - ph / 2;
    } else {
        left = vp.left + (vp.width - pw) / 2;
        const lift = Math.min(20, Math.max(0, (vp.height - ph) * 0.08));
        top = vp.top + (vp.height - ph) / 2 - lift;
    }
    const minLeft = vp.left + 6;
    const maxLeft = Math.max(minLeft, vp.left + vp.width - pw - 6);
    const minTop = vp.top + 10;
    const maxTop = Math.max(minTop, vp.top + vp.height - ph - 10);
    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(minTop, Math.min(top, maxTop));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
}

export function makeDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target?.closest?.('button, input, select, textarea, a')) return;
        const r = panel.getBoundingClientRect();
        drag = { sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top, pid: e.pointerId, moved: false };
        panel.style.left = `${r.left}px`; panel.style.top = `${r.top}px`;
        handle.style.cursor = 'grabbing';
        try { handle.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.pid) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            drag.moved = true;
            panel._wsUserDragged = true;
        }
        const vp = getViewportBounds();
        const pw = panel.offsetWidth || 200;
        const minTop = vp.top + 4;
        const maxTop = Math.max(minTop, vp.top + vp.height - 36);
        const minLeft = vp.left - pw + 60;
        const maxLeft = vp.left + vp.width - 60;
        panel.style.left = `${Math.max(minLeft, Math.min(drag.ol + dx, maxLeft))}px`;
        panel.style.top = `${Math.max(minTop, Math.min(drag.ot + dy, maxTop))}px`;
    });
    const endDrag = (e) => {
        if (!drag || (e && e.pointerId !== drag.pid)) return;
        if (drag.pid !== undefined) {
            try { if (handle.hasPointerCapture?.(drag.pid)) handle.releasePointerCapture(drag.pid); } catch {}
        }
        drag = null;
        handle.style.cursor = 'grab';
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}

export function createPanel(id, posCenter = null, onCloseX = null, highPriority = false) {
    document.getElementById(id)?.remove();
    const raise = highPriority ? raiseToTopHigh : raiseToTop;
    const panel = document.createElement('div'); panel.id = id; panel.className = 'popup ws-panel';
    panel.style.cssText = `position:fixed;top:0;left:0;width:min(400px,92vw);max-height:88vh;
        display:flex;flex-direction:column;background:var(--ws-panel);color:var(--ws-text);
        border:1px solid var(--ws-border);border-radius:var(--ws-radius);overflow:hidden;
        box-shadow:0 4px 16px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.04);
        font-size:13px;font-family:inherit;user-select:none;opacity:0;`;
    const handle = document.createElement('div');
    handle.style.cssText = `padding:8px 8px 8px 14px;background:var(--ws-panel3);cursor:grab;
        display:flex;align-items:center;justify-content:flex-end;touch-action:none;`;
    panel.appendChild(handle);
    const closeXBtn = document.createElement('button'); closeXBtn.textContent = '✕';
    closeXBtn.style.cssText = `background:transparent;border:none;color:var(--ws-text2);
        font-size:13px;font-family:inherit;cursor:pointer;width:22px;height:22px;
        display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;flex-shrink:0;`;
    closeXBtn.addEventListener('pointerenter', () => { closeXBtn.style.background = 'rgba(0,0,0,0.05)'; });
    closeXBtn.addEventListener('pointerleave', () => { closeXBtn.style.background = 'transparent'; });
    closeXBtn.addEventListener('pointerdown', e => e.stopPropagation());
    closeXBtn.addEventListener('click', e => { e.stopPropagation(); (onCloseX || (() => closePanel(id)))(); });
    handle.appendChild(closeXBtn);
    const body = document.createElement('div');
    body.className = 'ws-panel-body'; body.style.cssText = 'padding:4px 16px 16px;overflow-y:auto;flex:1;';
    panel.appendChild(body);
    document.body.appendChild(panel);

    // ST 드로어 외부 클릭 닫기 방지
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });
    panel.addEventListener('pointerdown', () => raise(panel));
    raise(panel);

    // 초기 750ms 내 뷰포트 안정화 시 재정렬, 이후엔 뷰포트 내 클램핑만 수행
    const createdAt = Date.now();
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    let settleTimer = null;
    const syncViewport = () => {
        if (!panel.isConnected) { cleanup(); return; }
        if (!panel._wsPositioned) return;
        const activeInside = typeof document !== 'undefined' && panel.contains(document.activeElement);
        if (!posCenter && !panel._wsUserDragged && !activeInside && (Date.now() - createdAt) <= 750) {
            positionPanelInViewport(panel, null);
        } else {
            clampPanelToViewport(panel);
        }
    };
    const cleanup = () => {
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        vv?.removeEventListener?.('resize', syncViewport);
        vv?.removeEventListener?.('scroll', syncViewport);
        window?.removeEventListener?.('resize', syncViewport);
    };
    const origRemove = panel.remove?.bind(panel);
    if (origRemove) {
        panel.remove = () => { cleanup(); origRemove(); };
    }
    vv?.addEventListener?.('resize', syncViewport);
    vv?.addEventListener?.('scroll', syncViewport);
    window?.addEventListener?.('resize', syncViewport);

    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!panel.isConnected) { cleanup(); return; }
        positionPanelInViewport(panel, posCenter);
        panel.style.opacity = '1';
        panel._wsPositioned = true;
        settleTimer = setTimeout(() => {
            settleTimer = null;
            syncViewport();
        }, 360);
    }));
    makeDraggable(panel, handle);
    return panel;
}

export const centerOf = el => { const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };

export function keepCenter(panel, prevCenter) {
    if (!prevCenter) return;
    requestAnimationFrame(() => {
        if (!panel.isConnected) return;
        positionPanelInViewport(panel, prevCenter);
    });
}

export const getPanelBody = p => p.querySelector('.ws-panel-body');

export function btn(label, onClick, extra = '') {
    const b = document.createElement('button'); b.textContent = label;
    b.className = 'ws-btn' + (extra ? ' ' + extra : ''); b.addEventListener('click', onClick); return b;
}

export function inputBox(ph) {
    const i = document.createElement('input'); i.type = 'text'; i.placeholder = ph;
    // iOS 자동교정/자동완성이 포커스를 잃을 때 앞뒤 공백을 임의로 지우는 걸 방지
    i.autocomplete = 'off'; i.autocorrect = 'off'; i.autocapitalize = 'off'; i.spellcheck = false;
    i.className = 'ws-input'; i.style.marginBottom = '10px'; return i;
}

export function searchOptions() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:10px;';
    function makeChk(label) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode(label)); wrap.appendChild(lbl); return chk;
    }
    // 2줄 배치: 대소문자 구분 | 띄어쓰기 무시
    //         전체 단어 일치 | 태그 무시
    const caseChk = makeChk('대소문자 구분'), spaceChk = makeChk('띄어쓰기 무시');
    const wordChk = makeChk('전체 단어 일치'), tagChk = makeChk('태그 무시');
    return {
        el: wrap,
        getCaseSensitive: () => caseChk.checked,
        getIgnoreSpace: () => spaceChk.checked,
        getWholeWord: () => wordChk.checked,
        getIgnoreTags: () => tagChk.checked,
    };
}

export const closePanel = id => document.getElementById(id)?.remove();

export function makeFollowChk(getVal, setVal) {
    const lbl = document.createElement('label'); lbl.className = 'ws-label';
    lbl.style.cssText = 'font-size:11px;color:var(--ws-text2);white-space:nowrap;flex-shrink:0;gap:4px;';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check'; chk.checked = getVal();
    chk.addEventListener('change', () => setVal(chk.checked));
    lbl.appendChild(chk); lbl.appendChild(document.createTextNode('스크롤 따라가기')); return lbl;
}

export function renderList(fb, items, onBack) {
    Object.assign(fb.style, { display: 'flex', flexDirection: 'column', padding: '4px 16px 0', overflow: 'hidden', flex: '0 1 auto', minHeight: '0', height: 'auto', maxHeight: '320px' });
    fb.innerHTML = '';
    const scroll = document.createElement('div'); scroll.className = 'ws-thin-scroll'; scroll.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';
    items.forEach(item => scroll.appendChild(item)); fb.appendChild(scroll);
    if (onBack) {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;flex-shrink:0;padding:10px 0 12px;margin-top:4px;';
        row.appendChild(btn('돌아가기', onBack));
        fb.appendChild(row);
    }
}
