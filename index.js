// ─────────────────────────────────────────────────────────────────────────
// 참고 및 출처
// - /goto, /message-button 기능 일부는 SillyTavern-LALib(@LenAnderson) 확장 프로그램의
//   /message-move 로직(DOM 클릭 방식)을 참고했습니다. (※ /move는 현재 배열+DOM 직접 패치
//   방식으로 완전히 새로 구현되어 있어 이 DOM 클릭 방식을 더 이상 사용하지 않습니다)
//   https://github.com/LenAnderson/SillyTavern-LALib
// - /find, /change, 빠른수정(드래그 필) 기능에 쓰인 텍스트 선택 하이라이팅은
//   bookmark(@ring***) 확장 프로그램에서 영감을 받았습니다.
//
// Credits
// - Part of the /goto and /message-button logic (DOM-click based) was adapted from the
//   /message-move command of the SillyTavern-LALib extension (@LenAnderson). (Note: /move
//   has since been fully reimplemented using direct array+DOM patching and no longer uses
//   this DOM-click technique.)
//   https://github.com/LenAnderson/SillyTavern-LALib
// - The text-selection highlighting used in /find, /change, and the quick-replace
//   (drag pill) feature was inspired by the bookmark extension (@ring***).
// ─────────────────────────────────────────────────────────────────────────
import { applyWsHlColor, applyWsHlCurColor, initMoveSnapshotClearing } from './state.js';
import { registerBasicCommands, initHideAlarmWatcher } from './commands-basic.js';
import { registerFindChangeCommands } from './find-change.js';
import { initDragFeatures } from './drag-features.js';
import { initTextboxSearch } from './textbox-search.js';
import { initSticky } from './sticky.js';
import { initMessageNote } from './note.js';
import { registerDifferenceCommands } from './difference.js';
import { registerNamingCommands } from './naming.js';
import { initUndoWatcher } from './undo-manager.js';
import { initCharSheetGuard } from './char-sheet-guard.js';

// ─── Panel CSS ────────────────────────────────────────────────────────────
function injectThemeCSS() {
    if (document.getElementById('ws-theme-vars')) return;
    const s = document.createElement('style'); s.id = 'ws-theme-vars';
    s.textContent = `
        :root {
            --ws-panel:#ffffff; --ws-panel2:#f9f9f9; --ws-panel3:#ffffff;
            --ws-text:#4a4a4a; --ws-text2:#999999; --ws-border:#e8e8e8;
            --ws-radius:12px;
            --ws-hl-color: rgba(177,224,179,0.9);
            --ws-hl-cur-bg: rgba(0,0,0,0.75); --ws-hl-cur-color: #ffffff;
            --ws-pin-color: #e65751;
            --ws-delete-overlay: rgba(255,120,120,0.18);
            --ws-dell-overlay: rgba(100,180,255,0.22);
            /* 드래그 필 클릭 지점 대비 오프셋 */
            --ws-pill-offset-x: 20px; --ws-pill-offset-y: 70px;
            /* 스티키 노트 기본 색 폴백 */
            --ws-sticky-color: #FEF2B5;
            --ws-sticky-opacity: 1;
        }
        .ws-btn { padding:5px 12px; border-radius:8px; border:1px solid var(--ws-border);
            background:var(--ws-panel2); color:var(--ws-text); cursor:pointer; font-size:13px;
            font-family:inherit; font-weight:500; transition:all 0.15s;
            box-shadow:0 1px 2px rgba(0,0,0,0.02); white-space:nowrap; flex-shrink:0; }
        .ws-btn:hover  { filter:brightness(0.95); border-color:var(--ws-text2); }
        .ws-btn:active { filter:brightness(0.9); transform:translateY(1px); box-shadow:none; }
        .ws-btn-accent { background:var(--ws-panel); font-weight:600; border:1px solid var(--ws-border); }
        .ws-btn-accent:hover { background:var(--ws-panel2); }
        .ws-input { width:100%; box-sizing:border-box; padding:8px 12px; border-radius:8px;
            border:1px solid var(--ws-border); background:var(--ws-panel); color:var(--ws-text);
            font-size:13px; font-family:inherit; outline:none; transition:border-color 0.15s;
            box-shadow:inset 0 1px 2px rgba(0,0,0,0.01); }
        .ws-input:focus { border-color:var(--ws-text2); }
        .ws-input::placeholder { color:var(--ws-text2); opacity:0.75; }
        .ws-range-input { color:var(--ws-text2); }
        .ws-range-input::placeholder { color:var(--ws-text2); opacity:0.75; }
        .ws-panel-body::-webkit-scrollbar, .ws-thin-scroll::-webkit-scrollbar { width:5px; }
        .ws-panel-body::-webkit-scrollbar-track, .ws-thin-scroll::-webkit-scrollbar-track { background:transparent; }
        .ws-panel-body::-webkit-scrollbar-thumb, .ws-thin-scroll::-webkit-scrollbar-thumb {
            background-color: rgba(120,120,120,0.35);
            border-radius: 999px;
        }
        .ws-panel-body, .ws-thin-scroll { scrollbar-width: thin; scrollbar-color: rgba(120,120,120,0.35) transparent; }
        /* 호버/선택 박스와 스크롤바 간 여백 확보 */
        .ws-thin-scroll { padding-right: 10px; }
        .ws-result-item { padding:6px 10px; border-radius:8px; cursor:pointer; margin-bottom:6px;
            border:1px solid transparent; background:var(--ws-panel); color:var(--ws-text);
            transition:all 0.15s; font-size:12px; line-height:1.4; }
        @media (hover: hover) {
            .ws-result-item:hover { background:var(--ws-panel2); border-color:var(--ws-border); }
        }
        .ws-result-item.active { background:var(--ws-panel2); border-color:var(--ws-border); font-weight:600; }
        .ws-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; color:var(--ws-text); }
        input[type=checkbox].ws-check { width:14px; height:14px; margin:0; flex-shrink:0; }

        /* ── 검색 하이라이트 CSS ─────────────────────────────────────────── */
        #chat.ws-hl-active {
            position: relative !important;
            z-index: 999991 !important;
            background: transparent !important;
        }
        #chat .mes_text mark[data-ws-g] {
            background: var(--ws-hl-color) !important;
            color: inherit !important;
            padding: 1px 1px !important;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }
        #chat .mes_text mark[data-ws-g].ws-hl-cur,
        #chat .mes_text mark[data-ws-qr].ws-hl-cur {
            background: var(--ws-hl-cur-bg) !important;
            color: var(--ws-hl-cur-color) !important;
            font-weight: bold !important;
            padding: 0.5px 1px !important;
        }
        /* 메시지 삭제 선택 오버레이 (기본 소프트 레드 / /dell 블루) */
        #chat .mes.selected,
        #chat .mes.last_mes.selected {
            background-color: var(--ws-delete-overlay) !important;
        }
        body.ws-dell-active #chat .mes.selected,
        body.ws-dell-active #chat .mes.last_mes.selected {
            background-color: var(--ws-dell-overlay) !important;
        }
        body.ws-dell-active.ws-dell-range #chat .mes.selected,
        body.ws-dell-active.ws-dell-range #chat .mes.last_mes.selected {
            background-color: var(--ws-delete-overlay) !important;
        }

        /* 삭제 확인 버튼을 일반 테마 메뉴 버튼 스타일로 통일 */
        #dialogue_del_mes_ok {
            background-color: var(--SmartThemeBlurTintColor) !important;
            color: var(--SmartThemeBodyColor) !important;
            border: 1px solid var(--SmartThemeBorderColor) !important;
        }
        #dialogue_del_mes_ok:hover {
            filter: brightness(1.1);
        }
        /* 연속 탭 시 iOS 더블탭 확대 방지 */
        #chat .mes {
            touch-action: manipulation;
        }

        /* ── 드래그 필 (커스텀 CSS 오버라이드 허용) ────────────────────── */
        .ws-drag-pill {
            position: fixed;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 20px;
            user-select: none;
            color: var(--ws-text);
            font-size: 14px;
            padding: 4px 2px;
            white-space: nowrap;
        }
        .ws-drag-pill-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .ws-drag-pill-icon i {
            font-size: 12px;
        }

        /* ── 삭제모드 보조 버튼 (ST 테마 변수 연동) ─────────────────────── */
        .ws-stitch-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0 12px;
            margin-left: 8px;
            box-sizing: border-box;
            min-width: 2.8em;
            background: transparent;
            border: 1px solid var(--SmartThemeBorderColor, var(--ws-border));
            border-radius: 10px;
            color: var(--SmartThemeBodyColor, var(--ws-text));
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
            vertical-align: middle;
            user-select: none;
        }
        @media (max-width: 480px) {
            .ws-stitch-btn {
                padding: 0 8px;
                min-width: 2.4em;
            }
        }
        #ws-del-batch-btn,
        #ws-del-clear-btn {
            min-width: 4.2em;
            text-align: center;
        }
        @media (max-width: 480px) {
            #ws-del-batch-btn,
            #ws-del-clear-btn {
                min-width: 3.6em;
            }
        }
        .ws-stitch-btn::before {
            content: '';
            position: absolute;
            inset: 3px;
            border: 1px dashed var(--SmartThemeBorderColor, var(--ws-border));
            border-radius: 7px;
            pointer-events: none;
            opacity: 0.6;
        }
        .ws-stitch-btn:active { opacity: 0.7; }
        .ws-stitch-btn.armed {
            background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.08));
            filter: brightness(0.96);
        }

        /* ── 팝업 텍스트박스 찾기/바꾸기 오버레이 ───────────────────────── */
        .ws-textbox-overlay mark {
            background: transparent !important;
            color: transparent !important;
            padding: 0 !important;
            text-decoration-line: underline !important;
            text-decoration-style: solid !important;
            text-decoration-color: var(--ws-pin-color, #e65751) !important;
            text-decoration-thickness: 1px !important;
            text-underline-offset: 2px !important;
            text-decoration-skip-ink: none !important;
            pointer-events: auto !important;
            cursor: pointer !important;
        }
        .ws-textbox-overlay mark.ws-tb-cur {
            background: rgba(230, 87, 81, 0.22) !important;
            border-radius: 2px !important;
            text-decoration-style: solid !important;
            text-decoration-thickness: 1px !important;
            text-decoration-color: #ff3b30 !important;
        }
        /* ── 텍스트박스 플로팅 돋보기 버튼 ──────────────────────────────── */
        .ws-tb-float-trigger {
            position: fixed;
            z-index: 999990;
            display: none;
            align-items: center;
            justify-content: center;
            width: 23px;
            height: 23px;
            box-sizing: border-box;
            padding: 0;
            margin: 0;
            border: 1px solid var(--SmartThemeBorderColor, rgba(140,140,140,0.35));
            border-radius: 6px;
            background: var(--SmartThemeBlurTintColor, rgba(30, 30, 30, 0.85));
            -webkit-backdrop-filter: blur(8px) saturate(1.2);
            backdrop-filter: blur(8px) saturate(1.2);
            color: var(--SmartThemeBodyColor, var(--ws-text, #eee));
            cursor: pointer;
            user-select: none;
            -webkit-user-select: none;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
            opacity: 0;
            transform: scale(0.85);
            transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease;
            box-shadow: 0 1px 5px rgba(0,0,0,0.25);
            pointer-events: auto;
        }
        .ws-tb-float-trigger.ws-tb-float-visible {
            display: flex !important;
            opacity: 1 !important;
            transform: scale(1) !important;
        }
        .ws-tb-float-trigger:hover {
            background: var(--SmartThemeBlurTintColor, rgba(50, 50, 50, 0.95));
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            transform: scale(1.08);
        }
        .ws-tb-float-trigger:active {
            transform: scale(0.92);
            opacity: 0.9;
        }
        .ws-tb-float-trigger i {
            font-size: 10px;
            pointer-events: none;
            color: inherit;
        }
        @supports (-webkit-touch-callout: none) {
            .ws-tb-float-trigger {
                -webkit-backdrop-filter: blur(10px) saturate(1.1);
            }
        }

        /* ── 스티키 노트 (글꼴은 :where()로 커스텀 CSS 오버라이드 허용) ──── */
        :where(#ws-sticky-panel textarea) {
            font-family: inherit;
            font-size: 13px;
            line-height: 1.5;
        }
        #ws-sticky-panel {
            position: fixed;
            background: var(--ws-sticky-color);
            opacity: var(--ws-sticky-opacity, 1);
            border: 1px solid rgba(0,0,0,0.08);
            border-radius: 10px;
            color: #3f3f3f;
            overflow: hidden;
        }
        #ws-sticky-panel .ws-sticky-dragbar {
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 2px;
            padding: 0 5px;
            cursor: grab;
            touch-action: none;
            box-sizing: border-box;
            z-index: 1;
        }
        #ws-sticky-panel .ws-sticky-icon-btn,
        #ws-sticky-panel .ws-sticky-icon-btn i {
            color: rgba(63,63,63,0.35) !important;
        }
        #ws-sticky-panel .ws-sticky-icon-btn {
            background: transparent;
            border: none;
            font-size: 12px;
            cursor: pointer;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            padding: 0;
            flex-shrink: 0;
            /* 평소엔 숨겨두고, 패널을 사용 중일 때(.ws-sticky-active)만 부드럽게 드러남 */
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease;
        }
        #ws-sticky-panel.ws-sticky-active .ws-sticky-icon-btn {
            opacity: 1;
            pointer-events: auto;
        }
        #ws-sticky-panel .ws-sticky-icon-btn:hover,
        #ws-sticky-panel .ws-sticky-icon-btn:hover i {
            background: rgba(0,0,0,0.07);
            color: rgba(63,63,63,0.9) !important;
        }
        #ws-sticky-panel .ws-sticky-icon-btn.ws-sticky-icon-active,
        #ws-sticky-panel .ws-sticky-icon-btn.ws-sticky-icon-active i {
            background: rgba(0,0,0,0.12);
            color: rgba(63,63,63,0.95) !important;
        }
        #ws-sticky-panel textarea {
            position: absolute;
            inset: 0;
            resize: none;
            border: none !important;
            outline: none;
            background: transparent !important;
            color: inherit;
            padding: 32px 14px 14px;
            box-sizing: border-box;
            width: 100%;
            height: 100%;
        }
        #ws-sticky-panel .ws-sticky-preview {
            position: absolute;
            inset: 0;
            padding: 32px 14px 14px;
            box-sizing: border-box;
            width: 100%;
            height: 100%;
            overflow-y: auto;
            color: inherit;
            font: inherit;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }
        #ws-sticky-panel .ws-sticky-preview .ws-sticky-codeblock {
            position: relative;
            background: rgba(0,0,0,0.06);
            border: 1px solid rgba(0,0,0,0.09);
            border-radius: 8px;
            margin: 0.6em 0;
            padding: 10px 36px 10px 12px;
            overflow-x: auto;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            box-shadow: inset 0 1px 3px rgba(0,0,0,0.02);
        }
        #ws-sticky-panel .ws-sticky-preview .ws-sticky-codeblock code {
            background: transparent; padding: 0; white-space: pre; font-size: 0.88em; font-family: inherit;
        }
        #ws-sticky-panel .ws-sticky-preview .ws-sticky-code-copy {
            position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.08); border: none;
            border-radius: 6px; width: 24px; height: 24px; cursor: pointer; color: inherit;
            display: flex; align-items: center; justify-content: center; font-size: 11px; padding: 0;
            transition: all 0.15s;
        }
        #ws-sticky-panel .ws-sticky-preview .ws-sticky-code-copy:hover {
            background: rgba(0,0,0,0.18);
            transform: scale(1.05);
        }

        /* 메시지 인덱스 스티커 (.mes_text 상단 우측 정렬) */
        .ws-note-sticker {
            display: flex; align-items: flex-start;
            max-width: min(420px, 92%); width: fit-content;
            margin: 0 0 4px auto; padding: 5px 10px;
            background: var(--ws-index-bg, rgba(255,51,153,0.9));
            color: var(--ws-index-font, var(--ws-text)); font-size: 13px; line-height: 1.35;
            border-radius: 6px; cursor: pointer; user-select: none;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .ws-note-sticker span {
            display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
            overflow: hidden; text-overflow: ellipsis; word-break: break-word;
            white-space: pre-wrap;
        }
        .ws-note-sticker:hover { filter: brightness(0.96); }
        /* 메시지 버튼 모음 내 인덱스 버튼 */
        .ws-index-btn { cursor: pointer; }

        /* ── /difference 비교 패널 스타일 ─────────────────────────────────── */
        .ws-panel input,
        .ws-panel textarea,
        .ws-diff-textarea {
            -webkit-user-select: text !important;
            user-select: text !important;
        }
        .ws-diff-textarea {
            flex: 1;
            width: 100%;
            height: 100%;
            min-height: 0;
            box-sizing: border-box;
            resize: none;
            border: 1px solid var(--ws-border, #e8e8e8);
            border-radius: 6px;
            background: var(--ws-panel2, #f9f9f9);
            color: var(--ws-text);
            padding: 10px 12px;
            font-family: inherit;
            font-size: 13px;
            line-height: 1.5;
            outline: none;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .ws-diff-textarea:focus {
            border-color: #bbbbbb;
            background: var(--ws-panel3, #ffffff);
        }
        .ws-diff-locked-card {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            width: 100%;
            height: 100%;
            box-sizing: border-box;
            border: 1px solid var(--ws-border, #e8e8e8);
            border-radius: 6px;
            background: var(--ws-panel2, #f9f9f9);
            overflow: hidden;
        }
        .ws-diff-locked-header {
            padding: 6px 10px;
            font-size: 11.5px;
            font-weight: 600;
            color: var(--ws-text2);
            background: rgba(0,0,0,0.03);
            border-bottom: 1px solid var(--ws-border, #e8e8e8);
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .ws-diff-locked-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 10px 12px;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
            color: var(--ws-text);
            -webkit-user-select: text !important;
            user-select: text !important;
        }
        mark.ws-diff-del {
            background: rgba(248, 113, 113, 0.36);
            color: inherit;
            border-radius: 3px;
            padding: 0 2px;
            box-shadow: inset 0 -1px 0 rgba(220, 38, 38, 0.32);
        }
        mark.ws-diff-add {
            background: rgba(74, 222, 128, 0.36);
            color: inherit;
            border-radius: 3px;
            padding: 0 2px;
            box-shadow: inset 0 -1px 0 rgba(22, 163, 74, 0.32);
        }
        .ws-diff-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 2px 8px;
            font-size: 11.5px;
            flex-shrink: 0;
            user-select: none;
            gap: 8px;
            flex-wrap: wrap;
        }
        .ws-diff-stats {
            color: var(--ws-text2);
            font-size: 11.5px;
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
        }
        .ws-diff-pill-del {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 7px;
            border-radius: 999px;
            font-weight: 600;
            font-size: 11px;
            background: rgba(239, 68, 68, 0.12);
            color: #c62828;
            border: 1px solid rgba(239, 68, 68, 0.28);
        }
        .ws-diff-pill-add {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 7px;
            border-radius: 999px;
            font-weight: 600;
            font-size: 11px;
            background: rgba(34, 197, 94, 0.13);
            color: #15803d;
            border: 1px solid rgba(34, 197, 94, 0.30);
        }
        .ws-diff-controls {
            display: flex;
            align-items: center;
            gap: 5px;
            flex-wrap: wrap;
            margin-left: auto;
        }
        .ws-diff-seg {
            display: inline-flex;
            align-items: stretch;
            height: 24px;
            box-sizing: border-box;
            border: 1px solid var(--ws-border);
            border-radius: 6px;
            overflow: hidden;
            background: var(--ws-panel2);
        }
        .ws-diff-seg button {
            border: none;
            background: transparent;
            color: var(--ws-text2);
            font-size: 11px;
            font-family: inherit;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            min-height: 0;
            margin: 0;
            padding: 0 9px;
            line-height: 1;
            box-sizing: border-box;
            white-space: nowrap;
            cursor: pointer;
            transition: background 0.12s, color 0.12s;
        }
        .ws-diff-seg button.active {
            background: var(--ws-panel);
            color: var(--ws-text);
            font-weight: 600;
            box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06);
        }
        .ws-btn.ws-diff-ctrl-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 24px;
            min-height: 0;
            margin: 0;
            padding: 0 8px;
            font-size: 11px;
            line-height: 1;
            border-radius: 6px;
            box-sizing: border-box;
            white-space: nowrap;
        }
        .ws-diff-cell.is-inline-editable,
        .ws-diff-unified-row.is-inline-editable {
            cursor: pointer;
            touch-action: manipulation;
        }
        .ws-diff-cell.is-inline-editing,
        .ws-diff-unified-row.is-inline-editing {
            cursor: default;
        }
        .ws-diff-inline-wrap {
            display: flex;
            flex-direction: column;
            gap: 5px;
            width: 100%;
            box-sizing: border-box;
            padding: 2px 0;
        }
        .ws-diff-inline-ta {
            width: 100%;
            min-height: 54px;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 1px solid #6366f1;
            border-radius: 6px;
            background: var(--ws-panel);
            color: var(--ws-text);
            font-family: inherit;
            font-size: 12px;
            line-height: 1.5;
            resize: vertical;
            outline: none;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .ws-diff-inline-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            flex-wrap: wrap;
        }
        .ws-diff-inline-hint {
            font-size: 10.5px;
            color: var(--ws-text2);
        }
        .ws-diff-inline-actions {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            margin-left: auto;
        }
        .ws-diff-inline-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 22px;
            min-height: 0;
            margin: 0;
            padding: 0 8px;
            box-sizing: border-box;
            border-radius: 5px;
            border: 1px solid var(--ws-border);
            background: var(--ws-panel2);
            color: var(--ws-text);
            font-family: inherit;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
        }
        .ws-diff-inline-btn.primary {
            background: #6366f1;
            border-color: #6366f1;
            color: #fff;
        }
        .ws-diff-table {
            flex: 1;
            overflow-y: auto;
            background: var(--ws-panel);
            display: flex;
            flex-direction: column;
            padding: 6px;
            gap: 4px;
        }
        .ws-diff-row {
            display: flex;
            gap: 6px;
            align-items: stretch;
            min-width: 0;
            flex-shrink: 0;
        }
        .ws-diff-cell {
            flex: 1;
            min-width: 0;
            box-sizing: border-box;
            display: flex;
            align-items: stretch;
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid rgba(0, 0, 0, 0.06);
            background: var(--ws-panel);
        }
        .ws-diff-cell.is-del {
            background: #fff1f2;
            border-color: rgba(239, 68, 68, 0.28);
        }
        .ws-diff-cell.is-add {
            background: #f0fdf4;
            border-color: rgba(34, 197, 94, 0.30);
        }
        .ws-diff-cell.is-eq {
            background: rgba(0, 0, 0, 0.014);
            border-color: rgba(0, 0, 0, 0.05);
        }
        .ws-diff-gutter {
            display: flex;
            align-items: flex-start;
            justify-content: flex-end;
            gap: 4px;
            flex-shrink: 0;
            padding: 6px 6px 6px 5px;
            font-size: 11px;
            line-height: 1.55;
            font-variant-numeric: tabular-nums;
            color: var(--ws-text2);
            background: rgba(0, 0, 0, 0.025);
            border-right: 1px solid rgba(0, 0, 0, 0.06);
            user-select: none;
        }
        .ws-diff-cell.is-del .ws-diff-gutter {
            background: rgba(239, 68, 68, 0.13);
            border-right-color: rgba(239, 68, 68, 0.22);
            color: #b91c1c;
        }
        .ws-diff-cell.is-add .ws-diff-gutter {
            background: rgba(34, 197, 94, 0.14);
            border-right-color: rgba(34, 197, 94, 0.24);
            color: #15803d;
        }
        .ws-diff-ln {
            min-width: 22px;
            text-align: right;
            opacity: 0.78;
        }
        .ws-diff-sign {
            width: 10px;
            text-align: center;
            font-weight: 700;
        }
        .ws-diff-code {
            flex: 1;
            min-width: 0;
            padding: 6px 9px;
            font-size: 13px;
            line-height: 1.55;
            white-space: pre-wrap;
            word-break: break-word;
            color: var(--ws-text);
            -webkit-user-select: text;
            user-select: text;
        }
        .ws-diff-cell-spacer {
            background: repeating-linear-gradient(
                -45deg,
                rgba(128, 128, 128, 0.035),
                rgba(128, 128, 128, 0.035) 6px,
                rgba(128, 128, 128, 0.085) 6px,
                rgba(128, 128, 128, 0.085) 12px
            );
            border: 1px dashed rgba(140, 140, 140, 0.25);
        }
        .ws-diff-unified-row {
            display: flex;
            align-items: stretch;
            min-width: 0;
            flex-shrink: 0;
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid rgba(0, 0, 0, 0.06);
            background: rgba(0, 0, 0, 0.012);
        }
        .ws-diff-unified-row.is-del {
            background: #fff1f2;
            border-color: rgba(239, 68, 68, 0.28);
        }
        .ws-diff-unified-row.is-add {
            background: #f0fdf4;
            border-color: rgba(34, 197, 94, 0.30);
        }
        .ws-diff-unified-row .ws-diff-gutter {
            gap: 5px;
            padding: 6px 7px;
        }
        .ws-diff-unified-row.is-del .ws-diff-gutter {
            background: rgba(239, 68, 68, 0.13);
            border-right-color: rgba(239, 68, 68, 0.22);
            color: #b91c1c;
        }
        .ws-diff-unified-row.is-add .ws-diff-gutter {
            background: rgba(34, 197, 94, 0.14);
            border-right-color: rgba(34, 197, 94, 0.24);
            color: #15803d;
        }
        .ws-diff-fold-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 6px;
            border: 1px dashed var(--ws-border);
            background: var(--ws-panel2);
            color: var(--ws-text2);
            font-size: 11px;
            cursor: pointer;
            flex-shrink: 0;
            transition: background 0.12s, color 0.12s;
        }
        .ws-diff-fold-bar:hover {
            background: var(--ws-panel3);
            color: var(--ws-text);
        }
        .ws-diff-row-flash {
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.45);
            border-radius: 7px;
        }
        .ws-diff-step-pill {
            display: inline-flex;
            align-items: center;
            padding: 1px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 600;
            background: rgba(245, 158, 11, 0.13);
            color: #b45309;
            border: 1px solid rgba(245, 158, 11, 0.32);
            white-space: nowrap;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .ws-diff-review-footer {
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 8px 12px;
            flex-wrap: wrap;
            padding: 10px 2px 0;
            flex-shrink: 0;
            user-select: none;
        }
        .ws-diff-review-hint {
            font-size: 11.5px;
            color: var(--ws-text2);
            display: inline-flex;
            align-items: center;
            gap: 5px;
            min-width: 0;
        }
        .ws-diff-review-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
            flex-wrap: wrap;
        }
        .ws-diff-review-skip,
        .ws-diff-review-apply {
            padding: 5px 12px;
            font-size: 12px;
            height: 29px;
            border-radius: 7px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
        }
        .ws-diff-review-apply {
            background: rgba(22, 163, 74, 0.13);
            border-color: rgba(22, 163, 74, 0.38);
            color: #15803d;
            font-weight: 600;
        }
        .ws-diff-review-apply:hover {
            filter: none;
            background: rgba(22, 163, 74, 0.21);
            border-color: rgba(22, 163, 74, 0.56);
        }
        .ws-diff-review-apply:disabled,
        .ws-diff-review-skip:disabled {
            opacity: 0.55;
            cursor: default;
        }
        /* ── /naming 랜덤 이름 생성기 CSS ─────────────────────────────────── */
        .ws-naming-tabs {
            display: flex;
            gap: 6px;
            margin-bottom: 8px;
        }
        .ws-naming-tabs > button {
            flex: 1;
            padding: 6px 10px;
            font-size: 12.5px;
            font-weight: 600;
        }
        .ws-naming-subtabs {
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 5px;
            margin-bottom: 12px;
        }
        .ws-naming-subtabs > button {
            padding: 4px 10px;
            font-size: 11.5px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            white-space: nowrap;
        }
        .ws-naming-subtabs.is-kr {
            flex-wrap: nowrap;
            gap: 4px;
        }
        .ws-naming-subtabs.is-kr > button {
            flex: 1 1 auto;
            min-width: 0;
            padding: 4px 5px;
            font-size: 11px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            white-space: nowrap;
        }
        .ws-naming-sex-f {
            color: #c9627e;
            font-size: 10.5px;
        }
        .ws-naming-sex-m {
            color: #4f79b8;
            font-size: 10.5px;
        }
        .ws-naming-card {
            background: var(--ws-panel2);
            border: 1px solid var(--ws-border);
            border-radius: 10px;
            padding: 18px 14px 14px;
            cursor: pointer;
            transition: border-color 0.14s, background 0.14s;
            user-select: text;
            -webkit-user-select: text;
        }
        .ws-naming-card:hover {
            border-color: #d0d0d0;
            background: var(--ws-panel3);
        }
        .ws-naming-result {
            font-size: 22px;
            font-weight: 700;
            color: var(--ws-text);
            letter-spacing: -0.3px;
            min-height: 30px;
            line-height: 1.3;
        }
        .ws-naming-result.is-popping {
            animation: wsNamingPop 0.14s ease-out;
        }
        @keyframes wsNamingPop {
            0% { transform: scale(0.92); opacity: 0.65; }
            60% { transform: scale(1.05); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
        }
        .ws-naming-hint {
            margin-top: 6px;
            font-size: 11px;
            color: var(--ws-text2);
            transition: color 0.14s;
        }
        .ws-naming-hint.is-copied {
            color: #15803d;
            font-weight: 600;
        }
        .ws-naming-gen-btn {
            flex: 1;
            padding: 8px 14px;
            font-size: 13.5px;
            font-weight: 700;
        }
        .ws-naming-history {
            margin-top: 12px;
            text-align: left;
        }
        .ws-naming-hist-label {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 11px;
            color: var(--ws-text2);
            margin-bottom: 5px;
        }
        .ws-naming-hist-clear {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 6px;
            border: 1px solid transparent;
            border-radius: 5px;
            background: transparent;
            color: var(--ws-text2);
            font-size: 10.5px;
            font-family: inherit;
            line-height: 1.4;
            cursor: pointer;
            transition: background 0.12s, border-color 0.12s, color 0.12s;
        }
        .ws-naming-hist-clear:hover {
            background: var(--ws-panel2);
            border-color: var(--ws-border);
            color: var(--ws-text);
        }
        .ws-naming-chips {
            display: flex;
            flex-wrap: wrap;
            align-content: flex-start;
            gap: 5px;
        }
        .ws-naming-chip {
            padding: 3px 8px;
            font-size: 11.5px;
            line-height: 1.3;
            border-radius: 999px;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .ws-naming-nick-wrap {
            text-align: left;
        }
        .ws-naming-nick-search {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ws-naming-nick-input {
            flex: 1;
            min-width: 0;
            padding: 7px 10px;
            font-size: 13px;
        }
        .ws-naming-nick-clear {
            padding: 6px 9px;
            font-size: 11.5px;
            line-height: 1.2;
            color: var(--ws-text2);
        }
        .ws-naming-nick-results {
            margin-top: 10px;
            max-height: 230px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .ws-naming-nick-group-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--ws-text2);
            margin-bottom: 5px;
        }
        .ws-naming-nick-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .ws-naming-nick-empty {
            padding: 16px 12px;
            text-align: center;
            font-size: 12px;
            color: var(--ws-text2);
            background: var(--ws-panel2);
            border: 1px dashed var(--ws-border);
            border-radius: 10px;
            line-height: 1.5;
        }
        .ws-slashie-desc::-webkit-scrollbar { display: none; }
    `;
    document.head.appendChild(s);
}

(() => {
    injectThemeCSS();
    applyWsHlColor();
    applyWsHlCurColor();
    initMoveSnapshotClearing();

    registerBasicCommands();
    registerFindChangeCommands();
    initDragFeatures();
    initTextboxSearch();
    initSticky();
    initMessageNote();
    initHideAlarmWatcher();
    registerDifferenceCommands();
    registerNamingCommands();
    initUndoWatcher();
    initCharSheetGuard();
})();
