// ─── difference.js ────────────────────────────────────────────────────────────
// /difference
// Diffchecker 스타일의 두 텍스트 유사도 및 차이점 비교 패널.
// - 텍스트 A(원본, 빨간색 제거) / 텍스트 B(수정, 초록색 추가) 독립 확인([확인] 버튼으로 홀드)
// - Split(나란히) / Unified(통합) 뷰 전환, 줄번호 거터 및 -/+ 마커, 동일 구간 접기, 다음 차이 이동
// - 문단 단위 Needleman-Wunsch 정렬로 구조가 달라도 비슷한 문단의 수평 위치 유지

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { createPanel, getPanelBody, closePanel, getViewportBounds } from './panel-ui.js';
import { raiseToTop, getChat, editMessage } from './state.js';
import { escapeHTML } from './utils.js';

const PANEL_ID = 'ws-diff-panel';
const MIN_PANEL_W = 460;
const MIN_PANEL_H = 340;
const EDGE_MARGIN = 12;

// 패널 내부 상태
let _diffState = {
    textA: '',
    textB: '',
    lockedA: false,
    lockedB: false,
    targetA: null,
    targetB: null,
    chatId: null,
    viewMode: 'split', // 'split' | 'unified'
    foldEqual: false,
};

// 순차 검토 큐 상태 (/fempov 등 외부 호출 전용)
let _reviewSession = null;
let _savedManualDiffState = null;

function clearLastReviewToast(session) {
    if (session?.lastToast && typeof toastr?.clear === 'function') {
        try { toastr.clear(session.lastToast); } catch { }
        session.lastToast = null;
    }
}

function endReviewSession() {
    clearLastReviewToast(_reviewSession);
    _reviewSession = null;
    if (_savedManualDiffState) {
        Object.assign(_diffState, _savedManualDiffState);
        _savedManualDiffState = null;
    }
}

// ─── 텍스트 토큰화 및 유사도 계산 ──────────────────────────────────────────
function tokenizeWords(str) {
    if (!str) return [];
    return str.toLowerCase().match(/[\w\uAC00-\uD7A3]+/g) || [];
}

function tokenizeFull(str) {
    if (!str) return [];
    return str.match(/[\s]+|[\w\uAC00-\uD7A3]+|[^\s\w\uAC00-\uD7A3]+/g) || [str];
}

function prepareLineData(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return { trimmed, wordCounts: new Map(), totalWords: 0 };
    const words = tokenizeWords(trimmed);
    const wordCounts = new Map();
    for (const w of words) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    return { trimmed, wordCounts, totalWords: words.length };
}

// 두 문단 간의 유사도 (0.0 ~ 1.0)
function calcLineSimilarity(da, db) {
    if (!da.trimmed && !db.trimmed) return 1.0;
    if (!da.trimmed || !db.trimmed) return 0.0;
    if (da.trimmed === db.trimmed) return 1.0;

    if (da.totalWords === 0 || db.totalWords === 0) {
        return 0.0;
    }

    let overlap = 0;
    for (const [word, countA] of da.wordCounts) {
        const countB = db.wordCounts.get(word);
        if (countB) overlap += Math.min(countA, countB);
    }
    return (2.0 * overlap) / (da.totalWords + db.totalWords);
}

// ─── 문단 단위 정렬 알고리즘 (Needleman-Wunsch 글로벌 시퀀스 정렬) ───────────
// 비포/애프터가 크게 다른 텍스트도 비슷한 문단을 찾아 수평 위치를 맞춰주고,
// 한쪽에만 있는 문단은 스페이서를 삽입해 다음 문장의 수평 라인을 일치시킴.
function alignParagraphs(linesA, linesB) {
    const n = linesA.length;
    const m = linesB.length;

    if (n === 0 && m === 0) return [];
    if (n === 0) return linesB.map((b, idx) => ({ type: 'right-only', a: null, b, sim: 0, lineA: null, lineB: idx + 1 }));
    if (m === 0) return linesA.map((a, idx) => ({ type: 'left-only', a, b: null, sim: 0, lineA: idx + 1, lineB: null }));

    const dataA = linesA.map(l => prepareLineData(l));
    const dataB = linesB.map(l => prepareLineData(l));

    const GAP_PENALTY = -0.38;
    const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));

    for (let i = 1; i <= n; i++) dp[i][0] = i * GAP_PENALTY;
    for (let j = 1; j <= m; j++) dp[0][j] = j * GAP_PENALTY;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const sim = calcLineSimilarity(dataA[i - 1], dataB[j - 1]);
            // sim이 0.28 이상이면 매칭으로 판단해 가산점, 미만이면 페널티 부여
            const matchScore = sim >= 0.28 ? (sim * 2.2 - 0.2) : -1.2;

            const scoreDiag = dp[i - 1][j - 1] + matchScore;
            const scoreUp = dp[i - 1][j] + GAP_PENALTY;
            const scoreLeft = dp[i][j - 1] + GAP_PENALTY;

            dp[i][j] = Math.max(scoreDiag, scoreUp, scoreLeft);
        }
    }

    // 역추적으로 최적 정렬 경로 생성
    let i = n, j = m;
    const aligned = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const sim = calcLineSimilarity(dataA[i - 1], dataB[j - 1]);
            const matchScore = sim >= 0.28 ? (sim * 2.2 - 0.2) : -1.2;
            const scoreDiag = dp[i - 1][j - 1] + matchScore;
            const scoreUp = dp[i - 1][j] + GAP_PENALTY;
            const scoreLeft = dp[i][j - 1] + GAP_PENALTY;
            const max = dp[i][j];

            if (Math.abs(max - scoreDiag) < 0.001 && sim >= 0.28) {
                aligned.unshift({ type: 'pair', a: linesA[i - 1], b: linesB[j - 1], sim, lineA: i, lineB: j });
                i--; j--;
                continue;
            }
            if (Math.abs(max - scoreUp) < 0.001) {
                aligned.unshift({ type: 'left-only', a: linesA[i - 1], b: null, sim: 0, lineA: i, lineB: null });
                i--;
                continue;
            }
            if (Math.abs(max - scoreLeft) < 0.001) {
                aligned.unshift({ type: 'right-only', a: null, b: linesB[j - 1], sim: 0, lineA: null, lineB: j });
                j--;
                continue;
            }
            aligned.unshift({ type: 'pair', a: linesA[i - 1], b: linesB[j - 1], sim, lineA: i, lineB: j });
            i--; j--;
        } else if (i > 0) {
            aligned.unshift({ type: 'left-only', a: linesA[i - 1], b: null, sim: 0, lineA: i, lineB: null });
            i--;
        } else {
            aligned.unshift({ type: 'right-only', a: null, b: linesB[j - 1], sim: 0, lineA: null, lineB: j });
            j--;
        }
    }

    return aligned;
}

// ─── 매칭된 한 줄 안의 단어/토큰 LCS Diff ─────────────────────────────────
function diffTokenPair(tokensA, tokensB) {
    const n = tokensA.length, m = tokensB.length;
    if (n === 0 && m === 0) return { diffA: [], diffB: [] };
    if (n === 0) return { diffA: [], diffB: tokensB.map(t => ({ token: t, same: false })) };
    if (m === 0) return { diffA: tokensA.map(t => ({ token: t, same: false })), diffB: [] };

    // 단일 라인이 지나치게 긴 경우의 폴백
    if (n * m > 60000) {
        const setB = new Set(tokensB.map(t => t.trim()).filter(Boolean));
        const setA = new Set(tokensA.map(t => t.trim()).filter(Boolean));
        return {
            diffA: tokensA.map(t => ({ token: t, same: t.trim().length === 0 || setB.has(t.trim()) })),
            diffB: tokensB.map(t => ({ token: t, same: t.trim().length === 0 || setA.has(t.trim()) }))
        };
    }

    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
            if (tokensA[i] === tokensB[j]) {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = Math.max(dp[i][j + 1], dp[i + 1][j]);
            }
        }
    }

    const matchA = new Uint8Array(n);
    const matchB = new Uint8Array(m);
    let i = n, j = m;
    while (i > 0 && j > 0) {
        if (tokensA[i - 1] === tokensB[j - 1]) {
            matchA[i - 1] = 1;
            matchB[j - 1] = 1;
            i--; j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    const diffA = tokensA.map((t, idx) => ({ token: t, same: !!matchA[idx] }));
    const diffB = tokensB.map((t, idx) => ({ token: t, same: !!matchB[idx] }));
    return { diffA, diffB };
}

// 토큰 Diff 렌더링 (type: 'left'=노란색, 'right'=핑크색)
function renderDiffTokensHtml(diffList, side) {
    const markClass = side === 'left' ? 'ws-diff-del' : 'ws-diff-add';
    return diffList.map(item => {
        const escaped = escapeHTML(item.token);
        if (item.same || item.token.trim().length === 0) {
            return escaped;
        }
        return `<mark class="${markClass}">${escaped}</mark>`;
    }).join('');
}

// 전체 텍스트 유사도 퍼센티지 계산
function computeOverallSimilarity(linesA, linesB) {
    const textA = linesA.join('\n').trim();
    const textB = linesB.join('\n').trim();
    if (!textA && !textB) return 100;
    if (!textA || !textB) return 0;
    if (textA === textB) return 100;

    const wordsA = tokenizeWords(textA);
    const wordsB = tokenizeWords(textB);
    if (wordsA.length === 0 || wordsB.length === 0) {
        return 0;
    }

    const countsA = new Map();
    for (const w of wordsA) countsA.set(w, (countsA.get(w) || 0) + 1);

    let overlap = 0;
    for (const w of wordsB) {
        const c = countsA.get(w);
        if (c && c > 0) {
            overlap++;
            countsA.set(w, c - 1);
        }
    }
    return Math.round((2.0 * overlap / (wordsA.length + wordsB.length)) * 100);
}

// ─── 패널 3면 자유 리사이즈 핸들러 부착 ──────────────────────────────────────
function attachPanelResizers(panel) {
    let activeResize = null;
    const createResizer = (dir, css, cursor) => {
        const el = document.createElement('div');
        el.className = `ws-diff-resizer ws-diff-resizer-${dir}`;
        el.style.cssText = `position:absolute;z-index:20;background:transparent;cursor:${cursor};touch-action:none;${css}`;

        el.addEventListener('pointerdown', e => {
            e.stopPropagation();
            e.preventDefault();
            try { el.setPointerCapture(e.pointerId); } catch { }
            panel._wsUserDragged = true;
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
            const vp = getViewportBounds();
            const vpRight = vp.left + vp.width;
            const vpBottom = vp.top + vp.height;

            let newW = activeResize.initW;
            let newH = activeResize.initH;
            const effMinW = Math.min(MIN_PANEL_W, activeResize.initW, Math.max(120, vp.width - EDGE_MARGIN * 2));
            const effMinH = Math.min(MIN_PANEL_H, activeResize.initH, Math.max(120, vp.height - EDGE_MARGIN * 2));

            if (dir.includes('r')) {
                const maxW = Math.max(effMinW, vpRight - activeResize.initLeft - EDGE_MARGIN);
                newW = Math.min(Math.max(activeResize.initW + dx, effMinW), maxW);
            }
            if (dir.includes('b')) {
                const maxH = Math.max(effMinH, vpBottom - activeResize.initTop - EDGE_MARGIN);
                newH = Math.min(Math.max(activeResize.initH + dy, effMinH), maxH);
            }
            if (dir.includes('l')) {
                const maxDelta = Math.max(0, activeResize.initW - effMinW);
                const minDelta = Math.min(0, -(activeResize.initLeft - (vp.left + EDGE_MARGIN)));
                const actualDx = Math.min(Math.max(dx, minDelta), maxDelta);
                newW = activeResize.initW - actualDx;
                panel.style.left = `${activeResize.initLeft + actualDx}px`;
            }

            panel.style.width = `${newW}px`;
            panel.style.height = `${newH}px`;
        });

        const onEnd = () => {
            if (!activeResize || activeResize.dir !== dir) return;
            activeResize = null;
        };
        el.addEventListener('pointerup', onEnd);
        el.addEventListener('pointercancel', onEnd);
        panel.appendChild(el);
    };

    createResizer('r', 'right:0;top:38px;bottom:10px;width:8px;', 'ew-resize');
    createResizer('b', 'left:10px;right:10px;bottom:0;height:8px;', 'ns-resize');
    createResizer('l', 'left:0;top:38px;bottom:10px;width:8px;', 'ew-resize');
    createResizer('rb', 'right:0;bottom:0;width:14px;height:14px;', 'nwse-resize');
    createResizer('lb', 'left:0;bottom:0;width:14px;height:14px;', 'nesw-resize');
}

// ─── Difference 패널 열기 ───────────────────────────────────────────────────
function openDifferencePanel(initTextA = null, initTextB = null, lockA = false, lockB = false, targetA = null, targetB = null) {
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) {
        closePanel(PANEL_ID);
        if (initTextA === null && initTextB === null) {
            return;
        }
    } else if (_reviewSession) {
        endReviewSession();
    }

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const curChatId = ctx?.chatId || ctx?.characterId || null;
    if (_diffState.chatId && curChatId && _diffState.chatId !== curChatId) {
        _diffState.targetA = null;
        _diffState.targetB = null;
    }
    if (curChatId) _diffState.chatId = curChatId;
    if (initTextA !== null) {
        _diffState.textA = initTextA;
        _diffState.lockedA = lockA;
        _diffState.targetA = targetA;
    }
    if (initTextB !== null) {
        _diffState.textB = initTextB;
        _diffState.lockedB = lockB;
        _diffState.targetB = targetB;
    }

    showDifferencePanelUI();
}

export function openDifferenceReviewQueue(items, options = {}) {
    const validItems = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!validItems.length) return;

    // 기존 패널이 검토 모드였다면 닫히면서 수동 작업 상태를 먼저 복구한 뒤 새 세션을 시작
    closePanel(PANEL_ID);
    if (_reviewSession) endReviewSession();

    _savedManualDiffState = {
        textA: _diffState.textA,
        textB: _diffState.textB,
        lockedA: _diffState.lockedA,
        lockedB: _diffState.lockedB,
        targetA: _diffState.targetA,
        targetB: _diffState.targetB,
    };

    _reviewSession = {
        items: validItems,
        index: 0,
        appliedCount: 0,
        titlePrefix: options.titlePrefix || '결과 검토',
        busy: false,
        lastToast: null,
    };

    const first = validItems[0];
    _diffState.textA = first.before ?? '';
    _diffState.textB = first.after ?? '';
    _diffState.lockedA = true;
    _diffState.lockedB = true;
    _diffState.targetA = null;
    _diffState.targetB = null;

    showDifferencePanelUI();
}

function showDifferencePanelUI() {
    const panel = createPanel(PANEL_ID);
    if (_reviewSession) {
        const sessionRef = _reviewSession;
        const prevRemove = panel.remove?.bind(panel);
        if (prevRemove) {
            panel.remove = () => {
                if (_reviewSession === sessionRef) endReviewSession();
                prevRemove();
            };
        }
    }
    panel.style.width = 'min(920px, 95vw)';
    panel.style.height = (typeof CSS !== 'undefined' && CSS.supports?.('height', '1dvh'))
        ? 'min(680px, 88dvh)'
        : 'min(680px, 88vh)';

    const body = getPanelBody(panel);
    body.style.cssText = 'padding:6px 14px 12px;display:flex;flex-direction:column;flex:1;overflow:hidden;box-sizing:border-box;min-height:0;';

    let titleDiv = null;
    let swapBtn = null;
    let resetBtn = null;

    // 상단 드래그 헤더 커스텀 (아이콘 + 타이틀 + 액션 버튼)
    const handle = panel.querySelector('div:first-child');
    if (handle) {
        handle.innerHTML = '';
        handle.style.cssText = 'padding:7px 10px 7px 14px;background:var(--ws-panel3);cursor:grab;display:flex;align-items:center;justify-content:space-between;gap:8px;touch-action:none;user-select:none;border-bottom:1px solid var(--ws-border);';

        titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;color:var(--ws-text);min-width:0;flex-wrap:wrap;';

        const headBtns = document.createElement('div');
        headBtns.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;';

        swapBtn = document.createElement('button');
        swapBtn.className = 'ws-btn';
        swapBtn.style.cssText = 'padding:3px 7px;font-size:11.5px;height:24px;width:26px;display:flex;align-items:center;justify-content:center;';
        swapBtn.innerHTML = '<i class="fa-solid fa-right-left"></i>';
        swapBtn.title = '좌우 텍스트 맞바꾸기';
        swapBtn.addEventListener('pointerdown', e => e.stopPropagation());
        swapBtn.addEventListener('click', () => {
            if (_reviewSession) return;
            commitInlineEdit(false);
            _inlineEdit = null;
            const tempText = _diffState.textA;
            _diffState.textA = _diffState.textB;
            _diffState.textB = tempText;

            const tempLock = _diffState.lockedA;
            _diffState.lockedA = _diffState.lockedB;
            _diffState.lockedB = tempLock;

            const tempTarget = _diffState.targetA;
            _diffState.targetA = _diffState.targetB;
            _diffState.targetB = tempTarget;

            renderAll();
        });

        resetBtn = document.createElement('button');
        resetBtn.className = 'ws-btn';
        resetBtn.style.cssText = 'padding:3px 7px;font-size:11.5px;height:24px;width:26px;display:flex;align-items:center;justify-content:center;';
        resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
        resetBtn.addEventListener('pointerdown', e => e.stopPropagation());
        resetBtn.addEventListener('click', () => {
            _inlineEdit = null;
            if (_reviewSession) {
                const curItem = _reviewSession.items[_reviewSession.index];
                if (!curItem) return;
                _diffState.textB = curItem.after ?? '';
                _diffState.lockedB = true;
                renderAll();
                return;
            }
            _diffState.textA = '';
            _diffState.textB = '';
            _diffState.lockedA = false;
            _diffState.lockedB = false;
            _diffState.targetA = null;
            _diffState.targetB = null;
            renderAll();
        });

        const closeX = document.createElement('button');
        closeX.textContent = '✕';
        closeX.style.cssText = 'background:transparent;border:none;color:var(--ws-text2);font-size:13px;cursor:pointer;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;margin-left:4px;';
        closeX.addEventListener('pointerenter', () => { closeX.style.background = 'rgba(0,0,0,0.06)'; });
        closeX.addEventListener('pointerleave', () => { closeX.style.background = 'transparent'; });
        closeX.addEventListener('pointerdown', e => e.stopPropagation());
        closeX.addEventListener('click', () => {
            if (_reviewSession && _reviewSession.appliedCount > 0 && _reviewSession.items.length > 1) {
                const count = _reviewSession.appliedCount;
                clearLastReviewToast(_reviewSession);
                closePanel(PANEL_ID);
                toastr.info(`${count}개 항목을 반영했습니다.`, '', { timeOut: 2500 });
                return;
            }
            closePanel(PANEL_ID);
        });

        headBtns.appendChild(swapBtn);
        headBtns.appendChild(resetBtn);
        headBtns.appendChild(closeX);

        handle.appendChild(titleDiv);
        handle.appendChild(headBtns);
    }

    // ─── 상태바 / Diffchecker 스타일 툴바 ──────────────────────────────────
    const statusBar = document.createElement('div');
    statusBar.className = 'ws-diff-toolbar';

    const statsBadge = document.createElement('div');
    statsBadge.className = 'ws-diff-stats';

    const viewControls = document.createElement('div');
    viewControls.className = 'ws-diff-controls';

    statusBar.appendChild(statsBadge);
    statusBar.appendChild(viewControls);
    body.appendChild(statusBar);

    // ─── 메인 뷰 컨테이너 (컬럼 헤더 + 본문 영역) ───────────────────────────
    const mainWrap = document.createElement('div');
    mainWrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;background:var(--ws-panel2);border-radius:8px;border:1px solid var(--ws-border);';
    body.appendChild(mainWrap);

    // 컬럼 타이틀 헤더 바 (텍스트 A [확인/수정] | 텍스트 B [확인/수정])
    const colHeaderBar = document.createElement('div');
    colHeaderBar.style.cssText = 'display:flex;gap:1px;background:var(--ws-border);flex-shrink:0;border-bottom:1px solid var(--ws-border);';

    const colHeaderA = document.createElement('div');
    colHeaderA.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:6px 12px;background:var(--ws-panel3);';

    const colHeaderB = document.createElement('div');
    colHeaderB.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:6px 12px;background:var(--ws-panel3);';

    colHeaderBar.appendChild(colHeaderA);
    colHeaderBar.appendChild(colHeaderB);
    mainWrap.appendChild(colHeaderBar);

    // 컨텐츠 표시 영역
    const contentArea = document.createElement('div');
    contentArea.style.cssText = 'flex:1;display:flex;min-height:0;overflow:hidden;position:relative;';
    mainWrap.appendChild(contentArea);

    // 순차 검토 하단 액션 바 (검토 모드일 때만 표시)
    const reviewFooter = document.createElement('div');
    reviewFooter.className = 'ws-diff-review-footer';
    const reviewHintEl = document.createElement('div');
    reviewHintEl.className = 'ws-diff-review-hint';
    const reviewActionsEl = document.createElement('div');
    reviewActionsEl.className = 'ws-diff-review-actions';
    reviewFooter.appendChild(reviewHintEl);
    reviewFooter.appendChild(reviewActionsEl);
    body.appendChild(reviewFooter);

    let _inlineEdit = null; // { side: 'A'|'B', lineIdx: number, draft: string }
    let _activeScrollEl = null;
    let _lastTouchTap = null; // { el, x, y, at }
    let _lastDoubleTapAt = 0;

    function captureFullEditScrollTargets() {
        const scrollEl = _activeScrollEl;
        if (!scrollEl) return null;
        const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        const scrollRatio = maxScroll > 0 ? (scrollEl.scrollTop / maxScroll) : 0;

        const computeForSide = (side) => {
            const totalLines = _diffState[side === 'A' ? 'textA' : 'textB'].split(/\r?\n/).length;
            if (totalLines <= 1) return { ratio: scrollRatio, isLineTop: false };
            const attr = side === 'A' ? 'data-ws-diff-line-a' : 'data-ws-diff-line-b';
            const containerRect = scrollEl.getBoundingClientRect?.();
            if (containerRect && containerRect.height > 0) {
                let bestLine = null;
                for (const node of scrollEl.querySelectorAll(`[${attr}]`)) {
                    const rect = node.getBoundingClientRect?.();
                    if (!rect || rect.height === 0) continue;
                    if (rect.bottom >= containerRect.top + 4) {
                        const parsed = parseInt(node.getAttribute(attr), 10);
                        if (Number.isFinite(parsed) && parsed >= 1) {
                            bestLine = parsed;
                            break;
                        }
                    }
                }
                if (bestLine != null && bestLine > 1) {
                    return {
                        ratio: Math.min(1, Math.max(0, (bestLine - 1) / totalLines)),
                        isLineTop: true,
                    };
                }
            }
            return { ratio: scrollRatio, isLineTop: false };
        };

        return { A: computeForSide('A'), B: computeForSide('B') };
    }

    function applyTextareaScrollTarget(ta, target) {
        if (!ta || !target) return;
        const applyNow = () => {
            if (!ta.isConnected && !ta.scrollHeight) return;
            const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
            const pos = target.isLineTop
                ? Math.round(ta.scrollHeight * target.ratio)
                : Math.round(maxScroll * target.ratio);
            ta.scrollTop = Math.min(maxScroll, Math.max(0, pos));
        };
        applyNow();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(applyNow);
        }
    }

    function commitInlineEdit(shouldRender = false) {
        if (!_inlineEdit) return false;
        const activeTa = contentArea.querySelector('.ws-diff-inline-ta');
        if (activeTa) _inlineEdit.draft = activeTa.value;
        const { side, lineIdx, draft } = _inlineEdit;
        const key = side === 'A' ? 'textA' : 'textB';
        const lines = _diffState[key].split(/\r?\n/);
        if (lineIdx >= 0 && lineIdx < lines.length) {
            lines[lineIdx] = draft;
            _diffState[key] = lines.join('\n');
        }
        _inlineEdit = null;
        if (shouldRender) {
            const prevScroll = _activeScrollEl ? _activeScrollEl.scrollTop : 0;
            renderAll({
                restoreScrollTop: prevScroll,
                flashTarget: { side, lineNum: lineIdx + 1 },
            });
        }
        return true;
    }

    function cancelInlineEdit() {
        if (!_inlineEdit) return;
        _inlineEdit = null;
        const prevScroll = _activeScrollEl ? _activeScrollEl.scrollTop : 0;
        renderAll({ restoreScrollTop: prevScroll });
    }

    function openInlineEdit(side, lineNum) {
        if (lineNum == null || lineNum < 1) return;
        let targetLineIdx = lineNum - 1;
        if (_inlineEdit) {
            if (_inlineEdit.side === side && _inlineEdit.lineIdx === targetLineIdx) {
                const existingTa = contentArea.querySelector('.ws-diff-inline-ta');
                existingTa?.focus?.({ preventScroll: true });
                return;
            }
            const prevEditSide = _inlineEdit.side;
            const prevEditIdx = _inlineEdit.lineIdx;
            const activeTa = contentArea.querySelector('.ws-diff-inline-ta');
            if (activeTa) _inlineEdit.draft = activeTa.value;
            const addedLines = _inlineEdit.draft.split(/\r?\n/).length - 1;
            commitInlineEdit(false);
            if (prevEditSide === side && targetLineIdx > prevEditIdx) {
                targetLineIdx += addedLines;
            }
        }
        const key = side === 'A' ? 'textA' : 'textB';
        const lines = _diffState[key].split(/\r?\n/);
        if (targetLineIdx < 0 || targetLineIdx >= lines.length) return;
        const prevScroll = _activeScrollEl ? _activeScrollEl.scrollTop : 0;
        _inlineEdit = { side, lineIdx: targetLineIdx, draft: lines[targetLineIdx] };
        renderAll({ restoreScrollTop: prevScroll, focusInline: true });
    }

    function createInlineEditorElement() {
        const wrap = document.createElement('div');
        wrap.className = 'ws-diff-inline-wrap';

        const ta = document.createElement('textarea');
        ta.className = 'ws-diff-inline-ta';
        ta.value = _inlineEdit.draft;
        ta.rows = Math.min(8, Math.max(2, _inlineEdit.draft.split(/\r?\n/).length));
        ta.addEventListener('input', () => {
            if (_inlineEdit) _inlineEdit.draft = ta.value;
            if (ta.scrollHeight > 0) {
                ta.style.height = 'auto';
                ta.style.height = `${Math.min(280, Math.max(54, ta.scrollHeight + 4))}px`;
            }
        });
        ta.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                commitInlineEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelInlineEdit();
            }
        });

        const bar = document.createElement('div');
        bar.className = 'ws-diff-inline-bar';

        const hint = document.createElement('span');
        hint.className = 'ws-diff-inline-hint';
        hint.textContent = 'Ctrl+Enter 저장 · Esc 취소';

        const actions = document.createElement('div');
        actions.className = 'ws-diff-inline-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'ws-diff-inline-btn';
        cancelBtn.textContent = '취소';
        cancelBtn.addEventListener('click', e => {
            e.stopPropagation();
            cancelInlineEdit();
        });

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'ws-diff-inline-btn primary';
        okBtn.textContent = '확인';
        okBtn.addEventListener('click', e => {
            e.stopPropagation();
            commitInlineEdit(true);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        bar.appendChild(hint);
        bar.appendChild(actions);
        wrap.appendChild(ta);
        wrap.appendChild(bar);
        return wrap;
    }

    function bindInlineEditGesture(el, { editSide, editLine, isLeftOnlyReview }) {
        const trigger = () => {
            if (isLeftOnlyReview) {
                toastr.info('삭제된 줄입니다. [수정]을 눌러 편집하세요.', '', { timeOut: 2500 });
                return;
            }
            if (!editSide || editLine == null) return;
            openInlineEdit(editSide, editLine);
        };

        el.addEventListener('dblclick', e => {
            if (e.target?.closest?.('.ws-diff-inline-wrap')) return;
            if (Date.now() - _lastDoubleTapAt < 450) return;
            e.preventDefault();
            try { window.getSelection?.()?.removeAllRanges?.(); } catch { }
            trigger();
        });

        let downState = null;
        el.addEventListener('pointerdown', e => {
            if (e.pointerType !== 'touch' || e.isPrimary === false) return;
            if (e.target?.closest?.('.ws-diff-inline-wrap')) return;
            downState = { x: e.clientX, y: e.clientY, at: Date.now() };
        });
        el.addEventListener('pointercancel', () => { downState = null; });
        el.addEventListener('pointerup', e => {
            if (e.pointerType !== 'touch' || e.isPrimary === false || !downState) return;
            if (e.target?.closest?.('.ws-diff-inline-wrap')) {
                downState = null;
                return;
            }
            const moved = Math.hypot(e.clientX - downState.x, e.clientY - downState.y);
            const elapsed = Date.now() - downState.at;
            downState = null;
            if (moved > 14 || elapsed > 350) {
                _lastTouchTap = null;
                return;
            }
            const now = Date.now();
            if (_lastTouchTap && _lastTouchTap.el === el
                && (now - _lastTouchTap.at) <= 360
                && Math.hypot(e.clientX - _lastTouchTap.x, e.clientY - _lastTouchTap.y) <= 32) {
                _lastTouchTap = null;
                _lastDoubleTapAt = now;
                e.preventDefault?.();
                try { window.getSelection?.()?.removeAllRanges?.(); } catch { }
                trigger();
            } else {
                _lastTouchTap = { el, x: e.clientX, y: e.clientY, at: now };
            }
        });
    }

    function setupDiffEditableBlock({ el, code, lineA, lineB, html, ownSide, editSide, editLine, isLeftOnlyReview = false }) {
        if (lineA != null) el.setAttribute('data-ws-diff-line-a', String(lineA));
        if (lineB != null) el.setAttribute('data-ws-diff-line-b', String(lineB));

        const ownLineNum = ownSide === 'A' ? lineA : ownSide === 'B' ? lineB : null;
        const isEditingThis = !!(_inlineEdit && ownSide && ownLineNum != null
            && _inlineEdit.side === ownSide && _inlineEdit.lineIdx === ownLineNum - 1);

        if (isEditingThis) {
            el.classList.add('is-inline-editing');
            code.innerHTML = '';
            code.appendChild(createInlineEditorElement());
            return;
        }

        code.innerHTML = html;

        if ((editSide && editLine != null) || isLeftOnlyReview) {
            el.classList.add('is-inline-editable');
            if (!el.title) {
                if (isLeftOnlyReview) {
                    el.title = '원본에서 삭제된 줄 ([수정]으로 추가 가능)';
                } else if (_reviewSession && ownSide === 'A') {
                    el.title = '더블클릭/더블탭하여 대응하는 결과 줄 수정';
                } else {
                    el.title = '더블클릭/더블탭하여 이 줄만 수정';
                }
            }
            bindInlineEditGesture(el, { editSide, editLine, isLeftOnlyReview });
        }
    }

    // ─── 렌더링 함수 ────────────────────────────────────────────────────────

    async function applyDifferenceToChatMessage(side) {
        commitInlineEdit(false);
        const isA = side === 'A';
        const isLocked = isA ? _diffState.lockedA : _diffState.lockedB;
        const textToApply = isA ? _diffState.textA : _diffState.textB;
        const sideName = isA ? '텍스트 A' : '텍스트 B';

        // 1차 안전망: [확인]으로 홀드된 상태에서만 전송 가능
        if (!isLocked) {
            toastr.warning(`${sideName}의 [확인]을 먼저 눌러 주세요.`);
            return;
        }

        let target = isA ? _diffState.targetA : _diffState.targetB;
        let enteredTarget = false;
        if (!target) {
            const input = prompt(`${sideName}의 수정 내용을 반영할 대상 메시지 번호를 입력하세요 (예: 21 또는 21-1):`);
            if (!input) return;
            target = parseMessageTarget(input);
            if (!target) {
                toastr.warning('번호 형식이 올바르지 않습니다.');
                return;
            }
            enteredTarget = true;
        }

        const chat = getChat();
        const msg = chat?.[target.msgIdx];
        if (!msg) {
            toastr.error(`메시지 #${target.msgIdx}를 찾을 수 없습니다.`);
            if (!enteredTarget) {
                if (isA) _diffState.targetA = null;
                else _diffState.targetB = null;
            }
            return;
        }

        if (target.swipeNum !== null) {
            const swipeIdx = target.swipeNum - 1;
            const maxSwipes = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
            if (swipeIdx < 0 || swipeIdx >= maxSwipes) {
                toastr.error(`#${target.msgIdx} 스와이프 #${target.swipeNum}이 없습니다.`);
                return;
            }
        }

        if (enteredTarget) {
            if (isA) _diffState.targetA = target;
            else _diffState.targetB = target;
        }

        const targetStr = target.swipeNum != null ? `#${target.msgIdx}-${target.swipeNum}` : `#${target.msgIdx}`;
        const confirmed = confirm(`메시지 ${targetStr}의 내용을 수정한 ${sideName}로 덮어쓰시겠습니까?\n(기존 메시지 본문이 변경됩니다)`);
        if (!confirmed) return;

        try {
            if (target.swipeNum !== null) {
                const swipeIdx = target.swipeNum - 1;
                if (!Array.isArray(msg.swipes)) msg.swipes = [msg.mes];
                if ((msg.swipe_id ?? 0) === swipeIdx) {
                    await editMessage(target.msgIdx, textToApply);
                } else {
                    const oldSwipeText = msg.swipes[swipeIdx] ?? '';
                    if (oldSwipeText !== textToApply && typeof window !== 'undefined' && typeof window._slashieRecordUndo === 'function') {
                        window._slashieRecordUndo({
                            mesId: target.msgIdx,
                            beforeText: oldSwipeText,
                            afterText: textToApply,
                            isTranslation: false,
                            name: msg.name,
                            isUser: !!msg.is_user,
                            swipeId: swipeIdx,
                        });
                    }
                    msg.swipes[swipeIdx] = textToApply;
                    const ctx = SillyTavern.getContext();
                    if (typeof ctx.saveChat === 'function') await ctx.saveChat();
                    else if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
                }
            } else {
                await editMessage(target.msgIdx, textToApply);
            }
            toastr.success(`${targetStr}에 반영했습니다.`);
        } catch (err) {
            console.error('[Slashie Difference] Failed to apply to chat:', err);
            toastr.error('반영에 실패했습니다.');
        }
    }

    function buildSplitCell({ kind, lineNum, marker, html, title = '', ownSide = null, editSide = null, editLine = null, isLeftOnlyReview = false }) {
        const cell = document.createElement('div');
        if (kind === 'spacer') {
            cell.className = 'ws-diff-cell ws-diff-cell-spacer';
            if (title) cell.title = title;
            return cell;
        }
        cell.className = `ws-diff-cell ${kind === 'del' ? 'is-del' : kind === 'add' ? 'is-add' : 'is-eq'}`;

        const gutter = document.createElement('div');
        gutter.className = 'ws-diff-gutter';
        const ln = document.createElement('span');
        ln.className = 'ws-diff-ln';
        ln.textContent = lineNum != null ? String(lineNum) : '';
        const sign = document.createElement('span');
        sign.className = 'ws-diff-sign';
        sign.textContent = marker || '';
        gutter.appendChild(ln);
        gutter.appendChild(sign);

        const code = document.createElement('div');
        code.className = 'ws-diff-code';
        setupDiffEditableBlock({
            el: cell,
            code,
            lineA: ownSide === 'A' ? lineNum : null,
            lineB: ownSide === 'B' ? lineNum : null,
            html,
            ownSide,
            editSide,
            editLine,
            isLeftOnlyReview,
        });

        cell.appendChild(gutter);
        cell.appendChild(code);
        return cell;
    }

    function buildUnifiedRow({ kind, lineA, lineB, marker, html, ownSide = null, editSide = null, editLine = null, isLeftOnlyReview = false }) {
        const row = document.createElement('div');
        row.className = `ws-diff-unified-row ${kind === 'del' ? 'is-del' : kind === 'add' ? 'is-add' : 'is-eq'}`;

        const gutter = document.createElement('div');
        gutter.className = 'ws-diff-gutter';
        const lnA = document.createElement('span');
        lnA.className = 'ws-diff-ln';
        lnA.textContent = lineA != null ? String(lineA) : '';
        const lnB = document.createElement('span');
        lnB.className = 'ws-diff-ln';
        lnB.textContent = lineB != null ? String(lineB) : '';
        const sign = document.createElement('span');
        sign.className = 'ws-diff-sign';
        sign.textContent = marker || '';
        gutter.appendChild(lnA);
        gutter.appendChild(lnB);
        gutter.appendChild(sign);

        const code = document.createElement('div');
        code.className = 'ws-diff-code';
        setupDiffEditableBlock({
            el: row,
            code,
            lineA,
            lineB,
            html,
            ownSide,
            editSide,
            editLine,
            isLeftOnlyReview,
        });

        row.appendChild(gutter);
        row.appendChild(code);
        return row;
    }

    function prepareDiffRows(aligned) {
        let delCount = 0;
        let addCount = 0;
        const rows = aligned.map(item => {
            if (item.type === 'pair') {
                if (item.a === item.b) {
                    return { ...item, kind: 'equal', htmlA: escapeHTML(item.a || ''), htmlB: escapeHTML(item.b || '') };
                }
                delCount++;
                addCount++;
                const { diffA, diffB } = diffTokenPair(tokenizeFull(item.a), tokenizeFull(item.b));
                return {
                    ...item,
                    kind: 'modified',
                    htmlA: renderDiffTokensHtml(diffA, 'left'),
                    htmlB: renderDiffTokensHtml(diffB, 'right'),
                };
            }
            if (item.type === 'left-only') {
                delCount++;
                return { ...item, kind: 'left-only', htmlA: `<mark class="ws-diff-del">${escapeHTML(item.a)}</mark>`, htmlB: '' };
            }
            addCount++;
            return { ...item, kind: 'right-only', htmlA: '', htmlB: `<mark class="ws-diff-add">${escapeHTML(item.b)}</mark>` };
        });
        return { rows, delCount, addCount };
    }

    function groupFoldableEntries(rows, foldEqual) {
        if (!foldEqual || rows.length === 0) return rows.map(r => ({ type: 'row', row: r }));
        const hasAnyDiff = rows.some(r => r.kind !== 'equal');
        if (!hasAnyDiff) return rows.map(r => ({ type: 'row', row: r }));

        // 변경 줄 바로 위/아래 1줄은 컨텍스트로 유지하고, 가운데 3줄 이상 연속 동일 줄만 접기
        const keep = new Uint8Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].kind !== 'equal') {
                keep[i] = 1;
                if (i > 0) keep[i - 1] = 1;
                if (i + 1 < rows.length) keep[i + 1] = 1;
            }
        }
        const entries = [];
        let run = [];
        const flushRun = () => {
            if (run.length >= 3) entries.push({ type: 'fold', rows: run });
            else run.forEach(r => entries.push({ type: 'row', row: r }));
            run = [];
        };
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].kind === 'equal' && !keep[i]) {
                run.push(rows[i]);
            } else {
                flushRun();
                entries.push({ type: 'row', row: rows[i] });
            }
        }
        flushRun();
        return entries;
    }

    let _nextDiffCursor = -1;

    function renderSplitEntry(entry) {
        const r = entry.row;
        const row = document.createElement('div');
        row.className = 'ws-diff-row';
        if (r.kind !== 'equal') row.setAttribute('data-ws-diff-changed', '1');
        const isReview = !!_reviewSession;

        if (r.kind === 'equal') {
            row.appendChild(buildSplitCell({ kind: 'eq', lineNum: r.lineA, marker: ' ', html: r.htmlA || '&nbsp;', ownSide: 'A' }));
            row.appendChild(buildSplitCell({ kind: 'eq', lineNum: r.lineB, marker: ' ', html: r.htmlB || '&nbsp;', ownSide: 'B' }));
        } else if (r.kind === 'modified') {
            row.appendChild(buildSplitCell({
                kind: 'del', lineNum: r.lineA, marker: '−', html: r.htmlA || '&nbsp;', ownSide: 'A',
                editSide: isReview ? 'B' : 'A', editLine: isReview ? r.lineB : r.lineA,
            }));
            row.appendChild(buildSplitCell({
                kind: 'add', lineNum: r.lineB, marker: '+', html: r.htmlB || '&nbsp;', ownSide: 'B',
                editSide: 'B', editLine: r.lineB,
            }));
        } else if (r.kind === 'left-only') {
            row.appendChild(buildSplitCell({
                kind: 'del', lineNum: r.lineA, marker: '−', html: r.htmlA || '&nbsp;', ownSide: 'A',
                editSide: isReview ? null : 'A', editLine: isReview ? null : r.lineA,
                isLeftOnlyReview: isReview,
            }));
            row.appendChild(buildSplitCell({ kind: 'spacer', title: '텍스트 B에 해당 줄 없음 (위치 정렬)' }));
        } else {
            row.appendChild(buildSplitCell({ kind: 'spacer', title: '텍스트 A에 해당 줄 없음 (위치 정렬)' }));
            row.appendChild(buildSplitCell({
                kind: 'add', lineNum: r.lineB, marker: '+', html: r.htmlB || '&nbsp;', ownSide: 'B',
                editSide: 'B', editLine: r.lineB,
            }));
        }
        return [row];
    }

    function renderUnifiedEntry(entry) {
        const r = entry.row;
        const isReview = !!_reviewSession;
        if (r.kind === 'equal') {
            return [buildUnifiedRow({ kind: 'eq', lineA: r.lineA, lineB: r.lineB, marker: ' ', html: r.htmlA || '&nbsp;' })];
        }
        if (r.kind === 'modified') {
            const delRow = buildUnifiedRow({
                kind: 'del', lineA: r.lineA, lineB: null, marker: '−', html: r.htmlA || '&nbsp;',
                ownSide: 'A', editSide: isReview ? 'B' : 'A', editLine: isReview ? r.lineB : r.lineA,
            });
            delRow.setAttribute('data-ws-diff-changed', '1');
            const addRow = buildUnifiedRow({
                kind: 'add', lineA: null, lineB: r.lineB, marker: '+', html: r.htmlB || '&nbsp;',
                ownSide: 'B', editSide: 'B', editLine: r.lineB,
            });
            return [delRow, addRow];
        }
        if (r.kind === 'left-only') {
            const delRow = buildUnifiedRow({
                kind: 'del', lineA: r.lineA, lineB: null, marker: '−', html: r.htmlA || '&nbsp;',
                ownSide: 'A', editSide: isReview ? null : 'A', editLine: isReview ? null : r.lineA,
                isLeftOnlyReview: isReview,
            });
            delRow.setAttribute('data-ws-diff-changed', '1');
            return [delRow];
        }
        const addRow = buildUnifiedRow({
            kind: 'add', lineA: null, lineB: r.lineB, marker: '+', html: r.htmlB || '&nbsp;',
            ownSide: 'B', editSide: 'B', editLine: r.lineB,
        });
        addRow.setAttribute('data-ws-diff-changed', '1');
        return [addRow];
    }

    function syncResetButton() {
        if (!resetBtn) return;
        if (_reviewSession) {
            const curItem = _reviewSession.items[_reviewSession.index];
            const edited = curItem && _diffState.textB !== (curItem.after ?? '');
            resetBtn.disabled = !edited;
            resetBtn.style.opacity = edited ? '1' : '0.4';
        } else {
            resetBtn.disabled = false;
            resetBtn.style.opacity = '';
        }
    }

    function syncReviewFooterHint() {
        if (!_reviewSession) return;
        const curItem = _reviewSession.items[_reviewSession.index];
        if (!curItem) return;
        if (!_diffState.lockedB) {
            reviewHintEl.innerHTML = '직접 수정 후 <b>[확인]</b>으로 비교하거나 바로 반영하세요.';
        } else if (_diffState.textA === _diffState.textB) {
            reviewHintEl.textContent = '원본과 달라진 부분이 없습니다.';
        } else if (_diffState.textB !== (curItem.after ?? '')) {
            reviewHintEl.innerHTML = '<span style="color:#15803d;font-weight:600;">직접 수정됨</span> · 반영 여부를 선택하세요.';
        } else {
            reviewHintEl.textContent = '변경 내용을 확인하고 반영할지 선택하세요.';
        }
    }

    function advanceOrFinishReview() {
        if (!_reviewSession) return;
        _inlineEdit = null;
        const nextIdx = _reviewSession.index + 1;
        if (nextIdx >= _reviewSession.items.length) {
            if (_reviewSession.appliedCount === 0 && _reviewSession.items.length > 1) {
                clearLastReviewToast(_reviewSession);
                toastr.info('반영 없이 검토를 마쳤습니다.', '', { timeOut: 2500 });
            }
            closePanel(PANEL_ID);
            return;
        }
        _reviewSession.index = nextIdx;
        const nextItem = _reviewSession.items[nextIdx];
        _diffState.textA = nextItem.before ?? '';
        _diffState.textB = nextItem.after ?? '';
        _diffState.lockedA = true;
        _diffState.lockedB = true;
        _diffState.targetA = null;
        _diffState.targetB = null;
        renderAll();
    }

    function renderHeader() {
        if (titleDiv) {
            if (_reviewSession) {
                const curItem = _reviewSession.items[_reviewSession.index];
                const total = _reviewSession.items.length;
                const stepText = total > 1 ? `${_reviewSession.index + 1} / ${total} · ${curItem.label}` : curItem.label;
                titleDiv.innerHTML = `<i class="fa-solid fa-code-compare" style="color:#f59e0b;font-size:13.5px;flex-shrink:0;"></i>`
                    + `<span style="white-space:nowrap;">${escapeHTML(_reviewSession.titlePrefix)}</span>`
                    + `<span class="ws-diff-step-pill">${escapeHTML(stepText)}</span>`;
            } else {
                titleDiv.innerHTML = '<i class="fa-solid fa-code-compare" style="color:#f59e0b;font-size:13.5px;"></i><span>텍스트 비교</span>';
            }
        }
        if (swapBtn) swapBtn.style.display = _reviewSession ? 'none' : 'flex';
        if (resetBtn) {
            resetBtn.title = _reviewSession ? 'AI 변환 원안으로 되돌리기' : '모든 텍스트 초기화';
            syncResetButton();
        }
    }

    function renderReviewFooter() {
        if (!_reviewSession) {
            reviewFooter.style.display = 'none';
            reviewActionsEl.innerHTML = '';
            return;
        }
        const curItem = _reviewSession.items[_reviewSession.index];
        const hasNext = _reviewSession.index + 1 < _reviewSession.items.length;
        reviewFooter.style.display = 'flex';
        syncReviewFooterHint();

        reviewActionsEl.innerHTML = '';
        const skipBtn = document.createElement('button');
        skipBtn.className = 'ws-btn ws-diff-review-skip';
        skipBtn.textContent = hasNext ? '건너뛰기' : '반영 안 함';
        skipBtn.title = hasNext ? '이 항목은 반영하지 않고 다음 항목으로 넘어갑니다.' : '이 항목을 반영하지 않고 검토를 마칩니다.';
        skipBtn.addEventListener('click', () => {
            if (!_reviewSession || _reviewSession.busy) return;
            advanceOrFinishReview();
        });

        const applyBtn = document.createElement('button');
        applyBtn.className = 'ws-btn ws-diff-review-apply';
        const btnLabel = curItem.applyLabel || `${curItem.label}에 반영`;
        applyBtn.innerHTML = `<i class="fa-solid fa-check" style="font-size:11px;"></i><span>${escapeHTML(btnLabel)}</span>`;
        applyBtn.title = hasNext ? `${btnLabel} 후 다음 항목으로 이동합니다.` : `${btnLabel} 후 검토를 마칩니다.`;
        applyBtn.addEventListener('click', async () => {
            if (!_reviewSession || _reviewSession.busy) return;
            commitInlineEdit(false);
            const liveTa = contentArea.querySelector('#ws-diff-textarea-b');
            if (liveTa) _diffState.textB = liveTa.value;
            const finalText = _diffState.textB;
            const session = _reviewSession;
            session.busy = true;
            skipBtn.disabled = true;
            applyBtn.disabled = true;
            try {
                const ok = await curItem.onApply?.(finalText);
                if (ok === false) return;
                session.appliedCount++;
                clearLastReviewToast(session);
                const msg = hasNext
                    ? `${curItem.label}에 반영했습니다.`
                    : (session.items.length > 1
                        ? `${curItem.label} 반영 완료 (${session.appliedCount}개)`
                        : `${curItem.label}에 반영했습니다.`);
                session.lastToast = toastr.success(msg, '', { timeOut: 2500 });
                advanceOrFinishReview();
            } catch (err) {
                console.error('[Slashie Difference] Review apply failed:', err);
                toastr.error('반영에 실패했습니다.', '', { timeOut: 3500 });
            } finally {
                session.busy = false;
                if (skipBtn.isConnected) skipBtn.disabled = false;
                if (applyBtn.isConnected) applyBtn.disabled = false;
            }
        });

        reviewActionsEl.appendChild(skipBtn);
        reviewActionsEl.appendChild(applyBtn);
    }

    function renderAll(opts = {}) {
        const isReview = !!_reviewSession;
        const bothLocked = _diffState.lockedA && _diffState.lockedB;
        const unifiedCompare = bothLocked && _diffState.viewMode === 'unified';
        renderHeader();

        // 헤더 A 갱신
        colHeaderA.innerHTML = '';
        const titleA = document.createElement('div');
        titleA.style.cssText = 'font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;color:var(--ws-text);';
        if (isReview) {
            titleA.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:rgba(239,68,68,0.14);color:#c62828;font-weight:700;font-size:12px;">−</span><span>원본 (Before)</span>';
        } else {
            const tagA = _diffState.targetA ? `<span style="font-size:11px;color:var(--ws-text2);font-weight:400;">#${_diffState.targetA.swipeNum != null ? `${_diffState.targetA.msgIdx}-${_diffState.targetA.swipeNum}` : _diffState.targetA.msgIdx}</span>` : '';
            titleA.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:rgba(239,68,68,0.14);color:#c62828;font-weight:700;font-size:12px;">−</span><span>원본 (텍스트 A)</span> ${tagA}`;
        }

        const actionsA = document.createElement('div');
        actionsA.style.cssText = 'display:flex;align-items:center;gap:6px;';

        if (!isReview) {
            const btnA = document.createElement('button');
            btnA.className = 'ws-btn' + (_diffState.lockedA ? '' : ' ws-btn-accent');
            btnA.style.cssText = 'padding:3px 10px;font-size:11.5px;height:24px;border-radius:6px;';
            btnA.innerHTML = _diffState.lockedA ? '<i class="fa-solid fa-pen" style="margin-right:4px;font-size:10px;"></i>수정' : '<i class="fa-solid fa-check" style="margin-right:4px;font-size:10px;"></i>확인';
            btnA.addEventListener('click', () => {
                let fullEditScroll = null;
                if (!_diffState.lockedA) {
                    const ta = contentArea.querySelector('#ws-diff-textarea-a');
                    if (ta) _diffState.textA = ta.value;
                    _diffState.lockedA = true;
                } else {
                    commitInlineEdit(false);
                    fullEditScroll = captureFullEditScrollTargets();
                    _diffState.lockedA = false;
                }
                renderAll({ fullEditScroll });
            });
            actionsA.appendChild(btnA);

            if (_diffState.lockedA) {
                const applyBtnA = document.createElement('button');
                applyBtnA.className = 'ws-btn ws-btn-accent';
                applyBtnA.style.cssText = 'padding:3px 10px;font-size:11.5px;height:24px;border-radius:6px;color:#c62828;';
                applyBtnA.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket" style="margin-right:4px;font-size:10px;"></i>본문 반영';
                applyBtnA.title = '수정 완료된 내용을 해당 번호의 본문 채팅 메시지에 덮어씁니다.';
                applyBtnA.addEventListener('click', () => {
                    applyDifferenceToChatMessage('A');
                });
                actionsA.appendChild(applyBtnA);
            }
        }

        colHeaderA.appendChild(titleA);
        colHeaderA.appendChild(actionsA);

        // 헤더 B 갱신
        colHeaderB.innerHTML = '';
        const titleB = document.createElement('div');
        titleB.style.cssText = 'font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;color:var(--ws-text);';
        if (isReview) {
            titleB.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:rgba(34,197,94,0.16);color:#15803d;font-weight:700;font-size:12px;">+</span><span>결과 (After)</span>';
        } else {
            const tagB = _diffState.targetB ? `<span style="font-size:11px;color:var(--ws-text2);font-weight:400;">#${_diffState.targetB.swipeNum != null ? `${_diffState.targetB.msgIdx}-${_diffState.targetB.swipeNum}` : _diffState.targetB.msgIdx}</span>` : '';
            titleB.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:rgba(34,197,94,0.16);color:#15803d;font-weight:700;font-size:12px;">+</span><span>수정 (텍스트 B)</span> ${tagB}`;
        }

        const actionsB = document.createElement('div');
        actionsB.style.cssText = 'display:flex;align-items:center;gap:6px;';

        const btnB = document.createElement('button');
        btnB.className = 'ws-btn' + (_diffState.lockedB ? '' : ' ws-btn-accent');
        btnB.style.cssText = 'padding:3px 10px;font-size:11.5px;height:24px;border-radius:6px;';
        btnB.innerHTML = _diffState.lockedB ? '<i class="fa-solid fa-pen" style="margin-right:4px;font-size:10px;"></i>수정' : '<i class="fa-solid fa-check" style="margin-right:4px;font-size:10px;"></i>확인';
        btnB.addEventListener('click', () => {
            let fullEditScroll = null;
            if (!_diffState.lockedB) {
                const tb = contentArea.querySelector('#ws-diff-textarea-b');
                if (tb) _diffState.textB = tb.value;
                _diffState.lockedB = true;
            } else {
                commitInlineEdit(false);
                fullEditScroll = captureFullEditScrollTargets();
                _diffState.lockedB = false;
            }
            renderAll({ fullEditScroll });
        });
        actionsB.appendChild(btnB);

        if (_diffState.lockedB && !isReview) {
            const applyBtnB = document.createElement('button');
            applyBtnB.className = 'ws-btn ws-btn-accent';
            applyBtnB.style.cssText = 'padding:3px 10px;font-size:11.5px;height:24px;border-radius:6px;color:#15803d;';
            applyBtnB.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket" style="margin-right:4px;font-size:10px;"></i>본문 반영';
            applyBtnB.title = '수정 완료된 내용을 해당 번호의 본문 채팅 메시지에 덮어씁니다.';
            applyBtnB.addEventListener('click', () => {
                applyDifferenceToChatMessage('B');
            });
            actionsB.appendChild(applyBtnB);
        }

        colHeaderB.appendChild(titleB);
        colHeaderB.appendChild(actionsB);

        // 본문 & 툴바 렌더링
        contentArea.innerHTML = '';
        viewControls.innerHTML = '';
        _nextDiffCursor = -1;

        if (!bothLocked) {
            _activeScrollEl = null;
            // [모드 1: 편집 / 단일 홀드 모드]
            statsBadge.innerHTML = isReview
                ? '<span style="color:var(--ws-text2);"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>오른쪽 결과를 수정한 뒤 [확인]을 누르면 변경점을 다시 비교할 수 있습니다.</span>'
                : '<span style="color:var(--ws-text2);"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>양쪽 내용을 입력하고 [확인]을 누르면 Diff 비교가 시작됩니다.</span>';

            const splitBox = document.createElement('div');
            splitBox.style.cssText = 'display:flex;flex:1;min-height:0;overflow:hidden;gap:1px;background:var(--ws-border);width:100%;';

            const boxA = document.createElement('div');
            boxA.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ws-panel);padding:8px;';
            let taA = null;
            if (!_diffState.lockedA) {
                taA = document.createElement('textarea');
                taA.id = 'ws-diff-textarea-a';
                taA.className = 'ws-diff-textarea';
                taA.placeholder = '원본 텍스트(A)를 입력하세요.';
                taA.value = _diffState.textA;
                taA.addEventListener('input', () => { _diffState.textA = taA.value; });
                boxA.appendChild(taA);
            } else {
                const lockedTitleA = isReview ? '원본 (Before)' : '텍스트 A 확인 완료 (홀드됨)';
                boxA.innerHTML = `
                    <div class="ws-diff-locked-card">
                        <div class="ws-diff-locked-header"><i class="fa-solid fa-lock"></i> ${lockedTitleA}</div>
                        <div class="ws-diff-locked-body ws-thin-scroll">${escapeHTML(_diffState.textA)}</div>
                    </div>
                `;
            }

            const boxB = document.createElement('div');
            boxB.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ws-panel);padding:8px;';
            let taB = null;
            if (!_diffState.lockedB) {
                taB = document.createElement('textarea');
                taB.id = 'ws-diff-textarea-b';
                taB.className = 'ws-diff-textarea';
                taB.placeholder = isReview ? '반영할 텍스트를 수정하세요.' : '비교할 텍스트(B)를 입력하세요.';
                taB.value = _diffState.textB;
                taB.addEventListener('input', () => {
                    _diffState.textB = taB.value;
                    syncResetButton();
                    syncReviewFooterHint();
                });
                boxB.appendChild(taB);
            } else {
                boxB.innerHTML = `
                    <div class="ws-diff-locked-card">
                        <div class="ws-diff-locked-header"><i class="fa-solid fa-lock"></i> 텍스트 B 확인 완료 (홀드됨)</div>
                        <div class="ws-diff-locked-body ws-thin-scroll">${escapeHTML(_diffState.textB)}</div>
                    </div>
                `;
            }

            splitBox.appendChild(boxA);
            splitBox.appendChild(boxB);
            contentArea.appendChild(splitBox);

            if (taA && opts.fullEditScroll?.A) applyTextareaScrollTarget(taA, opts.fullEditScroll.A);
            if (taB && opts.fullEditScroll?.B) applyTextareaScrollTarget(taB, opts.fullEditScroll.B);

        } else {
            // [모드 2: Diffchecker 스타일 비교 뷰]
            const linesA = _diffState.textA.split(/\r?\n/);
            const linesB = _diffState.textB.split(/\r?\n/);
            const aligned = alignParagraphs(linesA, linesB);
            const { rows, delCount, addCount } = prepareDiffRows(aligned);

            const simPercent = computeOverallSimilarity(linesA, linesB);
            const isIdentical = linesA.join('\n') === linesB.join('\n');
            statsBadge.innerHTML = '';
            const delPill = document.createElement('span');
            delPill.className = 'ws-diff-pill-del';
            delPill.textContent = `−${delCount}`;
            const addPill = document.createElement('span');
            addPill.className = 'ws-diff-pill-add';
            addPill.textContent = `+${addCount}`;
            const simSpan = document.createElement('span');
            simSpan.innerHTML = `유사도 <b style="color:var(--ws-text);">${simPercent}%</b>`;
            statsBadge.appendChild(delPill);
            statsBadge.appendChild(addPill);
            statsBadge.appendChild(simSpan);
            if (isIdentical) {
                const eqSpan = document.createElement('span');
                eqSpan.style.cssText = 'color:#15803d;font-weight:600;';
                eqSpan.textContent = '· 완전히 동일함';
                statsBadge.appendChild(eqSpan);
            }

            // 컨트롤 바: [나란히 | 통합] + [동일 접기] + [다음 차이 ↓] + (Unified일 때만 [결과 수정 / 다시 편집])
            const seg = document.createElement('div');
            seg.className = 'ws-diff-seg';
            const splitViewBtn = document.createElement('button');
            splitViewBtn.textContent = '나란히';
            splitViewBtn.className = _diffState.viewMode === 'split' ? 'active' : '';
            splitViewBtn.addEventListener('click', () => { commitInlineEdit(false); _diffState.viewMode = 'split'; renderAll(); });
            const unifiedViewBtn = document.createElement('button');
            unifiedViewBtn.textContent = '통합';
            unifiedViewBtn.className = _diffState.viewMode === 'unified' ? 'active' : '';
            unifiedViewBtn.addEventListener('click', () => { commitInlineEdit(false); _diffState.viewMode = 'unified'; renderAll(); });
            seg.appendChild(splitViewBtn);
            seg.appendChild(unifiedViewBtn);
            viewControls.appendChild(seg);

            const foldBtn = document.createElement('button');
            foldBtn.className = 'ws-btn ws-diff-ctrl-btn' + (_diffState.foldEqual ? ' ws-btn-accent' : '');
            foldBtn.textContent = _diffState.foldEqual ? '전체 보기' : '동일 접기';
            foldBtn.title = '변경이 없는 동일 구간 접기/펼치기';
            foldBtn.addEventListener('click', () => { commitInlineEdit(false); _diffState.foldEqual = !_diffState.foldEqual; renderAll(); });
            viewControls.appendChild(foldBtn);

            const scrollContainer = document.createElement('div');
            scrollContainer.className = 'ws-diff-table ws-thin-scroll';

            if (delCount > 0 || addCount > 0) {
                const nextDiffBtn = document.createElement('button');
                nextDiffBtn.className = 'ws-btn ws-diff-ctrl-btn';
                nextDiffBtn.innerHTML = '다음 차이 ↓';
                nextDiffBtn.addEventListener('click', () => {
                    const targets = Array.from(scrollContainer.querySelectorAll('[data-ws-diff-changed="1"]'));
                    if (!targets.length) return;
                    _nextDiffCursor = (_nextDiffCursor + 1) % targets.length;
                    const el = targets[_nextDiffCursor];
                    el.scrollIntoView({ block: 'center', behavior: 'auto' });
                    el.classList.add('ws-diff-row-flash');
                    setTimeout(() => el.classList.remove('ws-diff-row-flash'), 750);
                });
                viewControls.appendChild(nextDiffBtn);
            }

            if (unifiedCompare) {
                const editBothBtn = document.createElement('button');
                editBothBtn.className = 'ws-btn ws-diff-ctrl-btn';
                editBothBtn.innerHTML = `<i class="fa-solid fa-pen" style="margin-right:3px;font-size:10px;"></i>${isReview ? '결과 수정' : '다시 편집'}`;
                editBothBtn.addEventListener('click', () => {
                    commitInlineEdit(false);
                    const fullEditScroll = captureFullEditScrollTargets();
                    if (!isReview) _diffState.lockedA = false;
                    _diffState.lockedB = false;
                    renderAll({ fullEditScroll });
                });
                viewControls.appendChild(editBothBtn);
            }

            if (rows.length === 0) {
                scrollContainer.innerHTML = '<div style="color:var(--ws-text2);text-align:center;padding:40px 0;">비교할 내용이 없습니다.</div>';
            } else {
                const entries = groupFoldableEntries(rows, _diffState.foldEqual);
                const renderEntry = unifiedCompare ? renderUnifiedEntry : renderSplitEntry;

                entries.forEach(entry => {
                    if (entry.type === 'fold') {
                        const bar = document.createElement('button');
                        bar.className = 'ws-diff-fold-bar';
                        bar.innerHTML = `<i class="fa-solid fa-ellipsis"></i><span>동일한 줄 ${entry.rows.length}개 펼쳐보기</span>`;
                        bar.addEventListener('click', () => {
                            const frag = document.createDocumentFragment();
                            entry.rows.forEach(r => renderEntry({ type: 'row', row: r }).forEach(el => frag.appendChild(el)));
                            bar.replaceWith(frag);
                        });
                        scrollContainer.appendChild(bar);
                    } else {
                        renderEntry(entry).forEach(el => scrollContainer.appendChild(el));
                    }
                });
            }

            contentArea.appendChild(scrollContainer);
            _activeScrollEl = scrollContainer;

            if (opts.restoreScrollTop != null) {
                scrollContainer.scrollTop = opts.restoreScrollTop;
            }
            if (opts.flashTarget) {
                const attr = opts.flashTarget.side === 'A' ? 'data-ws-diff-line-a' : 'data-ws-diff-line-b';
                const candidates = Array.from(scrollContainer.querySelectorAll(`[${attr}="${opts.flashTarget.lineNum}"]`));
                const flashEl = opts.flashTarget.side === 'B'
                    ? (candidates.find(n => n.classList.contains('is-add')) || candidates[candidates.length - 1])
                    : (candidates.find(n => n.classList.contains('is-del')) || candidates[0]);
                if (flashEl) {
                    flashEl.classList.add('ws-diff-row-flash');
                    setTimeout(() => flashEl.classList.remove('ws-diff-row-flash'), 750);
                }
            }
            if (opts.focusInline) {
                const activeTa = contentArea.querySelector('.ws-diff-inline-ta');
                if (activeTa) {
                    if (activeTa.scrollHeight > 0) {
                        activeTa.style.height = 'auto';
                        activeTa.style.height = `${Math.min(280, Math.max(54, activeTa.scrollHeight + 4))}px`;
                    }
                    try {
                        activeTa.focus({ preventScroll: true });
                    } catch {
                        activeTa.focus();
                    }
                    if (opts.restoreScrollTop != null) {
                        scrollContainer.scrollTop = opts.restoreScrollTop;
                    }
                }
            }
        }

        renderReviewFooter();
    }

    renderAll();
    attachPanelResizers(panel);
    raiseToTop(panel);
}

// ─── 슬래시 커맨드 등록 ───────────────────────────────────────────────────────
function parseMessageTarget(token) {
    if (!token) return null;
    const str = String(token).trim();
    const m = str.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const msgIdx = parseInt(m[1], 10);
    const swipeNum = m[2] !== undefined ? parseInt(m[2], 10) : null;
    if (swipeNum !== null && swipeNum < 1) return null;
    return { msgIdx, swipeNum };
}

function getMessageTextByTarget(target) {
    if (!target) return '';
    const chat = getChat();
    const msg = chat?.[target.msgIdx];
    if (!msg) return '';
    if (target.swipeNum !== null) {
        const swipeIdx = target.swipeNum - 1;
        if (Array.isArray(msg.swipes)) {
            if (swipeIdx >= 0 && swipeIdx < msg.swipes.length) return msg.swipes[swipeIdx] ?? '';
            return '';
        }
        return target.swipeNum === 1 ? (msg.mes ?? '') : '';
    }
    return msg.mes ?? '';
}

function validateMessageTarget(chat, target) {
    const msg = chat?.[target.msgIdx];
    if (!msg) {
        toastr.warning(`메시지 #${target.msgIdx}를 찾을 수 없습니다.`, '', { timeOut: 3000 });
        return false;
    }
    if (target.swipeNum !== null) {
        const maxSwipes = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        if (target.swipeNum < 1 || target.swipeNum > maxSwipes) {
            toastr.warning(`#${target.msgIdx} 스와이프 #${target.swipeNum}이 없습니다.`, '', { timeOut: 3000 });
            return false;
        }
    }
    return true;
}

export function registerDifferenceCommands() {
    if (!window._wsDiffChatListenerAttached) {
        window._wsDiffChatListenerAttached = true;
        const ctx0 = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
        const evtChat = ctx0?.event_types?.CHAT_CHANGED ?? 'chat_id_changed';
        ctx0?.eventSource?.on?.(evtChat, () => {
            _diffState.targetA = null;
            _diffState.targetB = null;
            if (_savedManualDiffState) {
                _savedManualDiffState.targetA = null;
                _savedManualDiffState.targetB = null;
            }
        });
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'difference',
        helpString: 'Open side-by-side text difference and similarity inspection panel. Usage: /difference [msg1] [msg2] (e.g. 21 24, 21-1 21-3, or 7)',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Message index/swipe (e.g. 21 24, 21-1 21-3) or text (optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: (_a, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                openDifferencePanel();
                return '';
            }
            const parts = raw.split(/\s+/);
            const targetA = parts.length <= 2 ? parseMessageTarget(parts[0]) : null;
            const targetB = parts.length === 2 ? parseMessageTarget(parts[1]) : null;
            if (targetA && (parts.length === 1 || targetB)) {
                const chat = getChat();
                if (!chat?.[targetA.msgIdx]) {
                    toastr.warning(`메시지 #${targetA.msgIdx}를 찾을 수 없습니다.`, '', { timeOut: 3000 });
                    return '';
                }
                if (!validateMessageTarget(chat, targetA)) return '';
                const textA = getMessageTextByTarget(targetA);
                if (targetB) {
                    if (!chat?.[targetB.msgIdx]) {
                        toastr.warning(`메시지 #${targetB.msgIdx}를 찾을 수 없습니다.`, '', { timeOut: 3000 });
                        return '';
                    }
                    if (!validateMessageTarget(chat, targetB)) return '';
                    const textB = getMessageTextByTarget(targetB);
                    openDifferencePanel(textA, textB, true, true, targetA, targetB);
                    return '';
                }
                openDifferencePanel(textA, '', true, false, targetA, null);
                return '';
            }

            // 메시지 번호 형식이 아닌 일반 텍스트인 경우 (/difference (string), /difference {{input}} 등)
            // 왼쪽 텍스트 패널에 입력값을 채우고 편집 가능한 상태로 비교 패널을 엶
            openDifferencePanel(raw, '', false, false, null, null);
            return '';
        },
    }));
}
