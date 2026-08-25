// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * stream/stream-service.js —— 流式实时渲染服务（事件接线 + 段渲染 + DOM 呈现 + 正式链路拼合）。
 *
 * 方向 A（用户拍板）：「流式段渲染结果 = 最终成品」——
 *   - 段渲染传**含标签整串**（`<content>正文</content>`，与正式链路同一输入形态，content 标签
 *     由引擎清洗规则自然藏走/拼回）→ 两条链路引擎输入同形、输出同态（防跳变根因）；
 *   - 流式结束后正式链路 coverMessage 渲染整条消息时，把渲染表（renderTable）中已定格的
 *     正文段结果**拼合**进正式引擎输出（正文段区间用流式结果，其余用正式结果）——
 *     不二次渲染正文段（可见层）、无跳变；拼合是渲染层动作，不写 msg.extra / rph_display。
 *
 * 事件接线：
 *   - GENERATION_STARTED      → 先清理残留（无论开关状态）→ 初始化段状态机（读开关/匹配/排除
 *                               配置；continue 前缀基准；impersonate 跳过）
 *   - STREAM_TOKEN_RECEIVED   → 每 token（载荷 = 原始累计文本，DOM 重绘前 emit）喂段检测器；
 *                               段闭合 → 立即定格渲染；段内 → 节流（300ms）持续渲染
 *   - MutationObserver        → 观察聊天容器（ST 每帧 innerHTML 整体替换必然触发）→ 每帧重隐藏
 *                               原文段区域（兄弟节点容器存活，无需重建）；防御性补回容器
 *   - CHARACTER_MESSAGE_RENDERED / GENERATION_STOPPED / MESSAGE_DELETED / CHAT_CHANGED
 *                             → 流式结束衔接 + 中断/删除/切换清理
 *   - GENERATION_ENDED        → 错误/中断路径兜底清理（延时 2s；正常路径由 RENDERED 清理）
 *
 * 关键约束：
 *   - 不写 msg.extra.rph_display / display_text / rph_done（与正式链路 O2 指纹缓存零冲突）；
 *   - 事件注册顺序：本服务用 eventSource.on 追加在监听链尾部（第二部正式链路之后），
 *     清理在正式链路 coverMessage 之后执行（先正式、后清理，防闪烁）；
 *   - 开关默认关闭（rp_hub_stream_render_enabled=false）→ 零介入（所有事件直接 return）。
 */

import { runtime } from '../pipeline/runtime.js';
import { renderDisplayHtml } from '../pipeline/render.js';
import { fenceForMode } from '../engine/html-fence.js';
import { isEditingDom } from '../pipeline/pure.js';
import {
    isStreamRenderEnabled,
    getStreamMatch,
    getStreamExcludes,
} from '../store/settings.js';
import {
    createSegmentDetector,
    feedSegmentDetector,
    SEGMENT_STATE_IN,
    SEGMENT_EVENT_CLOSED,
} from './segment-detector.js';
import {
    renderSegment,
    createSegmentRenderTable,
    spliceSegmentRegions,
    nthNormalizedIndexOf,
} from './segment-render.js';
import { event_types, eventSource, chatElement } from '../st-bridge.js';

/** 段内持续渲染节流间隔（ms；M4：恢复节流持续更新，替代旧「只渲染一次」）。 */
export const STREAM_THROTTLE_MS = 300;

/** STOPPED 路径定格渲染落地封顶（ms）：< GENERATION_ENDED 的 2s 兜底定时器，规避兜底提前清理竞态。 */
const FORCE_CLOSE_RENDER_CAP_MS = 400;

/** 段容器 class（.mes 内 .mes_text 之后的兄弟节点；按 data-occurrence 区分多段）。 */
export const STREAM_SEGMENT_CLASS = 'rph-stream-segment';

/** 原文隐藏标记 class（span 包裹方式：隐藏 span 内是原文文本，清理时移除 span 即还原原文）。 */
export const STREAM_HIDDEN_CLASS = 'rph-stream-hidden';

/** 块级隐藏标记 class（问题 2 方案 B：content 段区域整段 display:none；observer「已隐藏」早退判据）。 */
export const STREAM_HIDDEN_BLOCK_CLASS = 'rph-stream-hidden-block';

/** coverMessage 已应用「跳过」的 .mes_text 标记（问题 3 方案 A：二次 cover 幂等跳过判据）。 */
export const STREAM_SKIP_CLASS = 'rph-stream-skip';

let started = false;
let observer = null;
let observerHits = 0;             // 调试：observer 触发计数
let observerApplies = 0;          // 调试：observer 实际执行恢复计数
let activeDetector = null;        // 当前生成段状态机（GENERATION_STARTED 建，结束清理）
let activeMessageId = null;       // 当前流式消息 id（首个 STREAM_TOKEN_RECEIVED 时确定 = chat.length-1）
let lastRenderAt = 0;             // 段内节流时间戳（M4 节流持续渲染）
let renderTable = null;           // 内存段渲染表（createSegmentRenderTable）
let accumulated = '';             // 累计文本缓冲（M1：continue 前缀 + 事件累计文本）
let messageIdKnown = false;       // 消息 id 是否已确定（首个 token 后为 true）
let streamPrefix = '';            // continue 前缀基准（GENERATION_STARTED 计算；事件载荷拼接前缀后检测）
// 在-flight 渲染登记表（代际令牌模型，修复 F1）：每个 renderAndApply 在入口【同步区】登记
// {gen, messageId} 令牌，finally 必达注销 —— 结构性消除「清理清零计数后在途自减为负」
// （旧 pendingRenders 模型缺陷）与 hung-render 永久污染（悬挂令牌只属于旧代，被谓词过滤）。
// 清理路径不再改写计数：cleanupActive/finalizeActive 的 generationSeq++ 即「作废旧代」全部动作。
let inFlightRenders = [];         // 元素形如 { gen: number, messageId: number }
/** 当前代指定消息是否还有在-flight 渲染（onMessageRendered 推迟 / Drain Barrier / finally 收尾共用谓词）。 */
function hasInFlight(gen, messageId) {
    const mid = Number(messageId);
    return inFlightRenders.some((t) => t.gen === gen && t.messageId === mid);
}
/** 当前代指定消息在-flight 渲染个数（诊断日志用）。 */
function countInFlight(gen, messageId) {
    const mid = Number(messageId);
    return inFlightRenders.filter((t) => t.gen === gen && t.messageId === mid).length;
}
/** 卫生措施：丢弃非当前代的悬挂令牌（hung render 永不注销时防堆积；对当前代语义无影响）。 */
function sweepStaleInFlight() {
    if (inFlightRenders.length > 0 && inFlightRenders.some((t) => t.gen !== generationSeq)) {
        inFlightRenders = inFlightRenders.filter((t) => t.gen === generationSeq);
    }
}
// 已作废消息 id 集合（N-E5 幽灵条目防线）：MESSAGE_DELETED/SWIPED/EDITED 已把该消息从渲染表
// 删除但表对象尚存，在途渲染恢复后 renderTable.set 会把幽灵条目复活 —— 此处登记作废号，
// 渲染恢复段复查后放弃回写。cleanupActive/finalizeActive 整表清空。
const invalidatedMessages = new Set();
let cleanupDeferred = false;      // onMessageRendered 因在途渲染推迟清理的标志（本代本消息在途归零时处理）
let recoverScheduled = false;     // 补发 RENDERED 的防重入标志
let cleanupTimer = null;          // GENERATION_ENDED 兜底清理定时器（错误路径无 RENDERED 时兜底）
let cleanupTimerMessageId = null; // 兜底定时器绑定的消息 id（防误清新生成状态）
let activeMode = null;            // 当前角色模式（硬约束 1：仅 'rphub' 才介入流式渲染；null/其它 = 不介入）
let activeRoute = 'include';      // 匹配作用（排除模式特性）：'include'＝选中标签交 RP（现行）；'exclude'＝选中标签区间交酒馆原生（流式层丢弃事件，不渲染不定格）
let generationSeq = 0;            // 生成代际计数（异步模式解析竞态守卫：清理/新生成时推进使在途解析失效）
let finalizedSkipRegistry = new Map(); // 定格段注册表（问题 3 方案 A：跨生成存活，供后续 coverMessage 跳过决策）
let isPerformingDomSurgery = false; // 静默操作标志位（Quiet Flag Gate：内部 DOM 手术时置 true，Observer 首行直接跳过）
let observerRafPending = false;    // Observer 合并 rAF 标志位，防止高频 Token 下级联微顿

/* ---------- 完整记录器（诊断：记录每一步渲染流程到 window.__rphStreamLog） ---------- */

/** 记录上限（防内存膨胀；超限丢最旧）。 */
const LOG_LIMIT = 500;

/** 记录一条渲染流程日志（存 window.__rphStreamLog + console.debug 摘要）。 */
function logStream(kind, detail) {
    try {
        const entry = { kind, t: Date.now(), ...detail };
        const w = typeof window !== 'undefined' ? window : null;
        if (w) {
            w.__rphStreamLog = w.__rphStreamLog || [];
            w.__rphStreamLog.push(entry);
            if (w.__rphStreamLog.length > LOG_LIMIT) w.__rphStreamLog.splice(0, w.__rphStreamLog.length - LOG_LIMIT);
        }
        const summary = detail && detail.summary ? detail.summary : '';
        console.debug(`[rp-hub-compat][流式日志] ${kind}${summary ? ' ' + summary : ''}`);
    } catch {
        // 记录器失败不阻断主流程
    }
}

/**
 * 导出完整记录（控制台 / CDP 读取用）：返回全部日志条目。
 * 挂到 window 上，F12 里可 window.__rphExportLog() 查看 / window.__rphStreamLog 直接读。
 */
function installLogExports() {
    try {
        const w = typeof window !== 'undefined' ? window : null;
        if (w) {
            w.__rphStreamLog = w.__rphStreamLog || [];
            w.__rphExportLog = () => JSON.stringify(w.__rphStreamLog, null, 2);
            w.__rphClearLog = () => { w.__rphStreamLog.length = 0; };
        }
    } catch {
        // 忽略
    }
}

/* ---------- 工具 ---------- */

/** 当前是否应运行（开关开启 + 服务已启动 + 当前角色为 rphub 卡）。
 * 硬约束 1：只对 rp 卡（formatDetail === 'rphub'，与正式链路 runtime.getMode() 同口径；
 * 自动判定或手动标记任一命中即为 rp 卡）介入流式渲染；st / unknown 卡即使开关打开
 * 也绝不介入（走原版渲染零影响）。 */
function shouldRun() {
    return started && isStreamRenderEnabled() && activeMode === 'rphub';
}

/** 找 text 中 from 起的第 n 次（1 起）匹配。返回索引或 -1。 */
function nthIndexOf(str, sub, n, from = 0) {
    if (!sub) return -1;
    if (n <= 1) return str.indexOf(sub, from);
    let idx = from;
    let found = 0;
    while (idx !== -1) {
        idx = str.indexOf(sub, idx);
        if (idx === -1) return -1;
        found++;
        if (found >= n) return idx;
        idx += sub.length;
    }
    return -1;
}

/** 取某消息的 .mes_text（DOM 定位；不存在 → null）。document.querySelector 优先（mesid 权威），
 * chatElement 兜底（两者同一 DOM，querySelector 避免 chatElement 缓存/错位问题）。 */
function getMesTextElement(messageId) {
    try {
        const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (textEl) {
            const jq = (typeof window !== 'undefined' && window.$ && typeof window.$ === 'function') ? window.$ : null;
            if (jq) return jq(textEl);
            // 无 jQuery：返回最小可用封装（真实 ST 环境必有 jQuery，此处仅防御）
            return {
                length: 1,
                0: textEl,
                append: (node) => { textEl.appendChild(node); return textEl; },
                children: () => ({ length: 0 }),
                find: () => ({ length: 0 }),
                hasClass: () => false,
            };
        }
    } catch {
        // 忽略，走 chatElement 兜底
    }
    try {
        const $mes = chatElement?.find?.(`.mes[mesid="${messageId}"]`);
        const $text = $mes?.find?.('.mes_text');
        if ($text && $text.length) return $text;
    } catch {
        // 忽略
    }
    return null;
}

/**
 * 隐藏 .mes_text 内已渲染段的原文区域（幂等；ST 每帧重绘恢复原文 → observer 每帧重新隐藏）。
 *
 * 问题 2 方案 B（用户拍板，根治）：content 段原文在 .mes_text 内**整段 display:none**
 * （块级隐藏 hideRangeByBlocks），只由下方兄弟容器（.rph-stream-segment）呈现渲染 UI ——
 * 隐藏不再做逐帧文本手术；块级隐藏带「已隐藏」早退（observer 自触发二轮不再重复改 DOM），
 * 消除「ST 每帧重绘 ↔ 隐藏」的逐帧竞争。
 *
 * 定位策略（实测修正）：
 *   - ST 流式中途渲染 .mes_text 时，`<content>` 标签【不显示在 textContent 里】（ST 原生
 *     通道处理/剥离）→ 不能依赖标签定位；
 *   - 因此用【正文内容定位】：段原始文本 raw 去掉标签后的正文【开头片段】做**空白归一匹配**
 *     （normalizedIndexOf：markdown 渲染后块级元素间换行消失/空白折叠，直接 indexOf 会失配，
 *     诊断问题 2 根因），定位段起点；闭合段再用正文【尾部片段】定位段终点（尾部保留给原版）。
 *   - 优先标签定位（原始/转义变体），失败后回退内容定位。
 *
 * S3：occurrence 支持定位第 N 个段区域（多段依次）。
 * M6：闭合段且闭合标签被剥离时，隐藏范围止于正文末尾 —— 正文之后的尾部（选项/其余文本）
 *     保留给原版通道。
 * 补丁项（诊断 2.2③）：head 过短守卫已修（<3 字符时整段作锚，配合归一匹配）；hideRangeInDom
 * 偏移 bug 已修（跳过节点也推进 offset）；块级隐藏「已隐藏」早退。
 *
 * @param {JQuery|object} $mesText .mes_text 元素
 * @param {object} [opts]
 * @param {string} [opts.startTag] 起始标签（如 <content>；空 = 段起点在消息开头）
 * @param {string} [opts.endTag] 闭合标签（如 </content>）
 * @param {string} [opts.raw] 段原始文本（含标签整串，如 <content>正文</content>）；用于
 *   标签定位失败时的正文内容定位兜底
 * @param {number} [opts.occurrence] 段出现序号（0 起；定位第 N 个段区域）
 * @param {boolean} [opts.closed] 是否已闭合定格（M6：闭合后隐藏范围止于正文末尾）
 * @param {boolean} [quiet] 静默模式（observer 每帧调用，跳过逐帧日志，L3 性能）
 * @returns {boolean} 是否执行了隐藏（找不到边界 → false）
 */
function hideSegmentRange($mesText, { startTag = '', endTag = '', raw = '', occurrence = 0, closed = false, match = '' } = {}, quiet = false) {
    if (!$mesText || !$mesText.length) return false;
    isPerformingDomSurgery = true;
    try {
        const container = $mesText[0];
        const full = container.textContent ?? '';
        let startIdx = -1;
        let endIdx = -1;

        // 策略 1：标签定位（原始或转义变体；occurrence 定位第 N 段）。
        // match==='last'（贪婪匹配至末标签）：start/end 定位改用「最后一次出现」口径，
        // 与段容器内容（贪婪段吞到文末最后一个闭合）保持一致 —— 否则隐藏范围只到首个
        // 闭合标签，中间原文残留可见。
        if (startTag || endTag) {
            if (startTag) {
                const s = match === 'last' ? full.lastIndexOf(startTag) : nthIndexOf(full, startTag, occurrence + 1);
                if (s !== -1) startIdx = s;
            } else {
                startIdx = 0; // 单闭合标签：段起点在消息开头
            }
            if (endTag) {
                if (match === 'last') {
                    const e = full.lastIndexOf(endTag);
                    if (e !== -1 && e >= startIdx) endIdx = e + endTag.length;
                } else {
                    const from = startIdx >= 0 ? startIdx + (startTag ? startTag.length : 0) : 0;
                    const e = nthIndexOf(full, endTag, occurrence + 1, from);
                    if (e !== -1) endIdx = e + endTag.length;
                }
            } else if (startIdx >= 0) {
                endIdx = full.length; // 无闭合 → 当前末尾
            }
            // 标签定位成功（startIdx 和 endIdx 都有效）→ 用之（块级隐藏优先，文本手术兜底）
            if (startIdx >= 0 && endIdx > startIdx) {
                const r = hideRangeByBlocks(container, startIdx, endIdx);
                if (r === 'already') return false; // 本帧已块级隐藏 → 早退（防自触发二轮）
                if (r === true) return true;
                return hideRangeInDom(container, full, startIdx, endIdx);
            }
            if (!quiet) logStream('hide-range', { summary: `标签定位失败 startIdx=${startIdx} endIdx=${endIdx}（.mes_text 内无标签）`, ok: false, startIdx, endIdx });
        }

        // 策略 2：正文内容定位兜底（标签被 ST 剥离时）—— 空白归一匹配（补丁项：修 head 过短/换行失配）。
        if (raw && startTag) {
            const innerStart = raw.indexOf(startTag);
            if (innerStart !== -1) {
                let inner = raw.slice(innerStart + startTag.length);
                if (endTag) {
                    const ie = inner.indexOf(endTag);
                    if (ie !== -1) inner = inner.slice(0, ie);
                }
                const trimmed = inner.trim();
                if (trimmed.length > 0) {
                    // 开头片段：前 12 字符（归一匹配处理换行/折叠空白）；过短（<3）则整段作锚
                    const head = trimmed.slice(0, 12).length >= 3 ? trimmed.slice(0, 12) : trimmed;
                    const idx = nthNormalizedIndexOf(full, head, occurrence + 1);
                    if (idx !== -1) {
                        // 段结束：有闭合标签 → 找闭合后的位置；无（IN 态）→ 当前末尾；
                        // 闭合标签被剥离（M6）→ 用正文尾部片段定位段终点（尾部保留）
                        let endIdx2 = full.length;
                        if (endTag) {
                            const closeIdx = full.indexOf(endTag, idx);
                            if (closeIdx !== -1) {
                                endIdx2 = closeIdx + endTag.length;
                            } else if (closed) {
                                const tail = trimmed.slice(-12).trim();
                                if (tail.length > 0) {
                                    const tIdx = nthNormalizedIndexOf(full, tail, occurrence + 1, idx + 1);
                                    endIdx2 = tIdx !== -1 && tIdx > idx
                                        ? Math.min(full.length, tIdx + tail.length)
                                        : Math.min(full.length, idx + trimmed.length);
                                } else {
                                    endIdx2 = Math.min(full.length, idx + trimmed.length);
                                }
                            }
                        }
                        if (endIdx2 > idx) {
                            const r = hideRangeByBlocks(container, idx, endIdx2);
                            if (r === 'already') return false; // 本帧已块级隐藏 → 早退（防自触发二轮）
                            if (r === true) return true;
                            return hideRangeInDom(container, full, idx, endIdx2);
                        }
                    }
                    if (!quiet) logStream('hide-range', { summary: `内容定位失败 head=${JSON.stringify(head)} idx=${idx}（.mes_text 内无该正文开头）`, ok: false, head, idx });
                }
            }
        }
        return false;
    } finally {
        isPerformingDomSurgery = false;
    }
}

/* ---------- 块级隐藏（问题 2 方案 B：content 段区域整段 display:none） ---------- */

/** 块级元素标签白名单（markdown 渲染的正文容器）。 */
const BLOCK_TAGS = new Set(['P', 'DIV', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'FORM', 'FIELDSET']);

function isBlockElement(el) {
    return !!el && typeof el.tagName === 'string' && BLOCK_TAGS.has(el.tagName.toUpperCase());
}

/** 找文本节点所在（最近的）块级祖先（container 之下）。 */
function blockParentOf(node, container) {
    let cur = node?.parentElement ?? null;
    while (cur && cur !== container) {
        if (isBlockElement(cur)) return cur;
        cur = cur.parentElement;
    }
    return null;
}

/** 收集 container 内从 startBlock 到 endBlock（含）的文档序块级元素。 */
function collectBlocksBetween(container, startBlock, endBlock) {
    const blocks = [];
    const w = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
        const el = w.currentNode;
        if (isBlockElement(el)) blocks.push(el);
    }
    const si = startBlock ? blocks.indexOf(startBlock) : 0;
    const ei = endBlock ? blocks.indexOf(endBlock) : blocks.length - 1;
    if (si === -1 || ei === -1 || si > ei) return [];
    return blocks.slice(si, ei + 1);
}

/**
 * 块级隐藏：把 [startIdx, endIdx) 覆盖的块级元素整段 display:none（+ 标记 class）。
 * 返回：true = 本次执行了隐藏；'already' = 覆盖块已全部带隐藏标记（本帧已隐藏，
 * observer 自触发二轮）→ 不改 DOM；false = 定位失败（无块级祖先/无覆盖块）→ 调用方回退
 * hideRangeInDom。
 */
function hideRangeByBlocks(container, startIdx, endIdx) {
    if (endIdx <= startIdx) return false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null;
    let endNode = null;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.textContent.length;
        const nodeStart = offset;
        const nodeEnd = offset + len;
        offset = nodeEnd;
        if (startNode === null && nodeEnd > startIdx) startNode = node;
        if (nodeStart < endIdx) endNode = node;
        if (startNode && nodeEnd >= endIdx) break;
    }
    if (!startNode) return false;
    const startBlock = blockParentOf(startNode, container);
    const endBlock = blockParentOf(endNode || startNode, container);
    if (!startBlock) return false;
    const blocks = collectBlocksBetween(container, startBlock, endBlock);
    if (blocks.length === 0) return false;
    if (blocks.every((el) => el.classList.contains(STREAM_HIDDEN_BLOCK_CLASS))) return 'already'; // 已隐藏早退（防自触发二轮）
    for (const el of blocks) {
        el.style.display = 'none';
        el.classList.add(STREAM_HIDDEN_BLOCK_CLASS);
    }
    return true;
}

/**
 * 文本节点手术兜底（块级定位失败时）：把 [startIdx, endIdx) 文本区域用隐藏 span 包裹（保留节点结构）。
 * 与旧实现（直接删除文本）的区别：隐藏 span 内是原文文本 —— 清理时移除 span 即还原原文
 * （M3：错误/中断路径无后续重绘/覆盖时，原文不再永久丢失）。
 * 补丁项（诊断 2.2③）：已修偏移 bug —— 跳过「已在隐藏 span 内」节点时**同样推进 offset**
 * （textContent 含隐藏文本，不推进会导致后续节点偏移错位，observer 二次回调误伤）。
 */
function hideRangeInDom(container, full, startIdx, endIdx) {
    if (endIdx <= startIdx) return false;
    // 先收集区间重叠的文本节点，再统一替换（避免 TreeWalker 遍历中断）
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const targets = [];
    let offset = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.textContent.length;
        // 已在隐藏 span 内（本帧已包裹）→ 跳过，防嵌套；修复：跳过也要推进 offset
        if (node.parentElement && node.parentElement.closest(`.${STREAM_HIDDEN_CLASS}`)) {
            offset += len;
            continue;
        }
        const nodeStart = offset;
        const nodeEnd = offset + len;
        offset = nodeEnd;
        if (nodeEnd <= startIdx || nodeStart >= endIdx) continue; // 不在区域内
        const s = Math.max(0, startIdx - nodeStart);
        const e = Math.min(len, endIdx - nodeStart);
        if (s >= e) continue;
        targets.push({ node, s, e });
    }
    if (targets.length === 0) return false;
    for (const { node, s, e } of targets) {
        const text = node.textContent;
        const before = text.slice(0, s);
        const inside = text.slice(s, e);
        const after = text.slice(e);
        const span = document.createElement('span');
        span.className = STREAM_HIDDEN_CLASS;
        span.textContent = inside;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(span);
        if (after) frag.appendChild(document.createTextNode(after));
        node.parentNode.replaceChild(frag, node);
    }
    return true;
}

/**
 * 幂等回插：把段渲染结果写进 .mes 内 .mes_text 之后的兄弟节点（S2）+ 隐藏原文段区域。
 * S2（审查 S2）：容器挂 .mes 内 .mes_text 之后 —— ST 每帧 innerHTML 只替换 .mes_text 内部，
 * 兄弟节点天然存活 → 闭合定格结果稳定显示；observer 不再每帧重建（仅防御性补回）。
 * S3：容器按 data-occurrence 键控（每条消息多个容器，如 rph-stream-segment-0/1/...）。
 *
 * @param {number} messageId
 * @param {string} html 段渲染 HTML（含标签整串渲染结果，与正式链路同态）
 * @param {string} startTag 起始标签（隐藏定位用；advanced 无标签 → ''）
 * @param {string} endTag 闭合标签
 * @param {string} raw 段原始文本（含标签整串；内容定位隐藏用）
 * @param {number} occurrence 段出现序号
 * @param {boolean} closed 是否闭合定格（M6：闭合后隐藏范围止于正文末尾）
 * @param {string} [match] 锚定方向（贪婪匹配至末标签）：'last' ＝ 原文隐藏定位取最后一次出现
 */
function applyStreamDom(messageId, html, startTag, endTag, raw, occurrence = 0, closed = false, match = '') {
    const $mesText = getMesTextElement(messageId);
    if (!$mesText || !$mesText.length) return false;
    if (isEditingDom($mesText)) return false;
    // 1. 隐藏原文段区域（标准模式标签对；raw 供内容定位兜底）
    let hidden = false;
    if (startTag || endTag) hidden = hideSegmentRange($mesText, { startTag, endTag, raw, occurrence, closed, match });
    // 2. 兄弟节点渲染结果（.mes 内 .mes_text 之后；幂等）
    const mesEl = $mesText[0].parentElement;
    if (!mesEl) return hidden;
    const occ = typeof occurrence === 'number' ? occurrence : 0;
    const selector = `.${STREAM_SEGMENT_CLASS}[data-occurrence="${occ}"]`;
    const existing = mesEl.querySelector(selector);
    if (existing) {
        // 幂等：内容一致跳过（对齐 coverSkipDecision「一致跳过」语义）
        if (existing.dataset.html === html) return hidden;
        existing.dataset.html = html;
        existing.innerHTML = html;
        return hidden;
    }
    const node = document.createElement('div');
    node.className = STREAM_SEGMENT_CLASS;
    node.dataset.occurrence = String(occ);
    node.dataset.html = html;
    node.innerHTML = html;
    const textNode = mesEl.querySelector('.mes_text');
    if (textNode) textNode.after(node);
    else mesEl.appendChild(node);
    return hidden;
}

/** 清理某消息的临时段容器与隐藏标记（流式结束/中断/删除）。原文由隐藏标记还原。
 * 导出供 display.js coverMessage 拼合后调用：content 已拼回 .mes_text，兄弟容器预览使命完成。 */
export function cleanupMessageDom(messageId) {
    try {
        const mes = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (mes) {
            mes.querySelectorAll(`.${STREAM_SEGMENT_CLASS}`).forEach((n) => n.remove());
            const textEl = mes.querySelector('.mes_text');
            // 还原原文：隐藏 span 内是原文文本（span 包裹方式 → 移除 span 即还原）
            textEl?.querySelectorAll(`span.${STREAM_HIDDEN_CLASS}`).forEach((span) => {
                span.replaceWith(document.createTextNode(span.textContent));
            });
            // 还原块级隐藏（问题 2 方案 B：display:none → 恢复）
            textEl?.querySelectorAll(`.${STREAM_HIDDEN_BLOCK_CLASS}`).forEach((el) => {
                el.style.display = '';
                el.classList.remove(STREAM_HIDDEN_BLOCK_CLASS);
            });
        }
    } catch {
        // 忽略，走 chatElement 兜底
    }
    try {
        const $mes = chatElement?.find?.(`.mes[mesid="${messageId}"]`);
        $mes?.find?.(`.${STREAM_SEGMENT_CLASS}`).remove();
        $mes?.find?.(`.mes_text span.${STREAM_HIDDEN_CLASS}`).each(function () {
            $(this).replaceWith(this.textContent);
        });
        $mes?.find?.(`.mes_text .${STREAM_HIDDEN_BLOCK_CLASS}`).each(function () {
            $(this).css('display', '');
            $(this).removeClass(STREAM_HIDDEN_BLOCK_CLASS);
        });
    } catch {
        // 忽略
    }
}

/* ---------- 段渲染（节流持续更新 + 闭合定格） ---------- */

/** 当前匹配配置的标准标签对（basic 模式；advanced → []）。 */
function currentTagRules() {
    try {
        const match = getStreamMatch();
        return match?.mode === 'basic' && Array.isArray(match.rules) ? match.rules : [];
    } catch {
        return [];
    }
}

/**
 * 渲染一个段并写入 DOM + 渲染表。
 * S1：传给 RP 的是【含标签整串】（如 `<content>正文</content>`，与正式链路同一输入形态，
 * content 标签由引擎清洗规则自然藏走/拼回）→ 两条链路引擎输入同形、输出同态。
 * raw（含标签整串）同时供原文内容定位隐藏；闭合后停止传 RP，尾部交回原版。
 * S3：occurrence 供段容器/渲染表/隐藏定位键控。
 */
async function renderAndApply(segmentText, messageId, segmentType, ruleIndex, occurrence = 0) {
    if (!segmentText) return;
    // 代际令牌捕获必须在本函数首个 await 之前（同步区）：此后 cleanup 推进 generationSeq 也不会误标自己。
    const myGen = generationSeq;
    const myMid = Number(messageId);
    const myToken = { gen: myGen, messageId: myMid };
    inFlightRenders.push(myToken);
    let settled = false;
    try {
        // 标签信息：basic 模式按 ruleIndex 取当前规则；advanced 无标签 → 直接整段
        const rules = currentTagRules();
        const rule = rules[ruleIndex];
        const startTag = rule?.start || '';
        const endTag = rule?.end || '';

        console.debug(`[rp-hub-compat] 流式段渲染 → RP：type=${segmentType} 标签=${startTag || '(无)'}~${endTag || '(无)'} 段前${Math.min(30, segmentText.length)}字=${JSON.stringify(segmentText.slice(0, 30))}`);
        const out = await renderSegment({
            text: segmentText, // S1：含标签整串（不再剥离；与正式链路同形）
            messageId,
            excludes: getStreamExcludes(),
            runtime,
            render: renderDisplayHtml,
            fence: fenceForMode,
        });
        if (!out) {
            console.warn(`[rp-hub-compat] 流式段渲染失败：renderSegment 返回 null（type=${segmentType}）`);
            return;
        }
        // 竞态：段内渲染在途期间段已闭合定格（closed 条目先入表）→ 本段内渲染作废，
        // 不再覆盖容器/表（闭合定格是权威结果）
        if (segmentType === 'in' && renderTable) {
            const list = renderTable.get(messageId);
            if (list.some((e) => (e.occurrence ?? 0) === occurrence && e.closed === true)) {
                console.debug(`[rp-hub-compat] 流式段内渲染作废：段已闭合定格（occ=${occurrence}）。`);
                return;
            }
        }
        console.debug(`[rp-hub-compat] 流式段渲染完成：via=${out.via} html前40字=${JSON.stringify(out.html.slice(0, 40))}`);
        // SR2 修复：停止/切聊竞态下 renderTable 可能已被置 null → 判空防御（避免 NPE 被吞）
        if (!renderTable) return;
        // R1 跨代替换防线：本渲染若登记于旧代（期间发生 cleanupActive/finalizeActive 推进代际），
        // 其结果不得写入当前注册表——否则会以同 (segmentType, occurrence) 原地顶替新一代条目，
        // 最终拼合显示上一代中断文本（实验 B7/B10 实证）。验证报告原列为"非必需"，实验后升级为必需。
        if (myGen !== generationSeq) {
            console.debug(`[rp-hub-compat] 流式段渲染作废：代际已推进（渲染时 ${myGen}，当前 ${generationSeq}），放弃回写。`);
            return;
        }
        // N-E5 幽灵条目防线：消息已被删除/swipe/edit 作废（渲染表条目已删但表对象尚存）→
        // 不得把条目写回渲染表或向其 DOM 回插，否则复活幽灵段。
        if (invalidatedMessages.has(myMid)) {
            console.debug(`[rp-hub-compat] 流式段渲染作废：消息 #${myMid} 已被删除/切换，放弃回写。`);
            return;
        }
        // raw 保留含标签整串（供原文内容定位隐藏）；engineText 供正式链路拼合（S1）
        const matchMode = rule?.match === 'last' ? 'last' : '';
        renderTable.set(messageId, segmentType, out.html, segmentText, {
            startTag, endTag, occurrence,
            engineText: out.engineText,
            closed: segmentType !== 'in',
            match: matchMode, // 贪婪匹配至末标签：原文隐藏定位需同口径（last）
        });
        const hidden = applyStreamDom(messageId, out.html, startTag, endTag, segmentText, occurrence, segmentType !== 'in', matchMode);
        console.debug(`[rp-hub-compat] 流式 DOM 回插：occ=${occurrence} segs节点更新，原文隐藏=${hidden ? '是' : '否'}（.mes_text 内按${startTag || '内容'}定位）`);
        logStream('render', {
            summary: `type=${segmentType} occ=${occurrence} hidden=${hidden ? '是' : '否'} via=${out.via}`,
            segmentType, occurrence, hidden, via: out.via,
            engineText: out.engineText.slice(0, 40),
            htmlHead: out.html.slice(0, 60),
            startTag, endTag,
        });
        settled = true;
    } finally {
        // 注销自身令牌（必达；代际令牌模型下结构性不可能负数/漏减）
        const tokenIdx = inFlightRenders.indexOf(myToken);
        if (tokenIdx !== -1) inFlightRenders.splice(tokenIdx, 1);
        if (settled && segmentType !== 'in') maybeScheduleRecover(messageId);
        // 清理推迟处理（谓词 = 本代本消息在途归零）：若含闭合定格则 maybeScheduleRecover 已排定补发
        // （其 RENDERED 会走 onMessageRendered 收尾）；否则（全为段内渲染）正式覆盖已完成、
        // 无跳过/拼合需求 → 直接 finalizeActive（问题 3 方案 A：保留定格成品，防泄漏）
        if (cleanupDeferred && !hasInFlight(generationSeq, myMid)) {
            cleanupDeferred = false;
            if (!recoverScheduled) finalizeActive();
        }
    }
}

/** 处理一次段检测结果（events + 段内文本）。节流门控在 onStreamToken（段内持续渲染）。
 *  排除模式（activeRoute==='exclude'）：检出的区间保持原样交酒馆原生通道 —— 本函数整体
 *  短路（不 renderAndApply / 不定格 / 不入表 / 不产令牌）；正式链路由 runtime 把排除规则
 *  转译为附加 cleanRules（藏走原样拼回）完成"区间内不进 RP 引擎"。 */
async function processDetection(feed) {
    if (!activeDetector || activeMessageId === null) return;
    if (activeRoute === 'exclude') return; // 排除模式：流式层零动作
    // 闭合事件 → 立即定格渲染（用户方案：闭合后停止传 RP，尾部交回原版）
    for (const ev of feed.events) {
        if (ev.type === SEGMENT_EVENT_CLOSED) {
            lastRenderAt = 0; // 重置节流（新段）
            console.debug(`[rp-hub-compat] 流式段闭合检测：rule=${ev.ruleIndex} occ=${ev.occurrence} 段=${JSON.stringify(ev.segment.slice(0, 40))}`);
            await renderAndApply(ev.segment, activeMessageId, `closed-${ev.ruleIndex}`, ev.ruleIndex, ev.occurrence ?? 0);
        }
    }
    // 段内：节流持续渲染（M4，每 STREAM_THROTTLE_MS 一次；规则索引/出现序号由检测器透出，
    // 不再 findIndex(r => r.start) 猜测 —— S3）
    if (feed.state === SEGMENT_STATE_IN && feed.inSegmentText) {
        const ruleIndex = typeof feed.currentRuleIndex === 'number' && feed.currentRuleIndex >= 0 ? feed.currentRuleIndex : 0;
        const occurrence = typeof feed.currentOccurrence === 'number' && feed.currentOccurrence >= 0 ? feed.currentOccurrence : 0;
        console.debug(`[rp-hub-compat] 流式段内渲染（节流）：rule=${ruleIndex} occ=${occurrence}`);
        await renderAndApply(feed.inSegmentText, activeMessageId, 'in', ruleIndex, occurrence);
    }
}

/**
 * S1 竞态兜底：闭合定格渲染若在正式链路 cover 之后才完成（罕见：闭合标签落在最后一个
 * token 且渲染慢于正式引擎跑完），补发一次 CHARACTER_MESSAGE_RENDERED —— 正式链路
 * coverMessage 会用最新定格结果重新拼合。防重入：recoverScheduled；幂等：拼合结果一致
 * 或 DOM 已引擎渲染且无流式段时 coverSkipDecision 自然跳过。
 */
function maybeScheduleRecover(messageId) {
    if (recoverScheduled) return;
    if (Number(messageId) !== activeMessageId) return;
    try {
        const msg = runtime.chat?.[messageId];
        if (!msg?.extra?.rph_done) return; // 正式链路尚未覆盖 → 无需补发（正常路径，cover 会读到定格表）
    } catch {
        return;
    }
    recoverScheduled = true;
    setTimeout(() => {
        recoverScheduled = false;
        if (activeMessageId === Number(messageId) && renderTable) {
            console.debug(`[rp-hub-compat] 流式实时渲染：闭合定格晚于正式覆盖 → 补发 RENDERED 重新拼合（msg #${messageId}）。`);
            // type 传 'normal'（与正式链路常规补发一致），避免第三方监听者遇到未知 type 分支
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
        }
    }, 0);
}

/* ---------- 事件处理器 ---------- */

/**
 * GENERATION_STARTED：初始化段状态机。
 * M3：先 cleanupActive（无论开关状态）—— 清上一生成残留，防开关关闭时的脏状态泄漏。
 * M5：impersonate 生成无 DOM 消息目标（ST 输出到 textarea）→ 跳过段接管。
 * 硬约束 1：异步解析当前角色模式（runtime.getMode() = formatDetail）——仅 rphub 卡才建
 * 检测器/接管；st / unknown 卡即使开关打开也绝不介入（走原版渲染零影响）。
 * 注：STREAM_TOKEN_RECEIVED 载荷是累计文本（script.js:3836），模式解析晚几个 token 不丢段
 * （首个被处理的 token 已含全量文本，检测器 advance 整体扫描）。
 */
function onGenerationStarted(type) {
    cleanupActive();
    if (!started) return;
    if (type === 'impersonate') {
        console.debug('[rp-hub-compat] 流式实时渲染：impersonate 生成无消息 DOM，跳过段接管。');
        return;
    }
    if (!isStreamRenderEnabled()) return; // 开关关 → 零介入（activeMode 保持 null）
    const mySeq = ++generationSeq; // 竞态守卫：清理/新生成会推进 generationSeq → 在途解析失效
    resolveStreamMode(type, mySeq).catch((err) => {
        console.warn('[rp-hub-compat] 流式实时渲染：模式解析失败（不介入流式渲染）：', String(err?.message || err));
    });
}

/** 异步解析模式并（仅 rphub）初始化段状态机。竞态守卫：解析期间代际已推进 → 丢弃。 */
async function resolveStreamMode(type, mySeq) {
    let mode = null;
    try {
        mode = await runtime.getMode();
    } catch {
        mode = null;
    }
    if (mySeq !== generationSeq) return; // 期间发生新 GENERATION_STARTED / 清理 → 丢弃
    activeMode = mode;
    if (mode !== 'rphub') {
        console.debug(`[rp-hub-compat] 流式实时渲染：非 rphub 卡（mode=${mode}）→ 不介入流式渲染（原版渲染）。`);
        return;
    }
    const match = getStreamMatch();
    activeRoute = match.route === 'exclude' ? 'exclude' : 'include'; // 排除模式路由（本代生效）
    streamPrefix = computeContinuePrefix(type, match); // M1
    activeDetector = createSegmentDetector({ match, prefix: streamPrefix });
    renderTable = createSegmentRenderTable();
    accumulated = '';
    messageIdKnown = false;
    lastRenderAt = 0;
    console.debug(`[rp-hub-compat] 流式实时渲染：生成开始（rphub 卡，匹配模式=${match.mode}${match.route === 'exclude' ? '/排除作用' : ''}${streamPrefix ? '，含 continue 前缀' : ''}，等首个 token 确定消息）`);
}

/** M1：continue 场景的前缀基准 —— 旧消息最后一个标签边界之后的内容。
 *   - 旧消息尾部是未闭合的起始标签（续写点）→ 前缀含它，续写闭合后拼出完整段（不丢段）；
 *   - 旧消息尾部是已闭合段 → 前缀从闭合标签后开始（干净起点，不重复渲染旧段）；
 *   - 无标签边界 → 空前缀（检测从流式文本起点开始）。
 * 注：事件载荷（STREAM_TOKEN_RECEIVED）不含 continue 前缀（script.js:3836 vs 3837），
 * 必须自行拼接。chat[lastMesId].mes 是整条旧消息，取尾部作近似前缀（与 continue_mag 对齐）。
 */
function computeContinuePrefix(type, match) {
    if (type !== 'continue') return '';
    try {
        const chat = runtime.chat;
        const last = Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;
        const oldMes = last && typeof last.mes === 'string' ? last.mes : '';
        if (!oldMes) return '';
        const rules = match?.mode === 'basic' && Array.isArray(match.rules) ? match.rules : [];
        let from = -1;
        for (const r of rules) {
            if (r.start) {
                const i = oldMes.lastIndexOf(r.start);
                if (i > from) from = i;
            }
            if (r.end) {
                const i = oldMes.lastIndexOf(r.end);
                if (i >= 0 && i + r.end.length > from) from = i + r.end.length;
            }
        }
        if (from <= 0) return ''; // 无标签边界（或边界在消息开头）→ 无前缀
        return oldMes.slice(from);
    } catch {
        return '';
    }
}

/** STREAM_TOKEN_RECEIVED：每 token（载荷 = 累计文本）累积 + 喂检测器（M1：前缀 + 载荷）。 */
function onStreamToken(incrementalText) {
    if (!shouldRun() || !activeDetector) return;
    const text = String(incrementalText ?? '');

    // 首个 token：消息已由 onStartStreaming 创建（script.js:3802 saveReply → messageId=chat.length-1）
    // L5：消息 id 判定先于空载荷检查（空 token 不影响 id 确定）
    if (!messageIdKnown) {
        try {
            const chat = runtime.chat;
            activeMessageId = Array.isArray(chat) ? Math.max(0, chat.length - 1) : 0;
            messageIdKnown = true;
            console.debug(`[rp-hub-compat] 流式实时渲染：消息 #${activeMessageId} 确定`);
        } catch {
            activeMessageId = 0;
            messageIdKnown = true;
        }
    }
    if (!text) return;

    // ⚠️ 载荷是【累计文本】（script.js:3836 emit(STREAM_TOKEN_RECEIVED, text) 的 text 是生成器
    // 累计结果，实测 token[0]='\n【开始思考】' token[1]='\n【开始思考】...' 长度递增）→
    // **覆盖** accumulated，绝不能 +=（会双重累积爆炸）；M1：continue 前缀 + 载荷（前缀不在载荷内）
    accumulated = streamPrefix + text;
    // 记录：token + 当前 .mes_text 状态（诊断）
    try {
        const mt = document.querySelector(`.mes[mesid="${activeMessageId}"] .mes_text`);
        logStream('token', {
            summary: `len=${text.length} 尾部=${JSON.stringify(text.slice(-20))}`,
            tokenLen: text.length,
            tokenTail: text.slice(-20),
            accumulatedLen: accumulated.length,
            state: activeDetector ? activeDetector.getState() : 'no-detector',
            mesTextLen: mt ? (mt.textContent || '').length : -1,
            mesTextTail: mt ? (mt.textContent || '').slice(-25) : null,
            mesHtmlHead: mt ? (mt.innerHTML || '').slice(0, 80) : null,
            segs: mt ? mt.parentElement.querySelectorAll('.rph-stream-segment').length : 0,
        });
    } catch { /* 记录失败忽略 */ }
    const feed = feedSegmentDetector(activeDetector, accumulated);
    // M4 节流门控：闭合事件无条件处理（定格）；段内持续渲染按 STREAM_THROTTLE_MS 节流
    const hasClosed = feed.events.some((e) => e.type === SEGMENT_EVENT_CLOSED);
    const now = Date.now();
    if (hasClosed || (feed.state === SEGMENT_STATE_IN && feed.inSegmentText && now - lastRenderAt >= STREAM_THROTTLE_MS)) {
        if (!hasClosed) lastRenderAt = now;
        processDetection(feed).catch((err) => {
            console.warn('[rp-hub-compat] 流式段渲染失败（不阻断流式）：', String(err?.message || err));
        });
    }
}

/** 流式结束 / 中断：清理临时 DOM 与段渲染表（正式链路 coverMessage 已跳过/覆盖）。
 * 注意：本函数**不**清 finalizedSkipRegistry（定格段注册表跨生成存活，供后续 coverMessage
 * 跳过决策；由停止/切聊处理器 / MESSAGE_SWIPED / MESSAGE_EDITED / MESSAGE_DELETED 显式清）。
 * 代际令牌模型：本函数【不改写任何渲染计数】—— generationSeq++ 即作废旧代，
 * 在途旧代渲染的令牌由 sweepStaleInFlight 丢弃、其 DOM 写入被 renderTable=null 卫警拦截。 */
function cleanupActive() {
    generationSeq++; // 使在途 resolveStreamMode 失效（竞态守卫）；同时作废旧代渲染令牌
    sweepStaleInFlight(); // 卫生：丢弃旧代悬挂令牌（hung render 防堆积）
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
        cleanupTimerMessageId = null;
    }
    if (activeMessageId !== null) {
        cleanupMessageDom(activeMessageId);
    }
    activeDetector = null;
    activeMessageId = null;
    renderTable = null;
    lastRenderAt = 0;
    accumulated = '';
    streamPrefix = '';
    messageIdKnown = false;
    invalidatedMessages.clear();
    cleanupDeferred = false;
    recoverScheduled = false;
    activeMode = null;
    activeRoute = 'include';
}

/**
 * 流式结束收尾（方向 A 拼合，用户拍板）：正式链路 coverMessage 已跑（先正式）——此处
 * 只做「后清理」：
 *   - **删除所有兄弟段容器** —— content 段成品已由 coverMessage 拼合进 .mes_text
 *     （正式输出里 content 段区间用流式定格结果替换），兄弟容器只是流式期间的实时预览，
 *     结束后不再需要（否则与 .mes_text 内拼合结果重复）；
 *   - 把定格段登记进 finalizedSkipRegistry（跨生成存活，供后续 coverMessage 拼合）；
 *   - 还原隐藏标记（隐藏 span/块）；重置全部瞬态。
 */
function finalizeActive() {
    generationSeq++; // 使在途 resolveStreamMode 失效；同时作废旧代渲染令牌
    sweepStaleInFlight(); // 卫生：丢弃旧代悬挂令牌
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
        cleanupTimerMessageId = null;
    }
    const mid = activeMessageId;
    const list = renderTable && mid !== null ? renderTable.get(mid) : [];
    const registry = [];
    for (const e of list) {
        if (e.closed === true && e.startTag && e.endTag) {
            registry.push(e);
        }
    }
    if (mid !== null) {
        cleanupMessageDom(mid); // 删除兄弟容器 + 还原隐藏标记（content 已拼进 .mes_text）
        if (registry.length > 0) finalizedSkipRegistry.set(mid, registry);
        else finalizedSkipRegistry.delete(mid);
    }
    activeDetector = null;
    activeMessageId = null;
    renderTable = null;
    lastRenderAt = 0;
    accumulated = '';
    streamPrefix = '';
    messageIdKnown = false;
    invalidatedMessages.clear();
    cleanupDeferred = false;
    recoverScheduled = false;
    activeMode = null;
    activeRoute = 'include';
}

/**
 * CHARACTER_MESSAGE_RENDERED（普通 on，在第二部正式链路之后）：流式结束衔接收尾。
 * 方向 A 拼合：先正式（coverMessage 已跑，content 已拼进 .mes_text）、后清理 ——
 * finalizeActive 删除兄弟容器 + 登记定格段注册表。
 * 在途段渲染（闭合定格未完成）→ 推迟 —— 在途渲染完成后会补发 RENDERED，coverMessage
 * 用最新定格结果拼合，随后本函数（本代本消息在途归零）再 finalizeActive。
 */
function onMessageRendered(messageId) {
    if (!started) return;
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
        cleanupTimerMessageId = null;
    }
    if (Number(messageId) !== activeMessageId) return;
    // 代际令牌谓词：只统计【当前代、本消息】的在途渲染 —— 旧代悬挂令牌不再误触发推迟/收尾
    if (hasInFlight(generationSeq, messageId)) {
        cleanupDeferred = true;
        console.debug(`[rp-hub-compat] 流式实时渲染：在途段渲染 ${countInFlight(generationSeq, messageId)} 个 → 推迟收尾（等待定格后补发 RENDERED 重跳过）。`);
        return;
    }
    finalizeActive();
}

/** MESSAGE_DELETED：删除消息 → 清理对应临时 DOM、段渲染表与定格注册表。 */
function onMessageDeleted(messageId) {
    if (!started) return;
    invalidatedMessages.add(Number(messageId)); // N-E5：标记作废，在途渲染不得回写幽灵条目
    cleanupMessageDom(messageId);
    if (renderTable) renderTable.delete(messageId);
    finalizedSkipRegistry.delete(Number(messageId));
    if (Number(messageId) === activeMessageId) {
        cleanupActive();
    }
}

/**
 * GENERATION_STOPPED（用户停止生成）：forceClose 定格渲染【先落地】再清理 —— 修复 F3
 * （旧实现 void 调度后同步清理，定格渲染被 renderTable=null 卫警丢弃，承诺落空）。
 *
 * 分事件策略（验证报告议题三）：STOPPED 时目标消息仍在屏幕上，定格有展示价值 →
 * await 渲染落地后再收尾；用 Promise.race 封顶（FORCE_CLOSE_RENDER_CAP_MS <
 * GENERATION_ENDED 的 2s 兜底定时器，天然规避兜底提前清理把定格撕裂的竞态）。
 *
 * 再入守卫：入口捕获当前代（myGen），每个 await 恢复后若代际已被推进
 * （新一代 GENERATION_STARTED / 他处清理先行），放弃本次收尾，让最新调用链全权负责。
 */
async function onGenerationStopped() {
    if (!started) return;
    const myGen = generationSeq; // 再入守卫基准（与代际令牌同源）
    // 排除模式路由过滤：检出的区间该交原版，不定格渲染进 DOM（否则恰与用户意图相反）；
    // forceClose 亦跳过 —— 检测器随 cleanupActive 丢弃，无状态机残留。
    if (activeRoute !== 'exclude') {
        await flushForcedCloseRenders();
    }
    if (myGen !== generationSeq) return; // 代际已推进 → 本次收尾作废
    finalizedSkipRegistry.clear();
    cleanupActive();
}

/**
 * CHAT_CHANGED（切换聊天/角色）：跳过定格渲染，直接闭合状态机 + 清理。
 * 旧聊天 DOM 正被销毁/重建、mesid 可能被新聊天复用 —— 向其写入是浪费且有串扰风险；
 * 内容回填由切换后的正式链路全量渲染接管（等效旧实现的最终效果：内容回到 .mes_text）。
 */
function onChatChanged() {
    if (!started) return;
    if (activeDetector && typeof activeDetector.forceClose === 'function') {
        try { activeDetector.forceClose(); } catch { /* 状态机仍尽力闭合；不阻断清理 */ }
    }
    finalizedSkipRegistry.clear();
    cleanupActive();
}

/**
 * 消费检测器的强制闭合事件并等待定格渲染落地（仅 STOPPED 路径调用）。
 * try/catch 全覆盖，替代旧 `void renderAndApply(...)` 的 unhandled rejection 面；
 * race 封顶保证「停止」交互反馈不被慢渲染拖住（超时后孤儿渲染由代际令牌/卫生兵安全作废）。
 */
async function flushForcedCloseRenders() {
    if (!activeDetector || typeof activeDetector.forceClose !== 'function') return;
    let evs = [];
    try {
        evs = activeDetector.forceClose() || [];
    } catch { /* forceClose 异常不阻断清理 */ }
    if (!Array.isArray(evs) || evs.length === 0 || activeMessageId === null) return;
    const targetMid = activeMessageId;
    const work = (async () => {
        for (const ev of evs) {
            await renderAndApply(ev.segment, targetMid, `closed-${ev.ruleIndex}`, ev.ruleIndex, ev.occurrence ?? 0);
        }
    })();
    // R3 兜底：Promise.race 会同时挂接两侧回调——封顶后才落定的失败既不会走外层 catch
    // （race 已消化）也不产生 unhandled rejection，形成"静默无日志"的排障盲区（实验 B9c 实证）。
    // 统一在此记录（无论封顶前后失败）；loggedWork 永不 reject，race 不会因此提前拒绝。
    const loggedWork = work.catch((err) => {
        console.warn('[rp-hub-compat] 中断定格渲染失败：', String(err?.message || err));
    });
    await Promise.race([
        loggedWork,
        new Promise((resolve) => setTimeout(resolve, FORCE_CLOSE_RENDER_CAP_MS)),
    ]);
}

/** MESSAGE_SWIPED：浏览到其它 swipe → 本消息定格段作废（容器/渲染表/注册表清理），
 * 正式链路对新的 swipe 全量渲染（不跳过）。 */
function onMessageSwiped(messageId) {
    if (!started) return;
    invalidatedMessages.add(Number(messageId)); // N-E5：标记作废，在途渲染不得回写幽灵条目
    cleanupMessageDom(messageId);
    if (renderTable) renderTable.delete(messageId);
    finalizedSkipRegistry.delete(Number(messageId));
    if (Number(messageId) === activeMessageId) cleanupActive();
}

/** MESSAGE_EDITED：编辑保存 → 同 swipe（定格段作废，正式链路全量渲染编辑后文本）。 */
function onMessageEdited(messageId) {
    if (!started) return;
    invalidatedMessages.add(Number(messageId)); // N-E5：标记作废，在途渲染不得回写幽灵条目
    cleanupMessageDom(messageId);
    if (renderTable) renderTable.delete(messageId);
    finalizedSkipRegistry.delete(Number(messageId));
    if (Number(messageId) === activeMessageId) cleanupActive();
}

/**
 * GENERATION_ENDED（script.js:3477，hideStopButton → activateSendButtons → unblockGeneration，
 * 正常/错误/停止路径都会触发）：错误/中断路径兜底清理。
 * ⚠️ 时序：正常路径 GENERATION_ENDED 先于 MESSAGE_RECEIVED/RENDERED（script.js:3735-3741）
 * —— 不能立即清理（会清掉正式链路拼合要读的渲染表）→ 延时 2s；正常路径由
 * CHARACTER_MESSAGE_RENDERED 的 onMessageRendered 提前清理（清定时器）。
 */
function onGenerationEnded() {
    if (!started) return;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimerMessageId = activeMessageId;
    cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        if (activeMessageId !== null && activeMessageId === cleanupTimerMessageId) {
            console.debug('[rp-hub-compat] 流式实时渲染：GENERATION_ENDED 兜底清理（无 RENDERED 事件路径，如 continue/swipe/impersonate API 错误）。');
            cleanupActive();
        }
    }, 2000);
}

/* ---------- MutationObserver：ST 重绘后重隐藏原文 + 防御性容器补回 ---------- */

/**
 * 观察聊天容器的 DOM 变化。ST 每帧 innerHTML 整体替换（script.js:3669）必然触发
 * childList/characterData —— 但 STREAM_TOKEN_RECEIVED 每 token、DOM 重绘被 streaming_fps
 * 节流：检测每 token 跑（onStreamToken），DOM 手术本应由 onStreamToken 的 processDetection
 * 完成；此处 observer 承担**每帧重绘后的恢复性手术**：
 *   1. ST 每帧用原文重绘 .mes_text → 我们隐藏的原文段区域被恢复 → 每帧重新隐藏
 *     （hideSegmentRange，按渲染表的 startTag/endTag/occurrence；quiet 模式免逐帧日志）；
 *   2. 段容器是 .mes 兄弟节点（S2）→ ST 重绘不清它 → 无需每帧重建；仅防御性补回
 *     （容器被外部清掉时，按出现序号补回渲染表内容）。
 * L3：观察范围从 document.body 收窄到聊天容器（#chat）；observer 调用走 quiet 隐藏。
 */
/** 观察聊天容器的 DOM 恢复操作函数。 */
function performObserverRecovery() {
    try {
        if (!shouldRun() || activeMessageId === null || !renderTable) return;
        const list = renderTable.get(activeMessageId);
        if (!list || list.length === 0) return;
        const $mesText = getMesTextElement(activeMessageId);
        if (!$mesText || !$mesText.length) return;
        if (isEditingDom($mesText)) return;
        const mesEl = $mesText[0].parentElement;
        for (const entry of list) {
            // 1. 每帧重绘后重新隐藏原文段区域（ST 已恢复原文）
            if (entry.startTag || entry.endTag) {
                hideSegmentRange($mesText, {
                    startTag: entry.startTag,
                    endTag: entry.endTag,
                    raw: entry.raw,
                    occurrence: entry.occurrence ?? 0,
                    closed: entry.closed === true,
                    match: entry.match === 'last' ? 'last' : '',
                }, true);
            }
            // 2. 防御：容器被外部清掉 → 按出现序号补回（兄弟节点方案下理论罕见）
            const occ = typeof entry.occurrence === 'number' ? entry.occurrence : 0;
            if (entry.html && mesEl && !mesEl.querySelector(`.${STREAM_SEGMENT_CLASS}[data-occurrence="${occ}"]`)) {
                isPerformingDomSurgery = true;
                try {
                    const node = document.createElement('div');
                    node.className = STREAM_SEGMENT_CLASS;
                    node.dataset.occurrence = String(occ);
                    node.dataset.html = entry.html;
                    node.innerHTML = entry.html;
                    const textNode = mesEl.querySelector('.mes_text');
                    if (textNode) textNode.after(node);
                    else mesEl.appendChild(node);
                } finally {
                    isPerformingDomSurgery = false;
                }
            }
        }
        observerApplies++;
    } catch (err) {
        console.warn('[rp-hub-compat] 流式 DOM 恢复手术失败：', String(err?.message || err));
    }
}

/**
 * 观察聊天容器的 DOM 变化。ST 每帧 innerHTML 整体替换（script.js:3669）必然触发
 * childList/characterData —— 但 STREAM_TOKEN_RECEIVED 每 token、DOM 重绘被 streaming_fps
 * 节流：检测每 token 跑（onStreamToken），DOM 手术本应由 onStreamToken 的 processDetection
 * 完成；此处 observer 承担**每帧重绘后的恢复性手术**：
 *   1. ST 每帧用原文重绘 .mes_text → 我们隐藏的原文段区域被恢复 → 每帧重新隐藏
 *     （hideSegmentRange，按渲染表的 startTag/endTag/occurrence；quiet 模式免逐帧日志）；
 *   2. 段容器是 .mes 兄弟节点（S2）→ ST 重绘不清它 → 无需每帧重建；仅防御性补回
 *     （容器被外部清掉时，按出现序号补回渲染表内容）。
 * L3：观察范围从 document.body 收窄到聊天容器（#chat）；observer 调用走 quiet 隐藏。
 */
function initObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        observerHits++;
        if (isPerformingDomSurgery) return; // 静默操作门控：内部正在做 DOM 手术，直接跳过

        // 变更目标过滤：若所有 mutations 均来自流式容器或隐藏标记，则直接忽略
        let hasRelevantMutation = false;
        for (const m of mutations) {
            const target = m.target;
            if (target && target.nodeType === 1) {
                if (target.classList?.contains(STREAM_SEGMENT_CLASS) || target.closest?.(`.${STREAM_SEGMENT_CLASS}`)) {
                    continue;
                }
            }
            hasRelevantMutation = true;
            break;
        }
        if (!hasRelevantMutation) return;

        if (observerRafPending) return;
        observerRafPending = true;
        const scheduleFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
        scheduleFn(() => {
            observerRafPending = false;
            if (isPerformingDomSurgery) return;
            performObserverRecovery();
        });
    });
    const target = (typeof chatElement !== 'undefined' && chatElement?.[0]) ? chatElement[0] : (document.body || null);
    if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });
}

function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    observerRafPending = false;
}

/* ---------- S1：正式链路拼合 API（display.js coverMessage 调用） ---------- */

/**
 * 等待指定消息的在途流式段渲染全部完成（异步协调互斥锁 / Drain Barrier）。
 * 消除正式渲染 coverMessage 与流式定格渲染的竞态双重闪烁。
 * 代际令牌语义：只等待【当前代、本消息】的在途渲染 —— 停止/切聊推进 generationSeq 后
 * 旧代悬挂令牌被过滤，屏障立即放行（等待上限 ≈0），不会再被脏计数短路或多等。
 * @param {number} messageId
 * @param {number} [timeoutMs=1000] 最大等待超时（毫秒）
 * @returns {Promise<void>}
 */
export async function waitForPendingStreamRenders(messageId, timeoutMs = 1000) {
    if (!hasInFlight(generationSeq, messageId) || activeMessageId !== Number(messageId)) return;
    const start = Date.now();
    while (hasInFlight(generationSeq, messageId) && activeMessageId === Number(messageId)) {
        if (Date.now() - start > timeoutMs) {
            console.warn(`[rp-hub-compat] waitForPendingStreamRenders 等待超时 (${timeoutMs}ms)，强制继续`);
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
    }
}

/**
 * 读取某消息的流式【定格】段（closed=true；含 startTag/endTag/engineText）。
 * 数据源：先内存渲染表（renderTable，流式期间）；收尾后 renderTable 置 null →
 * finalizedSkipRegistry（定格段注册表，跨生成存活）兜底。
 * 无流式状态 / 消息无定格段 → null（coverMessage 走原版路径，零影响）。
 * @param {number} messageId
 * @returns {Array<{ occurrence: number, startTag: string, endTag: string, engineText: string }>|null}
 */
export function getFinalizedSegments(messageId) {
    let list = null;
    if (renderTable) {
        try { list = renderTable.get(messageId); } catch { list = null; }
    }
    if (!list || list.length === 0) {
        const reg = finalizedSkipRegistry.get(Number(messageId));
        if (reg && reg.length > 0) list = reg;
    }
    if (!list || list.length === 0) return null;
    const closed = list.filter((e) => e.closed === true && typeof e.engineText === 'string' && e.startTag && e.endTag);
    if (closed.length === 0) return null;
    return closed.map((e) => ({
        occurrence: e.occurrence ?? 0,
        startTag: e.startTag,
        endTag: e.endTag,
        engineText: e.engineText,
    }));
}

/**
 * S1（方向 A）：把流式定格段拼合进正式链路引擎输出（正文段区间用流式结果，其余用正式结果）。
 * 渲染层动作：不写 msg.extra / rph_display。开关关闭 / 无定格段 → 原样返回（spliced=false）。
 * @param {string} text 正式链路引擎输出（rph_display，含标签整串）
 * @param {number} messageId
 * @returns {{ text: string, spliced: boolean }}
 */
export function spliceFinalizedSegments(text, messageId) {
    const segments = getFinalizedSegments(messageId);
    if (!segments) return { text: String(text ?? ''), spliced: false };
    return spliceSegmentRegions(text, segments);
}

/* ---------- 生命周期 ---------- */

/** 启动流式实时渲染服务（index.js 挂载时调用）。开关默认关闭 → 零介入。 */
export function initStreamService() {
    if (started) return;
    started = true;
    installLogExports(); // 装好 window.__rphStreamLog / __rphExportLog / __rphClearLog（诊断）
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    // CHARACTER_MESSAGE_RENDERED 用普通 on（追加在第二部正式链路之后）→ 先正式、后清理
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    // M3：错误/中断路径兜底清理（正常路径由 RENDERED 提前清理，定时器被清）
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    // 滑动/编辑：定格段作废 → 正式链路全量渲染新 swipe/编辑文本（防旧容器+新正文并存）
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    initObserver();
    console.debug('[rp-hub-compat] 流式实时渲染服务已挂载（开关默认关闭，开启后流式期间段级渲染）。');
}

/** 停止服务（扩展卸载）。 */
export function stopStreamService() {
    if (!started) return;
    started = false;
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.removeListener(event_types.MESSAGE_EDITED, onMessageEdited);
    stopObserver();
    finalizedSkipRegistry.clear();
    cleanupActive();
}

/** 调试状态导出（诊断面板/测试用）。 */
export function debugStreamState() {
    return {
        started,
        observerActive: !!observer,
        observerHits,
        observerApplies,
        activeMessageId,
        messageIdKnown,
        accumulatedLen: accumulated.length,
        streamPrefixLen: streamPrefix.length,
        inFlightRenders: inFlightRenders.map((t) => ({ ...t })), // 代际令牌快照（替代旧 pendingRenders 标量口径）
        inFlightCurrentGen: countInFlight(generationSeq, activeMessageId ?? NaN),
        renderTableSize: renderTable ? renderTable.raw.size : 0,
    };
}
