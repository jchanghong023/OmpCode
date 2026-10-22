# desktop-runtime-compat-preload

- Owner: desktop-runtime。模块是 preload adapters 层，只负责把可信、编译期确定、自包含的安装函数放入页面主世界；公开入口为 `mainWorld.ts` 与 `contract.ts`。
- 输入只来自 preload 源码。参数仅为 JSON 数据；不能接受页面提供的源码、函数或 IPC channel。安装器本身、Electron 对象及通用执行能力绝不经 contextBridge 暴露给 renderer。
- Electron 原生 `contextBridge.executeInMainWorld` 存在时原样执行，不包装回调、不改变同步行为。仅缺少此能力时使用 `webFrame.executeJavaScript`，参数经 JSON 编码；不插入受页面 CSP 影响的 script 标签。
- 回退调用只提交固定安装函数，不给不可信页面提供 eval 绕过。现有页面桥的回调、事件和取消订阅均在主世界创建与管理，不跨隔离世界复制函数状态。调用方先暴露限定业务 native bridge，再提交使用它的页面安装函数；独立安装脚本不依赖异步返回值。
- 页面导航销毁安装结果；每次文档 preload 重新安装。安装失败记录现有 console 错误，不静默制造成功结果。模块不拥有业务状态、事件队列、重试或持久化。
- `contract.test.ts` 描述原生路径优先、回退参数编码、主世界回调及取消、无通用 evaluator 暴露；测试源码的存在不代表已运行。页面生命周期保留由 plugin-ui 页面承载层负责，不属于本模块。
