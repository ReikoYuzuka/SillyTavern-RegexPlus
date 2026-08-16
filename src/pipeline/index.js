/**
 * pipeline/index.js —— 管道协调器：init/stop + 事件挂载。
 *
 * 事件表（对应引擎设计.md §2 / 实现计划.md 第 3 步）：
 *   MESSAGE_RECEIVED            → 双通道处理（显示+prompt 视角写回）+ 覆盖显示
 *   CHARACTER_MESSAGE_RENDERED  → coverMessage（渲染后覆盖，流式最终帧生效）
 *   USER_MESSAGE_RENDERED       → 用户消息处理 + 覆盖（用户消息不触发 MESSAGE_RECEIVED）
 *   MESSAGE_SWIPED              → 浏览 swipe 重算 + 覆盖
 *   MESSAGE_UPDATED             → 编辑取消/保存后恢复覆盖
 *   MESSAGE_EDITED              → 编辑保存同步 + 重算 + 保存
 *   GENERATE_AFTER_DATA         → prompt 兜底（未处理消息时整段处理）
 *   CHAT_CHANGED / SETTINGS_UPDATED → formatDetail 缓存失效
 *
 * 去重策略：
 *   - 单消息处理以 extra.rph_done 标记去重（持久化，reload 后不重复处理）。
 *   - MESSAGE_RECEIVED 已写回 prompt 视角 → GENERATE_AFTER_DATA 检测到全部已处理即跳过。
 *   - MESSAGE_RECEIVED 与 CHARACTER_MESSAGE_RENDERED 时序：
 *     ST 先 emit MESSAGE_RECEIVED 再 addOneMessage/emit RENDERED —— 显示结果
 *     已在 RENDERED 前写入 display_text，RENDERED 的 cover 是幂等覆盖（流式最终帧必需）。
 */

import { runtime } from './runtime.js';
import { clearModeCache } from '../store/rp-mode.js';
import { autoCoverCurrentChat, scheduleRerenderAfterPresetChange, cancelScheduledPresetRerender, hookRegexScriptsWrite } from './force-render.js';
import { event_types, eventSource } from '../st-bridge.js';
import * as display from './display.js';
import * as promptChannel from './prompt.js';
import * as edit from './edit.js';

let started = false;

/** 宏注入已在 runtime.engineRun 完成（ST substituteParams/substituteParamsExtended）。 */

export async function init() {
    if (started) return;
    started = true;
    runtime.active = true;

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, display.onCharacterRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, display.onUserRendered);
    eventSource.on(event_types.MESSAGE_SWIPED, display.onMessageSwiped);
    eventSource.on(event_types.MESSAGE_UPDATED, display.onMessageUpdated);
    eventSource.on(event_types.MESSAGE_EDITED, edit.onMessageEdited);
    eventSource.on(event_types.GENERATE_AFTER_DATA, promptChannel.onGenerateAfterData);
    // F4（审查报告 L4/D8）：WI 通道 —— prompt 合并前对 worldInfoBefore/After 施加 placement=5
    //（逐条目 per-entry depth 无法从扁平字符串恢复，文档声明局限；EM/depth/outlet 位置条目不在
    //  这两个字段内，同样声明局限）。
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, promptChannel.onGenerateBeforeCombinePrompts);
    // 预设变动 → 强制重渲染（用户定稿：监听预设变动强制执行一遍渲染；与第三方兼容，纯监听不干预）：
    //   切 API 预设（PRESET_CHANGED，kai/openai/nai/textgen）、API 切换（MAIN_API_CHANGED）
    //   都会改变当前正则/模板来源 → 模板消息 display_text 需用新鲜 rph_display 重渲染
    //   （第三部渲染服务），非模板消息由 forceRerenderAll 覆盖 DOM。去抖 800ms 合并连续切换。
    //   ⚠️ 不再监听 SETTINGS_UPDATED（settings_updated）：它在任何 saveSettings 都会发
    //   （含开聊天 selectCharacterById → saveSettings，script.js:8051），触发全量重渲染 +
    //   补发 character_message_rendered → 酒馆助手 auditRuntimes 每次开聊天把 iframe 重建
    //   3 次（重复渲染根因，eventTracing 堆栈实证）。面板保存正则已由 reloadCurrentChat
    //   兜底重渲染、SPreset 样式切换由 hookRegexScriptsWrite 钩子覆盖，均不依赖本监听。
    eventSource.on(event_types.PRESET_CHANGED, onPresetOrApiChanged);
    eventSource.on(event_types.MAIN_API_CHANGED, onPresetOrApiChanged);
    // SPreset 正则写入挂钩（切换样式自动重渲染）：oai_settings.extensions.regex_scripts 赋值拦截。
    // chatCompletionSettings 可能晚于扩展 init 就绪 → 未成功则等 APP_READY 再试一次。
    if (!hookRegexScriptsWrite()) {
        eventSource.once(event_types.APP_READY, () => {
            if (runtime.active) hookRegexScriptsWrite();
        });
    }
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, onSettingsChanged);
    eventSource.on(event_types.CHAT_LOADED, onChatLoaded);

    edit.initObserver();
    console.debug('[rp-hub-compat] 管道已挂载（显示/prompt 逐条/编辑链路 + WI 分部件 + 预设变动强制重渲染 + 宏注入 + formatDetail 判定 + 聊天打开自动覆盖）。');
}

export async function stop() {
    if (!started) return;
    started = false;
    runtime.active = false;

    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, display.onCharacterRendered);
    eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, display.onUserRendered);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, display.onMessageSwiped);
    eventSource.removeListener(event_types.MESSAGE_UPDATED, display.onMessageUpdated);
    eventSource.removeListener(event_types.MESSAGE_EDITED, edit.onMessageEdited);
    eventSource.removeListener(event_types.GENERATE_AFTER_DATA, promptChannel.onGenerateAfterData);
    eventSource.removeListener(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, promptChannel.onGenerateBeforeCombinePrompts);
    eventSource.removeListener(event_types.PRESET_CHANGED, onPresetOrApiChanged);
    eventSource.removeListener(event_types.MAIN_API_CHANGED, onPresetOrApiChanged);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.SETTINGS_UPDATED, onSettingsChanged);
    eventSource.removeListener(event_types.CHAT_LOADED, onChatLoaded);
    cancelScheduledPresetRerender();
    edit.stopObserver();
    console.debug('[rp-hub-compat] 管道已停止。');
}

/** 预设/API 变动 → 调度强制重渲染（去抖）。 */
function onPresetOrApiChanged() {
    if (!runtime.active) return;
    scheduleRerenderAfterPresetChange();
}

/** MESSAGE_RECEIVED：AI 回复收到 → 双通道处理 + 覆盖显示。 */
async function onMessageReceived(messageId) {
    if (!runtime.active) return;
    const msg = runtime.chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    if (msg.extra?.rph_done) {
        await display.coverMessage(messageId);
        return;
    }
    await display.processAndCover(messageId);
}

/** CHAT_CHANGED：聊天/角色切换 → formatDetail 缓存失效。 */
function onChatChanged() {
    clearModeCache();
}

/** SETTINGS_UPDATED：设置保存 → formatDetail 缓存失效。 */
function onSettingsChanged() {
    clearModeCache();
}

/**
 * CHAT_LOADED：打开已有聊天 / reloadCurrentChat（script.js:7610，printMessages 之后）→
 * 自动逐条覆盖（后台）。ST 此时用未围栏的 display_text 渲染 DOM（裸文档被清洗），
 * 需自动把围栏结果显示到界面 —— 否则用户要手动点第三部「强制重新渲染」。
 * 注意：本事件在 CHAT_CHANGED 之前（script.js:7610 vs 7641），且缓存键按角色区分，
 * 因此不清 formatDetail 缓存（切换角色时缓存键不同，不会命中旧判定）。
 * 启动时（init 阶段首个聊天）也会触发一次 —— 正常，覆盖幂等。
 */
function onChatLoaded() {
    if (!runtime.active) return;
    // 后台执行，不阻塞聊天渲染（长聊天逐条覆盖可能耗时）
    autoCoverCurrentChat().catch((err) => {
        console.warn('[rp-hub-compat] 聊天打开自动覆盖失败：', String(err?.message || err));
    });
}
