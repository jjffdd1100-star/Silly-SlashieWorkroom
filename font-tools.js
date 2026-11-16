// ─── font-tools.js ──────────────────────────────────────────────────────────
// /fonta — FontAwesome 아이콘 유니코드 검색 및 복사 (스크립트 연동 지원)
// /fontb — 특수 폰트(Mathematical Alphanumeric, Small Caps, Circled 등) 변환 패널 및 커맨드

import { createPanel, getPanelBody, closePanel } from './panel-ui.js';
import { copyText } from './state.js';

// ─── FontAwesome 유니코드 매핑 ───────────────────────────────────────────────
// 브라우저에 로드된 FontAwesome 스타일시트에서 실시간으로 아이콘 이름과 유니코드를 추출.
// cross-origin 등으로 읽지 못할 때를 대비한 풍부한 핵심 아이콘 폴백 맵 포함.
const FALLBACK_FA_MAP = {
    // Basic & UI
    'heart': 'f004', 'star': 'f005', 'user': 'f007', 'check': 'f00c', 'times': 'f00d', 'xmark': 'f00d',
    'gear': 'f013', 'cog': 'f013', 'house': 'f015', 'home': 'f015', 'trash': 'f1f8', 'trash-alt': 'f2ed',
    'trash-can': 'f2ed', 'magnifying-glass': 'f002', 'search': 'f002', 'pen': 'f304', 'pencil': 'f303', 'copy': 'f0c5',
    'comment': 'f075', 'comments': 'f086', 'message': 'f27a', 'image': 'f03e', 'images': 'f302',
    'music': 'f001', 'play': 'f04b', 'pause': 'f04c', 'stop': 'f04d', 'arrows-rotate': 'f021', 'sync': 'f021',
    'arrow-left': 'f060', 'arrow-right': 'f061', 'arrow-up': 'f062', 'arrow-down': 'f063',
    'chevron-left': 'f053', 'chevron-right': 'f054', 'chevron-up': 'f077', 'chevron-down': 'f078',
    'bars': 'f0c9', 'ellipsis': 'f141', 'ellipsis-vertical': 'f142',
    'circle': 'f111', 'check-circle': 'f058', 'circle-check': 'f058', 'circle-xmark': 'f057',
    'exclamation-circle': 'f06a', 'circle-exclamation': 'f06a', 'info-circle': 'f05a', 'circle-info': 'f05a',
    'question-circle': 'f059', 'circle-question': 'f059', 'floppy-disk': 'f0c7', 'save': 'f0c7',
    'folder': 'f07b', 'folder-open': 'f07c', 'lock': 'f023', 'unlock': 'f09c', 'key': 'f084',
    'eye': 'f06e', 'eye-slash': 'f070', 'bell': 'f0f3', 'bell-slash': 'f1f6',
    'bookmark': 'f02e', 'wand-magic-sparkles': 'e2ca', 'wand-magic': 'f0d0', 'eraser': 'f12d',
    'maximize': 'f31e', 'minimize': 'f78c', 'expand': 'f065', 'compress': 'f066', 'ghost': 'f6e2',
    'map-pin': 'f276', 'location-dot': 'f3c5', 'note-sticky': 'f249', 'quote-left': 'f10d', 'quote-right': 'f10e',
    'link': 'f0c1', 'unlink': 'f127', 'file': 'f15b', 'file-lines': 'f15c', 'font': 'f031',
    'bold': 'f032', 'italic': 'f033', 'code': 'f121', 'terminal': 'f120',

    // Hands & Gestures
    'hands': 'f4c2', 'hand': 'f256', 'hand-sparkles': 'e05d', 'hand-holding': 'f4bd', 'hand-holding-heart': 'f4be',
    'hand-point-up': 'f0a6', 'hand-point-down': 'f0a7', 'hand-point-left': 'f0a5', 'hand-point-right': 'f0a4',
    'thumbs-up': 'f164', 'thumbs-down': 'f165', 'handshake': 'f2b5',

    // Tools, Media, Editing
    'brush': 'f55d', 'palette': 'f53f', 'paint-roller': 'f5aa', 'crop': 'f125', 'sliders': 'f1de', 'filter': 'f0b0',
    'scissors': 'f0c4', 'paperclip': 'f0c6', 'upload': 'f093', 'download': 'f019', 'share': 'f064',
    'share-nodes': 'f1e0', 'rotate-left': 'f2ea', 'rotate-right': 'f2f9', 'clock-rotate-left': 'f1da',
    'layer-group': 'f5fd', 'cubes': 'f1b3', 'box': 'f466', 'boxes-stacked': 'f468',

    // Objects, Symbols, Nature
    'fire': 'f06d', 'bolt': 'f0e7', 'sun': 'f185', 'moon': 'f186', 'cloud': 'f0c2', 'snowflake': 'f2dc',
    'shield': 'f132', 'shield-halved': 'f3ed', 'crown': 'f521', 'gem': 'f3a5', 'diamond': 'f219',
    'book': 'f02d', 'book-open': 'f518', 'clock': 'f017', 'calendar': 'f133', 'tag': 'f02b', 'tags': 'f02c',
    'globe': 'f0ac', 'earth-americas': 'f57d', 'language': 'f1ab', 'bullhorn': 'f0a1', 'circle-nodes': 'e4e2',
    'sparkles': 'e880', 'dice': 'f522', 'dice-d20': 'f6cf', 'trophy': 'f091', 'medal': 'f5a2',
};

let _cachedFaMap = null;
let _cachedFaStyleMap = null;

const KNOWN_FA_BRANDS = new Set([
    'github', 'discord', 'twitter', 'x-twitter', 'youtube', 'instagram', 'facebook', 'tiktok',
    'twitch', 'reddit', 'apple', 'google', 'windows', 'linux', 'android', 'steam', 'spotify',
    'patreon', 'paypal', 'amazon', 'linkedin', 'pinterest', 'whatsapp', 'telegram', 'line',
    'slack', 'chrome', 'firefox', 'safari', 'edge', 'node-js', 'python', 'js', 'html5', 'css3',
    'react', 'vuejs', 'git', 'gitlab', 'bitbucket', 'npm', 'docker', 'aws', 'cloudflare',
]);

function getFontAwesomeMap() {
    if (_cachedFaMap && _cachedFaMap.size > 0) return _cachedFaMap;
    const map = new Map();
    const styleMap = new Map();
    // 1) 기본 폴백 등록
    Object.entries(FALLBACK_FA_MAP).forEach(([k, v]) => map.set(k, v));

    // 2) 브라우저 스타일시트 실시간 파싱
    try {
        for (const sheet of document.styleSheets) {
            try {
                const rules = sheet.cssRules || sheet.rules;
                if (!rules) continue;
                for (const rule of rules) {
                    if (rule.selectorText && rule.selectorText.includes('.fa-') && (rule.selectorText.includes('::before') || rule.selectorText.includes(':before'))) {
                        const content = rule.style?.content;
                        if (content && content !== 'none' && content !== 'normal') {
                            const rawChar = content.replace(/^['"]|['"]$/g, '');
                            let hex = '';
                            if (/^\\[0-9a-f]{1,6}$/i.test(rawChar)) {
                                hex = rawChar.slice(1).toLowerCase().replace(/^0+(?=.)/, '');
                            } else if (rawChar.length > 0 && !rawChar.startsWith('\\')) {
                                const cp = rawChar.codePointAt(0);
                                if (cp >= 0xE000) {
                                    hex = cp.toString(16).toLowerCase();
                                }
                            }
                            if (hex) {
                                const isBrandRule = rule.selectorText.includes('.fa-brands') || rule.selectorText.includes('.fab') || /brands/i.test(rule.style?.fontFamily || '');
                                const isRegRule = !isBrandRule && (rule.selectorText.includes('.fa-regular') || rule.selectorText.includes('.far'));
                                const matches = rule.selectorText.match(/\.fa-([a-z0-9-]+)(?=::?before)/g);
                                if (matches) {
                                    matches.forEach(m => {
                                        const name = m.replace(/^\.fa-/, '');
                                        map.set(name, hex);
                                        if (isBrandRule || KNOWN_FA_BRANDS.has(name)) styleMap.set(name, 'fa-brands');
                                        else if (isRegRule && !styleMap.has(name)) styleMap.set(name, 'fa-regular');
                                    });
                                }
                            }
                        }
                    }
                }
            } catch {}
        }
    } catch {}

    KNOWN_FA_BRANDS.forEach(name => { if (!styleMap.has(name)) styleMap.set(name, 'fa-brands'); });
    _cachedFaMap = map;
    _cachedFaStyleMap = styleMap;
    return map;
}

export function lookupFaIcon(query) {
    if (!query) return null;
    const str = query.trim().toLowerCase();
    const map = getFontAwesomeMap();

    // 1) 16진수 코드 포인트로 이름 찾기 (예: f004, \f004, \00f004, \uf004, u+f004)
    const codeMatch = str.match(/^(?:\\u|\\|&#x|u\+|u)?([0-9a-f]{3,6});?$/i);
    if (codeMatch) {
        const targetHex = codeMatch[1].toLowerCase().replace(/^0+(?=.)/, '');
        for (const [name, hex] of map.entries()) {
            if (hex === targetHex) {
                return { type: 'name', result: name, display: name };
            }
        }
    }

    // 2) 아이콘 이름으로 코드 찾기 (예: heart, fa-heart, fa-solid fa-heart)
    const cleanName = str
        .replace(/^fa-(solid|regular|brands)\s+/, '')
        .replace(/^fa-/, '');

    if (map.has(cleanName)) {
        const hex = map.get(cleanName);
        return { type: 'code', result: `\\${hex}`, display: `\\${hex}`, name: cleanName };
    }

    // 이름 부분 일치 검색
    for (const [name, hex] of map.entries()) {
        if (name.includes(cleanName)) {
            return { type: 'code', result: `\\${hex}`, display: `\\${hex}`, name };
        }
    }

    return null;
}

// ─── /fonta UI 패널 ──────────────────────────────────────────────────────────
export function openFontAPanel() {
    const PANEL_ID = 'ws-fonta-panel';
    if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return; }
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    // fontb와 동일한 크기(width 340px, list max-height 360px)로 설정하여 화면 중앙 y위치 일치
    panel.style.width = '340px';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;';
    title.innerHTML = '<span><i class="fa-solid fa-icons" style="margin-right:6px;"></i>FontAwesome 검색</span>';
    body.appendChild(title);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '영문명 검색 (아래 목록에 없는 아이콘도 검색)';
    searchInput.autocomplete = 'off'; searchInput.spellcheck = false;
    searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px;border:1px solid var(--ws-border);' +
        'border-radius:6px;background:var(--ws-panel2);color:inherit;outline:none;margin-bottom:8px;';
    body.appendChild(searchInput);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:var(--ws-text2);margin-bottom:8px;';
    hint.textContent = '클릭하면 유니코드(\\f...)가 클립보드에 복사됩니다.';
    body.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'ws-thin-scroll';
    list.style.cssText = 'max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;';
    body.appendChild(list);

    const map = getFontAwesomeMap();
    const allIcons = Array.from(map.entries()).map(([name, hex]) => ({ name, hex }));

    function renderList(query = '') {
        list.innerHTML = '';
        const q = query.trim().toLowerCase().replace(/^fa-/, '');
        const filtered = allIcons.filter(item => !q || item.name.includes(q)).slice(0, 100);

        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align:center;color:var(--ws-text2);font-size:12px;padding:16px 0;';
            empty.textContent = '일치하는 아이콘이 없습니다.';
            list.appendChild(empty);
            return;
        }

        filtered.forEach(({ name, hex }) => {
            const item = document.createElement('div');
            item.className = 'ws-result-item';
            item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;background:var(--ws-panel2);border:1px solid var(--ws-border);margin-bottom:2px;';

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const icon = document.createElement('i');
            const prefix = _cachedFaStyleMap?.get(name) || 'fa-solid';
            icon.className = `${prefix} fa-${name}`;
            icon.style.cssText = 'font-size:14px;width:18px;text-align:center;flex-shrink:0;color:var(--SmartThemeQuoteColor, inherit);';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;
            left.appendChild(icon); left.appendChild(nameSpan);

            const right = document.createElement('span');
            right.style.cssText = 'font-family:monospace;font-size:11px;color:var(--ws-text2);flex-shrink:0;';
            right.textContent = `\\${hex}`;

            item.appendChild(left); item.appendChild(right);
            item.addEventListener('click', async () => {
                const code = `\\${hex}`;
                const ok = await copyText(code, false);
                if (ok) toastr.success(code, '', { timeOut: 1500 });
                else toastr.error('Clipboard 접근이 거부되었습니다.', '', { timeOut: 2000 });
            });
            list.appendChild(item);
        });
    }

    searchInput.addEventListener('input', () => renderList(searchInput.value));
    renderList('');
    setTimeout(() => searchInput.focus(), 50);
}

// ─── 특수 폰트 (Mathematical Alphanumeric & More) 변환기 ────────────────────────
// Unicode Mathematical Alphanumeric Symbols offset mappings
const FONT_STYLES = [
    { key: 'bold', label: '𝗕𝗼𝗹𝗱 (볼드)', transform: t => toMath(t, 0x1D400, 0x1D41A, 0x1D7CE) },
    { key: 'italic', label: '𝘐𝘵𝘢𝘭𝘪𝘤 (이탤릭)', transform: t => toItalic(t) },
    { key: 'bolditalic', label: '𝑩𝒐𝒍𝒅 𝑰𝒕𝒂𝒍𝒊𝒄 (볼드 이탤릭)', transform: t => toMath(t, 0x1D468, 0x1D482) },
    { key: 'script', label: '𝒮𝒸𝓇𝒾𝓅𝓉 (필기체)', transform: t => toScript(t) },
    { key: 'boldscript', label: '𝓒𝓊𝓇𝓈𝒾𝓋ℯ (볼드 필기체)', transform: t => toMath(t, 0x1D4D0, 0x1D4EA) },
    { key: 'fraktur', label: '𝔉𝔯𝔞𝔨𝔱𝔲𝔯 (프락투어)', transform: t => toFraktur(t) },
    { key: 'boldfraktur', label: '𝕱𝖗𝖆𝖐𝖙𝖚𝖗 (볼드 프락투어)', transform: t => toMath(t, 0x1D56C, 0x1D586) },
    { key: 'doublestruck', label: '𝔻𝕠𝕦𝕓𝕝𝕖-𝕤𝕥𝕣𝕦𝕔𝕜 (칠판 볼드)', transform: t => toDoubleStruck(t) },
    { key: 'sans', label: '𝖲𝖺𝗇𝗌-𝗌𝖾𝗋𝗂𝖿 (산세리프)', transform: t => toMath(t, 0x1D5A0, 0x1D5BA, 0x1D7E2) },
    { key: 'sansbold', label: '𝗦𝗮𝗻𝘀 𝗕𝗼𝗹𝗱 (산세리프 볼드)', transform: t => toMath(t, 0x1D5D4, 0x1D5EE, 0x1D7EC) },
    { key: 'sansitalic', label: '𝘚𝘢𝘯𝘴 𝘐𝘵𝘢𝘭𝘪𝘤 (산세리프 이탤릭)', transform: t => toMath(t, 0x1D608, 0x1D622) },
    { key: 'sansbolditalic', label: '𝙎𝙖𝙣𝙨 𝘽𝙤𝙡𝙙 𝙄𝙩𝙖𝙡𝙞𝙘', transform: t => toMath(t, 0x1D63C, 0x1D656) },
    { key: 'mono', label: '𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎 (모노스페이스)', transform: t => toMath(t, 0x1D670, 0x1D68A, 0x1D7F6) },
    { key: 'smallcaps', label: 'ꜱᴍᴀʟʟ ᴄᴀᴘꜱ (스몰 캡스)', transform: t => toSmallCaps(t) },
    { key: 'circled', label: 'Ⓒⓘⓡⓒⓛⓔⓓ (원문자)', transform: t => toCircled(t) },
    { key: 'bubbleblack', label: '🅑🅛🅐🅒🅚 (검은 원문자)', transform: t => toBubbleBlack(t) },
    { key: 'squared', label: '🄱🄾🅇🄴🄳 (네모 박스)', transform: t => toSquared(t) },
    { key: 'squaredblack', label: '🅱🅾🆇🅴🅳 (검은 네모)', transform: t => toSquaredBlack(t) },
    { key: 'upsidedown', label: 'uʍop ǝpᴉsd∩ (거꾸로)', transform: t => toUpsideDown(t) },
    { key: 'strike', label: 'S̶t̶r̶i̶k̶e̶ (취소선)', transform: t => toStrike(t) },
    { key: 'underline', label: 'U̲n̲d̲e̲r̲l̲i̲n̲e̲ (밑줄)', transform: t => toUnderline(t) },
    { key: 'doubleunderline', label: 'D̳o̳u̳b̳l̳e̳ (이중 밑줄)', transform: t => toDoubleUnderline(t) },
    { key: 'superscript', label: 'ˢᵘᵖᵉʳˢᶜʳᶦᵖᵗ (윗첨자)', transform: t => toSuperScript(t) },
    { key: 'subscript', label: 'ₛᵤᵦₛ𝒸ᵣᵢₚₜ (아래첨자)', transform: t => toSubScript(t) },
    { key: 'parenthesized', label: '⒫⒜⒭⒠⒩ (괄호 문자)', transform: t => toParenthesized(t) },
    { key: 'fullwidth', label: 'Ｆｕｌｌｗｉｄｔｈ (전각)', transform: t => toFullwidth(t) },
];

function toMath(str, upperBase, lowerBase, numBase = null) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(upperBase + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(lowerBase + (code - 97));
        if (numBase !== null && code >= 48 && code <= 57) return String.fromCodePoint(numBase + (code - 48));
        return ch;
    }).join('');
}

function toItalic(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (ch === 'h') return 'ℎ'; // Planck constant exception
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D434 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D44E + (code - 97));
        return ch;
    }).join('');
}

function toScript(str) {
    const scriptUpper = {
        'B': 'ℬ', 'E': 'ℰ', 'F': 'ℱ', 'H': 'ℋ', 'I': 'ℐ', 'L': 'ℒ', 'M': 'ℳ', 'R': 'ℛ'
    };
    const scriptLower = {
        'e': 'ℯ', 'g': 'ℊ', 'o': 'ℴ'
    };
    return Array.from(str).map(ch => {
        if (scriptUpper[ch]) return scriptUpper[ch];
        if (scriptLower[ch]) return scriptLower[ch];
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D49C + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D4B6 + (code - 97));
        return ch;
    }).join('');
}

function toFraktur(str) {
    const frakUpper = { 'C': 'ℭ', 'H': 'ℌ', 'I': 'ℑ', 'R': 'ℜ', 'Z': 'ℨ' };
    return Array.from(str).map(ch => {
        if (frakUpper[ch]) return frakUpper[ch];
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D504 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D51E + (code - 97));
        return ch;
    }).join('');
}

function toDoubleStruck(str) {
    const dsUpper = { 'C': 'ℂ', 'H': 'ℍ', 'N': 'ℕ', 'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'Z': 'ℤ' };
    return Array.from(str).map(ch => {
        if (dsUpper[ch]) return dsUpper[ch];
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D538 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D552 + (code - 97));
        if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7D8 + (code - 48));
        return ch;
    }).join('');
}

function toSmallCaps(str) {
    const smalls = {
        'a': 'ᴀ', 'b': 'ʙ', 'c': 'ᴄ', 'd': 'ᴅ', 'e': 'ᴇ', 'f': 'ꜰ', 'g': 'ɢ', 'h': 'ʜ', 'i': 'ɪ',
        'j': 'ᴊ', 'k': 'ᴋ', 'l': 'ʟ', 'm': 'ᴍ', 'n': 'ɴ', 'o': 'ᴏ', 'p': 'ᴘ', 'q': 'ꞯ', 'r': 'ʀ',
        's': 'ꜱ', 't': 'ᴛ', 'u': 'ᴜ', 'v': 'ᴠ', 'w': 'ᴡ', 'x': 'x', 'y': 'ʏ', 'z': 'ᴢ'
    };
    return Array.from(str).map(ch => smalls[ch.toLowerCase()] || ch).join('');
}

function toCircled(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x24B6 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x24D0 + (code - 97));
        if (code >= 49 && code <= 57) return String.fromCodePoint(0x2460 + (code - 49));
        if (code === 48) return '⓪';
        return ch;
    }).join('');
}

function toBubbleBlack(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F150 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1F150 + (code - 97));
        if (code >= 49 && code <= 57) return String.fromCodePoint(0x2776 + (code - 49));
        if (code === 48) return '⓿';
        return ch;
    }).join('');
}

function toSquared(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F130 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1F130 + (code - 97));
        return ch;
    }).join('');
}

function toSquaredBlack(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F170 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1F170 + (code - 97));
        return ch;
    }).join('');
}

function toUpsideDown(str) {
    const map = {
        'a': 'ɐ', 'b': 'q', 'c': 'ɔ', 'd': 'p', 'e': 'ǝ', 'f': 'ɟ', 'g': 'ƃ', 'h': 'ɥ',
        'i': 'ᴉ', 'j': 'ɾ', 'k': 'ʞ', 'l': 'l', 'm': 'ɯ', 'n': 'u', 'o': 'o', 'p': 'd',
        'q': 'b', 'r': 'ɹ', 's': 's', 't': 'ʇ', 'u': 'n', 'v': 'ʌ', 'w': 'ʍ', 'x': 'x',
        'y': 'ʎ', 'z': 'z', 'A': '∀', 'B': '𐐒', 'C': 'Ɔ', 'D': 'ᗡ', 'E': 'Ǝ', 'F': 'Ⅎ',
        'G': '⅁', 'H': 'H', 'I': 'I', 'J': 'ſ', 'K': 'ʞ', 'L': '˥', 'M': 'W', 'N': 'N',
        'O': 'O', 'P': 'Ԁ', 'Q': 'Ό', 'R': 'ᴚ', 'S': 'S', 'T': '┴', 'U': '∩', 'V': 'Λ',
        'W': 'M', 'X': 'X', 'Y': '⅄', 'Z': 'Z', '1': 'Ɩ', '2': 'ᄅ', '3': 'Ɛ', '4': 'ㄣ',
        '5': 'ϛ', '6': '9', '7': 'ㄥ', '8': '8', '9': '6', '0': '0', '.': '˙', ',': '\'',
        '?': '¿', '!': '¡', '"': '„', '\'': ',', '`': ',', '(': ')', ')': '(', '[': ']',
        ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '&': '⅋', '_': '‾'
    };
    return Array.from(str).reverse().map(ch => map[ch] || ch).join('');
}

function toStrike(str) {
    return Array.from(str).map(ch => /\s/.test(ch) ? ch : ch + '\u0336').join('');
}

function toUnderline(str) {
    return Array.from(str).map(ch => /\s/.test(ch) ? ch : ch + '\u0332').join('');
}

function toDoubleUnderline(str) {
    return Array.from(str).map(ch => /\s/.test(ch) ? ch : ch + '\u0347').join('');
}

function toSuperScript(str) {
    const map = {
        'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ',
        'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ', 'p': 'ᵖ',
        'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
        'A': 'ᴬ', 'B': 'ᴮ', 'D': 'ᴰ', 'E': 'ᴱ', 'G': 'ᴳ', 'H': 'ᴴ', 'I': 'ᴵ', 'J': 'ᴶ',
        'K': 'ᴷ', 'L': 'ᴸ', 'M': 'ᴹ', 'N': 'ᴺ', 'O': 'ᴼ', 'P': 'ᴾ', 'R': 'ᴿ', 'T': 'ᵀ',
        'U': 'ᵁ', 'V': 'ⱽ', 'W': 'ᵂ',
        '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
        '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾'
    };
    return Array.from(str).map(ch => map[ch] || ch).join('');
}

function toSubScript(str) {
    const map = {
        'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ',
        'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ',
        '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
        '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎'
    };
    return Array.from(str).map(ch => map[ch] || ch).join('');
}

function toParenthesized(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x249C + (code - 97));
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x249C + (code - 65));
        if (code >= 49 && code <= 57) return String.fromCodePoint(0x2474 + (code - 49));
        return ch;
    }).join('');
}

function toFullwidth(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0);
        if (code === 32) return '　';
        if (code >= 33 && code <= 126) return String.fromCodePoint(0xFF01 + (code - 33));
        return ch;
    }).join('');
}

export function convertSpecialFont(text, styleKey = 'bold') {
    if (!text) return '';
    const style = FONT_STYLES.find(s => s.key === styleKey.toLowerCase()) || FONT_STYLES[0];
    return style.transform(text);
}

// ─── /fontb UI 패널 ──────────────────────────────────────────────────────────
export function openFontBPanel(initialText = '') {
    const PANEL_ID = 'ws-fontb-panel';
    if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return; }
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    panel.style.width = '340px';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px;';
    title.innerHTML = '<i class="fa-solid fa-font"></i><span>특수 폰트 변환기</span>';
    body.appendChild(title);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '변환할 영문/숫자 입력';
    input.value = initialText;
    input.autocomplete = 'off'; input.spellcheck = false;
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px;border:1px solid var(--ws-border);' +
        'border-radius:6px;background:var(--ws-panel2);color:inherit;outline:none;margin-bottom:8px;';
    body.appendChild(input);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:var(--ws-text2);margin-bottom:8px;';
    hint.textContent = '클릭하면 변환된 결과가 클립보드에 복사됩니다.';
    body.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'ws-thin-scroll';
    list.style.cssText = 'max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;';
    body.appendChild(list);

    function update() {
        const text = input.value || 'Hello World';
        list.innerHTML = '';
        FONT_STYLES.forEach(style => {
            const converted = style.transform(text);
            const card = document.createElement('div');
            card.className = 'ws-result-item';
            card.style.cssText = 'display:flex;flex-direction:column;gap:3px;padding:7px 10px;border-radius:6px;cursor:pointer;background:var(--ws-panel2);border:1px solid var(--ws-border);';

            const header = document.createElement('div');
            header.style.cssText = 'font-size:10.5px;color:var(--ws-text2);font-weight:600;display:flex;justify-content:space-between;';
            header.innerHTML = `<span>${style.label}</span><span style="opacity:0.6;"><i class="fa-regular fa-copy"></i> 복사</span>`;

            const preview = document.createElement('div');
            preview.style.cssText = 'font-size:14px;color:var(--ws-text);word-break:break-all;line-height:1.4;';
            preview.textContent = converted;

            card.appendChild(header); card.appendChild(preview);
            card.addEventListener('click', async () => {
                await copyText(converted);
            });
            list.appendChild(card);
        });
    }

    input.addEventListener('input', update);
    update();
    setTimeout(() => input.focus(), 50);
}
