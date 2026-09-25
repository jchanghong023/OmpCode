# OmpCode

<p align="center">
  <img src="public/logo/icons/1024x1024.png" alt="OmpCode 图标" width="96" />
</p>

<h3 align="center">omp 最好的桌面版本</h3>

<p align="center">
  ZCode 风格的界面，完整适配 omp 的内核与交互。<br />
  把 omp 的全部功能和所有斜杠命令，带进一个专为 AI 编程打造的桌面工作台。
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#项目来源">项目来源</a>
</p>

## 看看 OmpCode

**在熟悉的桌面界面里，直接使用完整的 omp。** 任务、工具调用、文件改动和会话状态集中呈现，专注写代码，无需在终端与多个窗口之间来回切换。

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

**每条 omp 斜杠命令都触手可及。** 在输入框键入 `/`，浏览命令并直接执行。

<p align="center">
  <a href="docs/images/ompcode-commands.png">
    <img src="docs/images/ompcode-commands.png" alt="OmpCode 中的 omp 斜杠命令面板" width="100%" />
  </a>
</p>

## 为什么选择 OmpCode

- **完整的 omp 体验**：内部以 omp 为 Agent 核心，界面、会话和操作围绕 omp 设计，支持 omp 的全部功能。
- **所有斜杠命令**：完整接入 omp 命令目录；`/model`、`/switch`、`/compact`、`/mcp`、`/usage` 与技能命令都能在对话输入框中使用。
- **模型由你掌控**：复用 omp Profile、模型目录与配置；为各个模型角色选择模型和思考等级，也可以在会话中临时切换。
- **清晰的工作现场**：流式回复、工具调用、文件改动、上下文用量和压缩状态，都在同一工作区里可见。
- **桌面之外继续工作**：保留 Web 与手机远程访问体验，在不同设备上接续同一个工作流。
- **开源、可扩展**：界面与视觉风格参考 [ZCode](https://github.com/zai-org/ZCode)，Agent 能力来自 [omp（oh-my-pi）](https://github.com/can1357/oh-my-pi)。

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

## 项目来源

OmpCode 基于 [ZCode](https://github.com/zai-org/ZCode) 开发，延续其桌面界面与视觉风格；Agent 内核替换为 [omp（oh-my-pi）](https://github.com/can1357/oh-my-pi)，通过 [omp 适配器](packages/omp-agent/)接入。感谢两个上游项目及其贡献者。

本项目采用 [Apache License 2.0](LICENSE)。第三方版权与项目声明见 [NOTICE.md](NOTICE.md)。
