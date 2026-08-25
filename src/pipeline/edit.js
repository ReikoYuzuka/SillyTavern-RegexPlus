// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/edit.js —— 编辑链路。
 *
 * 编辑打开（ST messageEdit，script.js:8180）：
 *   编辑框填充的是 `chat[id].mes`（本插件的 prompt 视角）→ MutationObserver 监听
 *   #curEditTextarea 出现 → 回填 rph_raw_mes（原始文本）并光标置末（去更新块）。
 *   补丁 2c：回填前校验 rph_raw_mes，疑似显示产物污染时回退用 mes 原文（阻断自复制）。
 *
 * 保存（MESSAGE_EDITED，script.js:8345）：
 *   ST updateMessage 已把编辑内容写入 chat[id].mes（trim + substituteParams 后）→
 *   补丁 2：resolveEditSource 校验 —— 若 ST 回退读了 .mes_text 拿到显示产物（```html 围栏 /
 *   完整 HTML 文档 / rph_display 相等），拒绝当新 raw，回退 rph_raw_mes 自愈式纠错；
 *   正常则同步 rph_raw_mes = 编辑后内容 → 清空双通道结果 → 重算 → saveChatConditional + 覆盖渲染。
 *
 * 取消（MESSAGE_UPDATED，script.js:8277）：走 display.onMessageUpdated 的 coverMessage
 *   恢复显示（mes 未变，rph_display 仍有效）。
 *   补丁 1b：observer 监听 #curEditTextarea 移除 → 调度 ensureMessageRecovered 兜底恢复
 *   （事件链路被时序/守卫吞掉时的二次保险）。
 */

import { runtime } from './runtime.js';
import { processAndCover, ensureMessageRecovered } from './display.js';
import { syncAfterEdit, resolveEditSource, classifyEditedSave } from './pure.js';

let observer = null;

/**
 * 挂载 MutationObserver：监听 #curEditTextarea 出现（回填原文）与移除（编辑关闭 → 兜底恢复）。
 * 只在元素被添加（childList）时触发回填 —— 我们赋值 value 不会再次触发观察器（去更新块）。
 * 补丁 1b：元素被移除（取消/保存/关闭）时调度兜底恢复 —— MESSAGE_UPDATED 事件链路之外的
 * 二次保险（ST 取消路径若被时序/守卫吞掉恢复，这里补一次）。
 */
export function initObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node && node.nodeType === 1 && node.id === 'curEditTextarea') {
                    refillEditTextarea(node);
                }
            }
            for (const node of mutation.removedNodes) {
                if (node && node.nodeType === 1 && node.id === 'curEditTextarea') {
                    scheduleRecover(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

export function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}

/** 回填原始文本并光标置末。 */
function refillEditTextarea(textarea) {
    const $mes = $(textarea).closest('.mes');
    const messageId = Number($mes.attr('mesid'));
    const msg = runtime.chat[messageId];
    if (!msg || typeof msg.extra?.rph_raw_mes !== 'string') return;

    // 补丁 2c：回填前校验 rph_raw_mes —— 若已被「显示产物」污染（历史坏数据/竞态），
    // 回退用 msg.mes（ST 存储层文本）回填并告警，阻断污染自复制。
    const candidate = msg.extra.rph_raw_mes;
    const fill = resolveEditSource(candidate, msg).adopt ? candidate : (typeof msg.mes === 'string' ? msg.mes : candidate);
    if (fill !== candidate) {
        console.warn('[rp-hub-compat] 编辑回填检测到 rph_raw_mes 疑似显示产物污染，改用 mes 原文回填。');
    }

    textarea.value = fill;
    // 光标置末
    textarea.setSelectionRange(fill.length, fill.length);
    // 高度自适应（field-sizing 不支持时）
    if (typeof CSS !== 'undefined' && !CSS.supports('field-sizing', 'content')) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
    }
    $(textarea).trigger('input');
    textarea.focus();
}

/**
 * 补丁 1b：textarea 被移除（编辑取消/保存/关闭）→ 下一帧调度兜底恢复。
 * 下一帧执行：让 ST 的 MESSAGE_UPDATED 事件链路先完成（其 coverMessage 是主恢复路径），
 * ensureMessageRecovered 只作为未被恢复时的二次保险（幂等，见 display.js）。
 * @param {HTMLElement} textarea 被移除的编辑框
 */
function scheduleRecover(textarea) {
    try {
        const $mes = $(textarea).closest('.mes');
        const messageId = Number($mes.attr('mesid'));
        if (!Number.isInteger(messageId) || messageId < 0) return;
        const msg = runtime.chat[messageId];
        if (!msg) return;
        setTimeout(() => {
            ensureMessageRecovered(messageId).catch((err) => {
                console.warn('[rp-hub-compat] 编辑关闭兜底恢复失败：', String(err?.message || err));
            });
        }, 0);
    } catch {
        // 极端情况（DOM 已销毁）静默跳过 —— 事件链路仍负责恢复
    }
}

/**
 * MESSAGE_EDITED：编辑保存后的同步。
 * editedText 取 ST 已写入 chat[id].mes 的值（trim + substituteParams 后，与 ST 存储一致）。
 *
 * 补丁 2（核心）：ST updateMessage 在快速取消/保存交错、`.edit_textarea` 缺失时回退读
 * `.mes_text`.text()（script.js:8082），而插件在 MESSAGE_EDITED/MESSAGE_UPDATED 的 emit 中途
 * 已把引擎显示结果写进 `.mes_text`（display.js coverMessage）—— 回退读到的就是显示产物
 * （```html 围栏 / 完整 HTML 文档 / 显示缓存文本）。resolveEditSource 识别这类污染并拒绝
 * 当新 raw 提交，回退用最后一次干净 rph_raw_mes 重算（commitMessageView 把 mes/swipes 恢复
 * 为干净原文，自愈式纠错 —— 不再永久固化「奇怪代码」）。
 *
 * 补丁 2v3（用户实测「快速操作时预设美化标签全没了」）：快速交错时回退读 `.mes_text.text()`
 * 拿到的是 ST 对原消息的 markdown/DOMPurify 渲染文本 —— `<fox_selc>`/`<think>` 等预设美化
 * 标记被剥 → 引擎按纯正文重跑 → 预设美化（1→2→1 第一阶段）不触发 → 标签全没。该类文本无
 * HTML 产物特征（isDisplayArtifactText 拦不住）。判别：真实保存时 #curEditTextarea 仍在 DOM
 * （messageEditDone script.js:8345 emit 后才 8347 empty），快速取消后 textarea 已被移除
 * （script.js:8256）→ classifyEditedSave 判定 readback → 拒绝当新 raw，回退 rph_raw_mes。
 */
export async function onMessageEdited(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg || typeof msg.mes !== 'string') return;

    // MESSAGE_EDITED 是用户明确点击保存的独占事件：
    // 无论是用户消息还是 AI 消息，msg.mes 均已由 ST updateMessage 写入最新的输入文本（Truth Source）。
    // 信任用户保存的内容，不再通过 DOM 存在性或标签拦截回退为旧原文。
    const source = msg.mes;
    syncAfterEdit(msg, source); // rph_raw_mes 同步为编辑后内容，清空旧显示缓存/模板标记，等待重算

    // F5：isEdit: true 透传 —— 存储通道（general）按原版 script.js:8100 语义，
    // runOnEdit=false 的 general 脚本编辑保存时跳过；显示通道不受 isEdit 影响。
    const result = await processAndCover(messageId, { source, force: true, isEdit: true });
    if (result.handled) {
        await runtime.saveChatConditional();
    }
}
