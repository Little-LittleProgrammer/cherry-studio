import { loggerService } from '@logger'
import {
  isAutoEnableImageGenerationModel,
  isGenerateImageModel,
  isGenerateImageModels,
  isMandatoryWebSearchModel,
  isVisionModel,
  isVisionModels,
  isWebSearchModel
} from '@renderer/config/models'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateTextTokens as estimateTxtTokens, estimateUserPromptUsage } from '@renderer/services/TokenService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type FileMetadata,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InputbarCore } from './components/InputbarCore'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const INPUTBAR_DRAFT_CACHE_KEY = 'inputbar-draft'
const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const getMentionedModelsCacheKey = (assistantId: string) => `inputbar-mentioned-models-${assistantId}`

const getValidatedCachedModels = (assistantId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(assistantId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<Props> = ({ assistant: initialAssistant, setActiveTopic, topic }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        actionsRef={actionsRef}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({ assistant: initialAssistant, setActiveTopic, topic, actionsRef }) => {
  const scope = topic.type ?? TopicType.Chat
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(INPUTBAR_DRAFT_CACHE_KEY) ?? '',
    onChange: (value) => CacheService.set(INPUTBAR_DRAFT_CACHE_KEY, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant } = useAssistant(initialAssistant.id)
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers } = useSettings()
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextCount, setContextCount] = useState({ current: 0, max: 0 })

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)
  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const isGenerateImageAssistant = useMemo(() => isGenerateImageModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const isGenerateImageSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isGenerateImageModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isGenerateImageAssistant),
    [mentionedModels, isGenerateImageAssistant]
  )

  const canAddImageFile = useMemo(() => {
    return isVisionSupported || isGenerateImageSupported
  }, [isGenerateImageSupported, isVisionSupported])

  const canAddTextFile = useMemo(() => {
    return isVisionSupported || (!isVisionSupported && !isGenerateImageSupported)
  }, [isGenerateImageSupported, isVisionSupported])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const onUnmount = useEffectEvent((id: string) => {
    CacheService.set(getMentionedModelsCacheKey(id), mentionedModels, DRAFT_CACHE_TTL)
  })

  useEffect(() => {
    return () => onUnmount(assistant.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.id])

  const placeholderText = enableQuickPanelTriggers
    ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
    : t('chat.input.placeholder_without_triggers', {
        key: getSendMessageShortcutLabel(sendMessageShortcut),
        defaultValue: t('chat.input.placeholder', {
          key: getSendMessageShortcutLabel(sendMessageShortcut)
        })
      })

  /**
   * sendMessage 用于发送用户输入消息的核心函数。
   *
   * 1. 首先检查速率限制（如请求太频繁则直接返回）。
   * 2. 启动日志记录和性能监控（trace），方便跟踪问题与性能分析。
   * 3. 触发 SEND_MESSAGE 事件，通知应用其他部分有新消息准备发送。
   * 4. 处理文件上传，如果用户发送了文件，先异步上传文件。
   * 5. 构建基本的消息参数对象（baseUserMessage），包括助理配置、话题、内容等，
   *    若有上传文件、@提及模型，也加入对应属性。
   * 6. 异步估算该消息的 token 用量，为后续计费或限制服务。
   * 7. 生成实际将要发送的消息对象和内容块（blocks）。
   * 8. 调用 dispatch，发送消息到 Redux store 以及执行对应的业务逻辑。
   * 9. 发送成功后，重置输入框内容、文件、主动调整 textarea 尺寸并重新聚焦输入框，
   *    以兼容部分中文输入法（如 fcitx5）的输入状态。
   * 10. 若有异常，记录日志并在性能跟踪中埋点异常细节方便排查。
   */
  const sendMessage = useCallback(async () => {
    // 步骤1: 检查速率限制
    if (checkRateLimit(assistant)) {
      return
    }

    // 步骤2: 日志记录
    logger.info('sendMessage: 开始发送消息')

    // 步骤3: 启动 trace 并发出 SEND_MESSAGE 事件
    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      mentionedModels.length > 0 ? mentionedModels : [assistant.model]
    )
    void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      // 步骤4: 上传文件（如果存在）
      const uploadedFiles = await FileManager.uploadFiles(files)

      // 步骤5: 构造消息参数
      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      // 步骤6: 预估输入 token 用量
      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      // 步骤7: 获取消息对象和 blocks
      const { message, blocks } = getUserMessage(baseUserMessage)
      message.traceId = parent?.spanContext().traceId

      // 步骤8: 触发消息发送
      // dispatch 是用于分发 Redux action 的函数，这里它将 _sendMessage action（包含消息内容、内容块、助理和话题 ID）分发到 Redux store，驱动后续消息发送的业务逻辑和状态更新。
      void dispatch(_sendMessage(message, blocks, assistant, topic.id))

      // 步骤9: 清空输入框和已选文件、调整 textarea 大小并重获焦点
      setText('')
      setFiles([])
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
      // 兼容某些输入法（如 fcitx5）的 IME 状态
      focusTextarea()
    } catch (error) {
      // 步骤10: 错误处理及埋点
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    assistant,
    topic,
    text,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setTimeoutTimer,
    resizeTextArea,
    focusTextarea
  ])

  const tokenCountProps = useMemo(() => {
    if (!config.showTokenCount || estimateTokenCount === undefined || !showInputEstimatedTokens) {
      return undefined
    }

    return {
      estimateTokenCount,
      inputTokenCount: estimateTokenCount,
      contextCount
    }
  }, [config.showTokenCount, contextCount, estimateTokenCount, showInputEstimatedTokens])

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      void onPause()
      return
    }
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const addNewTopic = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)

    await db.topics.add({ id: newTopic.id, messages: [] })

    if (assistant.defaultModel) {
      setModel(assistant.defaultModel)
    }

    addTopic(newTopic)
    setActiveTopic(newTopic)

    setTimeoutTimer('addNewTopic', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  }, [addTopic, assistant.defaultModel, assistant.id, setActiveTopic, setModel, setTimeoutTimer])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ ...assistant, knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, addNewTopic, clearTopic, onNewContext, setText, handleToggleExpanded, actionsRef])

  useShortcut(
    'new_topic',
    () => {
      void addNewTopic()
      void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true
  })

  useEffect(() => {
    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextCount }) => {
        _setEstimateTokenCount(tokensCount)
        setContextCount({ current: contextCount.current, max: contextCount.max })
      }),
      ...[EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic])

  useEffect(() => {
    const debouncedEstimate = debounce((value: string) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(value) || 0
        setEstimateTokenCount(count)
      }
    }, 500)

    debouncedEstimate(text)
    return () => debouncedEstimate.cancel()
  }, [showInputEstimatedTokens, text])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [
    topic.id,
    assistant.mcpServers,
    assistant.knowledge_bases,
    assistant.enableWebSearch,
    assistant.webSearchProviderId,
    mentionedModels,
    focusTextarea
  ])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    // Disable web search if model doesn't support it
    if (!isWebSearchModel(model) && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }

    // Clear web search provider if disabled or model has mandatory search
    if (
      assistant.webSearchProviderId &&
      (!WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId) || isMandatoryWebSearchModel(model))
    ) {
      updateAssistant({ ...assistant, webSearchProviderId: undefined })
    }

    // Auto-enable/disable image generation based on model capabilities
    if (isGenerateImageModel(model)) {
      if (isAutoEnableImageGenerationModel(model) && !assistant.enableGenerateImage) {
        updateAssistant({ ...assistant, enableGenerateImage: true })
      }
    } else if (assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  if (isMultiSelectMode) {
    return null
  }

  // topContent: 所有顶部预览内容
  const topContent = (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar = config.showTools ? <InputbarTools scope={scope} assistant={assistant} model={model} /> : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = (
    <>
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          inputTokenCount={tokenCountProps.inputTokenCount}
          contextCount={tokenCountProps.contextCount}
          onClick={onNewContext}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={loading}
      supportedExts={supportedExts}
      onPause={onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
    />
  )
}

export default Inputbar
