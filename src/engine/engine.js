/**
 * 引擎核心 —— run()：双模式（rphub/st）调度、双通道分流、脚本合并、超时预算。
 *
 * 契约（供后续阶段管道调用）：
 *   engine.run({
 *     text: string,                        // 必填，待处理文本
 *     scripts: Array<object>,              // 必填，脚本列表（调用方已合并三类存储）
 *     mode: 'st' | 'rphub',                // 必填，语义模式（来自 formatDetail）
 *     isDisplay?: boolean,                 // 显示通道标记
 *     isPrompt?: boolean,                  // prompt 通道标记
 *     isEdit?: boolean,                    // 编辑保存标记（st 语义：isEdit && !runOnEdit 跳过）
 *     depth?: number,                      // 消息深度（0=最后一条；undefined 跳过深度过滤）
 *     placement?: number | null,           // st 语义的 regex_placement 枚举（1/2/3/5/6）
 *     role?: number | string | null,       // rphub 语义的 role（1=user, 2=AI；undefined → 跳过 placement 过滤）
 *     characterOverride?: string,          // trim/宏的 name2Override
 *     macros?: object,                     // 可注入 ST 完整宏引擎 { substituteParams, substituteParamsExtended }
 *     budgetMs?: number,                   // 每条正则预算（默认 50ms；管道经 runtime.engineRun
 *                                          //   注入 rp_hub_budget_ms 设置，超时预算可配置化）
 *     options?: object,                    // { stGeneralMode?: 'both'|'verbatim',
 *                                          //   allowUserOnlyDoubleFalse?, protectEnabled?,
 *                                          //   protectItems?（保护替换配置，仅 rphub 生效），
 *                                          //   precheckEnabled?, precheckBypassKeys?（ReDoS 预检
 *                                          //   可配置化：总开关 + 绕过键表，st/rphub 双模式生效），
 *                                          //   autoProtectScript?（引擎级自动脚本区保护总开关，
 *                                          //   默认 true；仅 legacy 渲染模式生效 ——
 *                                          //   two_pass_121 由界面段藏走替代），
 *                                          //   renderMode?: 'two_pass_121'|'legacy'（渲染模式，
 *                                          //   默认 'two_pass_121' = 1→2→1 两阶段管线；
 *                                          //   'legacy' = 现状顺序混跑），
 *                                          //   passRules?: { first: object[], second: object[] }
 *                                          //   （渲染遍次过滤规则，rp_hub_pass_rules 注入；
 *                                          //   仅 two_pass_121 生效。规则为空 → 回退现状默认
 *                                          //   分桶：预设进 ①/③、剩余进 ②；规则非空 → 完全按
 *                                          //   规则分桶，见 shouldEnterPass），
 *                                          //   cleanRules?: Array<{ pattern: string,
 *                                          //   replaceEnabled?: boolean, replace?: string|null }>
 *                                          //   （清洗规则，rp_hub_clean_rules 注入；仅
 *                                          //   two_pass_121 生效。阶段② 藏走这些正则匹配的
 *                                          //   代码块；空数组 = 不藏任何。replaceEnabled=true
 *                                          //   的规则匹配段在阶段④ 还原为 replace（空 = 删除段），
 *                                          //   否则恢复原位），
 *                                          //   secondPassFilter?: object（第二次预设过滤，
 *                                          //   rp_hub_second_pass_filter 注入；仅 two_pass_121
 *                                          //   阶段③ 生效。mode='all' = 全部第二遍跑一遍（默认）；
 *                                          //   custom = 按位置/名称过滤，见 shouldRunSecondPass），
 *                                          //   secondPassEnabled?: boolean（阶段③ 预设第二遍总开关，
 *                                          //   rp_hub_second_pass_enabled 注入；仅 two_pass_121
 *                                          //   生效。缺省 false = 关闭 → 整个第二遍跳过（预设只跑
 *                                          //   一次阶段①，减小前端压力）；true = 开启 → 第二遍按
 *                                          //   filter / rp_skip_second_pass 约束跑，两者独立叠加） }
 *   })
 *   => { text: string, applied: Array<{ scriptName, timedOut?, reason?, elapsedMs? }> }
 *
 * 渲染模式（rp_hub_render_mode，默认 two_pass_121）：
 *   - legacy：顺序跑全部脚本（合并顺序）+ 自动隔离脚本区（autoProtectScript）—— 现状行为。
 *   - two_pass_121（1→2→1 渲染管线，用户最终方案）：
 *       ① 第一遍（第一遍规则选中的脚本，默认 = 预设）：界面生成 + 纯文本清理；
 *       ② 分拣：界面段（清洗规则 cleanRules 匹配的代码块：```html 围栏 / 完整 HTML 文档 /
 *          <script> 等）占位符藏走 → 阶段②（剩余脚本，默认 = scoped+global 美化桶）在剩余
 *          纯正文上跑美化（^ 锚定不失效、界面段不可见；纯段内 <script> 掩蔽）；
 *       ③ 第二遍（secondPassEnabled 开启时，第二遍规则选中的脚本，默认 = 预设）：在②基础上
 *          再跑（rp_skip_second_pass 勾选则跳过该条；受 secondPassFilter 过滤；disabled 优先；
 *          默认关闭 → 预设只跑一次阶段①）;
 *       ④ 拼回：界面段按原位置还原（replaceEnabled 规则 → 还原为替换文本，空 = 删除段；
 *          其余恢复原位）。
 *       界面与美化正文并存，各管各的（用户方案）。手动预处理（rp_preprocess/rp_scope_*）
 *       仍优先，两模式都尊重。
 *
 * 执行语义：
 *   1. 脚本合并顺序 = 传入顺序（调用方已按脚本类型排序；SPreset 兼容：三类顺序由
 *      window.__regexScriptOrder 决定）。本模块不排序，只按传入顺序执行。
 *   2. 双通道：调用方分别调 run({isDisplay:true}) 与 run({isPrompt:true})；
 *      单次调用内只有一个通道活跃（isDisplay/isPrompt 任一为 true 即按对应通道解释）。
 *   3. 逐脚本【分层解释器】（修复 1，用户拍板）：
 *        - 预设 / 全局脚本永远按酒馆标准（st 解释器）执行 —— markdownOnly/promptOnly/
 *          placement 全按 st 语义（stChannelOk 逐字复刻），预设作者的隐藏/美化行为
 *          100% 按预设意图生效；
 *        - RP 卡（mode='rphub'）的卡内嵌 scoped 脚本按 rphub 解释器 —— 保留保护替换 /
 *          userOnly 过滤等 RP 语义；
 *        - 其它（非 RP 卡 scoped）= st。
 *      判定依据 = 脚本的 rp_source 标签（mergeScripts 打标）：useRphub =
 *      mode==='rphub' && script.rp_source==='scoped'。任一脚本超时 → 跳过并记录
 *      （applied[] + console.warn）。
 *
 * 本模块是纯函数，不依赖 DOM / ST 全局。
 */

import { defaultSubstituteParams, defaultSubstituteParamsExtended } from './macros.js';
import { stShouldRun, runRegexScriptSt } from './interpreter/st.js';
import { rphubShouldRun, runRegexScriptRphub } from './interpreter/rphub.js';
import { normalizeRegexModifiers } from './rphub-normalize.js';

const defaultMacros = {
    substituteParams: defaultSubstituteParams,
    substituteParamsExtended: defaultSubstituteParamsExtended,
};

/**
 * 脚本规范化（st 字段默认值，对照原版默认）。
 * 调用方合并三类存储时通常会传 ST 12 字段；此处兜底，防止缺失字段导致异常。
 * rphub 模式保留原始字段（其 placement 缺省 = [1,2] 全生效、enabled 缺省 = 启用），
 * 由 rphub 解释器按 RP-Hub 语义兜底。
 */
function normalizeScript(script, mode = 'st') {
    if (!script || typeof script !== 'object') return null;
    if (mode === 'rphub') {
        return { ...script };
    }
    return {
        ...script,
        placement: Array.isArray(script.placement) ? script.placement : [1],
        disabled: !!script.disabled,
        markdownOnly: !!script.markdownOnly,
        promptOnly: !!script.promptOnly,
        // 修复 F5（审查报告 L5/D9）：runOnEdit 缺失默认值对齐原版 —— 原版 engine.js:356
        // `isEdit && !script.runOnEdit` 对 undefined 判定为「编辑时跳过」；编辑器新建仍显式 true
        //（logic-core.js EDITOR_NEW_DEFAULTS），此处不再把缺失字段默认成 true。
        runOnEdit: !!script.runOnEdit,
        substituteRegex: Number(script.substituteRegex) || 0,
    };
}

/* ---------- 预处理（rp_preprocess，原「正则自定义作用域」升级） ---------- */

/** 正则特殊字符转义（标签按字面匹配）。 */
export function escapeRegExp(s) {
    return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 旧字段单对作用域是否启用（rp_scope_start / rp_scope_end 均非空，向后兼容旧数据）。 */
export function hasScriptScope(script) {
    return !!script && typeof script === 'object'
        && typeof script.rp_scope_start === 'string' && script.rp_scope_start.length > 0
        && typeof script.rp_scope_end === 'string' && script.rp_scope_end.length > 0;
}

/** 预处理是否启用（rp_preprocess.enabled === true）。恒返回布尔。 */
export function hasPreprocess(script) {
    return !!(script && typeof script === 'object'
        && script.rp_preprocess && typeof script.rp_preprocess === 'object'
        && script.rp_preprocess.enabled === true);
}

/** 脚本是否走作用域/预处理路径（旧字段或新结构任一启用）。恒返回布尔。 */
export function isScopedScript(script) {
    return hasScriptScope(script) || hasPreprocess(script);
}

/** 构建作用域匹配正则：`start + [\s\S]*? + end`（全局，多组都处理，含标签整串）。 */
export function buildScopeRegex(start, end) {
    return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'g');
}

/**
 * 收集预处理段定位器（纯函数，node 可测）。返回定位器数组：
 *   { type:'tags', start, end, includeTags, exclude }  标签对（普通模式）
 *     - start/end 至少一个非空（单标签扩展：只填 start → start 到文本末尾；
 *       只填 end → 文本开头到 end）；start/end 均空 → 跳过该条
 *     - exclude：true = 段外跑（段区域保留，对本条正则隐身）
 *   { type:'regex', re, exclude, replaceEnabled, replace }  正则段（高级模式）
 *     - exclude：true = 段外跑
 *     - replaceEnabled：true = 段区域被 replace 替换（空/缺失 = 删除段），本条正则不在段内跑
 *     - 兼容旧数据：rx 元素为 string → 视为 { pattern: s, exclude:false, replaceEnabled:false, replace:null }
 * 编译失败正则一律跳过；无可执行定位器 → []。
 * @param {object} pp rp_preprocess 结构
 * @returns {Array<object>} 定位器数组
 */
export function collectPreprocessLocators(pp) {
    const locators = [];
    if (!pp || typeof pp !== 'object') return locators;
    if (pp.mode === 'advanced') {
        const rxList = Array.isArray(pp.rx) ? pp.rx : [];
        for (const item of rxList) {
            // 兼容旧字符串数组：字符串 → { pattern: s, exclude:false, replaceEnabled:false, replace:null }
            const entry = typeof item === 'string' ? { pattern: item } : (item && typeof item === 'object' ? item : {});
            const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
            if (!pattern) continue;
            let re;
            try { re = new RegExp(pattern, 'g'); } catch { continue; } // 编译失败跳过该条
            locators.push({
                type: 'regex',
                re,
                exclude: entry.exclude === true,
                replaceEnabled: entry.replaceEnabled === true,
                replace: typeof entry.replace === 'string' ? entry.replace : null,
            });
        }
        return locators;
    }
    const rules = Array.isArray(pp.rules) ? pp.rules : [];
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const start = typeof rule.start === 'string' ? rule.start.trim() : '';
        const end = typeof rule.end === 'string' ? rule.end.trim() : '';
        if (!start && !end) continue; // 单标签扩展：至少填一个；均空 → 跳过
        locators.push({ type: 'tags', start, end, includeTags: rule.includeTags !== false, exclude: rule.exclude === true });
    }
    return locators;
}

/** 构建标签段正则源（普通模式）：双标签 / 单开始→末尾 / 单结束→开头。 */
function buildTagSegmentSource(loc) {
    if (loc.start && loc.end) return `${escapeRegExp(loc.start)}[\\s\\S]*?${escapeRegExp(loc.end)}`;
    if (loc.start) return `${escapeRegExp(loc.start)}[\\s\\S]*$`; // 单开始：start 标签到文本末尾
    if (loc.end) return `^[\\s\\S]*?${escapeRegExp(loc.end)}`;   // 单结束：文本开头到 end 标签
    return null;
}

/* ---------- 占位符掩蔽/还原（两条线路隔离核心，applyOutsideSegments 新版） ---------- */

/**
 * 段占位符前后缀：`\u0001RP_SCOPE_n\u0001`（控制字符 + 固定串）。
 * 用控制字符 \u0001 保证与聊天文本/HTML 内容冲突概率趋零（正文、标签、脚本内容
 * 均不会出现该字符），且占位符短小 —— 掩蔽后整段文本保持「完整连续」，`^`/`$` 锚定
 * 与整段匹配的正则（如不死斩 [11] 正文沉浸框 `^(?!\s*<)...`）不因切碎而失效。
 */
const SEG_PLACEHOLDER_PREFIX = '\u0001RP_SCOPE_';
const SEG_PLACEHOLDER_SUFFIX = '\u0001';

/** 当前时间（毫秒；F10 跨段预算时钟用，与 budget.js 同源）。 */
const nowMs = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => performance.now()
    : () => Date.now();

/** 段正则编译缓存（O4：maskSegments/applyOutsideSegments 按 segSource 复用编译结果）。 */
const segRegexCache = new Map();

/** 取（缓存的）段正则（`new RegExp(segSource, 'g')`，native replace 会重置 lastIndex）。 */
function getSegRegex(segSource) {
    let re = segRegexCache.get(segSource);
    if (!re) {
        re = new RegExp(segSource, 'g');
        segRegexCache.set(segSource, re);
    }
    return re;
}

/**
 * 把 segSource 匹配的所有段逐个替换成唯一占位符，返回掩蔽文本 + 段记录。
 * @param {string} s 原文
 * @param {string} segSource 段正则源（不含首尾斜杠）
 * @param {string} [prefix] 占位符前缀（缺省 = 作用域占位符 \u0001RP_SCOPE_；
 *   界面段用 \u0001RP_UI_，两者同法）
 * @returns {{ masked: string, parts: Array<{ placeholder: string, seg: string }> }}
 */
function maskSegments(s, segSource, prefix = SEG_PLACEHOLDER_PREFIX) {
    const re = getSegRegex(segSource);
    const parts = [];
    let counter = 0;
    const masked = s.replace(re, (seg) => {
        const placeholder = `${prefix}${counter}${SEG_PLACEHOLDER_SUFFIX}`;
        parts.push({ placeholder, seg });
        counter++;
        return placeholder;
    });
    return { masked, parts };
}

/** 按记录把占位符逐字还原成原始段（split/join 字面替换，幂等，不解析正则）。 */
function restoreSegments(masked, parts) {
    let out = masked;
    for (const { placeholder, seg } of parts) {
        out = out.split(placeholder).join(seg);
    }
    return out;
}

/**
 * 按记录把清洗规则占位符还原/替换/删除（split/join 字面替换，幂等，不解析正则）。
 * 每条匹配段按其规则记录处理：
 *   - replaceEnabled=true → 还原为 rule.replace（有值 = 替换为它；空 = 删除段，不恢复原段）；
 *   - replaceEnabled=false → 恢复原始段（原位拼回，默认）。
 * 「空 = 删除段」而非「不替换」（对齐预处理高级模式 replaceEnabled 语义）。
 */
function restoreCleanSegments(masked, parts) {
    if (!Array.isArray(parts) || parts.length === 0) return masked;
    // O4（审查报告 P4）：单趟还原 —— split/join 逐段是 O(P×text)，这里一次正则替换 O(text)
    const map = new Map();
    for (const part of parts) {
        map.set(part.placeholder, part.replaceEnabled ? String(part.replace ?? '') : part.seg);
    }
    return String(masked ?? '').replace(/\u0001RP_UI_\d+\u0001/g, (ph) => (map.has(ph) ? map.get(ph) : ph));
}

/**
 * 用「占位符掩蔽 + 还原」实现排除模式（两条线路隔离核心，替换旧 split 切碎法）：
 *   1. 把 segSource 匹配的所有段（含标签整段）逐个替换成唯一占位符
 *      `\u0001RP_SCOPE_n\u0001`（正文保持完整连续 → `^` 锚定 / 整段匹配正则不失效）；
 *   2. 在【整个掩蔽文本】上跑 applyFn —— 脚本区已是占位符，applyFn 碰不到段内内容；
 *   3. 跑完把占位符还原成原始段（段区域最终原样保留）。
 *
 * 与旧 split 法的差异（汇报）：
 *   - 旧法：`split(/(段源)/)` 把文本切碎 → 段外片段不再是消息开头 → `^` 锚定/整段匹配
 *     正则（正文沉浸框 `^(?!\s*<)...`）整条不匹配 → 正文 UI 整块缺失（狐策实测回归）。
 *   - 新法：正文连续，正则正常整段匹配；段内容被占位符遮蔽，正则既匹配不到也改写不了
 *     段内内容（狐策脚本不再被包进单引号 HTML）。
 *   - 边界（已知，可接受）：若 applyFn 的匹配跨过占位符（把占位符随正文一并替换/删除），
 *     该段区域随匹配一起消失 —— 语义上「段内容未被本条正则在段内匹配」，与排除本意
 *     一致；罕见（跨段匹配需正则特意跨过脚本区）。
 * @param {string} s 当前文本
 * @param {string} segSource 段正则源（排除模式：段区域保留，对本条正则隐身）
 * @param {(masked: string) => string} applyFn 对【掩蔽后的完整文本】的替换函数
 * @returns {string} 处理后文本（段区域已还原）
 */
function applyOutsideSegments(s, segSource, applyFn) {
    const { masked, parts } = maskSegments(String(s ?? ''), segSource);
    if (parts.length === 0) return applyFn(String(s ?? '')); // 无段 → 直接跑（与旧法一致）
    const processed = applyFn(masked);
    return restoreSegments(processed, parts);
}

/**
 * 对单个定位器执行 applyFn / 替换（纯函数，node 可测）。
 * 模式优先级（互斥）：
 *   - exclude=true（段外）：段区域（含标签整段）原样保留，applyFn 只跑段外 —— 输出中段区域
 *     完好 → 下一条正则在后续管道仍看到完整信息（关键约束）。
 *   - replaceEnabled=true（高级替换）：段区域被 replace 值取代（空/缺失 = '' 删除段）；
 *     applyFn 不跑（段已被改写/删除）。
 *   - 默认（段内）：applyFn 跑在段内（includeTags 决定段是否含标签）。
 * @param {string} text 当前文本
 * @param {object} loc 定位器（collectPreprocessLocators 产出）
 * @param {(segment: string) => string} applyFn 单段替换函数（返回替换后段文本）
 * @returns {string} 处理后文本
 */
export function applyScopeLocator(text, loc, applyFn) {
    const s = String(text ?? '');
    if (loc.type === 'regex') {
        if (loc.exclude) {
            // 段外跑：段区域保留（对本条正则隐身），applyFn 只跑段外
            return applyOutsideSegments(s, loc.re.source, applyFn);
        }
        if (loc.replaceEnabled) {
            // 替换模式：段区域被 replace 取代（空/缺失 = '' 删除），applyFn 不跑
            const repl = loc.replace ?? '';
            return s.replace(loc.re, () => repl);
        }
        return s.replace(loc.re, (seg) => applyFn(seg));
    }
    // tags 定位器
    const segSource = buildTagSegmentSource(loc);
    if (!segSource) return s; // 收集时已过滤，防御
    if (loc.exclude) {
        // 段外跑：段区域（含标签整段）保留，applyFn 只跑段外；单标签时同理
        return applyOutsideSegments(s, segSource, applyFn);
    }
    if (loc.includeTags === false) {
        // 不含标签：只对标签内文本执行（标签原样保留）。单标签扩展：只填 start → 标签后到
        // 末尾；只填 end → 开头到标签前。
        if (loc.start && loc.end) {
            const re = new RegExp(`${escapeRegExp(loc.start)}([\\s\\S]*?)${escapeRegExp(loc.end)}`, 'g');
            return s.replace(re, (_m, inner) => `${loc.start}${applyFn(inner)}${loc.end}`);
        }
        if (loc.start) {
            const re = new RegExp(`${escapeRegExp(loc.start)}([\\s\\S]*)$`, 'g');
            return s.replace(re, (_m, inner) => `${loc.start}${applyFn(inner)}`);
        }
        if (loc.end) {
            const re = new RegExp(`^([\\s\\S]*?)${escapeRegExp(loc.end)}`, 'g');
            return s.replace(re, (_m, inner) => `${applyFn(inner)}${loc.end}`);
        }
        return s;
    }
    // 含标签（默认）：对整段（含标签）执行
    const re = new RegExp(segSource, 'g');
    return s.replace(re, (seg) => applyFn(seg));
}

/**
 * 预处理/作用域包裹执行（纯函数，node 可测）。
 * 优先级：
 *   1. rp_preprocess（新结构）启用 → 按 mode 收集定位器（basic 标签对含单标签扩展 /
 *      advanced 正则段），对每个定位器依次执行（**并集语义**：所有定位器都处理；
 *      **顺序应用语义**：后一条定位器在先前定位器的输出上执行，段重叠时后者可见前者的
 *      结果，即「后者覆盖前者」）。
 *      每条定位器语义（见 applyScopeLocator）：
 *       - 默认：本条正则只在段内跑，段外原样；
 *       - exclude（排除）：本条正则只在**段外**跑，段区域保留在结果（对本条正则隐身）
 *         —— 输出中段区域完好 → 下一条正则拿完整信息（管道文本不被改写，关键约束）；
 *       - replaceEnabled（高级替换）：段区域被替换文本取代（空 = 删除段），本条正则不跑段。
 *   2. 旧字段 rp_scope_start/rp_scope_end（单对，向后兼容）→ 等价 basic 单对含标签。
 *   3. 均未启用 → applyFn(text) 原样。
 * 空规则 / 编译失败定位器跳过；全部跳过（无可执行定位器）→ 原样返回（无段可执行）。
 * @param {object} script 脚本对象（读 rp_preprocess / rp_scope_*）
 * @param {string} text 待处理文本
 * @param {(segment: string) => string} applyFn 单段替换函数（返回替换后段文本）
 * @returns {string} 处理后文本
 */
export function applyScoped(script, text, applyFn) {
    const s = String(text ?? '');
    if (hasPreprocess(script)) {
        const locators = collectPreprocessLocators(script.rp_preprocess);
        if (locators.length === 0) return s; // 无段可执行 → 原样
        let out = s;
        for (const loc of locators) out = applyScopeLocator(out, loc, applyFn);
        return out;
    }
    if (hasScriptScope(script)) {
        const re = buildScopeRegex(script.rp_scope_start, script.rp_scope_end);
        return s.replace(re, (segment) => applyFn(segment));
    }
    return applyFn(s);
}

/* ---------- 引擎级自动保护脚本区（两条线路隔离，rp_hub_auto_protect_script，默认开） ---------- */

/** `<script ...>...</script>` 整段源（引擎自动保护掩蔽目标；与 protect.js 的 script 项同构）。 */
export const SCRIPT_BLOCK_SOURCE = '<script\\b[^>]*>[\\s\\S]*?<\\/script>';

/**
 * 显示美化脚本是否启用引擎级自动脚本区保护。
 *
 * 背景（两条线路隔离，用户拍板）：卡内嵌单引号 style 美化正则（不死斩 [11]-[16] 正文沉浸框
 * / 对白霓虹牌 / 章节标题等）扫全消息时会把狐策脚本包进单引号 HTML → JS 语法错误 → 脚本
 * 中断（狐策点不动）；用户手动配「排除 &lt;script&gt;」又破坏 `^` 锚定（applyOutsideSegments
 * 旧 split 切碎法 → 段外片段不再是消息开头 → 整条不匹配 → 正文 UI 缺失）。本插件在显示
 * 通道对 `<script>...</script>` 做占位符掩蔽 —— 正文保持完整连续（`^` 锚定不失效），
 * 脚本区对本条正则隐形（不被污染）。等价「自动排除脚本区」，免去逐条手动配置。
 *
 * 只对「美化类」生效，prompt/general 不自动（避免改变 prompt 语义）：
 *   - **rphub 模式**：显示通道执行的脚本即美化脚本（双 false userOnly / markdownOnly，
 *     prompt 干净）→ 显示通道全部自动保护；
 *   - **st 模式**：仅 `markdownOnly === true`（仅显示通道）脚本自动保护；general 双 false
 *     脚本不自动 —— 其「清理/存储」语义可能需处理脚本内容（如剥标签），且非「美化」职责。
 *
 * 与手动配置不冲突：仅当脚本**未配** rp_preprocess / rp_scope_*（非 scoped）时走自动保护；
 * 已配作用域的脚本由用户配置完全接管（手动优先）。
 * @param {object} script 脚本
 * @param {{ isDisplay: boolean, isPrompt: boolean }} ctx
 * @param {'st'|'rphub'} mode
 * @returns {boolean}
 */
export function shouldAutoProtectScript(script, { isDisplay, isPrompt }, mode) {
    if (isPrompt) return false; // prompt 通道不自动（prompt 语义不变）
    if (!isDisplay) return false; // 非显示通道（编辑/存储）不自动
    if (mode === 'rphub') return true; // rphub 显示通道 = 美化通道
    return !!script?.markdownOnly; // st：仅 markdownOnly（仅显示）脚本
}

/**
 * 引擎级自动脚本区保护执行：对 text 做 `<script>...</script>` 占位符掩蔽 →
 * runOnce(掩蔽后的完整文本) → 还原占位符。
 * runOnce 返回 { timedOut, text }（timedOut 时返回掩蔽文本原样，还原后 = 原文不动）。
 * 掩蔽/还原复用 applyOutsideSegments（两条线路隔离核心）。
 * @param {string} text 当前文本
 * @param {(masked: string) => { timedOut: boolean, text: string }} runOnce 单脚本执行
 * @returns {string} 处理后文本（脚本区已还原）
 */
function withScriptMask(text, runOnce) {
    return applyOutsideSegments(text, SCRIPT_BLOCK_SOURCE, (masked) => {
        const r = runOnce(masked);
        return r.timedOut ? masked : r.text;
    });
}

/* ---------- 1→2→1 渲染管线（two_pass_121，默认）：清洗规则/藏走/预设两遍/拼回 ---------- */

/**
 * 内置默认清洗规则（rp_hub_clean_rules 缺省值，settings.js 复用同源；每条含 pattern +
 * replaceEnabled/replace，默认不替换 = 拼回恢复原位）：
 *   - ```html 围栏代码块（狐策/表裏/NC-MAP 产物的围栏形态）
 *   - 完整 HTML 文档：`<html ...>...</html>`（裸文档形态）
 *   - 完整 HTML 文档：`<!DOCTYPE ...>...</html>`（裸文档形态）
 *   - `<script>...</script>` 块（用户拍板追加）
 *   - 裸 ``` 围栏（表裏/狐策模板的 ` ``` + 换行 + 文档 + ``` ` 形态；` ```html ` 规则在前则
 *     长围栏先命中，裸规则兜底短围栏——alternation 顺序最左优先）
 *   - `<content>` / `</content>` 正文包装标签（只藏走标签本身，正文保留在纯段——否则
 *     卡内嵌美化 `^(?!\s*<)` 负前瞻被正文包装标签挡住 → 阅读舱等整段美化不生成，
 *     不死斩「阅读舱不渲染」根因）
 * 阶段② 按此把界面段藏走；规则为空 = 不藏任何（清洗跳过）。
 */
export const DEFAULT_CLEAN_RULES = Object.freeze([
    { pattern: '```html[\\s\\S]*?```', replaceEnabled: false, replace: null },
    { pattern: '<html\\b[^>]*>[\\s\\S]*?<\\/html>', replaceEnabled: false, replace: null },
    { pattern: '<!DOCTYPE[^>]*>[\\s\\S]*?<\\/html>', replaceEnabled: false, replace: null },
    { pattern: '<script\\b[^>]*>[\\s\\S]*?<\\/script>', replaceEnabled: false, replace: null },
    { pattern: '```\\n[\\s\\S]*?```', replaceEnabled: false, replace: null },
    { pattern: '<content>\\s*', replaceEnabled: false, replace: null },
    { pattern: '\\s*<\\/content>', replaceEnabled: false, replace: null },
]);

/** 旧硬编码界面段识别源（保留导出兼容；引擎现用 DEFAULT_CLEAN_RULES，两者等价——脚本块已并入）。 */
export const UI_SEGMENT_SOURCE = '```html[\\s\\S]*?```|<html\\b[^>]*>[\\s\\S]*?<\\/html>|<!DOCTYPE[^>]*>[\\s\\S]*?<\\/html>|```\\n[\\s\\S]*?```|<content>\\s*|\\s*<\\/content>';

/** UI 占位符前缀（与 SEG_PLACEHOLDER 同法；splitAtUIPlaceholders 依赖同形）。 */
const UI_PLACEHOLDER_PREFIX = '\u0001RP_UI_';

/** 清洗规则编译缓存（O4，审查报告 P4）：键 = 归一后规则 JSON → { re, testers }。 */
const cleanRuleCompileCache = new Map();

/** 归一清洗规则并编译 alternation + 锚定复测器（带缓存；`cleanRules` 缺省 = 内置默认）。 */
function compileCleanRules(cleanRules) {
    const rules = Array.isArray(cleanRules) ? cleanRules : DEFAULT_CLEAN_RULES;
    const valid = [];
    for (const rule of rules) {
        // 兼容遗留字符串数组（历史 string[]）→ 对象（无替换）
        const pattern = typeof rule === 'string' ? rule : rule?.pattern;
        const p = String(pattern ?? '').trim();
        if (!p) continue;
        try { new RegExp(p); } catch { continue; } // 编译失败剔除
        valid.push({
            pattern: p,
            replaceEnabled: typeof rule === 'object' && rule.replaceEnabled === true,
            replace: typeof rule === 'object' && typeof rule.replace === 'string' ? rule.replace : null,
        });
    }
    if (valid.length === 0) return null; // 不藏任何（清洗跳过）
    const key = JSON.stringify(valid);
    let compiled = cleanRuleCompileCache.get(key);
    if (!compiled) {
        compiled = {
            re: new RegExp(valid.map((r) => r.pattern).join('|'), 'gi'),
            testers: valid.map((r) => new RegExp(`^(?:${r.pattern})$`, 'i')),
        };
        cleanRuleCompileCache.set(key, compiled);
    }
    return { valid, ...compiled };
}

/**
 * 按清洗规则掩蔽文本中的界面段 → { masked, parts }。
 * 把全部规则的 pattern 用 `|` 拼成一个 alternation 正则（gi，大小写不敏感：```HTML / <HTML
 * / <!doctype），单次 replace 逐匹配藏走 —— **最左匹配 + 规则顺序优先** 语义与旧硬编码
 * UI_SEGMENT_SOURCE 逐字一致（外层文档整体藏走：`<!DOCTYPE html><html>...` 由 doctype 规则
 * 整体命中，不会被 `<html>` 规则拆开）。占位符 `\u0001RP_UI_n\u0001` 短小且正文保持完整
 * 连续 —— 阶段② 卡内嵌美化正则（正文沉浸框 `^(?!\s*<)` 等）的 `^` 锚定不失效。
 *
 * 每条匹配记录所属规则（ruleIndex → replaceEnabled/replace），供阶段④ 按规则还原/替换/删除。
 * 归属判定用「锚定复测」：对匹配段依次用 `^(?:pattern)$`（i）测每条规则，首个命中即该规则 ——
 * 与 alternation 的「同一位置规则顺序优先」语义一致（不会误判给更靠后的规则）。
 * ⚠️ 规则为空 / 全部编译失败 → 不藏任何（{ masked: 原文, parts: [] }，清洗跳过）。
 * ⚠️ 自定义规则之间若重叠：同一位置先出现的规则优先（alternation 顺序）；已藏走的占位符
 * 不会再次被后续匹配命中（占位符含 `\u0001` 控制字符）。
 * @param {string} s 原文
 * @param {Array<{ pattern: string, replaceEnabled?: boolean, replace?: string|null }>|string[]|undefined} [cleanRules]
 *   清洗规则（对象数组，兼容遗留字符串数组；缺省 = 内置默认）
 * @param {number} [counterStart=0] 占位符计数器起始值（阶段② 逐脚本重藏时传入，避免与已藏占位符编号冲突）
 * @returns {{ masked: string, parts: Array<{ placeholder: string, seg: string, replaceEnabled: boolean, replace: string|null }> }}
 */
function maskUISegments(s, cleanRules, counterStart = 0) {
    const str = String(s ?? '');
    // 显式空数组 → 不藏任何（清洗跳过）；undefined/缺省 → 内置默认
    const compiled = compileCleanRules(cleanRules);
    if (!compiled) {
        return { masked: str, parts: [] }; // 清洗跳过：不藏任何
    }
    const { valid, re, testers } = compiled;
    const parts = [];
    let counter = counterStart;
    const masked = str.replace(re, (seg) => {
        let ruleIndex = 0;
        for (let i = 0; i < testers.length; i++) {
            if (testers[i].test(seg)) { ruleIndex = i; break; }
        }
        const rule = valid[ruleIndex];
        const placeholder = `${UI_PLACEHOLDER_PREFIX}${counter}${SEG_PLACEHOLDER_SUFFIX}`;
        parts.push({
            placeholder,
            seg,
            replaceEnabled: rule.replaceEnabled,
            replace: rule.replace,
        });
        counter++;
        return placeholder;
    });
    return { masked, parts };
}

/** 按 UI 占位符边界切分：返回 [pure0, ph0, pure1, ph1, ...]（纯段与占位符交替，首尾可为空串）。 */
function splitAtUIPlaceholders(s) {
    return String(s ?? '').split(/(\u0001RP_UI_\d+\u0001)/g);
}

/**
 * 在「界面占位符已隐藏」的文本上执行单脚本（阶段②/③）：
 * 按 UI 占位符边界把文本切分为**纯正文段**与**占位符段** —— 脚本只在纯正文段上执行
 * （界面占位符对脚本**完全隐形**：不可能被 `^([\s\S]*?)...` 大段匹配吞进阅读舱 →
 * 拼回位置天然正确），占位符原样保留在段间（顺序即原位置）。纯段内由 executor 做
 * <script> 掩蔽（狐策点不动保障）。多段执行只记一条 applied entry（取最后一段的）。
 * O4（审查报告 P4）：`segments` 传入时复用预切分结果（跨脚本原地更新纯段，
 * S×O(text) 全文切分 → 一次切分），不传时内部切分一次并返回拼接文本。
 * F10（审查报告 L10）：`budgetMs>0` 时按**脚本级总预算**计时（跨段共享），
 * 预算耗尽后剩余纯段原样保留（不执行）。
 * @param {object} script 脚本
 * @param {string} maskedText 界面占位符已隐藏的文本（segments 传入时忽略）
 * @param {(script, span, opts) => { text: string, entry: object|null }} executor 单脚本执行器
 * @param {boolean} maskScripts 纯段内是否做 <script> 掩蔽（结构性，不随设置）
 * @param {boolean} [skipBlankSegments=false] 空白段守卫
 * @param {number} [budgetMs=0] 脚本级跨段预算（0 = 不限制）
 * @param {string[]|null} [segments=null] 预切分段数组（原地更新）；传入时返回 { entry }，由调用方 join
 * @returns {{ text: string|null, entry: object|null }}
 */
function runScriptOnMasked(script, maskedText, executor, maskScripts, skipBlankSegments = false, budgetMs = 0, segments = null) {
    const segState = segments || splitAtUIPlaceholders(maskedText);
    let lastEntry = null;
    const start = budgetMs > 0 ? nowMs() : null;
    for (let i = 0; i < segState.length; i++) {
        const part = segState[i];
        if (i % 2 === 1 || !part) {
            continue; // 占位符 / 空纯段原样保留
        }
        if (skipBlankSegments === true && /^\s*$/.test(part)) {
            continue; // 空白段守卫：空白纯段原样保留，不交给脚本
        }
        if (start !== null && nowMs() - start > budgetMs) {
            continue; // F10：脚本级预算耗尽，剩余纯段原样保留
        }
        const r = executor(script, part, { maskScripts });
        segState[i] = r.text;
        if (r.entry) lastEntry = r.entry;
    }
    return { text: segments ? null : segState.join(''), entry: lastEntry };
}

/**
 * 遍次进入判定（1→2→1 管线的接管分桶，纯函数，node 可测）：
 *   - rules 为空（缺省 / 未配置）→ 回退现状默认分桶：`script.rp_source === defaultSource`
 *     （默认 defaultSource='preset'：预设进该遍，其余不进 → 阶段② = 剩余）。
 *   - rules 非空 → 逐条（**先匹配的规则生效**）：
 *       include 匹配 → 进该遍（true）；exclude 匹配 → 不进（false）；无规则命中 → 不进。
 *   - 匹配：field='source' → rp_source 全等；field='name' → 脚本名（scriptName || name）
 *     子串匹配（大小写不敏感）。
 * @param {object} script 脚本（读 rp_source / scriptName / name）
 * @param {object[]|undefined} rules 该遍的规则列表（undefined/[] = 默认分桶）
 * @param {string} [defaultSource='preset'] 默认分桶时进入该遍的来源
 * @returns {boolean}
 */
export function shouldEnterPass(script, rules, defaultSource = 'preset') {
    if (!Array.isArray(rules) || rules.length === 0) {
        // 规则为空 → 回退现状默认分桶（仅 defaultSource 来源的脚本进入该遍）
        return script?.rp_source === defaultSource;
    }
    const name = String(script?.scriptName || script?.name || '');
    const source = String(script?.rp_source || '');
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const match = String(rule.match ?? '').trim();
        if (!match) continue;
        const candidate = rule.field === 'name' ? name : source;
        const hit = rule.field === 'name'
            ? candidate.toLowerCase().includes(match.toLowerCase())
            : candidate === match;
        if (!hit) continue;
        return rule.mode === 'exclude' ? false : true;
    }
    return false;
}

/**
 * 第二次预设过滤判定（1→2→1 阶段③，纯函数，node 可测）：
 *   - filter 缺失 / mode='all' → 全部第二遍跑一遍（现状不变）；
 *   - mode='custom' → 按维度过滤，**维度之间 OR（任一命中即算匹配）**：
 *       - positions：按排序位置（索引 0 开始，第 0 个 = 第一个）。语法：
 *           `1` = 第2个；`1,3` = 第2和4；`1~` = 第2到末尾；`1~4` = 第2到第5
 *           （`~` 范围、`,` 逗号分隔；空 token 忽略；非法 token 忽略）
 *       - nameSimple：脚本名子串包含（大小写不敏感）
 *       - nameRegex：脚本名自定义正则（编译失败忽略该维度）
 *   - mode2：include = 匹配到的进第二遍；exclude = 匹配到的不进。
 *   - ⚠️ custom 模式但三维度全空 → 无过滤（全部第二遍跑，等价 all，避免误伤）。
 * @param {object} script 脚本（读 scriptName / name）
 * @param {number} index 该脚本在第二遍分桶中的位置（0 起，供 positions 匹配）
 * @param {object} [filter] 第二次预设过滤结构（缺省 = all）
 * @returns {boolean}
 */
export function shouldRunSecondPass(script, index, filter) {
    if (!filter || filter.mode !== 'custom') return true;
    const name = String(script?.scriptName || script?.name || '');
    const positions = String(filter.positions ?? '').trim();
    const simple = String(filter.nameSimple ?? '').trim();
    const rx = String(filter.nameRegex ?? '').trim();
    // custom 但三维度全空 → 无过滤（全部第二遍跑，等价 all，避免误伤）
    if (!positions && !simple && !rx) return true;

    let matched = false;
    if (positions) {
        const idx = Number(index);
        for (const token of positions.split(',')) {
            const t = token.trim();
            if (!t) continue;
            const m = t.match(/^(\d+)(?:~(\d*))?$/);
            if (!m) continue;
            const start = Number(m[1]);
            const endRaw = m[2];
            if (endRaw === undefined) {
                // 单索引：1 = 第2个（idx 0 起）
                if (idx === start) { matched = true; break; }
            } else if (endRaw === '') {
                // start~：start 到末尾
                if (idx >= start) { matched = true; break; }
            } else {
                // start~end
                const end = Number(endRaw);
                if (idx >= start && idx <= end) { matched = true; break; }
            }
        }
    }
    if (simple && name.toLowerCase().includes(simple.toLowerCase())) matched = true;
    if (rx) {
        try {
            if (new RegExp(rx).test(name)) matched = true;
        } catch { /* 编译失败忽略该维度 */ }
    }

    if (!matched) return filter.mode2 === 'exclude'; // 无匹配：exclude → 放行（其余跑）；include → 跳过
    return filter.mode2 === 'include'; // 有匹配：include → 跑；exclude → 跳过
}

/**
 * 主入口。
 * @param {object} args 见模块注释契约
 * @returns {{ text: string, applied: Array<object> }}
 */
export function run(args = {}) {
    const {
        text,
        scripts: rawScripts = [],
        mode = 'st',
        isDisplay = false,
        isPrompt = false,
        isEdit = false,
        depth,
        isFirstMessage = false,
        placement = null,
        role = null,
        characterOverride,
        macros = {},
        budgetMs = 50,
        options = {},
    } = args;

    const applied = [];
    if (typeof text !== 'string') {
        return { text: typeof text === 'undefined' ? '' : String(text), applied };
    }
    if (text.length === 0 || !Array.isArray(rawScripts) || rawScripts.length === 0) {
        return { text, applied };
    }

    // 排除第0楼（开场白 = 首条非系统消息，默认开启，设置 rp_hub_exclude_first_message，runtime.engineRun
    // 注入）。两档（excludeFirstMessageFulltextOnly，默认 true = 精细）：
    //   精细（默认）：只跳过「带全文负前瞻 (?![\s\S]*」的 scoped 正则（沉浸式容器 ^(?![\s\S]*(UI标记))
    //     会全文扫描到尾部预置 UI 面板而误伤正文）；隐藏状态 / 状态面板生成等普通 scoped 照常
    //     （与妹生活状态面板靠 scoped 生成，不能被跳过）。
    //   暴力（fulltextOnly=false）：跳过全部 scoped。
    // 预设/全局不受影响。
    const scripts = (options.excludeFirstMessage === true && isFirstMessage === true)
        ? rawScripts.filter((s) => {
            if (!s || s.rp_source !== 'scoped') return true; // 非 scoped 照常
            if (options.excludeFirstMessageFulltextOnly === false) return false; // 暴力档：跳过全部 scoped
            const pattern = String(s.regex ?? s.findRegex ?? '');
            return !/\(\?!\[\\s\\S\]\*/.test(pattern); // 精细档：只跳过全文负前瞻
        })
        : rawScripts;
    if (scripts.length === 0) return { text, applied };

    const { stGeneralMode = 'both', allowUserOnlyDoubleFalse = true, protectEnabled = true, protectItems, precheckEnabled = true, precheckBypassKeys = [], autoProtectScript = true, renderMode = 'two_pass_121', passRules, cleanRules, secondPassFilter, secondPassEnabled = false, skipBlankSegments = false } = options;
    const m = { ...defaultMacros, ...macros };

    // 修复 F1（审查报告 L1/D1-D3）：st 模式强制 legacy —— 原版卡（formatDetail=st）执行顺序与
    // 可见文本必须逐字复刻原版（Global→Preset→Scoped 串行、全文本替换、无界面段藏走）。
    // 1→2→1 渲染管线（two_pass_121：界面段藏走/预设分桶/第二遍）仅服务 rphub 美化管线。
    const effectiveRenderMode = mode === 'st' ? 'legacy' : renderMode;

    // 阶段③（预设第二遍）总开关（options.secondPassEnabled，缺省 false = 关闭；设置
    // rp_hub_second_pass_enabled 经 runtime.engineRun 注入）。用户反馈「前端卡卡的」→ 默认
    // 关闭 = 预设只跑一次（阶段①），减小前端压力。与 secondPassFilter（决定哪些进第二遍）
    // 独立叠加：总开关关 = 整个第二遍跳过；总开关开 = 按 filter/rp_skip_second_pass 约束跑。
    const secondPassOn = secondPassEnabled === true;

    // 引擎级自动脚本区保护总开关（options.autoProtectScript，缺省 true = 启用；
    // 设置 rp_hub_auto_protect_script 经 runtime.engineRun 注入）。仅 legacy 渲染模式生效：
    // two_pass_121 模式下由 1→2→1 管线的界面段藏走替代（结构性 <script> 掩蔽，不随设置）。
    const autoProtectOn = autoProtectScript !== false;
    /**
     * 分层解释器判定（修复 1，用户拍板）：
     *   - 预设 / 全局脚本永远按酒馆标准（st 解释器）执行 —— 预设作者写的隐藏/美化行为
     *     100% 按预设意图（markdownOnly/promptOnly/placement 全按 st 语义 stChannelOk）；
     *   - RP 卡（mode='rphub'）的卡内嵌 scoped 脚本按 rphub 解释器（保留保护替换 /
     *     userOnly 过滤等 RP 语义）；
     *   - 其它（非 RP 卡 scoped）= st。
     * rp_source 由 mergeScripts 在合并时打标（scripts-core.js:228-237），引擎只认该标签；
     * 未打标的脚本（直接传 engine.run 的测试/外部调用）按 st 兜底。
     * @param {object|null} rawScript
     * @returns {'rphub'|'st'}
     */
    const scriptInterpreterMode = (rawScript) => (mode === 'rphub' && rawScript?.rp_source === 'scoped' ? 'rphub' : 'st');
    // legacy：自动保护判定（显示通道美化脚本且未配作用域）—— 按该脚本实际解释器语义判定
    const wantsAutoProtectLegacy = (script) => !isScopedScript(script)
        && autoProtectOn
        && shouldAutoProtectScript(script, { isDisplay, isPrompt }, scriptInterpreterMode(script));
    // two_pass：结构性 <script> 掩蔽（显示通道美化脚本；不随 autoProtectScript 设置）
    const structuralMask = (script) => shouldAutoProtectScript(script, { isDisplay, isPrompt }, scriptInterpreterMode(script));

    /**
     * 单脚本执行器（legacy 与 two_pass_121 共用）。
     * @param {object} rawScript 原始脚本（未归一）
     * @param {string} input 当前文本
     * @param {{ maskScripts?: boolean }} [opts] maskScripts=true：脚本区 <script> 掩蔽
     *   （legacy = 设置驱动 wantsAutoProtectLegacy；two_pass = 结构性 display 美化）
     * @returns {{ text: string, entry: object|null }} entry = 应记入 applied 的条目（null = 未执行/超时）
     *   ⚠️ 超时/预检拦截由 record 回调直接推入 applied（budget.js 语义），此处 entry 返回 null；
   *    成功/作用域/掩蔽路径返回 entry，由调用方统一 push（多段同脚本只记一条）。
     */
    const executor = (rawScript, input, { maskScripts = false } = {}) => {
        // 分层解释器（修复 1）：该脚本走 rphub 还是 st（见 scriptInterpreterMode 注释）。
        // 归一化按实际解释器：st 脚本（预设/全局/非 RP 卡 scoped）统一 st 字段默认值；
        // rphub 脚本（仅 RP 卡 scoped）保留原始字段（rphub 解释器自带缺省兜底）。
        const useRphub = scriptInterpreterMode(rawScript) === 'rphub';
        const script = normalizeScript(rawScript, useRphub ? 'rphub' : 'st');
        if (!script) return { text: input, entry: null };

        // 超时记录回调（budget/ReDoS 拦截直接推 applied；成功路径不在此推）
        const record = (entry) => {
            applied.push({ scriptName: script.scriptName || script.id, ...entry });
        };

        try {
            if (useRphub) {
                if (!rphubShouldRun(script, { isDisplay, isPrompt, role, depth }, { allowUserOnlyDoubleFalse })) {
                    return { text: input, entry: null };
                }
                const rphubOpts = {
                    budgetMs,
                    record,
                    // 保护替换可配置化（引擎设计.md §5）：总开关 + 勾选项透传 rphub 解释器
                    protectEnabled,
                    protectItems,
                    // ReDoS 预检可配置化：总开关 + 绕过键表透传（st/rphub 双模式）
                    precheckEnabled,
                    precheckBypassKeys,
                    // 空白段守卫透传（legacy 渲染模式：保护替换按 HTML 标签切分普通片段时，
                    // 空白片段不交给脚本 —— 与 two_pass_121 阶段②/③ 共用同一设置）
                    skipBlankSegments,
                };
                // 预处理/作用域：只对配置的段执行，段外原样；超时段保持原样（手动配置完全接管）
                if (isScopedScript(script)) {
                    let anyTimedOut = false;
                    const out = applyScoped(script, input, (seg) => {
                        const r = runRegexScriptRphub(script, seg, rphubOpts);
                        if (r.timedOut) anyTimedOut = true;
                        return r.timedOut ? seg : r.text;
                    });
                    // E1 修复：任一段超时已由 record 推 applied，此处不再推成功 entry（避免双记录）
                    return { text: out, entry: anyTimedOut ? null : { scriptName: script.scriptName || script.id } };
                }
                if (maskScripts) {
                    let anyTimedOut = false;
                    const out = withScriptMask(input, (masked) => {
                        const r = runRegexScriptRphub(script, masked, rphubOpts);
                        if (r.timedOut) anyTimedOut = true;
                        return r.timedOut ? { timedOut: true, text: masked } : { timedOut: false, text: r.text };
                    });
                    return { text: out, entry: anyTimedOut ? null : { scriptName: script.scriptName || script.id, autoProtected: true } };
                }
                const r = runRegexScriptRphub(script, input, rphubOpts);
                if (r.timedOut) return { text: input, entry: null };
                return { text: r.text, entry: { scriptName: script.scriptName || script.id, elapsedMs: r.elapsedMs } };
            }
            // st（预设/全局永远 st；非 RP 卡 scoped 也 st —— 酒馆原生语义）
            if (!stShouldRun(script, { placement, isMarkdown: isDisplay, isPrompt, isEdit, depth }, { generalMode: stGeneralMode })) {
                return { text: input, entry: null };
            }
            const stOpts = {
                characterOverride,
                substituteParams: m.substituteParams,
                substituteParamsExtended: m.substituteParamsExtended,
                budgetMs,
                record,
                // ReDoS 预检可配置化：总开关 + 绕过键表透传（st/rphub 双模式）
                precheckEnabled,
                precheckBypassKeys,
            };
            // 预处理/作用域：只对配置的段执行，段外原样；超时段保持原样（手动配置完全接管）
            if (isScopedScript(script)) {
                let anyTimedOut = false;
                const out = applyScoped(script, input, (seg) => {
                    const r = runRegexScriptSt(script, seg, stOpts);
                    if (r.timedOut) anyTimedOut = true;
                    return r.timedOut ? seg : r.text;
                });
                // E1 修复：任一段超时已由 record 推 applied，此处不再推成功 entry（避免双记录）
                return { text: out, entry: anyTimedOut ? null : { scriptName: script.scriptName || script.id } };
            }
            if (maskScripts) {
                let anyTimedOut = false;
                const out = withScriptMask(input, (masked) => {
                    const r = runRegexScriptSt(script, masked, stOpts);
                    if (r.timedOut) anyTimedOut = true;
                    return r.timedOut ? { timedOut: true, text: masked } : { timedOut: false, text: r.text };
                });
                return { text: out, entry: anyTimedOut ? null : { scriptName: script.scriptName || script.id, autoProtected: true } };
            }
            const r = runRegexScriptSt(script, input, stOpts);
            if (r.timedOut) return { text: input, entry: null };
            return { text: r.text, entry: { scriptName: script.scriptName || script.id, elapsedMs: r.elapsedMs } };
        } catch (error) {
            // 单脚本异常跳过（compile error / replace error），与模式语义一致（rphub 捕获、st 忽略）
            const entry = { scriptName: script.scriptName || script.id, error: String(error?.message || error) };
            if (useRphub) {
                console.error(`[rp-hub-compat] 正则脚本「${script.scriptName || script.id}」执行出错，已跳过：`, error);
            }
            return { text: input, entry };
        }
    };

    // 单脚本执行（推 applied entry）
    const runScriptOnce = (script, input, opts) => {
        const r = executor(script, input, opts);
        if (r.entry) applied.push(r.entry);
        return r.text;
    };

    if (effectiveRenderMode === 'legacy') {
        // legacy = 现状：顺序混跑全部脚本 + 自动隔离脚本区（autoProtectScript 设置生效）
        let finalString = text;
        for (const rawScript of scripts) {
            finalString = runScriptOnce(rawScript, finalString, { maskScripts: wantsAutoProtectLegacy(rawScript) });
        }
        return { text: finalString, applied };
    }

    // two_pass_121（默认）= 1→2→1 渲染管线
    // 分桶：按「渲染遍次过滤规则」（rp_hub_pass_rules，options.passRules）判定每遍进入的脚本。
    //   - 规则为空（缺省 / 未配置）→ shouldEnterPass 回退现状默认分桶：第一遍/第二遍 = 来源
    //     preset（defaultSource），阶段② = 剩余 scoped+global 美化桶；
    //   - 用户配了规则（第一遍或第二遍非默认/非空）→ 引擎完全按规则分桶（不管来源硬编码）：
    //       阶段① = 第一遍规则选中的脚本；阶段③ = 第二遍规则选中的脚本（仍受
    //       rp_skip_second_pass 约束）；阶段② = 剩余（既不进①也不进③）的脚本。
    const firstRules = Array.isArray(passRules?.first) ? passRules.first : undefined;
    const secondRules = Array.isArray(passRules?.second) ? passRules.second : undefined;
    const firstScripts = [];
    const secondScripts = [];
    const localScripts = [];
    for (const rawScript of scripts) {
        const script = normalizeScript(rawScript, mode);
        if (!script) continue;
        const inFirst = shouldEnterPass(script, firstRules, 'preset');
        const inSecond = shouldEnterPass(script, secondRules, 'preset');
        if (inFirst) firstScripts.push(script);
        if (inSecond) secondScripts.push(script);
        if (!inFirst && !inSecond) localScripts.push(script);
    }

    let finalString = text;

    // ① 预设第一遍：界面生成（狐策/表裏/NC-MAP 完整文档）+ 纯文本清理（杀八股/OS/隐藏标签）
    for (const script of firstScripts) {
        finalString = runScriptOnce(script, finalString, { maskScripts: structuralMask(script) });
    }

    // ② 分拣 + 卡内嵌美化：
    //    - 界面段（清洗规则藏走：```html 围栏 / 完整 HTML 文档 / <script> 等，rp_hub_clean_rules）
    //      占位符藏走（记录段与位置）；规则为空 = 不藏任何（清洗跳过）
    //    - 阶段②（剩余）脚本在剩余纯正文上跑 —— 界面占位符对它们完全隐形
    //      （按占位符边界切分纯段执行），纯段内做 <script> 掩蔽
    const { masked, parts } = maskUISegments(finalString, cleanRules);
    finalString = masked;
    // O4（审查报告 P4）：一次切分，跨脚本原地更新纯段（占位符含 \u0001 控制字符，脚本不可能
    // 生成/破坏占位符 → 段边界在脚本间稳定）。F10：每脚本独立跨段预算（budgetMs）。
    let segState = splitAtUIPlaceholders(masked);
    // H4 根因修复：卡内嵌脚本（如 ui 脚本）可能在阶段②**才**生成裸完整文档（状态面板），
    // 而首次藏走发生在这些脚本之前 → 漏掉它们 → 后续脚本（正文美化容器 ^([\s\S]+)$）误包。
    // 修复：每个脚本跑完后重新藏走新生成的界面段（占位符计数器续接 parts.length，避免编号冲突）。
    // 幂等：已藏占位符含 \u0001，清洗规则不命中，不会被二次藏走。
    let nextCounter = parts.length;
    for (const script of localScripts) {
        const r = runScriptOnMasked(script, finalString, executor, structuralMask(script), skipBlankSegments === true, budgetMs, segState);
        if (r.entry) applied.push(r.entry);
        const 重藏 = maskUISegments(segState.join(''), cleanRules, nextCounter);
        if (重藏.parts.length > 0) {
            segState = splitAtUIPlaceholders(重藏.masked);
            parts.push(...重藏.parts);
            nextCounter += 重藏.parts.length;
        }
    }
    finalString = segState.join('');

    // ③ 预设第二遍（总开关 secondPassOn，默认关闭 = 跳过整个第二遍直接拼回）：
    //    开启后在②基础上（纯正文 + 卡内嵌美化结果）再跑第二遍规则选中的脚本；
    //    勾 rp_skip_second_pass 的脚本第二次不执行；受「第二次预设过滤」（rp_hub_second_pass_filter，
    //    mode='all' 默认 = 全部跑一遍；custom = 按位置/名称过滤）约束；**disabled 优先**：
    //    脚本 disabled → 即使规则选中也不进第二遍。界面段已藏走 → 界面正则匹配不到已消费的
    //    <fox_selc> 等 → 不重复生成；卡内嵌已替换掉的内容 → 预设第二遍匹配不到 = 卡作者责任。
    if (secondPassOn) {
        for (let i = 0; i < secondScripts.length; i++) {
            const script = secondScripts[i];
            if (script.disabled || script.enabled === false) continue; // disabled 优先
            if (script.rp_skip_second_pass === true) continue;
            if (!shouldRunSecondPass(script, i, secondPassFilter)) continue; // 第二次预设过滤
            const r = runScriptOnMasked(script, finalString, executor, structuralMask(script), skipBlankSegments === true, budgetMs);
            if (r.entry) applied.push(r.entry);
            finalString = r.text;
        }
    }

    // ④ 拼回：界面段按原位置还原（占位符 → 原始界面段）。
    //    每条匹配段按其规则配置处理：replaceEnabled=true → 还原为替换文本（空 = 删除段）；
    //    replaceEnabled=false → 恢复原位（默认）。
    finalString = restoreCleanSegments(finalString, parts);

    return { text: finalString, applied };
}

export { normalizeRegexModifiers };

/** 引擎对象（供入口 / 后续管道使用）。 */
export const engine = { run };
export default { run };
