// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * ui.js —— 面板 UI 层（jQuery 复刻原版正则扩展面板）。
 *
 * 复刻基准：public/scripts/extensions/regex/index.js（2157 行）+ dropdown/editor/debugger
 * /scriptTemplate/importTarget/embedded 模板。区块结构、按钮、交互时序与原版 1:1 对齐，
 * 差异仅在：
 *   - 模板路径：本插件目录（renderTemplateAsync fullPath 方式，见 loadTemplate）
 *   - 数据读写走本插件 src/store/scripts.js（原版存储模型）
 *   - 无斜杠命令（原版 /regex、/regex-preset 等不注册，避免与其它扩展冲突）
 *
 * 依赖全部通过 deps 注入（浏览器全局），本模块只 import 面板纯逻辑（logic-core /
 * debugger-core 的 browser 侧适配）与 ST 全局模板/工具 —— 不参与 node 单测。
 */

import { escapeHtml, getFileText, getSortableDelay, setInfoBlock, download, regexFromString, uuidv4 } from '../../../../../utils.js';
import { renderTemplateAsync } from '../../../../../templates.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../../../popup.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { t } from '../../../../../i18n.js';
import { eventSource, event_types, messageFormatting, reloadCurrentChat, getCurrentChatId, saveSettingsDebounced, characters, this_chid, getRequestHeaders, chat } from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { getPresetManager } from '../../../../../preset-manager.js';
import { selected_group } from '../../../../../group-chats.js';

import * as core from './logic-core.js';
import { executeRegexScriptForDebugging } from './debugger-core.js';
import { analyzeScripts } from './diagnose-core.js';
import { runRegexScriptSt } from '../engine/interpreter/st.js';
import { runtime } from '../pipeline/runtime.js';
import {
    getScriptsByType,
    saveScriptsByType,
    getRegexScripts,
    isScopedScriptsAllowed,
    allowScopedScripts,
    disallowScopedScripts,
    isPresetScriptsAllowed,
    allowPresetScripts,
    disallowPresetScripts,
    getCurrentPresetAPI,
    getCurrentPresetName,
    overlayScriptExtras,
    saveScriptExtras,
    clearScriptExtrasByFingerprint,
    migrateScriptExtrasStorage,
    SCRIPT_TYPES,
    SCRIPT_TYPE_UNKNOWN,
} from '../store/scripts.js';
import { isCleanPromptEnabled, setCleanPromptEnabled, getOrderSource, setOrderSource, getExtrasStorageMode, setExtrasStorageMode, isProtectEnabled, setProtectEnabled, getProtectItems, setProtectItems, getDegradeTarget, setDegradeTarget, getBudgetMs, setBudgetMs, normalizeBudgetMs, isPanelEscapeEnabled, setPanelEscapeEnabled, isPrecheckEnabled, setPrecheckEnabled, getPrecheckBypass, setPrecheckBypass, isAutoProtectScriptEnabled, setAutoProtectScriptEnabled, isExcludeFirstMessageEnabled, setExcludeFirstMessageEnabled, isExcludeFirstFulltextOnly, setExcludeFirstFulltextOnly, getRenderMode, setRenderMode, getCleanRules, setCleanRules, resetCleanRules, DEFAULT_CLEAN_RULES, getSecondPassFilter, setSecondPassFilter, resetSecondPassFilter, SECOND_PASS_FILTER_MODE_ALL, SECOND_PASS_FILTER_MODE_CUSTOM, SECOND_PASS_FILTER_MODE_INCLUDE, SECOND_PASS_FILTER_MODE_EXCLUDE, isSecondPassEnabled, setSecondPassEnabled, isSkipBlankSegments, setSkipBlankSegments, isStreamRenderEnabled, setStreamRenderEnabled, getStreamMatch, setStreamMatch, DEFAULT_STREAM_MATCH, STREAM_MATCH_MODE_BASIC, STREAM_MATCH_MODE_ADVANCED, getStreamExcludes, setStreamExcludes, STREAM_EXCLUDE_ACTION_HIDE, STREAM_EXCLUDE_ACTION_DELETE, STREAM_EXCLUDE_ACTION_REPLACE } from '../store/settings.js';
import { clearModeCache } from '../store/rp-mode.js';

// ---------------------------------------------------------------------------
// 模板加载（与原版 renderExtensionTemplateAsync('regex', 'dropdown') 等价）
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} 模板路径缓存（按模板名）。 */
const TEMPLATE_PATHS = {
    dropdown: 'dropdown',
    editor: 'editor',
    debugger: 'debugger',
    diagnose: 'diagnose',
    scriptTemplate: 'scriptTemplate',
    importTarget: 'importTarget',
    embeddedScripts: 'embeddedScripts',
    presetEmbeddedScripts: 'presetEmbeddedScripts',
};

/** 扩展根目录（动态推导，不硬编码目录名）：本文件位于 <ext>/src/panel/ui.js，模板在 <ext>/ 下。 */
const EXTENSION_ROOT = new URL('../../', import.meta.url).href;

async function loadTemplate(name) {
    const id = TEMPLATE_PATHS[name];
    if (!id) throw new Error(`Unknown template: ${name}`);
    return renderTemplateAsync(`${EXTENSION_ROOT}${id}.html`, {}, true, true, true);
}

// ---------------------------------------------------------------------------
// 调试器弹窗引用（保存/删除后刷新规则列表）
// ---------------------------------------------------------------------------

/** @type {JQuery<HTMLElement>|null} 当前打开的调试器内容容器。 */
let openDebuggerContainer = null;

// ---------------------------------------------------------------------------
// 公共：toggle 图标 / 移动按钮显隐（原版 index.js:486-502）
// ---------------------------------------------------------------------------

function setToggleAllIcon(allAreChecked) {
    const selectAllIcon = $('#bulk_select_all_toggle').find('i');
    selectAllIcon.toggleClass('fa-check-double', !allAreChecked);
    selectAllIcon.toggleClass('fa-minus', allAreChecked);
}

function setMoveButtonsVisibility() {
    const hasGlobalScripts = $('#saved_regex_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    const hasScopedScripts = $('#saved_scoped_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    const hasPresetScripts = $('#saved_preset_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    $('#bulk_regex_move_to_global').toggle(hasScopedScripts || hasPresetScripts);
    $('#bulk_regex_move_to_scoped').toggle(hasGlobalScripts || hasPresetScripts);
    $('#bulk_regex_move_to_preset').toggle(hasGlobalScripts || hasScopedScripts);
}

// ---------------------------------------------------------------------------
// 脚本类型推断 / 选中脚本（原版 index.js:1562-1584）
// ---------------------------------------------------------------------------

function getScriptType(script) {
    for (const scriptType of Object.values(SCRIPT_TYPES)) {
        const scripts = getScriptsByType(scriptType);
        if (scripts.some((s) => s.id === script.id)) {
            return scriptType;
        }
    }
    return SCRIPT_TYPE_UNKNOWN;
}

function getSelectedScripts() {
    // UI1 修复：allowedOnly=false 与面板列表渲染（getScriptsByType 不过滤 allow）口径一致，
    // 否则未允许脚本面板可见可勾选、但批量操作被静默跳过。
    const scripts = getRegexScripts({ allowedOnly: false });
    const selector = '#rph_regex_panel .regex-script-label:has(.regex_bulk_checkbox:checked)';
    const selectedIds = Array.from(document.querySelectorAll(selector))
        .map((e) => e.getAttribute('id'))
        .filter((id) => id);
    return scripts.filter((script) => selectedIds.includes(script.id));
}

// ---------------------------------------------------------------------------
// 保存 / 删除 / 移动（原版 index.js:512-625）
// ---------------------------------------------------------------------------

/** SCRIPT_TYPES → 指纹 kind（方法 2 本地 extras）。 */
function kindFromScriptType(scriptType) {
    if (scriptType === SCRIPT_TYPES.GLOBAL) return 'global';
    if (scriptType === SCRIPT_TYPES.SCOPED) return 'scoped';
    if (scriptType === SCRIPT_TYPES.PRESET) return 'preset';
    return null;
}

/**
 * 配置变更自动重算（需求 1）：保存了带预处理/作用域配置（rp_preprocess）的脚本后，
 * 已持久化的 rph_display 是旧配置生成的缓存 → 自动触发受影响消息的重算，免去手动
 * 「强制重新渲染」。
 *
 * 方案（c，评估后选此）：
 *   1. `window.__rphubCompat__.forceRerenderAll()`（第二部已有）：清 formatDetail 缓存 +
 *      全量重算 rph_display（新脚本集 → 新 rph_display；模板消息 commitDisplay 跳过
 *      display_text，纯数据层重算）；
 *   2. 逐条 `eventSource.emit(CHARACTER_MESSAGE_RENDERED, i)`：第三部 eventMakeFirst 的
 *      `处理事件` 会读新 rph_display 重渲染 display_text（跳过条件 rph_template_body
 *      与旧值不同 → 命中渲染）→ TH iframe 更新。
 *
 * 防循环：重算只写 rph_display / display_text，不写脚本配置 → 不会再次触发本保存路径。
 * 只在保存的脚本带 rp_preprocess 时触发（普通正则编辑不触发，避免不必要全量重算）。
 * @returns {Promise<void>}
 */
async function autoRecomputeAfterConfigSave() {
    try {
        const bridge = typeof window !== 'undefined' ? window.__rphubCompat__ : null;
        if (bridge && typeof bridge.forceRerenderAll === 'function') {
            await bridge.forceRerenderAll();
        }
    } catch (err) {
        console.warn('[rp-hub-compat] 配置变更自动重算（第二部）失败：', String(err?.message || err));
    }
    // 第三部重渲染：逐条 RENDERED 让模板渲染器重读新 rph_display（跳过条件命中才真正渲染）
    const messages = Array.isArray(chat) ? chat : [];
    for (let i = 0; i < messages.length; i++) {
        try {
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, i);
        } catch {
            // 单条失败不影响整体
        }
    }
}

async function saveRegexScript(regexScript, existingScriptIndex, scriptType, saveSettings = true) {
    const array = getScriptsByType(scriptType);

    if (!regexScript.id) {
        regexScript.id = uuidv4();
    }

    if (!regexScript.scriptName) {
        toastr.error(t`Could not save regex script: The script name was undefined or empty!`);
        return;
    }

    if (regexScript.findRegex.length === 0) {
        toastr.warning(t`This regex script will not work, but was saved anyway: A find regex isn't present.`);
    }

    if (regexScript.placement.length === 0) {
        toastr.warning(t`This regex script will not work, but was saved anyway: One "Affects" checkbox must be selected!`);
    }

    // 需求 1：记录本脚本是否带预处理/作用域配置（saveScriptExtras 会剥离 rp_preprocess，
    // 需在剥离前判定）——带配置的脚本保存后自动触发受影响消息重算。
    const hadPreprocess = !!regexScript.rp_preprocess && typeof regexScript.rp_preprocess === 'object'
        && regexScript.rp_preprocess.enabled === true;

    // 方法 2 指纹键控：自定义字段（rp_preprocess）剥离到本地 extras，不写卡/预设文件。
    // 编辑保存时旧脚本（array[existingScriptIndex]）若有旧指纹（改名/改 findRegex 前），
    // 先清旧 key 再写新 key，避免残留脏数据。
    const kind = kindFromScriptType(scriptType);
    if (kind) {
        if (existingScriptIndex !== -1 && array[existingScriptIndex]) {
            clearScriptExtrasByFingerprint(array[existingScriptIndex], kind);
        }
        regexScript = saveScriptExtras(regexScript, kind);
    }

    if (existingScriptIndex !== -1) {
        array[existingScriptIndex] = regexScript;
    } else {
        array.push(regexScript);
    }

    if (scriptType === SCRIPT_TYPES.SCOPED) {
        await saveScriptsByType(array, SCRIPT_TYPES.SCOPED);
        allowScopedScripts(characters?.[this_chid]);
    }

    if (scriptType === SCRIPT_TYPES.PRESET) {
        await saveScriptsByType(array, SCRIPT_TYPES.PRESET);
        allowPresetScripts(getCurrentPresetAPI(), getCurrentPresetName());
    }

    if (saveSettings) {
        saveSettingsDebounced();
        await loadRegexScripts();

        // 需求 1：带预处理配置的脚本保存后自动触发重算（rph_display 用新脚本集重算 +
        // 第三部重渲染），免去手动「强制重新渲染」。
        if (hadPreprocess) {
            await autoRecomputeAfterConfigSave();
        }

        const currentChatId = getCurrentChatId();
        if (currentChatId) {
            await reloadCurrentChat();
        }
    }

    refreshDebuggerRuleList();
}

async function deleteRegexScript(id, scriptType, saveSettings = true) {
    const array = getScriptsByType(scriptType);

    const existingScriptIndex = array.findIndex((script) => script.id === id);
    if (existingScriptIndex !== -1) {
        // 方法 2：删除脚本时同步清理其本地 extras（否则残留脏数据）
        const kind = kindFromScriptType(scriptType);
        if (kind) {
            clearScriptExtrasByFingerprint(array[existingScriptIndex], kind);
        }
        array.splice(existingScriptIndex, 1);

        switch (scriptType) {
            case SCRIPT_TYPES.GLOBAL:
                // will be handled by saveSettingsDebounced
                break;
            case SCRIPT_TYPES.SCOPED:
                await saveScriptsByType(array, SCRIPT_TYPES.SCOPED);
                break;
            case SCRIPT_TYPES.PRESET:
                await saveScriptsByType(array, SCRIPT_TYPES.PRESET);
                break;
            default:
                break;
        }
        if (saveSettings) {
            saveSettingsDebounced();
            await loadRegexScripts();
        }
    }
    refreshDebuggerRuleList();
}

async function moveRegexScript(script, toType, fromType = null, saveSettings = true) {
    if (!Object.values(SCRIPT_TYPES).includes(toType)) {
        console.warn(`moveRegexScript: Invalid target script type ${toType}`);
        return;
    }
    if (!Object.values(SCRIPT_TYPES).includes(fromType)) {
        fromType = getScriptType(script);
    }
    if (fromType === toType || fromType === SCRIPT_TYPE_UNKNOWN || toType === SCRIPT_TYPE_UNKNOWN) {
        return;
    }
    await deleteRegexScript(script.id, fromType, false);
    await saveRegexScript(script, -1, toType, saveSettings);
}

// ---------------------------------------------------------------------------
// 列表渲染（原版 index.js:627-755 loadRegexScripts/renderScript）
// ---------------------------------------------------------------------------

async function loadRegexScripts() {
    $('#saved_regex_scripts').empty();
    $('#saved_scoped_scripts').empty();
    $('#saved_preset_scripts').empty();
    setToggleAllIcon(false);

    const scriptTemplate = $(await loadTemplate('scriptTemplate'));

    /**
     * @param {string} containerId 列表容器 id
     * @param {object} script
     * @param {number} scriptType 类型（SCRIPT_TYPES）
     * @param {number} index
     */
    function renderScript(containerId, script, scriptType, index) {
        const container = $(`#${containerId}`);
        const scriptHtml = scriptTemplate.clone();
        const save = () => saveRegexScript(script, index, scriptType);

        if (!script.id) {
            script.id = uuidv4();
        }

        scriptHtml.attr('id', script.id);
        scriptHtml.find('.regex_script_name').text(script.scriptName).attr('title', script.scriptName);
        scriptHtml.find('.disable_regex').prop('checked', script.disabled ?? false)
            .on('input', async function () {
                script.disabled = !!$(this).prop('checked');
                await save();
            });
        scriptHtml.find('.regex-toggle-on').on('click', function () {
            scriptHtml.find('.disable_regex').prop('checked', true).trigger('input');
        });
        scriptHtml.find('.regex-toggle-off').on('click', function () {
            scriptHtml.find('.disable_regex').prop('checked', false).trigger('input');
        });

        scriptHtml.find('.edit_existing_regex').on('click', async function () {
            await onRegexEditorOpenClick(scriptHtml.attr('id'), scriptType);
        });
        scriptHtml.find('.move_to_global').on('click', async function () {
            const confirm = await callGenericPopup(t`Are you sure you want to move this regex script to global?`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;
            await moveRegexScript(script, SCRIPT_TYPES.GLOBAL, scriptType);
        });
        scriptHtml.find('.move_to_scoped').on('click', async function () {
            if (this_chid === undefined) {
                toastr.error(t`No character selected.`);
                return;
            }
            if (selected_group) {
                toastr.error(t`Cannot edit scoped scripts in group chats.`);
                return;
            }
            const confirm = await callGenericPopup(t`Are you sure you want to move this regex script to scoped?`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;
            await moveRegexScript(script, SCRIPT_TYPES.SCOPED, scriptType);
        });
        scriptHtml.find('.move_to_preset').on('click', async function () {
            const confirm = await callGenericPopup(t`Are you sure you want to move this regex script to preset?`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;
            await moveRegexScript(script, SCRIPT_TYPES.PRESET, scriptType);
        });
        scriptHtml.find('.export_regex').on('click', async function () {
            const fileName = core.exportFileNameForScript(script);
            const fileData = JSON.stringify(script, null, 4);
            download(fileData, fileName, 'application/json');
        });
        scriptHtml.find('.delete_regex').on('click', async function () {
            const confirm = await callGenericPopup(t`Are you sure you want to delete this regex script?`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;
            await deleteRegexScript(script.id, scriptType);
            await reloadCurrentChat();
        });
        scriptHtml.find('.regex_bulk_checkbox').on('change', function () {
            setMoveButtonsVisibility();
            const checkboxes = $('#rph_regex_panel .regex_bulk_checkbox');
            const allAreChecked = checkboxes.length === checkboxes.filter(':checked').length;
            setToggleAllIcon(allAreChecked);
        });
        scriptHtml.find('input[name="regex_expand"]').on('change', function () {
            if (!(this instanceof HTMLInputElement)) return;
            if (!this.checked) return;

            const closeMenuHandler = (e) => {
                if (e.target instanceof HTMLElement) {
                    if (e.target.closest`.regex-script-label`) return;
                    this.checked = false;
                    document.removeEventListener('click', closeMenuHandler);
                }
            };

            setTimeout(() => {
                document.addEventListener('click', closeMenuHandler, { passive: true, once: false });
            }, 0);
        });

        container.append(scriptHtml);
    }

    getScriptsByType(SCRIPT_TYPES.GLOBAL).forEach((script, index) => renderScript('saved_regex_scripts', script, SCRIPT_TYPES.GLOBAL, index));
    getScriptsByType(SCRIPT_TYPES.SCOPED).forEach((script, index) => renderScript('saved_scoped_scripts', script, SCRIPT_TYPES.SCOPED, index));
    getScriptsByType(SCRIPT_TYPES.PRESET).forEach((script, index) => renderScript('saved_preset_scripts', script, SCRIPT_TYPES.PRESET, index));

    $('#regex_scoped_toggle').prop('checked', isScopedScriptsAllowed(characters?.[this_chid]));
    $('#regex_preset_toggle').prop('checked', isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()));
    $('#regex_clean_prompt_toggle').prop('checked', isCleanPromptEnabled());
    $('#regex_order_source_spreset').prop('checked', getOrderSource() === 'spreset');
    $('#regex_order_source_st').prop('checked', getOrderSource() === 'st');

    // 插件设置：脚本自定义字段存储位置（localStorage 默认 / extension_settings 可选）
    $('#regex_extras_storage_local').prop('checked', getExtrasStorageMode() === 'local');
    $('#regex_extras_storage_settings').prop('checked', getExtrasStorageMode() === 'settings');

    // 插件设置：渲染模式（rp_hub_render_mode，默认 two_pass_121 = 1→2→1 两阶段管线）
    $('#regex_render_mode').val(getRenderMode());

    // 插件设置：流式实时渲染（rp_hub_stream_render_enabled + rp_hub_stream_match + rp_hub_stream_excludes）
    $('#regex_stream_render_toggle').prop('checked', isStreamRenderEnabled());
    renderStreamMatch(getStreamMatch());
    renderStreamExcludes(getStreamExcludes());
    renderStreamModeBlocks();

    // 插件设置：清洗规则（rp_hub_clean_rules，阶段② 藏走代码块的正则列表）
    renderCleanRules(getCleanRules());

    // 插件设置：第二次预设过滤（rp_hub_second_pass_filter，阶段③ 用哪些预设正则）
    const secondFilter = getSecondPassFilter();
    $('#regex_second_pass_mode').val(secondFilter.mode);
    $('#regex_second_pass_positions').val(secondFilter.positions);
    $('#regex_second_pass_name_simple').val(secondFilter.nameSimple);
    $('#regex_second_pass_name_regex').val(secondFilter.nameRegex);
    $('#regex_second_pass_mode2').prop('checked', secondFilter.mode2 === SECOND_PASS_FILTER_MODE_EXCLUDE);

    // 插件设置：阶段③（预设第二遍）总开关（rp_hub_second_pass_enabled，默认 false = 关闭）
    $('#regex_second_pass_enabled_toggle').prop('checked', isSecondPassEnabled());

    // 插件设置：空白段守卫（rp_hub_skip_blank_segments，默认 true = 开启）
    $('#regex_skip_blank_segments_toggle').prop('checked', isSkipBlankSegments());

    // 插件设置：引擎级自动脚本区保护总开关（rp_hub_auto_protect_script，默认 true = 启用；
    // 两条线路隔离 —— 显示美化正则自动对 <script> 掩蔽，正文连续 + 脚本区隐形）
    $('#regex_auto_protect_script_toggle').prop('checked', isAutoProtectScriptEnabled());

    // 插件设置：排除第0楼（开场白）总开关（rp_hub_exclude_first_message，默认 true = 启用）
    $('#regex_exclude_first_message_toggle').prop('checked', isExcludeFirstMessageEnabled());
    // 插件设置：排除第0楼 精细/暴力档位（rp_hub_exclude_first_fulltext_only，默认 true = 只跳过全文负前瞻）
    $('#regex_exclude_first_fulltext_toggle').prop('checked', isExcludeFirstFulltextOnly());

    // 插件设置：保护替换总开关 + 保护项勾选（引擎设计.md §5）
    $('#regex_protect_toggle').prop('checked', isProtectEnabled());
    const protectItems = new Set(getProtectItems());
    $('#regex_protect_items_list .regex_protect_item').each(function () {
        $(this).prop('checked', protectItems.has($(this).data('item')));
    });

    // 插件设置：降级目标（rp_hub_degrade_target，默认 st）
    $('#regex_degrade_target').val(getDegradeTarget());

    // 插件设置：超时预算（rp_hub_budget_ms，默认 50ms；回填当前值）
    $('#regex_budget_ms').val(getBudgetMs());

    // 插件设置：ReDoS 预检总开关（rp_hub_precheck_enabled，默认 true = 启用）
    $('#regex_precheck_toggle').prop('checked', isPrecheckEnabled());

    setMoveButtonsVisibility();
}

// ---------------------------------------------------------------------------
// 清洗规则（rp_hub_clean_rules，1→2→1 阶段② 藏走代码块）+ 第二次预设过滤（阶段③）
// ---------------------------------------------------------------------------

/** 渲染清洗规则行列表。 */
function renderCleanRules(rules) {
    $('#regex_clean_rules .rp_clean_rule_row, #regex_clean_rules .rp_clean_rule_replace_row').remove(); // 清旧行（主行 + 替换行；保留「添加」按钮）
    (Array.isArray(rules) ? rules : []).forEach((rule) => addCleanRuleRow(rule));
}

/**
 * 新增一行清洗规则（空行 / 回填行）。主行（正则 + 替换按钮 + 删除）后紧跟一条替换输入行
 * （默认隐藏；替换按钮展开/收起）——与预处理高级模式替换按钮同款交互。
 * entry 兼容遗留字符串 → 视为 { pattern, replaceEnabled:false, replace:null }。
 */
function addCleanRuleRow(entry) {
    const item = typeof entry === 'string' ? { pattern: entry, replaceEnabled: false, replace: null }
        : (entry && typeof entry === 'object' ? entry : {});
    const tpl = $('#regex_clean_rule_template');
    const row = tpl.clone().removeClass('displayNone').removeAttr('id').addClass('rp_clean_rule_row');
    row.find('input[name="rp_clean_rule"]').val(item.pattern ?? '');
    $('#regex_clean_rules').append(row);
    // 替换输入行（紧随主行；replaceEnabled 时展开）。加独立 class 便于清除/定位（防残留）。
    const replTpl = $('#regex_clean_rule_replace_template').clone().removeClass('displayNone').removeAttr('id').addClass('rp_clean_rule_replace_row');
    replTpl.find('input[name="rp_clean_rule_replace"]').val(typeof item.replace === 'string' ? item.replace : '');
    $('#regex_clean_rules').append(replTpl);
    if (item.replaceEnabled !== true) {
        // 用 displayNone class（ST 全局 !important），并清内联残留（与 renderMode 同一修复模式）
        replTpl.addClass('displayNone').css('display', '');
    }
}

/** 收集清洗规则行 → 对象数组（跳过 pattern 空行；replace 输入行跟随主行）。 */
function collectCleanRules() {
    const rules = [];
    // 主行 + 替换行成对；遍历主行，找其后的替换行
    $('#regex_clean_rules .rp_clean_rule_row').each(function () {
        const row = $(this);
        const pattern = String(row.find('input[name="rp_clean_rule"]').val() ?? '').trim();
        if (!pattern) return;
        const replRow = row.next('.rp_clean_rule_replace_row');
        const replaceEnabled = replRow.length > 0 && !replRow.hasClass('displayNone');
        const replace = replRow.length > 0 ? String(replRow.find('input[name="rp_clean_rule_replace"]').val() ?? '') : null;
        rules.push({ pattern, replaceEnabled, replace });
    });
    return rules;
}

/** 从 DOM 收集清洗规则 → setCleanRules + 持久化 + 自动重算显示。 */
function saveCleanRulesFromDom() {
    setCleanRules(collectCleanRules());
    saveSettingsDebounced();
    window.__rphubCompat__?.forceRerenderAll?.();
}

/** 绑定清洗规则 + 第二次预设过滤 UI：行增删（事件委托）、每行替换展开/收起、恢复默认、变更持久化 + 重算显示。 */
function bindCleanAndSecondPassEditor() {
    // 清洗规则：增行（主行 + 替换输入行）/ 行删（连替换输入行）/ 值变更 → 持久化 + 重算
    $('#regex_clean_add').on('click', function () {
        addCleanRuleRow({});
        saveCleanRulesFromDom();
    });
    // 行内删除（事件委托：动态行）—— 删除主行时连其后的替换输入行一起删
    $('body').on('click', '.rp_clean_rule_remove', function () {
        const row = $(this).closest('.rp_clean_rule_row');
        row.next('.rp_clean_rule_replace_row').remove();
        row.remove();
        saveCleanRulesFromDom();
    });
    $('#regex_clean_rules').on('input change', 'input', function () {
        saveCleanRulesFromDom();
    });
    // 每行替换按钮：展开/收起该主行后的替换输入行（displayNone class + 清内联残留，
    // 与预处理高级模式替换按钮同款交互）。有值 = 该条匹配的段替换为它；留空 = 删除该条匹配的段。
    $('body').on('click', '.rp_clean_rule_replace_btn', function () {
        const row = $(this).closest('.rp_clean_rule_row');
        const replRow = row.next('.rp_clean_rule_replace_row');
        if (replRow.length > 0) {
            const willShow = replRow.hasClass('displayNone');
            replRow.toggleClass('displayNone', !willShow).css('display', '');
        }
        saveCleanRulesFromDom();
    });
    // 清洗规则恢复默认
    $('#regex_clean_reset').on('click', function () {
        resetCleanRules();
        renderCleanRules(DEFAULT_CLEAN_RULES);
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(t`已恢复默认清洗规则（\`\`\`html 围栏 + 完整 HTML 文档 + script + 裸围栏 + content 标签）。`);
    });

    // 阶段③（预设第二遍）总开关（rp_hub_second_pass_enabled，默认 false = 关闭）。
    // 切换 = 引擎执行路径变化（整个第二遍是否跑）→ 自动重算全部消息显示。
    $('#regex_second_pass_enabled_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setSecondPassEnabled(isEnable);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启第二次预设（阶段③）：预设正则第二遍再跑一遍（受下方过滤规则约束）。`
            : t`已关闭第二次预设（默认）：预设只跑一次（阶段①），减小前端压力。`);
    });

    // 空白段守卫（rp_hub_skip_blank_segments，默认 true = 开启）。
    // 切换 = 引擎执行路径变化（纯空白段是否交给脚本）→ 自动重算全部消息显示。
    $('#regex_skip_blank_segments_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setSkipBlankSegments(isEnable);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启空白段守卫：纯空白段不交给美化脚本（防「整段匹配型」正则包出空卡片）。`
            : t`已关闭空白段守卫（默认）：空白段照常交给脚本。`);
    });

    // 第二次预设过滤：模式 / 维度 / 包含排除变更 → 持久化 + 重算
    $('#regex_second_pass_mode, #regex_second_pass_positions, #regex_second_pass_name_simple, #regex_second_pass_name_regex, #regex_second_pass_mode2').on('input change', function () {
        saveSecondPassFilterFromDom();
    });
    // 恢复默认（mode=all）
    $('#regex_second_pass_reset').on('click', function () {
        resetSecondPassFilter();
        $('#regex_second_pass_mode').val(SECOND_PASS_FILTER_MODE_ALL);
        $('#regex_second_pass_positions').val('');
        $('#regex_second_pass_name_simple').val('');
        $('#regex_second_pass_name_regex').val('');
        $('#regex_second_pass_mode2').prop('checked', false);
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(t`已恢复默认第二次预设过滤（全部预设第二遍跑一遍）。`);
    });
}

/** 从 DOM 收集第二次预设过滤 → setSecondPassFilter + 持久化 + 自动重算显示。 */
function saveSecondPassFilterFromDom() {
    setSecondPassFilter({
        mode: $('#regex_second_pass_mode').val() === SECOND_PASS_FILTER_MODE_CUSTOM ? SECOND_PASS_FILTER_MODE_CUSTOM : SECOND_PASS_FILTER_MODE_ALL,
        positions: $('#regex_second_pass_positions').val(),
        nameSimple: $('#regex_second_pass_name_simple').val(),
        nameRegex: $('#regex_second_pass_name_regex').val(),
        mode2: $('#regex_second_pass_mode2').prop('checked') === true ? SECOND_PASS_FILTER_MODE_EXCLUDE : SECOND_PASS_FILTER_MODE_INCLUDE,
    });
    saveSettingsDebounced();
    window.__rphubCompat__?.forceRerenderAll?.();
}

// ---------------------------------------------------------------------------
// 流式实时渲染配置（rp_hub_stream_render_enabled / rp_hub_stream_match / rp_hub_stream_excludes）
// ---------------------------------------------------------------------------

/** 当前匹配配置高级模式状态（#regex_stream_advanced_toggle 的 data-advanced，与编辑器预处理同款）。 */
function isStreamAdvanced() {
    return $('#regex_stream_advanced_toggle').data('advanced') === true;
}

/** 渲染匹配配置行列表 + 高级模式切换状态（回填用）。 */
function renderStreamMatch(match) {
    const m = match && typeof match === 'object' ? match : {};
    const advanced = m.mode === STREAM_MATCH_MODE_ADVANCED;
    $('#regex_stream_advanced_toggle').data('advanced', advanced);
    $('#regex_stream_advanced_toggle').find('small').text(advanced ? '标准模式' : '高级模式');
    // 匹配作用 radio 回填（排除模式特性；缺省 include）
    const exclude = m.route === 'exclude';
    $('input[name="rp_stream_route"][value="exclude"]').prop('checked', exclude);
    $('input[name="rp_stream_route"][value="include"]').prop('checked', !exclude);
    renderRouteVisibility(exclude);
    const rules = Array.isArray(m.rules) ? m.rules : [];
    const rx = Array.isArray(m.rx) ? m.rx : [];
    $('#regex_stream_rules_container .rp_stream_rule_row').remove();
    $('#regex_stream_rx_container .rp_stream_rx_row').remove();
    if (advanced) {
        if (rx.length === 0) addStreamRxRow({});
        else rx.forEach((x) => addStreamRxRow(x));
    } else {
        if (rules.length === 0) addStreamRuleRow({});
        else rules.forEach((r) => addStreamRuleRow(r));
    }
    renderStreamModeVisibility();
}

/** 新增一行标准标签对（空行 / 回填行）。 */
function addStreamRuleRow(rule) {
    const tpl = $('#regex_stream_rule_template');
    const row = tpl.clone().removeClass('displayNone').removeAttr('id').addClass('rp_stream_rule_row');
    row.find('input[name="rp_stream_rule_start"]').val(rule?.start ?? '');
    row.find('input[name="rp_stream_rule_end"]').val(rule?.end ?? '');
    // 匹配方式（贪婪匹配至末标签）：首个=缺省/现行懒匹配；最后一个=锚定文中最后一次出现
    row.find('select[name="rp_stream_rule_match"]').val(rule?.match === 'last' ? 'last' : 'first');
    $('#regex_stream_rules_container').append(row);
}

/** 新增一行高级段正则（空行 / 回填行）。 */
function addStreamRxRow(item) {
    const pattern = typeof item === 'string' ? item : (item && typeof item === 'object' ? item.pattern ?? '' : '');
    const tpl = $('#regex_stream_rx_template');
    const row = tpl.clone().removeClass('displayNone').removeAttr('id').addClass('rp_stream_rx_row');
    row.find('input[name="rp_stream_rx_input"]').val(pattern ?? '');
    $('#regex_stream_rx_container').append(row);
}

/** 收集匹配配置 DOM → { mode, rules, rx }。 */
function collectStreamMatch() {
    const advanced = isStreamAdvanced();
    const rules = [];
    $('#regex_stream_rules_container .rp_stream_rule_row').each(function () {
        const start = String($(this).find('input[name="rp_stream_rule_start"]').val() ?? '').trim();
        const end = String($(this).find('input[name="rp_stream_rule_end"]').val() ?? '').trim();
        if (start || end) rules.push({ start, end });
    });
    const rx = [];
    $('#regex_stream_rx_container .rp_stream_rx_row').each(function () {
        const pattern = String($(this).find('input[name="rp_stream_rx_input"]').val() ?? '').trim();
        if (pattern) rx.push({ pattern });
    });
    return {
        mode: advanced ? STREAM_MATCH_MODE_ADVANCED : STREAM_MATCH_MODE_BASIC,
        rules,
        rx,
        // 匹配作用（排除模式）：include=选中标签交 RP（缺省/现行）；exclude=选中标签区间交酒馆原生
        route: $('input[name="rp_stream_route"]:checked').val() === 'exclude' ? 'exclude' : 'include',
    };
}

/**
 * 匹配作用（route）联动渲染：排除态把 excludes 区块置灰并显示提示条 —— excludes 列表
 * 作用于「已被 RP 接管的段内容」，排除模式下没有任何段被接管，列表不适用（《排除模式
 * 报告》§2.5：两套排除层次不同，UI 隔离防无效调参困惑）。样式走内联，避免新增样式表。
 * @param {boolean} [exclude] 是否排除态；缺省读当前 radio
 */
function renderRouteVisibility(exclude) {
    const isExclude = typeof exclude === 'boolean'
        ? exclude
        : $('input[name="rp_stream_route"]:checked').val() === 'exclude';
    const $container = $('#regex_stream_excludes_container');
    if ($container.length === 0) return;
    let $notice = $('#regex_stream_exclude_notice');
    if ($notice.length === 0) {
        $notice = $('<small id="regex_stream_exclude_notice" class="displayNone" style="display:block;text-align:left;color:#e0a24a;margin:2px 0"></small>')
            .text('⚠️ 排除模式下不适用：本列表用于处理已被 RP 接管的段内容；当前不会有任何段被接管。');
        $container.closest('.flex-container.marginTop5').before($notice);
    }
    $notice.toggleClass('displayNone', !isExclude);
    const $title = $container.closest('.flex-container.marginTop5');
    const dim = { opacity: isExclude ? '0.45' : '', 'pointer-events': isExclude ? 'none' : '' };
    $title.css(dim);
    $title.next('small').css(dim);
    $container.css(dim);
}

/** 渲染排除规则行列表（回填用）。 */
function renderStreamExcludes(excludes) {
    $('#regex_stream_excludes_container .rp_stream_exclude_row').remove();
    (Array.isArray(excludes) ? excludes : []).forEach((e) => addStreamExcludeRow(e));
}

/** 新增一行排除规则（空行 / 回填行）。 */
function addStreamExcludeRow(rule) {
    const tpl = $('#regex_stream_exclude_template');
    const row = tpl.clone().removeClass('displayNone').removeAttr('id').addClass('rp_stream_exclude_row');
    row.find('input[name="rp_stream_exclude_pattern"]').val(rule?.pattern ?? '');
    row.find('select[name="rp_stream_exclude_action"]').val(rule?.action ?? STREAM_EXCLUDE_ACTION_HIDE);
    row.find('input[name="rp_stream_exclude_replace"]').val(typeof rule?.replace === 'string' ? rule.replace : '');
    $('#regex_stream_excludes_container').append(row);
    renderExcludeReplaceVisibility(row);
}

/** 动作 = 替换 时显示该行的替换输入，藏走/删除 时隐藏（displayNone class + 清内联残留）。 */
function renderExcludeReplaceVisibility(row) {
    const action = String(row.find('select[name="rp_stream_exclude_action"]').val() ?? '');
    const replaceInput = row.find('input[name="rp_stream_exclude_replace"]');
    if (action === STREAM_EXCLUDE_ACTION_REPLACE) {
        replaceInput.removeClass('displayNone').css('display', '');
    } else {
        replaceInput.addClass('displayNone').css('display', '');
    }
}

/** 收集排除规则 DOM → 规则数组（跳过 pattern 空行）。 */
function collectStreamExcludes() {
    const rules = [];
    $('#regex_stream_excludes_container .rp_stream_exclude_row').each(function () {
        const pattern = String($(this).find('input[name="rp_stream_exclude_pattern"]').val() ?? '').trim();
        if (!pattern) return;
        const action = String($(this).find('select[name="rp_stream_exclude_action"]').val() ?? '');
        rules.push({
            pattern,
            action: action === STREAM_EXCLUDE_ACTION_DELETE || action === STREAM_EXCLUDE_ACTION_REPLACE ? action : STREAM_EXCLUDE_ACTION_HIDE,
            replace: typeof $(this).find('input[name="rp_stream_exclude_replace"]').val() === 'string'
                ? $(this).find('input[name="rp_stream_exclude_replace"]').val()
                : null,
        });
    });
    return rules;
}

/** 普通/高级模式显隐（对齐编辑器预处理 renderMode 模式）。 */
function renderStreamModeVisibility() {
    const advanced = isStreamAdvanced();
    const $rulesBlock = $('#regex_stream_rules_container');
    const $rxBlock = $('#regex_stream_rx_container');
    $rulesBlock.toggleClass('displayNone', advanced).css('display', '');
    $rxBlock.toggleClass('displayNone', !advanced).css('display', '');
}

/**
 * 两种渲染模式区块互斥显隐（对称隐藏）：
 *   - 开关开（流式实时渲染 / 模式二）→ 隐藏「模式一专属」区块（.rp_stream_mode1：
 *     渲染模式 / 渲染遍次过滤 / 清洗规则 / 第二次预设 / 空白段守卫 / 自动隔离脚本区），
 *     显示流式配置区块（.rp_stream_mode2：段匹配配置 + 排除规则 + 恢复默认）；
 *   - 开关关（完整渲染 / 模式一）→ 反向：显示模式一区块，隐藏流式配置区块。
 * 流式总开关本身始终显示（两种模式的切换入口）。
 */
function renderStreamModeBlocks() {
    const enabled = isStreamRenderEnabled();
    $('.rp_stream_mode1').toggleClass('displayNone', enabled).css('display', '');
    $('.rp_stream_mode2').toggleClass('displayNone', !enabled).css('display', '');
}

/** 从 DOM 收集匹配配置 + 排除规则 → setter + 持久化。 */
function saveStreamConfigFromDom() {
    const before = getStreamMatch().route === 'exclude' ? 'exclude' : 'include';
    const collected = collectStreamMatch();
    setStreamMatch(collected);
    setStreamExcludes(collectStreamExcludes());
    // 匹配作用切换提示（不弹 confirm：settingsFp 已纳管 route，缓存自动失效、
    // 历史消息在下次渲染事件按新模式重算——非破坏性，toast 指引立即生效入口即可）
    if (before !== (collected.route || 'include') && typeof toastr !== 'undefined' && toastr?.info) {
        toastr.info(t`匹配作用已切换：历史消息将在下次渲染事件时更新；如需立即生效，请使用「强制重新渲染」。`, undefined, { timeOut: 6000 });
    }
    saveSettingsDebounced();
}

/** 绑定流式实时渲染配置 UI：开关、模式切换、增删行、动作联动、恢复默认、变更持久化。 */
function bindStreamRenderEditor() {
    // 总开关（rp_hub_stream_render_enabled，默认 false = 完整渲染）
    $('#regex_stream_render_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setStreamRenderEnabled(isEnable);
        saveSettingsDebounced();
        // 两种模式区块互斥显隐（模式一选项 / 流式配置）
        renderStreamModeBlocks();
        toastr.info(isEnable
            ? t`已开启流式实时渲染：流式期间按「段匹配配置」实时渲染段内容（闭合后交回酒馆）。`
            : t`已关闭流式实时渲染（默认）：完整文本获取后一次性渲染。`);
    });

    // 普通/高级模式切换
    $('#regex_stream_advanced_toggle').on('click', function () {
        $('#regex_stream_advanced_toggle').data('advanced', !isStreamAdvanced());
        $('#regex_stream_advanced_toggle').find('small').text(isStreamAdvanced() ? '标准模式' : '高级模式');
        // 切换后保证目标模式至少一条空行可编辑（对齐编辑器预处理：新建默认一条）
        if (isStreamAdvanced()) {
            if ($('#regex_stream_rx_container .rp_stream_rx_row').length === 0) addStreamRxRow({});
        } else {
            if ($('#regex_stream_rules_container .rp_stream_rule_row').length === 0) addStreamRuleRow({});
        }
        renderStreamModeVisibility();
        saveStreamConfigFromDom();
    });

    // 匹配作用 radio（排除模式）：即时联动 excludes 区块置灰/提示条，并走统一保存（含切换 toast）
    $('input[name="rp_stream_route"]').on('change', function () {
        renderRouteVisibility();
        saveStreamConfigFromDom();
    });

    // 添加标签对 / 段正则 / 排除规则
    $('#regex_stream_add_rule').on('click', function () {
        addStreamRuleRow({});
        saveStreamConfigFromDom();
    });
    $('#regex_stream_add_rx').on('click', function () {
        addStreamRxRow({});
        saveStreamConfigFromDom();
    });
    $('#regex_stream_add_exclude').on('click', function () {
        addStreamExcludeRow({});
        saveStreamConfigFromDom();
    });

    // 行内删除（事件委托：动态行）
    $('body').on('click', '.rp_stream_rule_remove', function () {
        $(this).closest('.rp_stream_rule_row').remove();
        saveStreamConfigFromDom();
    });
    $('body').on('click', '.rp_stream_rx_remove', function () {
        $(this).closest('.rp_stream_rx_row').remove();
        saveStreamConfigFromDom();
    });
    $('body').on('click', '.rp_stream_exclude_remove', function () {
        $(this).closest('.rp_stream_exclude_row').remove();
        saveStreamConfigFromDom();
    });

    // 值变更（input/change）→ 持久化
    $('#regex_stream_rules_container, #regex_stream_rx_container').on('input change', 'input', function () {
        saveStreamConfigFromDom();
    });
    $('#regex_stream_excludes_container').on('input change', 'input, select', function () {
        renderExcludeReplaceVisibility($(this).closest('.rp_stream_exclude_row'));
        saveStreamConfigFromDom();
    });

    // 恢复默认：开关关 + 内置默认匹配（标准模式预填正文标签 <content>）+ 无排除 + 匹配作用回「包含」+ match 回「首个」
    $('#regex_stream_reset').on('click', function () {
        setStreamRenderEnabled(false);
        $('#regex_stream_render_toggle').prop('checked', false);
        setStreamMatch(DEFAULT_STREAM_MATCH);
        setStreamExcludes([]);
        renderStreamMatch(DEFAULT_STREAM_MATCH);
        renderStreamExcludes([]);
        renderStreamModeBlocks();
        renderRouteVisibility();
        saveSettingsDebounced();
        toastr.info(t`已恢复默认流式配置（开关关、标准模式默认匹配正文标签 <content>、无排除、匹配作用=包含、匹配方式=首个）。`);
    });
}

/**
 * 编辑器联动：计算该脚本「第二遍执行状态」提示文本（1→2→1 模式）。
 * 读当前第二次预设过滤（rp_hub_second_pass_filter）+ 脚本字段（disabled / rp_skip_second_pass）。
 * 位置维度在编辑器内无法预知（需完整排序上下文）→ 文本里注明「位置由运行时决定」。
 * @param {object|null} script 正在编辑的脚本（null = 新建）
 * @param {JQuery} editorHtml 编辑器 DOM（读 rp_skip_second_pass 勾选态）
 * @returns {string} 状态提示文本
 */
function secondPassStatusText(script, editorHtml) {
    // 阶段③（预设第二遍）总开关关闭 → 整个第二遍不执行（预设只跑一次阶段①）
    if (!isSecondPassEnabled()) {
        return '第二遍：已关闭（阶段③ 总开关默认关闭，预设只跑一次阶段①；可在插件设置开启）。';
    }
    const skip = editorHtml.find('input[name="rp_skip_second_pass"]').prop('checked') === true;
    const disabled = !!(script?.disabled || script?.enabled === false)
        || editorHtml.find('input[name="disabled"]').prop('checked') === true;
    if (disabled) return '第二遍：跳过（脚本已禁用）。';
    if (skip) return '第二遍：跳过（已勾选「第二次不执行」）。';
    const filter = getSecondPassFilter();
    if (filter.mode !== SECOND_PASS_FILTER_MODE_CUSTOM) {
        return '第二遍：执行（当前为「全部」模式）。';
    }
    // custom：按可预知的维度（名称）评估；位置维度运行时决定
    const name = String(script?.scriptName || script?.name || '');
    let nameMatched = false;
    if (filter.nameSimple && name.toLowerCase().includes(String(filter.nameSimple).toLowerCase())) nameMatched = true;
    if (filter.nameRegex) {
        try { if (new RegExp(filter.nameRegex).test(name)) nameMatched = true; } catch { /* 忽略 */ }
    }
    const posSet = String(filter.positions ?? '').trim() !== '';
    const hasRule = posSet || nameMatched;
    const decided = nameMatched ? (filter.mode2 === SECOND_PASS_FILTER_MODE_EXCLUDE ? '跳过' : '执行') : null;
    const parts = [];
    parts.push(hasRule
        ? (decided
            ? `第二遍：${decided}（名称${nameMatched ? '命中' : '未命中'}${posSet ? '；位置由运行时决定' : ''}）。`
            : '第二遍：由位置规则决定（位置由运行时决定）。')
        : '第二遍：执行（自定义过滤未命中任何维度 → 视为全部）。');
    return parts.join('');
}

// ---------------------------------------------------------------------------
// 编辑器（原版 index.js:763-872）
// ---------------------------------------------------------------------------

/** 把脚本字段回填到编辑器 DOM（原版 index.js:772-795）。 */
function fillEditorFromScript(editorHtml, script) {
    const fields = core.fillEditorFields(script);
    editorHtml.find('.regex_script_name').val(fields.scriptName);
    editorHtml.find('.find_regex').val(fields.findRegex);
    editorHtml.find('.regex_replace_string').val(fields.replaceString);
    editorHtml.find('.regex_trim_strings').val(fields.trimStrings);
    editorHtml.find('input[name="disabled"]').prop('checked', fields.disabled);
    editorHtml.find('input[name="only_format_display"]').prop('checked', fields.markdownOnly);
    editorHtml.find('input[name="only_format_prompt"]').prop('checked', fields.promptOnly);
    editorHtml.find('input[name="run_on_edit"]').prop('checked', fields.runOnEdit);
    editorHtml.find('input[name="rp_skip_second_pass"]').prop('checked', fields.rp_skip_second_pass === true);
    editorHtml.find('select[name="substitute_regex"]').val(fields.substituteRegex);
    editorHtml.find('input[name="min_depth"]').val(fields.minDepth);
    editorHtml.find('input[name="max_depth"]').val(fields.maxDepth);
    fields.placement.forEach((element) => {
        editorHtml.find(`input[name="replace_position"][value="${element}"]`).prop('checked', true);
    });
    // 预处理回填
    fillPreprocessEditor(editorHtml, fields);
}

/** 预处理回填：清空现有行 → 按 fields 重建（rules 或 rx），开关/模式同步。 */
function fillPreprocessEditor(editorHtml, fields) {
    const enabled = !!fields.rp_preprocess_enabled;
    const mode = fields.rp_preprocess_mode === 'advanced' ? 'advanced' : 'basic';
    editorHtml.find('input[name="rp_preprocess_enabled"]').prop('checked', enabled);
    editorHtml.find('#rp_preprocess_advanced_toggle').data('advanced', mode === 'advanced');
    editorHtml.find('#rp_preprocess_rules_container').empty();
    editorHtml.find('#rp_preprocess_rx_container').empty();
    const rules = Array.isArray(fields.rp_preprocess_rules) ? fields.rp_preprocess_rules : [];
    const rxList = Array.isArray(fields.rp_preprocess_rx) ? fields.rp_preprocess_rx : [];
    if (mode === 'basic') {
        if (rules.length === 0) addPreprocessRuleRow(editorHtml, {});
        else rules.forEach((r) => addPreprocessRuleRow(editorHtml, r));
    } else {
        if (rxList.length === 0) addPreprocessRxRow(editorHtml, {});
        else rxList.forEach((x) => addPreprocessRxRow(editorHtml, x));
    }
}

/** 新增一行标签对规则（空行 / 回填行；含排除 checkbox）。 */
function addPreprocessRuleRow(editorHtml, rule) {
    const tpl = editorHtml.find('#rp_preprocess_rule_template').clone().removeClass('displayNone').removeAttr('id');
    tpl.find('input[name="rp_preprocess_rule_start"]').val(rule?.start ?? '');
    tpl.find('input[name="rp_preprocess_rule_end"]').val(rule?.end ?? '');
    tpl.find('input[name="rp_preprocess_rule_include"]').prop('checked', rule?.includeTags !== false);
    tpl.find('input[name="rp_preprocess_rule_exclude"]').prop('checked', rule?.exclude === true);
    editorHtml.find('#rp_preprocess_rules_container').append(tpl);
}

/**
 * 新增一行段正则（高级模式）。主行（段正则 + 排除 + 替换按钮 + 删除）后紧跟一条
 * 替换输入行（默认隐藏；替换按钮展开/收起）。entry 兼容旧字符串 → 视为 { pattern }。
 */
function addPreprocessRxRow(editorHtml, entry) {
    const item = typeof entry === 'string' ? { pattern: entry, exclude: false, replaceEnabled: false, replace: null }
        : (entry && typeof entry === 'object' ? entry : {});
    const tpl = editorHtml.find('#rp_preprocess_rx_template').clone().removeClass('displayNone').removeAttr('id');
    tpl.find('input[name="rp_preprocess_rx_input"]').val(item.pattern ?? '');
    tpl.find('input[name="rp_preprocess_rx_exclude"]').prop('checked', item.exclude === true);
    editorHtml.find('#rp_preprocess_rx_container').append(tpl);
    // 替换输入行（紧随主行；replaceEnabled 时展开）
    const replTpl = editorHtml.find('#rp_preprocess_rx_replace_template').clone().removeClass('displayNone').removeAttr('id');
    replTpl.find('input[name="rp_preprocess_rx_replace"]').val(typeof item.replace === 'string' ? item.replace : '');
    editorHtml.find('#rp_preprocess_rx_container').append(replTpl);
    if (item.replaceEnabled !== true) {
        // 用 displayNone class（ST 全局 !important），并清内联残留（与 renderMode 同一修复模式）
        replTpl.addClass('displayNone').css('display', '');
    }
}

/** 收集预处理 DOM → { rp_preprocess_enabled, rp_preprocess_mode, rp_preprocess_rules, rp_preprocess_rx }。 */
function collectPreprocessFields(editorHtml) {
    const enabled = editorHtml.find('input[name="rp_preprocess_enabled"]').prop('checked') === true;
    const advanced = editorHtml.find('#rp_preprocess_advanced_block').is(':visible');
    const mode = advanced ? 'advanced' : 'basic';
    const rules = [];
    editorHtml.find('#rp_preprocess_rules_container > .flex-container').each(function () {
        const row = $(this);
        const start = String(row.find('input[name="rp_preprocess_rule_start"]').val() ?? '').trim();
        const end = String(row.find('input[name="rp_preprocess_rule_end"]').val() ?? '').trim();
        const includeTags = row.find('input[name="rp_preprocess_rule_include"]').prop('checked') !== false;
        const exclude = row.find('input[name="rp_preprocess_rule_exclude"]').prop('checked') === true;
        if (start || end) rules.push({ start, end, includeTags, exclude });
    });
    const rx = [];
    // 主行 + 替换行成对；遍历主行，找其后的替换行
    const rxRows = editorHtml.find('#rp_preprocess_rx_container > .flex-container').has('input[name="rp_preprocess_rx_input"]');
    rxRows.each(function () {
        const row = $(this);
        const pattern = String(row.find('input[name="rp_preprocess_rx_input"]').val() ?? '').trim();
        if (!pattern) return;
        const exclude = row.find('input[name="rp_preprocess_rx_exclude"]').prop('checked') === true;
        const replRow = row.next('.flex-container').filter(function () { return $(this).find('input[name="rp_preprocess_rx_replace"]').length > 0; });
        const replaceEnabled = replRow.length > 0 && !replRow.hasClass('displayNone');
        const replace = replRow.length > 0 ? String(replRow.find('input[name="rp_preprocess_rx_replace"]').val() ?? '') : null;
        rx.push({ pattern, exclude, replaceEnabled, replace });
    });
    return {
        rp_preprocess_enabled: enabled,
        rp_preprocess_mode: mode,
        rp_preprocess_rules: rules,
        rp_preprocess_rx: rx,
    };
}

/** 绑定预处理 UI 交互：开关显隐、高级/普通切换、增删行、替换展开、排除与替换互斥。
 * @param {JQuery} editorHtml 编辑器弹窗 DOM
 * @param {Function} [onChange] 配置变化后的回调（编辑器实时测试刷新用；
 *   updateTestResult 定义在 showRegexEditor 作用域，经参数传入避免跨函数引用错误） */
function bindPreprocessEditorEvents(editorHtml, onChange) {
    const $enabled = editorHtml.find('input[name="rp_preprocess_enabled"]');
    const $advToggle = editorHtml.find('#rp_preprocess_advanced_toggle');
    const $basic = editorHtml.find('#rp_preprocess_basic_block');
    const $advanced = editorHtml.find('#rp_preprocess_advanced_block');
    const $hint = editorHtml.find('small.rp_preprocess_block');

    function renderMode() {
        const on = $enabled.prop('checked') === true;
        const adv = $advToggle.data('advanced') === true;
        // 显隐统一走 displayNone class（ST 全局 .displayNone 是 display:none !important，
        // 优先级高于内联样式）。.css('display','') 清掉旧版 .toggle() 留下的内联残留，
        // 避免 class 已移除但内联 display:none 仍生效导致永远不显示。
        $advToggle.toggleClass('displayNone', !on).css('display', '');
        $advToggle.find('small').text(adv ? '普通模式' : '高级模式');
        $hint.toggleClass('displayNone', !on).css('display', '');
        $basic.toggleClass('displayNone', !(on && !adv)).css('display', '');
        $advanced.toggleClass('displayNone', !(on && adv)).css('display', '');
    }

    $enabled.on('change', function () {
        renderMode();
        onChange?.();
    });
    $advToggle.on('click', function () {
        $advToggle.data('advanced', $advToggle.data('advanced') !== true);
        renderMode();
        onChange?.();
    });
    editorHtml.find('#rp_preprocess_add_rule').on('click', function () {
        addPreprocessRuleRow(editorHtml, {});
        onChange?.();
    });
    editorHtml.find('#rp_preprocess_add_rx').on('click', function () {
        addPreprocessRxRow(editorHtml, {});
        onChange?.();
    });
    // 行内删除（事件委托：动态行）—— 删除 rx 主行时连其后的替换行一起删
    editorHtml.on('click', '.rp_preprocess_rule_remove', function () {
        $(this).closest('.flex-container').remove();
        onChange?.();
    });
    editorHtml.on('click', '.rp_preprocess_rx_remove', function () {
        const row = $(this).closest('.flex-container');
        row.next('.flex-container').filter(function () { return $(this).find('input[name="rp_preprocess_rx_replace"]').length > 0; }).remove();
        row.remove();
        onChange?.();
    });
    // 替换按钮：展开/收起该主行后的替换输入行（displayNone class + 清内联残留）
    editorHtml.on('click', '.rp_preprocess_rx_replace_btn', function () {
        const row = $(this).closest('.flex-container');
        const replRow = row.next('.flex-container').filter(function () { return $(this).find('input[name="rp_preprocess_rx_replace"]').length > 0; });
        if (replRow.length > 0) {
            const willShow = replRow.hasClass('displayNone');
            replRow.toggleClass('displayNone', !willShow).css('display', '');
            // 排除与替换互斥：展开替换 → 取消排除（「不碰区域」与「改写区域」语义相反）
            if (willShow) row.find('input[name="rp_preprocess_rx_exclude"]').prop('checked', false);
        }
        onChange?.();
    });
    // 排除勾选 → 若展开替换则收起替换（互斥的另一方向）
    editorHtml.on('change', 'input[name="rp_preprocess_rx_exclude"]', function () {
        if ($(this).prop('checked') === true) {
            const row = $(this).closest('.flex-container');
            const replRow = row.next('.flex-container').filter(function () { return $(this).find('input[name="rp_preprocess_rx_replace"]').length > 0; });
            replRow.addClass('displayNone').css('display', '');
        }
        onChange?.();
    });
    renderMode();
}

/**
 * 打开编辑器弹窗（三类脚本共用）。
 * @param {{ existingScript: object|null, existingId: string|false }} params
 *   existingScript 已有条目（回填字段）；existingId 编辑 id 或 false 表示新建
 * @returns {Promise<{ script: object, existingId: string|false }|null>}
 *   保存时返回收集结果；取消 / 无脚本名等非法状态返回 null
 */
async function showRegexEditor({ existingScript, existingId }) {
    const editorHtml = $(await loadTemplate('editor'));

    if (existingScript) {
        if (!existingScript.scriptName) {
            toastr.error('This script doesn\'t have a name! Please delete it.');
            return null;
        }
        fillEditorFromScript(editorHtml, existingScript);
    } else {
        const defaults = core.EDITOR_NEW_DEFAULTS;
        editorHtml.find('input[name="only_format_display"]').prop('checked', defaults.markdownOnly);
        editorHtml.find('input[name="run_on_edit"]').prop('checked', defaults.runOnEdit);
        editorHtml.find('input[name="replace_position"][value="1"]').prop('checked', true);
        // 预处理新建默认：basic 模式一条空规则（开关关，配置区隐藏；开启后可见）
        fillPreprocessEditor(editorHtml, {
            rp_preprocess_enabled: false,
            rp_preprocess_mode: 'basic',
            rp_preprocess_rules: [],
            rp_preprocess_rx: [],
        });
    }

    bindPreprocessEditorEvents(editorHtml, updateTestResult);

    // 需求 1：「第二次不执行」仅 1→2→1 渲染模式显示；legacy 模式隐藏（沿用 displayNone
    // class + 清内联残留模式）。模式切换后重开编辑器生效即可（无需实时响应）。
    if (getRenderMode() !== 'two_pass_121') {
        editorHtml.find('#rp_skip_second_pass_row').addClass('displayNone').css('display', '');
        editorHtml.find('#rp_second_pass_status').addClass('displayNone').css('display', '');
    } else {
        // 编辑器联动：显示该脚本「第二遍执行状态」（读当前模式 + 规则）。
        editorHtml.find('#rp_second_pass_status').text(secondPassStatusText(existingScript, editorHtml));
    }

    editorHtml.find('#regex_test_mode_toggle').on('click', function () {
        editorHtml.find('#regex_test_mode').toggleClass('displayNone');
        updateTestResult();
    });

    function updateTestResult() {
        updateInfoBlock(editorHtml);

        if (!editorHtml.find('#regex_test_mode').is(':visible')) {
            return;
        }

        const testScript = core.collectRegexScriptData(
            {
                scriptName: editorHtml.find('.regex_script_name').val(),
                findRegex: editorHtml.find('.find_regex').val(),
                replaceString: editorHtml.find('.regex_replace_string').val(),
                trimStrings: editorHtml.find('.regex_trim_strings').val(),
                placement: [],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: editorHtml.find('select[name="substitute_regex"]').val(),
                minDepth: null,
                maxDepth: null,
                ...collectPreprocessFields(editorHtml),
            },
            '',
            uuidv4,
        );

        const rawTestString = String(editorHtml.find('#regex_test_input').val());
        const result = runRegexScript(testScript, rawTestString);
        editorHtml.find('#regex_test_output').text(result);
    }

    editorHtml.find('input, textarea, select').on('input', updateTestResult);
    updateInfoBlock(editorHtml);

    const popupResult = await callGenericPopup(editorHtml, POPUP_TYPE.CONFIRM, '', { okButton: t`Save`, cancelButton: t`Cancel`, allowVerticalScrolling: true });
    if (!popupResult) {
        return null;
    }

    const newRegexScript = core.collectRegexScriptData(
        {
            scriptName: editorHtml.find('.regex_script_name').val(),
            findRegex: editorHtml.find('.find_regex').val(),
            replaceString: editorHtml.find('.regex_replace_string').val(),
            trimStrings: editorHtml.find('.regex_trim_strings').val(),
            placement: editorHtml.find('input[name="replace_position"]').filter(':checked')
                .map(function () { return parseInt($(this).val().toString()); })
                .get(),
            disabled: editorHtml.find('input[name="disabled"]').prop('checked'),
            markdownOnly: editorHtml.find('input[name="only_format_display"]').prop('checked'),
            promptOnly: editorHtml.find('input[name="only_format_prompt"]').prop('checked'),
            runOnEdit: editorHtml.find('input[name="run_on_edit"]').prop('checked'),
            rp_skip_second_pass: editorHtml.find('input[name="rp_skip_second_pass"]').prop('checked'),
            substituteRegex: editorHtml.find('select[name="substitute_regex"]').val(),
            minDepth: editorHtml.find('input[name="min_depth"]').val(),
            maxDepth: editorHtml.find('input[name="max_depth"]').val(),
            ...collectPreprocessFields(editorHtml),
        },
        existingId ? String(existingId) : '',
        uuidv4,
    );

    return { script: newRegexScript, existingId: existingId ? String(existingId) : false };
}

async function onRegexEditorOpenClick(existingId, scriptType) {
    const array = getScriptsByType(scriptType);

    let existingScriptIndex = -1;
    let existingScript = null;
    if (existingId) {
        existingScriptIndex = array.findIndex((script) => script.id === existingId);
        if (existingScriptIndex !== -1) {
            // 方法 2：编辑器回填叠加本地 extras（本机配置优先显示；卡/预设历史字段作 fallback）。
            // 保存时 saveScriptExtras 会重新剥离写本地，因此叠加只在显示层，不写回卡/预设。
            const kind = kindFromScriptType(scriptType);
            existingScript = kind ? overlayScriptExtras(array[existingScriptIndex], kind) : array[existingScriptIndex];
        }
    }

    const out = await showRegexEditor({ existingScript, existingId });
    if (!out) {
        return;
    }
    saveRegexScript(out.script, existingScriptIndex, scriptType);
}

// ---------------------------------------------------------------------------
// 实时测试执行（等价原版 runRegexScript，engine.js:391-448）
// ---------------------------------------------------------------------------

/**
 * 编辑器测试用单脚本执行。走本插件引擎的 st 解释器（runRegexScriptSt 逐字复刻
 * 原版 runRegexScript：{{match}}/$n/$<name>/trimStrings/最终宏替换/substituteRegex），
 * 比原版调试器测试更接近真实引擎。宏引擎用 ST 完整宏引擎（runtime 注入方式一致）。
 * @returns {string}
 */
function runRegexScript(regexScript, rawString) {
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return rawString;
    }
    const { substituteParams, substituteParamsExtended } = runtime.macros;
    const result = runRegexScriptSt(regexScript, rawString, {
        substituteParams,
        substituteParamsExtended,
        // 编辑器测试预览走真实 st 解释器：预算取用户配置（rp_hub_budget_ms），
        // 与消息管道 runtime.engineRun 注入的预算一致（避免预览与实跑结果不一致）
        budgetMs: getBudgetMs(),
    });
    return result.text;
}

// ---------------------------------------------------------------------------
// 编辑器 info block（原版 index.js:1342-1370）
// ---------------------------------------------------------------------------

function updateInfoBlock(editorHtml) {
    const infoBlock = editorHtml.find('.info-block').get(0);
    const infoBlockFlagsHint = editorHtml.find('#regex_info_block_flags_hint');
    const findRegex = String(editorHtml.find('.find_regex').val());

    infoBlockFlagsHint.hide();

    if (!findRegex) {
        setInfoBlock(infoBlock, t`Find Regex is empty`, 'info');
        return;
    }

    try {
        const regex = regexFromString(findRegex);
        if (!regex) {
            throw new Error(t`Invalid Find Regex`);
        }

        const flagInfo = [];
        flagInfo.push(regex.flags.includes('g') ? t`Applies to all matches` : t`Applies to the first match`);
        flagInfo.push(regex.flags.includes('i') ? t`Case insensitive` : t`Case sensitive`);

        setInfoBlock(infoBlock, flagInfo.join('. '), 'hint');
        infoBlockFlagsHint.show();
    } catch (error) {
        setInfoBlock(infoBlock, error.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// 调试器（原版 index.js:942-1336）
// ---------------------------------------------------------------------------

function refreshDebuggerRuleList() {
    // openDebuggerContainer 是 detached 包装 div；其子元素（.regex-debugger-container）被
    // append 进弹窗内容，用子元素判断弹窗是否仍在 DOM（关闭时 callGenericPopup 会 remove）。
    if (openDebuggerContainer && openDebuggerContainer.length &&
        openDebuggerContainer.children().length &&
        document.body.contains(openDebuggerContainer.children().get(0))) {
        populateDebuggerRuleList(openDebuggerContainer);
        initDebuggerSortables(openDebuggerContainer);
    }
}

function populateDebuggerRuleList(container) {
    const rulesContainer = container.find('#regex_debugger_rules');
    const ruleTemplate = container.find('#regex_debugger_rule_template');
    if (!rulesContainer.length || !ruleTemplate.length) {
        console.error('Regex Debugger: Could not find rule list or template in the DOM.');
        return;
    }

    rulesContainer.empty();

    const allScripts = getRegexScripts();
    const { global, scoped, preset } = core.partitionByType(allScripts, getScriptsByType);

    if (!allScripts || allScripts.length === 0) {
        rulesContainer.append('<div class="regex-debugger-no-rules">' + t`No regex rules found.` + '</div>');
        return;
    }

    container.data('allScripts', [...global, ...preset, ...scoped]);

    const renderRule = (script) => {
        if (!script.id) script.id = uuidv4();
        const ruleElementContent = $(ruleTemplate.prop('content')).clone();
        const ruleElement = ruleElementContent.find('.regex-debugger-rule');

        ruleElement.attr('data-id', script.id);
        ruleElement.find('.rule-name').text(script.scriptName);
        ruleElement.find('.rule-regex').text(script.findRegex);
        ruleElement.find('.rule-scope').text(
            {
                [SCRIPT_TYPES.SCOPED]: t`Scoped`,
                [SCRIPT_TYPES.GLOBAL]: t`Global`,
                [SCRIPT_TYPES.PRESET]: t`Preset`,
            }[script.type] || t`RP`,
        );
        ruleElement.find('.rule-enabled').prop('checked', !script.disabled);
        ruleElement.find('.edit_rule').on('click', () => {
            onRegexEditorOpenClick(script.id, script.type);
        });

        ruleElement.on('click', function (event) {
            if ($(event.target).is('input, .menu_button, .menu_button i')) {
                return;
            }
            const scriptId = $(this).data('id');
            const stepElement = $(`#step-result-${scriptId}`);
            const stepsContainer = container.find('#regex_debugger_steps_output');

            if (stepElement.length && stepsContainer.length) {
                const targetTop = stepElement.position().top;
                const containerScrollTop = stepsContainer.scrollTop();
                const containerHeight = stepsContainer.height();

                let scrollTo = containerScrollTop + targetTop - (containerHeight / 2) + (stepElement.height() / 2);

                stepsContainer.animate({ scrollTop: scrollTo }, 300);

                stepElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                setTimeout(() => stepElement.css('background-color', ''), 1000);
            }
        });

        return ruleElementContent;
    };

    if (global.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Global Rules` + '</div>');
        const globalList = $('<ul id="regex_debugger_rules_global" class="sortable-list"></ul>');
        global.forEach((script) => globalList.append(renderRule(script)));
        rulesContainer.append(globalList);
    }

    if (preset.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Preset Rules` + '</div>');
        const presetList = $('<ul id="regex_debugger_rules_preset" class="sortable-list"></ul>');
        preset.forEach((script) => presetList.append(renderRule(script)));
        rulesContainer.append(presetList);
    }

    if (scoped.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Scoped Rules` + '</div>');
        const scopedList = $('<ul id="regex_debugger_rules_scoped" class="sortable-list"></ul>');
        scoped.forEach((script) => scopedList.append(renderRule(script)));
        rulesContainer.append(scopedList);
    }
}

function initDebuggerSortables(debuggerHtml) {
    debuggerHtml.find('#regex_debugger_rules_global').sortable({ delay: getSortableDelay() }).disableSelection();
    debuggerHtml.find('#regex_debugger_rules_scoped').sortable({ delay: getSortableDelay() }).disableSelection();
    debuggerHtml.find('#regex_debugger_rules_preset').sortable({ delay: getSortableDelay() }).disableSelection();
}

async function onRegexDebuggerOpenClick() {
    const templateContent = await loadTemplate('debugger');
    const debuggerHtml = $('<div>').html(templateContent);

    const stepTemplate = debuggerHtml.find('#regex_debugger_step_template');

    populateDebuggerRuleList(debuggerHtml);
    initDebuggerSortables(debuggerHtml);

    debuggerHtml.find('#regex_debugger_run_test').on('click', function () {
        const allScripts = debuggerHtml.data('allScripts');
        const orderedRuleIds = [
            ...debuggerHtml.find('#regex_debugger_rules_global').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ...debuggerHtml.find('#regex_debugger_rules_scoped').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ...debuggerHtml.find('#regex_debugger_rules_preset').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
        ];

        const rawInput = String(debuggerHtml.find('#regex_debugger_raw_input').val());
        const stepsOutput = debuggerHtml.find('#regex_debugger_steps_output');
        const finalOutput = debuggerHtml.find('#regex_debugger_final_output');

        if (!stepsOutput.length || !finalOutput.length) return;

        const displayMode = debuggerHtml.find('input[name="display_mode"]:checked').val();
        stepsOutput.empty();
        finalOutput.empty();
        debuggerHtml.find('#regex_debugger_final_summary').remove();

        if (!allScripts) return;
        let textForNextStep = rawInput;
        let totalCharsCaptured = 0;
        let totalCharsAdded = 0;
        let totalCharsRemoved = 0;

        orderedRuleIds.forEach((scriptId) => {
            const ruleElement = debuggerHtml.find(`#regex_debugger_rules [data-id="${scriptId}"]`);
            if (!ruleElement.find('.rule-enabled').is(':checked')) return;

            const script = allScripts.find((s) => s.id === scriptId);

            if (script) {
                const result = executeRegexScriptForDebugging(script, textForNextStep, { regexFromString, escapeHtml });
                totalCharsCaptured += result.charsCaptured;
                totalCharsAdded += result.charsAdded;
                totalCharsRemoved += result.charsRemoved;

                const stepElement = $(stepTemplate.prop('content')).clone();
                stepElement.find('>:first-child').attr('id', `step-result-${script.id}`);
                const stepHeader = stepElement.find('.step-header');
                stepHeader.find('strong').text(t`After:` + ` ${script.scriptName}`);

                const metricsHtml = '<span class="step-metrics">' + t`Captured:` + ` ${result.charsCaptured}, ` + t`Added:` + ` +${result.charsAdded}, ` + t`Removed:` + ` -${result.charsRemoved}</span>`;
                stepHeader.append(metricsHtml);

                if (displayMode === 'highlight') {
                    stepElement.find('.step-output').html(result.highlightedOutput);
                } else {
                    stepElement.find('.step-output').text(result.output);
                }

                if (result.error) {
                    stepHeader.append($(`<div class='warning_text text_rose-500'>${escapeHtml(result.error)}</div>`));
                }

                stepsOutput.append(stepElement);
                textForNextStep = result.output;
            }
        });

        const summaryHtml = `
            <div id="regex_debugger_final_summary" class="regex-debugger-summary">
                <strong>` + t`Total Captured:` + `</strong> ${totalCharsCaptured} | <strong>` + t`Total Added:` + `</strong> +${totalCharsAdded} | <strong>` + t`Total Removed:` + `</strong> -${totalCharsRemoved}
            </div>
        `;
        finalOutput.before(summaryHtml);

        const renderMode = debuggerHtml.find('#regex_debugger_render_mode').val();
        if (renderMode === 'message') {
            const formattedHtml = messageFormatting(textForNextStep, 'Debugger', true, false, null);
            const messageBlock = $('<div class="mes"><div class="mes_text"></div></div>');
            messageBlock.find('.mes_text').html(formattedHtml);
            finalOutput.append(messageBlock);
        } else {
            finalOutput.text(textForNextStep);
        }
    });

    debuggerHtml.find('#regex_debugger_save_order').on('click', async function () {
        const allKnownScripts = getRegexScripts();
        const newGlobalScripts = debuggerHtml.find('#regex_debugger_rules_global').children('li').map((_, el) => allKnownScripts.find((s) => s.id === $(el).data('id'))).get().filter(Boolean);
        const newScopedScripts = debuggerHtml.find('#regex_debugger_rules_scoped').children('li').map((_, el) => allKnownScripts.find((s) => s.id === $(el).data('id'))).get().filter(Boolean);
        const newPresetScripts = debuggerHtml.find('#regex_debugger_rules_preset').children('li').map((_, el) => allKnownScripts.find((s) => s.id === $(el).data('id'))).get().filter(Boolean);

        extension_settings.regex = newGlobalScripts;
        if (this_chid !== undefined) {
            await saveScriptsByType(newScopedScripts, SCRIPT_TYPES.SCOPED);
        }
        await saveScriptsByType(newPresetScripts, SCRIPT_TYPES.PRESET);

        saveSettingsDebounced();
        await loadRegexScripts();
        toastr.success(t`Regex script order saved!`);

        populateDebuggerRuleList(debuggerHtml);
        initDebuggerSortables(debuggerHtml);
    });

    debuggerHtml.find('#regex_debugger_expand_steps').on('click', function () {
        const popupContainer = $('<div class="expanded-regex-container"></div>');
        const navPanel = $('<div class="expanded-regex-nav"><h4>Steps</h4></div>');
        const contentPanel = $('<div class="expanded-regex-content"></div>');

        const content = debuggerHtml.find('#regex_debugger_steps_output').clone().html();
        contentPanel.html(content);

        debuggerHtml.find('#regex_debugger_rules .regex-debugger-rule').each(function () {
            const ruleElement = $(this);
            const scriptId = ruleElement.data('id');
            const scriptName = ruleElement.find('.rule-name').text();

            const link = $(`<a href="#">${escapeHtml(scriptName)}</a>`);
            link.data('target-id', `step-result-${scriptId}`);

            link.on('click', function (e) {
                e.preventDefault();
                navPanel.find('a').removeClass('active');
                $(this).addClass('active');

                const targetId = $(this).data('target-id');
                const targetElement = contentPanel.find(`#${targetId}`);

                if (targetElement.length) {
                    const scrollTo = contentPanel.scrollTop() + targetElement.position().top;
                    contentPanel.animate({ scrollTop: scrollTo }, 300);

                    targetElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                    setTimeout(() => targetElement.css('background-color', ''), 1000);
                }
            });

            navPanel.append(link);
        });

        popupContainer.append(navPanel).append(contentPanel);
        callGenericPopup(popupContainer, POPUP_TYPE.TEXT, t`Step-by-step Transformation`, { wide: true, allowVerticalScrolling: false });
    });

    debuggerHtml.find('#regex_debugger_expand_final').on('click', function () {
        const content = debuggerHtml.find('#regex_debugger_final_output').html();
        const popupContent = $('<div class="regex-popup-content"></div>').html(content);
        callGenericPopup(popupContent, POPUP_TYPE.TEXT, t`Final Output`, { wide: true, large: true, allowVerticalScrolling: true });
    });

    openDebuggerContainer = debuggerHtml;
    await callGenericPopup(debuggerHtml.children(), POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        onClose: () => {
            if (openDebuggerContainer === debuggerHtml) {
                openDebuggerContainer = null;
            }
        },
    });
}

// ---------------------------------------------------------------------------
// 正则诊断弹窗（ReDoS 预检 + 诊断弹窗）：逐脚本「编译 / 预检 / 执行」三层状态，
// 被预检拦截（redos-precheck）的脚本可「绕过」放行（写入 rp_hub_precheck_bypass）。
// ---------------------------------------------------------------------------

/** 当前打开的诊断弹窗容器（保存/设置变化后刷新） */
let openDiagnoseContainer = null;

/** 缺省测试文本：当前聊天最后一条 AI 回复 mes（is_user=false && is_system=false） */
function getLastAiReplyText() {
    try {
        const chat = runtime.chat;
        if (!Array.isArray(chat)) return '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && m.is_user === false && m.is_system === false && typeof m.mes === 'string') {
                return m.mes;
            }
        }
    } catch {
        // 忽略，返回空串
    }
    return '';
}

/** 诊断弹窗规则行状态徽标 HTML（编译✗红 / 预检拦截橙+绕过 / 已绕过绿 / 超时橙 / 正常绿）。 */
function buildDiagnoseBadges(result) {
    const badges = [];
    if (!result.compile.ok) {
        badges.push('<span class="regex-diagnose-badge regex-diagnose-badge-error" title="编译失败">编译✗</span>');
    }
    if (result.precheck.risky && result.precheck.blocked) {
        badges.push('<span class="regex-diagnose-badge regex-diagnose-badge-warn" title="ReDoS 预检拦截（嵌套量词）">预检拦截</span>');
    } else if (result.precheck.risky && result.precheck.bypassed) {
        badges.push('<span class="regex-diagnose-badge regex-diagnose-badge-ok" title="已加入绕过表，放行">已绕过</span>');
    }
    if (result.exec.timedOut) {
        const reasonText = result.exec.reason === 'redos-precheck' ? '预检拦截' : (result.exec.reason === 'budget-exceeded' ? '超预算' : (result.exec.reason === 'interrupted' ? '中断' : result.exec.reason || '超时'));
        badges.push(`<span class="regex-diagnose-badge regex-diagnose-badge-warn" title="${reasonText}">${reasonText}</span>`);
    } else if (result.exec.error) {
        badges.push('<span class="regex-diagnose-badge regex-diagnose-badge-error" title="执行错误">执行✗</span>');
    } else if (result.compile.ok) {
        badges.push('<span class="regex-diagnose-badge regex-diagnose-badge-ok" title="编译通过，未超时">正常</span>');
    }
    return badges.join('');
}

/** 诊断弹窗规则行详情文本（compile error / precheck 原因 / 执行耗时与是否改写）。 */
function buildDiagnoseDetail(result) {
    const parts = [];
    if (!result.compile.ok) {
        parts.push(`编译失败：${result.compile.error}`);
    } else {
        parts.push('编译通过');
    }
    if (result.precheck.risky) {
        parts.push(`预检：嵌套量词${result.precheck.blocked ? '（被拦截）' : (result.precheck.bypassed ? '（已绕过）' : '（未启用预检）')}`);
    } else {
        parts.push('预检：未命中');
    }
    if (result.exec.error) {
        parts.push(`执行错误：${result.exec.error}`);
    } else if (result.exec.timedOut) {
        parts.push(`执行：超时跳过（reason=${result.exec.reason || 'timedOut'}）`);
    } else {
        parts.push(`执行：${result.exec.changed ? '有替换' : '无改动'}（${Math.round(result.exec.elapsedMs)}ms）`);
    }
    return parts.join(' · ');
}

/** 重分析诊断弹窗全部规则行。 */
async function refreshDiagnoseRules(diagnoseHtml) {
    const container = diagnoseHtml.find('#regex_diagnose_rules');
    const ruleTemplate = diagnoseHtml.find('#regex_diagnose_rule_template');
    if (!container.length || !ruleTemplate.length) return;

    const text = String(diagnoseHtml.find('#regex_diagnose_input').val() ?? '');
    const bypassKeys = getPrecheckBypass();
    const precheckEnabled = isPrecheckEnabled();

    // 真实引擎 runner（runtime.engineRun 已注入预检设置 + 保护设置 + 预算）：
    // 诊断结果即真实消息管道的执行结果。
    const engineRun = (args) => runtime.engineRun(args);

    // 当前卡真实模式（rphub/st，含降级）：决定脚本合并与字段提取
    let mode = 'st';
    try {
        mode = (await runtime.getMode()) ?? 'st';
    } catch {
        // 后端判定失败时按 st 降级分析
    }

    // 收集全部脚本（三类），按引擎合并顺序
    const scripts = getRegexScripts({ mode });

    const results = analyzeScripts({
        scripts,
        text,
        mode,
        placement: 2,
        engineRun,
        precheckEnabled,
        bypassKeys,
    });

    container.empty();
    for (const result of results) {
        const el = $(ruleTemplate.prop('content')).clone();
        el.find('.regex-diagnose-rule-name').text(result.name);
        el.find('.regex-diagnose-rule-regex').text(result.key ? `[${result.key}]` : '(无键)');
        el.find('.regex-diagnose-badges').html(buildDiagnoseBadges(result));
        const detail = el.find('.regex-diagnose-rule-detail');
        detail.text(buildDiagnoseDetail(result));

        // 绕过 / 取消绕过 按钮（仅预检拦截或已绕过的脚本显示）
        if (result.precheck.risky && result.key) {
            const key = result.key;
            const isBypassed = bypassKeys.includes(key);
            const btn = $('<button class="menu_button menu_button_icon interactable"></button>')
                .append(`<small>${isBypassed ? '取消绕过' : '绕过'}</small>`);
            btn.on('click', () => {
                if (isBypassed) {
                    setPrecheckBypass(bypassKeys.filter((k) => k !== key));
                } else {
                    setPrecheckBypass([...bypassKeys, key]);
                }
                saveSettingsDebounced();
                // 🔴-2 修复：绕过/取消绕过后立即强制重渲染，否则 settingsFp（现已含 bypass 键表）
                // 变化后仅靠「下次事件收敛」，已渲染消息不会即时更新。
                window.__rphubCompat__?.forceRerenderAll?.();
                toastr.info(isBypassed ? `已取消「${result.name}」的预检绕过。` : `已绕过「${result.name}」的 ReDoS 预检（键 ${key}）。`);
                void refreshDiagnoseRules(diagnoseHtml);
            });
            detail.append(' ');
            detail.append(btn);
        }
        container.append(el);
    }
}

/** 打开正则诊断弹窗（照 onRegexDebuggerOpenClick 模式）。 */
/** 打开插件设置弹窗（把面板内 #plugin_settings_section 移进弹窗，关闭后移回原位）。
 * 设置控件（radio/checkbox/input）的 jQuery 事件绑定在面板挂载时已绑（全局 $ 选择器），
 * 移动 DOM 不丢失绑定；回填在挂载时已完成（refreshPanel 里 prop/val），弹窗内直接可用。 */
async function openPluginSettings() {
    const $section = $('#plugin_settings_section');
    if (!$section.length) return;

    // 包一层可滚动容器（与编辑弹窗一致：allowVerticalScrolling）
    const $wrap = $('<div class="plugin-settings-popup" style="max-height:70vh;overflow-y:auto;">');

    // 移动设置区进弹窗（原位置隐藏占位不动）
    const $holder = $('<div class="displayNone"></div>');
    $section.before($holder);
    $section.appendTo($wrap);
    $section.removeClass('displayNone');

    const ok = await callGenericPopup($wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: t`完成`,
        cancelButton: t`关闭`,
        allowVerticalScrolling: true,
    });

    // 弹窗关闭：设置区移回面板原占位处并恢复隐藏
    $section.appendTo($holder);
    $holder.replaceWith($section);
    $section.addClass('displayNone');
    void ok;
}

async function onRegexDiagnoseOpenClick() {
    const templateContent = await loadTemplate('diagnose');
    const diagnoseHtml = $('<div>').html(templateContent);

    // 测试文本缺省回填当前聊天最后一条 AI 回复 mes
    diagnoseHtml.find('#regex_diagnose_input').val(getLastAiReplyText());

    const runAnalysis = () => void refreshDiagnoseRules(diagnoseHtml);

    diagnoseHtml.find('#regex_diagnose_run').on('click', runAnalysis);
    diagnoseHtml.find('#regex_diagnose_reset').on('click', () => {
        diagnoseHtml.find('#regex_diagnose_input').val(getLastAiReplyText());
        runAnalysis();
    });
    // textarea input → 重分析全部行（防抖）
    let diagnoseTimer = null;
    diagnoseHtml.find('#regex_diagnose_input').on('input', () => {
        if (diagnoseTimer) clearTimeout(diagnoseTimer);
        diagnoseTimer = setTimeout(runAnalysis, 250);
    });

    openDiagnoseContainer = diagnoseHtml;
    runAnalysis();
    await callGenericPopup(diagnoseHtml.children(), POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        onClose: () => {
            if (openDiagnoseContainer === diagnoseHtml) {
                openDiagnoseContainer = null;
            }
        },
    });
}

/** 诊断弹窗刷新入口（保存/设置变化后调用；弹窗已关闭时无操作）。 */
function refreshDiagnoseIfOpen() {
    if (openDiagnoseContainer && openDiagnoseContainer.length &&
        openDiagnoseContainer.children().length &&
        document.body.contains(openDiagnoseContainer.children().get(0))) {
        void refreshDiagnoseRules(openDiagnoseContainer);
    }
}

// ---------------------------------------------------------------------------
// 导入（原版 index.js:1499-1560）
// ---------------------------------------------------------------------------

async function onRegexImportObjectChange(regexScript, scriptType) {
    try {
        if (!regexScript.scriptName) {
            throw new Error('No script name provided.');
        }

        regexScript.id = uuidv4();

        const array = getScriptsByType(scriptType);
        array.push(regexScript);

        switch (scriptType) {
            case SCRIPT_TYPES.GLOBAL:
                break;
            case SCRIPT_TYPES.SCOPED:
                await saveScriptsByType(array, SCRIPT_TYPES.SCOPED);
                break;
            case SCRIPT_TYPES.PRESET:
                await saveScriptsByType(array, SCRIPT_TYPES.PRESET);
                break;
            default:
                break;
        }

        saveSettingsDebounced();
        await loadRegexScripts();
        toastr.success(t`Regex script "${regexScript.scriptName}" imported.`);
    } catch (error) {
        console.log(error);
        toastr.error(t`Invalid regex object.`);
    }
}

async function onRegexImportFileChange(file, scriptType) {
    if (!file) {
        toastr.error('No file provided.');
        return;
    }

    try {
        const regexScripts = JSON.parse(await getFileText(file));
        if (Array.isArray(regexScripts)) {
            for (const regexScript of regexScripts) {
                await onRegexImportObjectChange(regexScript, scriptType);
            }
        } else {
            await onRegexImportObjectChange(regexScripts, scriptType);
        }
    } catch (error) {
        console.log(error);
        toastr.error('Invalid JSON file.');
    }
}

// ---------------------------------------------------------------------------
// Regex Preset 分组（原版 index.js:47-476）
// ---------------------------------------------------------------------------

/** @type {{ presetSelect, presetCreateButton, presetUpdateButton, presetApplyButton, presetDeleteButton, currentPresetId, lastKnownState }} */
const presetManager = {
    presetSelect: null,
    presetCreateButton: null,
    presetUpdateButton: null,
    presetApplyButton: null,
    presetDeleteButton: null,
    currentPresetId: null,
    lastKnownState: null,

    captureCurrentState() {
        return core.captureCurrentState((type) => getScriptsByType(type));
    },

    hasStateChanged(state1, state2) {
        return core.hasStateChanged(state1, state2);
    },

    updateStoredState(presetId) {
        this.currentPresetId = presetId;
        this.lastKnownState = this.captureCurrentState();
    },

    async checkUnsavedChanges() {
        if (!this.currentPresetId || !this.lastKnownState) {
            return true;
        }

        const currentState = this.captureCurrentState();
        if (!this.hasStateChanged(this.lastKnownState, currentState)) {
            return true;
        }

        const currentPreset = extension_settings.regex_presets.find((p) => p.id === this.currentPresetId);
        const presetName = currentPreset ? currentPreset.name : t`Unknown Preset`;

        const choice = await Popup.show.confirm(
            t`You have unsaved changes to the "${presetName}" preset.`,
            t`Do you want to save them before switching?`,
            {
                okButton: t`Save Changes`,
                cancelButton: t`Discard Changes`,
            },
        );

        if (choice) {
            await this.savePreset(this.currentPresetId, true);
            this.renderPresetList();
            return true;
        }

        return true;
    },

    setupEventListeners() {
        this.presetSelect = document.getElementById('regex_presets');
        if (!this.presetSelect) {
            console.error('RegexPresetManager: Could not find preset select element in the DOM.');
            return;
        }

        $(this.presetSelect).on('change', async (event) => {
            const selectedPresetId = this.presetSelect.value;
            const fromSlashCommand = event instanceof CustomEvent && event?.detail?.fromSlashCommand === true;

            if (!fromSlashCommand) {
                const canProceed = await this.checkUnsavedChanges();
                if (!canProceed) {
                    event.preventDefault();
                    const currentPreset = extension_settings.regex_presets.find((p) => p.id === this.currentPresetId);
                    if (currentPreset) {
                        this.presetSelect.value = currentPreset.id;
                    }
                    return;
                }
            }

            await this.applyPreset(selectedPresetId);
            extension_settings.regex_presets.forEach((p) => { p.isSelected = p.id === selectedPresetId; });
            saveSettingsDebounced();
            this.updateStoredState(selectedPresetId);
        });

        this.presetCreateButton = document.getElementById('regex_preset_create');
        if (!this.presetCreateButton) {
            console.error('RegexPresetManager: Could not find preset create button in the DOM.');
            return;
        }

        $(this.presetCreateButton).on('click', async () => {
            const newId = uuidv4();
            await this.savePreset(newId, false);
            this.renderPresetList();
            this.updateStoredState(newId);
        });

        this.presetUpdateButton = document.getElementById('regex_preset_update');
        if (!this.presetUpdateButton) {
            console.error('RegexPresetManager: Could not find preset update button in the DOM.');
            return;
        }

        $(this.presetUpdateButton).on('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.savePreset(selectedPresetId, true);
            this.renderPresetList();
            this.updateStoredState(selectedPresetId);
        });

        this.presetApplyButton = document.getElementById('regex_preset_apply');
        if (!this.presetApplyButton) {
            console.error('RegexPresetManager: Could not find preset apply button in the DOM.');
            return;
        }

        $(this.presetApplyButton).on('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.applyPreset(selectedPresetId);
            this.updateStoredState(selectedPresetId);
        });

        this.presetDeleteButton = document.getElementById('regex_preset_delete');
        if (!this.presetDeleteButton) {
            console.error('RegexPresetManager: Could not find preset delete button in the DOM.');
            return;
        }

        $(this.presetDeleteButton).on('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.deletePreset(selectedPresetId);
            this.renderPresetList();

            const newSelectedPresetId = extension_settings.regex_presets.find((p) => p.isSelected)?.id;
            if (newSelectedPresetId) {
                await this.applyPreset(newSelectedPresetId);
                this.presetSelect.value = newSelectedPresetId;
                this.updateStoredState(newSelectedPresetId);
            } else {
                this.currentPresetId = null;
                this.lastKnownState = null;
            }
        });

        this.renderPresetList();

        const selectedPreset = extension_settings.regex_presets?.find((p) => p.isSelected);
        if (selectedPreset) {
            this.updateStoredState(selectedPreset.id);
        }
    },

    renderPresetList() {
        if (!this.presetSelect) {
            return;
        }

        this.presetSelect.innerHTML = '';

        if (!Array.isArray(extension_settings.regex_presets) || extension_settings.regex_presets.length === 0) {
            const fallbackOption = new Option(t`[No presets saved]`, '', true, true);
            this.presetSelect.appendChild(fallbackOption);
            this.presetSelect.disabled = true;
            return;
        }

        extension_settings.regex_presets.forEach((preset) => {
            const option = new Option(preset.name, preset.id, preset.isSelected, preset.isSelected);
            this.presetSelect.appendChild(option);
        });

        this.presetSelect.disabled = false;
    },

    async applyPresetList({ presetList, targetList, saveFunction }) {
        if (!Array.isArray(targetList) || !Array.isArray(presetList)) {
            return;
        }

        core.applyPresetList({ presetList, targetList });
        await saveFunction(targetList);
    },

    async applyPreset(presetId) {
        const preset = extension_settings.regex_presets.find((p) => p.id === presetId);
        if (!preset) {
            toastr.error(t`Could not find the selected preset.`);
            return;
        }

        for (const scriptType of Object.values(SCRIPT_TYPES)) {
            await this.applyPresetList({
                presetList: {
                    [SCRIPT_TYPES.GLOBAL]: preset.global,
                    [SCRIPT_TYPES.SCOPED]: preset.scoped,
                    [SCRIPT_TYPES.PRESET]: preset.preset,
                }[scriptType],
                targetList: getScriptsByType(scriptType),
                saveFunction: (scripts) => saveScriptsByType(scripts, scriptType),
            });
        }

        await loadRegexScripts();
        await reloadCurrentChat();
    },

    regexListToPresetItems(list) {
        return core.regexListToPresetItems(list);
    },

    async savePreset(presetId, isUpdate) {
        const existingPreset = isUpdate ? extension_settings.regex_presets.find((p) => p.id === presetId) : null;

        if (isUpdate && !existingPreset) {
            toastr.error(t`Could not find the preset to update.`);
            return;
        }

        const name = isUpdate ? existingPreset.name : await Popup.show.input(t`Enter a name for the new regex preset:`, '');
        const id = isUpdate ? existingPreset.id : presetId;

        if (!name || !name.trim().length) {
            return;
        }

        const preset = core.buildPreset({
            id,
            name,
            getScriptsByType: (type) => getScriptsByType(type),
        });

        if (isUpdate) {
            Object.assign(existingPreset, preset);
        } else {
            extension_settings.regex_presets.push(preset);
        }

        extension_settings.regex_presets.forEach((p) => { p.isSelected = p.id === id; });
        saveSettingsDebounced();

        toastr.success(isUpdate ? t`Regex preset updated` : t`Regex preset saved`);
    },

    async deletePreset(presetId) {
        const presetIndex = extension_settings.regex_presets.findIndex((p) => p.id === presetId);
        if (presetIndex === -1) {
            toastr.error(t`Could not find the preset to delete.`);
            return;
        }

        const presetName = extension_settings.regex_presets[presetIndex].name;
        const confirm = await Popup.show.confirm(t`Are you sure you want to delete this regex preset?`, presetName);
        if (!confirm) {
            return;
        }

        extension_settings.regex_presets.splice(presetIndex, 1);

        extension_settings.regex_presets.forEach((p, i) => { p.isSelected = i === 0; });
        saveSettingsDebounced();

        toastr.success(t`Regex preset deleted`);
    },
};

// ---------------------------------------------------------------------------
// 嵌入脚本允许询问 + purge（原版 index.js:1586-1708）
// ---------------------------------------------------------------------------

function purgeEmbeddedRegexScripts({ character }) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    const checkKey = core.normalizeStorageKey(core.embeddedCheckKey(avatar));
    if (accountStorage.getItem(checkKey)) {
        accountStorage.removeItem(checkKey);
    }
    disallowScopedScripts(characters?.[this_chid]);
}

function purgePresetEmbeddedRegexScripts({ apiId, name }) {
    const checkKey = core.normalizeStorageKey(core.presetCheckKey(apiId, name));
    if (accountStorage.getItem(checkKey)) {
        accountStorage.removeItem(checkKey);
    }
    disallowPresetScripts(apiId, name);
}

async function checkCharEmbeddedRegexScripts() {
    const chid = this_chid;

    if (chid !== undefined && !selected_group) {
        const character = characters[chid];
        const scripts = getScriptsByType(SCRIPT_TYPES.SCOPED);

        if (core.shouldAskCharEmbedded(scripts, isScopedScriptsAllowed(character), false)) {
            const checkKey = core.normalizeStorageKey(core.embeddedCheckKey(character.avatar));
            if (!accountStorage.getItem(checkKey)) {
                accountStorage.setItem(checkKey, 'true');
                const template = await loadTemplate('embeddedScripts');
                const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '');

                if (result) {
                    allowScopedScripts(character);
                    await reloadCurrentChat();
                }
            }
        }
    }

    await loadRegexScripts();
}

/**
 * 提示是否重载当前聊天（原版 notifyReloadCurrentChat，index.js:1639-1648）。
 * @param {string} presetName
 */
function notifyReloadCurrentChat(presetName) {
    toastr.info(
        t`Reload the chat for regex to take effect` + '<br><u>' + t`Click here to reload immediately` + '</u>',
        t`Preset '${escapeHtml(presetName)}' contains enabled regex scripts`,
        {
            timeOut: 5000,
            escapeHtml: false,
            onclick: reloadCurrentChat,
        });
}

async function checkPresetEmbeddedRegexScripts() {
    const apiId = getCurrentPresetAPI();
    const name = getCurrentPresetName();
    const scripts = getScriptsByType(SCRIPT_TYPES.PRESET);

    const decision = core.shouldAskPresetEmbedded(scripts, isPresetScriptsAllowed(apiId, name), false);

    if (decision.ask) {
        const checkKey = core.normalizeStorageKey(core.presetCheckKey(apiId, name));
        if (!accountStorage.getItem(checkKey)) {
            accountStorage.setItem(checkKey, 'true');
            const template = await loadTemplate('presetEmbeddedScripts');
            const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '');

            if (result) {
                allowPresetScripts(apiId, name);
                if (getCurrentChatId()) {
                    await reloadCurrentChat();
                }
            }
        }
    } else if (decision.notifyReload && getCurrentChatId()) {
        notifyReloadCurrentChat(name);
    }

    await loadRegexScripts();
}

async function onMainApiChanged({ apiId }) {
    const manager = getPresetManager(apiId);
    if (!manager) {
        return;
    }
    const presetName = manager.getSelectedPresetName();
    const presetScripts = manager.readPresetExtensionField({ path: 'regex_scripts' }) ?? [];
    if (getCurrentChatId() &&
        isPresetScriptsAllowed(apiId, presetName) &&
        Array.isArray(presetScripts) &&
        presetScripts.filter((script) => !script.disabled).length > 0) {
        notifyReloadCurrentChat(presetName);
    }

    await loadRegexScripts();
}

function onPresetRenamed({ apiId, oldName, newName }) {
    const oldCheckKey = core.normalizeStorageKey(core.presetCheckKey(apiId, oldName));
    const checkKey = core.normalizeStorageKey(core.presetCheckKey(apiId, newName));
    const value = accountStorage.getItem(oldCheckKey);
    if (value) {
        accountStorage.setItem(checkKey, value);
        accountStorage.removeItem(oldCheckKey);
    }
    if (isPresetScriptsAllowed(apiId, oldName)) {
        disallowPresetScripts(apiId, oldName);
        allowPresetScripts(apiId, newName);
    }
}

// ---------------------------------------------------------------------------
// 批量操作（原版 index.js:1769-1910）
// ---------------------------------------------------------------------------

async function bulkToggleRegexScripts(newState) {
    const scripts = getSelectedScripts().filter((script) => script.disabled === newState);
    if (scripts.length === 0) {
        toastr.warning(newState
            ? t`No regex scripts selected for enabling.`
            : t`No regex scripts selected for disabling.`,
        );
        return;
    }
    const scriptTypesToSave = new Set();
    for (const script of scripts) {
        const scriptType = getScriptType(script);
        scriptTypesToSave.add(scriptType);
        script.disabled = !newState;
    }
    for (const scriptType of scriptTypesToSave) {
        const scriptsOfType = getScriptsByType(scriptType);
        await saveScriptsByType(scriptsOfType, scriptType);
    }

    saveSettingsDebounced();
    await loadRegexScripts();

    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        await reloadCurrentChat();
    }
}

async function bulkMoveRegexScript(toType) {
    const scripts = getSelectedScripts();
    if (scripts.length === 0) {
        toastr.warning(t`No regex scripts selected for moving.`);
        return;
    }
    for (const script of scripts) {
        await moveRegexScript(script, toType, getScriptType(script), false);
    }

    saveSettingsDebounced();
    await loadRegexScripts();

    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        await reloadCurrentChat();
    }
}

// ---------------------------------------------------------------------------
// init：挂载 dropdown + 注册全部交互（原版 init，index.js:1712-2157）
// ---------------------------------------------------------------------------

export async function init() {
    if (!Array.isArray(extension_settings.regex)) {
        extension_settings.regex = [];
    }

    if (!Array.isArray(extension_settings.regex_presets)) {
        extension_settings.regex_presets = [];
    }

    // 兼容模式（rp_hub_panel_escape，默认 true）：面板挂到 #regex_container 的父容器
    // （#extensions_settings2，index.html:5786）而非其内部 —— 脱离「鸡尾酒」regex-refresh-
    // optimizer 的捕获拦截域（getRegexContainer().contains(t) 判据失效，regex-refresh-
    // optimizer.js:1145-1180），我们面板的脚本交互恢复正常；也顺带避免与 ST regex 扩展
    // 的 dropdown 产生重复 id。false = 旧行为，挂回容器内部。
    const settingsHtml = $(await loadTemplate('dropdown'));
    if (isPanelEscapeEnabled()) {
        const parent = $('#regex_container').parent();
        if (parent.length) {
            parent.append(settingsHtml);
        } else {
            $('#regex_container').append(settingsHtml);
        }
    } else {
        $('#regex_container').append(settingsHtml);
    }

    $('#open_regex_editor').on('click', function () {
        onRegexEditorOpenClick(false, SCRIPT_TYPES.GLOBAL);
    });
    $('#open_regex_debugger').on('click', onRegexDebuggerOpenClick);
    $('#open_regex_diagnose').on('click', onRegexDiagnoseOpenClick);
    $('#open_plugin_settings').on('click', openPluginSettings);
    $('#open_scoped_editor').on('click', function () {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }

        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }

        onRegexEditorOpenClick(false, SCRIPT_TYPES.SCOPED);
    });
    $('#open_preset_editor').on('click', function () {
        onRegexEditorOpenClick(false, SCRIPT_TYPES.PRESET);
    });
    $('#import_regex_file').on('change', async function () {
        let target = SCRIPT_TYPES.GLOBAL;
        const template = $(await loadTemplate('importTarget'));
        template.find('#regex_import_target_global').on('input', () => (target = SCRIPT_TYPES.GLOBAL));
        template.find('#regex_import_target_scoped').on('input', () => (target = SCRIPT_TYPES.SCOPED));
        template.find('#regex_import_target_preset').on('input', () => (target = SCRIPT_TYPES.PRESET));

        await callGenericPopup(template, POPUP_TYPE.TEXT);

        const inputElement = this instanceof HTMLInputElement && this;
        for (const file of inputElement.files) {
            await onRegexImportFileChange(file, target);
        }
        inputElement.value = '';
    });
    $('#import_regex').on('click', function () {
        $('#import_regex_file').trigger('click');
    });

    $('#bulk_select_all_toggle').on('click', async function () {
        const checkboxes = $('#rph_regex_panel .regex_bulk_checkbox');
        if (checkboxes.length === 0) {
            return;
        }

        const allAreChecked = checkboxes.length === checkboxes.filter(':checked').length;
        const newState = !allAreChecked;

        checkboxes.prop('checked', newState);
        setToggleAllIcon(newState);
        setMoveButtonsVisibility();
    });

    $('#bulk_enable_regex').on('click', async function () {
        await bulkToggleRegexScripts(true);
    });

    $('#bulk_disable_regex').on('click', async function () {
        await bulkToggleRegexScripts(false);
    });

    $('#bulk_regex_move_to_global').on('click', async () => {
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to global?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.GLOBAL);
    });

    $('#bulk_regex_move_to_scoped').on('click', async () => {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }
        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to scoped?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.SCOPED);
    });

    $('#bulk_regex_move_to_preset').on('click', async function () {
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to preset?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.PRESET);
    });

    $('#bulk_delete_regex').on('click', async function () {
        const scripts = getSelectedScripts();
        if (scripts.length === 0) {
            toastr.warning(t`No regex scripts selected for deletion.`);
            return;
        }
        const confirm = await callGenericPopup(t`Are you sure you want to delete the selected regex scripts?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        for (const script of scripts) {
            await deleteRegexScript(script.id, getScriptType(script), false);
        }
        saveSettingsDebounced();
        await loadRegexScripts();
        await reloadCurrentChat();
    });

    $('#bulk_export_regex').on('click', async function () {
        const scripts = getSelectedScripts();
        if (scripts.length === 0) {
            toastr.warning(t`No regex scripts selected for export.`);
            return;
        }
        const fileName = core.bulkExportFileName();
        const fileData = JSON.stringify(scripts, null, 4);
        download(fileData, fileName, 'application/json');
        await loadRegexScripts();
    });

    const sortableDatas = [
        {
            selector: '#saved_regex_scripts',
            setter: (scripts) => saveScriptsByType(scripts, SCRIPT_TYPES.GLOBAL),
            getter: () => getScriptsByType(SCRIPT_TYPES.GLOBAL),
        },
        {
            selector: '#saved_scoped_scripts',
            setter: (scripts) => saveScriptsByType(scripts, SCRIPT_TYPES.SCOPED),
            getter: () => getScriptsByType(SCRIPT_TYPES.SCOPED),
        },
        {
            selector: '#saved_preset_scripts',
            setter: (scripts) => saveScriptsByType(scripts, SCRIPT_TYPES.PRESET),
            getter: () => getScriptsByType(SCRIPT_TYPES.PRESET),
        },
    ];
    for (const { selector, setter, getter } of sortableDatas) {
        $(selector).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            stop: async function () {
                const oldScripts = getter();
                const newScripts = [];
                $(selector).children().each(function () {
                    const id = $(this).attr('id');
                    const existingScript = oldScripts.find((e) => e.id === id);
                    if (existingScript) {
                        newScripts.push(existingScript);
                    }
                });

                await setter(newScripts);
                saveSettingsDebounced();

                console.debug(`Regex scripts in ${selector} reordered`);
                await reloadCurrentChat();
                await loadRegexScripts();
            },
        });
    }

    $('#regex_scoped_toggle').on('input', function () {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }

        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }

        const isEnable = !!$(this).prop('checked');
        const character = characters[this_chid];

        if (isEnable) {
            allowScopedScripts(character);
        } else {
            disallowScopedScripts(character);
        }

        saveSettingsDebounced();
        reloadCurrentChat();
    });

    $('#regex_preset_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        const name = getCurrentPresetName();

        if (isEnable) {
            allowPresetScripts(getCurrentPresetAPI(), name);
        } else {
            disallowPresetScripts(getCurrentPresetAPI(), name);
        }

        saveSettingsDebounced();
        reloadCurrentChat();
    });

    // 插件设置：脚本自定义字段存储位置（localStorage 默认 / extension_settings 可选）。
    // 切换时自动迁移已有 extras 到新模式（迁移完成清空旧模式，避免残留双份）。
    $('#regex_extras_storage_local, #regex_extras_storage_settings').on('input', function () {
        if (!$(this).prop('checked')) return;
        const mode = $(this).val() === 'settings' ? 'settings' : 'local';
        const before = getExtrasStorageMode();
        if (before === mode) return;
        setExtrasStorageMode(mode);
        const migrated = migrateScriptExtrasStorage(mode);
        saveSettingsDebounced();
        toastr.info(mode === 'local'
            ? t`脚本自定义字段已存 localStorage（关闭重开不丢）。迁移 ${migrated} 条。`
            : t`脚本自定义字段已存 extension_settings（随 ST settings.json 持久化）。迁移 ${migrated} 条。`);
    });

    // 插件设置：引擎级自动脚本区保护总开关（rp_hub_auto_protect_script，默认 true = 启用）。
    // 仅 legacy 渲染模式生效（two_pass_121 由界面段藏走替代，不单独作用）。关闭 = 现状（正则
    // 全消息跑，可能污染脚本，由用户自行负责）。改后自动重算显示（隔离变化 = 显示输出变化）。
    $('#regex_auto_protect_script_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setAutoProtectScriptEnabled(isEnable);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启自动隔离脚本区（仅旧模式生效：显示美化正则对 <script> 隐形，正文保持连续）。`
            : t`已关闭自动隔离脚本区（仅旧模式：正则全消息跑，可能污染脚本区，由你自己负责）。`);
    });

    // 插件设置：排除第0楼（开场白）总开关（rp_hub_exclude_first_message，默认 true = 启用）。
    // 开启 = 第 0 楼（开场白）scoped 正则按「精细/暴力」两档处理；预设/全局不受影响。改后自动重算显示。
    $('#regex_exclude_first_message_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setExcludeFirstMessageEnabled(isEnable);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启「排除第0楼」：第 0 楼 scoped 正则按档位处理。`
            : t`已关闭「排除第0楼」：第 0 楼照常执行局部正则。`);
    });

    // 插件设置：排除第0楼 精细/暴力档位（rp_hub_exclude_first_fulltext_only，默认 true = 精细）。
    // 精细（默认）= 只跳过带全文负前瞻的 scoped（沉浸式容器类）；暴力 = 跳过全部 scoped。改后自动重算显示。
    $('#regex_exclude_first_fulltext_toggle').on('input', function () {
        const isFine = !!$(this).prop('checked');
        setExcludeFirstFulltextOnly(isFine);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isFine
            ? t`「排除第0楼」精细档：只跳过带全文负前瞻的局部正则（隐藏状态/状态面板生成照常）。`
            : t`「排除第0楼」暴力档：跳过全部局部正则（与妹生活等卡状态面板会消失，慎用）。`);
    });

    // 插件设置：渲染模式（rp_hub_render_mode，默认 two_pass_121 = 1→2→1 两阶段管线）。
    // 切换 = 引擎执行路径变化（显示输出变化）→ 自动重算全部消息显示。
    $('#regex_render_mode').on('change', function () {
        const mode = $(this).val() === 'legacy' ? 'legacy' : 'two_pass_121';
        const before = getRenderMode();
        if (before === mode) return;
        setRenderMode(mode);
        saveSettingsDebounced();
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(mode === 'legacy'
            ? t`渲染模式已切换为「旧模式」（顺序混跑 + 自动隔离脚本区）。`
            : t`渲染模式已切换为「1→2→1 两阶段管线」（预设生成界面 → 卡内嵌美化正文 → 预设第二遍 → 拼回）。`);
    });

    // 插件设置：清洗规则（rp_hub_clean_rules）+ 第二次预设过滤（rp_hub_second_pass_filter）
    bindCleanAndSecondPassEditor();

    // 插件设置：流式实时渲染（rp_hub_stream_render_enabled + rp_hub_stream_match + rp_hub_stream_excludes）
    bindStreamRenderEditor();

    // 插件设置：提示词剥离（C2 管道，默认 true = 对整段 prompt 施加引擎剥离；关闭 = prompt 原样）
    $('#regex_clean_prompt_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setCleanPromptEnabled(isEnable);
        saveSettingsDebounced();
        toastr.info(isEnable
            ? t`已开启提示词剥离：每次发送前对整段提示词施加预设隐藏正则（删选项/剥思维链等）。`
            : t`已关闭提示词剥离：提示词原样发送（AI 可见选项标签等原文）。`);
    });

    // 插件设置：执行顺序来源（SPreset 默认 / 原版顺序，rp_hub_order_source）
    $('#regex_order_source_spreset, #regex_order_source_st').on('input', function () {
        if (!$(this).prop('checked')) return;
        const source = $(this).val();
        setOrderSource(source);
        loadRegexScripts();
        // B1/ST2 修复：执行顺序变化 → 脚本合并顺序变化 → 立即强制重渲染（不再依赖 SETTINGS_UPDATED）
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(source === 'st'
            ? t`执行顺序来源已切换为「原版顺序」（Global → Preset → Scoped，忽略 SPreset）。`
            : t`执行顺序来源已切换为「SPreset」（检测到 __regexScriptOrder 时跟随，否则回退原版）。`);
    });

    // 插件设置：保护替换总开关（rp_hub_protect_enabled，默认 true = 启用）
    $('#regex_protect_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setProtectEnabled(isEnable);
        saveSettingsDebounced();
        loadRegexScripts();
        // B1 修复：移除 SETTINGS_UPDATED 监听后，保护开关保存需主动强制重渲染（即时刷新）
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启保护替换（rphub 模式保护受保护内容不被正则替换）。`
            : t`已关闭保护替换（rphub 模式直接对全文替换，正则可改动 HTML / 代码块等）。`);
    });

    // 插件设置：保护项勾选（rp_hub_protect_items；勾选 = 该内容被保护）
    $('#regex_protect_items_list .regex_protect_item').on('input', function () {
        const items = $('#regex_protect_items_list .regex_protect_item')
            .filter(':checked')
            .map(function () { return $(this).data('item'); })
            .get();
        setProtectItems(items);
        saveSettingsDebounced();
        loadRegexScripts();
        // B1 修复：保护项勾选变化 → 立即强制重渲染（即时刷新）
        window.__rphubCompat__?.forceRerenderAll?.();
    });

    // 插件设置：降级目标（rp_hub_degrade_target，st/rphub/none，默认 st）。
    // 改后清 formatDetail 缓存（SETTINGS_UPDATED 已挂 clearModeCache）+ 重载脚本。
    $('#regex_degrade_target').on('change', function () {
        const target = $(this).val();
        setDegradeTarget(target);
        saveSettingsDebounced();
        loadRegexScripts();
        clearModeCache();
        // ST2 修复：降级目标变化 → 立即强制重渲染（即时刷新）
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(target === 'rphub'
            ? t`降级目标已切换为「rphub」：后端判定失败时仍按 RP 语义运行。`
            : target === 'none'
                ? t`降级目标已切换为「none」：后端判定失败时禁止降级，显示「判定失败」并按 st 行为运行。`
                : t`降级目标已切换为「st」：后端判定失败时降级为 st。`);
    });

    // 插件设置：超时预算（rp_hub_budget_ms，默认 50ms，范围 1-5000）。
    // input/change 都持久化 + toastr；归一后回填输入框（非法/超范围自动回退 50）。
    // input+change 对同一改动会连发：值与当前已存一致且输入框已回填 → 跳过（避免重复）。
    $('#regex_budget_ms').on('input change', function () {
        const value = normalizeBudgetMs($(this).val());
        if (getBudgetMs() === value && $(this).val() === String(value)) {
            return;
        }
        setBudgetMs(value);
        $(this).val(value);
        saveSettingsDebounced();
        loadRegexScripts();
        toastr.info(t`超时预算已设置为 ${value}ms（每条正则的最大执行时间）。`);
    });
    // B1 修复：budget 只在 change（失焦/回车）触发全量重渲染——input 连发若每次 forceRerenderAll
    // 会放大长聊天卡顿（每次输入都全量重算 + 酒馆助手 iframe 重建）。
    $('#regex_budget_ms').on('change', function () {
        window.__rphubCompat__?.forceRerenderAll?.();
    });

    // 兼容模式（rp_hub_panel_escape，默认 true）：切换需要重新挂载面板（改挂载目标）。
    // 持久化后提示用户刷新聊天/重载 —— 面板已渲染，切换挂载位置必须重新 init。
    $('#regex_panel_escape_toggle').prop('checked', isPanelEscapeEnabled());
    $('#regex_panel_escape_toggle').on('input', function () {
        setPanelEscapeEnabled(!!$(this).prop('checked'));
        saveSettingsDebounced();
        toastr.info(t`兼容模式已切换：需刷新页面后生效（面板挂载位置已改变）。`);
    });

    // 插件设置：ReDoS 预检总开关（rp_hub_precheck_enabled，默认 true = 启用）。
    // 关闭后跳过静态预检（被误伤正则放行，承担卡死风险）；诊断弹窗若打开则同步重分析。
    $('#regex_precheck_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        setPrecheckEnabled(isEnable);
        saveSettingsDebounced();
        refreshDiagnoseIfOpen();
        // B1 修复：预检总开关保存 → 立即强制重渲染（即时刷新）
        window.__rphubCompat__?.forceRerenderAll?.();
        toastr.info(isEnable
            ? t`已开启 ReDoS 预检（嵌套量词形态正则执行前被拦截）。`
            : t`已关闭 ReDoS 预检（跳过该防线 —— 被误伤的正则得以放行，但承担病理正则卡死风险）。`);
    });

    await loadRegexScripts();
    $('#saved_regex_scripts').sortable('enable');

    presetManager.setupEventListeners();

    eventSource.on(event_types.MAIN_API_CHANGED, onMainApiChanged);
    eventSource.on(event_types.CHAT_CHANGED, checkCharEmbeddedRegexScripts);
    eventSource.on(event_types.CHARACTER_DELETED, purgeEmbeddedRegexScripts);
    eventSource.on(event_types.PRESET_RENAMED_BEFORE, onPresetRenamed);
    eventSource.on(event_types.PRESET_CHANGED, checkPresetEmbeddedRegexScripts);
    eventSource.on(event_types.PRESET_DELETED, purgePresetEmbeddedRegexScripts);

    console.debug('[rp-hub-compat] 正则面板已挂载（dropdown 三分类 + 预设分组 + 编辑器 + 调试器 + 嵌入询问）。');
}
