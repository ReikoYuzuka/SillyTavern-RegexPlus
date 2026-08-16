// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/prompt.js —— prompt 通道（生成期逐条处理，F3 修复）。
 *
 * F3（审查报告 L3/L4/P1/D7，关键修复）：
 *   prompt 通道从「GENERATE_AFTER_DATA 整段处理」改为「ST 官方扩展挂钩 generate_interceptor
 *   逐条处理」：
 *     - manifest.json 声明 `generate_interceptor: 'rphubCompatPromptInterceptor'`；
 *     - ST 在 script.js:4505（coreChat 组装 4442-4470 之后、WI 扫描 4576 与 prompt 合并 5181 之前，
 *       且 !dryRun 门控）调用 `globalThis.rphubCompatPromptInterceptor(chat, contextSize, abort, type)`，
 *       chat = coreChat（含 is_user/mes/extra/index 的完整消息对象，先例：
 *       extensions/vectors/manifest.json:8 + index.js:891）；
 *     - 逐条消息跑引擎 prompt 通道，placement（user=1/narrator=3/AI=2）与 depth
 *       （chat.length - index - (isContinue?2:1)，同原版 script.js:4444-4445）恢复 ——
 *       原版卡依赖的 placement/depth 过滤逐字复刻；
 *     - st 模式源文本 = rph_general（F2 存储通道视图）?? mes；verbatim 语义（general 已由
 *       存储通道处理，此处只跑 promptOnly/双 true）。
 *   GENERATE_AFTER_DATA 保留为**兜底**：interceptor 机制不可用时（旧 manifest 无该字段）
 *   仍走整段处理，行为与修复前一致。
 *
 * C2 管道：msg.mes 恒存原始文本（含 fox_selc/think），prompt 剥离只发生在生成期（本模块）。
 *
 * 语义说明：
 *   - rphub 模式：双 false（美化）脚本在 prompt 通道被解释器过滤（仅显示），prompt 保持干净；
 *   - st 模式：promptOnly/双 true 脚本逐条执行，结果写回 coreChat item.mes（生成期临时，不落 mes）；
 *   - reasoning（placement=6）与 WI 逐条目（placement=5 per-entry depth）：interceptor 时点
 *     reasoning 已并入消息文本、WI 已扫描完毕 —— 逐条 placement=6 不单独处理（文档声明局限）；
 *     WI 通道由 pipeline/index.js 的 GENERATE_BEFORE_COMBINE_PROMPTS 分部件兜底（见 F4 注记）。
 */

import { runtime } from './runtime.js';
import { derivePromptContext, hasGeneralScript } from './pure.js';

/** interceptor 是否可用（F3）：首次被 ST 调用后置 true，GENERATE_AFTER_DATA 兜底据此跳过。 */
export function isPromptInterceptorAvailable() {
    return runtime.interceptorAvailable === true;
}

/**
 * ST generate_interceptor（manifest.json generate_interceptor 字段 → globalThis 同名函数）。
 * 在 prompt 组装早期逐条处理核心聊天消息（placement/depth 逐字复刻原版 script.js:4447）。
 * 由 index.js 注册到 globalThis（manifest 要求全局函数名）。
 * @param {object[]} chat coreChat（含 is_user/mes/extra/index 的消息数组）
 * @param {number} contextSize 上下文大小（未用）
 * @param {(immediately: boolean) => void} abort 中止回调（未用 —— 本通道只改写文本不中止生成）
 * @param {string} type 生成类型（continue/swipe/impersonate/…，depth 推导用）
 * @returns {Promise<void>}
 */
export async function rphubCompatPromptInterceptor(chat, contextSize, abort, type) {
    if (!runtime.active) return;
    // cleanPrompt 开关（默认 true）：关闭 = 不施加任何剥离，prompt 原样（用户选择权）
    if (runtime.getCleanPrompt?.() !== true) return;
    if (!Array.isArray(chat) || chat.length === 0) return;
    const mode = await runtime.getMode();
    // ⚠️ 仅 rphub 模式接管 prompt：原版卡（st）的提示词由 ST 原生正则处理，本插件不介入
    //   （否则 promptOnly 脚本被插件 + ST 原生应用两次 → 原版卡提示词被二次改写）。
    if (mode !== 'rphub') return;
    const scripts = runtime.getScripts(mode);
    if (scripts.length === 0) return;

    const total = chat.length;
    for (let i = 0; i < total; i++) {
        const item = chat[i];
        if (!item || typeof item.mes !== 'string' || item.mes.length === 0) continue;
        // placement/depth/role（原版 script.js:4444-4445 逐字复刻，pure.derivePromptContext）
        const { placement, depth, role } = derivePromptContext(item, i, total, type);
        // st 源文本 = general 视图（F2 存储通道语义）。有 general 脚本时**现算**（缓存的
        // rph_general 在脚本集变化后可能过期）；无 general 脚本 → 原文（当前环境快速路径）。
        let source = item.mes;
        if (mode === 'st' && hasGeneralScript(scripts)) {
            const generalResult = runtime.engineRun({
                text: item.mes,
                scripts,
                mode,
                placement,
                options: { stGeneralMode: 'verbatim' },
            });
            if (typeof generalResult?.text === 'string') source = generalResult.text;
        }
        const result = runtime.engineRun({
            text: source,
            scripts,
            mode,
            isPrompt: true,
            placement,
            depth,
            role,
            options: { ...(mode === 'st' ? { stGeneralMode: 'verbatim' } : {}) },
        });
        if (typeof result?.text === 'string' && result.text !== item.mes) {
            item.mes = result.text; // 写回 coreChat 临时项（生成期使用，不落 chat 存储）
        }
    }
    runtime.interceptorAvailable = true;
}

/**
 * GENERATE_BEFORE_COMBINE_PROMPTS：WI 通道分部件处理（F4，审查报告 L4/D8）。
 * ST 在 script.js:5175 发射，data 含 worldInfoBefore/worldInfoAfter 等未扁平化的 prompt 部件。
 * 对 WI 字符串施加 placement=5（WORLD_INFO）+ isPrompt —— 恢复原版 world-info.js:5086 的
 * WI 通道语义（placement=5 脚本作用于 WI 内容；非 placement=5 脚本不误碰 WI）。
 * 局限（文档声明）：① 扁平字符串无法恢复逐条目 atDepth 深度（depth 过滤跳过）；
 * ② EM 示例（→mesExamplesArray）、WIDepth/outlet 条目不在该两字段内，未覆盖；
 * ③ 仅 interceptor 模式生效（兜底模式 WI 已含在整段 prompt 处理中，避免双重应用）。
 * @param {object} data GENERATE_BEFORE_COMBINE_PROMPTS 载荷（worldInfoBefore/worldInfoAfter）
 */
export async function onGenerateBeforeCombinePrompts(data) {
    if (!runtime.active) return;
    if (runtime.interceptorAvailable !== true) return; // 兜底模式：WI 已含在整段 prompt 处理中
    if (runtime.getCleanPrompt?.() !== true) return;
    if (!data || typeof data !== 'object') return;
    const mode = await runtime.getMode();
    // ⚠️ 仅 rphub 模式：原版卡（st）的 WI 由 ST 原生 world-info 通道处理，本插件不介入
    //   （否则 placement=5 脚本被应用两次）。
    if (mode !== 'rphub') return;
    const scripts = runtime.getScripts(mode);
    if (scripts.length === 0) return;

    let changed = false;
    for (const key of ['worldInfoBefore', 'worldInfoAfter']) {
        const value = data[key];
        if (typeof value !== 'string' || value.length === 0) continue;
        const result = runtime.engineRun({
            text: value,
            scripts,
            mode,
            isPrompt: true,
            placement: 5, // regex_placement.WORLD_INFO（原版 world-info.js:5086）
            options: { ...(mode === 'st' ? { stGeneralMode: 'verbatim' } : {}) },
        });
        if (typeof result?.text === 'string' && result.text !== value) {
            data[key] = result.text;
            changed = true;
        }
    }
    if (changed) {
        console.debug('[rp-hub-compat] GENERATE_BEFORE_COMBINE_PROMPTS：WI 分部件 placement=5 处理完成。');
    }
}

/**
 * GENERATE_AFTER_DATA 兜底（F3）：interceptor 机制不可用（旧 manifest / 未挂载）时对整段 prompt
 * 施加引擎 isPrompt 处理 —— 行为与修复前一致；interceptor 已生效后直接跳过（避免二次处理）。
 * @param {object} generate_data  { prompt: string, ... }（script.js:5259 发射）
 * @param {boolean} [dryRun]
 */
export async function onGenerateAfterData(generate_data, dryRun) {
    if (!runtime.active || dryRun || !generate_data || typeof generate_data !== 'object') return;
    if (runtime.interceptorAvailable === true) return; // F3：interceptor 已逐条处理，兜底跳过
    // cleanPrompt 开关（默认 true）：关闭 = 不施加任何剥离，prompt 原样（用户选择权）
    if (runtime.getCleanPrompt?.() !== true) return;
    const prompt = generate_data.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) return;

    const mode = await runtime.getMode();
    // ⚠️ 仅 rphub 模式：原版卡（st）的 prompt 由 ST 原生正则处理，本插件不介入
    //   （否则 promptOnly 脚本被应用两次）。
    if (mode !== 'rphub') return;
    const scripts = runtime.getScripts(mode);
    if (scripts.length === 0) return;

    const result = runtime.engineRun({ text: prompt, scripts, mode, isPrompt: true });
    if (typeof result?.text === 'string' && result.text !== prompt) {
        generate_data.prompt = result.text;
        console.debug('[rp-hub-compat] GENERATE_AFTER_DATA：对整段 prompt 应用引擎剥离（F3 兜底路径，interceptor 不可用）。');
    }
}
