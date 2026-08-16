// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/display.js —— 显示通道（D1 事件介入）。
 *
 * 事件挂载（index.js 负责 on）：
 *   - MESSAGE_RECEIVED               → index.onMessageReceived → processAndCover（双通道）
 *   - USER_MESSAGE_RENDERED          → onUserRendered（用户消息不触发 MESSAGE_RECEIVED）
 *   - CHARACTER_MESSAGE_RENDERED     → onCharacterRendered
 *   - MESSAGE_SWIPED                 → onMessageSwiped（浏览 swipe → 重算 + 覆盖）
 *   - MESSAGE_UPDATED                → onMessageUpdated（编辑取消/保存后的恢复渲染）
 *
 * coverMessage 语义：
 *   渲染发生在 ST 之后（RENDERED/SWIPED/UPDATED/EDITED 事件时序），我们覆盖 .mes_text
 *   使引擎结果显示生效；编辑态（.mes_text 内含 #curEditTextarea）跳过。
 *   修复 1：rph_done 消息不再直接渲染旧缓存 rph_display —— 用「当前脚本集 + 原始文本」
 *   重算显示；一致则跳过 DOM 覆盖，不一致才覆盖并写回新缓存（玄狐样式切换生效）。
 *   修复 3：酒馆助手已渲染 TH-render iframe 时整体跳过（尊重其渲染结果）。
 *   修复 4：打开已有聊天时 ST 用 mes 重建 DOM，.mes_text 是 ST 默认纯文本渲染（无
 *   TH-render / 无 rph-rendered 标记）—— 此时「一致跳过」不成立，视同需强制覆盖；
 *   写入引擎结果时给 .mes_text 打 rph-rendered 标记（识别「已是引擎结果」）。
 *   显示源：优先 rph_display；缺失时从 rph_raw_mes/mes 重算（持久化恢复 / 未处理消息）。
 */

import { runtime } from './runtime.js';
import { event_types, eventSource } from '../st-bridge.js';
import {
    processMessageView,
    needsReprocess,
    isEditingDom,
    derivePlacement,
    recomputeDisplay,
    recomputeDecision,
    commitDisplay,
    hasTavernHelperRender,
    hasUnwrappedFrontendPre,
    isEngineRenderedDom,
    coverSkipDecision,
    isTemplateRendered,
    shouldSkipRecoveryRecompute,
    DISPLAY_KEY,
    DISPLAY_FP_KEY,
    RENDER_MARK_CLASS,
} from './pure.js';
import { fenceForMode } from '../engine/html-fence.js';
import { renderDisplayHtml } from './render.js';
// 方向 A（用户拍板）：coverMessage 渲染整条消息时，对流式定格段（content）做「拼合」——
// content 段区间用流式定格结果（engineText）替换进正式引擎输出（成品在 .mes_text 正确位置，
// 顺序 = 思维链 → content → 尾部）；STREAM_SKIP_CLASS 标记用于「已应用拼合」的幂等判定
// （消除 RENDERED 二次全量重渲染）。单向依赖，stream-service 不 import display，无循环。
import { spliceFinalizedSegments, STREAM_SKIP_CLASS } from '../stream/stream-service.js';

// 补丁 1d：最近一次 editRecovery/forceApply 强制写回的消息（供 rescanForIframe 补发的 RENDERED
// 识别「本次 recompute 应跳过」—— 见 pure.shouldSkipRecoveryRecompute 注释）。
let freshWriteMessageId = null;
let freshWriteAt = 0;

/**
 * 双通道处理 + 显示写回（MESSAGE_RECEIVED / swipe / 编辑保存 / RENDERED 兜底共用）。
 * @param {number} messageId
 * @param {{ source?: string, force?: boolean, isEdit?: boolean }} [opts]
 *   isEdit（F5，审查报告 L5/D9）：编辑保存标记，透传 processMessageView —— 存储通道（general）
 *   按原版 isEdit 语义执行（runOnEdit=false 的 general 脚本编辑保存时跳过，script.js:8100）。
 * @returns {Promise<{ handled: boolean, raw?: string, display?: string, prompt?: string }>}
 */
export async function processAndCover(messageId, { source, force = false, isEdit = false } = {}) {
    const msg = runtime.chat[messageId];
    if (!msg || typeof msg.mes !== 'string' || msg.mes.length === 0) return { handled: false };
    if (msg.is_system) return { handled: false };
    if (!force && msg.extra?.rph_done) {
        await coverMessage(messageId);
        return { handled: false, reason: 'already-handled' };
    }
    const mode = await runtime.getMode();
    // ⚠️ 仅 rphub 模式接管显示：原版卡（st）的显示由 ST 原生 messageFormatting 处理
    //   （script.js:1809 getRegexedString isMarkdown），本插件不介入 —— 否则引擎处理 +
    //   ST messageFormatting 二次应用 markdownOnly 脚本（render.js 用 messageFormatting 渲染）。
    if (mode !== 'rphub') return { handled: false, reason: 'st-mode-not-managed' };
    const scripts = runtime.getScripts(mode);
    const runArgs = {
        ...derivePlacement(msg),
        depth: runtime.computeDepth(messageId),
        isFirstMessage: runtime.isFirstMessage(messageId),
        characterOverride: msg.name,
    };
    // C2：mes 恒存原始文本（不含 cleanPrompt 参数 —— 剥离职责在 prompt 通道承接）
    const result = processMessageView({ msg, mode, scripts, source, runArgs, run: runtime.engineRun, force, isEdit, settingsFp: runtime.getSettingsFp() });
    if (!result.handled) return result;
    runtime.fixSwipes(messageId, msg, result.raw);
    // forceApply：刚处理完的消息 DOM 可能还是流式原文渲染，必须显式覆盖展示引擎结果
    await coverMessage(messageId, { forceApply: true });
    return result;
}

/**
 * 用引擎显示结果覆盖 .mes_text（渲染在 ST 之后，覆盖生效）。
 * 编辑态（textarea）跳过；rph_display 缺失时重算（持久化恢复 / 未处理消息）。
 *
 * 修复 1（玄狐兼容）：rph_done 消息不再直接渲染旧缓存 rph_display，而是用
 * 「当前脚本集 + 原始文本（rph_raw_mes → rph_display → mes）」重算显示 ——
 * 重算与缓存一致则跳过 DOM 覆盖（避免高频强制刷新场景反复重写 DOM），
 * 不一致才覆盖并写回新缓存。
 * 修复 3（玄狐兼容兜底）：.mes_text 内酒馆助手已渲染 TH-render iframe 时整体跳过。
 * 修复 4（打开已有聊天）：ST 用 mes 重建 DOM 时「一致跳过」不成立 ——
 * 重算一致但当前 DOM 非引擎结果（无 TH-render / 无 rph-rendered 标记）→ 视同需
 * 强制覆盖（coverSkipDecision），写入引擎结果并打 rph-rendered 标记。
 *
 * @param {number} messageId
 * @param {{ forceApply?: boolean, editRecovery?: boolean }} [opts] forceApply=true 时跳过重算决策，
 *   直接应用现有缓存（processAndCover 刚处理完的消息：DOM 可能还是流式原文渲染，
 *   必须显式覆盖才能展示引擎显示结果）。
 *   editRecovery=true（编辑取消/保存恢复路径）：放宽 hasTavernHelperRender 守卫 ——
 *   ST 已用 mes 重建 DOM，中间态上的 TH iframe 不是最终渲染，需写回引擎显示结果（补丁 1a）。
 */
export async function coverMessage(messageId, { forceApply = false, editRecovery = false } = {}) {
    const msg = runtime.chat[messageId];
    if (!msg) return;
    // 模板渲染消息（D2 根治）：显示由第三部方案A 渲染服务接管（display_text=正文+模板围栏），
    // 本扩展不覆写 display_text / DOM —— 引擎缓存（rph_display/rph_raw_mes）照常维护。
    // 修复（切换后需手动强制重新渲染）：样式/脚本切换（玄狐改 preset 正则 disabled）→ RENDERED
    // → 第三部（eventMakeFirst 先于本扩展）用**旧 rph_display** 判跳过（rph_template_body===正文）
    // → 本扩展若整体 return，新 rph_display 永不重算 → 模板 display_text 仍旧样式。此处对模板
    // 消息**仍重算 rph_display**（只写缓存，不写 display_text/DOM —— 第三部所有权不变），
    // 若结果变化 → 补发 RENDERED 让第三部用新鲜正文源重渲染（收敛：重算不变即不补发）。
    if (isTemplateRendered(msg)) {
        if (!forceApply && msg.extra?.rph_done) {
            const mode = await runtime.getMode();
            const scripts = runtime.getScripts(mode);
            const runArgs = {
                ...derivePlacement(msg),
                depth: runtime.computeDepth(messageId),
        isFirstMessage: runtime.isFirstMessage(messageId),
                characterOverride: msg.name,
            };
            const result = recomputeDisplay({ msg, mode, scripts, runArgs, run: runtime.engineRun, settingsFp: runtime.getSettingsFp() });
            if (result.handled && result.display !== msg.extra?.[DISPLAY_KEY]) {
                commitDisplay(msg, result.display, result.fp); // 模板消息：只写 rph_display + 指纹（display_text 由第三部写）
                eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal'); // 通知第三部用新鲜正文源重渲染
            }
        }
        return;
    }
    // ⚠️ 仅 rphub 模式接管显示：原版卡（st）的显示由 ST 原生 messageFormatting 渲染
    //   （script.js:1809 getRegexedString isMarkdown），本插件不覆盖 DOM —— 否则引擎处理 +
    //   ST messageFormatting 二次应用 markdownOnly 脚本（显示双重应用，render.js 用
    //   messageFormatting 渲染引擎结果）。
    const mode = await runtime.getMode();
    if (mode !== 'rphub') return;
    const $mesText = runtime.chatElement.find(`.mes[mesid="${messageId}"] .mes_text`);
    if (!$mesText.length) return;
    if (isEditingDom($mesText)) return; // 编辑态（.mes_text 内为 textarea）跳过

    // 修复 3：酒馆助手已把样式代码块渲染成 TH-render iframe 界面 → 尊重其结果，不覆盖。
    // 补丁 1a：编辑恢复路径（editRecovery = MESSAGE_UPDATED 取消/保存）例外 —— ST 刚用 mes
    // 重建 DOM（原文渲染中间态），其上的 TH iframe 不是我们要尊重的最终渲染；必须写回引擎
    // 显示结果，否则取消后界面停留在 ST 原文渲染（问题 1「有时候不重新渲染」）。
    if (hasTavernHelperRender($mesText) && !editRecovery) return;

    // 显示通道 HTML 围栏化模式判定（设计 §5 / 界面按钮点不动诊断.md 方案 A）：
    // 仅 rphub 模式启用（formatDetail=rphub 语义）；st 模式已在上方门控跳过。

    let text;
    if (msg.extra?.rph_done && !forceApply) {
        // 修复 1：RENDERED/UPDATED/SWIPED 事件 → 用当前脚本集 + 原始文本重算显示。
        // getScripts(mode) 每次现读（含玄狐刚切的 disabled 标志）；source 用 rph_raw_mes
        // 保持 swipe 稳定（needsReprocess/fixSwipes 语义不变）。
        // O2（审查报告 P2）：settingsFp + recomputeDisplay 指纹命中 → 跳过引擎执行（缓存直返）。
        const scripts = runtime.getScripts(mode);
        const runArgs = {
            ...derivePlacement(msg),
            depth: runtime.computeDepth(messageId),
        isFirstMessage: runtime.isFirstMessage(messageId),
            characterOverride: msg.name,
        };
        const result = recomputeDisplay({ msg, mode, scripts, runArgs, run: runtime.engineRun, settingsFp: runtime.getSettingsFp() });
        if (!result.handled) return;
        // 修复 1：重算一致 → 默认跳过 DOM 覆盖（新样式未变，避免闪烁/性能损失）；不一致 → 覆盖并写回缓存。
        // 修复 4：「一致跳过」只在当前 DOM 已是引擎渲染结果时成立 —— 打开已有聊天时 ST 用 mes
        // 重建 DOM（.mes_text 是 ST 默认纯文本渲染，无 TH-render iframe、无本扩展 rph-rendered 标记），
        // 此时 rph_display 虽在磁盘但界面没出来 → 视同需强制覆盖（绕过一致跳过，把引擎结果写进 DOM）。
        const { apply } = recomputeDecision(msg, result.display);
        // 方向 A：流式定格段拼合进正式引擎输出 —— content 段区间用流式结果，其余用正式结果；
        // 渲染层动作，不写缓存（rph_display 保持正式引擎输出，拼合只影响本次 DOM 写入）。
        const spliced = spliceFinalizedSegments(result.display, messageId);
        text = spliced.spliced ? spliced.text : result.display;
        const { cover } = coverSkipDecision({ apply, isEngineRendered: isEngineRenderedDom($mesText, result.display) });
        const spliceMarked = $mesText.hasClass(STREAM_SKIP_CLASS);
        // 拼合形态与 DOM 当前形态一致（且一致跳过）→ 无需再写 DOM（消除 RENDERED 二次全量重渲染）；
        // 不一致（需要补拼合 / 需要摘拼合）→ 写（覆盖可能已因竞态先写了全量、或拼合已失效）。
        if (!cover && spliced.spliced === spliceMarked) return;
        if (spliced.spliced) $mesText.addClass(STREAM_SKIP_CLASS);
        else $mesText.removeClass(STREAM_SKIP_CLASS);
        if (apply) commitDisplay(msg, result.display, result.fp);
        else if (result.fp && result.fp !== msg.extra?.[DISPLAY_FP_KEY]) commitDisplay(msg, result.display, result.fp); // O2：内容未变也同步指纹（防反复重算）
    } else {
        // 缓存缺失重算（持久化恢复 / 未处理消息）或 forceApply（刚处理完，直接应用）
        text = msg.extra?.rph_display;
        if (typeof text !== 'string' || text.length === 0) {
            // 重算：swipe 浏览用当前 mes（原始文本）；否则用原始快照兜底
            const scripts = runtime.getScripts(mode);
            const source = needsReprocess(msg) ? msg.mes : (msg.extra?.rph_raw_mes ?? msg.mes);
            const runArgs = {
                ...derivePlacement(msg),
                depth: runtime.computeDepth(messageId),
        isFirstMessage: runtime.isFirstMessage(messageId),
                characterOverride: msg.name,
            };
            const result = processMessageView({ msg, mode, scripts, source, runArgs, run: runtime.engineRun, force: true, settingsFp: runtime.getSettingsFp() });
            if (!result.handled) return;
            runtime.fixSwipes(messageId, msg, result.raw);
            text = result.display;
        }
        if (typeof text !== 'string' || text.length === 0) return;
        // 方向 A：流式定格段拼合（content 段区间用流式结果；渲染层动作，不写缓存）
        const spliced = spliceFinalizedSegments(text, messageId);
        if (spliced.spliced) text = spliced.text;
        if (spliced.spliced) $mesText.addClass(STREAM_SKIP_CLASS);
        else $mesText.removeClass(STREAM_SKIP_CLASS);
    }
    // 围栏化：仅 rphub 模式把「裸完整 HTML 文档」（无 ``` 围栏）包成 ```html 代码块，
    // 使 ST 生成 <pre><code> → 酒馆助手 isFrontend 命中 → iframe 原样渲染（卡脚本存活、
    // 按钮可点）。已带围栏/非完整文档原样（幂等）。缓存 rph_display 保持引擎原始输出，
    // 围栏化只是渲染层动作，不写回缓存（recomputeDecision 一致比较不受影响）。
    text = fenceForMode(text, mode);
    const { html } = renderDisplayHtml({ text, messageId, msg, messageFormatting: runtime.messageFormatting });
    if (!html) return;
    // 写引擎结果 + rph-rendered 标记（修复 4：标记用于识别「当前 DOM 已是引擎结果」，
    // 使后续一致跳过成立；ST 用 mes 重建 DOM 时标记丢失 → 重新强制覆盖）。
    $mesText.empty().addClass(RENDER_MARK_CLASS).append(html);
}

/** CHARACTER_MESSAGE_RENDERED：渲染后覆盖（MESSAGE_RECEIVED 已处理则直接覆盖；未处理则兜底处理）。 */
export async function onCharacterRendered(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    if (msg.extra?.rph_done) {
        // 补丁 1d：本次 RENDERED 若由 rescanForIframe 为「刚被 editRecovery 强制写回」的消息补发，
        // DOM 已是权威引擎显示结果 —— 跳过 recompute，避免宏非确定性（{{random}}/{{time}}）导致
        // 重算结果 ≠ 缓存 → 覆盖 rph_display/display_text 并破坏酒馆助手刚 iframe 化的 TH-render
        // （用户实测「取消后整个渲染没了 / 再取消模板出现但正则没了」）。
        if (shouldSkipRecoveryRecompute(messageId, freshWriteMessageId, freshWriteAt)) {
            freshWriteMessageId = null;
            freshWriteAt = 0;
            return;
        }
        await coverMessage(messageId);
        return;
    }
    await processAndCover(messageId);
}

/** USER_MESSAGE_RENDERED：用户消息（sendMessageAsUser 不触发 MESSAGE_RECEIVED）。 */
export async function onUserRendered(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg || !msg.is_user || msg.is_system) return;
    if (msg.extra?.rph_done) {
        await coverMessage(messageId);
        return;
    }
    await processAndCover(messageId);
}

/** MESSAGE_SWIPED：浏览到其它 swipe（mes 已被 syncSwipeToMes 置为 swipes[id] 原始文本）→ 重算 + 覆盖。 */
export async function onMessageSwiped(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg) return;
    if (needsReprocess(msg)) {
        await processAndCover(messageId, { source: msg.mes, force: true });
        return;
    }
    await coverMessage(messageId);
}

/** MESSAGE_UPDATED：编辑取消 / 保存后的恢复渲染。 */
export async function onMessageUpdated(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    // 强制写回：编辑重绘后 ST 用 mes（纯正文）渲染，重算结果与缓存 rph_display 一致会被
    // recomputeDecision 跳过、不写 DOM → 界面消失。forceApply 绕开一致跳过，强制恢复显示。
    // 补丁 1a：editRecovery 放宽 TH-render 守卫（ST 重建的中间态不是最终渲染）。
    // 补丁 1c：写回围栏后补发 RENDERED，让酒馆助手重扫 iframe 化（消除「TH 先扫无围栏 DOM、
    // 围栏写入后无人 iframe 化」的竞态 —— 问题 1「有时候」的第二来源）。
    // 修复（编辑取消奇偶交替）：补发 RENDERED 从「嵌套同步发射」改为「setTimeout(0) 延时发射」——
    // 嵌套发射发生在 MESSAGE_UPDATED 监听链中途，会与 cocktail html-render-cache 的
    // makeLast restore（监听链最后一位）与 JSR audit 产生时序竞态（奇偶交替根因候选）；
    // 延时后整个 MESSAGE_UPDATED 监听链（含 cocktail restore / JSR 先扫）先完成，
    // 再对**最终 DOM** 补发 RENDERED 让 JSR 重扫 —— 确定性恢复显示。
    // 修复（模板消息取消后不渲染，用户日志实证）：模板消息（rph_template_render）显示由第三部
    // 渲染服务接管，取消后 ST 裸渲染 DOM=0/0，第三部渲染单条在 MESSAGE_UPDATED 一轮内可能
    // 未走到重建（跳过分支的 重新断言DOM 依赖后续 RENDERED 收敛）——**无条件补发 RENDERED**
    // 让第三部 eventMakeFirst 重处理（渲染单条 → 跳过 → 重新断言DOM → updateMessageBlock 重建 +
    // 触发重扫描 → TH 补挂 iframe）；非模板消息仍走「未包裹前端 pre 才补发」守卫（避免无谓重扫）。
    debugEvent('onMessageUpdated:before', messageId);
    await coverMessage(messageId, { forceApply: true, editRecovery: true });
    debugEvent('onMessageUpdated:after-cover', messageId);
    // 补丁 1d：记录本次强制写回 —— 补发的 RENDERED 触发 onCharacterRendered 时跳过 recompute
    //（DOM 已是权威显示，避免宏非确定性重算覆盖缓存/破坏 TH iframe）。
    freshWriteMessageId = messageId;
    freshWriteAt = Date.now();
    setTimeout(() => {
        if (!runtime.active) return;
        if (msg?.extra?.rph_template_render === true) {
            debugEvent('onMessageUpdated:template-rescan-emit', messageId);
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
        } else {
            rescanForIframe(messageId);
        }
    }, 0);
}

/**
 * 补丁 1c：补发 CHARACTER_MESSAGE_RENDERED，让酒馆助手重扫围栏并 iframe 化。
 * 修复（奇偶交替）：守卫从「存在任何 TH-render 即跳过」改为「存在**未包裹**的前端 pre 才补发」——
 * cocktail html-render-cache 钉住的隐藏旧 TH-render 不应阻塞补发（否则新写入的引擎显示围栏
 * 无人 iframe 化 → 显示为代码块/不渲染）；已包裹的 pre 尊重 JSR 结果不重复补发。
 * （与 force-render.js rescanTavernHelper 同构；display 侧不能反向 import force-render 避免循环依赖）
 * @param {number} messageId
 */
function clearFreshWrite() {
    freshWriteMessageId = null;
    freshWriteAt = 0;
}

function rescanForIframe(messageId) {
    try {
        const $mesText = runtime.chatElement.find(`.mes[mesid="${messageId}"] .mes_text`);
        if (!$mesText || !$mesText.length) { clearFreshWrite(); return; }
        const unwrapped = hasUnwrappedFrontendPre($mesText);
        debugEvent(`rescanForIframe unwrapped=${unwrapped}`, messageId, $mesText);
        if (!unwrapped) {
            // D1 修复：无未包裹前端代码块（已 iframe 化 / 本消息无围栏）→ 补发无意义，消费 freshWrite
            // 防残留 2000ms 窗口（否则同消息后续正常 RENDERED 被误判跳过 recompute）
            clearFreshWrite();
            return;
        }
        // 补发 RENDERED 重扫（我们自身监听幂等：DOM 已带 rph-rendered 标记，coverSkipDecision 跳过）
        eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
    } catch {
        clearFreshWrite(); // D1 修复：异常路径也消费 freshWrite 防残留
        // 事件/DOM 不可用（极端情况）静默跳过 —— 事件链路的 MESSAGE_UPDATED 覆盖已恢复显示
    }
}

/**
 * 取消/覆盖链路诊断（默认开启 console.log；localStorage 置 `rphubDebugEvents=0` 可关闭）。
 * 输出每次编辑取消/保存与 rescan 决策的 DOM 状态（TH-render 数 / pre 数 / 未包裹前端 pre /
 * freshWrite 窗口），用于定位「编辑取消不渲染」「切换后需手动强制重新渲染」。
 * @param {string} label
 * @param {number} messageId
 * @param {object} [$mesText]
 */
function debugEvent(label, messageId, $mesText = null) {
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('rphubDebugEvents') === '0') return;
        const $t = $mesText || runtime.chatElement.find(`.mes[mesid="${messageId}"] .mes_text`);
        const th = typeof $t?.find === 'function' ? $t.find('div.TH-render').length : -1;
        const pre = typeof $t?.find === 'function' ? $t.find('pre').length : -1;
        const msg = runtime.chat[messageId];
        console.log(`[rp-hub-compat:debug] ${label} mesid=${messageId} TH-render=${th} pre=${pre} unwrapped=${hasUnwrappedFrontendPre($t)} rph_template=${msg?.extra?.rph_template_render === true} rph_done=${msg?.extra?.rph_done === true} freshWrite=${freshWriteMessageId === messageId ? (Date.now() - freshWriteAt) + 'ms' : 'no'}`);
    } catch { /* 诊断失败不影响主流程 */ }
}

/**
 * 补丁 1b：编辑关闭兜底恢复 —— MESSAGE_UPDATED 事件链路之外的二次保险。
 * 由 edit.js 的 MutationObserver 在 #curEditTextarea 被移除（取消/保存）后调度。
 * 幂等：未处理消息 / 模板渲染 / 无 DOM / 编辑态（又打开了新编辑器）/ 已是引擎渲染结果
 * （事件链路已恢复）均跳过，不与 MESSAGE_UPDATED 正常链路重复写 DOM。
 * @param {number} messageId
 */
export async function ensureMessageRecovered(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg) return;
    if (!msg.extra?.rph_done) return; // 未处理消息：无显示缓存可恢复
    if (isTemplateRendered(msg)) return;
    const $mesText = runtime.chatElement.find(`.mes[mesid="${messageId}"] .mes_text`);
    if (!$mesText.length) return;
    if (isEditingDom($mesText)) return; // 又打开了新编辑器，别打扰
    if (isEngineRenderedDom($mesText, msg.extra?.[DISPLAY_KEY])) return; // 事件链路已恢复，无需补
    await coverMessage(messageId, { forceApply: true, editRecovery: true });
    // 补丁 1d：同 onMessageUpdated —— 记录本次强制写回，让 rescanForIframe 补发的 RENDERED
    // 跳过 recompute（DOM 已是权威显示）。
    freshWriteMessageId = messageId;
    freshWriteAt = Date.now();
    rescanForIframe(messageId);
}
