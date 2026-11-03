# clustercode

**OpenCode 的长跑型 agent 集群。**
模型自己立任务 DAG，插件在每轮结束时把下一棒递回去，团队成员按轮次换座位上场，
队列跑到清空为止。

[English](../README.md) · [简体中文](README.zh-CN.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português](README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## 为什么需要它

OpenCode V2 重写了插件 API（`Plugin.define`，2.x），1.x 插件在 2.x 上直接加载失败。
V2 原生给了后台 subagent、压缩和预热，但没给两件无人值守必需的事：

1. **续跑** —— 一轮结束后没有人递下一棒，只能人不停敲回车。
2. **换人** —— 一个 agent 从头干到尾，而不是规划、实现、审查、测试轮流上。

`clustercode` 补的就是这两块，再加上「可以真的放着跑 24 小时」所需的几道闸。

## 能力

| 能力 | 说明 |
|---|---|
| **任务 DAG** | 任务之间可写 `dependsOn`，前置全部 `done` 才可执行。 |
| **自动规划** | `cluster_auto({ goal })` 用一次离屏调用把目标编译成 DAG，不污染当前会话。 |
| **成员轮换** | 成员是磁盘上真实的 agent 文件（`clustercode-<id>.md`），插件用 `switchAgent` 换人；任务可点名成员。 |
| **验收闸门** | 标 `done` 时真跑任务的 `verify` 命令，退出码非 0 就拒绝并返回输出。 |
| **24h 心跳** | `heartbeat: true` 时，空闲 session 过了冷却期会被重新叫醒，中断后能自己接上。 |
| **多道闸门** | 后台任务、队列结束、死锁、轮次上限、停滞保护，只在同一处、按同一顺序判定。 |
| **三个入口** | server（钩子/工具/RPC）、TUI（状态栏 + `/cluster` 面板）、Desktop（侧栏面板 + 输入框胶囊 + 菜单）。 |
| **追加与重试** | `cluster_plan({ append: true })` 向在跑的队列追加；`cluster_retry` 把失败任务放回队列。 |

## 设计原则

七条规则，每条都有测试兜底；[design.md](design.md) 给出「原则 → 模块 → 测试」的完整映射，
以及与「无限制 agent 群」的取舍差异。

1. **一个触发点，一个调度器** —— idle 钩子和心跳都调 `decide()`，闸门顺序只写一遍。
2. **`resume: true` 闭合链路** —— 没有它，空闲 session 等不到那次唤醒。
3. **要证据，不要自评** —— 标 `done` 真跑验收命令，模型的自我评价不算证据。
4. **前提坏了就停** —— failed 的前置不算满足，死锁立刻停机并说明原因。
5. **默认让路** —— 后台任务优先，权限与重试交给别的插件，系统卡片保持不变以保住 prompt cache。
6. **文件即接口** —— 一个座位就是一个受管 markdown 文件，手写文件绝不覆盖。
7. **一条数据链路** —— 快照 → RPC → 两个 UI，文案共用一套纯函数。

## 安装

克隆后，在 `~/.config/opencode/opencode.json` 里指向**目录**（不是文件）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

宿主通过 `package.json` 的 `exports` 找三半：

| exports | 半边 | 内容 |
|---|---|---|
| `.` | server | 工具、钩子、命令、RPC、心跳 |
| `./tui` | 终端 | 底部状态段、`/cluster` 面板 |
| `./gui-experimental` | 桌面 | 侧栏面板、输入框胶囊、菜单/标签/命令入口（`dist/*.cjs`） |

两条运行规则：

- 桌面半边是**预构建**的。新克隆后先跑 `npm run build`，否则桌面没有入口。
- 宿主**只在启动时**探测一次 `exports`。改完 `exports` 或重建 GUI 后必须重启 server 和桌面端；
  `opencode reload` 只重读配置。重启前可用 `npm run check:entry` 验证探测结果。

需要 OpenCode 2.x 插件宿主（`@opencode/plugin >= 2.0.27 < 3`）。开发脚本需要 Node 22.18+。

## 快速开始

1. 重启 OpenCode，让插件加载。
2. 按 **Shift+Tab** 切到 `clustercode` 模式。这个模式存在的意义就是：让模型把活交给队列，而不是自己硬干。
3. 直接提需求，或者直接调工具：

```
cluster_auto({ "goal": "给配置加载器加 --json 开关，带测试和文档" })
```

```
cluster_plan({
  "goal": "加固导入器",
  "tasks": [
    { "id": "t1", "title": "拒绝超过 10MB 的文件", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "补充限制说明文档", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. 看进度：`/cluster` 打开面板。TUI 底部显示 `cluster 2/5 · turn 3 · coder`，
   桌面端在输入框上方显示同一条进度胶囊。
5. 刹车用 `/cluster-stop`，继续用 `/cluster-resume`。

第一次用建议保留 `maxRounds: 5`；确认计划靠谱后再放开。`maxRounds: null` 加上全放行的权限配置，
是真的会一直跑到队列清空。

## 工具

| 工具 | 作用 |
|---|---|
| `cluster_auto` | 给一句目标，自动生成 DAG 并开跑；没有团队时先建默认班底。 |
| `cluster_plan` | 手工建队列。支持 `dependsOn`、`verify`、`member`、`maxRounds`、`maxStagnant`、`heartbeat`、`append`。 |
| `cluster_update` | 更新状态为 `pending` / `running` / `done` / `failed`；`done` 会过验收闸门。 |
| `cluster_status` | 轮次、队列、下一棒、依赖阻塞、心跳、停机原因。 |
| `cluster_team` | 建/换团队；`adoptCluster: true` 接管手写的 `clustercode.md`。 |
| `cluster_retry` | 把失败任务重置为 `pending`，清掉停机原因继续跑。 |

命令：`/cluster-stop`、`/cluster-resume`、`/cluster`（面板）。

## 内置班底

用 `cluster_team({ members: [...] })` 替换；成员支持 `id`、`role`、`color`、`extra`、`model`。

| id | 职责 | 说明 |
|---|---|---|
| `architect` | 拆解需求、定接口、写计划 | 不写实现代码 |
| `coder` | 按计划实现 | 自己验证改动 |
| `reviewer` | 只读审查 | frontmatter 里拒绝 `edit:*` 工具调用 |
| `tester` | 跑测试、复现问题、验证验收标准 | 只认真实输出 |

`reviewer` 的只读是**策略层**限制，不是沙箱。真要让 agent 碰不到文件，得在 OS 层限制。

## 一轮是怎么跑的

```
experimental.idle
   ├─ 还有后台任务在跑？   → 让路（它们结束时会再次唤醒）
   ├─ 队列结束了？         → 停机（finished）
   ├─ 任务图死锁？         → 停机（deadlock）
   ├─ 到轮次上限了？       → 停机（max-rounds）
   ├─ 下一轮会算停滞？     → 停机（stagnant）
   └─ 否则
        switchAgent(下一棒)  → 只有切换成功才推进 cursor
        round += 1，存盘，发布快照
        synthetic({ resume: true, text: "第 N 轮，任务 tX，做完用 cluster_update 上报" })
```

`resume: true` 是整条链路能闭合的关键：没有它，注入的消息会等下一次唤醒，而空闲 session
等不到下一次唤醒，长跑就静默停住了。心跳走的是同一个 `decide()`，所以到了轮次上限的集群
在心跳路径上也会被停机，而不是被多叫起来跑一轮。

## 架构

```
core（纯逻辑，可单测）
  state.ts      任务 DAG、轮换、计数器、状态指纹
  scheduler.ts  decide() + commit()：闸门顺序只写一遍
  plan.ts       目标 → DAG、JSON 容错、环检测
  store.ts      带缓存与串行写的持久化 + FileStorage
        │
server（src/index.ts）
  idle 钩子 · 系统卡片 · 命令 · 工具 · 心跳 · 快照 RPC
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI（src/tui.tsx）                 Desktop（dist/gui-experimental.cjs）
   底部状态 + /cluster 面板            侧栏面板 + 输入框胶囊 + 命令
```

两个 UI 半边只读 RPC，不碰 server 的内存和磁盘，所以连远程 server 的桌面端和本地表现一致。
两边共用 `status.ts` 的文案与计算，状态栏和面板不会对同一个数字给出不同说法。

## 闸门与成本

- **停滞保护**：连续 12 轮没有任何任务状态变化就停机；`maxStagnant: 0` 关闭，此时只剩轮次上限。
- **轮次上限**：默认 `null`。前几次跑建议设成数字。
- **死锁**：依赖成环或上游 failed 会立刻停机并说明原因，不空转到停滞计数器触发。
- **心跳**：`cluster_auto` 默认开，`cluster_plan` 默认关；最小间隔 15s，默认 60s。
  它同样受轮次上限和停滞保护约束。

所有判定都在 `decide()` 里，没有第二份规则副本。

## 与其他插件共存

clustercode 刻意不碰别的插件可能已经在管的区域：

| 区域 | 归属 |
|---|---|
| 权限、长 shell 超时 | 你的权限插件（从不注册 `permission.evaluate`） |
| 重试退避 | 你的重试插件（从不注册 `retry`——两个插件都写 `event.decision` 时只有后注册的生效） |
| 系统提示词 | 宿主；clustercode 只追加一张常量卡片，且每轮最多一次 |
| 每个座位的模型 | 你，通过成员的 `model` 字段 |

两个都注册 `retry` 的插件不可能都赢。这就是本插件退出的原因。

## 已验证

```
npm run check
  类型检查（tsc --noEmit，含 TSX）
  187 项断言（node --test，不调模型、不联网）
  架构不变式：模块边界由测试从源码读出并检查
  文档不变式：六种语言的数字一致、相对链接都能解析
  构建：dist/gui-experimental.cjs + TUI 编译检查
  入口探测：server / tui / desktop 三半都能解析
  TUI 接线检查 + Desktop 接线检查
```

**没有**验证的：真实渲染（需要活的 TUI / 桌面端）和真实模型下的完整无人值守长跑（需要花 token）。
其余都有测试兜底。

## 开发

```powershell
npm install
npm run check        # 上面那一整套，按顺序跑
npm run test         # 只跑断言
npm run typecheck
npm run build        # 桌面 bundle + TUI 编译检查
npm run check:entry  # 复刻宿主对 exports 的探测
```

测试用 `CLUSTERCODE_AGENTS_DIR` 把 agent 目录重定向到临时目录，不会写真实的
`~/.config/opencode/agents`。

`docs/development.md` 说明了 `opencode/` 下那份 OpenCode 源码参照副本怎么用，
以及如何对着它复核宿主 API。

## 已知限制

- **单车道**：每个 session 一次只跑一轮。并行属于后台 subagent，idle 钩子会主动给它们让路。
- **`cluster_plan` 默认整体替换队列**，要追加得传 `append: true`。
- **`experimental.idle` 是实验性钩子**，宿主升级可能改签名；升级后先跑 `npm run check`。
- **验收闸门是策略层的**：它跑一条 shell 命令，不是沙箱。
- **RPC 的 output schema 必须列全快照字段**：宿主按封闭对象解码，少一个字段就是
  `rpc.invalid_output`，面板永远空着。`test/rpc.test.ts` 会拿真实载荷逐字段比对 schema，
  所以漏字段会在 CI 挂，而不是在客户端挂。
- **空串表示「无」**：`currentMember`、`stoppedReason`、`member`、`color`、`verify` 一律用 `""`，
  不用 `null`——解码器没有 null 分支。
- **渲染需要重启**：宿主只在启动时探测插件入口。

## 与「无限制 agent 群」的关系

`clustercode` 是对中文 OpenCode V2 插件 **无限制 agent 群**（`unlimited-agent-cluster`）
那套思路的独立重写。这一版改了什么：

- 运行时文案、注释、文档改成英文，社区不再局限于单一语言。
- agent 文件改成 `clustercode` / `clustercode-<id>`，两个插件可以并存，互不覆盖对方的 agent。
- 用一个 `decide()` 服务 idle 钩子和心跳，而不是两份闸门顺序。
- 停机原因除人话外，还有机器可读的 `stoppedCode`。
- 支持增量 `append` 和 `cluster_retry`。
- 加了 RPC 载荷与 schema 的逐字段覆盖测试——这正是以前把两个面板同时打空的那个 bug。

## 许可

MIT，见 [LICENSE](../LICENSE)。
