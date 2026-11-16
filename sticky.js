// ─── sticky.js ───────────────────────────────────────────────────────────────
// /sticky — 포스트잇 메모 패널 (내용은 extensionSettings, UI 상태는 localStorage 저장).

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { raiseToTop, wsSettings, saveWsSettings, copyText } from './state.js';
import { makeDraggable } from './panel-ui.js';
import { escapeHTML } from './utils.js';

const STORAGE_KEY = 'slashieSticky';

const DEFAULT_W = 260, DEFAULT_H = 300;
const MIN_W = 160, MIN_H = 140;
const EDGE_MARGIN = 14;
const INITIAL_TOP_MARGIN = 40;

function loadStickyText() {
    try {
        const raw = SillyTavern.getContext().extensionSettings?.[STORAGE_KEY];
        return typeof raw?.text === 'string' ? raw.text : '';
    } catch { return ''; }
}

export const stickyData = { text: '', ...wsSettings.sticky };

function persistStickyText(immediate = false) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) return;
        ctx.extensionSettings[STORAGE_KEY] = { text: stickyData.text };
        ctx.saveSettingsDebounced?.();
        if (immediate) ctx.saveSettingsDebounced?.flush?.();
    } catch { }
}

export function persistStickyUI() {
    Object.assign(wsSettings.sticky, {
        rgb: stickyData.rgb, alpha: stickyData.alpha,
        left: stickyData.left, top: stickyData.top,
        width: stickyData.width, height: stickyData.height,
        scrollTop: stickyData.scrollTop, open: stickyData.open,
    });
    saveWsSettings();
}

export function applyStickyColor() {
    document.documentElement.style.setProperty('--ws-sticky-color', stickyData.rgb);
    document.documentElement.style.setProperty('--ws-sticky-opacity', String(stickyData.alpha / 100));
}

function clampGeometry(left, top, width, height) {
    const w = Math.min(Math.max(width, MIN_W), window.innerWidth - EDGE_MARGIN * 2);
    const h = Math.min(Math.max(height, MIN_H), window.innerHeight - EDGE_MARGIN * 2);
    let l = Math.max(EDGE_MARGIN, Math.min(left, window.innerWidth - w - EDGE_MARGIN));
    let t = Math.max(EDGE_MARGIN, Math.min(top, window.innerHeight - h - EDGE_MARGIN));
    return { left: l, top: t, width: w, height: h };
}

let _panel = null, _textarea = null;
let _idleTimer = null;

// 모바일·HTTP 호환: navigator.clipboard 실패 시 execCommand 폴백은 copyText가 처리
async function copyCodeToClipboard(text) {
    const ok = await copyText(text, false);
    if (ok) toastr.info('코드를 복사했습니다.', '', { timeOut: 1500 });
    else toastr.warning('복사에 실패했습니다.', '', { timeOut: 2000 });
}

// 코드블럭(```)만 렌더링하고 나머지 텍스트는 이스케이프
function renderStickyMarkdown(raw) {
    if (!raw) return '';
    const blocks = [];
    let text = raw.replace(/```([\s\S]*?)```/g, (_, code) => {
        blocks.push(code.replace(/^\n/, '').replace(/\n$/, ''));
        return `\u0000WSCODE${blocks.length - 1}\u0000`;
    });
    text = escapeHTML(text);

    text = text.replace(/\u0000WSCODE(\d+)\u0000/g, (_, i) => {
        const raw = blocks[Number(i)];
        return `<div class="ws-sticky-codeblock"><code>${escapeHTML(raw)}</code>` +
            `<button class="ws-sticky-code-copy" type="button" data-code="${encodeURIComponent(raw)}" title="복사"><i class="fa-solid fa-copy"></i></button></div>`;
    });

    return text;
}

// 사용 중일 때만 상단 제어 버튼 표시
function showStickyControls() {
    if (!_panel) return;
    _panel.classList.add('ws-sticky-active');
    if (_idleTimer) clearTimeout(_idleTimer);
    // 포커스 유지 중에는 숨기지 않음
    _idleTimer = setTimeout(() => {
        if (_textarea && document.activeElement === _textarea) return;
        _panel?.classList.remove('ws-sticky-active');
    }, 3500);
}

function buildIconBtn(faClass, title) {
    const b = document.createElement('button'); b.className = 'ws-sticky-icon-btn'; b.title = title;
    b.innerHTML = `<i class="${faClass}"></i>`;
    b.addEventListener('pointerdown', e => e.stopPropagation()); // 드래그 시작 안 되게
    return b;
}

function closeStickyPanel(saveScroll = true, skipPersist = false) {
    if (!_panel) return;
    if (saveScroll && _textarea) stickyData.scrollTop = _textarea.scrollTop;
    stickyData.open = false;
    if (!skipPersist) persistStickyUI();
    if (_idleTimer) clearTimeout(_idleTimer);
    _panel.remove();
    _panel = null; _textarea = null;
}

export function resetStickyUI() {
    Object.assign(stickyData, wsSettings.sticky);
    applyStickyColor();
    closeStickyPanel(false, true);
}

function deleteStickyData() {
    if (!window.confirm('메모를 삭제할까요?')) return;
    stickyData.text = '';
    stickyData.scrollTop = 0;
    if (_textarea) _textarea.value = '';
    const prevEl = _panel?.querySelector('.ws-sticky-preview');
    if (prevEl && prevEl.style.display !== 'none') {
        prevEl.innerHTML = renderStickyMarkdown('');
    }
    persistStickyText(true);
    persistStickyUI();
}

function openStickyPanel() {
    if (_panel) { raiseToTop(_panel); return; }
    applyStickyColor();

    const panel = document.createElement('div'); panel.id = 'ws-sticky-panel';
    const hasPos = stickyData.left !== null && stickyData.top !== null;
    const initW = stickyData.width || DEFAULT_W, initH = stickyData.height || DEFAULT_H;
    // 최초 기본 위치: 화면 우상단
    const initLeft = hasPos ? stickyData.left : (window.innerWidth - initW - EDGE_MARGIN);
    const initTop = hasPos ? stickyData.top : INITIAL_TOP_MARGIN;
    const g = clampGeometry(initLeft, initTop, initW, initH);
    panel.style.left = `${g.left}px`; panel.style.top = `${g.top}px`;
    panel.style.width = `${g.width}px`; panel.style.height = `${g.height}px`;

    // ST 드로어 외부 클릭 닫기 방지
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });
    panel.addEventListener('pointerdown', (e) => {
        raiseToTop(panel);
        showStickyControls();
        if (e.target && e.target.tagName === 'TEXTAREA') {
            requestAnimationFrame(() => e.target.focus());
        }
    });

    const dragbar = document.createElement('div'); dragbar.className = 'ws-sticky-dragbar';
    const previewBtn = buildIconBtn('fa-solid fa-code', '코드 보기');
    const saveBtn = buildIconBtn('fa-solid fa-floppy-disk', '저장');
    const trashBtn = buildIconBtn('fa-fw fa-solid fa-trash', '메모 삭제');
    const closeBtn = buildIconBtn('fa-solid fa-xmark', '닫기');
    saveBtn.addEventListener('click', () => {
        stickyData.text = _textarea.value;
        persistStickyText(true);
        toastr.info('저장했습니다.', '', { timeOut: 1500 });
    });
    trashBtn.addEventListener('click', () => deleteStickyData());
    closeBtn.addEventListener('click', () => closeStickyPanel());
    dragbar.appendChild(previewBtn); dragbar.appendChild(saveBtn); dragbar.appendChild(trashBtn); dragbar.appendChild(closeBtn);
    panel.appendChild(dragbar);
    makeDraggable(panel, dragbar);

    const textarea = document.createElement('textarea');
    textarea.value = stickyData.text;
    textarea.placeholder = '메모를 입력하세요';
    textarea.autocomplete = 'off'; textarea.autocorrect = 'off'; textarea.autocapitalize = 'off'; textarea.spellcheck = false;
    textarea.maxLength = 1000000;
    textarea.addEventListener('input', () => { stickyData.text = textarea.value; persistStickyText(); });
    textarea.addEventListener('focus', () => showStickyControls());
    textarea.addEventListener('blur', () => showStickyControls());
    panel.appendChild(textarea);
    requestAnimationFrame(() => { textarea.scrollTop = stickyData.scrollTop || 0; });

    // 미리보기 — 편집(textarea) ↔ 렌더링(div) 전환. 코드블럭 복사 버튼은 이벤트 위임으로 한 번만 등록.
    const preview = document.createElement('div'); preview.className = 'ws-sticky-preview'; preview.style.display = 'none';
    preview.addEventListener('click', e => {
        const btn = e.target.closest('.ws-sticky-code-copy'); if (!btn) return;
        copyCodeToClipboard(decodeURIComponent(btn.dataset.code || ''));
    });
    panel.appendChild(preview);
    let isPreview = false;
    let savedScrollTop = 0;
    previewBtn.addEventListener('click', () => {
        isPreview = !isPreview;
        previewBtn.classList.toggle('ws-sticky-icon-active', isPreview);
        if (isPreview) {
            savedScrollTop = textarea.scrollTop;
            preview.innerHTML = renderStickyMarkdown(textarea.value);
            textarea.style.display = 'none'; preview.style.display = 'block';
            previewBtn.title = '편집으로 돌아가기';
        } else {
            preview.style.display = 'none'; textarea.style.display = '';
            previewBtn.title = '코드 보기';
            requestAnimationFrame(() => { textarea.scrollTop = savedScrollTop; });
        }
    });

    // 상단을 제외한 3면(좌, 우, 하단) 및 하단 모서리 자유 리사이즈 (티나는 핸들 아이콘 없이 자연스럽게)
    let activeResize = null;
    const createResizer = (dir, css, cursor) => {
        const el = document.createElement('div');
        el.className = `ws-sticky-resizer ws-sticky-resizer-${dir}`;
        el.style.cssText = `position:absolute;z-index:10;background:transparent;cursor:${cursor};touch-action:none;${css}`;
        el.addEventListener('pointerdown', e => {
            e.stopPropagation();
            e.preventDefault();
            showStickyControls();
            try { el.setPointerCapture(e.pointerId); } catch { }
            const rect = panel.getBoundingClientRect();
            activeResize = {
                dir,
                sx: e.clientX,
                sy: e.clientY,
                initLeft: rect.left,
                initTop: rect.top,
                initW: panel.offsetWidth,
                initH: panel.offsetHeight,
            };
        });
        el.addEventListener('pointermove', e => {
            if (!activeResize || activeResize.dir !== dir) return;
            const dx = e.clientX - activeResize.sx;
            const dy = e.clientY - activeResize.sy;
            let newW = activeResize.initW;
            let newH = activeResize.initH;
            const effMinW = Math.min(MIN_W, activeResize.initW, Math.max(100, window.innerWidth - EDGE_MARGIN * 2));
            const effMinH = Math.min(MIN_H, activeResize.initH, Math.max(100, window.innerHeight - EDGE_MARGIN * 2));

            if (dir.includes('r')) {
                const maxW = Math.max(effMinW, window.innerWidth - activeResize.initLeft - EDGE_MARGIN);
                newW = Math.min(Math.max(activeResize.initW + dx, effMinW), maxW);
            }
            if (dir.includes('b')) {
                const maxH = Math.max(effMinH, window.innerHeight - activeResize.initTop - EDGE_MARGIN);
                newH = Math.min(Math.max(activeResize.initH + dy, effMinH), maxH);
            }
            if (dir.includes('l')) {
                const maxDelta = Math.max(0, activeResize.initW - effMinW);
                const minDelta = Math.min(0, -(activeResize.initLeft - EDGE_MARGIN));
                const actualDx = Math.min(Math.max(dx, minDelta), maxDelta);
                newW = activeResize.initW - actualDx;
                const newLeft = activeResize.initLeft + actualDx;
                panel.style.left = `${newLeft}px`;
            }

            panel.style.width = `${newW}px`;
            panel.style.height = `${newH}px`;
        });
        const onEnd = () => {
            if (!activeResize || activeResize.dir !== dir) return;
            activeResize = null;
            const rect = panel.getBoundingClientRect();
            stickyData.left = rect.left;
            stickyData.top = rect.top;
            stickyData.width = panel.offsetWidth;
            stickyData.height = panel.offsetHeight;
            persistStickyUI();
        };
        el.addEventListener('pointerup', onEnd);
        el.addEventListener('pointercancel', onEnd);
        panel.appendChild(el);
    };

    createResizer('r', 'right:0;top:28px;bottom:14px;width:4px;', 'ew-resize');
    createResizer('b', 'left:10px;right:10px;bottom:0;height:8px;', 'ns-resize');
    createResizer('l', 'left:0;top:28px;bottom:10px;width:8px;', 'ew-resize');
    createResizer('rb', 'right:0;bottom:0;width:14px;height:14px;', 'nwse-resize');
    createResizer('lb', 'left:0;bottom:0;width:14px;height:14px;', 'nesw-resize');

    document.body.appendChild(panel);
    raiseToTop(panel);
    _panel = panel; _textarea = textarea;

    // 드래그 종료 시 최종 좌표 클램프 및 저장
    dragbar.addEventListener('pointerdown', () => showStickyControls());
    dragbar.addEventListener('pointerup', () => {
        const rect = panel.getBoundingClientRect();
        const g2 = clampGeometry(rect.left, rect.top, rect.width, rect.height);
        panel.style.left = `${g2.left}px`; panel.style.top = `${g2.top}px`;
        stickyData.left = g2.left; stickyData.top = g2.top;
        persistStickyUI();
    });

    stickyData.open = true;
    persistStickyUI();
}

function toggleStickyPanel() {
    if (_panel) closeStickyPanel();
    else openStickyPanel();
}

function registerStickyCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sticky', helpString: 'Toggle sticky note panel.',
        callback: () => { toggleStickyPanel(); return ''; },
    }));
}

export async function initSticky() {
    const text = loadStickyText();
    if (text) stickyData.text = text;
    applyStickyColor();
    registerStickyCommand();
    // 지난 세션에 열려있었으면 그대로 이어서 열어줌
    if (stickyData.open) openStickyPanel();
}
