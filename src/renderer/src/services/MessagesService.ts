import { loggerService } from '@logger'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT, UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
import { getTopicById } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { messageBlocksSelectors, removeManyBlocks } from '@renderer/store/messageBlock'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Assistant, FileMetadata, Model, Topic, Usage } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { getTitleFromString } from '@renderer/utils/export'
import {
  createAssistantMessage,
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createMessage,
  resetMessage
} from '@renderer/utils/messageUtils/create'
import { filterContextMessages } from '@renderer/utils/messageUtils/filters'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import dayjs from 'dayjs'
import { t } from 'i18next'
import type { NavigateFunction } from 'react-router'

import { getAssistantById, getAssistantProvider, getDefaultModel } from './AssistantService'
import { EVENT_NAMES, EventEmitter } from './EventService'
import FileManager from './FileManager'

const logger = loggerService.withContext('MessagesService')

export {
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterMessages,
  filterUsefulMessages,
  filterUserRoleStartMessages,
  getGroupedMessages
} from '@renderer/utils/messageUtils/filters'

export function getContextCount(assistant: Assistant, messages: Message[]) {
  const settingContextCount = assistant?.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT
  const actualContextCount = settingContextCount === MAX_CONTEXT_COUNT ? UNLIMITED_CONTEXT_COUNT : settingContextCount

  const contextMsgs = filterContextMessages(messages, actualContextCount)

  return {
    current: contextMsgs.length,
    max: settingContextCount
  }
}

/** @deprecated Use safeDeleteFiles instead */
export async function deleteMessageFiles(message: Message) {
  const state = store.getState()
  const fileDataList: FileMetadata[] = []

  message.blocks?.forEach((blockId) => {
    const block = messageBlocksSelectors.selectById(state, blockId)
    if (block && (block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE)) {
      const fileData = (block as any).file as FileMetadata | undefined
      if (fileData) {
        fileDataList.push(fileData)
      }
    }
  })

  if (fileDataList.length > 0) {
    await FileManager.deleteFiles(fileDataList)
  }
}

// 删除列表中的文件
export async function safeDeleteFiles(filesToDelete: FileMetadata[]): Promise<void> {
  if (!filesToDelete || filesToDelete.length === 0) return

  try {
    await FileManager.deleteFiles(filesToDelete)
  } catch (error) {
    logger.error('Failed to delete files, may produce orphan files:', error as Error)
  }
}

export function isGenerating() {
  return new Promise((resolve, reject) => {
    const generating = store.getState().runtime.generating
    generating && window.toast.warning(i18n.t('message.switch.disabled'))
    generating ? reject(false) : resolve(true)
  })
}

export async function locateToMessage(navigate: NavigateFunction, message: Message) {
  await isGenerating()

  SearchPopup.hide()
  const assistant = getAssistantById(message.assistantId)
  const topic = await getTopicById(message.topicId)

  navigate('/', { state: { assistant, topic } })

  setTimeout(() => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  setTimeout(() => EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id), 300)
}

/**
 * Creates a user message object and associated blocks based on input.
 * This is a pure function and does not dispatch to the store.
 *
 * @param params - The parameters for creating the message.
 * @returns An object containing the created message and its blocks.
 */
export function getUserMessage({
  assistant,
  topic,
  type,
  content,
  files,
  // Keep other potential params if needed by createMessage
  mentions,
  usage
}: {
  assistant: Assistant
  topic: Topic
  type?: Message['type']
  content?: string
  files?: FileMetadata[]
  knowledgeBaseIds?: string[]
  mentions?: Model[]
  usage?: Usage
}): { message: Message; blocks: MessageBlock[] } {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel
  const messageId = uuid() // Generate ID here
  const blocks: MessageBlock[] = []
  const blockIds: string[] = []

  // 内容为空也应该创建空文本块
  if (content !== undefined) {
    // Pass messageId when creating blocks
    const textBlock = createMainTextBlock(messageId, content, {
      status: MessageBlockStatus.SUCCESS
    })
    blocks.push(textBlock)
    blockIds.push(textBlock.id)
  }
  if (files?.length) {
    files.forEach((file) => {
      if (file.type === FILE_TYPE.IMAGE) {
        const imgBlock = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
        blocks.push(imgBlock)
        blockIds.push(imgBlock.id)
      } else {
        const fileBlock = createFileBlock(messageId, file, { status: MessageBlockStatus.SUCCESS })
        blocks.push(fileBlock)
        blockIds.push(fileBlock.id)
      }
    })
  }

  // 直接在createMessage中传入id
  const message = createMessage(
    'user',
    topic.id, // topic.id已经是string类型
    assistant.id,
    {
      id: messageId, // 直接传入ID，避免冲突
      modelId: model?.id,
      model: model,
      blocks: blockIds,
      // 移除knowledgeBaseIds
      mentions,
      // 移除mcp
      type,
      usage
    }
  )

  // 不再需要手动合并ID
  return { message, blocks }
}

export function getAssistantMessage({ assistant, topic }: { assistant: Assistant; topic: Topic }): Message {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel

  return createAssistantMessage(assistant.id, topic.id, {
    modelId: model?.id,
    model: model
  })
}

export function getMessageModelId(message: Message) {
  return message?.model?.id || message.modelId
}

export function resetAssistantMessage(message: Message, model?: Model): Message {
  const blockIdsToRemove = message.blocks
  if (blockIdsToRemove.length > 0) {
    store.dispatch(removeManyBlocks(blockIdsToRemove))
  }

  return {
    ...message,
    model: model || message.model,
    modelId: model?.id || message.modelId,
    status: AssistantMessageStatus.PENDING,
    useful: undefined,
    askId: undefined,
    mentions: undefined,
    blocks: [],
    createdAt: new Date().toISOString()
  }
}

export async function getMessageTitle(message: Message, length = 30): Promise<string> {
  const content = getMainTextContent(message)

  if ((store.getState().settings as any).useTopicNamingForMessageTitle) {
    try {
      const tempMessage = resetMessage(message, {
        status: AssistantMessageStatus.SUCCESS,
        blocks: message.blocks
      })

      const titlePromise = fetchMessagesSummary({ messages: [tempMessage] })
      window.toast.loading({ title: t('chat.topics.export.wait_for_title_naming'), promise: titlePromise })
      const { text: title } = await titlePromise

      // store.dispatch(messageBlocksActions.upsertOneBlock(tempTextBlock))

      // store.dispatch(messageBlocksActions.removeOneBlock(tempTextBlock.id))
      if (title) {
        window.toast.success(t('chat.topics.export.title_naming_success'))
        return title
      }
    } catch (e) {
      window.toast.error(t('chat.topics.export.title_naming_failed'))
      logger.error('Failed to generate title using topic naming, downgraded to default logic', e as Error)
    }
  }

  let title = getTitleFromString(content, length)

  if (!title) {
    title = dayjs(message.createdAt).format('YYYYMMDDHHmm')
  }

  return title
}
/**
 * 检查指定助手（assistant）是否因速率限制（rate limit）而需要等待。
 *
 * 逻辑步骤如下：
 * 1. 获取该助手的 provider 并判断其是否有设置 rateLimit，如果没有则不受限制，返回 false。
 * 2. 获取该助手的第一个 topic 的 id，并根据此 id 查询该话题下的消息列表。
 * 3. 如果消息为空或只有一条消息，则直接返回 false（没有超出速率限制）。
 * 4. 计算最后一条消息的时间和当前时间的差值（单位：毫秒），再得到 provider 限定的最小间隔（毫秒）。
 * 5. 如果间隔小于限定值，则提示用户还需等待多少秒（四舍五入上取整），返回 true，表示“当前受速率限制，需要等待”。
 * 6. 若无上述情况，则返回 false，表示不受速率限制，可继续操作。
 */
export function checkRateLimit(assistant: Assistant): boolean {
  // 获取助手的 provider（服务提供者）
  const provider = getAssistantProvider(assistant)

  // 如果未设置速率限制，直接返回不受限制
  if (!provider?.rateLimit) {
    return false
  }

  // 获取当前助手的第一个话题 id
  const topicId = assistant.topics[0].id

  // 获取该话题下所有消息
  const messages = selectMessagesForTopic(store.getState(), topicId)

  // 如果该话题下消息为空或只有一条，认为不触发速率限制
  if (!messages || messages.length <= 1) {
    return false
  }

  // 当前时间（毫秒）
  const now = Date.now()
  // 最后一条消息
  const lastMessage = messages[messages.length - 1]
  // 最后一条消息的创建时间（毫秒）
  const lastMessageTime = new Date(lastMessage.createdAt).getTime()
  // 距离上次消息的时间差（毫秒）
  const timeDiff = now - lastMessageTime
  // 速率限制对应的最小等待时间（毫秒）
  const rateLimitMs = provider.rateLimit * 1000

  // 如果距离上次消息的时间还没到速率下限
  if (timeDiff < rateLimitMs) {
    const waitTimeSeconds = Math.ceil((rateLimitMs - timeDiff) / 1000)

    // 弹出提示告知用户需要等待
    window.toast.warning(t('message.warning.rate.limit', { seconds: waitTimeSeconds }))
    return true // 当前受速率限制
  }

  // 没有触发速率限制
  return false
}
