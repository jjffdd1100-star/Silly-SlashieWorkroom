// ─── utils.js ───────────────────────────────────────────────────────────────
// 파싱, 텍스트 가공, 정규식 헬퍼.

export function parseRange(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const str = String(raw).trim();
    const single = str.match(/^(\d+)$/);
    if (single) return [parseInt(single[1], 10)];
    const range = str.match(/^(\d+)-(\d+)$/);
    if (range) {
        const s = parseInt(range[1], 10), e = parseInt(range[2], 10);
        if (s > e || (e - s + 1) > 50000) return null;
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
    }
    return null;
}

// 콤마 구분 단일 숫자("5") 또는 범위("2-8") 파싱 (예: "0,2-8,11")
export function parseChangeRangeInput(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return null;
    const parts = str.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const result = [];
    for (const p of parts) {
        if (/^\d+$/.test(p)) { result.push(parseInt(p, 10)); continue; }
        const m = p.match(/^(\d+)-(\d+)$/);
        if (!m) return null;
        const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
        if (s > e || (e - s + 1) > 50000) return null;
        for (let i = s; i <= e; i++) {
            result.push(i);
            if (result.length > 50000) return null;
        }
    }
    return result;
}

const _wsDOMParser = new DOMParser();

export function stripText(html) {
    const c = String(html ?? '')
        .replace(/<style(\s[^>]*)?>[\s\S]*?<\/style>/gi, '')
        .replace(/<(?!(\/?[a-zA-Z][a-zA-Z0-9:-]*|!--[\s\S]*?--|!DOCTYPE)(?:\s[^>]*|\/?)>)/gi, '&lt;');
    return _wsDOMParser.parseFromString(c, 'text/html').body.textContent || '';
}

export function escapeHTML(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function expandDetails(html) {
    const openRe = /<details\b[^>]*>/gi, closeRe = /<\/details>/gi;
    const tags = []; let m;
    openRe.lastIndex = 0; while ((m = openRe.exec(html))) tags.push({ type:'open',  start:m.index, end:m.index+m[0].length });
    closeRe.lastIndex = 0; while ((m = closeRe.exec(html))) tags.push({ type:'close', start:m.index, end:m.index+m[0].length });
    tags.sort((a,b) => a.start - b.start);
    let depth = 0, outerOpen = null; const pairs = [];
    for (const t of tags) {
        if (t.type === 'open') { if (depth === 0) outerOpen = t; depth++; }
        else { if (depth === 0) continue; depth--; if (depth === 0 && outerOpen) { pairs.push({ open:outerOpen, close:t }); outerOpen = null; } }
    }
    if (!pairs.length) return html.trim();
    let result = html;
    for (let i = pairs.length - 1; i >= 0; i--) {
        const { open, close } = pairs[i];
        const inner = result.slice(open.end, close.start).replace(/^\s*<summary(?:\s[^>]*)?>[\s\S]*?<\/summary>/i, '');
        result = result.slice(0, open.start) + inner.trim() + result.slice(close.end);
    }
    return result.trim();
}

export function hexAlphaToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    let h = m ? m[1] : 'ff3399';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const a = Number.isFinite(Number(alpha)) ? Math.min(100, Math.max(0, Number(alpha))) : 100;
    const r = parseInt(h.slice(0,2), 16), g = parseInt(h.slice(2,4), 16), b = parseInt(h.slice(4,6), 16);
    return `rgba(${r},${g},${b},${(a/100).toFixed(2)})`;
}

export const ESC_SPECIAL = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyFiller(escaped, ignoreSpace) {
    if (!ignoreSpace) return escaped;
    const stripped = escaped.replace(/\s+/g, ''); if (!stripped) return escaped;
    const atoms = []; let i = 0;
    while (i < stripped.length) {
        if (stripped[i] === '\\' && i + 1 < stripped.length) {
            const cpLen = (stripped.codePointAt(i + 1) ?? 0) > 0xFFFF ? 2 : 1;
            atoms.push(stripped.slice(i, i + 1 + cpLen));
            i += 1 + cpLen;
        } else {
            const cpLen = (stripped.codePointAt(i) ?? 0) > 0xFFFF ? 2 : 1;
            atoms.push(stripped.slice(i, i + cpLen));
            i += cpLen;
        }
    }
    return atoms.join('\\s*');
}

// HTML 태그를 동일 길이의 더미 문자(\u0000)로 마스킹하여 오프셋을 보존한 채 검색에서 제외
export function maskTags(raw) {
    return raw.replace(/<(?:!--[\s\S]*?--|(?:\/[a-zA-Z][a-zA-Z0-9_:-]*\s*|[a-zA-Z][a-zA-Z0-9_:-]*(?:\s(?:"[^"]*"|'[^']*'|[^<>])*)?\/?))>/g, m => '\u0000'.repeat(m.length));
}

const REASONING_WRAPPER_TAGS = ['think', 'thinking', 'CoT', 'starter'];

function replaceReasoningBlocks(raw, replacer) {
    let text = raw;
    for (const tag of REASONING_WRAPPER_TAGS) {
        const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, 'gi');
        text = text.replace(re, replacer);
    }
    return text;
}

export function maskReasoningBlocks(raw) {
    return replaceReasoningBlocks(raw, m => '\u0000'.repeat(m.length));
}

export function applyWholeWord(pattern, wholeWord) {
    if (!wholeWord) return pattern;
    return `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
}

export function buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord = false, ignoreTags = false, allowedIdxs = null, ignoreReasoning = false, getText = null) {
    if (!Array.isArray(chat) || !chat.length) return [];
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord), all = [];
    const allowedSet = allowedIdxs ? new Set(allowedIdxs) : null;
    let re_flags = flags.includes('g') ? flags : flags + 'g';
    if (wholeWord && !re_flags.includes('u')) re_flags += 'u';
    const re = new RegExp(re_esc, re_flags);
    chat.forEach((msg, msgIdx) => {
        if (!msg) return;
        if (allowedSet && !allowedSet.has(msgIdx)) return;
        let searchText = getText ? getText(msg) : msg.mes;
        if (searchText === undefined || searchText === null) return;
        if (ignoreReasoning) searchText = maskReasoningBlocks(searchText);
        if (ignoreTags) searchText = maskTags(searchText);
        re.lastIndex = 0;
        let m, matchIdx = 0;
        while ((m = re.exec(searchText)) !== null) {
            if (m.index === re.lastIndex) { re.lastIndex++; continue; }
            all.push({ msgIdx, matchIdx, charIdx: m.index }); matchIdx++;
        }
    });
    return all;
}

export function parseRangeInputFlexible(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return { idxs: null };
    const idxs = parseChangeRangeInput(str);
    if (idxs === null) return 'invalid';
    return { idxs };
}

export function stripReasoningBlocks(raw) {
    return replaceReasoningBlocks(raw, () => '');
}

export function stripLeadingTagBlock(raw) {
    let text = raw;
    while (true) {
        const trimmed = text.replace(/^\s+/, '');
        const m = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?(\/?)>/);
        if (!m) break;
        if (m[2] === '/') { text = trimmed.slice(m[0].length); continue; }
        const tag = m[1];
        const tagRe = new RegExp(`<(/)?${tag}(?:\\s[^>]*)?(/?)>`, 'gi');
        let depth = 0, endIdx = -1, tm;
        while ((tm = tagRe.exec(trimmed)) !== null) {
            if (tm[1]) {
                depth--;
                if (depth === 0) { endIdx = tm.index + tm[0].length; break; }
            } else if (!tm[2]) {
                depth++;
            }
        }
        if (endIdx < 0) break;
        text = trimmed.slice(endIdx);
    }
    return text;
}

export function smartInsertSpacing(fullText, insertPos, insertedText) {
    const before = fullText[insertPos - 1], after = fullText[insertPos];
    const left  = (before !== undefined && !/\s/.test(before)) ? ' ' : '';
    const right = (after  !== undefined && !/\s/.test(after))  ? ' ' : '';
    return fullText.slice(0, insertPos) + left + insertedText + right + fullText.slice(insertPos);
}
