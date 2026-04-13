import { loggerService } from '@logger'
import type { Span } from '@opentelemetry/api'
import { AiProvider } from '@renderer/aiCore'
import { getMessageContent } from '@renderer/aiCore/plugins/searchOrchestrationPlugin'
import { DEFAULT_KNOWLEDGE_DOCUMENT_COUNT, DEFAULT_KNOWLEDGE_THRESHOLD } from '@renderer/config/constant'
import { getEmbeddingMaxContext } from '@renderer/config/embedings'
import { REFERENCE_PROMPT } from '@renderer/config/prompts'
import { addSpan, endSpan } from '@renderer/services/SpanManagerService'
import store from '@renderer/store'
import type { Assistant } from '@renderer/types'
import {
  type FileMetadata,
  type KnowledgeBase,
  type KnowledgeBaseParams,
  type KnowledgeReference,
  type KnowledgeSearchResult,
  SystemProviderIds
} from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { routeToEndpoint } from '@renderer/utils'
import type { ExtractResults } from '@renderer/utils/extract'
import { createCitationBlock } from '@renderer/utils/messageUtils/create'
import { isAzureOpenAIProvider, isGeminiProvider } from '@renderer/utils/provider'
import type { ModelMessage, UserModelMessage } from 'ai'
import { isEmpty } from 'lodash'

import { getProviderByModel } from './AssistantService'
import FileManager from './FileManager'
import type { BlockManager } from './messageStreaming'
import { estimateTextTokens } from './TokenService'

const logger = loggerService.withContext('RendererKnowledgeService')

export const getKnowledgeBaseParams = (base: KnowledgeBase): KnowledgeBaseParams => {
  const rerankProvider = getProviderByModel(base.rerankModel)
  const aiProvider = new AiProvider(base.model)
  const rerankAiProvider = new AiProvider(rerankProvider)

  // get preprocess provider from store instead of base.preprocessProvider
  const preprocessProvider = store
    .getState()
    .preprocess.providers.find((p) => p.id === base.preprocessProvider?.provider.id)
  const updatedPreprocessProvider = preprocessProvider
    ? {
        type: 'preprocess' as const,
        provider: preprocessProvider
      }
    : base.preprocessProvider

  const actualProvider = aiProvider.getActualProvider()

  let { baseURL } = routeToEndpoint(actualProvider.apiHost)

  const rerankHost = rerankAiProvider.getBaseURL()
  if (isGeminiProvider(actualProvider)) {
    baseURL = baseURL + '/openai'
  } else if (isAzureOpenAIProvider(actualProvider)) {
    baseURL = baseURL + '/v1'
  } else if (actualProvider.id === SystemProviderIds.ollama) {
    // LangChain生态不需要/api结尾的URL
    baseURL = baseURL.replace(/\/api$/, '')
  }

  logger.info(`Knowledge base ${base.name} using baseURL: ${baseURL}`)

  let chunkSize = base.chunkSize
  const maxChunkSize = getEmbeddingMaxContext(base.model.id)

  if (maxChunkSize) {
    if (chunkSize && chunkSize > maxChunkSize) {
      chunkSize = maxChunkSize
    }
    if (!chunkSize && maxChunkSize < 1024) {
      chunkSize = maxChunkSize
    }
  }

  return {
    id: base.id,
    dimensions: base.dimensions,
    embedApiClient: {
      model: base.model.id,
      provider: base.model.provider,
      apiKey: aiProvider.getApiKey() || 'secret',
      baseURL
    },
    chunkSize,
    chunkOverlap: base.chunkOverlap,
    rerankApiClient: {
      model: base.rerankModel?.id || '',
      provider: rerankProvider.name.toLowerCase(),
      apiKey: rerankAiProvider.getApiKey() || 'secret',
      baseURL: rerankHost
    },
    documentCount: base.documentCount,
    preprocessProvider: updatedPreprocessProvider
  }
}

export const getFileFromUrl = async (url: string): Promise<FileMetadata | null> => {
  logger.debug(`getFileFromUrl: ${url}`)
  let fileName = ''

  if (url && url.includes('CherryStudio')) {
    if (url.includes('/Data/Files')) {
      fileName = url.split('/Data/Files/')[1]
    }

    if (url.includes('\\Data\\Files')) {
      fileName = url.split('\\Data\\Files\\')[1]
    }
  }
  logger.debug(`fileName: ${fileName}`)
  if (fileName) {
    const actualFileName = fileName.split(/[/\\]/).pop() || fileName
    logger.debug(`actualFileName: ${actualFileName}`)
    const fileId = actualFileName.split('.')[0]
    const file = await FileManager.getFile(fileId)
    if (file) {
      return file
    }
  }

  return null
}

export const getKnowledgeSourceUrl = async (item: KnowledgeSearchResult & { file: FileMetadata | null }) => {
  if (item.metadata.source.startsWith('http')) {
    return item.metadata.source
  }

  if (item.file) {
    return `[${item.file.origin_name}](http://file/${item.file.name})`
  }

  return item.metadata.source
}

/**
 * searchKnowledgeBase
 * 从字符串query转换成向量（Embedding），再据此检索知识库。
 * 如果KnowledgeBase有设置rerank模型，则对初步搜索结果进行重排序（rerank）。
 */
export const searchKnowledgeBase = async (
  query: string,
  base: KnowledgeBase,
  rewrite?: string,
  topicId?: string,
  parentSpanId?: string,
  modelName?: string
): Promise<Array<KnowledgeSearchResult & { file: FileMetadata | null }>> => {
  // 1. 限制query的长度，避免嵌入模型的最大上下文限制被超出（防止embedding报错）
  const maxContext = getEmbeddingMaxContext(base.model.id)
  if (maxContext) {
    const estimatedTokens = estimateTextTokens(query)
    if (estimatedTokens > maxContext) {
      const ratio = maxContext / estimatedTokens
      query = query.slice(0, Math.floor(query.length * ratio))
    }
  }

  let currentSpan: Span | undefined = undefined

  try {
    const baseParams = getKnowledgeBaseParams(base)
    const documentCount = base.documentCount || DEFAULT_KNOWLEDGE_DOCUMENT_COUNT
    const threshold = base.threshold || DEFAULT_KNOWLEDGE_THRESHOLD

    // 跟踪一个Span过程，便于链路追踪或分析
    if (topicId) {
      currentSpan = addSpan({
        topicId,
        name: `${base.name}-search`,
        inputs: {
          query,
          rewrite,
          base: baseParams
        },
        tag: 'Knowledge',
        parentSpanId,
        modelName
      })
    }

    // 2. 字符串转换成向量 & 检索召回
    //    后端实际是把search这个字符串做embedding转为向量，然后与知识库内存储的向量做相似度检索，返回召回结果
    const searchResults: KnowledgeSearchResult[] = await window.api.knowledgeBase.search(
      {
        search: query || rewrite || '',
        base: baseParams
      },
      currentSpan?.spanContext()
    )

    // 3. 用阈值过滤掉得分较低的召回结果
    const filteredResults = searchResults.filter((item) => item.score >= threshold)

    // 4. 是否需要重排序（Rerank）
    //    rerank模型通常是一种更强的模型（比如cross-encoder），能结合query和召回文本再次打分做更优的排序
    let rerankResults = filteredResults
    if (base.rerankModel && filteredResults.length > 0) {
      rerankResults = await window.api.knowledgeBase.rerank(
        {
          search: rewrite || query,
          base: baseParams,
          results: filteredResults
        },
        currentSpan?.spanContext()
      )
    }

    // 5. 最终只返回限定数量的结果（数量受documentCount配置限制）
    const limitedResults = rerankResults.slice(0, documentCount)

    // 6. 补充文件（source）信息，方便后续展示
    const result = await Promise.all(
      limitedResults.map(async (item) => {
        const file = await getFileFromUrl(item.metadata.source)
        logger.debug(`Knowledge search item: ${JSON.stringify(item)} File: ${JSON.stringify(file)}`)
        return { ...item, file }
      })
    )

    if (topicId) {
      endSpan({
        topicId,
        outputs: result,
        span: currentSpan,
        modelName
      })
    }

    return result
  } catch (error) {
    logger.error(`Error searching knowledge base ${base.name}:`, error as Error)
    if (topicId) {
      endSpan({
        topicId,
        error: error instanceof Error ? error : new Error(String(error)),
        span: currentSpan,
        modelName
      })
    }
    throw error
  }
}

export const processKnowledgeSearch = async (
  extractResults: ExtractResults,
  knowledgeBaseIds: string[] | undefined,
  topicId: string,
  parentSpanId?: string,
  modelName?: string
): Promise<KnowledgeReference[]> => {
  if (
    !extractResults.knowledge?.question ||
    extractResults.knowledge.question.length === 0 ||
    isEmpty(knowledgeBaseIds)
  ) {
    logger.info('No valid question found in extractResults.knowledge')
    return []
  }

  const questions = extractResults.knowledge.question
  const rewrite = extractResults.knowledge.rewrite

  const bases = store.getState().knowledge.bases.filter((kb) => knowledgeBaseIds?.includes(kb.id))
  if (!bases || bases.length === 0) {
    logger.info('Skipping knowledge search: No matching knowledge bases found.')
    return []
  }

  // span 是一个用于追踪和记录操作过程的“追踪单元”对象，通常用于监控和分析请求链路（比如性能分析、日志关联等）。
  // 在这里，addSpan 用于创建一个新的 span，标记“knowledgeSearch”这一步骤的开始和相关输入，便于后续统计和调试。
  const span = addSpan({
    topicId,
    name: 'knowledgeSearch',
    inputs: {
      questions,
      rewrite,
      knowledgeBaseIds: knowledgeBaseIds
    },
    tag: 'Knowledge',
    parentSpanId,
    modelName
  })

  // 为每个知识库执行多问题搜索
  const baseSearchPromises = bases.map(async (base) => {
    // 为每个问题搜索并合并结果
    const allResults = await Promise.all(
      questions.map((question) =>
        searchKnowledgeBase(question, base, rewrite, topicId, span?.spanContext().spanId, modelName)
      )
    )

    // 合并结果并去重
    const flatResults = allResults.flat()
    const uniqueResults = Array.from(
      new Map(flatResults.map((item) => [item.metadata.uniqueId || item.pageContent, item])).values()
    ).sort((a, b) => b.score - a.score)

    // 转换为引用格式
    const result = await Promise.all(
      uniqueResults.map(
        async (item, index) =>
          ({
            id: index + 1,
            content: item.pageContent,
            sourceUrl: await getKnowledgeSourceUrl(item),
            metadata: item.metadata,
            type: 'file'
          }) as KnowledgeReference
      )
    )
    return result
  })

  // 汇总所有知识库的结果
  const resultsPerBase = await Promise.all(baseSearchPromises)
  const allReferencesRaw = resultsPerBase.flat().filter((ref): ref is KnowledgeReference => !!ref)
  endSpan({
    topicId,
    outputs: resultsPerBase,
    span,
    modelName
  })

  // 重新为引用分配ID
  return allReferencesRaw.map((ref, index) => ({
    ...ref,
    id: index + 1
  }))
}

/**
 * 处理知识库搜索结果中的引用
 * @param references 知识库引用
 * @param onChunkReceived Chunk接收回调
 */
export function processKnowledgeReferences(
  references: KnowledgeReference[] | undefined,
  onChunkReceived: (chunk: Chunk) => void
) {
  if (!references || references.length === 0) {
    return
  }

  for (const ref of references) {
    const { metadata } = ref
    if (!metadata?.source) {
      continue
    }

    switch (metadata.type) {
      case 'video': {
        onChunkReceived({
          type: ChunkType.VIDEO_SEARCHED,
          video: {
            type: 'path',
            content: metadata.source
          },
          metadata
        })
        break
      }
    }
  }
}

/**
 * 注入引用搜索提示到最近的用户消息。
 *
 * 该函数用于在用户最新的问题中，根据助手所配置的知识库，自动进行知识库检索，并将检索到的知识引用信息，按特定提示格式替换到该用户消息的内容中。
 *
 * 步骤说明：
 * 1. 检查助手是否绑定知识库，并且有用户消息；
 * 2. 找到最后一条消息，确认其为用户问题 role 为 user；
 * 3. 基于最后一条用户消息内容，调用知识库搜索，获取相关知识引用（knowledgeReferences）；
 * 4. 若没有找到可用引用则返回；
 * 5. 构建引用块并将其插入，便于后续渲染参考信息；
 * 6. 用模板 REFERENCE_PROMPT，通过替换 {question} 和 {references}，生成新的消息内容 knowledgeSearchPrompt；
 * 7. 将 knowledgeSearchPrompt 设置到用户消息内容中。如果 content 为字符串则直接替换，如果是数组则替换或追加 text 类型部分。
 */
export const injectUserMessageWithKnowledgeSearchPrompt = async ({
  modelMessages,
  assistant,
  assistantMsgId,
  topicId,
  blockManager,
  setCitationBlockId
}: {
  modelMessages: ModelMessage[]
  assistant: Assistant
  assistantMsgId: string
  topicId?: string
  blockManager: BlockManager
  setCitationBlockId: (blockId: string) => void
}) => {
  // 若助手未配置知识库或者当前无用户消息，则不处理
  if (!(assistant.knowledge_bases?.length && modelMessages.length > 0)) {
    return
  }

  // 取出最后一条用户消息
  const lastUserMessage = modelMessages[modelMessages.length - 1]

  // 判断是否真的是用户消息
  if (lastUserMessage.role !== 'user') {
    return
  }

  // 基于用户消息进行知识库检索，返回引用
  const knowledgeReferences = await getKnowledgeReferences({
    assistant,
    lastUserMessage,
    topicId: topicId
  })

  // 没有引用内容则无需处理
  if (knowledgeReferences.length === 0) {
    return
  }

  // 插入引用块
  await createKnowledgeReferencesBlock({
    assistantMsgId,
    knowledgeReferences,
    blockManager,
    setCitationBlockId
  })

  // 取出用户问题和引用内容
  const question = getMessageContent(lastUserMessage) || ''
  const references = JSON.stringify(knowledgeReferences, null, 2)

  // 按模板生成新的用户消息内容
  const knowledgeSearchPrompt = REFERENCE_PROMPT.replace('{question}', question).replace('{references}', references)

  // 根据消息内容类型（字符串或数组）设置新的内容
  if (typeof lastUserMessage.content === 'string') {
    lastUserMessage.content = knowledgeSearchPrompt
  } else if (Array.isArray(lastUserMessage.content)) {
    const textPart = lastUserMessage.content.find((part) => part.type === 'text')
    if (textPart) {
      textPart.text = knowledgeSearchPrompt
    } else {
      lastUserMessage.content.push({
        type: 'text',
        text: knowledgeSearchPrompt
      })
    }
  }
}

export const getKnowledgeReferences = async ({
  assistant,
  lastUserMessage,
  topicId
}: {
  assistant: Assistant
  lastUserMessage: UserModelMessage
  topicId?: string
}) => {
  // 如果助手没有知识库，返回空字符串
  if (!assistant || isEmpty(assistant.knowledge_bases)) {
    return []
  }

  // 获取知识库ID
  const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)

  // 获取用户消息内容
  const question = getMessageContent(lastUserMessage) || ''

  // 获取知识库引用
  const knowledgeReferences = await processKnowledgeSearch(
    {
      knowledge: {
        question: [question],
        rewrite: ''
      }
    },
    knowledgeBaseIds,
    topicId!
  )

  // 返回提示词
  return knowledgeReferences
}

export const createKnowledgeReferencesBlock = async ({
  assistantMsgId,
  knowledgeReferences,
  blockManager,
  setCitationBlockId
}: {
  assistantMsgId: string
  knowledgeReferences: KnowledgeReference[]
  blockManager: BlockManager
  setCitationBlockId: (blockId: string) => void
}) => {
  // 创建引用块
  const citationBlock = createCitationBlock(
    assistantMsgId,
    { knowledge: knowledgeReferences },
    { status: MessageBlockStatus.SUCCESS }
  )

  // 处理引用块
  void blockManager.handleBlockTransition(citationBlock, MessageBlockType.CITATION)

  // 设置引用块ID
  setCitationBlockId(citationBlock.id)

  // 返回引用块
  return citationBlock
}
