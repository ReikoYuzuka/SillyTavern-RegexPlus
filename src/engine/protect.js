// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * 保护替换 —— 逐字复刻 RP-Hub core-utils.js 的 transformUnprotectedText / protectedContentPattern
 * / splitProtectedText（D2-3 修复，2026-10-07，保护 7 类 → 官方 13 备选 + parseCot 栈式思考块）。
 *
 * 目的（引擎设计.md §5）：美化正则把 AI 输出替换成 ```html 代码块后，后续正则不能破坏代码块
 * （历史 bug：正则把代码块拆坏 → 渲染器不识别）。仅 rphub 模式启用；st 模式无保护（与原版一致）。
 *
 * 来源：RP-Hub-main/assets/js/core-utils.js:278-297，逐字保留语义：
 *   - protectedContentPattern 提取受保护片段（:278，14 备选）：
 *       DOCTYPE/html/script/style 成对 + 四者未闭合吃尾 + ui_template_updates 可选闭合 +
 *       HTML 注释可选闭合 + ``` 成对/未闭合 + 行内码 + 引号感知标签；
 *   - splitProtectedText（:280-294）：先 parseCot.ranges 标思考块 protected，再 appendPlain
 *     其余部分按 pattern 切分（split with capture group → exact 锚定判定）；
 *   - transformUnprotectedText（:295-297）：protected 段原样、普通段 transform。
 *
 * 保护可配置化（引擎设计.md §5 定稿 + D2-3 扩展）：
 *   - PROTECT_ITEMS 把官方静态 13 备选拆成可按需拼装的类目（新增 doctype/html/script/style
 *     未闭合、ui_template_updates、HTML 注释、``` 未闭合；html_tag 改官方引号感知形态）；
 *   - cot_think 类目由 parseCot 栈式解析承载（官方语义，core-utils.js:19-69），不再以
 *     近似正则进 pattern 源 —— 默认全开时 pattern 源与官方 :278 逐字一致，勾选语义不变；
 *   - buildProtectedSource(items) 按勾选项拼接保护模式（规范顺序 = 官方 source 顺序）；
 *   - transformUnprotectedText(text, transform, items)：items 缺省 = 全部（默认全开，
 *     行为与原版逐字一致）；items = 空数组 → 无任何保护，直接对全文 transform。
 *
 * 调用方（rphub 解释器）另按 RP-Hub app.js 语义判断是否启用保护：
 *   当正则模式本身含 <、> 或 ``` 时跳过保护直接替换；且受「保护替换」总开关
 *   （rp_hub_protect_enabled，settings.js）与勾选项（rp_hub_protect_items）约束。
 */

/**
 * 官方 parseCot 的 token 扫描正则（core-utils.js:24 逐字，gi）。
 * 承载栈式思考块解析：成对容器标签吃尾、注释/代码围栏/行内码/普通标签逐个扫描、
 * thinking|think|cot 标签进栈出栈定 ranges。
 */
const PARSE_COT_TOKENS = /<(html|script|style|ui_template_updates)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|`[^`\r\n]*`|<\s*(\/?)\s*(thinking|think|cot)\s*>|<\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

/**
 * parseCot 思考块范围 —— 逐字复刻 RP-Hub core-utils.js:19-69 的栈式解析（只取 ranges）。
 * 重复开标签仍属于分析；只有真正的闭合标签才能放行正文；尾部未闭合 → range 吃到文本末尾
 * （:56）；流式拆开的残缺闭合标签尾部按 :54 剥离。
 * @param {string} text
 * @returns {Array<{start: number, end: number}>}
 */
export function parseCotRanges(text) {
    const source = String(text || '');
    if (!source) return [];
    const openTags = [];
    const ranges = [];
    let blockStart = 0;
    let cursor = 0;
    for (const match of source.matchAll(PARSE_COT_TOKENS)) {
        cursor = match.index + match[0].length;
        if (!match[3]) continue; // 非思考标签 token：只推进游标
        const tag = match[3].toLowerCase();
        if (!match[2]) {
            // 开标签：首个开标签定 blockStart，重复开标签仍在栈内继续分析
            if (!openTags.length) blockStart = match.index;
            if (!openTags.includes(tag)) openTags.push(tag);
        } else if (openTags[openTags.length - 1] === tag) {
            // 匹配栈顶的闭标签：栈清空 → 一个完整思考块 range 落定
            openTags.pop();
            if (!openTags.length) ranges.push({ start: blockStart, end: match.index + match[0].length });
        }
    }
    if (openTags.length) ranges.push({ start: blockStart, end: source.length });
    return ranges;
}

/**
 * 保护项 → 正则源片段映射（官方 core-utils.js:278 protectedContentPattern 的 14 备选拆解，
 * 顺序 = 官方 source 顺序；cot_think 由 parseCotRanges 承载，不在 pattern 源内）。
 */
export const PROTECT_ITEMS = {
    /** <!DOCTYPE html>…</html> 成对。 */
    html_doc: '<!DOCTYPE html>[\\s\\S]*?<\\/html>',
    /** <html …>…</html> 成对。 */
    html_doc_pair: '<html\\b[^>]*>[\\s\\S]*?<\\/html>',
    /** <script …>…</script> 成对。 */
    script: '<script\\b[^>]*>[\\s\\S]*?<\\/script>',
    /** <style …>…</style> 成对。 */
    style: '<style\\b[^>]*>[\\s\\S]*?<\\/style>',
    /** <!DOCTYPE html> 未闭合吃尾。 */
    doctype_unclosed: '<!DOCTYPE html>[\\s\\S]*$',
    /** <html …> 未闭合吃尾。 */
    html_unclosed: '<html\\b[^>]*>[\\s\\S]*$',
    /** <script …> 未闭合吃尾。 */
    script_unclosed: '<script\\b[^>]*>[\\s\\S]*$',
    /** <style …> 未闭合吃尾。 */
    style_unclosed: '<style\\b[^>]*>[\\s\\S]*$',
    /** <ui_template_updates …> 可选闭合（官方更新块标签自身受保护，防卡内正则改写变量块）。 */
    ui_template_updates: '<ui_template_updates\\b[^>]*>[\\s\\S]*?(?:<\\/ui_template_updates>|$)',
    /** HTML 注释 <!-- … --> 可选闭合。 */
    html_comment: '<!--[\\s\\S]*?(?:-->|$)',
    /** markdown 代码块（```…```）成对。 */
    code_block: '```[\\s\\S]*?```',
    /** markdown 代码块未闭合吃尾。 */
    code_block_unclosed: '```[\\s\\S]*$',
    /** 行内代码（`…`）。 */
    inline_code: '`[^`]+`',
    /** 单个 HTML 标签（开/闭/自闭合，官方引号感知形态：属性值内 > 不截断）。 */
    html_tag: '<\\/?[a-zA-Z][\\w:-]*(?:[^"\'<>]|"[^"]*"|\'[^\']*\')*>',
};

/**
 * 思考块保护（cot/think/cot 栈式解析，官方 parseCot 语义）—— 不进 pattern 源，
 * 由 transformUnprotectedText 的 parseCot 前置承载；保留键名以兼容既有勾选存储。
 */
export const COT_PROTECT_KEY = 'cot_think';

/** 保护项展示名（面板勾选列表用）。 */
export const PROTECT_ITEM_LABELS = {
    html_doc: '完整 HTML 文档（DOCTYPE 成对）',
    html_doc_pair: '完整 HTML 文档（<html> 成对）',
    script: 'script 块',
    style: 'style 块',
    doctype_unclosed: '未闭合 DOCTYPE 文档',
    html_unclosed: '未闭合 <html> 文档',
    script_unclosed: '未闭合 <script>',
    style_unclosed: '未闭合 <style>',
    ui_template_updates: 'ui_template_updates 更新块',
    html_comment: 'HTML 注释',
    code_block: '代码块（``` 成对）',
    code_block_unclosed: '代码块（``` 未闭合）',
    inline_code: '行内代码',
    html_tag: 'HTML 标签（引号感知）',
    [COT_PROTECT_KEY]: 'cot/think 思考块',
};

/** 保护项规范顺序（拼接顺序 = 官方 protectedContentPattern source 顺序 + cot_think 末位）。 */
export const PROTECT_ITEM_KEYS = [...Object.keys(PROTECT_ITEMS), COT_PROTECT_KEY];

/** 默认保护项 = 全部（默认全开，行为与原版逐字一致）。 */
export const DEFAULT_PROTECT_ITEMS = [...PROTECT_ITEM_KEYS];

/**
 * 按勾选项拼接保护模式源（cot_think 不产生 pattern 源，由 parseCot 前置承载）。
 * @param {string[]|undefined|null} [items] 保护项键（PROTECT_ITEM_KEYS 子集）；
 *   缺省 = 全部；非数组 / 未知项忽略；空数组 → ''（无任何保护）。
 * @returns {string} 用 | 拼接的正则源片段
 */
export function buildProtectedSource(items) {
    if (items === undefined || items === null) {
        return Object.keys(PROTECT_ITEMS).map((k) => PROTECT_ITEMS[k]).join('|');
    }
    if (!Array.isArray(items)) return '';
    const set = new Set(items.filter((k) => Object.prototype.hasOwnProperty.call(PROTECT_ITEMS, k)));
    return Object.keys(PROTECT_ITEMS).filter((k) => set.has(k)).map((k) => PROTECT_ITEMS[k]).join('|');
}

/** 默认（全开）保护模式 —— 与官方 core-utils.js:278 protectedContentPattern source 逐字一致。 */
const PROTECTED_SOURCE = buildProtectedSource();

/** 逐字复刻 core-utils.js:278（gi 标志）。 */
export const protectedContentPattern = new RegExp(`(${PROTECTED_SOURCE})`, 'gi');

/** 逐字复刻 core-utils.js:279（i 标志，锚定整个片段）。 */
export const exactProtectedContentPattern = new RegExp(`^(${PROTECTED_SOURCE})$`, 'i');

/**
 * 按勾选项构建拆分模式。
 * @param {string[]|undefined} [items] 保护项键；缺省 = 全部
 * @returns {RegExp|null} null = 无任何保护项（不应拆分，直接全文 transform）
 */
export function buildProtectedContentPattern(items) {
    const source = buildProtectedSource(items);
    if (!source) return null;
    return new RegExp(`(${source})`, 'gi');
}

/**
 * 按勾选项构建精确匹配模式。
 * @param {string[]|undefined} [items] 保护项键；缺省 = 全部
 * @returns {RegExp|null} null = 无任何保护项
 */
export function buildExactProtectedContentPattern(items) {
    const source = buildProtectedSource(items);
    if (!source) return null;
    return new RegExp(`^(${source})$`, 'i');
}

/**
 * splitProtectedText —— 逐字复刻 core-utils.js:280-294：
 * 先 parseCot.ranges 标思考块 protected，再对其余文本 appendPlain（split with capture
 * group → 每段 exact 锚定判定）。
 * @param {string} text 原文
 * @param {boolean} includeCot 是否启用 parseCot 思考块保护（cot_think 勾选或缺省）
 * @param {RegExp} splitPattern 保护拆分正则
 * @param {RegExp} exactPattern exact 锚定正则
 * @returns {Array<{text: string, protected: boolean}>}
 */
function splitProtectedText(text, includeCot, splitPattern, exactPattern) {
    const source = String(text || '');
    const parts = [];
    const appendPlain = (value) => {
        value.split(splitPattern).forEach((part) => {
            if (part) parts.push({ text: part, protected: exactPattern.test(part) });
        });
    };
    if (includeCot) {
        let cursor = 0;
        for (const { start, end } of parseCotRanges(source)) {
            appendPlain(source.slice(cursor, start));
            parts.push({ text: source.slice(start, end), protected: true });
            cursor = end;
        }
        appendPlain(source.slice(cursor));
        return parts;
    }
    appendPlain(source);
    return parts;
}

/**
 * 只对非受保护片段应用 transform。
 * 逐字复刻 core-utils.js:295-297 transformUnprotectedText（缺省 items = 全部，含
 * parseCot 思考块前置，与原版逐字一致）。
 * @param {string} text 原文
 * @param {(part: string) => string} transform 对普通文本片段的替换函数
 * @param {string[]|undefined} [items] 保护项键（勾选项）；空数组 = 无保护，直接对全文 transform
 * @returns {string}
 */
export function transformUnprotectedText(text, transform, items) {
    const useDefault = items === undefined || items === null;
    const splitPattern = useDefault ? protectedContentPattern : buildProtectedContentPattern(items);

    // 无任何保护项（空勾选）→ 直接对全文 transform（无保护语义）
    if (!splitPattern) {
        return transform(String(text || ''));
    }

    const exactPattern = useDefault ? exactProtectedContentPattern : buildExactProtectedContentPattern(items);
    const includeCot = useDefault || (Array.isArray(items) && items.includes(COT_PROTECT_KEY));
    const parts = splitProtectedText(text, includeCot, splitPattern, exactPattern);
    return parts
        .map((part) => (part.protected ? part.text : transform(part.text)))
        .join('');
}
