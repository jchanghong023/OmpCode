/** Fork-owned OmpCode terminology and controls; layered over the upstream locale. */
const ompZhCNOverrides: Record<string, string> = {
  "chat.error.ompAttachmentRejected": "附件无法发送给 omp：{reason}",
  "chat.subagents.unavailable": "omp 子代理状态暂不可用，当前会话的子代理记录可能不完整。",
  "settings.ompNative.extensions": "OMP 扩展",
  "settings.ompNative.mcp": "OMP MCP 服务器",
  "settings.ompNative.description":
    "显示当前 omp profile 和本地项目中的原生配置。修改配置后刷新此页。",
  "settings.ompNative.runtimeUnavailable":
    "omp RPC 暂未提供扩展运行状态或 MCP 连接状态；下列内容只表示配置入口。",
  "settings.ompNative.refresh": "刷新",
  "settings.ompNative.loadFailed": "读取 omp 配置失败",
  "settings.ompNative.profile": "当前 Profile",
  "settings.ompNative.project": "当前项目",
  "settings.ompNative.openDirectory": "打开目录",
  "settings.ompNative.configInvalid": "mcp.json 无法解析，请在 omp 配置中检查。",
  "settings.ompNative.empty": "未发现配置项",
  "settings.ompNative.enabled": "已启用",
  "settings.ompNative.disabled": "已禁用",
  "settings.ompNative.directoryEntry": "目录入口",
  "settings.ompNative.loading": "读取中…",
  "chat.ompSubagent.transcript": "查看子代理记录",
  "settings.dataBaseDirDescription":
    "应用数据的根目录（默认为用户主目录），修改后会将现有数据复制到新位置。路径后缀 .ompcode/v2 不可更改。",
  "occupationOnboarding.modeDescription": "你希望 OmpCode 如何呈现工作过程？",
  "settings.ompModelRoles.configMissing": "当前 omp profile 未找到模型配置",
  "settings.ompModelRoles.configInvalid": "omp 模型配置格式无效，请检查 config.yml 中的 modelRoles",
  "settings.ompModelRoles.catalogEmpty": "omp 尚未提供可选模型",
  "settings.ompModelRoles.title": "模型设置",
  "settings.ompModelRoles.description": "配置 omp 各角色的模型。保存前自动备份配置文件。",
  "settings.ompModelRoles.unset": "未配置",
  "settings.ompModelRoles.thinkingLevel": "思考等级",
  "settings.ompModelRoles.levelDefault": "默认档位",
  "settings.ompModelRoles.platformUnsupported": "当前环境不支持打开 omp 模型配置",
  "settings.ompModelRoles.loadFailed": "omp 模型配置加载失败",
  "settings.ompModelRoles.saved": "已保存（原配置已自动备份）",
  "settings.ompModelRoles.saving": "保存中…",
  "settings.ompModelRoles.save": "保存",
  "settings.ompProfile.label": "OMP Profile",
  "settings.ompProfile.default": "默认 profile",
  "settings.ompProfile.error": "OMP profile 读取或保存失败",
  "settings.ompProfile.restartRequired":
    "Profile 已保存。请重启应用后使用该 profile 的配置、模型和会话。",
  "settings.ompProfile.restart": "重启应用",
  "occupationOnboarding.description": "选择最接近你日常工作的一项，让 OmpCode 更懂你的工作。",
  "occupationOnboarding.memoryDescription": "让 OmpCode 记住你的偏好与工作上下文。",
  "startup.global.silent": "正在启动 OmpCode",
  "startup.global.servicesFailed":
    "本地数据准备已完成，但应用服务启动失败。请复制诊断信息，退出并重新打开 OmpCode。",
  "startup.global.starting_services": "正在启动 OmpCode",
  "startup.global.help":
    "准备完成后将自动进入 OmpCode。历史记录较多时可能需要较长时间，请保持应用运行。",
  "startup.global.error.lock_timeout":
    "等待数据库写锁超时。请检查其他 OmpCode 或 CLI 进程是否仍在更新数据，待其完成后点击重试。",
  "startup.global.error.startup_status_timeout":
    "未能收到启动状态。请退出并重新打开 OmpCode；如果仍失败，请提供诊断信息。",
  "startup.global.error.transport_closed":
    "数据准备进程意外退出或连接中断。请退出并重新打开 OmpCode，应用会重新检查迁移记录。",
  "startup.global.error.unsupported_runtime":
    "当前配置的 Agent 不支持独立存储准备。请恢复配套的 Agent 后重新打开 OmpCode。",
  "chat.ompStatus.sessionModel": "当前会话模型（下次提交生效）",
  "chat.ompStatus.noModel": "未选择模型",
  "chat.ompStatus.usePlanModel": "切换计划模型",
  "chat.ompStatus.exitPlanModel": "退出计划模型",
  "chat.ompStatus.planModelShort": "计划模型",
  "chat.ompStatus.exitPlanModelShort": "退出计划",
  "chat.ompStatus.enabled": "开",
  "chat.ompStatus.disabled": "关",
  "chat.ompStatus.planMissing": "未配置 plan 角色模型",
  "chat.ompStatus.planFailed": "计划模型切换失败",
  "chat.ompStatus.context": "上下文占用",
  "chat.ompStatus.compact": "压缩上下文",
  "chat.ompStatus.autoCompact": "自动压缩",
  "chat.ompStatus.autoFailed": "自动压缩切换失败",
  "settings.computerUse.disabledToast": "电脑控制已关闭，已有对话需重启 OmpCode 后生效。",
  "conversationShare.permission.linkEditorHint": "可导入到 OmpCode",
  "conversationShare.import.loginRequired": "该分享暂不支持匿名导入，请登录 OmpCode 后重试",
  "bots.description": "把外部聊天工具和 Webhook 接入 OmpCode 机器人。",
  "bots.setup.guide.weixin.create.2":
    "OmpCode 会直接保存 iLink 返回的 bot_token；扫码后请在微信里向 Bot 发送任意消息完成会话激活。",
  "bots.setup.guide.weixin.create.3":
    "OmpCode 内置 iLink 客户端，通过 `/ilink/bot/getupdates` 长轮询收消息，通过 `/ilink/bot/sendmessage` 回复。",
  "bots.setup.guide.webhook.create.1":
    "Webhook 模式不需要先在第三方平台创建原生机器人；你的系统只需要能向 OmpCode 回调接口发消息。",
  "bots.setup.guide.webhook.bind.1": "向 OmpCode 的 `/api/bots/webhook` 发送一条私聊消息回调。",
  "bots.runtime.telegramLongPollingHandledElsewhere": "Telegram 长轮询由另一个 OmpCode 窗口处理。",
  "welcome.title": "Welcome to OmpCode",
  "login.title": "欢迎来到 OmpCode",
  "login.description": "连接账号，开始使用 OmpCode",
  "logout.confirm.title": "断开连接并重启 OmpCode？",
  "modelTrajectory.empty": "暂无模型调用记录（仅 OmpCode Agent 会落盘 model-io）",
  "titleBar.menu.help.about": "关于 OmpCode",
  "forceUpdate.title": "需要升级 OmpCode 后继续使用",
  "workspaceSidebar.unavailableLocalDirectory":
    "工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 OmpCode 即可继续使用。",
  "ssh.assetInstallModeDescription":
    "远端服务器下载可减少上传等待，但服务器需要能访问 OmpCode CDN，并具备下载、解压和校验工具。",
  "webRemoteControl.description": "通过聊天机器人控制 OmpCode 工作区。",
  "settings.terminalFontFamilyDescription":
    "留空时自动探测系统终端配置；填写后作为 OmpCode 终端的字体覆盖。",
  "settings.zcodeInteractionBehaviorDescription":
    "在 OmpCode 运行时将后续操作加入队列，或引导至下一轮工具调用后运行。",
  "settings.dataBaseDirForbiddenInstallDir":
    "不能选择 OmpCode 安装目录作为数据存储路径。请选择安装目录之外的文件夹。",
  "sidebar.settings.menuTitle": "显示效果",
  "settings.migration.sectionDescription":
    "扫描本机 Claude Code 原生历史，可按 workspace 和时间范围筛选，再把选中的会话导入到对应的 OmpCode 任务列表。",
  "resourceManager.storage.summaryTotal": "OmpCode 总占用",
  "resourceManager.storage.diskUsage": "OmpCode 占用 {used}",
  "settings.browser.desktopOnly": "浏览器数据只能在 OmpCode 桌面端管理。",
  "settings.browser.import.helperVerificationFailed":
    "OmpCode 的 Windows 安全导入组件校验失败，Cookie 未导入。请重新安装或更新 OmpCode。",
  "settings.browser.import.adminConfirmDescription":
    "Chrome 在 Windows 上使用 App-Bound 加密保护 Cookie。OmpCode 将为本次导入请求管理员权限，临时启动系统服务，完成后立即删除。不会读取或导入 Chrome 密码。",
  "settings.mcp.description": "管理 OmpCode Agent 使用的 MCP 服务器配置。",
  "settings.mcp.host.activeDescription":
    "该 MCP 服务器由 OmpCode 宿主为 {pluginName} 插件提供，运行时身份由宿主管理。",
  "settings.mcp.statusOnlyUnsupported":
    "当前 OmpCode Agent 不支持 OAuth 状态刷新。请升级或重启 OmpCode，然后重新打开 MCP 设置进行完整刷新。",
  "settings.mcp.failure.not_authenticated": "当前未登录，请先登录 OmpCode。",
  "settings.mcpServers.import.importing": "正在导入 MCP 服务器到 OmpCode",
  "settings.modelProvider.startPlan.highlight.trial.description": "登录 OmpCode 3.x 后开始计时。",
  "settings.modelProvider.startPlan.compatibility":
    "支持 BYOK、BYOA；Base URL、API Format 和 API Key 由 OmpCode 自动维护，无需手动配置。",
  "settings.modelProvider.codingPlan.purchase.teamMemberNoticeDescription":
    "请先在 BigModel 团队套餐管理页添加自己或其他成员，完成后即可在 OmpCode 使用团队额度。",
  "settings.modelProvider.help.contextWindow":
    "模型一次可处理的上下文容量，单位为 Token。OmpCode 会据此管理上下文。\n请勿超过模型的实际上限。",
  "settings.modelProvider.help.followRecommendedConfig":
    "根据模型 ID、Base URL 和 API 格式，为您智能匹配推荐配置。OmpCode 会持续更新推荐配置，并自动同步给您。\n如果手动修改某项配置，该项将转为手动管理，不再跟随推荐更新；其他配置仍由智能配置管理。",
  "settings.usage.billingBanner.description":
    "连接 {provider} 账号后查询编程套餐权益，购买或配置后回到 OmpCode 即可继续编码。",
  "settings.usage.entitlementServerMcpUsage": "OmpCode MCP",
  "sidebar.usage.plan.mcp": "OmpCode MCP",
  "sidebar.usage.plan.zcodeMcp": "OmpCode MCP",
  "sidebar.usage.plan.zcodeMcpDescription": "OmpCode 预置插件 MCP 每日合计额度",
  "settings.skills.import.mode.copy.description":
    "将完整技能目录复制到 OmpCode。外部 Agent 目录后续变更不会自动同步。",
  "settings.skills.import.mode.symlink.description":
    "创建指向外部 Agent 技能目录的链接。OmpCode 会跟随来源目录后续变更，但该技能依赖来源路径持续可用。",
  "settings.skills.import.importing": "正在导入技能到 OmpCode",
  "settings.subagents.description": "管理 OmpCode Agent 运行时消费的用户级子智能体 Markdown 文件。",
  "settings.plugins.store.subtitle": "用插件为 OmpCode 扩展技能、命令与 MCP 能力",
  "settings.plugins.import.mode.copy.description":
    "将完整插件目录复制到 OmpCode，并注册到 plugins.dirs。外部 Agent 目录后续变更不会自动同步。",
  "settings.plugins.import.mode.symlink.description":
    "创建指向外部 Agent 插件目录的链接，并注册到 plugins.dirs。OmpCode 会跟随来源目录后续变更，但该插件依赖来源路径持续可用。",
  "settings.plugins.import.importing": "正在导入插件到 OmpCode",
  "settings.commands.description":
    "管理 OmpCode Agent 的 .md 命令文件。命令可通过 /command-name 在聊天中调用。",
  "settings.commands.source.zcodeAgent": "OmpCode Agent",
  "settings.commands.import.mode.copy.description":
    "将命令文件复制到 OmpCode。外部 Agent 文件后续变更不会自动同步。",
  "settings.commands.import.mode.symlink.description":
    "创建指向外部 Agent 命令文件的链接。OmpCode 会跟随来源文件后续变更，但该命令依赖来源路径持续可用。",
  "settings.commands.import.importing": "正在导入命令到 OmpCode",
  "settingsSync.agent.zcode": "OmpCode Agent",
  "settingsSync.discovery.helper": "仅导入缺失项，不会覆盖当前 OmpCode 中已存在的配置。",
  "onboarding.dialog.title": "欢迎使用 OmpCode",
  "onboarding.welcome.title": "欢迎使用 OmpCode",
  "onboarding.welcome.start": "开始使用 OmpCode",
  "onboarding.stepDescription.migration": "开始迁移并等待 OmpCode 完成导入。",
  "onboarding.agentsFile.confirmDescription":
    "将从 {source} 复制到 {target}。\n如果目标文件已存在，OmpCode 默认 AGENTS 配置会被覆盖。",
  "chat.placeholder.newTask": "向 OmpCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力",
  "chat.placeholder.newTaskMobile": "向 OmpCode 提问…",
  "chat.contextUsage.omp.estimated": "估算用量分项",
  "chat.contextUsage.omp.systemPrompt": "系统提示词",
  "chat.contextUsage.omp.systemTools": "系统工具",
  "chat.contextUsage.omp.systemContext": "系统上下文",
  "chat.contextUsage.omp.skills": "技能",
  "chat.contextUsage.omp.messages": "消息",
  "chat.contextUsage.omp.mcpTools": "MCP 工具",
  "chat.contextUsage.omp.memoryFiles": "记忆文件",
  "chat.contextUsage.omp.customAgents": "自定义代理",
  "chat.contextUsage.omp.free": "空闲空间",
  "chat.contextUsage.omp.autoCompactBuffer": "自动压缩预留区",
  "chat.toolbar.computerUse.tooltip.ready": "电脑操作已就绪 · 直接描述你想让 OmpCode 做的事",
  "chat.toolbar.computerUse.tooltip.error":
    "电脑操作启用失败 · 重启 OmpCode 应用后重试，或让 OmpCode 排查日志",
  "workflows.hub.empty.hint":
    "在对话里让 OmpCode 设计工作流，跑通之后再让它保存到项目里。未打开的项目不会出现在这里。",
  "workflows.hub.detail.whenToUse.help": "给 OmpCode 的路由提示：什么场景该选这个工作流。",
  "workflows.hub.detail.script.note": "脚本只读。要改脚本，在对话里让 OmpCode 修订后另存一版。",
  "chat.quota.mcp.quotaExhausted": "OmpCode MCP「{server}」今日额度已用完，明天自动恢复。",
  "chat.quota.mcp.codingPlanRequired":
    "当前无 OmpCode MCP「{server}」额度，请登录或开通 Coding Plan 使用。",
  "resourceManager.appUsage": "OmpCode",
  "feedback.submit.template.section.copyErrorHeading": "OmpCode 报错信息",
  "offPeak.keepAwakeBanner": "OmpCode 运行会话时保持电脑唤醒。",
  "offPeak.form.instructionsPlaceholder":
    "描述希望 OmpCode 在后台完成的工作、预期结果和约束，例如整理本周代码改动并生成站会摘要…",
  "chat.cuaReadiness.toolsNotLoaded":
    "OmpCode 电脑控制仍在准备中——工具尚未加载（已加载 {count} 个）。请先授予下方权限，Helper 就绪后工具会自动出现。",
  "chat.cuaReadiness.toolsPreparing":
    "OmpCode 电脑控制仍在准备中——工具尚未加载。请先授予下方权限，Helper 就绪后工具会自动出现。",
  "cuaPermission.modal.relaunchAppButton": "重启 OmpCode",
  "cuaPermission.modal.relaunchAppHint":
    "重启 Helper 后仍未生效？重启 OmpCode 可彻底重载 Helper 进程。",
  "cuaPermission.tools.untrustedRuntime":
    "检测到电脑控制工具，但它们并非来自已校验的 OmpCode 官方插件。请检查插件安装后重新验证。",
  "cuaPermission.ready.sessionValidationHint":
    "首个会话启动时，OmpCode 会针对该会话精确验证电脑控制工具。",
};

export default ompZhCNOverrides;
