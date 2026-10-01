# approval-zh — 权限确认窗口中文化

把 DSH 的**权限确认窗口（Approval）**整块换成中文界面，并且把窗口里那句一直
是英文的**授权原因**也翻成中文。

窗口原本长这样：

```
● 等待审批
Tool bash requests privileged execution.      ← 一直是英文
  rm -rf build/                                ← 命令明细（英文面板同款）
[ 拒绝 ]  [ 允许一次 ]
```

装上本插件后：

```
● 等待审批
工具 Shell 命令 请求越权执行                    ← 中文
  rm -rf build/
[ 拒绝 ]  [ 允许一次 ]
```

> 说明：DSH 官方面板自带的按钮/标题**本来就已中文化**；本插件真正解决的是
> **`reason`（授权原因）**——它是调用方（bash / edit / write 等工具）传入的
> 自由文本英文串，没有内置词典，所以永远显示英文。

---

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单。声明 host 半边（`index.js`）、client 半边（`client.js`）与 patch。 |
| `cordis.patch.yml` | 安装时插入的插件行（`- insert:`）。 |
| `index.js` | **宿主半边**（ESM）。挂 `approval/request` 瀑布监听，用 model-router 翻译原因。 |
| `client.js` | **客户端半边**（浏览器纯脚本）。接管审批面板，即时套本地词表重绘中文。 |
| `selftest.mjs` | 离线自检（75 项）。不联网、不启动 DSH。 |
| `README.md` | 本文件。 |

---

## 两条翻译路径

插件是**双保险**设计，两条路径都只读不改审批语义：

**① 客户端本地词表（零延迟，弹窗打开前就完成）**
`client.js` 用 `priority: 0` 接管 `conversation.composer` 链槽（官方面板是
`priority: 1`，链槽按 priority 升序选举，数字小的先命中），自己画整张卡片。
界面文案来自内置词典，常见英文原因来自 `PHRASES` 正则表，工具名来自
`TOOL_LABELS`。**不发任何网络请求**，所以弹窗一点不卡。

**② 宿主侧 model-router 兜底（覆盖词表未收录的写法）**
`index.js` 在 `agent/created` 时对 `agent.ctx` 挂 `approval/request` 瀑布监听：
`req.reason` 里没有 CJK 字符 → 调 model-router 库翻译 → 写回 `req.reason`。
翻译结果同时在宿主和客户端缓存，所以下一次同样的原因会立即显示中文。

三条硬约束，保证**绝不**拖慢或破坏审批：

| 约束 | 行为 |
|---|---|
| 硬时间预算 | 默认 2500ms 超时即放行，原因保持英文 |
| 永远放行 | 监听器**总是** `return next()`，从不消费/否决审批决定 |
| 绝不动冻结对象 | `Object.isFrozen(req)` 时直接跳过 |

任何一步失败（库缺失、超时、模型报错、返回空）都只 `console.warn`，界面照常工作。

---

## 安装

### 方式一：从 GitHub 克隆后本地安装

```bash
git clone https://github.com/KNGLOKIKO/dsh-plugin-approval-zh.git
```

然后用 `plugin_manager` 工具安装（**不要**手改 profile 下的
`~/.dsh/profiles/desktop/cordis.patch.yml`）：

```
plugin_manager  action=install_bundle
                target=<克隆下来的绝对路径>
```

安装时会在宿主 / 浏览器进程里执行插件代码，所以需要 Full access 或逐次批准。
装完用（免批准的）`cordis_inspect_query` 确认新行，不必翻页 `list_plugins`：

```
cordis_inspect_query  platform=host  provider=Config  method=listConfigs
                      input={"name":"@local/approval-zh"}
```

`status: "absent"` 是**正常的**——它表示本插件没有导出 `Config` schema，
不代表插件没装。

安装后**刷新页面**（或重启 DSH）让 `client.js` 进入浏览器模块表。

### 方式二：让插件管理器直接从 git 仓库装

`install_bundle` 也接受 git 规格（本仓库的 `package.json` 已带
`dsh.bundle.patch`，无需额外构建）：

```
plugin_manager  action=install_bundle
                target=git+https://github.com/KNGLOKIKO/dsh-plugin-approval-zh.git
```

### 卸载

```
plugin_manager  action=remove_bundle  target=@local/approval-zh
```

### 配置项

编辑 `cordis.patch.yml` 的 `config`（改完需重装 bundle 或重启 DSH）：

```yaml
- insert:
    - id: approval-zh
      name: '@local/approval-zh'
      config:
        libraryPath: '.../model-router/index.js'  # 可选，见下
        translateBudgetMs: 2500                    # 翻译硬预算，超时放行
        useModelRouter: true                       # false = 只用本地词表
```

`libraryPath` **不必手写**。不填时按以下顺序自动解析：

1. 环境变量 `APPROVAL_ZH_MODEL_ROUTER`
2. 与本 bundle **同级**的 `../model-router/index.js`

第 2 条让「把 model-router 和本插件克隆到同一父目录」即可开箱拿到兜底翻译；
都解析不到时只走客户端本地词表，插件照常工作。

---

## 本地词表怎么加

**加整句模板** → 编辑 `client.js` 的 `PHRASES` 数组（顺序即优先级，先匹配先赢）：

```js
{ re: /^Tool\s+(.+?)\s+requests privileged execution\.?$/i,
  build: (m) => '工具 ' + toolZh(m[1]) + ' 请求越权执行' },
```

`build` 收到正则的 `match` 数组，返回中文字符串。加完需要重装 bundle + 刷新页面。

**加工具名** → 在 `TOOL_LABELS` 里补一行 `bash: 'Shell 命令'`。未收录的工具名
原样保留，不会消失。

**加界面文案** → 同时改 `client.js` 顶部的 `zh` / `en` 词典。

> 词表没命中时**不会丢信息**：面板原样显示英文原因，并附一行
> 「尚未收录本地词表」提示；同时宿主侧会尝试用 model-router 翻。

---

## 已知边界

- **不翻译审计记录**：日志里记录的仍是原始 `reason`，中文只作用于界面。
- **不改审批语义**：「允许一次 / 拒绝」仍然只由用户点击或 Enter / Esc 决定，
  插件既不自动放行也不自动拒绝。
- **命令明细依赖 `useChat`**：命令明细来自槽位 kit 的 `useChat`。若当前 DSH
  版本没在 `conversation.composer` 注入它，明细区不显示，面板其余部分正常。
- **崩溃隔离**：面板外层有 React 错误边界，渲染异常时降级为极简中文面板，
  不会白屏。
- **`reason` 是冻结对象时**宿主侧不改写，此时只有客户端词表这一层可用。

---

## 自检

```
E:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe `
  C:\Users\KngLokiko\Documents\deepseek-harness\default-workspace\_diag\approval-zh-bundle\selftest.mjs
```

应输出 `BUNDLE SELFTEST PASSED (75 checks)`。
