// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/force-render.js —— 强制重新渲染 + 聊天打开自动覆盖（全局入口 window.__rphubCompat__）。
 *
 * 解决问题（换浏览器/刷新后正常、但缓存导致界面未围栏化/未渲染）：
 *   后端手动标记（marks）变化后，前端 getFormatDetail 有 30 分钟内存缓存
 *   （rp-mode.js CACHE_TTL_MS）—— 前端仍按旧 mode 处理 → 围栏化（仅 rphub）不生效
 *   → 界面 HTML 落入 ST 渲染被清洗（custom- 前缀 / p 残留 / 按钮点不动）。
 *   换浏览器 = 清缓存 → 正常。本模块提供两个入口：
 *
 *   clearModeCache()  → 清 formatDetail 内存缓存，下一次 runtime.getMode() 重新请求后端。
 *   forceRerenderAll() → 遍历当前聊天全部消息（跳过 is_system），逐条
 *     processAndCover(messageId, { force: true })：重算显示（走围栏化判定，仅 rphub
 *     时把完整 HTML 包 ```html 围栏）+ fixSwipes + coverMessage(forceApply) 覆盖 DOM。
 *     手动入口（第三部「强制重新渲染」按钮）—— 清缓存 + 全量重算。
 *   autoCoverCurrentChat() → 打开已有聊天 / reloadCurrentChat 时自动调用（CHAT_LOADED）：
 *     不重算、不清缓存（缓存由 index.js 的 CHAT_CHANGED 失效），只把已处理消息的
 *     围栏结果显示到 DOM（修复 4 dom-not-engine 强制覆盖），未处理消息走完整双通道。
 *   mountCompatApi()  → 挂 window.__rphubCompat__（已存在则合并不覆盖）。
 *
 * 后台执行：逐条 await（processAndCover 内部含网络/异步边界），消息间累计 ≥16ms
 *   或每 20 条用 setTimeout(0) 让出一帧 —— 长聊天逐条重算不卡 UI。
 */

import { runtime } from './runtime.js';
import { clearModeCache as clearStoreModeCache } from '../store/rp-mode.js';
import { coverMessage, processAndCover } from './display.js';
import { hasUnwrappedFrontendPre } from './pure.js';
import { event_types, eventSource } from '../st-bridge.js';
export const GLOBAL_KEY = '__rphubCompat__';

/** 让出主线程一帧（合作式调度，后台执行不卡 UI）。 */
function yieldToMainThread() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 解析当前聊天数组（messageId = 数组下标，与 runtime.chat / processAndCover 的索引一致）。
 * 优先 window.SillyTavern.chat（第三部 iframe 桥注入的 live 引用）；降级
 * SillyTavern.getContext().chat；最后 runtime.chat（st-bridge 导入的 ST chat live 引用）。
 * 三者最终指向同一数组，索引一致。
 */
function getChatArray() {
    try {
        const g = globalThis;
        if (Array.isArray(g?.SillyTavern?.chat)) return g.SillyTavern.chat;
        const ctx = typeof g?.SillyTavern?.getContext === 'function' ? g.SillyTavern.getContext() : null;
        if (ctx && Array.isArray(ctx.chat)) return ctx.chat;
    } catch {
        // 忽略：SillyTavern 全局解析失败时走 runtime.chat
    }
    return runtime.chat;
}

/**
 * 清空 formatDetail 内存缓存（rp-mode.js CACHE_TTL_MS = 30 分钟）。
 * 下一次 getMode() 重新请求后端 by-name —— 手动标记 / formatDetail 的最新值立即生效。
 */
export function clearModeCache() {
    clearStoreModeCache();
}

/**
 * 预设变动 → 强制重渲染（用户定稿：监听预设变动强制执行一遍渲染）。
 *
 * 背景（与第三方兼容优先）：样式/模板切换后若只依赖 RENDERED 事件，模板消息（第三部渲染服务
 * 接管 display_text）会因「第三部 eventMakeFirst 先于第二部重算、用旧 rph_display 判跳过」而
 * 显示仍旧样式 → 需手动点第三部「强制重新渲染」。本函数把手动按钮的行为自动化：
 *   ① 第二部 forceRerenderAll()：清 formatDetail 缓存 + 逐条重算 rph_display + 覆盖非模板 DOM；
 *   ② 模板消息（rph_template_render）补发 RENDERED —— forceRerenderAll 的 coverMessage(forceApply)
 *      对模板消息让位（display_text/DOM 归第三部），补发后第三部渲染服务用**新鲜 rph_display**
 *      重渲染 display_text（正文源变化 → 跳过条件不命中 → 全量重渲染）。
 * 幂等/收敛：重复触发（连续切预设/开关）由去抖合并；模板补发仅对已处理消息，第三部渲染幂等。
 */

/** 预设变动强制重渲染去抖定时器（毫秒；连续切预设/开关合并为一次）。 */
let presetRerenderTimer = null;
const PRESET_RERENDER_DEBOUNCE_MS = 800;

/* ---------- SPreset 正则写入挂钩（切换样式自动重渲染，用户定稿方向） ----------
 * 背景（inject.js 实证）：SPreset（soliumbra 预设内置正则 v2 注入的 regex_bind/inject.js）
 * 切换样式 = `syncToST()` 整体赋值 `ctx.chatCompletionSettings.extensions.regex_scripts =
 * presetRegexes`（inject.js:2000），只改 disabled；而 `updateSTRegexes()` 仅在**全局数组长度**
 * 变化时才 reloadCurrentChat（inject.js:1966）→ 切换 disabled 后**不发射任何 ST 事件**
 * （PRESET_CHANGED / RENDERED / CHAT_LOADED 均无）→ 事件驱动链路休眠 → 只能手动点
 * 「强制重新渲染」。
 * 解法（不硬核）：oai_settings.extensions.regex_scripts 是 preset-manager 读取的正则来源
 * （getPresetList('openai').settings === oai_settings，preset-manager.js:554），用 accessor
 * 挂钩该键赋值 —— SPreset 每次切换必然整体赋值该键 → 触发调度全量重渲染。
 * 兼容：只读不改值（get/set 语义等价原数据属性）；configurable 允许删除/重定义（hook 失效
 * 无害）；触发的是我们自己的重渲染，不干预第三方。玄狐（JSR preset API lodash.set）与
 * 我们的面板保存（writePresetExtensionField）走同一 setter → 一并触发（去抖合并，无害）。
 */
let regexScriptsWriteHooked = false;

/** 挂钩 oai_settings.extensions.regex_scripts 赋值（SPreset 切换样式自动重渲染）。
 * chatCompletionSettings 未就绪时返回 false，调用方应在 APP_READY 后重试。
 * @returns {boolean} 是否挂钩成功
 */
export function hookRegexScriptsWrite() {
    if (regexScriptsWriteHooked) return true;
    try {
        const g = globalThis.SillyTavern;
        const ctx = typeof g?.getContext === 'function' ? g.getContext() : null;
        const ccs = ctx?.chatCompletionSettings;
        if (!ccs || typeof ccs !== 'object') return false;
        const exts = ccs.extensions;
        if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return false;
        let current = exts.regex_scripts;
        try {
            Object.defineProperty(exts, 'regex_scripts', {
                configurable: true,
                enumerable: true,
                get: () => current,
                set: (v) => {
                    current = v;
                    // force-I1 修复：扩展停止（runtime.active=false）后该键再被写不再调度重渲染
                    if (!runtime.active) return;
                    // SPreset 切换样式/玄狐/面板保存 → 调度全量重渲染（去抖，等价手动按钮）
                    scheduleRerenderAfterPresetChange();
                },
            });
        } catch {
            return false; // 不可配置属性（极端）→ 放弃挂钩，事件链路兜底
        }
        regexScriptsWriteHooked = true;
        console.debug('[rp-hub-compat] 已挂钩 oai_settings.extensions.regex_scripts 写入（SPreset 切换样式自动重渲染）。');
        return true;
    } catch {
        return false;
    }
}

/**
 * 调度预设变动强制重渲染（去抖）。由 pipeline/index.js 的 PRESET_CHANGED / MAIN_API_CHANGED
 * 监听与 regex_scripts 写入挂钩调用；stop() 时清除挂起定时器。
 * ⚠️ 不再由 SETTINGS_UPDATED 调用（settings_updated 在任何 saveSettings 都发，含开聊天，
 * 曾导致每次开聊天 iframe 重建 3 次 —— 重复渲染根因，见 pipeline/index.js 注释）。
 */
export function scheduleRerenderAfterPresetChange() {
    if (presetRerenderTimer !== null) return; // 已挂起 → 合并
    presetRerenderTimer = setTimeout(() => {
        presetRerenderTimer = null;
        void rerenderAllAfterPresetChange();
    }, PRESET_RERENDER_DEBOUNCE_MS);
}

/** 清除挂起的预设变动重渲染（stop 时调用，防止扩展停止后仍执行）。 */
export function cancelScheduledPresetRerender() {
    if (presetRerenderTimer !== null) {
        clearTimeout(presetRerenderTimer);
        presetRerenderTimer = null;
    }
}

/** 预设变动全量重渲染：第二部 forceRerenderAll + 全量补发 RENDERED（对齐手动「强制重新渲染」按钮）。
 * 补发 RENDERED 的接收方：
 *   - 第三部渲染服务（eventMakeFirst）：模板消息用新鲜 rph_display 重渲染 display_text；
 *   - 酒馆助手 JSR audit：非模板消息的 ```html 围栏重新 iframe 化（forceRerenderAll 的
 *     coverMessage 只写 DOM，不补建 iframe —— 手动按钮的第三部全量同样负责这步）；
 *   - 本扩展自身幂等：fp 命中 → 缓存直返，coverSkipDecision 一致跳过，不重复写 DOM。 */
async function rerenderAllAfterPresetChange() {
    console.debug('[rp-hub-compat] PRESET_CHANGED/API 切换 → 强制重渲染（第二部全量 + 全量补发 RENDERED）。');
    try {
        await forceRerenderAll();
    } catch (error) {
        console.warn('[rp-hub-compat] 预设变动强制重渲染（第二部）失败：', String(error?.message || error));
    }
    const chat = getChatArray();
    if (!Array.isArray(chat)) return;
    for (let messageId = 0; messageId < chat.length; messageId++) {
        const msg = chat[messageId];
        if (!msg || msg.is_system) continue;
        if (msg.extra?.rph_done !== true) continue;
        try {
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
        } catch { /* 事件不可用忽略（显示降级，下次事件收敛） */ }
    }
}

/**
 * 强制重新渲染全部消息（async，后台执行）：
 *   1. 清 formatDetail 缓存（后端最新判定立即生效）；
 *   2. 遍历当前聊天，跳过 is_system / 无正文消息；
 *   3. 逐条 processAndCover(messageId, { force: true }) —— 重算（走围栏化判定）+
 *      forceApply 覆盖 DOM（含 rph_done 消息，force 忽略去重标记强制重算）。
 * 空聊天直接返回。单条失败不中断整体（console.warn 后继续）。
 * @returns {Promise<{ count: number, skipped: number }>} count=已处理条数，skipped=跳过条数
 */
export async function forceRerenderAll() {
    const chat = getChatArray();
    if (!Array.isArray(chat) || chat.length === 0) {
        console.debug('[rp-hub-compat] forceRerenderAll：当前聊天为空，直接返回。');
        return { count: 0, skipped: 0 };
    }

    // 先清 formatDetail 缓存：后端 marked / formatDetail 变化立即生效（不再等 30 分钟 TTL）
    clearStoreModeCache();

    let count = 0;
    let skipped = 0;
    let lastYield = Date.now();

    for (let messageId = 0; messageId < chat.length; messageId++) {
        const msg = chat[messageId];
        if (!msg || msg.is_system || typeof msg.mes !== 'string' || msg.mes.length === 0) {
            skipped++;
            continue;
        }
        try {
            const result = await processAndCover(messageId, { force: true });
            if (result?.handled) {
                count++;
            } else {
                skipped++;
            }
        } catch (err) {
            console.warn(`[rp-hub-compat] forceRerenderAll 第 ${messageId} 条重算失败：`, String(err?.message || err));
            skipped++;
        }
        // 合作式让出主线程：累计 ≥16ms 或每满 20 条让出一帧（长聊天逐条重算不卡 UI）
        if (Date.now() - lastYield >= 16 || (messageId + 1) % 20 === 0) {
            await yieldToMainThread();
            lastYield = Date.now();
        }
    }

    console.debug(`[rp-hub-compat] forceRerenderAll 完成：处理 ${count} 条，跳过 ${skipped} 条。`);
    return { count, skipped };
}

/**
 * 打开已有聊天 / reloadCurrentChat 后的自动覆盖（async，后台执行）。
 *
 * 背景（独立验证报告 #1）：ST 加载聊天（getChat → getChatResult → printMessages）用
 * updateMessageElement 直接渲染 extra.display_text —— 该字段是引擎输出、未围栏 ——
 * 裸完整文档落入 ST DOMPurify 被清洗（脚本剥、按钮点不动）。coverMessage 的
 * 「修复 4 dom-not-engine 强制覆盖」只在 coverMessage 被调用时生效，而打开聊天没有
 * 任何事件调用它 → 界面一直不渲染，直到用户手动点「强制重新渲染」或 swipe/编辑。
 *
 * 本函数挂在 CHAT_LOADED（script.js:7610，printMessages 之后）上，复用合作式调度
 * 后台逐条覆盖，与手动 forceRerenderAll 的区别：
 *   - 不清 formatDetail 缓存、不强制重算（rph_display 已持久化，重算交给后续事件）；
 *   - 已处理（rph_done）消息只走 coverMessage —— 重算一致时 coverSkipDecision 因
 *     DOM 非引擎结果（ST 刚重建）强制覆盖，把围栏结果写进界面；
 *   - 未处理消息（插件中途启用 / 旧聊天）走完整 processAndCover（双通道 + fixSwipes）。
 *
 * 已知局限（文档标注）：showMoreMessages（滚动加载更多历史）直接 updateMessageElement、
 * 不发射 CHAT_LOADED —— 该批消息不会自动覆盖，需手动「强制重新渲染」。
 * @returns {Promise<{ count: number, skipped: number }>} count=已覆盖条数，skipped=跳过条数
 */
export async function autoCoverCurrentChat() {
    const chat = getChatArray();
    if (!Array.isArray(chat) || chat.length === 0) {
        console.debug('[rp-hub-compat] autoCoverCurrentChat：当前聊天为空，直接返回。');
        return { count: 0, skipped: 0 };
    }

    let count = 0;
    let skipped = 0;
    let lastYield = Date.now();

    for (let messageId = 0; messageId < chat.length; messageId++) {
        const msg = chat[messageId];
        if (!msg || msg.is_system || typeof msg.mes !== 'string' || msg.mes.length === 0) {
            skipped++;
            continue;
        }
        try {
            if (msg.extra?.rph_done) {
                // 已处理消息：ST 刚用未围栏 display_text 重建 DOM → coverMessage 修复 4
                // （dom-not-engine 强制覆盖）把围栏结果显示到界面。
                await coverMessage(messageId);
            } else {
                // 未处理消息：完整双通道处理 + 覆盖（与 MESSAGE_RECEIVED 路径一致）。
                const result = await processAndCover(messageId);
                if (!result?.handled) {
                    skipped++;
                    continue;
                }
            }
            count++;
            // 打开聊天竞态（用户实测「渲染后不见，需编辑取消重触发」）：CHAT_LOADED 上
            // 酒馆助手 rerenderAll 与 autoCoverCurrentChat 并行 —— 酒馆助手先扫时围栏 pre
            // 还没写入 → 不 iframe；我们后写围栏，酒馆助手不重扫 → 界面停留代码块/不可见。
            // 补发 RENDERED 让酒馆助手 auditRuntimes 重扫该消息（我们自身监听幂等，
            // TH-render/标记保护不重复写）。仅当 DOM 已有围栏 pre 且尚无 TH-render 时补发。
            rescanTavernHelper(messageId);
        } catch (err) {
            console.warn(`[rp-hub-compat] autoCoverCurrentChat 第 ${messageId} 条覆盖失败：`, String(err?.message || err));
            skipped++;
        }
        // 合作式让出主线程：累计 ≥16ms 或每满 20 条让出一帧（长聊天逐条覆盖不卡 UI）
        if (Date.now() - lastYield >= 16 || (messageId + 1) % 20 === 0) {
            await yieldToMainThread();
            lastYield = Date.now();
        }
    }

    console.debug(`[rp-hub-compat] autoCoverCurrentChat 完成：覆盖 ${count} 条，跳过 ${skipped} 条。`);
    return { count, skipped };
}

/**
 * 补发消息渲染事件，让酒馆助手重扫围栏并 iframe 化（打开聊天竞态修复）。
 * 幂等守卫：.mes_text 已有 TH-render → 已 iframe 化，跳过；无 ```html 围栏 pre → 无围栏可扫，跳过。
 * @param {number} messageId
 */
function rescanTavernHelper(messageId) {
    try {
        const $mesText = runtime.chatElement.find(`.mes[mesid="${messageId}"] .mes_text`);
        if (!$mesText || !$mesText.length) return;
        // 修复（奇偶交替同源）：仅当存在「未包裹」的前端 pre 才补发（已包裹的尊重 JSR 结果；
        // cocktail 钉住的隐藏旧 TH-render 不阻塞补发）
        if (!hasUnwrappedFrontendPre($mesText)) return;
        // 酒馆助手在 CHAT_LOADED 已扫过（此刻围栏未写入）→ 补发 RENDERED 重扫
        eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
    } catch {
        // 事件/DOM 不可用（极端情况）静默跳过 —— 编辑取消等后续事件仍可触发重扫
    }
}

/**
 * 挂全局入口 window.__rphubCompat__ = { clearModeCache, forceRerenderAll, processAndCover }。
 * 已存在则合并（不覆盖已有键）—— 避免冲掉其它扩展/旧版本已挂的同名 API。
 *
 * processAndCover（2026-08-14 新增，狐策点不动方案 A 唯一第二部改动）：单条消息
 * 双通道重算 + 覆盖显示。第三部「脏 rph_display 检测 → 引擎重算」链路调用：消息
 * 持久化的 rph_display 被历史旧预设污染的 span 注入后，重算用 rph_raw_mes 干净源
 * （recomputeDisplay 源缺省优先 rph_raw_mes）产出干净 rph_display；模板消息
 * （rph_template_render）下 commitDisplay 跳过 display_text（纯显式覆盖），第三部
 * 标记不受影响。force=true 忽略 rph_done 去重标记强制重算。
 */
export function mountCompatApi() {
    const g = globalThis;
    // runScoped（路线 B 开场白桥）：第三部把开场白正文切出来后调它跑 scoped 正则（渐变盒 + 隐藏状态栏）。
    const api = { clearModeCache, forceRerenderAll, processAndCover, runScoped: (text, opts) => runtime.runScoped(text, opts) };
    try {
        const existing = g?.[GLOBAL_KEY];
        if (!existing || typeof existing !== 'object') {
            g[GLOBAL_KEY] = api;
        } else {
            for (const [key, value] of Object.entries(api)) {
                if (!(key in existing)) existing[key] = value;
            }
        }
    } catch {
        // 极少数环境不允许扩展全局对象，忽略（API 仍可从模块导入使用）
    }
}
