# 任务分组

控制端 Host 独占写入跨 workspace 分组组织态，复用 tasks-index 的旧分组表。
CLI 和远端项目服务不接收 Group。结构读取无副作用，任务内容来自现有 Host 树。

move 是单节点相对位置命令：来源和目标锚点在事务中复检，不以可见快照覆盖全库。
所有引用按 canonical workspace identity 与 taskId 隔离，服务校验 Host 身份和任务事实。
远端离线不删成员，不通过分组服务建立连接。取消组保留全部任务及成员顺序。

组织态以实际原生 runtime 确认的 OMP configRoot 与 activeProfile 为存储域，同一域允许跨 workspace 分组。
Host 只管理该域的既有 SQLite owner，不以 Host 进程环境或下次启动的 selectedProfile 选库。
列表聚合当前各 workspace 的实际域；创建分组必须指定 workspace 执行域，移动不得跨域。
切换 profile 不搬移、不清空旧域；切回后 UUID、成员、相对排序和任务置顶/归档/未读原样保留。

公开接口 `read(targets)` 按真实 SQLite owner 去重，返回 `{ storageScope, target, targets, groups, members, order }[]`；
每个元素保持独立执行域（默认系统组 ID 在不同域可相同），不改写持久化 ID 或合并排序。
`save({target,...})`、`ungroup({target,id})`、`move({target,...})` 必须显式提供 workspace target。
target 包含 workspacePath、可选 workspaceIdentity/remoteSessionId；读取、任务、锚点均通过同一 resolver 解析。
未知执行域、错误组 ID、跨域任务或锚点均明确失败，不落回旧库；admit 按任务实际域拆分登记。
`storageScope` 来自与 SQLite 绑定的原生实际 root/profile，不随代表 workspace 改变；
factory 的 `database(target)` 一次返回 `{ database, storageScope }`，不得分别读取偏好构造 scope。
`target` 是首个代表 workspace，`targets` 是本次读取中经真实数据库 owner 确认的全部所属 workspace；
UI 使用这份服务端成员关系判定域，不根据跨 Host 可能相同的路径或 scope 文本猜测。

```text
workspace target → 原生实际 root/profile → tasks-index SQLite owner → 事务 → 广播
read(active targets) → 同 owner 去重 → 各域独立结构（不读取非 active 域）
```

admit 只登记首次出现或首次系统类型标记；独立加法表记录是否已被用户整理和创建 receipt，
防止重复刷新覆盖手动移出或迟到创建回包覆盖后续整理。登记状态不复制会话事实。
所有写入提交后广播 state:task-groups；失败不广播，客户端沿用已接受结构并刷新。

规格：docs/ui/task-grouped-view.md。桌面 continuous 与手机 replayable 复用同一组织 owner。
