# GUI 与 omp 可执行技能对齐

## 产品规则

- 聊天输入的 `$` 候选、`/` 面板的 `skill:*` 候选，以及设置页的技能清单，均以目标工作区或会话 omp `get_available_commands` 中 `source=skill` 的命令为准。名称去掉 `skill:` 前缀；只显示 omp 当前可调用的技能。TUI 扩展控制中心包含禁用、遮蔽和仅供发现的条目，其总数不是可调用技能数。
- 选择技能后，发送给 omp 的文本使用原生 `/skill:<name>` token；聊天中的可见 chip 仍显示技能名。omp 支持位于用户句子中间的 token，技能正文与参数由 omp 处理，GUI 不扫描并注入另一份正文。
- 设置页不再展示 ZCode 本地扫描得到的技能、本地导入/删除/开关或插件技能；技能数量、搜索结果和作用域只反映当前目标工作区 omp 可调用目录。无工作区时不以用户本地目录冒充可用技能。
- 新草稿按目标工作区当前目录读取；已有会话按该会话 omp 进程读取。未知或不属于目标工作区的会话必须报错，不能回退到工作区目录。远端工作区只查询对应远端 Host。命令目录变化时清理或刷新相应缓存，不展示旧工作区的候选。

## 所有者和接口

```text
omp cwd / profile / source gates → omp 会话的技能快照
  → get_available_commands(source=skill)
  → omp-agent skills/referenceCatalog → Host service → GUI 设置及 $、/ 技能候选
  → /skill:<name> token → 同一 omp 会话执行
```

- omp 拥有技能发现、启用和调用状态；`omp-agent` 仅投影命令目录，不维护第二份扫描或开关状态。Host 保留现有 workspace identity 路由。GUI 草稿和会话目录按请求代次隔离，较早异步结果不得覆盖新目标。
- 目录查询失败时显示加载错误，不回退到本地扫描所得的伪运行时目录。桌面连续链路和手机恢复链路均沿用现有 Host service 请求；技能选择不修改 v4 消息序列。

## 验收

1. fake omp 返回内置、扩展和两个 `source=skill` 命令：GUI catalog 恰好含两个技能；错误名称、重复项不进入结果。
2. 工作区草稿和现有会话各取对应 omp 命令目录；未知会话报错，命令目录更新后再查询可见新值。
3. `$` 搜索显示与 omp 可执行技能目录一致的候选，选择后提交的 prompt 含原生 `/skill:<name>` token；不显示 `skills/referenceCatalog` 未支持错误。
4. 设置页仅显示目标工作区 omp 可用技能；数量与搜索结果均不含 ZCode 本地扫描项，作用域菜单不提供与 omp 无关的用户技能目录。
5. 真实 omp 与同一工作区 GUI 设置页及 `$`、`/` 技能候选的可执行技能名称集合一致；检查项目技能和用户技能各一个。桌面与 Web 均能读取各自目标工作区；远端不读取本机同名路径。
