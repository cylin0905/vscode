# iShell

**基于 VS Code（Code - OSS 1.143）深度定制的"终端 + 本地 AI"一体化开发环境。**

iShell 在 VS Code 内核基础上，内置 SSH 远程终端与完全离线的本地大模型工作台，去除了 Microsoft 专属服务与遥测，扩展市场替换为 [open-vsx](https://open-vsx.org)。

## 核心特性

### SSH 远程终端
- 连接管理：SSH 主机配置、密码/密钥认证、host key 校验（从 key blob 解析算法，避免连接崩溃）
- xterm.js 终端编辑器：远程会话直接作为编辑器标签页打开，支持会话中命令插入确认按钮
- 终端体验优化与 iShell 应用图标

### 本地大模型工作台（llama.cpp）
完全本地运行，无需任何云服务与 API Key：

- **模型广场**：预置 Qwen / DeepSeek / Llama 系列 GGUF 模型目录（Q4_K_M 量化），品牌专属本地图标（本地静态资源，无在线依赖），模型搜索过滤，下载进度条带实时速度显示（MB/s），按机器内存自动推荐适配模型
- **网络模型搜索**：左侧视图支持关键词检索 HuggingFace 上的 GGUF 模型仓库，跟随下载源自动切换官方/国内镜像（hf-mirror.com），防抖请求 + 过期结果丢弃，可打开模型主页或复制模型 ID
- **引擎管理**：llama.cpp llama-server 引擎一键下载（支持 GitHub 直连 / gh-proxy 加速通道），启动后自动开启 OpenAI 兼容 API 网关
- **对话 Agent**：内置 Chat 参与者"iShell 本地模型"，多轮对话上下文、流式输出、Skill 指令注入、打断续聊
- **指令跟随（渐进式编辑）**：模型回答中的 `### ishell:write` / `### ishell:edit` / `### ishell:terminal` 指令块边生成边执行——围栏闭合即落盘，无需等待完整回答；写文件自动保存、三方合并冲突检测、终端命令经确认按钮插入
- **版本历史**：每次模型编辑自动生成版本快照，支持回滚、预览与差异对比
- **智能补全**：编辑器内联补全，基于光标前后文上下文
- **快速修复**：诊断问题一键交回模型重写（QuickFix 集成），编辑未命中自动"重新思考"修复
- **静态诊断**：内置规则引擎（语法/逻辑/bug/性能），保存时自动分析并归档报告
- **产物持久化**：对话记录、代码块、诊断报告自动归档，支持命名规则与目录配置
- **Skill 体系**：内置技能 + 用户目录加载 + 扩展注册，触发词命中自动注入 system prompt
- **日志面板**：系统/引擎/下载/网关/对话五源日志实时查看

### 其他
- 品牌与产品名全量替换为 iShell，移除 Microsoft 专属服务
- 扩展市场默认指向 open-vsx

## 构建与运行（Windows）

```powershell
# 环境要求：Node.js >= 20，Python 3.x（VS Code 构建脚本依赖）
npm install        # 安装依赖（首次约 10 分钟）
npm run compile    # 编译（tsgo，约 1 分钟）
npm run watch      # 开发模式，增量编译
```

启动调试：VS Code 打开本仓库，按 `F5` 启动"iShell"实例。

## 测试

```powershell
# 运行 iShell 模块全部单元测试
npm run test-node -- --run-glob "vs/workbench/contrib/ishell/test/node/*.test.js"

# 单文件运行示例
npm run test-node -- --run src/vs/workbench/contrib/ishell/test/node/llmCatalog.test.js
```

覆盖指令解析、三方合并、产物存储、诊断引擎、Skill 注册、模型目录、下载器、API 网关、网络搜索等 10 个测试套件。

## 目录结构

自定义模块全部位于 `src/vs/workbench/contrib/ishell/`，按进程边界分层：

```
ishell/
├── common/          # 渲染/主进程共享契约（类型 + 指令解析 + 三方合并）
├── node/            # Node 能力（引擎、下载、网关、目录、诊断、Skill、版本历史）
├── electron-main/   # 主进程服务（IPC 编排、引擎进程管理）
├── electron-sandbox/# 渲染进程服务代理
├── browser/         # UI（模型广场、侧边栏、Chat Agent、补全、诊断、日志）
└── test/node/       # 单元测试
```

## 许可证

[MIT](LICENSE.txt)，基于 [microsoft/vscode](https://github.com/microsoft/vscode) 衍生。上游贡献请遵循 [VS Code 贡献指南](https://github.com/microsoft/vscode/wiki/How-to-Contribute)。
