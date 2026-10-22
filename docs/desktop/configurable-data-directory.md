# OmpCode 只读数据存储目录

## 所有者与解析规则

FORK-004 取代原有 ZCode 目录选择、复制及启动指针机制。OmpCode 应用根由启动环境唯一拥有：

- 默认根为 `~/.ompcode`。
- `OMP_CONFIG_ROOT` 去除首尾空白、展开 `~` 后为有效绝对路径时，应用根在该路径末尾追加 `_ompcode`。例如 `/data/omp-a` 对应 `/data/omp-a_ompcode`。
- 空值、相对路径或含 NUL 的无效路径回到默认根。`PI_CONFIG_DIR` 不参与应用根解析。
- 原始 OMP 环境不被派生应用根覆盖，OMP 自己继续解析其配置与 profile。
- `ZCODE_DATA_BASE_DIR` 和旧 `setting.json.dataBaseDir` 不再拥有路径；不读取、迁移、复制或修改 `~/.zcode`。
- 环境变更需完整退出并重启 Electron、Host 和 Agent 才生效。两根往返只读写各自已有文件，不向新根导入其他根的数据。

## 目录结构

```text
<applicationRoot>/
  v2/setting.json
  v2/credentials.json
  v2/logs/
  v2/tasks-index.sqlite
  v2/omp-scopes/<actual-root-profile-hash>/tasks-index.sqlite
  workspace/default/
  electron/<runtimeApplicationName>/
    session/
```

任务组织索引作用域必须来自实际运行 OMP 的配置根与 profile，不使用待重启选择。传入实际作用域后，索引路径由现有 paths 所有者派生；未绑定作用域的应用级索引维持独立应用根内的默认路径。
远端控制器持有的组织数据同时包含可信 Host authority；不同机器即使原生配置根与 profile 字符串一致也不能共享 SQLite 目录。省略 authority 或传入 `local` 时保持既有 `[configRoot, profileId]` 哈希；远端使用 `[authority, configRoot, profileId]`，authority 由连接注册表的 canonical remoteHostId 提供。


## 启动与事件顺序

```text
启动环境 → shared Node 根解析 → services 固定应用根
                                 ├→ Main settings / logs / credentials
                                 ├→ Electron userData / sessionData
                                 └→ Host 继承同一原始根环境 → 同一应用根
```

根在设置、日志和 Electron 存储 IO 之前确定。早期 bootstrap 不再读取磁盘上的旧设置，不存在设置覆盖环境的第二条写入路径。显式测试隔离的 Electron userData/sessionData 参数保留给 Chromedriver；不改变业务数据根。

## 只读接口

- 设置页面直接显示 `settingService.get().dataBaseDir` 返回的实际应用根，并说明 Windows/Linux 环境变量设置方式。
- 不提供选择目录、保存目录或数据迁移操作。
- `update({ dataBaseDir: ... })` 与 `updateDataBaseDir(...)` 均明确拒绝，不依赖 UI 禁用。
- `setDataBaseDir` 仅供测试 fixture 注入，生产调用拒绝；不作为启动或迁移路径。

## 回归入口

- `packages/desktop/test/desktopDataBaseDirBootstrap.test.ts`：隔离 HOME、有效/无效覆盖、PI_CONFIG_DIR 无关、原始 OMP 环境保留、两真实根往返、上游哨兵不变、旧设置不能重定向以及服务端拒写。
- `packages/services/test/settingService.test.ts`：现有设置持久化、并发与迁移规则继续在独立应用根运行。

上述为规范及测试入口，不代表这些检查已执行或通过。
