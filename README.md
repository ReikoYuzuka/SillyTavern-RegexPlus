# SillyTavern-RegexPlus

SillyTavern 正则引擎插件：RP-Hub 角色卡的正则解释器与渲染管道，附带正则面板（三分类下拉 + 编辑器 + 调试器）。

> ⚠️ **与原有的正则扩展不兼容，需要主动关闭原版 Regex 扩展**，再启用本插件（两者会同时接管正则处理）。

**安装**：把本目录放进 `SillyTavern/public/scripts/extensions/third-party/`（目录名任意，建议保持 `SillyTavern-RegexPlus`），扩展设置里启用；同时**关闭原版 `Regex` 扩展**。

## 新增功能

- **双语义解释器**：预设/全局脚本按酒馆标准（st）执行，RP 卡内嵌 scoped 脚本按 RP-Hub 语义执行（保护替换 / userOnly / 双 false 仅显示）。
- **1→2→1 渲染管线**：预设第一遍生成界面 → 界面段藏走 → 卡内嵌美化跑纯正文 → 预设第二遍 → 拼回，界面与美化正文并存。
- **界面段隔离**：HTML 围栏 / 完整 HTML 文档 / script 块在美化阶段对正则隐形，正文 `^` 锚定不失效。
- **空白段守卫**：纯空白段不交给「整段匹配型」美化正则，防止包出空卡片。
- **排除第 0 楼**：开场白带全文负前瞻的沉浸式容器默认跳过，普通 scoped 照常执行。
- **保护替换**：正则美化产出代码块后，后续正则不会破坏代码块。
- **ReDoS 预检 + 超时预算**：病态正则执行前被拦截，重正则预算内掐断。
- **triggerSlash 语义分发桥**：纯文本 `/` 开头按钮走「发消息 + 生成」，不再报 Unknown command。
- **显示保底（默认开启）**：每次把界面写进 `.mes_text` 后，同步写酒馆原生 `extra.display_text`。
  酒馆的 `updateMessageBlock`（`script.js:2033-2037`）按 `extra.display_text ?? mes` 重画楼层，
  所以其它扩展（ST-Prompt-Template / cocktail / 渲染优化器）重画这一楼时会读到我们的界面
  并把界面写回来，而不是退回原始正文——这修掉了「编辑取消 / 保存后界面变成纯正文」。
  面板可关闭（插件设置 → 显示保底）。

## 第三方写入约定（JOIN-07）

其它扩展 / 脚本若直接写入 `extension_settings.regex`（或预设/卡内嵌脚本数据），必须遵守：

- **稳定 id**：每条脚本对象的 `id` 字段必须在多次会话间保持稳定（如内容哈希），不要用随机数
  或每次启动重新生成——本插件的诊断、绕过表（`rp_hub_precheck_bypass`）与面板编辑定位都以
  `script.id || script.scriptName` 为键，id 漂移会导致用户配置失联。
- **字段语义**：`findRegex`/`replaceString`/`placement`/`markdownOnly`/`promptOnly`/`disabled`
  与原版 ST 正则扩展语义一致；RP 专属字段（`userOnly`/`scope`/`rp_source`）由本插件解释。
- **消息楼层写入**：写 `chat[i].mes` 的共存方建议维护 `extra.rph_rev` 修订号（写入时 +1）。
  本插件写回原始文本前会检测修订链（commitMessageView），遵循约定的共存方不会被本插件
  意外覆盖修改。