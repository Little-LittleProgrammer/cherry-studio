import { loggerService } from '@logger'
import type { AppDispatch, RootState } from '@renderer/store'
import { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

const logger = loggerService.withContext('BlockManager')

interface ActiveBlockInfo {
  id: string
  type: MessageBlockType
}

interface BlockManagerDependencies {
  dispatch: AppDispatch
  getState: () => RootState
  saveUpdatedBlockToDB: (
    blockId: string | null,
    messageId: string,
    topicId: string,
    getState: () => RootState
  ) => Promise<void>
  saveUpdatesToDB: (
    messageId: string,
    topicId: string,
    messageUpdates: Partial<any>,
    blocksToUpdate: MessageBlock[]
  ) => Promise<void>
  assistantMsgId: string
  topicId: string
  // 节流器管理从外部传入
  throttledBlockUpdate: (id: string, blockUpdate: any) => void
  cancelThrottledBlockUpdate: (id: string) => void
}

/**
 * BlockManager - 消息块管理器
 *
 * ## 职责
 * 管理流式响应过程中消息块的生命周期，包括：
 * - 块的增量更新（节流/立即更新策略）
 * - 块类型转换时的状态同步
 * - Redux store 与数据库的持久化协调
 *
 * ## 核心概念
 * - **ActiveBlockInfo**: 当前正在流式传输的活跃块信息 { id, type }
 * - **lastBlockType**: 上一个处理的块类型，用于检测块类型切换
 * - **智能更新策略**: 同类型块使用节流更新，类型切换时立即更新
 *
 * ## 流式更新场景示例
 * ```
 * 用户输入 → LLM 流式响应
 *   ├─ 文本块 (TEXT) → 节流更新 (每 100ms 批量更新)
 *   ├─ 代码块 (CODE) → 立即更新 (类型切换)
 *   ├─ 文本块 (TEXT) → 立即更新 (类型切换)
 *   └─ 块完成 → 立即更新 + 清理状态
 * ```
 */
export class BlockManager {
  private deps: BlockManagerDependencies

  // ==================== 状态管理 ====================

  /**
   * 当前活跃块信息
   * - 流式传输过程中记录正在更新的块
   * - 块完成时会被清空 (null)
   * - 用于跨块更新时取消上一个块的节流更新
   */
  private _activeBlockInfo: ActiveBlockInfo | null = null

  /**
   * 上一个处理的块类型
   * - 用于检测块类型是否发生变化
   * - 类型变化时触发立即更新策略
   * - 保留用于错误处理场景
   */
  private _lastBlockType: MessageBlockType | null = null

  constructor(dependencies: BlockManagerDependencies) {
    this.deps = dependencies
  }

  // ==================== Getters ====================

  /** 获取当前活跃块信息 */
  get activeBlockInfo() {
    return this._activeBlockInfo
  }

  /** 获取上一个块类型 */
  get lastBlockType() {
    return this._lastBlockType
  }

  /**
   * 检查是否存在初始占位符块
   * - UNKNOWN 类型块用作流式响应开始时的占位符
   * - 用于在收到实际内容前显示 loading 状态
   */
  get hasInitialPlaceholder() {
    return this._activeBlockInfo?.type === MessageBlockType.UNKNOWN
  }

  /** 获取初始占位符块的 ID */
  get initialPlaceholderBlockId() {
    return this.hasInitialPlaceholder ? this._activeBlockInfo?.id || null : null
  }

  // ==================== Setters ====================

  set lastBlockType(value: MessageBlockType | null) {
    this._lastBlockType = value
  }

  set activeBlockInfo(value: ActiveBlockInfo | null) {
    this._activeBlockInfo = value
  }

  // ==================== 核心方法 ====================

  /**
   * 智能更新策略：根据块类型连续性自动判断使用节流还是立即更新
   *
   * ## 更新策略决策树
   * ```
   * isBlockTypeChanged || isComplete?
   *   ├─ YES → 立即更新
   *   │   ├─ 取消上一块的节流更新 (避免重复)
   *   │   ├─ dispatch 更新到 Redux
   *   │   ├─ 立即持久化到 DB
   *   │   └─ 更新 lastBlockType
   *   │
   *   └─ NO → 节流更新
   *       └─ 调用 throttledBlockUpdate (延迟批量更新)
   * ```
   *
   * ## 为什么需要智能策略？
   * 1. **节流更新**：同一文本块流式传输时，避免每字符都触发 DB 写入
   * 2. **立即更新**：块类型切换时，确保上一个块完整持久化后再开始新块
   * 3. **完成更新**：块结束时确保最终状态立即同步
   *
   * @param blockId 块 ID
   * @param changes 块的增量更新内容
   * @param blockType 当前块类型
   * @param isComplete 块是否已完成（流式传输结束）
   */
  smartBlockUpdate(
    blockId: string,
    changes: Partial<MessageBlock>,
    blockType: MessageBlockType,
    isComplete: boolean = false
  ) {
    // 检测块类型是否变化（首次进入时 lastBlockType 为 null，不算变化）
    const isBlockTypeChanged = this._lastBlockType !== null && this._lastBlockType !== blockType

    if (isBlockTypeChanged || isComplete) {
      // ---------- 立即更新分支 ----------

      // 如果块类型改变，取消上一个块的节流更新，避免重复写入
      if (isBlockTypeChanged && this._activeBlockInfo) {
        this.deps.cancelThrottledBlockUpdate(this._activeBlockInfo.id)
      }

      // 如果当前块完成，取消当前块的节流更新
      if (isComplete) {
        this.deps.cancelThrottledBlockUpdate(blockId)
        this._activeBlockInfo = null // 块完成，清空活跃块信息
      } else {
        // 块类型切换但未完成，更新活跃块信息为新块
        this._activeBlockInfo = { id: blockId, type: blockType }
      }

      // 立即更新 Redux store
      this.deps.dispatch(updateOneBlock({ id: blockId, changes }))
      // 立即持久化到数据库
      this.deps.saveUpdatedBlockToDB(blockId, this.deps.assistantMsgId, this.deps.topicId, this.deps.getState)
      // 记录当前块类型，用于下一次判断
      this._lastBlockType = blockType
    } else {
      // ---------- 节流更新分支 ----------
      // 同类型块的增量更新，使用节流策略减少 DB 写入频率
      this._activeBlockInfo = { id: blockId, type: blockType }
      this.deps.throttledBlockUpdate(blockId, changes)
    }
  }

  /**
   * 处理块转换
   *
   * ## 触发场景
   * - 流式响应从一种块类型切换到另一种时调用
   * - 例如：文本块 → 代码块 → 文本块
   *
   * ## 处理流程
   * 1. 更新内部状态 (lastBlockType, activeBlockInfo)
   * 2. 更新消息的 blockInstruction (指向新块)
   * 3. 插入新块到 Redux store
   * 4. 更新消息的块引用列表
   * 5. 持久化到数据库
   *
   * @param newBlock 新创建的消息块
   * @param newBlockType 新块的类型
   */
  async handleBlockTransition(newBlock: MessageBlock, newBlockType: MessageBlockType) {
    logger.debug('handleBlockTransition', { newBlock, newBlockType })

    // 更新内部状态
    this._lastBlockType = newBlockType
    this._activeBlockInfo = { id: newBlock.id, type: newBlockType }

    // 1. 更新消息的 blockInstruction，指向当前正在流式传输的块
    // blockInstruction 用于 UI 定位当前正在接收内容的块
    this.deps.dispatch(
      newMessagesActions.updateMessage({
        topicId: this.deps.topicId,
        messageId: this.deps.assistantMsgId,
        updates: { blockInstruction: { id: newBlock.id } }
      })
    )

    // 2. 插入新块到 Redux store (blocks slice)
    this.deps.dispatch(upsertOneBlock(newBlock))

    // 3. 更新消息的块引用列表 (message.blocks 数组)
    // 这一步将新块 ID 添加到消息的 blocks 数组中
    this.deps.dispatch(
      newMessagesActions.upsertBlockReference({
        messageId: this.deps.assistantMsgId,
        blockId: newBlock.id,
        status: newBlock.status,
        blockType: newBlock.type
      })
    )

    // 4. 持久化到数据库
    const currentState = this.deps.getState()
    const updatedMessage = currentState.messages.entities[this.deps.assistantMsgId]
    if (updatedMessage) {
      await this.deps.saveUpdatesToDB(this.deps.assistantMsgId, this.deps.topicId, { blocks: updatedMessage.blocks }, [
        newBlock
      ])
    } else {
      logger.error(
        `[handleBlockTransition] Failed to get updated message ${this.deps.assistantMsgId} from state for DB save.`
      )
    }
  }
}
