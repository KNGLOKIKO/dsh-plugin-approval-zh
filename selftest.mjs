/**
 * @local/approval-zh 离线自检（`node selftest.mjs`）。
 *
 * 不联网、不调用任何真实模型，也**不启动 DSH**：把 bundle 的四件套当作数据来校验，
 * 再用假 ctx / 假 React / 假 window 走一遍注册与渲染，确认：
 *   1. manifest 与 patch 的字段形状符合 DSH bundle 契约；
 *   2. 宿主半边可加载、apply() 不抛错、审批瀑布监听永远 return next()；
 *   3. 宿主半边在无 model-router / 冻结 req / 已中文化 三种情况下都不改动原因；
 *   4. 客户端半边注册到 conversation.composer，priority 0（抢先官方的 1）；
 *   5. 面板渲染出中文文案、本地词表命中与未命中两条路径都正确；
 *   6. 未命中时不丢信息（原文照显 + 提示）。
 */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + label)
  } else {
    failures.push(label + (detail === undefined ? '' : ' — ' + detail))
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

function section(title) {
  console.log('\n' + title)
}

/* ------------------------------------------------------------------ *
 * 1. manifest
 * ------------------------------------------------------------------ */
section('1. package.json (bundle manifest)')
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
check('name 是 @local/approval-zh', pkg.name === '@local/approval-zh', pkg.name)
check('type=module（host 半边按 ESM 加载）', pkg.type === 'module', pkg.type)
check('exports["."] 指向 index.js', pkg.exports && pkg.exports['.'] === './index.js')
check('exports["./client"] 指向 client.js', pkg.exports && pkg.exports['./client'] === './client.js')
check('dsh.bundle.patch 已声明', Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch))
check('dsh.client.platform=web', Boolean(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'))
check('dsh.client.inject 含 conversation 包',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
  JSON.stringify(pkg.dsh?.client?.inject))
check('dsh.client.inject 含 approval 包',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-approval'))

/* ------------------------------------------------------------------ *
 * 2. patch
 * ------------------------------------------------------------------ */
section('2. cordis.patch.yml')
const patch = await readFile(join(here, 'cordis.patch.yml'), 'utf8')
check('使用 - insert: 插入列表', /^- insert:/m.test(patch))
check('插入条目 id=approval-zh', /^\s*- id: approval-zh$/m.test(patch))
check("插入条目 name='@local/approval-zh'", /name:\s*'@local\/approval-zh'/.test(patch))
check('config 带 translateBudgetMs', /translateBudgetMs:/.test(patch))
check('patch 不含机器相关的绝对路径', !/[A-Za-z]:\\/.test(patch), '应为可移植配置')
check('文件里没有明文 API key', !/nvapi-|sk-[A-Za-z0-9]{16,}/.test(patch))

/* ------------------------------------------------------------------ *
 * 3. host half
 * ------------------------------------------------------------------ */
section('3. index.js（宿主半边）')
const host = await import(pathToFileURL(join(here, 'index.js')).href)
check('导出 name', host.name === 'approval-zh', host.name)
check('导出 apply 函数', typeof host.apply === 'function')
check('hasCJK 识别中文', host.__internal.hasCJK('需要提权') === true)
check('hasCJK 识别日文假名', host.__internal.hasCJK('テスト') === true)
check('hasCJK 对纯英文返回 false', host.__internal.hasCJK('Tool bash requires approval') === false)
check('tidy 去掉代码围栏', host.__internal.tidy('```\n需要提权\n```') === '需要提权', host.__internal.tidy('```\n需要提权\n```'))
check('tidy 去掉引号', host.__internal.tidy('“需要提权”') === '需要提权', host.__internal.tidy('“需要提权”'))
check('tidy 去掉“译文:”前缀', host.__internal.tidy('译文: 需要提权') === '需要提权', host.__internal.tidy('译文: 需要提权'))

// 假 ctx：捕获 agent/created 与 effect/on 的注册。
const warnings = []
function makeCtx() {
  const created = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    on(event, handler) {
      if (event === 'agent/created') created.push(handler)
      return () => {}
    },
  }
  return { ctx, created }
}

function makeScope() {
  const listeners = new Map()
  const scope = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
  return { scope, listeners }
}

const { ctx, created } = makeCtx()
let applyThrew = null
try {
  host.apply(ctx, { libraryPath: join(here, 'definitely-missing-library.cjs'), translateBudgetMs: 200 })
} catch (error) {
  applyThrew = error
}
check('apply() 不抛错', applyThrew === null, applyThrew && applyThrew.message)
check('注册了 agent/created 监听', created.length === 1, String(created.length))

const { scope, listeners } = makeScope()
created[0]({ ctx: scope })
check('在 agent.ctx 上注册了 approval/request 瀑布监听', listeners.has('approval/request'))
check('库缺失时仅 warn 不抛错', warnings.length >= 1, warnings.join(' | '))

const waterfall = listeners.get('approval/request')
const next = () => 'NEXT'

const reqEnglish = { reason: 'Tool bash requests privileged execution.', toolName: 'bash' }
const r1 = await waterfall(reqEnglish, next)
check('英文原因在库缺失时保持原样', reqEnglish.reason === 'Tool bash requests privileged execution.', reqEnglish.reason)
check('监听器返回 next() 的结果（不消费审批决定）', r1 === 'NEXT', String(r1))

const reqChinese = { reason: '工具 bash 请求越权执行' }
await waterfall(reqChinese, next)
check('已中文化的原因不重复处理', reqChinese.reason === '工具 bash 请求越权执行', reqChinese.reason)

const frozen = Object.freeze({ reason: 'Tool bash requests privileged execution.' })
let frozenThrew = null
try {
  const r = await waterfall(frozen, next)
  check('冻结的 req 不会抛错且返回 next()', r === 'NEXT', String(r))
} catch (error) {
  frozenThrew = error
}
check('冻结的 req 不抛错', frozenThrew === null, frozenThrew && frozenThrew.message)
check('冻结的 req 内容未被改动', frozen.reason === 'Tool bash requests privileged execution.')

// 有 model-router 时应写回中文（用临时 fixture 顶替真实库，不联网）。
const work = await mkdtemp(join(tmpdir(), 'approval-zh-selftest-'))
const fixturePath = join(work, 'fixture-router.cjs')
await writeFile(
  fixturePath,
  "module.exports = { route: async () => ({ text: '```\\n工具 bash 请求越权执行\\n```' }) }\n",
  'utf8'
)
const { ctx: ctx2, created: created2 } = makeCtx()
host.apply(ctx2, { libraryPath: fixturePath, translateBudgetMs: 1000 })
const { scope: scope2, listeners: listeners2 } = makeScope()
created2[0]({ ctx: scope2 })
const req2 = { reason: 'Tool bash requests privileged execution.', toolName: 'bash' }
const r2 = await listeners2.get('approval/request')(req2, next)
check('库可用时把原因改写成中文（并去掉围栏）', req2.reason === '工具 bash 请求越权执行', req2.reason)
check('改写后仍返回 next()', r2 === 'NEXT', String(r2))

// 超时保护：fixture 永不 resolve 时必须按时放行且不改动原文。
const slowPath = join(work, 'fixture-slow.cjs')
await writeFile(slowPath, 'module.exports = { route: () => new Promise(() => {}) }\n', 'utf8')
const { ctx: ctx3, created: created3 } = makeCtx()
host.apply(ctx3, { libraryPath: slowPath, translateBudgetMs: 120 })
const { scope: scope3, listeners: listeners3 } = makeScope()
created3[0]({ ctx: scope3 })
const req3 = { reason: 'Tool bash requests privileged execution.' }
const startedAt = Date.now()
const r3 = await listeners3.get('approval/request')(req3, next)
const elapsed = Date.now() - startedAt
check('超时后立即放行（<1500ms）', elapsed < 1500, elapsed + 'ms')
check('超时后返回 next()', r3 === 'NEXT', String(r3))
check('超时后原因保持原样', req3.reason === 'Tool bash requests privileged execution.', req3.reason)
await rm(work, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * 4. client half
 * ------------------------------------------------------------------ */
section('4. client.js（客户端半边）')
const clientSrc = await readFile(join(here, 'client.js'), 'utf8')

let captured = null
const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def } } }
// client.js 是浏览器脚本（非 ESM），在 Node 里用 Function 包一层执行。
// eslint-disable-next-line no-new-func
new Function('window', clientSrc)(fakeWindow)

check('通过 window.__ModuleLoader__.load 注册', captured !== null)
check('模块 id 等于包名', captured && captured.id === '@local/approval-zh', captured && captured.id)
check('导出 factory', captured && typeof captured.factory === 'function')

// 极简 React 替身：够跑通本插件用到的 createElement + 四个 Hook。
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {},
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        Object.assign(this.state, next)
      }
    },
  }
}

const React = makeReact()
const fakeRequire = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement }
  throw new Error('unexpected require: ' + name)
}

const clientModule = captured.factory(fakeRequire)
check('导出 apply 与 inject', typeof clientModule.apply === 'function' && Array.isArray(clientModule.inject))
check('inject 声明 slots 与 locale',
  clientModule.inject.includes('slots') && clientModule.inject.includes('locale'),
  JSON.stringify(clientModule.inject))

const localeRegistrations = []
const slotRegistrations = []
const slotInjects = []
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
const fakeCtx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts })
      return () => {}
    },
    resolveText: (text) => text,
  },
  slots: {
    inject(key, callback) {
      slotInjects.push(key)
      return callback()
    },
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
  },
}

let clientApplyThrew = null
try {
  clientModule.apply(fakeCtx)
} catch (error) {
  clientApplyThrew = error
}
check('client apply() 不抛错', clientApplyThrew === null, clientApplyThrew && clientApplyThrew.message)
check('注册了 locale 词表 approval-zh',
  localeRegistrations.some((r) => r.ns === 'approval-zh' && r.dicts && r.dicts.zh && r.dicts.zh.waiting === '等待审批'),
  JSON.stringify(localeRegistrations.map((r) => r.ns)))
check('向 conversation.composer 注入', slotInjects.includes('conversation.composer'), JSON.stringify(slotInjects))
check('只注册了一个槽位', slotRegistrations.length === 1, String(slotRegistrations.length))

const reg = slotRegistrations[0]
check('nameslot = conversation.composer', reg.options.name === 'conversation.composer', reg.options.name)
check('priority = 0（低于官方面板的 1，故抢先生效）', reg.options.priority === 0, String(reg.options.priority))
check('声明了 locale 命名空间', reg.options.locale === 'approval-zh', reg.options.locale)
check('select 是函数', typeof reg.options.select === 'function')
check('select 未声明 children（approval.detail 已被官方占用，声明会抛错）', reg.options.children === undefined)
check('select 对 approval 命中',
  (() => { const p = { kind: 'approval' }; return reg.options.select({ pendingInteraction: p }) === p })())
check('select 对 question 返回 null',
  reg.options.select({ pendingInteraction: { kind: 'question' } }) === null)
check('select 对空值返回 null', reg.options.select({ pendingInteraction: undefined }) === null)

/* ------------------------------------------------------------------ *
 * 5. 词表与渲染
 * ------------------------------------------------------------------ */
section('5. 本地词表与面板渲染')
const { translateReason, toolZh, hasCJK, PanelBody, FallbackPanel } = clientModule.__internal

check('toolZh 翻译 bash', toolZh('bash') === 'Shell 命令', toolZh('bash'))
check('toolZh 未知工具回退原名', toolZh('mystery_tool') === 'mystery_tool', toolZh('mystery_tool'))

const t1 = translateReason('Tool bash requests privileged execution.', 'bash')
check('命中「工具 X 请求越权执行」模板', t1 && t1.text === '工具 Shell 命令 请求越权执行', t1 && t1.text)
check('命中标记 translated=true', t1 && t1.translated === true)
check('中文原因直接透传', translateReason('需要人工确认', 'bash').text === '需要人工确认')
check('未收录英文返回 null', translateReason('Some brand new English sentence.', 'bash') === null)
check('空原因 + 有工具名时给通用中文', translateReason('', 'bash').text === '工具 Shell 命令 请求越权执行')
check('hasCJK 对英文返回 false', hasCJK('English only') === false)

function collectText(node, out) {
  if (node === null || node === undefined || node === true || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
  return out
}

const pending = {
  kind: 'approval',
  key: 'approval:1',
  toolName: 'bash',
  callId: 42,
  reason: 'Tool bash requests privileged execution.',
  answerable: true,
  answer: () => Promise.resolve(),
}

const panelProps = { matched: pending, t: null, resolveReason: undefined }
const panelText = collectText(PanelBody(panelProps), []).join('\n')
check('面板显示「等待审批」', panelText.includes('等待审批'), panelText)
check('面板显示「拒绝」', panelText.includes('拒绝'))
check('面板显示「允许一次」', panelText.includes('允许一次'))
check('面板显示中文原因', panelText.includes('工具 Shell 命令 请求越权执行'), panelText)
check('面板带 data-approval-zh 标记', PanelBody(panelProps).props['data-approval-zh'] === 'panel')

const unknownPending = { ...pending, key: 'approval:2', reason: 'Some brand new English sentence.' }
const unknownText = collectText(PanelBody({ matched: unknownPending, t: null, resolveReason: undefined }), []).join('\n')
check('未收录时不丢原文', unknownText.includes('Some brand new English sentence.'), unknownText)
check('未收录时给出提示', unknownText.includes('尚未收录本地词表'), unknownText)

const fallbackText = collectText(FallbackPanel({ pending, tt: (k, f) => f }), []).join('\n')
check('降级面板显示「等待审批」', fallbackText.includes('等待审批'), fallbackText)
check('降级面板仍可「允许一次」', fallbackText.includes('允许一次'))

/* ------------------------------------------------------------------ *
 * 6. 关键安全属性（静态检查）
 * ------------------------------------------------------------------ */
section('6. 安全与合规静态检查')
check('客户端不 require 任何 Harness client 包',
  !/@deepseek-ai\/dsh-client-ui-(primitives|chat|conversation|approval)/.test(clientSrc.replace(/dsh\.client[^\n]*/g, '')))
check('客户端不往 document.body 追加节点', !/document\.body/.test(clientSrc))
check('宿主半边不写 session 事件', !/\.append\(/.test(await readFile(join(here, 'index.js'), 'utf8')))
check('客户端样式只用 --dsw-* / --dsh-* token', (() => {
  const colors = clientSrc.match(/(?:background|color|border)\s*:\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]*\))/g) || []
  return colors.every((c) => !/#(?!fff\b)[0-9a-fA-F]{3,8}/i.test(c) || /#fff\b/i.test(c))
})(), '除 #fff 兜底外不应出现字面色值')

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log(' - ' + f)
  process.exit(1)
}
console.log('BUNDLE SELFTEST PASSED (' + passed + ' checks)')
