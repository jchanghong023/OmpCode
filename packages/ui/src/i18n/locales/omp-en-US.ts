/** Fork-owned OmpCode terminology and controls; layered over the upstream locale. */
const ompEnUSOverrides: Record<string, string> = {
  "ompInteractions.viewOriginal": "View original",
  "ompInteractions.summary.result": "Result",
  "ompInteractions.summary.childResult": "Child result",
  "ompInteractions.summary.reportedMessages": "Reported sent",
  "ompInteractions.summary.messageCount": "{count} messages",
  "ompInteractions.summary.structuredCount": "Structured result · {count} fields",
  "ompInteractions.summary.structuredResult": "Structured result",
  "ompInteractions.summary.seconds": "{value}s",
  "ompInteractions.summary.milliseconds": "{value}ms",
  "ompInteractions.summary.minutes": "{value}min",
  "ompInteractions.summary.hours": "{value}h",
  "ompInteractions.status.completed": "Completed",
  "ompInteractions.status.aborted": "Aborted",
  "ompInteractions.sentTime": "Sent time",
  "ompInteractions.recordedTime": "Record time",
  "ompInteractions.title": "Agent interactions",
  "ompInteractions.description": "A read-only view of agents and their exchanges.",
  "ompInteractions.agentCount": "{count} agents",
  "ompInteractions.messageCount": "{count} interactions",
  "ompInteractions.history": "Interaction history",
  "ompInteractions.loading": "Loading interactions…",
  "ompInteractions.empty": "No interactions yet",
  "ompInteractions.emptyDescription":
    "Messages and task exchanges recorded by omp will appear here.",
  "ompInteractions.error": "Could not load interactions",
  "ompInteractions.retry": "Retry",
  "ompInteractions.refresh": "Refresh",
  "ompInteractions.loadMore": "Load more",
  "ompInteractions.loadingMore": "Loading more…",
  "ompInteractions.search": "Search messages or agents",
  "ompInteractions.allAgents": "All agents",
  "ompInteractions.graphLabel": "Directed agent interaction graph",
  "ompInteractions.unknownAgent": "Unknown agent",
  "ompInteractions.unknownTime": "Time unknown",
  "ompInteractions.mainAgent": "Main agent",
  "ompInteractions.user": "User",
  "ompInteractions.source": "Record source",
  "ompInteractions.source.live": "Live observation",
  "ompInteractions.source.history": "Saved history",
  "ompInteractions.source.live_and_history": "Live observation and saved history",
  "ompInteractions.sourceId": "Source record ID",
  "ompInteractions.unknownSourceId": "Source record ID unknown",
  "ompInteractions.selectedMessage": "Selected interaction",
  "ompInteractions.noMatches": "No matching interactions",
  "ompInteractions.coveragePartial": "Partial history",
  "ompInteractions.coverageComplete": "Complete available records",
  "ompInteractions.recordsRemaining": "Showing {loaded} of {count} records",
  "ompInteractions.kind.task_dispatch": "Task dispatched",
  "ompInteractions.kind.task_result": "Task result",
  "ompInteractions.kind.message": "Message",
  "ompInteractions.kind.user_intervention": "User intervention",
  "ompInteractions.delivery.injected": "Delivered",
  "ompInteractions.delivery.woken": "Agent awakened",
  "ompInteractions.delivery.revived": "Agent resumed",
  "ompInteractions.delivery.failed": "Delivery failed",
  "ompInteractions.delivery.observed": "Observed in a record",
  "ompInteractions.delivery.unknown": "Delivery unknown",
  "ompInteractions.replyTo": "Reply to {id}",
  "ompInteractions.selectMessage": "Select an interaction to view its full message.",
  "ompInteractions.status.running": "Running",
  "ompInteractions.status.waiting": "Waiting",
  "ompInteractions.status.blocked": "Blocked",
  "ompInteractions.status.success": "Completed",
  "ompInteractions.status.failed": "Failed",
  "ompInteractions.status.cancelled": "Cancelled",
  "ompInteractions.status.lost": "Unavailable",
  "ompInteractions.status.unknown": "Status unconfirmed",
  "ompInteractions.coverage.legacy_history_gaps":
    "omp does not persist every relayed message; some older exchanges may be unavailable.",
  "ompInteractions.coverage.record_unavailable": "Some source records could not be read.",
  "ompInteractions.coverage.missing_timestamp": "Some records have no message timestamp.",
  "ompInteractions.coverage.ambiguous_identity":
    "Some records do not identify both agents unambiguously.",
  "ompInteractions.coverage.read_budget_exceeded":
    "More source records exist beyond this read budget.",
  "ompInteractions.timeBasis.recorded": "Record time",
  "ompInteractions.timeBasis.sent": "Sent time",
  "ompInteractions.timeBasis.unknown": "Time unknown",
  "chat.error.ompAttachmentRejected": "Cannot send attachment to omp: {reason}",
  "chat.subagents.unavailable":
    "omp subagent status is unavailable; this session may have incomplete subagent records.",
  "settings.ompNative.extensions": "OMP Extensions",
  "settings.ompNative.hooks": "OMP Hooks",
  "settings.ompNative.hooksDescription":
    "Shows JS/TS hook files in hooks/pre and hooks/post for the current profile and local project.",
  "settings.ompNative.hooksRuntimeUnavailable":
    "These are discoverable files only; omp determines whether they loaded. Refresh this page and the session after changes.",
  "settings.ompNative.hooksReadFailed":
    "Could not read the hook directories. Check directory permissions.",
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
    "Set OMP_CONFIG_ROOT to choose the app data path; OmpCode appends _ompcode. Without it, the default path is used. Quit and restart after changes. Existing data is not copied automatically.",
  "settings.dataBaseDirEnvironmentWindows":
    'Windows example:\nsetx OMP_CONFIG_ROOT "D:\\omp"\nThen launch the app from a new terminal.',
  "settings.dataBaseDirEnvironmentLinux":
    "Linux example:\nexport OMP_CONFIG_ROOT=/path/omp\ntcsh: setenv OMP_CONFIG_ROOT /path/omp\nRestart the app from that terminal.",
  "settings.dataDirectory.runtimeRoot": "Current activity root",
  "settings.dataDirectory.persistentRoot": "Persistent backup root",
  "settings.dataDirectory.offlineWarning":
    "Offline data is active in temporary shared memory. Backups run asynchronously every 10 minutes, with no automatic recovery or final backup on exit. A restart, power loss, or external cleanup may lose changes since the last successful backup; this can exceed 10 minutes if backups fail. An empty activity root starts a fresh environment; restore manually when needed.",
  "offlineData.backupFailed":
    "Offline backup failed. Work continues in temporary shared memory, but changes since the last successful backup may be lost, possibly more than 10 minutes. Check permissions and available space at the persistent backup root shown in Settings.",
  "occupationOnboarding.modeDescription": "How would you like OmpCode to show its work?",
  "settings.ompModelRoles.configMissing": "No model config found for the current omp profile",
  "settings.ompModelRoles.configInvalid":
    "Invalid omp model config; check modelRoles in config.yml",
  "settings.ompModelRoles.catalogEmpty": "omp has not provided any models yet",
  "settings.ompModelRoles.title": "Model settings",
  "settings.ompModelRoles.description":
    "Configure models for omp roles. Existing config is backed up before saving.",
  "settings.ompModelRoles.unset": "Not configured",
  "settings.ompModelRoles.thinkingLevel": "thinking level",
  "settings.ompModelRoles.levelDefault": "Default level",
  "settings.ompModelRoles.platformUnsupported": "Opening omp model config is unsupported here",
  "settings.ompModelRoles.loadFailed": "Failed to load omp model config",
  "settings.ompModelRoles.saved": "Saved (previous config backed up automatically)",
  "settings.ompModelRoles.created": "Saved",
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
  "chat.ompStatus.enabled": "On",
  "chat.ompStatus.disabled": "Off",
  "chat.ompStatus.context": "Context usage",
  "chat.ompStatus.compact": "Compact context",
  "chat.ompStatus.autoCompact": "Auto compact",
  "chat.ompStatus.autoFailed": "Could not change auto compact",
  "settings.computerUse.disabledToast":
    "Computer Use is disabled. Existing conversations require a OmpCode restart to take effect.",
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
  "ompSubagentControl.send": "Send",
  "ompSubagentControl.stop": "Stop",
  "ompSubagentControl.sendPlaceholder": "Send a message to this subagent…",
  "ompSubagentControl.status": "Result",
  "ompSubagentControl.failed": "Failed",
  "ompModelRoles.fromAgent":
    "Full role catalog from the OMP runtime (unconfigured roles included); saving is automatic on selection.",
  "ompModelRoles.loadUnavailable":
    "OMP role catalog is temporarily unavailable: the project process may be starting or unavailable",
  "ompModelRoles.saveFailed": "Save failed",
  "ompModelRoles.saving": "Saving…",
  "ompModelRoles.saved": "Saved",
  "ompModelRoles.notConfigured": "Not configured",
  "ompModelRoles.overridden": "User config saved but currently overridden by another source",
  "ompModelRoles.autoOption": "Auto",
  "ompNativeTools.open": "Native tools",
  "ompNativeTools.title": "OMP native tools",
  "ompNativeTools.description":
    "Inspect the current workspace catalog. Actions are submitted to this conversation. Acceptance does not mean completion; output and follow-up questions appear in the conversation.",
  "ompNativeTools.projectIndex": "Knowledge & code indexes",
  "ompNativeTools.orchestration": "Orchestration shortcuts",
  "ompNativeTools.workspace": "Workspace",
  "ompNativeTools.session": "Conversation",
  "ompNativeTools.draft": "New conversation (keeps your draft)",
  "ompNativeTools.catalogScope":
    "This catalog comes from the workspace runtime; the target conversation validates execution again.",
  "ompNativeTools.blocked.running":
    "This conversation is running. You can browse but cannot execute actions.",
  "ompNativeTools.blocked.interaction":
    "Complete the native question in the conversation before executing an action.",
  "ompNativeTools.blocked.choice":
    "Conversation input is waiting for a choice. You can browse but cannot execute actions.",
  "ompNativeTools.blocked.unavailable":
    "Submission is unavailable. Select a model or wait for the connection to recover.",
  "ompNativeTools.blocked.submitting":
    "An action is being submitted. Please do not submit it again.",
  "offlineBackup.title": "Runtime & Backups",
  "offlineBackup.description":
    "Read-only runtime and backup state from this device’s application Main process. This does not restrict network access or use the current remote Host’s directories.",
  "offlineBackup.refresh": "Refresh state",
  "offlineBackup.refreshHint":
    "Reads in-memory state only; does not back up, restore, or scan directories.",
  "offlineBackup.loading": "Reading runtime state…",
  "offlineBackup.unavailable":
    "Runtime and backup state is unavailable on this platform. Web cannot read this device’s Main process state.",
  "offlineBackup.error":
    "Could not read or subscribe to runtime state. Refresh to retry; this does not mean a backup failed.",
  "offlineBackup.localRuntime": "Local runtime",
  "offlineBackup.backupState": "Backup state",
  "offlineBackup.offline": "Offline runtime mode",
  "offlineBackup.offlineEnabled": "Linux shared-memory runtime and persistent backups enabled",
  "offlineBackup.offlineDisabled": "Shared-memory offline runtime not enabled",
  "offlineBackup.activeProfile": "Active runtime profile",
  "offlineBackup.runtimeRoot": "Runtime root",
  "offlineBackup.persistentRoot": "Persistent root",
  "offlineBackup.phase": "Current phase",
  "offlineBackup.period": "Backup period",
  "offlineBackup.periodValue": "{milliseconds} ms",
  "offlineBackup.lastAttemptAt": "Last attempt",
  "offlineBackup.lastSuccessfulAt": "Last successful backup",
  "offlineBackup.nextScheduledAt": "Next scheduled trigger",
  "offlineBackup.code": "Status code",
  "offlineBackup.revision": "State revision",
  "offlineBackup.noRecord": "No record in this run",
  "offlineBackup.noNextScheduled": "No trigger currently scheduled",
  "offlineBackup.noCode": "No status code",
  "offlineBackup.nextHint":
    "The next time is a scheduled trigger, not a guarantee of backup completion; a busy attempt may be skipped.",
  "offlineBackup.risk":
    "Runtime data in shared memory may be lost after exit, a crash, or a restart. Only completed successful backups count as persisted records. This page does not offer manual backup, restore, or path editing.",
  "offlineBackup.phase.disabled": "Disabled",
  "offlineBackup.phase.waiting": "Waiting",
  "offlineBackup.phase.running": "Running",
  "offlineBackup.phase.completed": "Completed",
  "offlineBackup.phase.busy": "Busy — skipped",
  "offlineBackup.phase.failed": "Failed",
  "offlineBackup.phaseDescription.disabled":
    "Shared-memory backups are disabled for this run; non-offline runtimes, including Windows, can normally report this state.",
  "offlineBackup.phaseDescription.waiting":
    "Waiting for a scheduled trigger; this does not imply a successful backup exists.",
  "offlineBackup.phaseDescription.running":
    "This process is backing up; the attempt has not completed.",
  "offlineBackup.phaseDescription.completed": "The latest backup attempt completed.",
  "offlineBackup.phaseDescription.busy":
    "The latest trigger was skipped because backups were busy; the last successful time is unchanged.",
  "offlineBackup.phaseDescription.failed": "The latest backup attempt failed; see the status code.",
  "ompProjectIndex.title": "Project Knowledge & Code Indexes",
  "ompProjectIndex.description":
    "Open native index dashboards exposed by the current command catalog, or query the code index through the current session model.",
  "ompProjectIndex.catalogNotice":
    "Availability comes from the current workspace command catalog, not index existence, readiness, or session-process support. The target session is checked again on submission.",
  "ompProjectIndex.wiki.title": "Knowledge Wiki",
  "ompProjectIndex.wiki.description":
    "List or create knowledge indexes, Search / Grep / paginate, or delete them in the native conversation. In-place updates and rebuilds are not supported.",
  "ompProjectIndex.repo.title": "Code Index Repo",
  "ompProjectIndex.repo.description":
    "View status, build, update, rebuild, or delete code indexes in the native conversation. This dashboard provides no direct search RPC.",
  "ompProjectIndex.dashboardNotice":
    "These buttons only open bare-command dashboards. Further operations, progress, and destructive-action confirmations continue in the original conversation.",
  "ompProjectIndex.available": "Command exposed by catalog",
  "ompProjectIndex.unavailable":
    "The catalog does not expose this command. Capability is missing or not ready; no ordinary-prompt fallback is used.",
  "ompProjectIndex.openWiki": "Open /wiki dashboard",
  "ompProjectIndex.openRepo": "Open /repo dashboard",
  "ompProjectIndex.preview": "Full submission preview",
  "ompProjectIndex.search.title": "Search Code Through Model",
  "ompProjectIndex.search.description":
    "Use the repo tool through the current session model for a read-only query. This invokes the model and incurs model usage; results return to the original conversation. This is not a model-free search RPC.",
  "ompProjectIndex.search.query": "Code search query",
  "ompProjectIndex.search.placeholder": "Enter a query for the existing code index",
  "ompProjectIndex.search.readOnly":
    "Requests only a query against an existing index, not creation, update, rebuild, or deletion. The original query is JSON-encoded, not executed as slash-command arguments.",
  "ompProjectIndex.search.submit": "Use repo tool through current session model",
  "ompProjectIndex.search.empty": "Enter a non-empty search query.",
  "ompProjectIndex.search.previewEmpty": "Enter a query to preview the complete model request.",
  "ompProjectIndex.executionUnavailable":
    "Submission is unavailable in this session. Resolve running work, pending interactions, or input routing first.",
  "ompProjectIndex.executionBlocked":
    "The request was not submitted: the session is unavailable or target capabilities changed. Check the conversation notice.",
  "ompProjectIndex.confirmationRequired":
    "The request has not been submitted. Complete the confirmation in the original conversation first.",
  "ompProjectIndex.executionFailed":
    "Submission failed. Review the error in the conversation before retrying.",
  "ompOrchestration.title": "Native orchestration",
  "ompOrchestration.description":
    "Parameters generate native commands; output, questions, and actual state remain in the conversation.",
  "ompOrchestration.command": "Command",
  "ompOrchestration.missing":
    "Not provided by the current catalog: {commands}. No plain-prompt fallback.",
  "ompOrchestration.noCapabilities": "No orchestration commands are available in this workspace.",
  "ompOrchestration.goalHelp":
    "Goal manages the current session’s persistent objective; this panel does not infer its state.",
  "ompOrchestration.goalAction": "Goal action",
  "ompOrchestration.goalSet": "Set objective",
  "ompOrchestration.goalShow": "Show goal",
  "ompOrchestration.goalPause": "Pause goal",
  "ompOrchestration.goalResume": "Resume goal",
  "ompOrchestration.goalDrop": "Drop goal",
  "ompOrchestration.goalBudget": "Adjust budget",
  "ompOrchestration.objective": "Objective",
  "ompOrchestration.budget": "Token budget (positive integer or off)",
  "ompOrchestration.loopAction": "Loop action",
  "ompOrchestration.loopStart": "Start bounded loop",
  "ompOrchestration.loopStop": "Bare /loop (disable or toggle)",
  "ompOrchestration.loopKind": "Limit type",
  "ompOrchestration.loopCount": "Count",
  "ompOrchestration.loopDuration": "Duration",
  "ompOrchestration.loopLimit": "Loop limit",
  "ompOrchestration.loopInterval": "Interval (optional, e.g. 30s, 1m30s)",
  "ompOrchestration.loopHelp":
    "With an interval, count includes the initial turn; without one, the initial turn may be followed by at most N repeats. Duration limits are enforced by the native runtime. Conversation Stop can pause the loop; there are no /loop pause or resume subcommands.",
  "ompOrchestration.teamHelp": "/team performs read-only planning, not implementation.",
  "ompOrchestration.magicHelp":
    "This command accepts task text only; no invented concurrency setting or workflow state.",
  "ompOrchestration.task": "Task",
  "ompOrchestration.preview": "Full command preview",
  "ompOrchestration.previewEmpty": "Fill in the required parameters to generate a command.",
  "ompOrchestration.confirmDrop":
    "I confirm removing the current goal record; accumulated usage remains in the session log.",
  "ompOrchestration.confirmLoop":
    "I confirm sending bare /loop; the native session disables or toggles the loop according to its current state.",
  "ompOrchestration.execute": "Execute in current conversation",
  "ompOrchestration.submitting": "Submitting…",
  "ompOrchestration.blocked":
    "This conversation cannot accept the command now; check its blocking state.",
  "ompOrchestration.confirmationRequired":
    "Not sent: complete the required confirmation in the conversation.",
  "ompOrchestration.failed": "Submission failed; see the error in the conversation.",
  "ompOrchestration.sent":
    "Submission accepted; see the original conversation for execution results.",
  "ompOrchestration.invalid.required": "Enter the objective or task.",
  "ompOrchestration.invalid.budget": "Budget must be a positive safe integer (digits only) or off.",
  "ompOrchestration.invalid.count": "Count must be a positive safe integer (digits only).",
  "ompOrchestration.invalid.duration":
    "Use positive integer seconds, minutes, or hours, e.g. 30s, 10 minutes, or 1h30m; each segment must be positive.",
  "ompOrchestration.invalid.interval":
    "Interval must be a compact duration (e.g. 30s, 1m30s), at most 2147483647 milliseconds.",
  "ompOrchestration.invalid.loopTask":
    "The task prefix would be parsed as a limit, interval, or condition flag; start with ordinary text.",
};

export default ompEnUSOverrides;
