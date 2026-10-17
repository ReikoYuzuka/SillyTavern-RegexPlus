// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * pipeline/pure.js —— 管道纯函数（可 node 离线测试，不依赖 DOM / ST 全局）。
 *
 * 消息视角约定（本插件双通道 + C2 管道）：
 *   - msg.mes：存储层文本。C2 起【恒存原文】（raw，含 fox_selc/think）—— 狐策/玄狐等
 *     依赖 mes 原文重载样式/内容的预设工具始终拿到完整原文（含选项标签）；
 *     提示词剥离（删 fox_selc、剥 think）由 GENERATE_AFTER_DATA 对整段 prompt 施加
 *     （prompt.js），不再写回 mes。
 *   - msg.extra.rph_raw_mes：原始文本快照（编辑回填 / 覆盖兜底 / 显示重算的源）。
 *   - msg.extra.rph_display：引擎显示通道结果（coverMessage 写入 DOM 用）。
 *   - msg.extra.display_text：ST 原生显示视角字段（getMessageTextHTML/updateMessageBlock 优先读它）。
 *   - msg.extra.rph_prompt：引擎 prompt 通道结果（swipe 判别用；兜底剥离的参考视角）。
 *   - msg.extra.rph_done：本消息是否已处理（去重标记，随 chat 持久化）。
 *
 * 本模块只导出纯函数；引擎 runner（run）与 ST 全局由调用方注入。
 */

import { run as engineRun } from '../engine/engine.js';
import { fenceFullHtml, isFragmentFrontend, isFragmentInterface } from '../engine/html-fence.js';
import { djb2Hash } from '../store/scripts-core.js';

export const RAW_MES_KEY = 'rph_raw_mes';
export const DISPLAY_KEY = 'rph_display';
export const PROMPT_KEY = 'rph_prompt';
export const FLAG_KEY = 'rph_done';
/** 存储通道结果（F2，审查报告 L2/D6）：general（双 false）脚本先跑一次的视图。
 * 显示/prompt 通道在它上面跑（verbatim），恢复原版「general 先于一切」的顺序保证。 */
export const GENERAL_KEY = 'rph_general';
/** 显示指纹（O2，审查报告 P2/L7/D11）：rph_display 伴随脚本集+源+配置指纹，命中跳过重算。 */
export const DISPLAY_FP_KEY = 'rph_display_fp';

/**
 * 显示结果指纹（O2，纯函数，node 可测）：djb2(mode + settingsFp + 脚本集执行字段 + 源文本 +
 * placement/depth)。脚本集变化（玄狐式 disabled 切换/内容编辑/顺序）、源文本变化、配置变化、
 * 消息深度变化任一发生 → 指纹变化 → 重算；全部一致 → 直接返回缓存跳过引擎执行。
 * @param {object} arg
 * @param {'st'|'rphub'} arg.mode
 * @param {object[]} arg.scripts 合并后的脚本数组（含 rp_source）
 * @param {string} arg.raw 源文本
 * @param {string} [arg.settingsFp] 影响输出的设置指纹（runtime.getSettingsFp）
 * @param {number|string} [arg.placement]
 * @param {number} [arg.depth]
 * @returns {string}
 */
export function buildDisplayFingerprint({ mode, scripts = [], raw, settingsFp = '', placement = '', depth = '' } = {}) {
    return djb2Hash(`${String(mode)}|${String(settingsFp)}|${execFingerprintOf(scripts)}|${String(raw)}|${String(placement)}|${String(depth)}`);
}

/**
 * 脚本集执行字段指纹（导出版，供 O2 显示缓存与「切换样式指纹轮询兜底」共用）：
 * 逐脚本混入 id/disabled/markdownOnly/promptOnly/placement/substituteRegex/min/maxDepth/
 * runOnEdit/findRegex/replaceString/trimStrings。覆盖玄狐式 disabled 切换与面板内容编辑
 * （findRegex/replaceString 变化 → 指纹变化），也覆盖 SPreset 改执行顺序（数组顺序参与哈希）。
 * @param {object[]} scripts
 * @returns {string}
 */
export function computeScriptsFingerprint(scripts) {
    return execFingerprintOf(scripts);
}

/**
 * 脚本集执行字段指纹（O2 内部，纯函数）：逐脚本混入 id/disabled/markdownOnly/promptOnly/
 * placement/substituteRegex/min/maxDepth/runOnEdit/findRegex/replaceString/trimStrings。
 * 覆盖玄狐式 disabled 切换与面板内容编辑（findRegex/replaceString 变化 → 指纹变化）。
 * @param {object[]} scripts
 * @returns {string}
 */
function execFingerprintOf(scripts) {
    let h = 5381;
    const mix = (str) => {
        const s = String(str ?? '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h;
    };
    const list = Array.isArray(scripts) ? scripts : [];
    for (const s of list) {
        if (!s || typeof s !== 'object') { mix('|null|'); continue; }
        // P1/SC4 修复：混入 rp_preprocess/rp_scope_*/scriptName 与 rphub 归一字段
        // （enabled/regex/replacement/flags/regexFlags），使这些字段变化也触发显示缓存失效。
        // rp_preprocess 为对象，JSON.stringify 序列化（键序由写入方稳定，风险低）。
        const preprocess = s.rp_preprocess && typeof s.rp_preprocess === 'object' ? JSON.stringify(s.rp_preprocess) : '';
        mix(`|${s.id ?? ''}|${!!s.disabled}|${!!s.enabled}|${!!s.markdownOnly}|${!!s.promptOnly}|${Array.isArray(s.placement) ? s.placement.join(',') : ''}|${Number(s.substituteRegex) || 0}|${s.minDepth ?? ''}|${s.maxDepth ?? ''}|${!!s.runOnEdit}|${s.findRegex ?? ''}|${s.regex ?? ''}|`);
        mix(s.replaceString ?? '');
        mix(s.replacement ?? '');
        mix(`|${s.flags ?? s.regexFlags ?? ''}|${s.scriptName ?? ''}|${s.rp_scope_start ?? ''}|${s.rp_scope_end ?? ''}|${preprocess}|`);
        mix(Array.isArray(s.trimStrings) ? s.trimStrings.join('\n') : '');
        mix('|');
    }
    return String(h);
}

/** 是否有 st general（双 false）脚本（F2 存储通道快速路径：无 general 则跳过存储通道执行）。 */
export function hasGeneralScript(scripts) {
    return (Array.isArray(scripts) ? scripts : []).some((s) => s && typeof s === 'object' && !s.disabled && !s.markdownOnly && !s.promptOnly);
}

/** 存储通道参数（st）：对齐原版 cleanUpMessage/发送/编辑保存 —— placement 过滤生效、depth 不传
 * （原版 script.js:6422/8100 不传 depth → 深度过滤跳过）、isEdit 透传（runOnEdit 门控）。 */
function storageRunArgs(runArgs, isEdit) {
    return {
        placement: runArgs.placement,
        characterOverride: runArgs.characterOverride,
        isEdit,
        options: { ...(runArgs.options || {}), stGeneralMode: 'verbatim' },
    };
}

/** 编辑态判定：.mes_text 内为 textarea（编辑打开）时跳过覆盖。 */
export function isEditingDom($mesText) {
    if (!$mesText || !$mesText.length) return false;
    return $mesText.find('textarea').length > 0 || $mesText.prop('tagName') === 'TEXTAREA';
}

/** 快照原文：仅首次保存（后续 swipes/编辑由 source 显式覆盖）。 */
export function snapshotRaw(msg) {
    if (!msg || typeof msg !== 'object') return null;
    msg.extra ??= {};
    if (typeof msg.extra[RAW_MES_KEY] !== 'string') {
        msg.extra[RAW_MES_KEY] = msg.mes;
    }
    return msg.extra[RAW_MES_KEY];
}

/**
 * 是否需要重新处理：mes 不是当前原始快照 —— 说明内容被外部改写过
 * （swipe 浏览 / 编辑保存 / 其它扩展写入）。
 * C2：mes 恒存原文（= RAW_MES_KEY），任何偏离原文的 mes 都视为外部改写需重算。
 */
export function needsReprocess(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg.mes !== 'string') return false;
    if (msg.extra?.rph_stream_processed === true) return false;
    return msg.mes !== msg.extra?.[RAW_MES_KEY];
}

/**
 * 模板脚本特征（尾部 HTML 文档形态的辅助信号）：
 *   - ac 系模板函数（acSend/acTab/ac-send/ac_tab、document.querySelector('.ac-*')）
 *   - 通用：`<script>` 内 400 字符内出现 function（模板脚本骨架，脚本通常较短）
 * 只在文本尾部 8000 字符内检查（模板文档尾正是脚本所在区域，避免长正文误伤）。
 */
const TEMPLATE_SCRIPT_TAIL_RE = /(?:acSend|acTab|ac[-_]send|ac[-_]tab|document\.querySelector\(['"][^'"]*ac[-_])|<script\b[^>]*>[^<]{0,400}function\s+\w+/i;

/** 去 ``` 围栏（尾部重叠比较时排除围栏头尾差异）。 */
function stripMarkdownFence(text) {
    return String(text).replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
}

/**
 * 文本尾部是否与显示缓存尾部逐字重叠（显示结果被「部分读走」：正文开头 + 文档尾）。
 * 覆盖用户实测形态：mes 开头是正常正文、结尾拼接了模板 HTML 文档尾 ——
 * 此时 mes 的尾部（末 300 字符）与 rph_display 的尾部同源。围栏差异用去围栏版本兜底。
 * @param {unknown} text 待判定文本
 * @param {unknown} display 显示缓存（rph_display）
 * @returns {boolean}
 */
function tailOverlapsDisplay(text, display) {
    if (typeof display !== 'string' || display.length === 0) return false;
    const candidates = [display, stripMarkdownFence(display)];
    for (const cand of candidates) {
        if (typeof cand !== 'string' || cand.length === 0) continue;
        const len = Math.min(300, text.length, cand.length);
        if (len < 40) continue;
        if (text.slice(-len) === cand.slice(-len)) return true;
    }
    return false;
}

/**
 * 文本（去尾部空白）的 HTML 文档闭合形态：
 *   - 'full'：`</body></html>` 双闭合（完整文档尾，近乎必然污染 —— 正文/代码编辑几乎不可能以此结尾）
 *   - 'bare'：仅 `</html>` 闭合（可能被截断或用户刻意写代码，需叠加辅助信号）
 *   - null：非文档闭合结尾
 * 补丁 2 v2 核心判据：**只认尾部，不看开头** —— 污染形态是「正文开头 + 尾部拼接文档」，
 * 开头是正常正文（不命中任何开头特征），但结尾的 `</html>` 是强污染信号。
 * @param {unknown} text 待判定文本
 * @returns {'full'|'bare'|null}
 */
function htmlTailForm(text) {
    const t = String(text ?? '').trimEnd();
    if (/<\/body><\/html>$/i.test(t)) return 'full';
    if (/<\/html>$/i.test(t)) return 'bare';
    return null;
}

/**
 * 判定文本是否疑似「引擎显示产物」（显示通道结果被误当作原始文本的污染形态）。
 *
 * 背景（编辑链路-专项审查报告 §3，问题 2 主嫌疑）：ST `updateMessage` 在快速取消/保存
 * 交错、`.edit_textarea` 缺失时回退读 `.mes_text`.text()`（script.js:8082），而插件在
 * MESSAGE_EDITED/MESSAGE_UPDATED 的 emit 中途已把引擎显示结果写进 `.mes_text`
 * （display.js coverMessage → $mesText.empty().append）—— 回退读到的就是显示产物
 * （```html 围栏 / 完整 HTML 文档 / 显示缓存文本），被 ST 写成 mes 后若插件再当新 raw
 * 提交会永久固化（自复制）。本函数用于识别这类污染，拒绝其进入 rph_raw_mes。
 *
 * 判定特征（强特征优先，避免误伤正常编辑）：
 *   1. 与显示缓存 rph_display 逐字相等（编辑取消时 .mes_text 里正是它）—— 最强信号；
 *   2. 与围栏化后的显示缓存（fenceFullHtml(rph_display)）相等；
 *   3. 文本（去掉前导空白）以 `<!doctype html>` / `<html...>` 开头 —— 完整 HTML 文档被
 *      整体当文本读回（markdown 围栏被渲染成 <pre><code> 后 .text() 已剥掉 ``` 反引号）；
 *   4. 文本以 ```html 开头且含完整文档/前端标记（<!doctype/<html/<head/<body）——
 *      围栏形态的显示产物在「未转 markdown」的回退读路径；
 *   5. **v2（补丁 2 盲区修复）尾部 HTML 文档形态**：污染实际形态是「正文开头 + 尾部拼接
 *      完整模板 HTML 文档」（实测样例：开头是正常正文「【开始思考】…」，结尾是
 *      `...<script>function acTab…acSend…</script></body></html>`）—— 开头特征全不命中，
 *      只认尾部：结尾成 `</html>` 闭合（且含模板脚本特征 / 或尾部与显示缓存重叠 /
 *      或无可比对的显示缓存）判污染；
 *   6. **v2 尾部重叠**：无论是否以 `</html>` 结尾，只要文本尾部与显示缓存尾部高度重叠
 *      （显示结果被部分读走）即判污染。
 *
 * 局限（已知）：被 TH-render iframe 化后的显示产物经 .text() 只剩可见卡片文本（无标签），
 * 无法用特征识别 —— 但该形态不会表现为「奇怪代码」，不在本补丁覆盖范围。
 *
 * @param {unknown} text 待判定文本（通常 = 编辑保存时 ST 写入的 msg.mes）
 * @param {object|null} [msg] 消息对象（读 extra.rph_display / extra.rph_raw_mes）
 * @returns {boolean} true = 疑似显示产物污染，不应作为新 raw 采纳
 */
export function isDisplayArtifactText(text, msg) {
    if (typeof text !== 'string' || text.length === 0) return false;
    const extra = (msg && typeof msg === 'object' && msg.extra) || {};
    const display = extra[DISPLAY_KEY];
    if (typeof display === 'string' && display.length > 0) {
        if (text === display) return true;
        try {
            const fenced = fenceFullHtml(display);
            if (typeof fenced === 'string' && fenced.length > 0 && text === fenced) return true;
        } catch {
            // 围栏化失败不阻断其余特征判定
        }
    }
    const trimmed = text.trimStart();
    if (trimmed.startsWith('```html')) {
        return /<!doctype html|<html\b|<head>|<body/i.test(trimmed);
    }
    // 完整 HTML 文档被当文本读回（``` 围栏被 markdown 渲染成 <pre><code> 后 .text() 剥掉了反引号）。
    // 剥掉开头 <!doctype/<html> 打开标签后，还需命中文档体标记（<head>/<body/</html>）才判为完整文档，
    // 降低「用户文本恰好以 <html 开头」的误伤；仅在开头 2048 字符内检查（防大文本正则开销）。
    const head = trimmed.slice(0, 2048).replace(/^(?:<!doctype html>|<html\b[^>]*>)/i, '');
    if (/<head>|<body|<\/html>/i.test(head)) return true;
    // v2（补丁 2 盲区修复）：只认尾部 —— 污染是「正文开头 + 尾部拼接完整模板 HTML 文档」，
    // 开头特征全部不命中（实测样例 90993 字符，</html> 远超 2048 窗口）。逐特征核对失败原因：
    // ①≠rph_display ②≠fenceFullHtml(rph_display) ③非```html 开头 ④非 doctype/html 开头。
    const tailForm = htmlTailForm(text);
    if (tailForm) {
        // 'full'（</body></html> 双闭合）：完整文档尾，正常编辑/正文几乎不可能以此结尾 → 直接判污染。
        // 'bare'（仅 </html>）：需叠加辅助信号 —— 模板脚本特征 / 尾部与显示缓存重叠 /
        // 无可比对的显示缓存（兜底）。误拒后果可恢复（resolveEditSource 回退 rph_raw_mes）。
        if (tailForm === 'full') return true;
        if (TEMPLATE_SCRIPT_TAIL_RE.test(text.slice(-8000)) || tailOverlapsDisplay(text, display)) return true;
        if (typeof display !== 'string' || display.length === 0) return true;
        return false; // 有显示缓存但无重叠无脚本 → 保守不判（防误伤用户刻意写的 </html> 结尾）
    }
    // 尾部与显示缓存高度重叠（部分读走，未必到 </html> 闭合）也判污染
    return tailOverlapsDisplay(text, display);
}

/**
 * 编辑保存的源文本决策（纯函数，node 可测）：区分「正常编辑」与「显示产物污染」。
 * - 正常（adopt=true）：editedText 无显示产物特征 → 采纳为编辑后新 raw。
 * - 污染（adopt=false）：editedText 疑似显示产物（ST 回退读 .mes_text 的污染）→ 拒绝，
 *   回退用最后一次干净 rph_raw_mes 作为重算源（commitMessageView 会把 mes/swipes 恢复
 *   为干净原文，自愈式纠错）；rph_raw_mes 缺失时只能退回 editedText（无更优源）。
 * 供 edit.js onMessageEdited / refillEditTextarea 共用。
 * @param {unknown} editedText 编辑保存时 ST 写入的 msg.mes
 * @param {object|null} [msg] 消息对象
 * @returns {{ adopt: boolean, source: string }}
 */
export function resolveEditSource(editedText, msg) {
    const text = typeof editedText === 'string' ? editedText : '';
    if (isDisplayArtifactText(text, msg)) {
        const clean = (typeof msg?.extra?.[RAW_MES_KEY] === 'string' && msg.extra[RAW_MES_KEY].length > 0)
            ? msg.extra[RAW_MES_KEY]
            : text;
        return { adopt: false, source: clean };
    }
    return { adopt: true, source: text };
}

/**
 * 编辑保存来源分类（补丁 2v3，纯函数可测）：区分「真实用户编辑」与「环境读回」。
 *
 * 背景（用户实测「快速操作时预设美化标签全没了」，编辑链路-专项审查报告 §3 / 补丁 2 盲区补漏）：
 *   ST `.mes_edit` 点击处理在已有编辑器打开时会先强制 messageEditDone（script.js:11792）；
 *   若用户在 messageEditCancel 的 `await emit(MESSAGE_UPDATED)` 期间快速再次点编辑（此时
 *   `this_edit_mes_id` 尚未清除、且取消已把 textarea 移除），强制保存走 `updateMessage`
 *   （script.js:8080-8134）的 `mesBlock.find('.edit_textarea').val() ?? .mes_text.text()`
 *   回退（script.js:8082）—— 读回的是 ST 对原消息的 markdown/DOMPurify 渲染文本，
 *   `<fox_selc>`/`<think>` 等预设美化标记被剥 → 引擎按纯正文重跑 → 预设美化（1→2→1
 *   第一阶段）不触发 → 「标签全没了」。此类 editedText 不能当新 raw。
 *
 * 判别：真实保存（用户点 Done / 编辑中强制保存）时 #curEditTextarea 仍在 DOM ——
 *   messageEditDone 在 emit MESSAGE_EDITED（script.js:8345）之后才 empty（script.js:8347），
 *   插件 onMessageEdited 运行时 textarea 一定在。textarea 缺失 = 读回路径（或 slash 命令
 *   role/name 修改 —— 那些不改变 mes 内容，editedText === preEditRaw → 'no-change'）。
 *
 * @param {{ editedText: unknown, preEditRaw: unknown, textareaPresent?: boolean }} arg
 * @returns {'genuine'|'no-change'|'readback'}
 *   - 'genuine'：textarea 在 DOM，editedText 来自用户输入，可信。
 *   - 'no-change'：textarea 缺失但 editedText === preEditRaw（role/name 修改 / 幂等读回）→ 内容未变。
 *   - 'readback'：textarea 缺失且 editedText ≠ preEditRaw（快速取消后回退读 .mes_text.text()）→ 拒绝当新 raw。
 */
export function classifyEditedSave({ editedText, preEditRaw, textareaPresent = false } = {}) {
    const text = typeof editedText === 'string' ? editedText : '';
    const raw = typeof preEditRaw === 'string' ? preEditRaw : null;
    if (textareaPresent) return 'genuine';
    if (raw !== null && text === raw) return 'no-change';
    return 'readback';
}

/**
 * 补丁 1d：rescanForIframe 补发的 CHARACTER_MESSAGE_RENDERED 是否应跳过 recompute（纯函数，node 可测）。
 *
 * 背景（编辑链路-专项审查报告 补丁 1c 竞态，用户实测「取消后整个渲染没了/正则没了」）：
 *   onMessageUpdated 的 editRecovery 强制写回后，rescanForIframe 补发 RENDERED 让酒馆助手重扫
 *   iframe 化 —— 但该事件也会触发插件自身的 onCharacterRendered → coverMessage 的 recompute 路径
 *   （display.js rph_done && !forceApply 分支）。若 recompute 结果 ≠ 缓存 rph_display（模板卡常用
 *   {{random}}/{{time}} 宏 → 每次重算非确定性），recomputeDecision 判 changed → commitDisplay 覆写
 *   rph_display/display_text + DOM 整体替换 —— 可能恰好破坏刚被酒馆助手 iframe 化的 TH-render
 *   （TH 已扫过、不会重扫）→ 模板界面消失；且覆写后的 rph_display 在下一次取消时被渲染出来
 *   （模板出现但内容被宏/重算污染）→ 与用户「两次取消差异」吻合。
 *
 * 判定：最近一次 editRecovery/forceApply 强制写回的消息 == 本次 RENDERED 的消息，且在短窗口内
 * （freshWindowMs 缺省 2000ms）→ 本次 recompute 应跳过（DOM 已是权威引擎显示结果，缓存即权威；
 * 跳过可避免宏非确定性重算覆盖缓存/破坏 TH iframe）。窗口外（正常 RENDERED 事件，如玄狐切样式
 * 重载）→ 照常 recompute。
 *
 * @param {unknown} messageId 本次 RENDERED 的消息 id
 * @param {unknown} freshWriteMessageId 最近被 editRecovery/forceApply 强制写回的消息 id（null = 无）
 * @param {number} [freshWriteAt] 写回时间戳（ms；0 = 未知 → 不跳过）
 * @param {number} [now] 当前时间戳（测试可注入；缺省 Date.now()）
 * @param {number} [freshWindowMs] 跳过窗口（缺省 2000ms）
 * @returns {boolean} true = 本次 recompute 应跳过（DOM 已被权威写回，让酒馆助手 iframe 化）
 */
export function shouldSkipRecoveryRecompute(messageId, freshWriteMessageId, freshWriteAt = 0, now = Date.now(), freshWindowMs = 2000) {
    if (freshWriteMessageId === null || freshWriteMessageId === undefined) return false;
    if (Number(freshWriteMessageId) !== Number(messageId)) return false;
    if (!Number.isFinite(freshWriteAt) || freshWriteAt <= 0) return false;
    if (!Number.isFinite(now) || !Number.isFinite(freshWindowMs)) return false;
    return now - freshWriteAt < freshWindowMs;
}

/** 模板渲染标记：第三部方案A 渲染服务写 display_text（正文+模板围栏）后置 true。 */
export const TEMPLATE_RENDER_KEY = 'rph_template_render';

/**
 * 消息是否由第三部模板渲染服务接管显示（pure，node 可测）。
 * true 时本扩展不再覆写 display_text / DOM —— 显示由模板渲染服务负责
 * （变量渲染-验证与决策.md §2.5 决策 D2 根治）。
 * @param {object|null} msg
 * @returns {boolean}
 */
export function isTemplateRendered(msg) {
    return !!(msg && typeof msg === 'object' && msg.extra?.[TEMPLATE_RENDER_KEY] === true);
}

/**
 * 提交双通道结果：display_text=rph_display（ST 原生显示），标记 rph_done。
 * 模板渲染消息（rph_template_render）：跳过 display_text 覆写（显示由第三部接管），
 * 引擎缓存（rph_display/rph_raw_mes/rph_prompt）照常提交 —— 重算一致性不受影响。
 * msg.mes 恒存原始文本（C2 管道）：原文含 fox_selc/think，狐策/玄狐等读 mes 的工具
 * 拿到完整原文；提示词剥离由 GENERATE_AFTER_DATA 对整段 prompt 施加（prompt.js）。
 */
export function commitMessageView(msg, { raw, display, prompt, fp } = {}) {
    msg.extra ??= {};
    // JOIN-05（多方写入竞争）：msg.mes 还原原始文本前，若本楼层已有更高修订号的外部写入
    // （ST-Prompt-Template 等共存扩展也写 chat[i].mes），保留对方版本并警告——raw 是我们
    // 处理起点，若 mes 已被他人改写，回写旧 raw 会丢失对方修改。
    // 约定：本扩展与共存方写入 mes 时递增 extra.rph_rev（修订号）；对方未遵循约定（无 rph_rev）
    // 时无法检测，保持原行为。
    if (typeof raw === 'string' && typeof msg.mes === 'string' && msg.mes !== raw) {
        const ownRev = typeof msg.extra[RAW_MES_KEY] === 'string' && msg.extra[RAW_MES_KEY] === msg.mes;
        if (!ownRev && typeof msg.extra?.rph_rev === 'number') {
            console.warn('[rp-hub-compat] commitMessageView：检测到 mes 已被外部修改（rph_rev 修订链），保留外部版本不回写 raw。');
        } else {
            msg.mes = raw;
        }
    } else if (typeof raw === 'string') {
        msg.mes = raw;
    }
    msg.extra[RAW_MES_KEY] = raw;
    msg.extra[DISPLAY_KEY] = display;
    msg.extra[PROMPT_KEY] = prompt;
    if (typeof fp === 'string' && fp.length > 0) msg.extra[DISPLAY_FP_KEY] = fp;
    if (!isTemplateRendered(msg)) msg.extra.display_text = display;
    msg.extra[FLAG_KEY] = true;
    delete msg.extra.rph_stream_processed;
    msg.extra.rph_rev = (typeof msg.extra.rph_rev === 'number' ? msg.extra.rph_rev : 0) + 1;
    return msg;
}

/** 编辑保存同步：rph_raw_mes 同步为编辑后内容，清空双通道结果/指纹与标记（等待重算）。 */
export function syncAfterEdit(msg, newText) {
    if (!msg || typeof msg !== 'object') return;
    msg.extra ??= {};
    msg.extra[RAW_MES_KEY] = typeof newText === 'string' ? newText : msg.mes;
    delete msg.extra[DISPLAY_KEY];
    delete msg.extra[PROMPT_KEY];
    delete msg.extra[GENERAL_KEY];
    delete msg.extra[DISPLAY_FP_KEY];
    delete msg.extra[FLAG_KEY];
    delete msg.extra.display_text;
    delete msg.extra.rph_template_body;
    delete msg.extra.rph_template_display;
}

/**
 * 单条消息的双通道处理（MESSAGE_RECEIVED / swipe 浏览 / 编辑保存共用）。
 *
 * F2（审查报告 L2/D6）：st 模式先跑**存储通道**（general 双 false 脚本，结果存 rph_general），
 * 显示通道在 general 结果上以 verbatim 语义跑（仅 markdownOnly/双 true）——恢复原版
 * 「general 在写入通道先跑一次、显示/prompt 读已处理文本」的顺序保证。
 * F3（审查报告 P1/L3）：**prompt 次执行移除**（rph_prompt 无读取方，死计算）——prompt 通道
 * 职责移到生成期 generate_interceptor（prompt.js rphubCompatPromptInterceptor）；此处
 * rph_prompt 保留为 prompt 源视角（= general 视图；rphub = raw），不再执行引擎。
 *
 * @param {object} args
 * @param {object} args.msg        消息对象
 * @param {'st'|'rphub'} args.mode 语义模式
 * @param {object[]} args.scripts  合并后的脚本
 * @param {string} [args.source]   源文本（缺省取 msg.mes）；swipe/编辑重算时显式传入
 * @param {object} [args.runArgs]  额外 run 参数（placement/role/depth/characterOverride…）
 * @param {Function} [args.run]    引擎 runner（缺省 engineRun）；测试可注入 fake
 * @param {boolean} [args.force]   忽略 rph_done 标记强制重算（swipe/编辑用）
 * @param {boolean} [args.isEdit]  编辑保存标记（F5，审查报告 L5/D9）：存储通道透传引擎，
 *   使 runOnEdit=false 的 general 脚本编辑保存时跳过（原版 script.js:8100 isEdit 语义）
 * @param {string} [args.settingsFp] 影响输出的设置指纹（O2，runtime.getSettingsFp）
 * @returns {{ handled: boolean, raw?: string, display?: string, prompt?: string, reason?: string, fp?: string }}
 */
export function processMessageView({ msg, mode, scripts = [], source, runArgs = {}, run = engineRun, force = false, isEdit = false, settingsFp = '' } = {}) {
    if (!msg || typeof msg !== 'object') return { handled: false, reason: 'no-message' };
    if (typeof msg.mes !== 'string' || msg.mes.length === 0) return { handled: false, reason: 'empty-text' };
    msg.extra ??= {};
    if (!force && msg.extra[FLAG_KEY]) return { handled: false, reason: 'already-handled' };

    const raw = typeof source === 'string' ? source : snapshotRaw(msg);

    // F2：存储通道（仅 st 模式；rphub 双 false 仅显示、无 general 语义）。无 general 脚本 →
    // 快速路径（当前用户 36 条 preset 无纯 general 脚本 → 零额外开销）。
    let general = raw;
    if (mode === 'st') {
        if (hasGeneralScript(scripts)) {
            const generalResult = run({ text: raw, scripts, mode, ...storageRunArgs(runArgs, isEdit) });
            if (typeof generalResult?.text === 'string') general = generalResult.text;
        }
        if (general === raw) delete msg.extra[GENERAL_KEY];
        else msg.extra[GENERAL_KEY] = general;
    }

    // 显示通道：st 在 general 结果上跑（verbatim）；rphub 在 raw 上跑（rphub 语义不变）
    const displayResult = run({
        text: general,
        scripts,
        mode,
        isDisplay: true,
        ...runArgs,
        options: { ...(runArgs.options || {}), ...(mode === 'st' ? { stGeneralMode: 'verbatim' } : {}) },
    });
    const display = typeof displayResult?.text === 'string' ? displayResult.text : general;

    // F3：prompt 次执行移除（P1 死计算）；rph_prompt 保留为 prompt 源视角（general / raw）
    const prompt = general;

    const fp = buildDisplayFingerprint({ mode, scripts, raw, settingsFp, placement: runArgs.placement, depth: runArgs.depth });
    commitMessageView(msg, { raw, display, prompt, fp });
    return { handled: true, raw, display, prompt, fp };
}

/**
 * 显示通道重算（修复 1）：用「当前脚本集 + 原始文本」重算显示字符串。
 * 只跑显示通道、只返回结果 —— 不提交缓存、不改 msg.mes（提交/写回由调用方
 * 按 recomputeDecision 决策执行）。source 缺省优先 rph_raw_mes（保持 swipe 稳定），
 * 次选 rph_display，最后 msg.mes。
 * F2：st 显示源 = general 视图（rph_general 缓存缺失时用原文 + 存储通道重算）。
 * O2（审查报告 P2/L7/D11）：指纹命中（脚本集/源/配置/深度均未变）→ 直接返回缓存，
 * 跳过引擎执行（打开聊天/事件风暴场景从「N×全量重算」降为「N×hash 比较」）。
 * @param {object} args
 * @param {object} args.msg        消息对象
 * @param {'st'|'rphub'} args.mode 语义模式
 * @param {object[]} args.scripts  当前脚本集（调用方每次现读，含刚被外部改的 disabled 标志）
 * @param {string} [args.source]   源文本（缺省 rph_raw_mes → rph_display → mes）
 * @param {object} [args.runArgs]  额外 run 参数
 * @param {Function} [args.run]    引擎 runner
 * @param {boolean} [args.isEdit]  编辑保存标记（F5；存储通道透传）
 * @param {string} [args.settingsFp] 影响输出的设置指纹（O2）
 * @returns {{ handled: boolean, raw?: string, display?: string, reason?: string, fp?: string, cached?: boolean }}
 */
export function recomputeDisplay({ msg, mode, scripts = [], source, runArgs = {}, run = engineRun, isEdit = false, settingsFp = '' } = {}) {
    if (!msg || typeof msg !== 'object') return { handled: false, reason: 'no-message' };
    const raw = typeof source === 'string'
        ? source
        : (msg.extra?.[RAW_MES_KEY] ?? msg.extra?.[DISPLAY_KEY] ?? msg.mes);
    if (typeof raw !== 'string' || raw.length === 0) return { handled: false, reason: 'empty-text' };

    // O2：指纹命中 → 直接返回缓存（跳过引擎）
    const fp = buildDisplayFingerprint({ mode, scripts, raw, settingsFp, placement: runArgs.placement, depth: runArgs.depth });
    const cachedDisplay = msg.extra?.[DISPLAY_KEY];
    if (typeof cachedDisplay === 'string' && cachedDisplay.length > 0 && msg.extra?.[DISPLAY_FP_KEY] === fp) {
        return { handled: true, raw, display: cachedDisplay, fp, cached: true };
    }

    // F2：st 显示源 = general 视图（重算路径**始终重算** general —— 缓存的 rph_general 在脚本集
    // 变化后可能过期；指纹快速路径已覆盖「全未变」场景，此处到达即代表有变化，需新鲜值）。
    let general = raw;
    if (mode === 'st' && hasGeneralScript(scripts)) {
        const generalResult = run({ text: raw, scripts, mode, ...storageRunArgs(runArgs, isEdit) });
        if (typeof generalResult?.text === 'string') general = generalResult.text;
    }

    const displayResult = run({
        text: general,
        scripts,
        mode,
        isDisplay: true,
        ...runArgs,
        options: { ...(runArgs.options || {}), ...(mode === 'st' ? { stGeneralMode: 'verbatim' } : {}) },
    });
    const display = typeof displayResult?.text === 'string' ? displayResult.text : general;
    return { handled: true, raw, display, fp };
}

/**
 * 重算决策（修复 1）：重算结果与缓存一致则跳过 DOM 覆盖（高频强制刷新场景下
 * 避免反复重写 DOM 造成闪烁/性能损失），不一致才应用并写回缓存。
 * @param {object} msg
 * @param {string} [display] 重算出的显示字符串
 * @returns {{ apply: boolean, reason: string }}
 */
export function recomputeDecision(msg, display) {
    if (!msg || typeof msg !== 'object') return { apply: false, reason: 'no-message' };
    if (typeof display !== 'string' || display.length === 0) return { apply: false, reason: 'empty-display' };
    if (display === msg.extra?.[DISPLAY_KEY]) return { apply: false, reason: 'consistent' };
    return { apply: true, reason: 'changed' };
}

/** 写回重算后的显示缓存（rph_display + display_text + 指纹），供下次事件直接使用新样式。
 * 模板渲染消息（rph_template_render）跳过 display_text 写回（显示由第三部接管）。 */
export function commitDisplay(msg, display, fp) {
    if (!msg || typeof msg !== 'object' || typeof display !== 'string') return msg;
    msg.extra ??= {};
    msg.extra[DISPLAY_KEY] = display;
    if (typeof fp === 'string' && fp.length > 0) msg.extra[DISPLAY_FP_KEY] = fp;
    if (!isTemplateRendered(msg)) msg.extra.display_text = display;
    return msg;
}

/**
 * 酒馆助手 TH-render 检测（修复 3）：.mes_text 内已存在 TH-render iframe 界面时
 * 尊重酒馆助手渲染结果，跳过我们的覆盖。
 * @param {object|null} $mesText 可注入 fake（{ length, find: () => ({ length }) }）
 * @returns {boolean}
 */
export function hasTavernHelperRender($mesText) {
    if (!$mesText || !$mesText.length) return false;
    try {
        return $mesText.find('div.TH-render, div.TH-render iframe').length > 0;
    } catch {
        return false;
    }
}

/**
 * 文本是否为 JSR（酒馆助手）前端代码块判定命中（is_frontend.ts 语义：html> / <head> / <body）。
 * 纯函数，node 可测。用于 rescanForIframe 的「未包裹前端 pre」判定。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isFrontendCodeText(text) {
    const s = String(text ?? '');
    return s.includes('html>') || s.includes('<head>') || s.includes('<body');
}

/**
 * DOM 内是否存在「未被 TH-render 包裹」的前端代码块 pre（编辑取消恢复用 rescan 判定）。
 * 修复（编辑取消奇偶交替）：旧守卫「存在任何 TH-render 即跳过补发 RENDERED」会在 cocktail
 * html-render-cache 钉住的隐藏旧 iframe 存在时吞掉补发，导致新写入的引擎显示围栏无人
 * iframe 化；改为「存在**未包裹**的前端 pre 才补发」—— 已包裹的尊重 JSR 结果，
 * 未包裹的（我们刚写入的围栏）触发 JSR 重扫。
 * @param {object|null} $mesText 可注入 fake（{ length, find }，find 返回 toArray 数组）
 * @returns {boolean}
 */
export function hasUnwrappedFrontendPre($mesText) {
    if (!$mesText || !$mesText.length) return false;
    try {
        const list = typeof $mesText.find === 'function' ? $mesText.find('pre') : [];
        const pres = typeof list.toArray === 'function' ? list.toArray() : [];
        for (const pre of pres) {
            if (!pre || typeof pre.closest !== 'function') continue;
            if (pre.closest('div.TH-render')) continue; // 已包裹（JSR 已 iframe 化，尊重其结果）
            if (isFrontendCodeText(pre.textContent)) return true;
        }
    } catch {
        return false;
    }
    return false;
}

/** 引擎渲染结果写入 .mes_text 时的标记 class（识别「当前 DOM 是否已是引擎结果」）。 */
export const RENDER_MARK_CLASS = 'rph-rendered';

/**
 * 当前 .mes_text 是否已是本扩展引擎渲染结果（纯函数，node 可测）。
 *
 * 修复 4：coverMessage 的「一致跳过」只在当前 DOM 已是引擎结果时成立。打开已有聊天时
 * ST 用 mes 重建 DOM（.mes_text 是 ST 默认纯文本渲染 —— 无 TH-render、无本扩展标记），
 * 此时 rph_display 虽在磁盘但界面没出来 → 需视同强制覆盖。
 *
 * 判定特征：
 *   1. 酒馆助手 TH-render iframe 存在（修复 3 语义：已渲染则尊重其结果，视为引擎结果）；
 *   2. 前端显示（display 命中 isFrontendCodeText：html> / <head> / <body）→ 必须有围栏
 *      pre（TH 尚未 iframe 化）才算引擎结果 —— rph-rendered 类在外部清空 DOM 后会残留，
 *      不能单独作为前端消息的判据（发送刷新后残留类 + 纯正文 = 已被重置，需强制覆盖）；
 *   3. 非前端消息 / 未传 display → .mes_text 带本扩展写入标记 class（RENDER_MARK_CLASS）。
 * 均不满足 → 当前是 ST 默认 mes 渲染 → 非引擎结果。
 * @param {object|null} $mesText 可注入 fake（{ length, find, hasClass }）
 * @param {string} [display] 引擎显示字符串（rph_display）；前端消息据此要求实际围栏/iframe
 * @returns {boolean}
 */
export function isEngineRenderedDom($mesText, display) {
    if (!$mesText || !$mesText.length) return false;
    if (hasTavernHelperRender($mesText)) return true;
    // 前端显示（完整文档/界面片段）：引擎输出必有围栏 pre（TH 尚未 iframe 化）或已 iframe 化。
    // rph-rendered 类在外部清空 DOM 后会残留 —— 酒馆助手 refreshOneMessage（玄狐 forceRefreshAll
    // 发送刷新）做 $mesText.empty() 只删子节点、保留 .mes_text 上的类，此时 DOM 已退回 ST 原文
    // 渲染（纯正文），残留类不能证明「仍是引擎结果」→ 前端消息必须看实际 DOM（围栏 pre / iframe）。
    // A1 修复：前端判定除完整文档（html>/<head>/<body）外，还需覆盖 <style>/<script>/<iframe
    // 开头的 fragment（fenceFullHtml 会为其补骨架围栏），否则该类片段消息仍落到残留类判据，
    // 出现「DOM 被外部清空、类残留」时误判为引擎结果。
    // 片段界面（div/article/span/... 开头且含 class/onclick/script 标记）同理（fenceFullHtml
    // 为其补骨架围栏 → 命中 isFrontendCodeText 的 html>），也需纳入，避免落到残留类判据。
    if (isFrontendCodeText(display) || isFragmentFrontend(display) || isFragmentInterface(display)) {
        return hasUnwrappedFrontendPre($mesText);
    }
    // 非前端消息（无围栏/iframe 可判）：rph-rendered 标记即可（缺省 display 时保持旧语义）
    try {
        return typeof $mesText.hasClass === 'function' && $mesText.hasClass(RENDER_MARK_CLASS);
    } catch {
        return false;
    }
}

/**
 * coverMessage「一致跳过」绕过决策（纯函数，node 可测）。
 * 重算不一致（apply=true）→ 必须覆盖；重算一致时默认跳过 DOM 覆盖（高频强制刷新场景
 * 避免反复重写 DOM），但若当前 DOM 不是引擎渲染结果（打开已有聊天时 ST 用 mes 重建
 * DOM —— rph_display 在磁盘但界面是 ST 默认纯文本渲染）→ 仍强制覆盖。
 * @param {{ apply?: boolean, isEngineRendered?: boolean }} arg
 *   apply：recomputeDecision 结果（true=重算结果与缓存不一致，需覆盖）
 *   isEngineRendered：当前 .mes_text 是否已是引擎结果（isEngineRenderedDom）
 * @returns {{ cover: boolean, reason: string }}
 */
export function coverSkipDecision({ apply = false, isEngineRendered = true } = {}) {
    if (apply === true) return { cover: true, reason: 'changed' };
    if (isEngineRendered === false) return { cover: true, reason: 'dom-not-engine' };
    return { cover: false, reason: 'consistent' };
}

/**
 * coverMessage 决策（纯函数）：编辑态跳过；rph_display 存在才覆盖。
 * @param {object} msg
 * @param {JQuery|object|null} $mesText 可注入 fake（{ find: () => [], length: 0, prop: () => 'DIV' }）
 * @returns {{ shouldCover: boolean, text: string|null }}
 */
export function coverDecision(msg, $mesText = null) {
    if (!msg || typeof msg !== 'object') return { shouldCover: false, text: null };
    if ($mesText && isEditingDom($mesText)) return { shouldCover: false, text: null };
    const text = msg.extra?.[DISPLAY_KEY];
    if (typeof text !== 'string' || text.length === 0) return { shouldCover: false, text: null };
    return { shouldCover: true, text };
}

/** 由消息派生态位（placement=1/2/3, role=1/2），供 st/rphub 双模式 run 使用。 */
export function derivePlacement(msg) {
    if (!msg || typeof msg !== 'object') return { placement: 2, role: 2 };
    const isUser = !!msg.is_user;
    const isNarrator = msg.extra?.type === 'narrator';
    return {
        placement: isUser ? 1 : (isNarrator ? 3 : 2),
        role: isUser ? 1 : 2,
    };
}

/**
 * 生成期 prompt 逐条处理的上下文推导（F3，纯函数，node 可测）。
 * 逐字复刻原版 script.js:4444-4445 + 4486：
 *   placement = user→1 / narrator→3 / AI→2；
 *   depth = total - index - (isContinue ? 2 : 1)；
 *   role = user→1 / 其它→2（rphub 语义）。
 * @param {object|null} item 消息对象（读 is_user / extra.type / index）
 * @param {number} index 数组内下标（item.index 缺失时兜底）
 * @param {number} total 数组长度（coreChat.length）
 * @param {string} [type] 生成类型（'continue' 时 depth 额外 -1）
 * @returns {{ placement: number, depth: number, role: number }}
 */
export function derivePromptContext(item, index, total, type = '') {
    const isContinue = type === 'continue';
    const placement = item?.is_user ? 1 : (item?.extra?.type === 'narrator' ? 3 : 2);
    const depth = total - (Number.isInteger(item?.index) ? item.index : index) - (isContinue ? 2 : 1);
    const role = item?.is_user ? 1 : 2;
    return { placement, depth, role };
}
