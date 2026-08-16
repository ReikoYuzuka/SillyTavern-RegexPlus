// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/render.js —— 显示写回（酒馆助手优先，ST 原生回退）。
 *
 * 优先级（引擎设计.md §8 / 任务 C）：
 *   1. 酒馆助手已安装：window.TavernHelper.formatAsDisplayedMessage(text, { message_id })
 *      = ST messageFormatting + hljs 代码高亮 + iframe 渲染器识别。
 *   2. 未安装：ST 原生 messageFormatting —— 保证引擎替换后的文本正确显示
 *      （rphub 美化正则产出的 ```html 代码块由 ST markdown 转换器渲染；RP-Hub 完整
 *      iframe 界面渲染属于酒馆助手能力，未安装时退化为代码块显示）。
 *
 * 设计约束（本阶段不做 DOM 合成，见 index.js 的 DOM 写回）：
 *   renderToHtml 只产出 HTML 字符串；实际写入 .mes_text 由 display.js 的 DOM 写回完成，
 *   以确保与酒馆助手 formatAsDisplayedMessage 的原生语义（append 节点 + hljs）一致。
 *
 * 围栏化（界面按钮点不动诊断.md 方案 A）：
 *   coverMessage（display.js）在取到 text 后、调用本函数前，仅 rphub 模式用
 *   fenceForMode 做完整 HTML 围栏化 —— 显示通道的覆盖/重算/编辑恢复全部经本函数
 *   写 DOM，围栏化使裸 HTML 界面变成 ```html 代码块 → 酒馆助手 iframe 原样渲染、
 *   脚本可执行、按钮可点。围栏化是渲染层动作，不写回 rph_display 缓存（缓存保持引擎
 *   原始输出，recomputeDecision 重算一致性比较不受影响）。
 *   st 模式不做围栏化（fenceForMode 按 mode 跳过），此处只渲染收到的文本。
 */

/**
 * 将引擎处理后的文本渲染为显示 HTML。
 * @param {object} ctx
 * @param {string} ctx.text        引擎结果（rphub 模式已被 coverMessage 围栏化）
 * @param {number} [ctx.messageId] 消息 id（酒馆助手 message_id 用）
 * @param {object} ctx.msg         消息对象（ST messageFormatting 参数来源）
 * @param {Function} [ctx.messageFormatting] ST messageFormatting（可注入）
 * @returns {{ html: string, via: 'tavern-helper'|'st-native'|'none' }}
 */
export function renderDisplayHtml({ text, messageId = -1, msg = {}, messageFormatting } = {}) {
    const th = (typeof window !== 'undefined') ? window?.TavernHelper : null;
    if (th && typeof th.formatAsDisplayedMessage === 'function') {
        try {
            const html = th.formatAsDisplayedMessage(text, { message_id: typeof messageId === 'number' && messageId >= 0 ? messageId : 'last' });
            return { html, via: 'tavern-helper' };
        } catch (err) {
            console.warn('[rp-hub-compat] 酒馆助手 formatAsDisplayedMessage 失败，回退 ST 原生渲染：', String(err?.message || err));
        }
    }
    if (typeof messageFormatting === 'function') {
        const html = messageFormatting(text, msg.name, msg.is_system, msg.is_user, messageId, {}, false);
        return { html, via: 'st-native' };
    }
    return { html: text, via: 'none' };
}

/** 当前是否使用酒馆助手渲染。 */
export function isTavernHelperAvailable() {
    return typeof window !== 'undefined' && !!(window?.TavernHelper && typeof window.TavernHelper.formatAsDisplayedMessage === 'function');
}
