# 09-构建测试与发布

## 构建系统概览

项目使用 `electron-vite` 作为 Electron 应用构建器，并结合 workspace 包一起工作。

从 `package.json` 和 `electron.vite.config.ts` 可以看到三类构建对象：

- 主进程构建
- preload 构建
- renderer 构建

## `electron.vite.config.ts` 的关键信息

### 主进程

- 配置了 `@main`、`@shared`、`@logger` 等别名
- 将大部分依赖 external 化
- 在生产环境尽量减少多余输出

### preload

- 使用 React SWC 插件处理 TS decorators
- 提供 `@shared` 与 trace 相关别名

### renderer

- 使用 React SWC
- 使用 Tailwind Vite 插件
- 支持可选 bundle visualizer
- 定义多个 HTML 输入入口

## Workspace 包如何参与构建

renderer 的 alias 直接把若干包映射到源码目录：

- `@cherrystudio/ai-core`
- `@cherrystudio/extension-table-plus`
- `@cherrystudio/ai-sdk-provider`

这意味着开发态和构建态都可以直接消费 workspace 源码，而不必先发布成外部 npm 包。

## 常用开发命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动开发环境 |
| `pnpm debug` | 带调试端口启动 |
| `pnpm build` | 类型检查后打包 |
| `pnpm build:check` | lint + openapi 检查 + test |
| `pnpm lint` | oxlint + eslint + typecheck + i18n + format |
| `pnpm test` | Vitest 全量测试 |
| `pnpm format` | Biome 格式化与 lint 写回 |

## 测试结构

测试体系不是单套配置，而是多 project：

- `main`
- `renderer`
- `aiCore`
- `shared`
- `scripts`

这样做的好处是：

- Node 环境与 jsdom 环境可以分离
- 包级能力可以单独验证
- Electron 项目中的不同执行上下文更容易被正确测试

## 发布与工程约束

工程脚本里还包含：

- OpenAPI 生成与校验
- i18n 同步与检查
- agents schema 生成与推送
- bundle 分析
- changeset 发布流程

说明这个项目不仅是功能型应用，也有较成熟的工程化基础设施。

## 工程原则总结

```mermaid
flowchart LR
  Code[源码]
  Lint[Lint / Format]
  Type[Typecheck]
  Test[Test]
  Build[Electron Build]
  Release[Release / Publish]

  Code --> Lint --> Type --> Test --> Build --> Release
```

## 对理解架构有什么帮助

看构建配置可以反推出几个架构事实：

- 这是多入口桌面应用，而不是单网页。
- 这是多包协作工程，而不是单仓单应用。
- AI Core、Trace、Provider 扩展被当作一级模块对待。
- 主进程、preload、renderer 的边界在构建层也被明确区分。

因此，构建系统本身就是架构的一部分，而不只是“打包脚本”。

