/** Fork-owned OmpCode terminology and controls; layered over the upstream locale. */
const ompEnUSOverrides: Record<string, string> = {
  "chat.error.ompAttachmentRejected": "Cannot send attachment to omp: {reason}",
  "chat.subagents.unavailable":
    "omp subagent status is unavailable; this session may have incomplete subagent records.",
  "settings.ompNative.extensions": "OMP Extensions",
  "settings.ompNative.mcp": "OMP MCP Servers",
  "settings.ompNative.description":
    "Shows native configuration in the current omp profile and local project. Refresh after changing configuration.",
  "settings.ompNative.runtimeUnavailable":
    "omp RPC does not expose extension runtime or MCP connection status. These entries show configuration only.",
  "settings.ompNative.refresh": "Refresh",
  "settings.ompNative.loadFailed": "Could not read omp configuration",
  "settings.ompNative.profile": "Current Profile",
  "settings.ompNative.project": "Current Project",
  "settings.ompNative.openDirectory": "Open Folder",
  "settings.ompNative.configInvalid": "Could not parse mcp.json. Check the omp configuration.",
  "settings.ompNative.empty": "No configured entries",
  "settings.ompNative.enabled": "Enabled",
  "settings.ompNative.disabled": "Disabled",
  "settings.ompNative.directoryEntry": "Directory entry",
  "settings.ompNative.loading": "Loading…",
  "chat.ompSubagent.transcript": "View subagent transcript",
  "settings.dataBaseDirDescription":
    "Root directory for app data (defaults to user home directory). Existing data will be copied to the new location. The .ompcode/v2 suffix cannot be changed.",
  "occupationOnboarding.modeDescription": "How would you like OmpCode to show its work?",
  "settings.ompModelRoles.configMissing": "No model config found for the current omp profile",
  "settings.ompModelRoles.configInvalid":
    "Invalid omp model config; check modelRoles in config.yml",
  "settings.ompModelRoles.catalogEmpty": "omp has not provided any models yet",
  "settings.ompModelRoles.title": "Model settings",
  "settings.ompModelRoles.description":
    "Configure models for omp roles. The config is backed up before saving.",
  "settings.ompModelRoles.unset": "Not configured",
  "settings.ompModelRoles.thinkingLevel": "thinking level",
  "settings.ompModelRoles.levelDefault": "Default level",
  "settings.ompModelRoles.platformUnsupported": "Opening omp model config is unsupported here",
  "settings.ompModelRoles.loadFailed": "Failed to load omp model config",
  "settings.ompModelRoles.saved": "Saved (previous config backed up automatically)",
  "settings.ompModelRoles.saving": "Saving…",
  "settings.ompModelRoles.save": "Save",
  "settings.ompProfile.label": "OMP Profile",
  "settings.ompProfile.default": "Default profile",
  "settings.ompProfile.error": "Failed to load or save OMP profiles",
  "settings.ompProfile.restartRequired":
    "Profile saved. Restart the app to use its config, models, and sessions.",
  "settings.ompProfile.restart": "Restart app",
  "occupationOnboarding.memoryDescription":
    "Let OmpCode remember your preferences and work context.",
  "startup.global.silent": "Starting OmpCode",
  "startup.global.servicesFailed":
    "Local data is ready, but app services failed to start. Copy the diagnostics, then exit and reopen OmpCode.",
  "startup.global.starting_services": "Starting OmpCode",
  "startup.global.help":
    "OmpCode will open when preparation finishes. Large histories may take longer. Please keep the app running.",
  "startup.global.error.lock_timeout":
    "Waiting for the database write lock timed out. Another OmpCode or CLI process may be updating data. Retry after it finishes.",
  "startup.global.error.startup_status_timeout":
    "No startup status was received. Exit and reopen OmpCode. If it fails again, provide the diagnostics to support.",
  "startup.global.error.transport_closed":
    "The preparation process exited or disconnected. Exit and reopen OmpCode to check the migration records again.",
  "startup.global.error.unsupported_runtime":
    "The configured Agent does not support storage preparation. Restore the bundled Agent, then reopen OmpCode.",
  "chat.ompStatus.sessionModel": "Session model (applies on next send)",
  "chat.ompStatus.noModel": "No model selected",
  "chat.ompStatus.usePlanModel": "Use plan model",
  "chat.ompStatus.exitPlanModel": "Exit plan model",
  "chat.ompStatus.planModelShort": "Plan model",
  "chat.ompStatus.exitPlanModelShort": "Exit plan",
  "chat.ompStatus.enabled": "On",
  "chat.ompStatus.disabled": "Off",
  "chat.ompStatus.planMissing": "No plan role model configured",
  "chat.ompStatus.planFailed": "Could not switch plan model",
  "chat.ompStatus.context": "Context usage",
  "chat.ompStatus.compact": "Compact context",
  "chat.ompStatus.autoCompact": "Auto compact",
  "chat.ompStatus.autoFailed": "Could not change auto compact",
  "settings.computerUse.disabledToast":
    "Computer Use is disabled. Existing conversations require a OmpCode restart to take effect.",
  "conversationShare.permission.linkEditorHint": "Import into OmpCode",
  "conversationShare.import.loginRequired":
    "This share cannot be imported anonymously. Sign in to OmpCode and try again",
  "bots.description": "Connect external chats and webhooks to OmpCode bots.",
  "bots.setup.guide.weixin.create.2":
    "OmpCode saves the bot_token returned by iLink automatically; after scanning, send any message to the bot in Weixin to activate the chat.",
  "bots.setup.guide.weixin.create.3":
    "OmpCode uses a built-in iLink client: `/ilink/bot/getupdates` for long polling and `/ilink/bot/sendmessage` for replies.",
  "bots.setup.guide.webhook.create.1":
    "Webhook mode does not require a native bot in the third-party product; your integration only needs to POST messages to OmpCode.",
  "bots.setup.guide.webhook.bind.1":
    "POST a private-message callback to OmpCode's `/api/bots/webhook` endpoint.",
  "bots.runtime.telegramLongPollingHandledElsewhere":
    "Telegram long polling is handled by another OmpCode window.",
  "welcome.title": "Welcome to OmpCode",
  "login.title": "Welcome to OmpCode",
  "login.description": "Connect your account to start using OmpCode",
  "logout.confirm.title": "Disconnect and restart OmpCode?",
  "modelTrajectory.empty": "No model calls recorded (only OmpCode Agent writes model-io)",
  "titleBar.menu.help.about": "About OmpCode",
  "forceUpdate.title": "Update OmpCode to continue",
  "workspaceSidebar.unavailableLocalDirectory":
    "The workspace directory does not exist or cannot be accessed. You can only view history for now. Restore the directory and restart OmpCode to continue.",
  "ssh.assetInstallModeDescription":
    "Remote server download reduces upload waiting, but the server must reach the OmpCode CDN and have download, extract, and checksum tools.",
  "webRemoteControl.description": "Control OmpCode workspaces through chat bots.",
  "chat.changeSummary.rewindDialog.description":
    "OmpCode checks current file content again before writing. If another process changed a file, no files will be written.",
  "settings.terminalFontFamilyDescription":
    "Leave blank to auto-detect system terminal settings; set a value to override the OmpCode terminal font.",
  "settings.zcodeInteractionBehaviorDescription":
    "While OmpCode is running, add follow-up actions to the queue or guide them to run after the next tool call.",
  "settings.dataBaseDirForbiddenInstallDir":
    "The data directory cannot be the OmpCode installation folder on Windows. Choose a folder outside the app install location.",
  "sidebar.settings.menuTitle": "Display",
  "settings.migration.sectionDescription":
    "Scan native Claude Code history on this machine, optionally filter by workspace and activity window, then import the selected sessions into their matching OmpCode task lists.",
  "resourceManager.storage.summaryTotal": "Total used by OmpCode",
  "resourceManager.storage.diskUsage": "OmpCode uses {used}",
  "settings.browser.desktopOnly": "Browser data can only be managed in the OmpCode desktop app.",
  "settings.browser.import.helperVerificationFailed":
    "OmpCode could not verify its Windows secure import component. Reinstall or update OmpCode before importing cookies.",
  "settings.browser.import.adminConfirmDescription":
    "Chrome protects cookies with App-Bound encryption on Windows. For this import only, OmpCode will request administrator access, start a temporary system service, and delete it immediately afterward. Chrome passwords are never read or imported.",
  "settings.mcp.description": "Manage MCP server configurations used by OmpCode Agent.",
  "settings.mcp.host.activeDescription":
    "OmpCode provides this MCP server for the {pluginName} plugin. Its runtime identity is managed by the host.",
  "settings.mcp.statusOnlyUnsupported":
    "This OmpCode Agent cannot refresh OAuth status. Upgrade or restart OmpCode, then reopen MCP settings to run a full refresh.",
  "settings.mcp.failure.not_authenticated":
    "You are not signed in. Sign in to OmpCode to use this MCP server.",
  "settings.mcpServers.import.importing": "Importing MCP servers into OmpCode",
  "settings.modelProvider.startPlan.highlight.trial.description":
    "Timing starts after signing in to OmpCode 3.x.",
  "settings.modelProvider.startPlan.compatibility":
    "Supports BYOK and BYOA. Base URL, API format, and API Key are maintained by OmpCode automatically.",
  "settings.modelProvider.codingPlan.purchase.teamMemberNoticeDescription":
    "Add yourself or other members on the BigModel team plan management page. Once assigned, the team quota will be available in OmpCode.",
  "settings.modelProvider.help.contextWindow":
    "The context capacity the model can process at once, in tokens. OmpCode uses this to manage context.\nDo not exceed the model's actual limit.",
  "settings.modelProvider.help.followRecommendedConfig":
    "Matches recommended configuration using the model ID, Base URL, and API format. OmpCode continually updates recommendations and automatically syncs them to you.\nWhen you manually change a setting, that setting becomes manually managed and stops following recommendation updates; other settings remain managed by smart configuration.",
  "settings.usage.billingBanner.description":
    "Connect your {provider} account to query Coding Plan entitlement, then keep coding in OmpCode after purchase or setup.",
  "settings.usage.entitlementServerMcpUsage": "OmpCode MCP",
  "sidebar.usage.plan.mcp": "OmpCode MCP",
  "sidebar.usage.plan.zcodeMcp": "OmpCode MCP",
  "sidebar.usage.plan.zcodeMcpDescription":
    "Daily aggregate quota for OmpCode built-in plugin MCPs",
  "settings.skills.import.mode.copy.description":
    "Copy the full skill directory into OmpCode. Later changes in the external agent directory will not sync automatically.",
  "settings.skills.import.mode.symlink.description":
    "Create a directory link to the external agent skill. OmpCode follows later source changes, but the skill depends on that source path remaining available.",
  "settings.skills.import.importing": "Importing skills into OmpCode",
  "settings.subagents.description":
    "Manage user-level subagent Markdown files consumed by OmpCode Agent.",
  "settings.plugins.store.subtitle":
    "Extend OmpCode with skills, commands, and MCP servers from plugins",
  "settings.plugins.import.mode.copy.description":
    "Copy the full plugin directory into OmpCode and register it in plugins.dirs. Later changes in the external agent directory will not sync automatically.",
  "settings.plugins.import.mode.symlink.description":
    "Create a directory link to the external agent plugin and register it in plugins.dirs. OmpCode follows later source changes, but the plugin depends on that source path remaining available.",
  "settings.plugins.import.importing": "Importing plugins into OmpCode",
  "settings.commands.description":
    "Manage OmpCode Agent .md command files. Commands can be invoked with /command-name in chat.",
  "settings.commands.source.zcodeAgent": "OmpCode Agent",
  "settings.commands.import.mode.copy.description":
    "Copy the command file into OmpCode. Later changes in the external agent file will not sync automatically.",
  "settings.commands.import.mode.symlink.description":
    "Create a file link to the external agent command. OmpCode follows later source changes, but the command depends on that source path remaining available.",
  "settings.commands.import.importing": "Importing commands into OmpCode",
  "settingsSync.action.finish": "Start using OmpCode",
  "settingsSync.agent.zcode": "OmpCode Agent",
  "settingsSync.discovery.helper":
    "Only missing items will be imported and your current OmpCode settings will not be overwritten.",
  "onboarding.dialog.title": "Welcome to OmpCode",
  "onboarding.welcome.title": "Welcome to OmpCode",
  "onboarding.welcome.start": "Start OmpCode",
  "onboarding.stepDescription.migration":
    "Start migration and wait while OmpCode imports your selections.",
  "onboarding.agentsFile.confirmDescription":
    "OmpCode will copy {source} to {target}.\nIf the target file already exists, the OmpCode default AGENTS configuration will be overwritten.",
  "chat.placeholder.newTask":
    "Ask OmpCode anything, @ to add context, / for commands or capabilities",
  "chat.placeholder.newTaskMobile": "Ask OmpCode anything…",
  "chat.contextUsage.omp.estimated": "Estimated usage by category",
  "chat.contextUsage.omp.systemPrompt": "System prompt",
  "chat.contextUsage.omp.systemTools": "System tools",
  "chat.contextUsage.omp.systemContext": "System context",
  "chat.contextUsage.omp.skills": "Skills",
  "chat.contextUsage.omp.messages": "Messages",
  "chat.contextUsage.omp.mcpTools": "MCP tools",
  "chat.contextUsage.omp.memoryFiles": "Memory files",
  "chat.contextUsage.omp.customAgents": "Custom agents",
  "chat.contextUsage.omp.free": "Free space",
  "chat.contextUsage.omp.autoCompactBuffer": "Auto-compact buffer",
  "chat.modelSwitch.contextWindowGuard.description":
    "This conversation has used {used} tokens, which exceeds {modelName}'s available context of {target} tokens after reserving maximum output.\nCompress the current conversation with the current model first. If the compressed context fits, OmpCode will continue switching models.",
  "chat.toolbar.computerUse.tooltip.ready":
    "Computer Use ready — just describe what you want OmpCode to do",
  "chat.toolbar.computerUse.tooltip.error":
    "Computer Use enablement failed. Please restart OmpCode app and retry, or ask OmpCode to investigate the logs",
  "workflows.hub.empty.hint":
    "Design a workflow with OmpCode in chat, then have it save the workflow to a project once it works. Projects that aren't open don't appear here.",
  "workflows.hub.detail.whenToUse.help":
    "A routing hint for OmpCode: when this workflow is the right pick.",
  "workflows.hub.detail.script.note":
    "The script is read-only. To change it, revise it with OmpCode in chat and save a new version.",
  "chat.slash.emptyUnavailable":
    "No slash commands have been broadcast for the current OmpCode Agent session",
  "chat.quota.mcp.quotaExhausted":
    'OmpCode MCP "{server}" has used up today\'s quota. It resets tomorrow.',
  "chat.quota.mcp.codingPlanRequired":
    'No OmpCode MCP "{server}" quota. Sign in or get a Coding Plan to use it.',
  "resourceManager.appUsage": "OmpCode",
  "feedback.submit.template.section.copyErrorHeading": "OmpCode Error Info",
  "offPeak.keepAwakeBanner": "Keep your computer awake while OmpCode is running a chat.",
  "offPeak.form.instructionsPlaceholder":
    "Describe a task OmpCode can work on in the background, including the expected result and any constraints…",
  "chat.cuaReadiness.toolsNotLoaded":
    "OmpCode Computer Use is still preparing — its tools aren't loaded yet ({count} loaded). Grant the permissions below; tools appear once the helper is ready.",
  "chat.cuaReadiness.toolsPreparing":
    "OmpCode Computer Use is still preparing — its tools aren't loaded yet. Grant the permissions below; tools appear once the helper is ready.",
  "cuaPermission.modal.relaunchAppButton": "Restart OmpCode",
  "cuaPermission.modal.relaunchAppHint":
    "Still not working after restarting Helper? Restart OmpCode to fully reload the Helper process.",
  "cuaPermission.tools.untrustedRuntime":
    "Computer Use tools were found, but they did not come from the verified OmpCode plugin. Review the plugin installation, then check again.",
  "cuaPermission.ready.sessionValidationHint":
    "OmpCode will verify the Computer Use tools against the exact session when your first session starts.",
};

export default ompEnUSOverrides;
