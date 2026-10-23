# Fork 需求文档

## 1. 文档定位

本文件是本 Fork 的需求入口，用于记录相对 ZCode 上游新增或调整的产品需求、行为边界和验收标准。上游已有能力继续以当前源码及对应需求文档为准，不在本文件重复定义。

## 2. 重新开始 Fork 的背景与决策

- `main` 分支基于老版本 Fork 改造，累计改动过大，已经不好管理。
- 因此，决定完全从头开始：以上游 ZCode 为起点重新进行 Fork 改造，不再以旧版 `main` 的改造结果作为新的开发起点。
- 新一轮 Fork 的第一步是先把测试跑通，建立基线，再开展后续改造。

## 3. 上游源码起点

以下信息记录于 2026-10-21，仅表示文档创建时的状态，不代表后续始终与上游同步。

| 项目         | 基线                                       |
| ------------ | ------------------------------------------ |
| Fork 仓库    | <https://github.com/jchanghong023/OmpCode> |
| 上游仓库     | <https://github.com/zai-org/ZCode>         |
| 当前开发分支 | `dev`                                      |
| 上游对比分支 | `upstream/main`                            |
| 初始化提交   | `3c5b2276`（`chore: sync ZCode source`）   |

创建文档前，本地 `dev` 与 `upstream/main` 指向同一提交，无代码差异；本地 `dev` 相对 `origin/dev` 领先 3 个提交。

上述记录仅说明源码起点，不代表测试已经跑通或测试基线已经建立。

## 4. FORK-001：先跑通测试，建立基线

### 目标

在从上游重新开始的代码上，先把测试跑通，建立后续 Fork 改造可对照、可复现的测试基线。

### 范围与边界

- 先确认当前仓库实际提供的测试入口及其运行条件，再执行测试并处理失败，直到测试跑通。
- 基线建立前，不开展后续功能改造；本阶段修改应限于让测试跑通所必需的问题。
- 不通过跳过失败测试、删除有效测试或放宽断言来制造通过结果。
- 记录基线对应的提交、运行环境、测试命令和实际结果，便于后续改造比较。
- 测试或环境受阻时，如实记录阻塞及未验证范围，不得将其记为基线已通过。
- 具体模块的行为和边界继续以对应需求文档为准，参见 [specs](specs/) 和 [docs](docs/)。

### 本轮执行范围：UT

- 按本轮要求，先执行根目录 `pnpm test:unit`，使用现有 Vitest 配置和测试范围，不额外缩小测试选择。
- 本轮不运行桌面 E2E，也不将根 UT 结果当作 CLI 独立测试或跨平台验证结果。
- 仅处理直接阻塞 UT 的依赖、环境和代码问题，通过后记录 UT 基线。

### 验收标准

1. 明确并记录测试入口、运行条件和执行命令。
2. 测试实际运行通过，失败项得到解决，不将未执行或受阻的测试标为通过。
3. 记录可复现的基线提交、运行环境及测试结果。
4. 在此基线上开展后续 Fork 改造，能够识别改造引入的测试回归。

### 当前状态

本轮根目录全量 UT 已通过，Windows UT 基线已建立。范围仅限本轮要求的根 UT，
不代表 CLI 独立测试、桌面 E2E 或其他平台已经验收；架构门禁仍有下述未通过项。

### UT 环境与复现步骤（2026-10-21）

- 源码起点：`3c5b2276`；UT 验收对象为本轮修复后的源码，随本文一同提交。
- 运行环境：Windows x64，Node `24.14.0`，pnpm `10.33.2`，实际测试运行器 Vitest `4.1.4`。
- 本机默认 Node 为 `24.20.0` 且未安装 mise，以下命令通过 pnpm 临时选择仓库声明的 Node 版本，不修改全局 Node。
- 最终全量沿用默认并发：普通 UT 最多 4 个 worker，`fork-isolated` 组单文件串行、最多 1 个 worker。

```bash
pnpm --config.use-node-version=24.14.0 install --frozen-lockfile
pnpm --config.use-node-version=24.14.0 typecheck
pnpm --config.use-node-version=24.14.0 --filter @zcode/adapters... build
pnpm --config.use-node-version=24.14.0 test:unit
```

准备步骤不可省略：首次执行时尚无依赖；安装后，部分 UT 还需要 `@zcode/e2e-report` 和
`@zcode/adapters/storage` 的包构建产物。根类型检查生成前者所需的 Node 产物，后者通过其现有依赖构建入口准备。

### UT 执行结果

| 全量轮次       | 通过文件 | 失败文件 | 通过用例 | 失败用例 | 跳过用例 | 耗时（秒） |
| -------------- | -------- | -------- | -------- | -------- | -------- | ---------- |
| 首轮基线调查   | 2031     | 17       | 19818    | 25       | 73       | 567.32     |
| 主要修复后     | 2047     | 1        | 19847    | 1        | 79       | 606.64     |
| 真实 IO 隔离后 | 2047     | 1        | 19843    | 5        | 79       | 915.28     |
| 最终验收       | 2048     | 0        | 19848    | 0        | 79       | 544.81     |

各轮均有 4 个测试文件按现有平台条件跳过。首轮存在收集失败的文件，补齐构建产物后恢复收集，
因此用例总数不同；权限用例修复了原定跳过条件的注册方式，不是删除失败用例。
最终全量命令退出码为 0；不将此前失败轮次或跳过项记为通过。

### 其他检查与证据边界

- `pnpm typecheck` 已实际执行通过。
- `pnpm lint` 已实际执行通过，保留 96 个警告、0 个错误；后续修改的测试和配置文件另经定向 lint 通过。
- 独立 smoke 使用实际源码生成远端安装脚本，经真实 Git Bash stdin 执行，完成安装并核对目标文件内容；临时夹具已删除。
- `pnpm architecture:check --changed` 未通过：本轮修改前已有 18 项 `unmanaged-new-file`；
  同步预加载调用方后，既有 `packages/desktop/wdio.conf.ts` 额外触发 1 项未登记规则，最终共 19 项。
  本轮不调整架构策略或扩大为模块治理改造，不能据此宣称所有质量门禁全绿。

### 本轮直接修复

- 远端组件安装器：锁心跳及其后代隔离标准 IO，避免前台命令退出后仍被后台 `sleep` 持有管道；
  Git Bash 测试后端通过 stdin 传递完整脚本，避免 Windows `-c` 参数破坏嵌套引号。
- 路径与 URL 夹具：使用当前 Host 的原生路径和合法 file URL，保留路径归一化、锚点剥离和非法 URL 拒绝验证。
- 子进程夹具：预加载入口统一使用 `file:` URL；Windows 管道存活场景显式分离后代进程，保留原超时和行为断言。
- 编码边界：PowerShell 测试明确输出 UTF-8；NSIS 编译与 electron-builder 一致，显式指定输入 UTF-8。
- 文件系统权限：Windows 用无需提权的 junction 验证拒绝链接边界；
  POSIX 权限用例改用正确的注册期跳过 API，保留原有 Windows/root 限制，不新增跳过条件。
- 真实并发 IO：固定随包配置的并发读取与 30 轮原子替换移入现有串行隔离组，
  保留文件内部并发、完整版本断言及原有重试预算。
- Manager 生命周期：仅验证 admission、重试、所有权或异常转发的 Agent 夹具按真实 stdin EOF 协议退出；
  protocol-close 场景改由实际通知触发非法帧，不再用固定启动延迟猜测时序。
  强制回收及后代进程覆盖仍保留在既有进程树测试中，未修改生产清理预算或身份校验。

远端安装器的管道所有权与事件顺序见[部署规范](docs/remote/zcode-agent-remote-deployment.md#retained-component-installer-failure-contract)。

### 后续验证节奏

- 修复期间定向执行失败文件或相关 UT，不因单个局部修复反复运行全量。
- 建立基线时执行一次最终全量 UT，不能以局部通过或 affected 的成功退出替代全量结果。
- 日常改造使用现有 `pnpm test:unit:affected` 选择受影响测试；这不是已通过结果缓存。
- `pnpm test:unit` 执行当前根配置启用的 UT；下述临时白名单生效期间不再代表原完整根 UT。模块转换缓存不代表可以跳过测试执行。
- affected 若选中整个套件，现有入口会说明并跳过，退出码 0 不代表全量 UT 通过，详见[选测规范](docs/testing/pre-push-hook.md#affected-unit-tests)。
- 可用 `pnpm test:unit --maxWorkers=2` 指定 worker 上限，或加 `--no-file-parallelism` 将测试文件串行执行；
  本轮最终全量没有使用这些覆盖参数。

## 5. FORK-002：移除推送时的自动架构门禁

### 目标

正常推送不再因架构合规扫描失败而被阻断，无需每次使用 `--no-verify` 绕过整个 pre-push 钩子。

### 范围与规则

- 从根 `verify:pre-push` 执行链删除 `pnpm run architecture:check -- --changed`。
- 保留 Lint、SQLite schema 兼容检查、架构规则自身的单测及 push 范围的受影响 UT；这些检查失败时仍阻止推送。
- `.husky/pre-push` 继续作为唯一推送钩子，保留 push ref 传递和 Git local env 清理，不新增旁路脚本或吞错分支。
- 手动 `pnpm architecture:check --changed`、架构策略及模块边界规则保持不变；移除推送阻断不等于架构违规已修复。
- 同步维护命令说明，不扩大为运行时代码或架构模块治理改造。

### 验收标准

1. 使用正常 `git push origin dev:dev`，不设置跳过钩子的参数或环境变量。
2. 实际钩子执行保留的检查，不再调用架构合规扫描。
3. 保留检查通过后推送成功，远端 `dev` 更新到本次提交。

## 6. FORK-003：通过 OMP app-server 替换 Agent 核心

### 目标与权威边界

OMP 是用户必须预先独立安装的外部运行依赖，不随 OmpCode 分发。OmpCode 的安装包、ZIP 及其他发行归档均不得携带 OMP 可执行文件或其私有运行时资产。启动时优先使用 `ZCODE_AGENT_SERVER_COMMAND` 显式指定的程序；未设置时直接调用当前终端继承环境中可执行的 `omp`，由操作系统按 PATH 解析。开发态与打包态、Windows／Linux／macOS 规则一致，不扫描安装目录，不维护发现缓存，不表示 OmpCode 内置 OMP。

- 外部协议及既有产品合同以本仓库的 [ZCode Protocol](docs/zcode-protocol.md)、对应 spec 和固定兼容提交中的公开 schema 为准，不通过大改协议迁就 OMP，也不把 OMP 当作原 Agent 的 Model provider。
- OMP 入口、独立协议目录、与 AgentSession 同进程的业务 API 调用、存储准备生产端及功能／权限合同由 `F:/code2026/oh-my-pi/docs-zh-CN/requirements/rpc-ui-protocol.md` 维护；本节只维护 ZCode 侧启动消费、发行装配、宿主边界和源码保留。下文时序图是引用，不在本仓库另立一份 OMP 合同。
- 本仓库的接入逻辑集中在启动、初始化、打包、远端分发和必要的能力展示；协议适配由 OMP 负责，不散落到 UI、Host 或原 Agent 核心中。不得为迁就 OMP 改变既有问答字段、命令准入及 CAS 刷新路径，也不在 ZCode 回放夹具中建立第二套协议翻译层或改写原有行为断言。
- 在 OMP 全力适配后仍无法实现的功能，ZCode 原有 UI 页面、入口和控件也不能删除或隐藏；保留可见并明确显示真实不可用原因，可禁用或在点击时返回明确不支持，不伪造可用性，不自动回退旧 Agent。
- [OMP 需求在线入口（浮动 main）](https://github.com/jchanghong023/oh-my-pi/blob/main/docs-zh-CN/requirements/rpc-ui-protocol.md) 仅用于发布导航，不能证明已包含本地确认的合同。未取得双方真实需求发布提交前，以各仓本地需求文件为准；发布时分别记录实际提交并更新引用，不虚构 SHA，也不把固定协议源码提交当作新需求已发布的证据。

### 启动选择与发行装配

- `ZCODE_AGENT_SERVER_COMMAND` 选择可执行程序，不自动转换协议。默认调用 `omp app-server --stdio`，桌面追加 `--surface desktop`；OMP 入口与桌面呈现的具体行为引用 OMP 需求，不在此重复定义。直接运行 `omp` 仍是 OMP 原生 TUI。
- 显式非空 `ZCODE_AGENT_SERVER_COMMAND` 具有最高优先级，显式空值报错。未设置该变量时默认命令就是 `omp`，复用当前终端继承的 PATH 与既有进程启动机制；不自行遍历 PATH、扫描安装目录或预先探测候选可执行文件，也不维护异步发现及缓存。显式配置错误或实际启动失败时直接报错，不回退到 PATH 中另一个 OMP、随包副本或原 Agent。入口注入统一位于 `packages/desktop/src/main/desktopRuntimeEnv.ts`，不下载／安装工具，不写系统环境变量，不修改用户 PATH、shell 配置或 OMP 偏好。
- `ZCODE_AGENT_SERVER_ARGS_JSON`、`ZCODE_AGENT_SERVER_CWD` 独立覆盖默认值，不因自动发现命令而被改写；覆盖后仍须满足同一 app-server、stdio、surface、cwd 和 profile 合同，不能因参数被清空而启动 TUI。准备与正常运行使用同一已解析产物、有效参数、profile 和执行环境。
- 源码联调可将命令设为 Bun 绝对路径，参数设为 `["run","<OMP 仓库绝对路径>/packages/coding-agent/src/cli.ts","app-server","--stdio","--surface","desktop"]`；仍由 Host 注入实际 workspace 的 cwd，不将 `ZCODE_AGENT_SERVER_CWD` 改成 OMP 源码仓库。该路径直接加载当前源码，无需反复编译 exe；已有 OMP 源码依赖及本机 native addon 仍是前提，不将其结果冒充打包产物验收。
- 选定 OMP 后，文件不可用、版本或协议不兼容、参数错误、初始化或启动失败必须明确报错，提示用户先安装或更新兼容 OMP；保留诊断信息。不自动下载、安装、升级或替换用户的 OMP，不回退原 Agent、源码运行器或随包副本；不新增通用多 runtime 注册框架或长期双 Agent 设置开关。
- 本地和远端分别要求用户预先安装各自执行端所需的 OMP，并在该执行环境设置命令或 PATH；本地安装／变量不代表 SSH、WSL 或 Docker 已具备 OMP。OmpCode 的远端归档同样不携带 OMP，既有远端 Host／Server 的安装、更新及网络策略不因此扩展为 OMP 安装器，不借本机 OMP 执行远端任务。
- OmpCode 构建、准备资产、安装、更新与发行装配不得从 `ZCODE_OMP_ARTIFACT_ROOT` 或其他来源复制 OMP，不生成 `bundled-agents/<target>/omp`、`resources/omp`、`runtime/omp` 等内置运行副本，也不把 OMP 装入桌面安装包、ZIP 或远端 runtime archive。原先要求校验 OMP manifest 后随包装配、签名豁免或自动分发的合同取消；OMP 自身的独立发行与完整性校验仍由 OMP 项目维护。
- Desktop 和 Source Server 仅解析、验证并启动外部 OMP。准备与正常运行复用同一实际命令、参数、执行环境和 profile；现有存储准备、协议初始化及能力校验负责判断兼容性，不要求用户安装目录具备 OmpCode 私有的随包 manifest。不得因发现到一个可执行文件就伪报兼容成功；不可用时明确阻断并说明原因。原 Agent 源码、Node runtime 与既有 TUI bundle 的保留不构成备用 Agent。
- 验收须覆盖显式环境变量优先于 PATH、未配置时使用终端 PATH、完全未安装、错误显式路径及不兼容 OMP；显式配置失败不得回退，未安装／不兼容时不自动修补依赖，也不启动备用 Agent。实际检查桌面安装包、ZIP 与远端发行归档均不包含 OMP 及其私有运行资产；不以源码联调或清空某个资源目录代替发行产物验收。需求更新本身不代表现有装配实现已完成迁移。

### 存储启动消费与监督

- Host 的 tasks-index 准备继续由现有 Node Worker 执行；原配套 Node CLI 的准备路径保留。选中外部 OMP 时，`packages/desktop/src/host/database-startup/storagePreparationProcesses.ts` 必须通过子进程 spawn 执行同一 OMP 的 `app-server --stdio --prepare-storage --cwd <绝对路径>`，不得将 Bun 二进制作为 Node Worker 脚本，也不得因缺少原 Worker entry 跳过准备。
- OMP 准备进程的参数、帧形状、写入边界和退出行为以 OMP 需求“存储准备生产端合同”为准，wire 类型复用 ZCode 公开 schema。Host 负责校验帧、真实路径观测及确认、同轮成功资源的 reuse 判定、取消、时限和自有进程回收，不直接操作 OMP journal。
- 只有收到合法的路径与准备完成事实、进程退出码为 0 且无失败时，Host 才允许启动业务服务。非法帧、提前 EOF、超时、取消、失败状态或非零退出均阻断启动，保留原始错误；不能用 no-op 或放宽时限制造成功。
- 正常 app-server 仍受启动状态门约束，必要初始化 ready 前不发送执行命令；其 attempt、sequence 与终态按公开合同校验。准备成功不等于模型／认证已可用，模型执行保留独立就绪检查。

### 宿主所有权与事件顺序

- 每个 window-scoped Host 的每个 workspaceKey 最多一个 app-server，其内由同进程 AgentSession 托管多个主会话，不另起会话 RPC 宿主。两个窗口可各有 app-server；持久会话租约仍跨进程约束，不能同时写同一 OMP 会话。独立短生命周期存储准备进程不属于会话执行架构。
- Window Host 拥有可信连接路由、attachment、进程监督及 tasks-index 组织元数据；UI 只拥有草稿与展示态。OMP 正文／队列与 app-server 投影的所有权、`session/list` 与 `sessions-index` 的字段归属均引用 OMP 需求，不在 Host／Main／relay 重建事实。
- 身份路由沿用 `workspaceIdentity?.trim() || workspacePath`，路径仅用于执行和展示，远端保留 `remoteSessionId`；Host 负责 `desktop-continuous` 与 `web-remote-replayable` attachment 隔离，手机只 attach 已有运行时。

```mermaid
sequenceDiagram
    participant M as Desktop Main（环境装配）
    participant H as Window Host（监督与组织态）
    participant P as OMP 准备子进程
    participant B as OMP app-server（协议投影）
    participant R as AgentSession（同进程执行事实）
    participant U as 桌面或手机 attachment
    M->>H: 注入已解析的 OMP 产物和环境
    H->>H: 现有 Worker 准备 tasks-index
    H->>P: spawn 同一产物的 prepare-storage 入口
    P-->>H: startup/storagePath
    H->>P: 观测真实路径后 storagePathReady
    P->>P: 准备真实存储并关闭准备资源
    P-->>H: startup/storagePrepared
    H->>P: 关闭准备通道 stdin
    P-->>H: exit 0
    Note over H,P: 任一失败或取消均阻断业务启动
    H->>B: 每个 Host 的 workspaceKey 启动一次
    B-->>H: startup/storageState ready
    Note over B,R: 同一进程，直接业务 API，无内部 RPC
    U->>H: hello/clientHello 与用户意图
    H->>B: 注入可信连接上下文并转发命令
    B->>R: 直接调用目标会话的业务 API
    R-->>B: 接纳结果与事件回调
    B-->>H: command ACK 与权威 projection
    H-->>U: 按所属 attachment 投递
```

### 源码保留与持续合并

- 尽量保留 `apps/zcode-cli/` 及原 runtime、工具和配套源码，继续合并 ZCode 上游；不为更换核心批量删除、搬迁或重写上游实现。迁移初期“不整体回灌旧 main”指向当时的旧产品实现，不禁止此次明确将新 main 合入 dev-centos7；本次产品功能以 main 为准。
- Fork 产品通过装配替换运行入口。源码保留不等于长期暴露两个 Agent；清理限于 Fork 自有临时开关和重复适配，不以删除上游源码实现切换。
- OmpCode 依赖用户预先独立安装的兼容 OMP，不跨仓深路径引用私有实现。发行说明记录兼容的 OMP 版本／提交范围、ZCode 协议基线与实际能力，但不把固定 OMP 发行物嵌入 OmpCode；schema 校验不替代行为联调。
- 合并上游、升级目标发行或修改协议、Host、启动、UI 消费链时，必须执行 OMP 需求中约定的兼容评估；只有目标合同变化才重钉基线并适配／验证，纯注释或排版变化不机械触发重钉。

### OMP 模型配置 GUI 与可选协议扩展

- `session/configure` 是向后兼容的可选公开方法；仅支持显式 `sessionId` 与 `operation`：`get_model_roles`、`set_model_role`、`get_team_config`、`get_team_models`、`set_team_config`。参数由对应严格 schema 校验，成功返回 `{operation,data}`，失败使用数值协议错误及结构化 `data`（保留保存回执）。不封装或调用内部 RPC；服务器直接调用所属会话的共享配置服务。
- 服务能力通过 `get_team_config` 的明确方法发现读取；旧 Agent 的 `-32601` 禁用此专用入口并说明原因，不回读文件、不假称支持。OMP 必须实现全部操作，不能以能力发现缩小交付。
- GUI 复用公开 `IZCodeAgentService` 与 hook，不使用 `window.zcode`。主模型临时切换使用既有会话模型命令，不持久化默认值；role 编辑展示完整目录、未配置及自定义 role、用户值／项目值／有效来源，使用对应 role revision 保存。
- 多 profile 是核心设置能力，设置页枚举 OMP 配置根下的默认及已有命名 profile，显示执行端、实际运行 profile 和已保存的下次启动选择；名称、目录与配置保存复用 OMP 原生机制，不复制凭据、不修改系统环境。
- profile 选择由 App Settings 持久化，保存后完整退出并重启应用才生效，不热切换当前会话。待重启期间，设置页与会话工具栏的角色编辑器均明确显示原因并禁止向旧 profile 保存角色，Host 同时拒绝该持久写入；临时模型仍作用于当前实际运行会话。任务不可变归属与完整隔离合同见下节。
- Host 的 `omp/profiles/*` 控制请求使用所属进程启动时记录的实际 cwd，身份仍保留原 workspaceKey／workspaceIdentity。历史目录失效而执行目录回退时，只调整 profile 控制请求的路径，不改历史会话 cwd、任务归属或偏好存储 key；读取项目树不得因两者不同而失败。OMP 的目录校验保持启用。
- 多 role 与临时模型界面必须保持原生差异：role 完整目录、自定义角色和独立 CAS 保存，临时模型仅作用当前会话且不写持久配置。验收分别证明双 profile 配置／会话隔离、role 保存后重启读回、临时模型不影响其他或新会话默认值；业务权威见 OMP 需求「多 profile、多 role 与临时模型界面」。
- 专用 Team 面板完整展示用户、持久、有效三份无损名单、读取状态、主模型、来源及问题。成员草稿可添加、替换、复制、排序、删除、清除及恢复默认；预览携带 `clientRevision`，只读计算与实际快照分开。保存全量具体身份与 CAS revision；失效原槽位保留直至用户修复，不写入原始 selector。
- 草稿由所属面板唯一持有，服务端独占已保存事实。事件／焦点刷新不覆盖脏草稿，显式重新读取可比较最新快照但不自动更新旧 CAS 基线；取消不保存。完整、覆盖、部分、未知、冲突分别显示，失败／断连先重读，不自动重放。会话／profile／连接代际及草稿版本的迟到结果不得改变当前面板。
- 自动化验收包括编辑／取消、预览版本、冲突与部分／未知回执、脏草稿外部刷新，以及切换目标后旧响应隔离；真实 GUI 保存与重启读回是完整交付验收的一部分。
- 既有已保存工作流、会话内定时任务与 Memory 的正常消费按 OMP 需求中「既有界面的工作流与记忆消费」接入：Host 仅继续持有既有定时调度，OMP 持有工作流执行、run／actor journal 与原生记忆；不把旧 Agent 数据库布局当作 OMP 的验收前提，不以缺能力或空结果跳过仍然保留的界面行为。

### 子代理与工作流核心范围（引用）

- 子代理创建配置、模型／思考隔离、真实 child 派生、转父问答、过程／历史、消息、停止恢复和失败结算，以及完整工作流定义管理、真实 actor 过程／交互、产物／历史、恢复／失败／取消，均为本次替换的核心范围；行为与协议事实的唯一权威为 OMP 需求的「子代理核心能力」「既有界面的工作流与记忆消费」。本节仅规定既有 GUI 的消费和验收边界，不另立执行状态或参数合同。
- 不用 `/workflowz` 或脚本编排替代 GUI actor 过程／历史，不用旧 `zcode-cli`、旧工具别名或平行 runtime 迁就 fixture。Host 仍只路由和持有组织态，UI 仍只持有草稿和展示；子代理／工作流执行事实不能迁入 Host。desktop-continuous 与 web-remote-replayable 隔离不变。
- v4 permission 工具审批纳入完整替换范围，复用既有权限面板、`resolveInteraction` 和双 delivery profile，具体授权／取消／隔离合同以 OMP 需求「权限与提问」为唯一权威。Host／UI 不记录另一份授权规则，不把一次批准扩大为全访问。Skill、Provider 管理在 OMP 已有原生能力范围内尽力完整桥接，仅修改适配与消费侧，不改变核心执行语义；原生没有等价能力的操作明确反馈限制。`plugin_reference`／插件目录、MCP 及其他管理面不因此扩大。
- 新增验收 ID `OMP-SA01`–`OMP-SA06`、`OMP-WF01`–`OMP-WF05` 的动作／证据见 [case catalog](docs/conversation-session-case-catalog.md#omp-native-子代理与工作流核心验收)，执行范围与状态见 [coverage matrix](docs/testing/conversation-session-e2e-coverage-matrix.md#omp-native-子代理与工作流核心验收)。全部当前为新增规划／未验证，需求更新不证明真实适配完成。

```mermaid
flowchart LR
    U["GUI：草稿/展示"] --> H["Host：路由/组织"]
    H --> P["OMP：公开协议投影"]
    P --> O["原生 AgentSession/registry/task owner"]
    O --> J["OMP：会话/工作流持久事实"]
    J --> P
    P --> U
```

### Tan 原生后台委派

- 接入 OMP `/tan <任务>`／“后台委派”，保留原有 `/side` 与 fork；Tan 是父 Agent 负责的原生后台工作，不是另开普通侧聊。原生继承、owner/job/registry、结果回投、取消与安全合同以 OMP 需求「Tan 原生后台委派」为权威。
- 不新增 Tan 专页，复用既有后台任务卡与子会话侧面板展示过程、结果、错误、停止及完成历史；关闭查看面板不能取消任务，关闭 owner 按原生生命周期处理。Host 只路由、UI 只持有输入草稿与可重建展示；缺能力的入口保留可见并给出原因。
- 真实 GUI 与协议验收使用隔离本地模型，证明父回合继续、结果只回所属 Main、并发／profile 隔离、独立取消与 EOF、双 delivery 恢复及旧 side／fork 不退化；不把 SDK 可创建普通会话当作完整 Tan 验收。

### 原生工具权限审批

- OMP 原生策略要求审批时，现有 GUI 必须展示真实 permission pending interaction、工具身份与原生提供的选项；允许一次、拒绝、取消及原生可用的会话／持久授权必须回到同一原生工具调用，不使用普通问答冒充权限。
- 权限等待／工具状态／任务计数来自 OMP 投影；UI 只保存当前应答 pending overlay。重复点击、桌面／手机竞争和迟到应答不能重复执行、扩大授权或改变其他会话。停止、关闭、EOF 和连接关闭按 OMP 合同取消，普通切换查看与订阅恢复不得另起审批。
- 新增 OMP-native GUI 验收使用真实 Desktop、Host、当前 OMP、隔离本地模型与真实文件副作用，覆盖批准前零执行、允许一次精确执行、拒绝／停止零执行、多会话隔离及刷新恢复；协议回归补齐非法／重复／迟到应答和关闭边界。历史 permission 旧夹具的排除记录仅描述当时执行选择，不再是取消该产品能力的依据。

### Team 聊天命令、设置与 Wiki／Repo 专页

- Team 是当前会话的内置聊天命令，不是独立应用页面。专用设置页只配置成员、模型及顺序，不承载任务输入或运行；聊天中 `/team …` 通过原生 Team 编排器发起讨论，以复用现有工作流组件的流程图卡片呈现，点击在右侧展开阶段、Agent 调用、审查／修订关系和过程详情。完成后卡片与最终方案保留在所属聊天记录，用户在原输入框继续对话；关闭详情不取消运行。不将 Team 转成普通工作流，不另建编排器。完整配置与运行合同见 OMP [Team 2.9–2.10](../oh-my-pi/docs-zh-CN/requirements/team.md#210-team-动态运行视图与交互关系新增需求未验收)。
- Team 模型与有序成员是当前 OMP 配置根／运行 profile 的全局用户配置，由会话共用，不按聊天会话或项目分别保存。Team 设置入口无需已有会话即可打开、读取和保存；通过可选 `omp/team/configure` 扩展调用原生 TeamConfigService，不创建或激活聊天会话、不发模型请求。工作区及 identity 只用于定位已有执行端及其 profile，不成为另一份 Team 配置的存储 key。会话中 `/team …` 仍只负责发起原生讨论；既有 CAS、未保存草稿、待重启 profile 与双端保存回执规则保留。
- Team 页就是模型配置页：打开后直接展示全局有序模型成员列表与“添加模型”，允许选择、增删、复制及调整顺序，保存／取消操作始终可达；不再先展示空页面再打开全屏技术配置对话框。默认优先呈现实际已配置、可用的模型，可搜索其他候选；不可用项必须有准确原因，不能把大量未认证 provider 的禁用行当作主选择界面。无可用模型时明确指出需配置模型服务，不伪造认证或自动选择模型。主界面不展示当前会话主模型、运行槽位诊断、shm／NFS／活动端／持久端或 CAS 技术字段；必要的高级来源与双端保存事实放入折叠详情，冲突／部分失败仍须清晰可见，不能隐瞒错误或削减真实保存语义。
- Wiki 与 Repo 均为 OMP 核心功能，分别设置独立页面和左侧入口，放在“自动化”下方，相邻排列。Wiki 承接 TUI 新增／导入、删除、默认搜索／grep／分页／正文查看，详见 [Wiki 权威需求](../oh-my-pi/docs-zh-CN/requirements/fork.md#zcode-wiki-专页新增需求未实现未验收)；Repo 承接首次确认建立、状态、更新、重建／恢复、删除、进度／取消及文本／符号查询，详见 [Repo 权威需求](../oh-my-pi/docs-zh-CN/requirements/repo-index.md#zcode-repo-专页新增需求未实现未验收)。
- Wiki／Repo 只增加向后兼容的可选协议扩展及能力发现，禁止改变现有 ZCode 方法、字段、通知、信封、版本或语义，禁止改 vendor 基线。Host 只路由到执行端的原生服务，不另建数据库或索引生命周期。旧客户端／旧 Agent 保持原行为，缺扩展明确不可用；真实专页新增、删除、搜索和生命周期证据不能由 TUI 既有通过记录替代。
- 上述新增专页及 OMP 模型配置必须遵循 `DESIGN.md`，直接参考 ZCode 现有工作流运行页、资源列表和 Settings 的布局、组件与视觉风格，不另造设计语言。使用统一紧凑页头、明确的主要操作、分组表单、可读的列表／结果与完整空态。执行端长路径作为次级信息，不挤占操作与结果；避免把全宽大表单、调试字段或原始 JSON 直接堆在主页面。
- Team 运行以聊天中的流程图卡片及右侧过程详情为视觉中心，设置与运行职责分离；禁止独立 Team 任务输入／运行页。Wiki／Repo 区分索引管理、查询和结果；模型设置区分 profile、持久 role／Team 草稿及仅当前会话模型。保留全部原生功能、禁用原因、状态所有者及接口，不借视觉重设计削减能力。
- 新版界面须在真实 Electron 页面验证，核对深浅主题、窄布局、长路径与长结果；只使用现有语义色与 `text-ui-*` 字级，运行动画响应 reduced-motion，所有交互沿用原有真实边界。

### 最新证据快照（2026-10-23，非整体验收）

Wiki／Repo 新版真实 GUI bg229 PASS（exit 0，170.04s，`desktop-e2e-20261022224641003-p64788-9616faedaa677057`）；mention bg230 PASS（exit 0，246.40s，`desktop-e2e-20261022224640810-p85936-69d818d634ab7f89`）。完整产物路径、Wiki／Repo 查询／生命周期及 mention／SharedSkill 实际覆盖范围见 [coverage matrix](docs/testing/conversation-session-e2e-coverage-matrix.md#omp-native-wikirepo-与-mention-最新真实-gui-证据2026-10-23)，本轮门禁结果见 [联调记录](docs/testing/omp-integration-blockers.md#最新局部验证与未完成项2026-10-23)。根 UT 最新为当前白名单 100 文件、1905 passed／31 skipped，不代表原全仓；历史基线和原需求保留。

**整体仍未完成／未验收**：新聊天 Team bg240 失败，profile 四阶段 GUI 尚在运行，默认安装版启动待处理。既有 permission、M01／M02、model restore、Tan 子代理／工作流通过保持原范围；旧独立 Team 页通过不得转记新聊天 Team。当前源码和 localhost 模型证据不冒充安装版、真实模型、手机、远端或其他平台通过。
### 单次完整交付与验收

不分阶段交付或分阶段验收。以下均为同一次完整交付的并列条件；内部工程依赖顺序不构成部分交付出口：

1. 在 FORK-001 的 UT 基线上，验证开发态显式覆盖、安装包默认注入、参数／cwd 覆盖、外部 OMP 存储准备和正常启动；失败不能启动业务或回落旧 Agent。
2. 通过真实 UI、Host 与 app-server 内同进程 AgentSession 完成全部约定功能，包括多会话隔离、消息／工具、停止／问答、历史／冷恢复、配置、命令／技能、执行中输入和队列；双方成功、失败与取消条件全部有效。
3. 验证同一 app-server 内多个主会话的配置／cwd／代理身份／事件隔离，单会话阻塞或停止不影响另一会话；同时验证双窗口 Host 隔离与写租约、索引归属、`existing-only` 及两种 delivery profile，不通过会话子进程规避同进程验收。
4. 桌面与远端实际运行同一兼容组合；取消、EOF、断线、版本不兼容和迟到结果均不能串会话、回落本地或遗留自有执行进程。
5. 全部约定能力验收后才切换正式发行入口。任一必需能力或验收未完成时整体仍为未完成／未验收，不把 UT 或既有独立 RPC 接口的局部通过当作完整替换完成。

### 当前临时 E2E 执行范围

- 本次继续适配后仅运行新增的 OMP-native 核心 E2E（上述 SA／WF ID）；旧套件和旧 fixture 不重新执行。下列旧排除／暂缓记录保留其原始证据与未运行状态，但不再构成对子代理和工作流核心行为的默认排除，也不充当新增用例通过或整体完成证据。

- 本次 OMP 联调暂不运行用户指定的两档 E2E：第一档为 Browser、计费／营销／登录及指定纯 GUI 场景；第二档为指定的 Agent 预热、资源监控、进程生命周期及其他非协议场景。仅调整测试选择，不删除测试或功能代码，不将排除项计为通过；E2E 排除本身不改变 UT 选择，UT 执行范围由下述独立临时规范控制。
- 精确排除集合统一由 `packages/desktop/scripts/e2e-formal-spec-selection.mjs` 维护，WDIO 与分片入口共同消费；默认全量、显式 `--spec` 和环境变量选择均遵守该临时屏蔽。恢复时移除该集合，不另设永久功能开关。
- `conversation-session` 下的消息、工具、队列、Bot worker、压缩、历史、配置和恢复等协议联调，以及 `omp-app-server.e2e.ts` 仍保留。后续暂缓清单只改变首轮调度，不取消协议能力；`bots/bot-runtime-authority.test.ts` 恢复为首轮 Bot 代表，其他既有 Bot 硬屏蔽项不变。
- 第三档暂缓会话内 19 个纯 UI spec：预览卡片／视频／Markdown 选区、附件布局、输入与滚动／导航、工具栏／计划快捷键、问答默认焦点、侧聊提醒、Plugin 引用展示和搜索设置等。`hooks-lifecycle` 同属本轮屏蔽、留第二轮验证；这只是推迟该 E2E，不取消 OMP hooks 执行合同。精确文件仍在上述集合中维护；`plugin-reference-subagent` 另按下述已取消的 `plugin_reference` 投影合同硬屏蔽，不与纯展示场景混为一谈。
- 首轮另暂缓 7 个已知失败的大 spec：`background`、`goal-run-cases`、`guarded`、`tool-cross-product`、`bash-direct-output`、`compact-auto`、`anthropic-reasoning-history-replay`。这些是重要协议场景，不归为取消的功能；默认首轮不调度，修复时可用精确 `--spec` 单文件定向执行，修绿后从暂缓列表移回首轮。
- 模型／Provider GUI 的 `model-provider-restart-recovery`、`model-provider-turbo-switch`、`model-provider-turbo-recovery`、`model-provider-settings-transition` 同样从默认首轮移出、允许精确单文件定向执行。`model-output-token-preflight-smoke` 原先保留首轮，现仅根据下述独立实跑的旧私有日志依赖暂缓。`provider-readiness-agent-startup` 的只读启动／进程复用需求仍有效，但当前 driver 使用旧 `storage-migrate` 和旧 SQLite 历史 seed，不能靠 OMP 环境覆盖切换执行对象，按下述旧 CLI 专用夹具硬屏蔽。
- 首轮暂缓清单与前述临时硬屏蔽清单在同一选择模块内分开维护：仅精确指定的暂缓文件可解除本次默认排除，宽泛 glob 不会把整组暂缓文件重新纳入首轮。原临时硬屏蔽项仍不因 `--spec` 而执行；两类均保留原用例、断言和代码，不将未运行记为通过。
- 补充 19 个会话纯渲染／布局与 ToolSearch 展示变体进入硬屏蔽清单；补充 11 个 Bot／Feishu worker、可配置数据目录及自动化建档／编辑场景进入首轮暂缓清单。具体文件仍只在统一选择模块枚举，不以耗时估算代替实际通过证据。ToolSearch base 原先保留首轮，现按下述真实源码运行证据更正为暂缓；recovery、scope、TUI、catalog、feedback 的当前物理 driver 属原 CLI 专用，不能因 consumer 需求真实存在就视为可经 OMP 环境覆盖执行。native ToolSearch 目录、冷恢复和 feedback provider 请求体需求仍保留，旧 CLI 结果不能作为 OMP 验收。
- 联调使用显式指定的最新 OMP 实现，不以原 `zcode-cli` 运行结果代替；开发迭代可按上述配置直接用 Bun 加载当前源码，exe 验收则使用包含本次修复的最新构建，二者结果分别记录。复用已确认通过的 OMP fulltest，优先完成本仓 UT／E2E；已证实为旧 Agent 专用夹具、非 OMP 生产缺陷的用例可暂缓，逐项记录原始证据，不改断言、不在 replay 中增加协议翻译，也不把暂缓或首错取消的用例计为通过。当前新增暂缓 `fork-merged-assistant`：夹具返回旧 `Write(file_path,content)`，真实 OMP 广告 `_write(path,i,content)` 并明确返回 `Tool Write not found`。
- 自动化 `automation-run-title-stable` 当前因本地构建没有 telemetry endpoint 暂缓：业务执行和正文成功，但包含 Host 独有 `session_create` 在内的报告库存为空；`telemetryCore` 在端点为空时按既有可选能力合同不发送。此项不归因 OMP，不为联调开启真实遥测。
- 根据 run `desktop-e2e-20261022081214117-p46328-434bcd46fdfcbee9` 的原始请求与 journal，另仅暂缓 6 个精确 spec：`conversation-session-chat-loading-live-tail.test.ts`（OMP 标题 sidecar 误耗主 fixture 次数）、`conversation-session-automation-cron-relative.test.ts`（依赖已排除的 native permission 反馈）、`conversation-session-ask-user-question-keyboard-navigation.test.ts`（旧 `AskUserQuestion` 工具不存在）、`conversation-session-background-notification-batch.test.ts`（三次旧 `Agent` 工具不存在）、`conversation-session-built-in-subagent-model-overrides.test.ts`（旧 `Agent` 工具不存在）、`conversation-session-compact-stream-fallback.test.ts`（原生小会话 guard 阻止压缩，尚未进入 transport）。逐项原始错误和相对 run 证据见 [OMP 联调阻塞记录](docs/testing/omp-integration-blockers.md#当前新增暂缓项)；保留精确 `--spec` 定向执行，不改硬屏蔽、测试、fixture 或断言。
- `context-window-cold-resume` 的旧水位缺陷已修复，最新 exe 已通过原高 usage UI 断言；现仅因后续依赖旧 Agent 私有 `.zcode/cli/debug/model-io-*.jsonl` 格式而暂缓该 spec，不将其后 compact／再次冷恢复计为通过。`empty-completion-retry` 的显式 context stop 已正确进入 overflow maintenance；仅第二 case 的短历史压缩／旧持久化夹具暂缓，第一 case 保留，通过既有 `ZCODE_E2E_MOCHA_GREP` 排除该第二 case 的完整标题，不修改测试或断言。修复前的真实 OMP 缺陷与修复后夹具边界分别记录，不能追溯改称同一个原因。
- 未知的 `automations-workflows-hub`、`highspeed-card-draw-timeout` 继续保留。已通过的 Bot 两项与 conversation workspace 一项不调整。首错取消不是已完成失败或通过；CLI exclude 诊断意外纳入的 manual-review／缺 `SSH_CONTAINER` 不属于本轮 formal 集，不扩大排除范围。
- `automation-cron-create` 同样暂缓：实际 `_CronCreate` schema 已包含防递归自动化要求，但用例先硬编码旧 wire 名 `CronCreate`，且后续必须批准已排除的 native permission；不通过改名或开启权限界面迁就该夹具。
- 本轮新增 6 个旧 CLI 专用 driver 硬屏蔽：`toolsearch-recovery`、`toolsearch-scope`、`toolsearch-tui`、`toolsearch-catalog`、`toolsearch-feedback` 及顶层 `provider-readiness-agent-startup`。静态证据：`helpers/toolsearch-cli-process.ts:106,119-123` 固定原 `apps/zcode-cli/.../dist/zcode.cjs`，`helpers/toolsearch-feedback.ts:56-62` 的 `runFeedback` 调用该 fixture 的 `start`；`fixtures/toolsearch/runtime-driver.mjs:1-4` 导入原 bootstrap。不得启动这些旧执行对象，也不得把其结果记为 OMP 结果；这纠正原先 recovery／feedback／provider-readiness 总能由环境覆盖的假设，不取消真实业务需求。
- 本轮另新增 7 个合同硬屏蔽：`permission-hook-rewrite`、`permission-hook-race`、`v4-bash-command-prefix-permission`、`v4-permission`、`v4-refresh-permission` 依赖当前不支持的专用 permission 界面；`plugin-reference-subagent` 依赖已取消的 `plugin_reference` 投影；`hook-trust` 依赖旧 Host trust store，原生不制造平行信任存储，schema accepted 为 false。这组是合同排除，不表示全部已运行失败。最新源码 run `desktop-e2e-20261022084020260-p29896-cfa8bcf60372a0c8` 仅确证 `permission-hook-rewrite` 在 beforeAll `:97 → :219` 打不开旧 `cli/db/db.sqlite`；不是 OMP 库缺失，`permission-hook-race` 也没有同一 SQLite setup 或实测失败证据。
- 本轮仅按静态旧 Agent 夹具／私有存储边界新增 12 个首轮暂缓，均未取得该轮单 spec 实测失败结果：`model-output-token-preflight`、`model-output-token-budget`（旧 model-io／精确 preflight-v1 策略）；`send-message-resume-stop`、`subagent-runtime-catalog-reasoning`、`subagent-prompt-assembly`、`subagent-respond-to-coordinator`（旧 Agent／SendMessage／子代理目录与 prompt）；`memory`（旧 Extraction／存储／工具）；`background-bash-output`、`background-subagent-rate-limit`（旧 Bash／Agent／文件布局）；`pasted-image-path-projection`（旧 image-cache）；`tool-group-settings-persistence`（旧工具组合）；`v4-rewind-files`（旧 Read／Write 夹具不能创建其所需真实文件）。保留精确 `--spec` 定向机制，不复制旧日志、路径或工具别名，不取消原生 Memory 偏好、输出限制、子代理及文件回滚等真实需求。
- 另据真实源码 run `desktop-e2e-20261022084903410-p66240-0eabf19b4586d659`，仅将 `conversation-session-toolsearch.test.ts` 追加首轮暂缓而非硬屏蔽：`:48` 要求旧 `TodoWrite` schema 失败，capture 实际广告含原生 `_todo`（以及 `_read`／`_bash`），后续 tool_result 明确 `Tool TodoWrite not found` 且 `is_error:true`。此前保留判断经真实边界更正：旧 TodoWrite fixture 未走到 OMP `_todo`，不是原生待办业务缺失，也不能据此宣称 cold resume 已验收。真实 native Todo／ToolSearch 需求保留，不加旧工具别名、不翻译 replay、不改断言，仍可精确 `--spec` 定向执行。
- 上述新增清单不外推至混合 case 文件 `modified-submit-delivery`、`side-pane-full-view`、`v4-rewind-queue-background`，也不屏蔽 highspeed、`model-provider-add-send`、`unregistered-tool-cold-snapshot`、公开队列／Goal／模型隔离或 OMP 专用 GUI 用例。首错取消或静态旧依赖不等于业务失败；本轮只调整精确名单，不改产品、fixture、断言、exports 或选择实现，不新增 replay 翻译。
- 请求取证须按实际标题 sidecar 分类排除辅助生成，兼容原 CLI 与 OMP 的标题 system prompt；仍对主请求原样校验状态、模型及配置参数，不改写请求、响应、fixture matcher 或断言。仅因辅助标题返回不同而误选记录属于测试取证缺陷，不作为主 provider 配置失效证据。
- `side-pane-full-view` 保留普通浮窗 case。SPFV-E2E-008 先暴露的 OMP turnHeader 提前完成缺陷已修复并通过原工作时长断言；后续独立失败已确认是旧 `AskUserQuestion` fixture 未调用原生 `ask`，仅通过 `ZCODE_E2E_MOCHA_GREP` 精确暂缓这个标题，不排除整个文件或原生问答能力，也不把该旧夹具场景记为通过。
- `model-output-token-preflight-smoke` 独立源码 run `desktop-e2e-20261022093234491-p80224-4626d362622ab5d2` 已通过前置正文完成与 provider 输出 cap 断言，但 `:135-140,445` 必须读取旧 CLI 的 `compact.auto.skipped`／`below_threshold` 私有日志，在 `OTB11` 首错；仅此文件追加首轮暂缓，不复制旧日志或改原断言。该运行不证明后续 30K 压缩、48K 场景或完整 smoke 通过；公开输出上限与原生 context 恢复需求仍保留。
- `running-guide-steer` 保留混合文件，仅按两个完整 P06 标题暂缓：`P06 MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示` 与 `P06 non-MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示`。MCS 原始 capture 明确返回 `Tool Read not found`；non-MCS 共享同一旧 `Read(file_path)` 夹具及私有 wire 断言，仅属静态同源依赖，不记为实测失败。通过现有 `ZCODE_E2E_MOCHA_GREP` 精确排除这两个标题，不改测试或回放；plain guide 仍保留，两个 Goal case 按下述独立证据处理。
- 同文件仅另暂缓 `guide 模式下 active goal 运行中发送引导消息，不得 stop active target` 与 `guide 模式下 goal verifier 运行中发送消息，应保留为 future queue 且不 stop active target`：独立源码实跑证明 active objective 已经进入带原生 `<goal_context>` 的首次主请求，但原断言在发送 guide 前就要求旧私有 continuation 文案；不能据此判原生引导／调度失败。verifier 本轮未执行，仅同源旧 continuation/verifier 夹具阻塞，不能记为实测失败。plain running guide 已实际通过，不整文件屏蔽，不复制旧目标 prompt。
- 剩余 fixture 仅据静态必经旧工具路径新增两个默认文件暂缓：`conversation-session-v4-background-work.test.ts` 唯一 case 必须成功执行旧 `Bash(run_in_background:true)`；`conversation-session-subagent-interaction-delegate.test.ts` 的 T01 必经旧 `Agent → AskUserQuestion`，T02 除旧 `Agent → Bash` 外还强制当前不支持的 permission dock。两文件复用 `FORK_DEFERRED_E2E_SPECS`、仍可精确 `--spec` 点名；T01 不归为 permission 排除。这是静态同源边界，不声称本轮已实跑失败，不取消原生后台取消、子代理或问答需求。
- 混合文件不整文件暂缓，仅由父级通过既有 `ZCODE_E2E_MOCHA_GREP` 精确排除 `M06k MCS：工具结果后 Cmd/Ctrl+Enter 抢占，human reminder 全文与角色正确`、`M06k non-MCS：工具结果后 Cmd/Ctrl+Enter 抢占，human reminder 全文与角色正确`（必经旧 `Read(file_path)` 及真实文件结果），以及 `PV4-23 edit 前取消被裁 turn 的后台 Bash，新分支只启动一次`（编辑前必须成功启动旧后台 `Bash`）。这些是静态同源阻塞，未运行不记失败；modified-submit 的 pre-output 抢占／guide future queue、running-send-now 全部 case、PV4-20 held queue 和 PV4-18／19 compact/edit/restore 仍保留实际执行。旧 reminder golden 或 compact prompt matcher 仅作后续归因线索，不据此扩大过滤。精确 fixture／case 证据见[联调阻塞记录](docs/testing/omp-integration-blockers.md#剩余默认集合的静态旧工具边界)。
- `v4-compact` 当前唯一短种子 case 实跑被原生 `Nothing to compact (session too small)` 拒绝，没有摘要请求；仅暂缓该文件，不伪造 success，不连带排除 PV4-18／19／20。`settings/mcp-dual-era-version-negotiation` 两例依赖旧 `.zcode/cli/config.json`、`mcp/list` 管理面和旧 dual-era 日志：本次仅 MVN04 已实跑，未进入服务器握手；第二例未执行且旧合同不适用。该文件默认暂缓，不为其增加未承诺的 MCP 管理接口，native MCP 启动／工具调用合同保留。
- PV4-18／19／20 后续分别独立实跑，均在各自第一次压缩处由原生明确返回 `Nothing to compact (session too small)`，没有发出会话摘要请求。现将 `v4-rewind-compact-extended` 与 `v4-rewind-queue-background` 默认暂缓；前者两例分别有证据，后者 PV4-20 为短种子前置、PV4-23 为旧 Bash 前置，不能混称同一原因。未到达的附件 edit、两次 boundary/cold restore、held/edit 后各消费一次仍是验收缺口，不记通过；原生正向压缩另用专用 OMP GUI 场景验证，不降低产品阈值。
- `v4-edit` 的唯一用例已独立运行，首个 compact 在原生 journal 明确返回 small-session 错误；尚未执行 edit，不以该结果判断原生 branch cut。`v4-fork` 已完成真实派生、父问答继承、模型能力恢复及 child provider 请求，但旧断言强制模型上下文含固定英文 fork notice 和字符串 content；公共 lineage／marker 不依赖该私有提示词。两文件默认暂缓，不复制旧 prompt 或降低压缩阈值。
- `tool-input-validation-provider-content` 仅有的用例返回旧 `AskUserQuestion`，原生目录为 `ask`，真实 continuation 已回报工具不存在，未进入原生 schema validator；`unregistered-tool-cold-snapshot` 已真实持久化并上送全部 61 个失败结果，但 fixture 的旧 `Tool not found: Grep` 子串不匹配原生错误，主 continuation 返回 500。两文件默认暂缓，不增加工具别名或错误翻译；未到达的原生 malformed-tool、错误 cold restore、60-row tail 补齐仍不记通过。
- `running-send-now` 仅精确暂缓两个 `M07a MCS/non-MCS：running 中点击队首立即引导，消费原文并以 user reminder 降级` 标题。MCS 实跑已验证所选输入身份、队列移除及原生 user interjection 请求，失败在旧 `runtime-input-presentation.json` 全文；non-MCS 为同一回调的静态依赖，不冒充实测失败。非队首、Goal 和双击 case 继续运行，不能将 Goal 真正的准入失败归为私有 prompt 差异。

### 当前临时 UT 执行范围

- OMP 对接期优先快速验证：根 Vitest 只运行 OMP 对接白名单，包括用户列明的 fork／工作区改动 UT、Agent 传输及进程链路，以及必要的 OMP 配置和 E2E fail-fast 回归。外部 OMP 切换不再要求已删除的 OMP artifact 校验套件。`zcodeAgentService.v4` 保留，不以耗时为由屏蔽直接协议覆盖；不为协议补偿新增回放翻译器或配套测试。
- 只调整根配置的测试选择，保留全部测试文件、用例、断言及原全量范围定义，不改产品行为、不延长测试超时。无关普通 UT、串行隔离 UT 与 CUA 子项目暂不执行；不将屏蔽项记为通过。
- 白名单由 `vitest.config.ts` 单点维护，保留普通 threads 与真实进程串行 forks 的既有隔离规则。`test`、`test:unit`、coverage 和根 affected/pre-push 均受该根配置约束；“整个根套件”在临时配置期间指白名单范围，不含被屏蔽测试。架构合同测试仅保留白名单内项，`test:architecture` 的独立入口不变；CLI 独立套件不由本修改接管。
- 文件数量与耗时以当前真实 Vitest 选择和实跑为准；先前的“35 个／4.6 分钟”是分析估算，不作为新配置的通过证据。恢复时将根配置 `focusedUnitTests` 的数组初始化值替换为 `null`，由选择分支单点切回保留的 `fullUnitTests`、`fullForkIsolatedTests` 及 CUA 子项目定义，并根据届时改动处理冲突和实际验证；不以白名单通过替代原全量验收。

### 当前状态

本机既定联调范围已通过：Host 直接启动 OMP app-server，开发迭代使用 Bun 加载当前源码，不回退原 `zcode-cli`；协议适配仍由 OMP 承担，不在 Host/UI 或回放中增加协议翻译。已修复原生输入／Goal 准入、暂停队列、context 终态发布、模型覆盖、Highspeed 事实、工作流失败回收及启动恢复时序等联调问题，保留必要配置 GUI、启动／发行装配与通用会话恢复。最后一次重新构建 Desktop 的 10-shard 真实 GUI 运行通过 23 文件／45 用例；此前当前 UT 白名单通过 42 文件、893 passed／23 skipped，选择合同回归 162 项通过。类型检查、Lint 与受改动架构检查通过，Lint 仍为 96 warnings／0 errors。排除、暂缓、原始失败及证据边界见 [OMP 联调记录](docs/testing/omp-integration-blockers.md#本机联调收口)，不把白名单通过等同全产品验收；正式签名发行、跨平台部署及未覆盖组合仍未验收。已确认的 OMP fulltest 结果复用；源码运行结果不冒充已安装 exe 或正式发行结果。

上述通过记录仅覆盖当时既定选择；新增的子代理／工作流完整核心合同尚待真实适配与 `OMP-SA01`–`OMP-SA06`、`OMP-WF01`–`OMP-WF05` 新 E2E 验收，整体替换不能据旧收口记录宣称完成。本次不扩跑 UT、旧 E2E 或门禁，执行证据由新增 E2E 的实际结果单独记录。

## 7. FORK-004：OmpCode 产品身份、独立数据与 profile 隔离

### 产品身份与双装

- 面向用户的产品名称为 `OmpCode`，覆盖桌面窗口、菜单、托盘、关于页、Web 页面与安装包；保留 ZCode 来源引用和现有协议、包名等不影响双装的内部标识，不做全仓字符串替换。
- OmpCode 与上游 ZCode 可以同时安装、同时运行、分别卸载，安装目录、应用 ID／AUMID、深链 scheme、操作系统菜单注册、单实例锁、更新缓存、凭据及 Electron 用户数据均独立。不得沿用 main 旧合同中允许共享 appId／scheme 的例外。
- OmpCode 不查询、安装上游 ZCode 自动更新，也不受其强制更新阻止启动；没有本 fork 专属更新来源时保留相关 UI 并明确说明不可用，不伪造更新成功。不得操作或结束现有 ZCode／OMP 进程。

### 应用数据根与只读目录

- OmpCode 默认业务数据根为 `~/.ompcode`，不读取、迁移、复制、覆盖或删除上游 `~/.zcode`；配置、日志、任务组织索引、应用凭据及内部工作区均由独立根派生。
- 迁移 main 的环境规则：有效的绝对 `OMP_CONFIG_ROOT=xx/bb` 决定 OmpCode 数据根为 `xx/bb_ompcode`，支持 `~` 展开；无有效覆盖时使用默认根。`PI_CONFIG_DIR` 只影响 OMP 自身的既有解析，不改变 OmpCode 数据根。OMP 原始环境继续原样传递，不把应用派生根传回 OMP 作为配置根。
- 应用启动最早期在设置、日志及 Electron 存储初始化前确定根并向 Host 传递同一事实；旧 `setting.json` 的 `dataBaseDir` 及旧目录选择／迁移机制均不能覆盖它。环境变量变更只在完整退出重启后生效，不自动搬运任何旧数据。
- 设置页面只读显示实际路径及 Windows／Linux 环境变量设置方法，不提供目录选择、保存或数据迁移；服务端同样拒绝修改目录，不仅禁用按钮。

### 实际 OMP 根／profile 的状态域

- OMP 拥有实际配置根、运行 profile、模型角色与会话历史。Host 以真实启动后的根／profile 事实建立作用域，不能使用待重启的选择、客户端猜测值或只含 workspacePath 的 key 代替。
- 任务组织索引、未提交草稿和 Recent 模型偏好均随实际 OMP 根及运行 profile 隔离，并保留 workspaceIdentity／remoteSessionId 的现有隔离；三者各复用原有持久化所有者，不新增第二套事实存储。
- 任务 UUID、分组、排序、置顶、归档、未读等组织信息在切换根／profile 时不串入目标域，切回时原样恢复；不迁移、删除或重新绑定旧会话。
- 草稿内容、临时模型与 Recent 记录不能跨根／profile 回流。保存待重启 profile 不改变当前运行域；重启后仅加载目标域，切回后恢复原草稿与偏好。域切换、断连及请求代际变化时丢弃迟到结果。

### 验收

- 用隔离 HOME 和两个真实临时 OMP 根验证默认／命名 profile 枚举、保存重启、双角色入口及 Host 拒写；旧 profile 的配置保持不变。
- 用真实应用设置页核对 OmpCode 名称、实际根及只读目录；向上游数据目录预置哨兵，启动、保存与重启后哨兵内容及目录树不变，空新根不导入旧设置。
- 验证两根／两 profile 的任务组织、草稿和 Recent 往返隔离及切回恢复；安装元数据、协议与更新边界使用现有构建配置及隔离运行验证，不将配置检查冒充已安装双包实测。

## 8. FORK-005：OMP 内置命令最小接入

本节为本次命令接入的优先合同；已有需求与本节冲突时以本节为准。用户原始消息逐字保存在 `local://original-omp-command-requirements.txt`，不以实现摘要替代。

在现有会话输入框中，支持 OMP 全部非 TUI 专属内置命令及其参数，保留命令名补全和用法提示；尽量减少 ZCode 改动，不改变现有协议。

### 功能要求

1. 真实命令目录：命令名称、别名、说明及参数用法来自当前目标工作区 OMP 的实际注册信息，不维护人工命令白名单。
2. 命令名补全：输入 `/` 时可浏览、筛选和选择命令，展示命令说明及已有的参数用法提示。
3. 完整参数提交：支持手工输入命令的全部合法参数，保留引号、换行及内部空白，由 OMP 原生处理器解析和校验。
4. 原生命令优先：OMP 运行时下，目录中已注册的命令不得被 ZCode 同名本地逻辑截获、改写或丢失参数。
5. 统一结果展示：命令输出、错误及执行状态进入所属会话的现有时间线；选择、确认和文本输入复用已有交互组件。
6. 真实失败反馈：非法参数显示 OMP 返回的用法或错误；不能改成普通模型问题，不能以受理成功代替执行完成。
7. 终端能力边界：仅依赖 TUI 专属界面的命令或子操作明确提示不可用，不影响同一命令中可独立执行的其他操作。
8. 执行边界不变：继续复用现有会话身份、队列准入、停止和去重机制，不另建命令执行链路。

### 最小改动约束

- 继续使用现有 `createSession.firstInput.text`、`sendText.text` 和交互应答通道。
- 不新增逐命令接口、参数字段或协议版本。
- ZCode 不复制 OMP 的参数解析、校验及业务逻辑。
- 改动集中于命令目录投影、提交优先级和必要的结果／交互映射。
- 新增普通 OMP 内置命令后，应通过目录发现并复用通用提交路径，不要求同步增加 ZCode 命令分支。

### 不包含

- 动态参数补全，例如参数位置的模型、路径或子命令候选。
- 命令专属参数表单、页面和设置面板。
- 终端编辑器、终端选择器及其他 TUI 专属界面。

### 验收条件

1. `/` 面板与目标 OMP 实际命令目录一致，能展示说明和参数用法。
2. 从现有输入框执行非 TUI 专属命令及其合法参数，行为与 OMP 原生处理一致。
3. `/goal show`、`/goal pause` 不再被旧本地解析拒绝，`/compact` 参数完整到达 OMP。
4. 非法参数和 TUI 专属操作返回真实错误，不误发模型、不伪造成功。
5. 命令的输出、交互、取消及历史恢复沿用现有会话机制，不串会话、不重复执行。
6. 既有普通对话、按钮操作及上游 Agent 路径不因本次接入改变。

## Windows 打包与发布

- `.github/workflows/release-windows.yml` 保留本分支手动发布入口，只接受 `refs/heads/dev-centos7`，各构建及发布阶段固定触发 SHA；仅安装构建依赖、构建 Windows x64 NSIS 安装包、生成并核对 SHA256、上传与发布，不运行测试、E2E、smoke、lint 或独立类型检查门禁。生成产物所需的 TypeScript 编译及包资源／体积完整性检查仍属于构建，不另增测试作业。与 CentOS 共同行为见[双平台发布规范](docs/centos7-desktop-release.md#8-双平台-github-发布slice-4)。
- 正式产品身份为 OmpCode；应用版本来自根 `package.json`，Release 标签沿用 UTC 时间、GitHub run ID 与 attempt 的唯一组合。Release 精确指向本轮 `GITHUB_SHA`，先创建草稿、核对安装包与校验文件后才公开；未签名的 Windows 产物明确说明。外部 OMP 不随包分发、不自动安装或替换。
- 此次将新 main 合入 `dev-centos7`，产品功能以 main 为准，仅保留本分支必要底层兼容与构建适配；不在本次任务切换发行分支或替换远端 main 历史。先前“以 dev 替换旧 main”的操作合同属于历史发布阶段，不约束此次明确合并。
- 本分支发布验收须以实际触发的 `dev-centos7` SHA、对应 Windows workflow 成功结果、公开 Release、安装包和 SHA256 为准，不以历史绿色 run、其他平台 Release 或旧草稿代替。main 已有 Team 模型配置与聊天工作流式卡片功能合同保留；历史 E2E 结果不作为此次合并后的新验证。

## 9. 后续需求记录规则

- 新增或修改行为前，先记录对应需求，再实现代码。
- 每项需求明确目标、产品规则、状态所有者、接口边界和验收场景。
- 涉及已有模块时，复用并更新对应需求文档，在本文件引用，避免形成相互冲突的两份定义。
- 实现和验证状态以实际结果记录；未运行的验证不得标记为通过。

<a id="fork-004-centos7-desktop-release"></a>

## 10. FORK-004：CentOS 7 桌面发布迁移

### 标识与需求依据

本节按本次任务要求保留 `FORK-004` 标识，与第 7 节既有的「FORK-004：OmpCode 产品身份、独立数据与 profile 隔离」发生编号冲突；二者是不同需求，不替代、不合并，也不重编号既有 FORK-004 或 FORK-005。引用本节时使用唯一锚点 [`fork-004-centos7-desktop-release`](#fork-004-centos7-desktop-release)，避免仅用编号区分。

详细合同见 [CentOS 7 桌面发布迁移规范](docs/centos7-desktop-release.md)。旧 `main:docs/requirements/centos7-release.md` 仅作为迁移需求依据；与本节及新规范冲突的旧 UI、离线策略、内嵌 Agent 和平台基线不沿用。

### 目标

在 `dev-centos7` 合入新 `main`，功能语义以 main 为准，仅保留 CentOS 7 x64 桌面发行必需的底层兼容与构建适配；取消迁移初期不 merge、cherry-pick 或 rebase main 的操作禁令。目标宿主为 Linux 3.10／glibc 2.17；仅 CentOS 构建固定 Electron `28.3.3`、内嵌 Node `18.18.2` 与 Chromium `120`。Windows、macOS 等其他平台沿用当前上游 Desktop manifest／lockfile 的版本，不永久固定 Electron `41.0.3`（它只是本次迁移开始时的源码基线）。各平台复用 main 的界面、协议与功能，只迁移必要的底层兼容、启动和发行装配，保留持续合并上游的能力。

### 范围与边界

- 唯一 CentOS 分发格式为可重定位的 ZIP 及 SHA256 校验文件；Electron、原生模块、搜索工具、库和字体等应用资产自包含，OMP 是用户须预先独立安装的兼容外部依赖，不在包内。用户先配置对应执行环境的 OMP 命令或 PATH，之后非 root 解压应用不需联网补齐资产或安装宿主包。产物不包含 OMP 私有运行资产、PRoot、Ubuntu userspace 或替换宿主 glibc 的方案，不恢复旧 RPM／安装器路径。
- Electron 及 Node 18 兼容依赖的精确版本切换只在 CentOS 临时构建工作区进行，不持久改写根 manifest、lockfile 或其他平台 runtime。此次不修改源码 Electron `41.0.3` 的值，但不增加阻止未来上游正常升级的固定版本检查或版本配置框架。复用现有构建与发布约定，兼容清单、资产来源与构建期检查由详细规范维护。
- 提供真实等价的 Electron 28／Node 18 API 兼容实现，包括文件附件路径、浏览器历史、`node:sqlite` 和 `fs/promises.glob` 等差异；现代 runtime 优先使用原生能力，仅缺少所需能力时走兼容路径，不通过删除功能、吞错或空实现获得兼容。按用户 2026-10-23 要求删除 CentOS runtime API audit 功能及其发布门禁、报告、专用构建元数据与配套文件，不保留替代审计入口；既有运行时兼容实现不变。
- 打包 glibc 2.17 兼容原生模块、搜索工具、所需 C++／GUI 库、可再分发中文字体及许可；保持 `app.asar`／`app.asar.unpacked`／`resources/tools` 的既有资源职责，保留符号链接与可执行权限。不分发可选 `sshcrypto.node`，SSH 使用 `ssh2` 与 Electron 内置 crypto；高于目标 GLIBC 的二进制、缺失必需资源和损坏归档在构建期阻断。
- OMP 继续遵循 FORK-003：用户预装兼容 OMP，由 Host 启动外部 `omp app-server --stdio`，app-server 内同进程 AgentSession 执行业务；不内置、下载或分发 OMP，不要求 OMP artifact／manifest 或固定生产端，不恢复旧随包适配器、旧 Agent 回退或会话子进程架构。启动器仅透传显式命令及继承 PATH，不探测发现；未设命令默认 `omp`，显式非空优先、空值报错由现有启动解析负责。所有继承的 `OMP_*` 及 `PI_CONFIG_DIR` 原样透传，不解析或改写 `OMP_OFFLINE`，离线语义完全由 OMP 自身解析。
- 启动器负责安装目录解析、进程局部库路径、必要的私有 XDG 环境、参数／profile 转发及直接启动 Electron；帮助先于资源检查和目录创建。不恢复 `--home`／`--offline`、数据迁移或根目录重定向。默认软件渲染及 `--no-sandbox` 的安全限制须明确记录，仍要求可用图形会话。
- P0 输入法合同保留旧规范的完整 IBus 算法：按当前 UID 与初始 DISPLAY 查找，NUL 分隔 `/proc/<pid>/environ` 只作数据读取；仅本地 Unix 总线，经 `gdbus --session` 查询 IBus owner PID，每次限时 2 秒。保留已验证调用者总线，否则仅选唯一有效候选；显式地址、歧义、当前显示已有或归属未知的守护进程不得被替换。自动启动须先 `flock` 等待最多 5 秒并重查，创建总线最多 3 秒、启动最多 5 秒、就绪窗口 5 秒；保留其他 DISPLAY 的进程，不使用 `--replace`／`--xim`，不 `eval` 总线输出。选定环境仅传给应用子进程，原 HOME／XDG 下先发现地址再隔离；缺工具或失败具体告警后继续 Electron，只清理本次失败的新建总线，不更改父 shell、持久配置或已有守护进程。
- 不修改 UI，不删除或隐藏入口，不迁移默认语言、不增加离线门控／网络策略、不改变性能标记、shm 活动根、流式输出或动画。既有身份、数据根和 profile 合同保持原状，不借发行迁移扩大改造范围。
- 最终验收保留 Windows 可执行的受影响共享逻辑测试及必要质量检查，按实际命令、选中测试与结果记录；此前阶段性“不执行测试”不构成永久禁测政策。代码编辑子任务不自行运行检查，由主执行者在整合后执行 Windows 受影响测试。不新增 CentOS 7 专项测试，不执行 Linux／WSL／VM／Citrix 运行，不触发、等待或验证发布 workflow；目标平台由用户在内网测试，未取得实际结果前保持未验收。构建期 ELF、原生资产、归档及校验和约束属于打包完整性检查，不等于运行测试，也不表示已完成实际产物检查。
- 迁移旧 main 的 Windows 与 CentOS 7 两条 GitHub 构建流水线；两者只构建、打包及发布，不运行 UT、E2E、类型检查、Lint 或运行时 SSH 握手测试。流水线适配当前分支和 FORK-003 资产合同，不照搬旧路径。CentOS 手动发布由 GitHub 固定并发组串行调度，使用多 pending 队列，不因后来请求取消已等待的请求；队列上限遵循 GitHub 的 100 个 pending 限制。

### 验收标准

1. 新规范覆盖依赖精确版本、兼容 API、启动器、P0 IBus、外部 OMP、原生资产、ZIP 布局、构建与发布职责，并逐项区分继承要求和本轮排除项。
2. 后续实现按上述边界完成真实兼容与装配；仅 CentOS 隔离构建固定 28.3.3／18.18.2／120，其他平台保持当前上游 manifest／lockfile，不被 CentOS 构建降级，也不被永久钉在本次历史基线；无旧 Agent 适配器或平台专属 UI 分叉。
3. 双平台流水线仅打包、不测试；CentOS 发行流程仅发布满足目标 GLIBC、必需资产、权限／链接、归档和 SHA256 完整性约束的 ZIP；任何未执行的构建或发布检查不得写成通过。
4. Windows 可执行的检查如实记录命令、结果与范围；Windows 检查、历史主机记录及本次规范编写均不能证明 CentOS 包、中文输入或目标宿主已验收。不以取消 Linux 测试要求冒充目标平台验证成功。

### 当前状态

迁移代码已落地：启动器／IBus 与环境透传、共享 SQLite 驱动门面及调用方、Electron／Node／CSS 兼容分支、原生资产与临时构建工作区、Windows／CentOS 两条手动 GitHub 仅打包发布流水线均已实现。本次源码 Electron `41.0.3` 与 React `19.2.7` override 保持不变，此处记录当前事实而非未来上游版本约束；CentOS 的 Electron `28.3.3` 等精确覆盖仅作用于源码外的新建构建工作区。实现、资产版本与证据边界详见[详细规范](docs/centos7-desktop-release.md)，不将代码落地等同于完整发行验收。

以下为本次 main 合并前已记录的 Windows 历史证据，不能作为合并后的检查通过：依赖安装成功；此前代码合并后的 typecheck 通过，lint 为 100 warnings／0 errors（更早为 98 warnings／0 errors）；原生 SQLite 操作命令输出 `{ value: 'native runtime', sqliteVersion: '3.51.2' }`；打包脚本 `--help`／status、所改打包脚本 `node --check` 与三份 shell 脚本 `bash -n` 曾通过。此前架构检查相对 `b19b2fda` 因三个既有 contract 文件超行数失败，未放宽阈值或更新 baseline；最初默认检查的 26 项既有违规不记为当轮新增。此前 affected UT 选择结果为 0／92、没有选中测试，不能写成测试通过。旧通用 API 审计框架报告的 6381 项误报不能记作运行时缺陷或审计通过；2026-10-23 用户要求删除整个 CentOS runtime API audit 功能，不再要求其库存、报告或门禁通过。此次合并与外部 OMP 合同文档更新未运行检查；整合后的 Windows 受影响检查结果只能按主执行者实际执行记录。

尚无实际 ZIP／EXE 构建产物、GitHub dispatch／发布或 Linux／CentOS／WSL／VM／Citrix 运行证据；GUI、中文输入、SSH 及内网目标宿主仍由用户验收。Electron 28 的历史兼容保留现存原生条目，并提供进程内完整 URL／title／index 导航栈；不宣称能导入／导出 Chromium 的不透明 POST／表单／子框架 pageState，也不宣称已有持久化浏览器恢复存储。静态 ELF 检查代码不能证明 OMP 内嵌 native／内核兼容，旧 main 的历史验证同样不计为本次通过证据。
