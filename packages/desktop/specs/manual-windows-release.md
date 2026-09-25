# 手动发布 Windows 安装包

## 产品规则

- 仅从 `main` 的手动 GitHub Actions 运行发布 Windows x64 安装包。操作者输入唯一的 `v<package.json version>-omp.<序号>` 标签，可选择是否标为预发布。
- 发布资产为生产环境的 `OmpCode-<version>-win-x64.exe` 和相应 SHA256 校验文件。安装包内嵌当前 omp fork release 的 Windows x64 二进制；不依赖用户本机安装 omp。
- 发布流水线只执行资源准备、桌面打包及发布资产上传，不另跑类型检查、Lint、协议测试或 GUI 测试。打包脚本自身的运行时依赖与体积检查仍属于打包步骤。
- Windows 安装器不要求代码签名；发布说明应明确当前为未签名包。

## 所有者与接口

- GitHub Actions 工作流拥有发布顺序及成功/失败判定；桌面 `bundle:desktop` 脚本拥有资源准备、打包及打包检查。工作流不复制打包实现。
- 工作流通过 `workflow_dispatch` 接收标签和预发布选项，使用当前提交的 `package.json` 校验版本。`GITHUB_TOKEN` 仅用于读取 omp release、创建本仓库 Release 及上传资产。
- GitHub Release 是公开分发状态的唯一所有者；失败的检查或打包不得创建公开 Release。已存在的标签或 Release 不被覆盖。

## 验收场景

1. 从 `main` 手动运行并输入匹配当前版本的未使用标签；打包完成后，Release 关联本次提交，EXE 与 SHA256 文件可下载，资产大小与本地安装器一致。
2. 输入不匹配当前版本的标签、从非 `main` 运行、或标签已存在时，发布前失败。
3. 资源准备、打包或产物上传失败时，Release 不公开发布。
