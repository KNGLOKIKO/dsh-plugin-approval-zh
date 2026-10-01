/**
 * @local/approval-zh — DSH Client 半边（浏览器纯 JS，无需构建）。
 *
 * 接管 `conversation.composer` 链槽中的审批卡片，用中文重绘：
 *  - 静态文案走 Client locale 服务（命名空间 `approval-zh`）；
 *  - 授权原因走本地词表翻译；未收录时保留原文并提示；
 *    （宿主半边的 model_router 兜底通常已把中文写回 req.reason，此处即直接透传。）
 *  - 命令明细复用与官方 ApprovalCommand 相同的取数逻辑（`useChat` 快照的
 *    tool-call 节点），不 import 任何 Harness Client 包。
 *
 * 为什么是「接管」而不是「插槽追加」：
 *  `conversation.approval.detail` 是 single 槽且已被 `dsh-client-ui-chat` 占用；
 *  而 `renderSlot` 只允许渲染自己 `children` 里声明过的键，且 `children` 声明的
 *  键若已被他人声明会在注册时抛错 —— 所以无法复用官方命令渲染，只能自己画。
 *
 * 选择优先级：链槽按 priority 升序逐个 `select()`，**第一个返回非 null 的胜出**
 *  （见 dsh-client-ui-renderer：`for (const entry of entries) { ... break }`）。
 *  官方审批面板用的是 priority 1，故本插件用 priority 0 抢先。
 *
 * 稳定性要求（用户 m00578：不可以出现报错、断链）：所有取数与渲染都在错误边界
 *  之内；任何内部异常都会退化成「原始原因 + 拒绝/允许一次」的最小可用面板，
 *  绝不让审批卡住。
 */
window.__ModuleLoader__.load({
  id: '@local/approval-zh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'approval-zh';
    const PRIORITY = 0;

    const zh = {
      waiting: '等待审批',
      detailAria: '审批详情',
      escalation: '工具 {toolName} 请求越权执行',
      reject: '拒绝',
      allowOnce: '允许一次',
      untranslated: '该提示尚未收录本地词表，以下为原文。',
      answered: '已提交',
      crashtip: '中文审批面板渲染异常，已降级为原始面板（仍可正常审批）。',
    };
    const en = {
      waiting: 'Waiting for approval',
      detailAria: 'Approval details',
      escalation: 'Tool {toolName} requests privileged execution',
      reject: 'Reject',
      allowOnce: 'Allow once',
      untranslated: 'Not yet in the local dictionary; showing the original text.',
      answered: 'Submitted',
      crashtip: 'The Chinese approval panel failed to render; degraded to the raw panel (decisions still work).',
    };

    /** 工具名 → 中文标签。 */
    const TOOL_LABELS = {
      bash: 'Shell 命令',
      write: '写入文件',
      edit: '编辑文件',
      read: '读取文件',
      read_image: '读取图片',
      glob: '查找文件',
      grep: '搜索内容',
      web_fetch: '抓取网页',
      web_search: '联网搜索',
      present: '交付文件',
      subagent: '子代理',
      spawn_teammate: '协作代理',
      workflow: '工作流',
      model_router: '模型路由',
      ask_user_question: '向用户提问',
      todo_write: '更新任务清单',
      create_goal: '创建目标',
      skill: '技能加载',
      terminal_open: '打开终端',
      terminal_read: '读取终端',
    };

    /** 常见英文提示片段 → 中文。命中即视为「已收录」。 */
    const PHRASES = [
      [/^Tool\s+(.+?)\s+requests privileged execution\.?$/i, (m) => `工具 ${toolZh(m[1])} 请求越权执行`],
      [/\brequests? privileged execution\b/i, '请求越权执行'],
      [/\brequires? (?:your |user )?approval\b/i, '需要人工确认'],
      [/\bnot (?:permitted|allowed)\b/i, '不被允许'],
      [/\bescalat(?:e|es|ed|ion|ing) (?:the )?sandbox\b/i, '需要提权（沙箱升级）'],
      [/\bsandbox escalation\b/i, '沙箱提权'],
      [/\boutside (?:of )?the workspace\b/i, '超出工作区范围'],
      [/\bnetwork access\b/i, '需要网络访问'],
      [/\bwrite access\b/i, '需要写入权限'],
      [/\bdestructive\b/i, '具有破坏性'],
      [/\bprivileged\b/i, '越权'],
    ];

    function toolZh(name) {
      const key = String(name == null ? '' : name).trim();
      return TOOL_LABELS[key] || key;
    }

    /**
     * 把槽位给的 locale 席位包成「取不到就用内置中文兜底」的安全翻译函数。
     * 不传 params，避免把兜底文案误当成插值参数。
     */
    function makeTT(props) {
      const seat = props && typeof props.t === 'function' ? props.t : null;
      return (key, fallback) => {
        if (!seat) return fallback;
        try {
          const value = seat(key);
          return typeof value === 'string' && value !== '' && value !== key ? value : fallback;
        } catch (error) {
          return fallback;
        }
      };
    }

    function hasCJK(value) {
      return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(String(value == null ? '' : value));
    }

    /**
     * 本地词表翻译。命中返回 { text, translated: true }；
     * 已含中文直接透传；完全未命中返回 null（由调用方决定如何呈现原文）。
     */
    function translateReason(reason, toolName) {
      const raw = String(reason == null ? '' : reason).trim();
      if (raw === '') {
        if (!toolName) return null;
        return { text: `工具 ${toolZh(toolName)} 请求越权执行`, translated: true };
      }
      if (hasCJK(raw)) return { text: raw, translated: true };
      for (const [pattern, replacement] of PHRASES) {
        if (!pattern.test(raw)) continue;
        if (typeof replacement === 'function') return { text: replacement(raw.match(pattern)), translated: true };
        return { text: `${toolZh(toolName)}：${replacement}`, translated: true };
      }
      return null;
    }

    /** 与官方 ApprovalCommand 相同的取数：从会话快照里找关联的 bash 命令。 */
    function commandOf(call) {
      if (call === void 0 || call === null) return void 0;
      try {
        const args = JSON.parse(call.argsRaw);
        return typeof args.command === 'string' ? args.command : void 0;
      } catch (error) {
        return void 0;
      }
    }

    /** 只在拿到 useChat 时才挂载，避免条件调用 Hook。 */
    function ChatCommand({ callId, useChat }) {
      const command = useChat((snapshot) => {
        const nodes = snapshot && snapshot.nodes;
        if (!nodes || typeof nodes.values !== 'function') return void 0;
        for (const node of nodes.values()) {
          const root = node && node.kind === 'tool-call' ? node.data && node.data.root : void 0;
          if (root === void 0) continue;
          if (root.callId === callId && !('kind' in root) && root.phase === 'start') return commandOf(root);
        }
        return void 0;
      });
      if (command === void 0 || command === null || command === '') return null;
      return h('div', { className: 'appzh_command' }, String(command));
    }

    /** 最小可用面板：任何内部异常都退到这里，保证用户仍能审批。 */
    function FallbackPanel({ pending, tt }) {
      const [done, setDone] = React.useState(false);
      const busy = React.useRef(false);
      const answer = (outcome) => {
        if (busy.current || !pending || !pending.answerable) return;
        busy.current = true;
        setDone(true);
        try {
          Promise.resolve(pending.answer(outcome)).catch(() => {
            busy.current = false;
            setDone(false);
          });
        } catch (error) {
          busy.current = false;
          setDone(false);
        }
      };
      return h(
        'div',
        { className: 'appzh_root', 'data-approval-zh': 'fallback' },
        h(
          'div',
          { className: 'appzh_card' },
          h('div', { className: 'appzh_strip' }, h('span', { className: 'appzh_dot' }), tt('waiting', '等待审批')),
          h(
            'div',
            { className: 'appzh_body' },
            h('div', { className: 'appzh_headline' }, String((pending && pending.reason) || tt('escalation', '工具 {toolName} 请求越权执行').replace('{toolName}', pending ? toolZh(pending.toolName) : ''))),
            pending && pending.callId !== void 0 ? h('div', { className: 'appzh_command' }, `callId: ${String(pending.callId)}`) : null
          ),
          h(
            'div',
            { className: 'appzh_actionRow' },
            h('button', { type: 'button', className: 'appzh_btn appzh_btnReject', disabled: done, onClick: () => answer('rejected') }, tt('reject', '拒绝')),
            h('button', { type: 'button', className: 'appzh_btn appzh_btnPrimary', disabled: done, onClick: () => answer('allowed-once') }, tt('allowOnce', '允许一次'))
          )
        )
      );
    }

    /** 错误边界：只包住面板，崩溃不外溢到槽渲染。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        try {
          console.error('[approval-zh] panel crashed, degraded:', error);
        } catch (ignored) {
          /* 控制台不可用也无所谓 */
        }
      }
      render() {
        if (this.state.failed) return h(FallbackPanel, { pending: this.props.pending, tt: this.props.tt });
        return this.props.children;
      }
    }

    /** 命令明细单独一层边界，取数失败不影响主面板。 */
    class CommandBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        try {
          console.error('[approval-zh] command detail unavailable:', error);
        } catch (ignored) {
          /* 同上 */
        }
      }
      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    function PanelBody(props) {
      const pending = props.matched;
      const tt = makeTT(props);
      const [done, setDone] = React.useState(false);
      const busy = React.useRef(false);
      const alive = React.useRef(true);
      // 官方实现的键盘节奏：Enter=允许一次、Escape=拒绝，排除输入框/IME/组合键。
      const composing = React.useRef(false);
      const compositionEnded = React.useRef(false);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const answer = (outcome) => {
        if (busy.current || !pending || !pending.answerable) return;
        busy.current = true;
        setDone(true);
        try {
          Promise.resolve(pending.answer(outcome)).catch(() => {
            if (!alive.current || !pending.answerable) return;
            busy.current = false;
            setDone(false);
          });
        } catch (error) {
          busy.current = false;
          setDone(false);
        }
      };

      const onKeyDown = (event) => {
        try {
          const element = event.target;
          const current = event.currentTarget;
          if (event.defaultPrevented) return;
          if (!current || !element || !current.contains(document.activeElement)) return;
          if (element.closest && element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          if (event.key === 'Enter' && element.closest && element.closest('button, a[href], [role="button"]') !== null) return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat || composing.current || compositionEnded.current || (event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229) return;
          answer(event.key === 'Enter' ? 'allowed-once' : 'rejected');
        } catch (error) {
          /* 键盘处理永不抛出 */
        }
      };

      // 官方逻辑：displayReason 存在时先解析成可读文本。
      let reasonText;
      if (pending && pending.displayReason !== void 0 && typeof props.resolveReason === 'function') {
        try {
          reasonText = props.resolveReason(pending.displayReason);
        } catch (error) {
          reasonText = pending.reason;
        }
      } else {
        reasonText = pending ? pending.reason : void 0;
      }

      const localized = translateReason(reasonText, pending && pending.toolName);
      const unknown = localized === null && String(reasonText == null ? '' : reasonText).trim() !== '';
      const headline = localized
        ? localized.text
        : unknown
          ? String(reasonText)
          : tt('escalation', '工具 {toolName} 请求越权执行').replace('{toolName}', toolZh(pending && pending.toolName));

      const command = pending && pending.callId !== void 0 && typeof props.useChat === 'function'
        ? h(CommandBoundary, null, h(ChatCommand, { callId: pending.callId, useChat: props.useChat }))
        : null;

      return h(
        'div',
        {
          className: 'appzh_root',
          'data-approval-zh': 'panel',
          'data-approval-key': pending ? pending.key : void 0,
          'aria-busy': done,
          onKeyDown,
          onKeyUpCapture: () => {
            compositionEnded.current = false;
          },
          onCompositionStartCapture: () => {
            composing.current = true;
          },
          onCompositionEndCapture: () => {
            composing.current = false;
            compositionEnded.current = true;
          },
        },
        h(
          'div',
          { className: 'appzh_card' },
          h(
            'div',
            { className: 'appzh_strip' },
            h('span', { className: 'appzh_dot' }),
            tt('waiting', '等待审批'),
            done ? h('span', { className: 'appzh_note' }, ' · ' + tt('answered', '已提交')) : null
          ),
          h(
            'div',
            { className: 'appzh_body', 'data-approval-scroll': '', tabIndex: 0, role: 'group', 'aria-label': tt('detailAria', '审批详情') },
            h('div', { className: 'appzh_headline' }, headline),
            command,
            unknown ? h('div', { className: 'appzh_note' }, tt('untranslated', '该提示尚未收录本地词表，以下为原文。')) : null
          ),
          h(
            'div',
            { className: 'appzh_actionRow' },
            h('button', { type: 'button', className: 'appzh_btn appzh_btnReject', disabled: done, onClick: () => answer('rejected') }, tt('reject', '拒绝')),
            h('button', { type: 'button', className: 'appzh_btn appzh_btnPrimary', disabled: done, onClick: () => answer('allowed-once') }, tt('allowOnce', '允许一次'))
          )
        )
      );
    }

    /** 注册进链槽的组件。 */
    function ApprovalZhPanel(props) {
      return h(Boundary, { pending: props.matched, tt: makeTT(props) }, h(PanelBody, props));
    }

    const CSS = [
      '.appzh_root{padding:8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px;flex-direction:column;align-items:center;display:flex}',
      '.appzh_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}',
      '.appzh_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}',
      '.appzh_dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}',
      '.appzh_body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height);flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow-y:auto}',
      '.appzh_headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}',
      '.appzh_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);word-break:break-all;white-space:pre-wrap;font-size:13px;line-height:20px}',
      '.appzh_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.appzh_actionRow{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex}',
      '.appzh_btn{cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:var(--dsw-radius-m,8px);border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary)}',
      '.appzh_btn:disabled{opacity:.5;cursor:default}',
      '.appzh_btnReject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}',
      '.appzh_btnPrimary{background:var(--dsw-alias-interactive-bg-primary,#1a6dff);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.appzh_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-primary-hover,#1660e0)}',
    ].join('');

    return {
      inject: ['slots', 'locale'],
      // 供离线 selftest 复用纯逻辑（浏览器运行时忽略这些额外键）。
      __internal: { translateReason, toolZh, hasCJK, makeTT, PanelBody, FallbackPanel, TOOL_LABELS, PHRASES },
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approval-zh: dictionaries');
        } catch (error) {
          console.error('[approval-zh] locale registration failed:', error);
        }
        try {
          ctx.effect(() => {
            const tag = document.createElement('style');
            tag.dataset.plugin = '@local/approval-zh';
            tag.textContent = CSS;
            document.head.appendChild(tag);
            return () => {
              try {
                tag.remove();
              } catch (ignored) {
                /* 已随文档卸载 */
              }
            };
          }, 'approval-zh: styles');
        } catch (error) {
          console.error('[approval-zh] style injection failed:', error);
        }
        try {
          ctx.slots.inject('conversation.composer', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer',
                priority: PRIORITY,
                locale: NS,
                // 不用 instanceof：PendingApproval 是官方包的私有类。
                select: ({ pendingInteraction }) =>
                  pendingInteraction && pendingInteraction.kind === 'approval' ? pendingInteraction : null,
                // 与官方面板同源：displayReason 是 locale 键时在客户端解析。
                inject: () => ({
                  resolveReason: (reason) => {
                    try {
                      return ctx.locale.resolveText(reason);
                    } catch (error) {
                      return reason;
                    }
                  },
                }),
              },
              ApprovalZhPanel
            )
          );
        } catch (error) {
          console.error('[approval-zh] slot registration failed:', error);
        }
      },
    };
  },
});
