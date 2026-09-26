# OmpCode

<p align="center">
  <img src="public/logo/icons/1024x1024.png" alt="OmpCode 图标" width="96" />
</p>

<h3 align="center">omp 最好的桌面版本</h3>

<p align="center">
  像 ChatGPT 一样顺手，拥有 ZCode 的精致界面和 omp 的完整能力。<br />
  OmpCode 把 omp 的所有命令与功能，带进友好的图形化 AI 编程工作台。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="https://github.com/can1357/oh-my-pi/discussions/13231">omp 社区讨论</a> ·
  <a href="#项目来源">项目来源</a>
</p>

## 看看 OmpCode

**用熟悉的聊天界面，驾驭完整的 omp。** 基于 ZCode 的工作区延续 ChatGPT 式对话体验，同时清晰呈现 omp 的任务、工具调用、文件改动与会话状态。

<p align="center">
  <a href="docs/images/ompcode-workspace.png">
    <img src="docs/images/ompcode-workspace.png" alt="OmpCode 桌面工作区与 Agent 会话" width="100%" />
  </a>
</p>

**看清上下文。** 在输入区查看上下文容量、估算用量分项、空闲空间和自动压缩预留区。

<p align="center">
  <a href="docs/images/ompcode-context.png">
    <img src="docs/images/ompcode-context.png" alt="OmpCode 上下文用量面板" width="502" />
  </a>
</p>

**按 omp 的方式配置模型。** 选择 Profile，为不同模型角色分别设置模型和思考等级。

<p align="center">
  <a href="docs/images/ompcode-models.png">
    <img src="docs/images/ompcode-models.png" alt="OmpCode 的 OMP Profile 与模型角色设置" width="100%" />
  </a>
</p>

**每条 omp 斜杠命令都触手可及。** 在输入框键入 `/`，浏览并执行命令，不必离开对话。

<p align="center">
  <a href="docs/images/ompcode-commands.png">
    <img src="docs/images/ompcode-commands.png" alt="OmpCode 中的 omp 斜杠命令面板" width="100%" />
  </a>
</p>

## 为什么选择 OmpCode

- **ZCode 界面，ChatGPT 式上手体验**：沿用 ZCode 的界面与视觉风格，用熟悉的对话布局呈现强大的编程工作区。
- **由 omp 驱动到底**：内嵌 omp 核心，界面围绕 omp 的会话、工具、模型、命令与全部功能设计。
- **所有斜杠命令**：在输入框浏览并执行完整的 omp 命令目录，包括 `/model`、`/switch`、`/compact`、`/mcp`、`/usage` 与技能命令。
- **模型由你掌控**：复用 omp Profile 与模型角色，为不同角色设置模型和思考等级，也可以在会话中临时切换。
- **清晰的工作现场**：流式回复、工具调用、文件改动、上下文用量和压缩状态，都在同一工作区里可见。
- **桌面之外继续工作**：通过 Web 与手机远程访问，在不同设备上接续同一个工作流。

## 快速开始

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**；版本以 [mise.toml](mise.toml) 为准。在仓库根目录运行：

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` 安装依赖、准备桌面运行资源并构建项目。桌面应用会内嵌 omp；无需单独安装 omp。应用使用 omp 的配置、模型与会话数据。

开发 Web 客户端与服务端：

```bash
pnpm dev:web
```

构建桌面应用：

```bash
pnpm bundle:desktop -- --os win --arch x64
```

更多可用命令以根目录和目标包的 `package.json` 为准。

## 手动发布

在 GitHub Actions 中从 `main` 手动运行 **Release Windows EXE** 或 **Release CentOS 7 ZIP**。两条流水线都只打包和发布，不运行测试。输入符合当前 `package.json` 版本且未使用过的标签，例如 Windows 用 `v3.14.3-omp.1`，CentOS 7 用 `v3.14.3-omp.2-centos7`；按需选择预发布。标签和资产相互独立，不修改 Windows 安装包。

CentOS 7 流水线发布一个自包含的 `OmpCode-<version>-centos7-x64.zip` 和可选的 `.sha256` 校验文件。将 ZIP 复制到离线机器，以普通用户解压运行：

```bash
sha256sum --check OmpCode-3.14.3-centos7-x64.zip.sha256
unzip -q OmpCode-3.14.3-centos7-x64.zip -d "$HOME"
"$HOME/OmpCode-3.14.3-centos7-x64/bin/ompcode-centos7"
```

无需 root、包管理器、网络、升级宿主 glibc/Node/omp，也无需另装运行时库。ZIP 内含独立用户态、中文字体、Electron、PRoot 与 omp；宿主仍需图形会话与 `ptrace`。**兼容环境无法启用 Chromium 沙箱**，只在可信工作区中使用。工作区不在家目录时，从该目录启动，或设置 `OMPCODE_CENTOS7_BIND=/工作区绝对路径`。ZIP 不注册宿主桌面入口或 `zcode://` 处理器。

按 [Electron 官方平台政策](https://github.com/electron/electron#platform-support)，已停止维护的 CentOS 7 不属于正式支持范围；在原生 3.10 内核上观察到 PRoot 的 seccomp 加速崩溃，因此兼容启动器禁用该加速。

## 项目来源

OmpCode 基于 [ZCode](https://github.com/zai-org/ZCode) 开发，延续其桌面界面与视觉风格；Agent 内核替换为 [omp（oh-my-pi）](https://github.com/can1357/oh-my-pi)，通过 [omp 适配器](packages/omp-agent/)接入。感谢两个上游项目及其贡献者。

本项目采用 [Apache License 2.0](LICENSE)。第三方版权与项目声明见 [NOTICE.md](NOTICE.md)。
