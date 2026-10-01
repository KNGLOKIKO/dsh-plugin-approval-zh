/**
 * @local/approval-zh — DSH Host 半边（ESM 入口）。
 *
 * 职责：给「权限确认窗口」的**授权原因**提供兜底翻译。
 *
 * 分工（与用户确认的方案一致：本地词表优先 + model_router 兜底）：
 *  - 客户端 client.js 负责面板重绘与**本地词表**翻译：即时、离线、不耗配额；
 *  - 本文件负责词表未收录的英文原因：在审批请求进入浏览器之前，
 *    用 model_router 翻成中文并写回 req.reason，浏览器端即可直接显示中文。
 *
 * 安全约束（用户要求：不可以出现报错、断链等影响实际使用的情况）：
 *  1. apply() 全程防御式，任何环节失败都只降级，绝不抛错、绝不让 Loader 条目失败；
 *  2. 翻译带硬性时间预算（默认 2500ms），超时立即放行，绝不拖住审批弹窗；
 *  3. 只读不拦截：监听器永远 `return next()`，不消费审批决定；
 *  4. 只在「原因是非中文文本」时动手，已中文化的文案原样透传；
 *  5. 任何情况下都不会修改审批结果、不会新增 session 事件。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))

export const name = 'approval-zh'

/**
 * 兜底翻译用的 model-router 库位置，按以下顺序解析：
 *   1. config.libraryPath（显式配置优先）
 *   2. 环境变量 APPROVAL_ZH_MODEL_ROUTER
 *   3. 与本 bundle **同级**的 `../model-router/index.js`
 *
 * 第 3 条让「克隆两个仓库放在同一目录」即可开箱可用；解析不到时 `require`
 * 会抛错并被捕获，插件静默降级为「只用客户端本地词表」，审批流程不受影响。
 */
function defaultLibraryPath() {
  const fromEnv = process.env.APPROVAL_ZH_MODEL_ROUTER
  if (fromEnv) return fromEnv
  return join(HERE, '..', 'model-router', 'index.js')
}

const DEFAULT_BUDGET_MS = 2500

/** 已含中日韩统一表意文字，说明上游已给出中文文案，直接透传。 */
function hasCJK(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(value)
}

function warn(ctx, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.warn === 'function') logger.warn('[approval-zh] ' + message)
  } catch {
    /* 日志失败不影响插件 */
  }
}

/** 清掉模型可能附带的引号、代码围栏与前缀。 */
function tidy(text) {
  let out = String(text == null ? '' : text).trim()
  out = out.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  out = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '')
  out = out.replace(/^(译文|翻译|中文)\s*[:：]\s*/, '')
  return out.trim()
}

function buildTranslator(ctx, config) {
  const libraryPath = (config && config.libraryPath) || defaultLibraryPath()
  const budgetMs = Number(config && config.translateBudgetMs) > 0
    ? Number(config.translateBudgetMs)
    : DEFAULT_BUDGET_MS
  const enabled = !config || config.useModelRouter !== false

  if (!enabled) return async () => null

  let router
  try {
    router = require(libraryPath)
  } catch (error) {
    warn(ctx, 'model-router 库不可用（' + libraryPath + '）：' + (error && error.message))
    return async () => null
  }
  if (!router || typeof router.route !== 'function') {
    warn(ctx, 'model-router 库未导出 route()，兜底翻译关闭')
    return async () => null
  }

  const cache = new Map()
  const inflight = new Map()

  return function translate(text) {
    if (cache.has(text)) return Promise.resolve(cache.get(text))
    if (inflight.has(text)) return inflight.get(text)

    const prompt =
      '把下面的英文界面提示翻译成简体中文。要求：只输出译文本身，' +
      '不要引号、不要解释、不要保留英文原文、不要换行。\n' +
      '原文：' + text

    const work = new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, budgetMs)
      Promise.resolve()
        .then(() => router.route('chat', prompt))
        .then((result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const zh = tidy(result && result.text)
          if (zh && hasCJK(zh)) {
            cache.set(text, zh)
            resolve(zh)
          } else {
            resolve(null)
          }
        })
        .catch(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(null)
        })
    }).finally(() => {
      inflight.delete(text)
    })

    inflight.set(text, work)
    return work
  }
}

export function apply(ctx, config = {}) {
  const translate = buildTranslator(ctx, config)

  const listener = async (req, next) => {
    try {
      const reason = req && typeof req.reason === 'string' ? req.reason : ''
      if (reason && !hasCJK(reason) && !Object.isFrozen(req)) {
        const zh = await translate(reason)
        if (zh) req.reason = zh
      }
    } catch (error) {
      warn(ctx, '原因翻译失败（已放行）：' + (error && error.message))
    }
    return next()
  }

  try {
    ctx.on('agent/created', (agent) => {
      const scope = agent && agent.ctx
      if (!scope || typeof scope.effect !== 'function' || typeof scope.on !== 'function') return
      try {
        // 注册在 agent 作用域上：随 agent 释放而移除，插件卸载时也会一并清掉。
        scope.effect(() => scope.on('approval/request', listener), 'approval-zh: reason translation')
      } catch (error) {
        warn(ctx, '无法为 agent 注册审批监听：' + (error && error.message))
      }
    })
  } catch (error) {
    warn(ctx, '无法监听 agent/created：' + (error && error.message))
  }
}

// 供 selftest 复用
export const __internal = { hasCJK, tidy }
