// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * stream/legacy-hook.js —— ST 卡流式即时正则拦截挂钩（与 ST StreamingProcessor 桥接）。
 *
 * 核心目标：
 *   - 专服务于 ST 卡（mode !== 'rphub'）在原版 regex 扩展关闭时的流式即时渲染体验；
 *   - 拦截 StreamingProcessor.onProgressStreaming，在 ST 每帧处理前，将累积 text 参数替换为
 *     轻量引擎处理后的版本；
 *   - ST 原生流水线（cleanUpMessage -> messageFormatting -> innerHTML）随后自然渲染，
 *     零 DOM 竞争、零闪烁，标签闭合瞬间立即呈现；
 *   - 数据闭环：拦截前将未经修改的原始累积文本存入 msg.extra.rph_raw_mes，并打上
 *     rph_stream_processed 临时标记，流式结束后由正式链路统一收敛。
 */

import { streamingProcessor, event_types, eventSource } from '../st-bridge.js';
import { runtime } from '../pipeline/runtime.js';
import { isStreamRenderEnabled } from '../store/settings.js';
import { getRegexedStringLegacy } from './st-legacy-engine.js';

let hooked = false;
let cachedMode = null;

/**
 * 预热当前卡片模式（在 GENERATION_STARTED 时提前读取并缓存）。
 */
async function warmupMode() {
    try {
        cachedMode = await runtime.getMode();
    } catch {
        cachedMode = 'st';
    }
}

/**
 * 判定当前生成是否应应用 ST 卡流式轻量拦截：
 *   1. 扩展必须处于激活状态；
 *   2. 未开启高级流式段渲染开关（互斥）；
 *   3. 原版 regex 扩展未在运行（原版关闭时我们才补位，原版开启时由原版负责）；
 *   4. 当前卡为 ST 卡（mode !== 'rphub'）。
 */
function shouldApplyLegacyHook() {
    if (!runtime.active) return false;
    if (isStreamRenderEnabled()) return false;
    if (runtime.nativeRegexRunning()) return false;
    // 优先使用预热缓存的 mode；缺失时按 'st' 兜底
    const mode = cachedMode || 'st';
    return mode !== 'rphub';
}

/**
 * 对当前的 streamingProcessor 实例挂钩 onProgressStreaming。
 */
function hookProcessorInstance() {
    if (hooked) return;
    if (!streamingProcessor || typeof streamingProcessor.onProgressStreaming !== 'function') return;

    const original = streamingProcessor.onProgressStreaming.bind(streamingProcessor);

    streamingProcessor.onProgressStreaming = async function (messageId, text, isFinal) {
        // 1. 守卫过滤：final 帧、continue 续写、impersonate 模式或未满足 ST 卡条件时，直接放行原生
        if (isFinal || this.type === 'continue' || this.type === 'impersonate' || !shouldApplyLegacyHook()) {
            return original(messageId, text, isFinal);
        }

        const rawText = String(text ?? '');
        const msg = runtime.chat?.[messageId];
        if (msg) {
            msg.extra ??= {};
            // 真实数据保护：捕获未经任何正则处理的原始累积字符串作为权威原料
            msg.extra.rph_raw_mes = rawText;
            msg.extra.rph_stream_processed = true;
        }

        // 2. 执行轻量逐条正则替换
        try {
            const mode = cachedMode || await runtime.getMode() || 'st';
            if (mode !== 'rphub') {
                const scripts = runtime.getScripts(mode);
                const depth = runtime.computeDepth(messageId);
                const replacedText = getRegexedStringLegacy(rawText, 2, { // 2 = regex_placement.AI_OUTPUT
                    isMarkdown: true,
                    depth,
                    characterOverride: msg?.name,
                    scripts,
                    substituteParams: runtime.macros?.substituteParams,
                    substituteParamsExtended: runtime.macros?.substituteParamsExtended,
                });

                // 将轻量替换后的文本传递给 ST 原生流水线进行渲染
                return original(messageId, replacedText, isFinal);
            }
        } catch (error) {
            console.warn('[rp-hub-compat] ST 卡流式轻量正则执行异常（降级为原文渲染）：', error);
        }

        return original(messageId, rawText, isFinal);
    };

    hooked = true;
    console.debug('[rp-hub-compat] StreamingProcessor.onProgressStreaming 已挂钩（ST 卡流式实时渲染生效）。');
}

/**
 * 初始化 ST 卡流式即时正则拦截器。
 */
export function initLegacyStreamHook() {
    // 1. 生成开始时预热模式缓存
    eventSource.on(event_types.GENERATION_STARTED, () => {
        hooked = false;
        warmupMode().catch(() => {});
    });

    // 2. 首个 token 到达时对 streamingProcessor 实例执行挂钩
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
        if (!hooked) {
            hookProcessorInstance();
        }
    });

    // 3. 生成结束/中断时重置状态
    eventSource.on(event_types.GENERATION_ENDED, () => {
        hooked = false;
    });

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        hooked = false;
    });
}
