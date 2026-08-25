// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/runtime.js —— 管道共享运行时（唯一导入 st-bridge 的管道模块）。
 *
 * 职责：
 *   - 组装引擎 runner（注入 ST 原版宏引擎 substituteParams/substituteParamsExtended）
 *   - 模式解析（rp-mode.getFormatDetail，按当前角色）
 *   - 脚本合并（store/scripts.getRegexScripts，三类存储 + allow）
 *   - 深度计算（复刻 script.js messageFormatting 的 depth 推导）
 *   - swipes[] 校正（ST 在 MESSAGE_RECEIVED 后会把 mes=prompt 视角写进 swipes，
 *     导致浏览 swipe 时把 prompt 视角当原始文本 —— 这里把 swipes 校正回原始文本）
 */

import { engine } from '../engine/engine.js';
import { getRegexScripts } from '../store/scripts.js';
import { getFormatDetail } from '../store/rp-mode.js';
import { isCleanPromptEnabled, isProtectEnabled, getProtectItems as readProtectItems, getDegradeTarget, getBudgetMs as readBudgetMs, isPrecheckEnabled, getPrecheckBypass, isAutoProtectScriptEnabled, isExcludeFirstMessageEnabled, isExcludeFirstFulltextOnly, getRenderMode as readRenderMode, getPassRules as readPassRules, getCleanRules as readCleanRules, getSecondPassFilter as readSecondPassFilter, isSecondPassEnabled as readSecondPassEnabled, isSkipBlankSegments as readSkipBlankSegments, getStreamMatch } from '../store/settings.js';
import {
    chat,
    characters,
    this_chid,
    chatElement,
    extension_settings,
    saveChatConditional,
    messageFormatting,
    substituteParams,
    substituteParamsExtended,
} from '../st-bridge.js';

/* ---------- 排除模式转译（语义 A，《流式排除模式可行性报告》） ---------- */

/** 正则元字符转义：字面标签串（如 `<状态栏>`）→ 正则安全形态。 */
function escapeRegExpLiteral(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 rp_hub_stream_match 的规则转译为附加 cleanRules（route==='exclude' 时非空）：
 * 每条规则 → { pattern, replaceEnabled:false, replace:null } —— 经引擎 maskUISegments
 * 藏走占位符（阶段②脚本不可见 ＝ 不进 RP 引擎），restoreCleanSegments 对
 * replaceEnabled=false 的段【原样拼回】（＝交酒馆原生通道）。
 * 形态：start+end → `start[\s\S]*?end`（惰性，多次出现各自命中）；
 *       仅 start   → `start[\s\S]*$`（贪婪到楼尾）；
 *       仅 end     → `^[\s\S]*?end`（开头到首个闭合）；
 *       advanced rx → pattern 原样使用（裸正则，不含 /…/ 定界符）。
 * 顺序约定：派生规则置于用户 cleanRules 【之前】拼接 —— maskUISegments 的 alternation
 * 最左优先 + testers 锚定归属首条命中，用户显式的排除意图优先于壳剥离类内置规则；
 * 与内置清洗规则文本重叠时以先匹配为准（文档化行为）。
 * @param {object|null} streamMatch getStreamMatch() 归一产物
 * @returns {Array<{ pattern: string, replaceEnabled: boolean, replace: null }>}
 */
function buildExcludeCleanRules(streamMatch) {
    if (!streamMatch || streamMatch.route !== 'exclude') return [];
    const out = [];
    const push = (pattern) => {
        const p = String(pattern ?? '').trim();
        if (p) out.push({ pattern: p, replaceEnabled: false, replace: null });
    };
    for (const r of Array.isArray(streamMatch.rules) ? streamMatch.rules : []) {
        const s = r.start ? escapeRegExpLiteral(r.start) : '';
        const e = r.end ? escapeRegExpLiteral(r.end) : '';
        if (s && e) push(`${s}[\\s\\S]*?${e}`);
        else if (s) push(`${s}[\\s\\S]*$`);
        else if (e) push(`^[\\s\\S]*?${e}`);
    }
    for (const x of Array.isArray(streamMatch.rx) ? streamMatch.rx : []) {
        if (x && typeof x.pattern === 'string') push(x.pattern);
    }
    return out;
}

export const runtime = {
    active: false,

    /** ST 原版宏引擎注入（用户已确认 100% 一致）。 */
    macros: { substituteParams, substituteParamsExtended },

    chat,
    characters,
    this_chid,
    chatElement,
    saveChatConditional,
    messageFormatting,

    /** 当前角色 → 后端 formatDetail → rphub/st（带缓存 + 按配置降级目标降级）。 */
    async getMode() {
        const ch = characters?.[this_chid];
        const info = await getFormatDetail({ avatar: ch?.avatar, name: ch?.name, degradeTarget: getDegradeTarget() });
        return info.formatDetail;
    },

    /** 合并三类脚本。mode=null（判定失败/禁止降级）按 st 行为。 */
    getScripts(mode) {
        return getRegexScripts({ allowedOnly: true, mode: mode === null ? 'st' : mode });
    },

    /**
     * 原版 Regex 扩展是否仍在运行（未在 extension_settings.disabledExtensions 里）。
     * 用于 st 卡显示/prompt 接管门控：
     *   - 原版在跑 → st 卡让 ST 原生 getRegexedString/messageFormatting 处理（避免双重应用）；
     *   - 原版关闭（README 要求的安装方式）→ st 卡走本引擎 legacy 补位（原版等价渲染）。
     * rphub 卡不受此门控（永远走本引擎 RP 渲染）。
     */
    nativeRegexRunning() {
        return Array.isArray(extension_settings?.disabledExtensions)
            && !extension_settings.disabledExtensions.includes('regex');
    },

    /** cleanPrompt 开关读取（C2，默认 true = 对整段 prompt 施加引擎剥离；false = prompt 原样）。 */
    getCleanPrompt() {
        return isCleanPromptEnabled();
    },

    /** 保护替换总开关读取（默认 true = 启用，仅 rphub 模式生效）。 */
    getProtectEnabled() {
        return isProtectEnabled();
    },

    /** 保护项勾选读取（默认全部 = 默认全开）。 */
    getProtectItems() {
        return readProtectItems();
    },

    /** 超时预算读取（默认 50ms，范围 1-5000，非法回退默认；每条正则执行预算）。 */
    getBudgetMs() {
        return readBudgetMs();
    },

    /** ReDoS 静态预检总开关读取（默认 true = 启用；false = 关闭预检，被误伤正则放行）。 */
    getPrecheckEnabled() {
        return isPrecheckEnabled();
    },

    /** ReDoS 预检绕过键表读取（默认 []；键 = script.id || scriptName）。 */
    getPrecheckBypass() {
        return getPrecheckBypass();
    },

    /** 引擎级自动脚本区保护总开关读取（默认 true = 启用；仅 legacy 渲染模式生效）。 */
    getAutoProtectScript() {
        return isAutoProtectScriptEnabled();
    },

    /** 「排除第0楼」总开关读取（默认 true = 启用）。 */
    getExcludeFirstMessage() {
        return isExcludeFirstMessageEnabled();
    },

    /** 「排除第0楼」精细/暴力档位读取（默认 true = 只跳过全文负前瞻正则）。 */
    getExcludeFirstFulltextOnly() {
        return isExcludeFirstFulltextOnly();
    },

    /** 渲染模式读取（默认 'two_pass_121' = 1→2→1 两阶段管线；'legacy' = 现状顺序混跑）。 */
    getRenderMode() {
        return readRenderMode();
    },

    /** 渲染遍次过滤规则读取（默认 { first:[preset include], second:[preset include] }）。 */
    getPassRules() {
        return readPassRules();
    },

    /** 清洗规则读取（默认 [围栏, html, doctype, script, 裸围栏, content]；空数组 = 阶段②不藏任何）。 */
    getCleanRules() {
        return readCleanRules();
    },

    /** 第二次预设过滤读取（默认 mode='all' = 全部预设第二遍跑一遍）。 */
    getSecondPassFilter() {
        return readSecondPassFilter();
    },

    /** 阶段③（预设第二遍）总开关读取（默认 false = 关闭，预设只跑一次阶段①）。 */
    getSecondPassEnabled() {
        return readSecondPassEnabled();
    },

    /** 空白段守卫读取（默认 true = 开启：纯空白段跳过不执行，防「整段匹配型」正则包空卡片）。 */
    getSkipBlankSegments() {
        return readSkipBlankSegments();
    },

    /**
     * 影响引擎输出的设置指纹（O2，审查报告 P2）：渲染模式/清洗规则/遍次规则/第二遍开关/
     * 空白段守卫/预算/预检/自动保护/保护替换/cleanPrompt 任一变化 → 指纹变化 → 显示缓存失效。
     * 供 display.js 传给 recomputeDisplay/processMessageView 的 settingsFp。
     * @returns {string}
     */
    getSettingsFp() {
        try {
            const p = readPassRules();
            const c = readCleanRules();
            const f = readSecondPassFilter();
            return [
                readRenderMode(),
                readSecondPassEnabled(),
                readSkipBlankSegments(),
                readBudgetMs(),
                isPrecheckEnabled(),
                // 🔴-2 修复：预检绕过键表必须参与指纹——否则点「绕过」后脚本虽放行执行，
                // 但 settingsFp 不变 → buildDisplayFingerprint 不变 → rph_display_fp 命中 → 显示缓存永不失效。
                // sort 防 fp 抖动（键表顺序不应影响指纹稳定性，见 R2）。
                getPrecheckBypass().sort().join(','),
                isAutoProtectScriptEnabled(),
                isExcludeFirstMessageEnabled(),
                isExcludeFirstFulltextOnly(),
                isProtectEnabled(),
                readProtectItems().join(','),
                isCleanPromptEnabled(),
                JSON.stringify(p),
                JSON.stringify(c),
                JSON.stringify(f),
                // 排除模式纳管（必改项，防切换后旧缓存假失效）：include 态摘要恒定（改流式
                // 标签不影响正式链路输出、不无谓失效缓存）；exclude 态携带转译产物摘要——
                // 规则变 → 指纹变 → rph_display 缓存正确失效重算。
                (() => {
                    const sm = getStreamMatch();
                    return sm.route === 'exclude'
                        ? 'exclude|' + JSON.stringify(buildExcludeCleanRules(sm))
                        : 'include';
                })(),
            ].join('|');
        } catch {
            return 'err';
        }
    },

    /** 引擎 runner：固定注入 ST 宏引擎 + 保护替换设置（总开关/勾选项）+ ReDoS 预检设置 + 超时预算 + 自动脚本区保护 + 渲染模式 + 遍次过滤规则 + 清洗规则 + 第二次预设过滤 + 阶段③总开关。 */
    engineRun(args) {
        return engine.run({
            ...args,
            macros: runtime.macros,
            budgetMs: runtime.getBudgetMs(),
            options: {
                ...(args.options || {}),
                protectEnabled: runtime.getProtectEnabled(),
                protectItems: runtime.getProtectItems(),
                precheckEnabled: runtime.getPrecheckEnabled(),
                precheckBypassKeys: runtime.getPrecheckBypass(),
                autoProtectScript: runtime.getAutoProtectScript(),
                excludeFirstMessage: runtime.getExcludeFirstMessage(),
                excludeFirstMessageFulltextOnly: runtime.getExcludeFirstFulltextOnly(),
                renderMode: runtime.getRenderMode(),
                passRules: runtime.getPassRules(),
                // 排除模式（语义 A）：派生规则置于用户 cleanRules 之前 —— alternation 最左
                // 优先，用户显式排除意图优先于壳剥离类内置/自定义清洗规则；include 态为空数组。
                cleanRules: [...buildExcludeCleanRules(getStreamMatch()), ...runtime.getCleanRules()],
                secondPassFilter: runtime.getSecondPassFilter(),
                secondPassEnabled: runtime.getSecondPassEnabled(),
                skipBlankSegments: runtime.getSkipBlankSegments(),
            },
        });
    },

    /**
     * 只对给定文本跑当前卡的 scoped 正则（路线 B 开场白桥，供第三部调用）。
     * 强制 legacy 串行（不走 1→2→1 界面段藏走，避免把 ═══状态═══ 当界面段藏走）；
     * 预设/全局不参与（rp_source==='scoped' 过滤）。不传 isFirstMessage → 引擎
     * 「排除第0楼」过滤不触发（该过滤要求 isFirstMessage===true），scoped 照常执行。
     * @param {string} text 正文段（已切掉预置 UI 面板）
     * @param {{ mode?: string, role?: number|null }} [opts]
     * @returns {string} 渲染后的正文（缺省/无脚本/非字符串 → 原样）
     */
    runScoped(text, { mode = 'rphub', role = 2 } = {}) {
        if (typeof text !== 'string') return text;
        const scripts = runtime.getScripts(mode).filter((s) => s && s.rp_source === 'scoped');
        if (!scripts.length) return text;
        const result = engine.run({
            text,
            scripts,
            mode,
            isDisplay: true,
            role,
            macros: runtime.macros,
            budgetMs: runtime.getBudgetMs(),
            options: {
                protectEnabled: runtime.getProtectEnabled(),
                protectItems: runtime.getProtectItems(),
                precheckEnabled: runtime.getPrecheckEnabled(),
                precheckBypassKeys: runtime.getPrecheckBypass(),
                autoProtectScript: runtime.getAutoProtectScript(),
                renderMode: 'legacy', // 串行，不走 1→2→1
            },
        });
        return typeof result?.text === 'string' ? result.text : text;
    },

    /** 深度计算（复刻 script.js:1804-1806）。 */
    computeDepth(messageId) {
        const usable = runtime.chat
            .map((x, index) => ({ message: x, index }))
            .filter((x) => !x.message.is_system);
        const indexOf = usable.findIndex((x) => x.index === Number(messageId));
        return messageId >= 0 && indexOf !== -1 ? usable.length - indexOf - 1 : undefined;
    },

    /** 是否第 0 楼（开场白 = 首条非系统消息）。与 computeDepth 同一过滤口径（剔除 is_system）。 */
    isFirstMessage(messageId) {
        const usable = runtime.chat
            .map((x, index) => ({ message: x, index }))
            .filter((x) => !x.message.is_system);
        return usable.length > 0 && usable[0].index === Number(messageId);
    },

    /**
     * 保持 swipes[] = 原始文本。
     * ST saveReply 在 MESSAGE_RECEIVED 之后执行 `item.swipes[swipeId] = item.mes`
     * （此时 mes 已被我们写成 prompt 视角）→ 延时再校正一次，确保浏览 swipe 时
     * 拿到的是原始文本（而不是 prompt 视角）。
     */
    fixSwipes(messageId, msg, raw) {
        if (typeof msg?.swipe_id !== 'number' || !Array.isArray(msg.swipes)) return;
        msg.swipes[msg.swipe_id] = raw;
        setTimeout(() => {
            if (msg.extra?.rph_raw_mes === raw && typeof msg.swipe_id === 'number' && Array.isArray(msg.swipes)) {
                msg.swipes[msg.swipe_id] = raw;
            }
        }, 0);
    },
};
