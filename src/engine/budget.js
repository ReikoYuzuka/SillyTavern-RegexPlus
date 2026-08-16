// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * 超时预算 —— 防灾难性回溯（性能防线最高优先级）。
 *
 * 背景（ST原版正则性能分析.md §4.1）：
 *   原版无任何执行预算，病理正则 `(a+)+$` 在 35 字符输入下同步卡死主线程 ~110 秒。
 *   同步 RegExp 无法中途强杀，因此本模块采用「三层防线」：
 *
 *   1. ReDoS 静态预检（isRedosRisky）：执行前检测「组 + 无界量词 + 组内含量化原子」
 *      （嵌套量词形态，如 `(a+)+`、`(a*)*`、`(?:[ab]+)+`）—— 命中即跳过，根本不会执行。
 *   2. 可中断替换（runInterruptibleReplace）：用 exec 循环逐匹配替换，每个匹配间检查
 *      预算时钟，多匹配慢脚本可被中途掐断（丢弃部分结果，文本保持不变）。
 *   3. 事后计时（withBudget）：脚本执行完成后统计耗时，超过预算则记录 timedOut。
 *
 * 语义（引擎设计.md §6）：
 *   - 每条正则预算默认 50ms，超时 → 中断跳过并记录（console.warn + applied[] 标注）。
 *   - 写好的正则（30 脚本 × 14KB ≈ 1.8ms）远低于预算，无感。
 */

const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => performance.now()
    : () => Date.now();

/**
 * 判定正则字符串是否存在「嵌套量词」形态的灾难性回溯风险。
 *
 * 规则：模式中存在某个分组 `(...)`，其后跟「无界量词」（`*`、`+` 或 `{m,}`），
 * 且组体内存在「被量化的原子」或「被量化的嵌套分组」。
 * 典型命中：`(a+)+`、`(a*)*`、`(?:[ab]+)+`、`(abc?)+`（保守命中）。
 * 典型不命中：`(ab)+`、`(\d+)-(\d+)`（组未被量词修饰）、`(ab|cd)+`（组内无量化原子）。
 *
 * 局限（已知，后续可加强）：`(a|aa)+`、`(a|ab)+` 这类「组内重叠备选 + 组被无界量词」
 * 也属灾难性，但组内无量化原子，当前启发式不会命中 —— 汇报中列为遗留。
 *
 * @param {string} pattern 正则模式（不含首尾斜杠的纯 pattern）
 * @returns {boolean}
 */
export function isRedosRisky(pattern) {
    if (typeof pattern !== 'string' || pattern.length === 0) return false;
    return scanRegion(pattern, 0).risky;
}

function isQuantifierStart(c) {
    return c === '*' || c === '+' || c === '?' || c === '{';
}

/** 跳过量词（含 {m} / {m,n} / {m,}），返回新的下标。 */
function skipQuantifier(s, i) {
    const c = s[i];
    if (c === '*' || c === '+' || c === '?') return i + 1;
    if (c === '{') {
        let j = i + 1;
        const n = s.length;
        while (j < n && s[j] >= '0' && s[j] <= '9') j++;
        if (j < n && s[j] === '}') return j + 1;
        if (j < n && s[j] === ',') {
            j++;
            while (j < n && s[j] >= '0' && s[j] <= '9') j++;
            if (j < n && s[j] === '}') return j + 1;
        }
    }
    return i + 1;
}

/** 读取量词，返回 { unbounded, end }；非量词返回 null。 */
function readQuantifier(s, i) {
    const c = s[i];
    if (c === '*' || c === '+') return { unbounded: true, end: i + 1 };
    if (c === '?') return { unbounded: false, end: i + 1 };
    if (c === '{') {
        const n = s.length;
        let j = i + 1;
        while (j < n && s[j] >= '0' && s[j] <= '9') j++;
        if (j < n && s[j] === '}') return { unbounded: false, end: j + 1 };
        if (j < n && s[j] === ',') {
            j++;
            const before = j;
            while (j < n && s[j] >= '0' && s[j] <= '9') j++;
            if (j < n && s[j] === '}') return { unbounded: j === before, end: j + 1 };
        }
    }
    return null;
}

/** 跳过字符类 [...]（含内部转义），返回新下标。 */
function skipCharClass(s, i) {
    const n = s.length;
    let j = i + 1;
    while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === ']') { j++; break; }
        j++;
    }
    return j;
}

/**
 * 扫描一段模式文本（递归），返回：
 *   quantToken —— 段内存在「被量化的原子」或「被量化的分组」；
 *   risky      —— 段内存在「嵌套量词」风险分组。
 */
function scanRegion(s, start) {
    let i = start;
    let quantToken = false;
    let risky = false;
    const n = s.length;
    while (i < n) {
        const c = s[i];
        if (c === '\\') {
            i += 2;
            if (i < n && isQuantifierStart(s[i])) { quantToken = true; i = skipQuantifier(s, i); }
            continue;
        }
        if (c === '[') {
            i = skipCharClass(s, i);
            if (i < n && isQuantifierStart(s[i])) { quantToken = true; i = skipQuantifier(s, i); }
            continue;
        }
        if (c === '(') {
            const g = scanGroupAt(s, i);
            i = g.end;
            if (g.quantified) quantToken = true;
            if (g.risky) risky = true;
            continue;
        }
        if (c === '^' || c === '$' || c === '|') {
            i++;
            continue;
        }
        // 字面量原子
        i++;
        if (i < n && isQuantifierStart(s[i])) { quantToken = true; i = skipQuantifier(s, i); }
    }
    return { quantToken, risky };
}

/**
 * 扫描以 s[i] === '(' 开头的一个分组；返回 { end, quantified, risky }。
 * quantified —— 该分组其后有无界/有界量词；
 * risky —— 该分组「被无界量词修饰」且「组内含量化原子」。
 */
function scanGroupAt(s, i) {
    const n = s.length;
    let depth = 1;
    let j = i + 1;
    while (j < n && depth > 0) {
        const c = s[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') { j = skipCharClass(s, j); continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        j++;
    }
    if (depth !== 0) {
        // 未闭合 —— 当作普通文本
        return { end: n, quantified: false, risky: false };
    }
    const close = j - 1;
    const body = s.slice(i + 1, close);
    const bodyInfo = scanRegion(body, 0);
    let quantified = false;
    let unbounded = false;
    let qEnd = close + 1;
    if (qEnd < n && isQuantifierStart(s[qEnd])) {
        const q = readQuantifier(s, qEnd);
        qEnd = q.end;
        quantified = true;
        unbounded = q.unbounded;
    }
    const risky = quantified && unbounded && bodyInfo.quantToken;
    return { end: qEnd, quantified, risky };
}

/**
 * 预算中断哨兵异常：保护替换（transformUnprotectedText 多片段）内部任一片段
 * 中途超时时抛出，withBudget 捕获并统一按 'interrupted' 处理。
 */
export class BudgetInterrupted extends Error {
    constructor() {
        super('Budget exceeded: interrupted');
        this.name = 'BudgetInterrupted';
    }
}

/**
 * ECMAScript AdvanceStringIndex（RegExpBuiltinExec / String.prototype.replace 的零宽推进语义）。
 *
 * 返回从 index 起推进一个 code point 边界后的位置：isUnicode=false 时恒为 index+1；
 * isUnicode=true 且 index 处是 surrogate pair 高位（后随低位）时返回 index+2（跳过整个对），否则 index+1。
 * String.replace 在每次零宽匹配后用它推进 searchValue.[[LastIndex]]，从而不丢字符地跳过当前匹配点。
 */
function advanceStringIndex(S, index, isUnicode) {
    if (!isUnicode) return index + 1;
    const first = S.charCodeAt(index);
    if (first < 0xd800 || first > 0xdbff) return index + 1;
    const second = S.charCodeAt(index + 1);
    if (second < 0xdc00 || second > 0xdfff) return index + 1;
    return index + 2;
}

/**
 * 可中断的全局替换。
 *
 * 语义等价 `String.prototype.replace(regex, replacer)`（仅全局/粘性；非全局退化为单次匹配），
 * 但每个匹配之间检查预算时钟；超时返回 { done:false }，调用方应丢弃结果（文本保持不变）。
 *
 * 注意：单次 exec() 匹配自身可能仍阻塞（如 `(a+)+$`）—— 这正是 isRedosRisky 预检的职责；
 * 本函数负责「多匹配慢脚本」与「单脚本多匹配累计超预算」的掐断。
 *
 * @param {string} text 输入文本
 * @param {RegExp} regex 已编译正则（可 global/sticky）
 * @param {(args: any[]) => string} replacer 替换回调，参数形状与 String.replace 一致
 * @param {number} budgetMs 预算毫秒数
 * @param {number} [startTime] 共享起点（保护替换多片段时传入同一起点）
 * @returns {{ done: true, text: string } | { done: false }}
 */
export function runInterruptibleReplace(text, regex, replacer, budgetMs, startTime) {
    const start = startTime ?? now();
    if (!regex.global && !regex.sticky) {
        // 单次匹配路径（与 String.replace 非全局语义一致）
        regex.lastIndex = 0;
        const m = regex.exec(text);
        if (!m) return { done: true, text };
        const replacement = String(replacer(buildArgs(m)));
        return {
            done: true,
            text: text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length),
        };
    }

    let out = '';
    let lastIndex = 0;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
        // 每个匹配检查一次预算时钟（now() 开销可忽略，保证多匹配慢脚本在预算附近被掐断）
        if (now() - start > budgetMs) {
            return { done: false };
        }
        if (m[0].length === 0) {
            // 零宽匹配（match[0] === ''）：匹配结束位置 = m.index（零宽不消耗字符）。
            // 输出游标停在匹配结束位置（旧实现无条件 +1 会跳过并丢失一个字符）；
            // 搜索游标按 AdvanceStringIndex 语义推进（isUnicode 且该处为 surrogate pair
            // 高位时跳 2，否则跳 1），与 String.prototype.replace 的零宽推进完全一致，不丢字符。
            out += text.slice(lastIndex, m.index) + String(replacer(buildArgs(m)));
            lastIndex = m.index;
            regex.lastIndex = advanceStringIndex(text, m.index, regex.unicode || regex.unicodeSets);
            continue;
        }
        const replacement = String(replacer(buildArgs(m)));
        out += text.slice(lastIndex, m.index) + replacement;
        lastIndex = regex.lastIndex;
    }
    out += text.slice(lastIndex);
    regex.lastIndex = 0;
    return { done: true, text: out };
}

/** 构造与 String.replace 回调一致的参数数组 [match, g1..gn, offset, string, groups]。 */
function buildArgs(m) {
    const args = [m[0]];
    for (let i = 1; i < m.length; i++) args.push(m[i]);
    args.push(m.index, m.input, m.groups);
    return args;
}

/**
 * 超时/预检告警节流（O7，审查报告 P7）：每脚本键 60s 内只打一次 console.warn，
 * 避免慢脚本/被拦截脚本在长聊天每次渲染刷屏（原版无预算故无此噪音）。
 */
const warnThrottle = new Map();
const WARN_THROTTLE_MS = 60 * 1000;

const warn = typeof console !== 'undefined' ? (msg) => console.warn(msg) : () => {};

function throttledWarn(key, msg) {
    const nowTs = Date.now();
    const last = warnThrottle.get(key);
    if (last !== undefined && nowTs - last < WARN_THROTTLE_MS) return;
    warnThrottle.set(key, nowTs);
    warn(msg);
}

/**
 * 执行带预算的脚本替换。
 *
 * 流程：
 *   1. ReDoS 预检：pattern 命中风险形态 → 直接跳过（timedOut, reason='redos-precheck'）。
 *   2. 可中断替换：runInterruptibleReplace；中途超时 → 跳过（reason='interrupted'）。
 *   3. 事后计时：完成但耗时 > budgetMs → 跳过（reason='budget-exceeded'），并记录实际耗时。
 *
 * @param {object} opts
 * @param {string} opts.scriptName 脚本名（记录/告警用）
 * @param {string} opts.pattern   最终 pattern（substituteRegex 宏替换后的最终形态）
 * @param {string} opts.flags     最终 flags
 * @param {(pattern: string, flags: string, interruptible: boolean) => { text: string }|{ done: boolean, text?: string }}
 *   opts.run 执行函数；interruptible=true 时它内部应使用 runInterruptibleReplace。
 * @param {number} [opts.budgetMs=50] 预算毫秒数
 * @param {(entry: object) => void} [opts.record] 超时记录回调（applied[] 追加）
 * @param {boolean} [opts.precheckEnabled=true] ReDoS 静态预检总开关（设置 rp_hub_precheck_enabled）
 * @param {string[]} [opts.precheckBypassKeys=[]] 预检绕过脚本键表（设置 rp_hub_precheck_bypass；
 *   键 = script.id || scriptName）—— 命中的脚本跳过预检直接放行
 * @param {string} [opts.scriptKey] 当前脚本键（script.id || scriptName，绕过匹配用）
 * @returns {{ timedOut: boolean, reason: string|null, elapsedMs: number, text?: string }}
 */
export function withBudget({ scriptName, pattern, flags, run, budgetMs = 50, record, precheckEnabled = true, precheckBypassKeys = [], scriptKey }) {
    const warnKey = scriptKey || scriptName || '?';

    // 防线 1：ReDoS 静态预检（可配置化，ReDoS 预检 + 诊断弹窗）——
    // 总开关关闭（precheckEnabled=false）或该脚本键在绕过表（precheckBypassKeys 含 scriptKey）
    // 时放行（被预检误伤的正则得以执行）；否则嵌套量词形态被拦截，根本不会执行。
    const bypassed = Array.isArray(precheckBypassKeys) && precheckBypassKeys.includes(scriptKey);
    if (precheckEnabled && !bypassed && isRedosRisky(pattern)) {
        const entry = { scriptName, timedOut: true, reason: 'redos-precheck', elapsedMs: 0 };
        if (record) record(entry);
        throttledWarn(warnKey, `[rp-hub-compat] 正则「${scriptName}」被 ReDoS 预检拦截（嵌套量词），已跳过。`);
        return { timedOut: true, reason: 'redos-precheck', elapsedMs: 0 };
    }

    const start = now();
    let result;
    try {
        // 可中断替换路径（全局/粘性正则）
        result = run(pattern, flags, true);
    } catch (error) {
        if (error instanceof BudgetInterrupted) {
            // 保护替换多片段中途超时
            const elapsed = now() - start;
            const entry = { scriptName, timedOut: true, reason: 'interrupted', elapsedMs: elapsed };
            if (record) record(entry);
            throttledWarn(warnKey, `[rp-hub-compat] 正则「${scriptName}」执行超时（保护替换中途中断），已跳过。`);
            return { timedOut: true, reason: 'interrupted', elapsedMs: elapsed };
        }
        // 其它错误（如编译失败）—— 由解释器层处理（与语义相关），这里向上抛
        throw error;
    }
    const elapsedMs = now() - start;

    if (result && result.done === false) {
        // 防线 2：可中断替换中途超时
        const entry = { scriptName, timedOut: true, reason: 'interrupted', elapsedMs };
        if (record) record(entry);
        throttledWarn(warnKey, `[rp-hub-compat] 正则「${scriptName}」执行超时（${Math.round(elapsedMs)}ms ≥ 预算 ${budgetMs}ms），已中断跳过。`);
        return { timedOut: true, reason: 'interrupted', elapsedMs };
    }

    if (elapsedMs > budgetMs) {
        // 防线 3：事后计时超预算
        const entry = { scriptName, timedOut: true, reason: 'budget-exceeded', elapsedMs };
        if (record) record(entry);
        throttledWarn(warnKey, `[rp-hub-compat] 正则「${scriptName}」耗时 ${Math.round(elapsedMs)}ms 超过预算 ${budgetMs}ms，已跳过该脚本结果。`);
        return { timedOut: true, reason: 'budget-exceeded', elapsedMs };
    }

    const text = typeof result === 'string' ? result : result?.text;
    return { timedOut: false, reason: null, elapsedMs, text };
}
