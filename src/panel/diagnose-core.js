// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * panel/diagnose-core.js —— 正则诊断弹窗纯逻辑核心（可 node 离线测试）。
 *
 * 背景（ReDoS 预检 + 正则诊断弹窗）：
 *   绝区零卡「状态栏」正则（`(?:\|[^=|]+=[^|]*)*` 形态）被 isRedosRisky 静态预检
 *   误伤 → reason:'redos-precheck' 静默跳过 → 状态面板不渲染。预检是无条件硬门
 *   （budget.js 防线 1），用户无手段放行。本模块提供：
 *     - scriptKeyOf(script)：脚本键 = script.id || script.scriptName（预检绕过匹配键）
 *     - analyzeScripts(...)：逐脚本分析 → { key, name, compile, precheck, exec }
 *
 * 层序（对齐引擎真实行为，budget.js:284-332）：
 *   编译（new RegExp 提取 pattern/flags）→ 预检（risky && enabled && !bypassed =
 *   blocked）→ 执行（blocked 时标记 blocked 不执行；否则经 engineRun 跑真实引擎，
 *   反映 redos-precheck / interrupted / budget-exceeded / 正常替换 / 编译错误）。
 *
 * 本模块纯函数：isRedosRisky 从 budget.js 导入，engineRun 由调用方注入（node 测试
 * 注入 fake，浏览器用 runtime.engineRun / engine.run）。
 */

import { isRedosRisky } from '../engine/budget.js';

/**
 * 脚本键（预检绕过匹配键）：script.id || script.scriptName。
 * 与预算链路（budget.js withBudget 的 scriptKey 参数）保持一致：
 *   st.js: scriptKey = script.id || script.scriptName
 *   rphub.js: scriptKey = script.id || script.scriptName || script.name
 * @param {object|null|undefined} script
 * @returns {string|null} 无 id / scriptName 时为 null
 */
export function scriptKeyOf(script) {
    if (!script || typeof script !== 'object') return null;
    const key = script.id ?? script.scriptName ?? script.name;
    return typeof key === 'string' && key.trim() ? key : null;
}

/**
 * 提取脚本的最终 pattern/flags（诊断编译用；对齐 rphub.js extractRphubFields 的
 * /pattern/flags 字面量解析，不做 substituteRegex 宏替换 —— 诊断以原始模式为准）。
 * @param {object} script
 * @param {'st'|'rphub'} [mode] 字段语义（rphub: regex/findRegex + flags/regexFlags；
 *   st: findRegex + 字面量 flags）
 * @returns {{ pattern: string|null, flags: string }}
 */
export function extractPatternFields(script, mode = 'st') {
    if (!script || typeof script !== 'object') return { pattern: null, flags: '' };
    if (mode === 'rphub') {
        let regexPattern = script.regex || script.findRegex;
        let flags = script.flags || script.regexFlags || 'g';
        if (!regexPattern) return { pattern: null, flags };
        if (typeof regexPattern === 'string' && regexPattern.startsWith('/') && regexPattern.lastIndexOf('/') > 0) {
            const lastSlash = regexPattern.lastIndexOf('/');
            const potentialFlags = regexPattern.substring(lastSlash + 1);
            if (/^[gimsuy]*$/.test(potentialFlags)) {
                flags = potentialFlags;
                regexPattern = regexPattern.substring(1, lastSlash);
            }
        }
        return { pattern: String(regexPattern), flags };
    }
    const findRegex = script.findRegex;
    if (!findRegex || typeof findRegex !== 'string') return { pattern: null, flags: '' };
    if (findRegex.startsWith('/') && findRegex.lastIndexOf('/') > 0) {
        const lastSlash = findRegex.lastIndexOf('/');
        const potentialFlags = findRegex.substring(lastSlash + 1);
        if (/^[gimsuy]*$/.test(potentialFlags)) {
            return { pattern: findRegex.substring(1, lastSlash), flags: potentialFlags };
        }
    }
    return { pattern: findRegex, flags: '' };
}

/**
 * 逐脚本诊断分析（纯函数，node 可测）。
 * @param {object} args
 * @param {object[]} args.scripts 待分析脚本列表
 * @param {string} args.text 测试文本（缺省回填当前聊天最后一条 AI 回复 mes）
 * @param {'st'|'rphub'} [args.mode='st'] 卡语义模式（字段提取按分层解释器逐脚本判定）
 * @param {number} [args.placement=2] st 模式 placement（缺省 2 = AI 输出）
 * @param {number} [args.depth] st/rphub 深度（undefined = 不深度过滤）
 * @param {Function} [args.engineRun] 真实引擎 runner（缺省 null = 不执行，仅编译+预检）
 * @param {boolean} [args.precheckEnabled=true] ReDoS 预检总开关
 * @param {string[]} [args.bypassKeys=[]] 预检绕过键表（脚本键）
 * @returns {Array<{ key: string|null, name: string,
 *   compile: { ok: boolean, error: string|null },
 *   precheck: { risky: boolean, bypassed: boolean, blocked: boolean },
 *   exec: { timedOut: boolean, reason: string|null, elapsedMs: number, changed: boolean, error: string|null } }>}
 */
export function analyzeScripts({ scripts = [], text = '', mode = 'st', placement = 2, depth, engineRun = null, precheckEnabled = true, bypassKeys = [] } = {}) {
    const results = [];
    for (const script of scripts) {
        if (!script || typeof script !== 'object') continue;
        const key = scriptKeyOf(script);
        const name = script.scriptName || script.name || key || '(未命名脚本)';
        // 分层解释器（修复 1）：preset/global 永远按 st 字段；仅 RP 卡 scoped 按 rphub 字段
        const scriptMode = mode === 'rphub' && script.rp_source === 'scoped' ? 'rphub' : 'st';

        // 层 1：编译（new RegExp）
        const { pattern, flags } = extractPatternFields(script, scriptMode);
        let compile = { ok: false, error: null };
        if (pattern === null || pattern === '') {
            compile = { ok: false, error: '无匹配模式（findRegex/regex 为空）' };
        } else {
            try {
                new RegExp(pattern, flags);
                compile = { ok: true, error: null };
            } catch (e) {
                compile = { ok: false, error: String(e?.message || e) };
            }
        }

        // 层 2：预检（risky && enabled && !bypassed = blocked）
        const risky = pattern !== null && isRedosRisky(pattern);
        const bypassed = Array.isArray(bypassKeys) && key !== null && bypassKeys.includes(key);
        const blocked = compile.ok && precheckEnabled && risky && !bypassed;

        // 层 3：执行（blocked 时标记 blocked 不执行；否则经真实引擎 —— 引擎内部按 rp_source
        // 分层解释，runArgs.mode 透传卡模式）
        let exec = { timedOut: false, reason: null, elapsedMs: 0, changed: false, error: null };
        if (compile.ok && !blocked && typeof engineRun === 'function') {
            const runArgs = scriptMode === 'rphub'
                ? { text, scripts: [script], mode, isDisplay: true, role: 2, depth }
                : { text, scripts: [script], mode, isDisplay: true, placement, depth };
            try {
                const result = engineRun({
                    ...runArgs,
                    options: { precheckEnabled, precheckBypassKeys: bypassKeys },
                });
                const applied = Array.isArray(result?.applied) ? result.applied[0] : null;
                exec = {
                    timedOut: applied?.timedOut === true,
                    reason: applied?.reason ?? null,
                    elapsedMs: applied?.elapsedMs ?? 0,
                    changed: result?.text !== text,
                    error: applied?.error ?? null,
                };
            } catch (e) {
                exec.error = String(e?.message || e);
            }
        }

        results.push({ key, name, compile, precheck: { risky, bypassed, blocked }, exec });
    }
    return results;
}
