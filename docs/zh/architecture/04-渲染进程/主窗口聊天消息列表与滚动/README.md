# 10-主窗口聊天消息列表与滚动

本文说明主窗口与 Agents 会话中**消息列表的布局、滚动方向、发送时触底**，以及**流式输出时视口为何能跟在最新内容附近**。涉及的实现主要在渲染进程 `src/renderer/src/pages/home/Messages/` 与 Agents 侧复用同一套容器的组件。

## 相关源码

| 职责 | 路径 |
| --- | --- |
| 主聊天消息列表、无限滚动、触底监听 | `src/renderer/src/pages/home/Messages/Messages.tsx` |
| 滚动容器与 Flex 方向 | `src/renderer/src/pages/home/Messages/shared.tsx` |
| 发送时发出事件 | `src/renderer/src/pages/home/Inputbar/Inputbar.tsx` |
| Agents 会话消息列表（同源滚动逻辑） | `src/renderer/src/pages/agents/components/AgentSessionMessages.tsx` |
| 事件名 | `src/renderer/src/services/EventService.ts`（`SEND_MESSAGE` 等） |
| 滚动位置持久化 | `src/renderer/src/hooks/useScrollPosition.ts` |

## 布局：`column-reverse` 在做什么

`MessagesContainer`（外层可滚动）与 `ScrollContainer`（内层消息列）均使用 **`flex-direction: column-reverse`**（见 `shared.tsx`）。主聊天外层还包了一层 `NarrowLayout`，同样为 `column-reverse`。

含义（竖直 Flex）：

- **第一个 Flex 子节点**会贴在主轴起点，在 `column-reverse` 下通常对应**视口偏下、靠近「最新对话」的一侧**。
- **最后一个子节点**在**视口偏上**，对应更早的消息。

`column-reverse` **只改变子项在主轴上的叠放顺序**，**不会**按时间戳自动排序。要让「旧在上、新在下」符合常见聊天习惯，**数组顺序必须与该布局配套**（见下文「DOM 顺序与数据顺序」）。

主聊天页在 `InfiniteScroll` 上使用 **`inverse`**（`react-infinite-scroll-component`），与反向列表配套：向「更早消息」方向滑动时加载更多历史。

## 发送时主动触底：事件 + `scrollTo({ top: 0 })`

用户点击发送后，`Inputbar` 会触发：

- `EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId, traceId })`

`Messages.tsx` / `AgentSessionMessages.tsx` 中订阅 `SEND_MESSAGE`，在 **`requestAnimationFrame`** 里执行：

```ts
scrollContainerRef.current.scrollTo({ top: 0 })
```

即项目里所谓的「滚到底」对应 **`scrollTop === 0`**，而不是正向列表常用的 `scrollTop ≈ scrollHeight - clientHeight`。

源码注释说明：**不要使用 `behavior: 'smooth'`**。平滑滚动动画尚未结束时，流式内容高度仍在变化，容易导致滚动目标不准或无法持续贴在最新区域。

## 流式输出过程中有没有「每段内容滚一次」？

**没有**在流式 token / 消息块每次更新时再次全局 `scrollTo` 或再次 `emit` 触底。

实际组合是：

1. **发送瞬间**已通过 `SEND_MESSAGE` 把容器对齐到「最新一侧」（`top: 0`）。
2. 助手气泡高度随流式变高时，依赖 **反向 Flex 布局** 与浏览器对滚动容器在 **内容高度变化** 时的默认行为（例如 scroll anchoring），使视口在已对齐状态下**观感上仍跟在最新内容附近**。

**未实现**的行为：检测用户是否「离开底部一定距离」，仅在贴近底部时才跟流；若用户已向上翻阅历史，流式更新**不会**在代码层面被强制拉回底部。

## 为何有 `column-reverse` 还要在数据上「反序」？

若 Redux / 数据源中消息为时间**正序** `[旧, …, 新]`，且**不做任何顺序调整**，直接按该顺序生成 Flex 子节点，再套 `column-reverse`：

- DOM 第一个子项 = 最旧 → 会贴在**视口下方**；
- DOM 最后一个 = 最新 → 在**视口上方**。

这与「最新在屏幕下方」的常见聊天布局相反。

因此项目**在数据层**把用于渲染的列表调成与 `column-reverse` 一致，而不是指望 CSS 单独完成时间排序：

- **主聊天**：`computeDisplayMessages` 从 `messages` **末尾向前**取数，得到 **`displayMessages` 为「新在前」**；分组后对每组再 `toReversed()`，与组内展示顺序对齐（见 `Messages.tsx` 中注释与 `groupedMessages` 的 `useMemo`）。
- **Agents 会话**：`displayMessages = [...messages].reverse()`（见 `AgentSessionMessages.tsx`）。

可记一张对应表：

| 期望视觉效果（`column-reverse`） | 列表数据上更靠前的应是 |
| --- | --- |
| 最新在屏幕**下** | **较新**的对话组 / 消息（「新在前」的数组） |

## 与其它滚动逻辑的区分

- **`LOCATE_MESSAGE:*`**、`MessageGroup` / `Message` 中的 **`scrollIntoView`**：用于定位某条消息、编辑高亮、多模型切换等，**不是**流式跟底的主路径。
- **`useScrollPosition`**：按 `topic-${topic.id}` 等 key 把 `scrollTop` 存到 `keyv`，切换话题时恢复滚动位置，与「发送触底」独立。

## 小结

| 问题 | 结论 |
| --- | --- |
| 流式时谁在滚？ | 发送时 **`SEND_MESSAGE` → `scrollTo({ top: 0 })`**；流式过程中**无**逐块全局滚动代码。 |
| 为何是 `top: 0`？ | 反向列表 + 无限滚动 `inverse` 下，**「锚在最新区域」**对应 **`scrollTop === 0`**。 |
| `column-reverse` 会代替 reverse 数组吗？ | **不会**。顺序靠 **`computeDisplayMessages` / `.reverse()` / 组内 `toReversed()`** 与布局对齐。 |
| 用户上滑看历史时还会被流式拽回底部吗？ | 当前**没有**「仅接近底部才跟流」的检测逻辑。 |
