import { getSetting } from '../settings'
import type { AgentId } from '../types'

export type TeamLang = 'zh' | 'en'

export function teamLang(): TeamLang {
  return getSetting('team_language') === 'en' ? 'en' : 'zh'
}

const AGENT_LABELS: Record<TeamLang, Record<string, string>> = {
  zh: {
    system: '系统',
    coordinator: '协调者',
    architect: '架构师',
    frontend: '前端工程师',
    backend: '后端工程师',
    reviewer: '审查员',
    qa: 'QA',
    challenger: '质疑者',
    ba: '需求分析师',
    devops: 'DevOps 工程师',
    scribe: '书记官',
  },
  en: {
    system: 'System',
    coordinator: 'Coordinator',
    architect: 'Architect',
    frontend: 'Frontend',
    backend: 'Backend',
    reviewer: 'Reviewer',
    qa: 'QA',
    challenger: 'Challenger',
    ba: 'Business Analyst',
    devops: 'DevOps Engineer',
    scribe: 'Scribe',
  },
}

export function agentLabel(id: string): string {
  return AGENT_LABELS[teamLang()][id] ?? id
}

/** 编排层所有对 agent 的指令与用户可见文案（按团队工作语言切换） */
export interface Texts {
  // ---- 会议 ----
  meetingTopic(projectName: string): string
  meetingAnnouncement(requirement: string): string
  transcriptIntro(meetingId: number, delta: string): string
  kickoffOpening(projectName: string): string
  focusArchitect: string
  focusFrontend: string
  focusBackend: string
  focusQa: string
  participantTurnFirst(focus: string): string
  participantTurnLater(round: number): string
  /** 收敛轮：带着质疑者上一轮的异议针对性发言 */
  participantTurnObjections(round: number, objections: string): string
  kickoffClosing(): string
  /** 未收敛异议追加进总结指令：协调者必须逐条裁决 */
  kickoffClosingUnresolved(objections: string): string
  kickoffRevision(): string
  // ---- 需求收敛环 ----
  /** 每轮结束后质疑者的收敛裁决（JSON {satisfied, objections[]}） */
  meetingConvergenceCheck(round: number): string
  /** 质疑者把未收敛异议贴进会议记录 */
  objectionsMsg(objections: string): string
  /** JSON 解析失败后的格式重试指令（弱模型兜底） */
  jsonRetry(): string
  passSentinel: RegExp
  // ---- 质疑打断 ----
  challengeCheck(speaker: string): string
  /** 按轮批量检查：可指定质疑对象 */
  challengeCheckRound(speakers: string): string
  challengeAnswer(): string
  challengeEval(): string
  adjudicate(speaker: string): string
  interruptMsg(speaker: string, challenge: string): string
  resolvedMsg(comment?: string): string
  followupMsg(followup?: string): string
  deadlockMsg(followup?: string): string
  // ---- 站会 ----
  standupSystem(context: string): string
  standupInstruction(): string
  // ---- 需求分析（BA）----
  baPrd(requirement: string): string
  baRevise(answers: string): string
  baQuestionsTitle: string
  baQuestionsContext(questions: string): string
  baQuestionsSkipped(questions: string): string
  prdAnnouncement(prd: string): string
  // ---- 团队记忆 ----
  lessonsSection(items: string): string
  memoryRebuildNote: string
  scribeDistillTask(p: { id: number; title: string; history: string }): string
  scribeDistillProject(p: { name: string; requirement: string; history: string }): string
  focusDevops: string
  // ---- 设计 ----
  designDoc(designPath: string, summary: string): string
  designChallenge(designPath: string): string
  designIssuesMsg(issues: string): string
  designRevision(issues: string, designPath: string): string
  designRevisionMsg(revision: string): string
  // ---- 架构设计环（再挑战循环）----
  /** 第 cycle 轮复审修订后的设计（JSON {pass, issues[]} 同 designChallenge） */
  designRechallenge(designPath: string, cycle: number): string
  /** 设计环达上限仍未收敛：按当前版本放行的频道告警 */
  designUnresolvedMsg(issues: string): string
  // ---- 任务流 ----
  devBrief(p: {
    id: number
    title: string
    desc: string
    worktree: string
    branch: string
    reworkNote?: string | null
    ownsFiles: string[]
    depsDone: Array<{ id: number; title: string; ownsFiles: string[] }>
  }): string
  devDoneDm(id: number, summary: string): string
  noCommitsNote(summary: string): string
  reviewBrief(p: { id: number; title: string; desc: string; branch: string; worktree: string; diff: string }): string
  reviewResultDm(id: number, approve: boolean, summary: string, findings: string): string
  reviewReworkNote(summary: string, findings: string): string
  qaBrief(p: { id: number; title: string; desc: string; worktree: string; branch: string }): string
  qaResultDm(id: number, pass: boolean, summary: string, issues: string): string
  qaReworkNote(summary: string, issues: string): string
  challengeBrief(p: { id: number; title: string; desc: string; branch: string; worktree: string; diff: string }): string
  challengeResultDm(id: number, blocking: boolean, summary: string, concerns: string): string
  challengeReworkNote(summary: string, concerns: string): string
  // ---- 协调者终审 ----
  finalBrief(p: { id: number; title: string; desc: string; prdExcerpt: string; qaSummary: string; challengeSummary: string; reworkCycles: number; diff: string }): string
  finalResultDm(id: number, complete: boolean, gapsText: string): string
  finalReworkNote(gapsText: string): string
  /** 自测门失败打回说明（带命令与输出尾部） */
  selftestFailNote(cmd: string, output: string, timedOut: boolean): string
  mergeConflictNote(err: string): string
  /** 合并冲突自动返工指引（也作为"已冲突过一次"的识别前缀） */
  mergeAutoReworkNote(taskId: number): string
  /** 依赖任务被放弃时下游的阻塞说明（固定前缀，retry 联动复位据此识别） */
  depBlockedNote(depId: number, depTitle: string): string
  taskErrorNote(err: string): string
  reworkTitle(id: number, title: string, cycles: number): string
  reworkContext(note: string): string
  reworkOptOneMore: string
  reworkOptForceMerge: string
  reworkOptAbandon: string
  forcedPassNote: string
  abandonedNote(comment?: string): string
  reworkUserNote(note: string, comment?: string): string
  // ---- 审批策略（仅预算时的自动处理）----
  autoApprovedNote: string
  autoExtraRoundMsg(id: number, title: string, cycles: number): string
  // ---- 用户对话 ----
  userChat(statusContext: string, message: string, taskDetail?: string | null): string
  chatNoProject: string
  concurrencyLimitMsg(projectName: string, cap: number): string
  // ---- 预算 ----
  budgetTitle(cost: number, budget: number): string
  budgetContext: string
  budgetAdd5: string
  budgetAdd20: string
  budgetPause: string
  // ---- 审批（Bash 门）----
  bashLabel(zhLabel: string): string
  bashApprovalTitle(label: string): string
  bashApprovalContext(agentId: string, cmd: string, label: string): string
  denyOutsideWorkspace(cwd: string): string
  denyByUser(label: string, comment?: string | null): string
  workspaceRootNote(cwd: string): string
  /** 用户自定义技能注入段的标题 */
  skillsSectionHeader: string
  // ---- 私信/参谋 ----
  dmAnswer(from: string, content: string): string
  adviser(requestedBy: string, title: string, context: string): string
  opinionSeparator: string
  // ---- 交付/暂停 ----
  delivery(): string
  deliveryMsg(text: string): string
  blockedPauseMsg(lines: string): string
  // ---- 崩溃恢复 ----
  /** 服务中断遗留的 open 会议被作废时写入的纪要 */
  meetingSweptSummary: string
  /** 服务重启时过期掉的 pending 审批的说明 */
  approvalExpiredComment: string
  /** 本地代理（LiteLLM sidecar）拉起失败的频道告警 */
  proxyFailedMsg(detail: string): string
  // ---- 报告 ----
  reportInstruction(p: {
    since?: string
    projectName: string
    status: string
    taskStats: string
    taskLines: string
    approvalLines: string
    costPeriod: string
    costTotal: string
    budget: string
  }): string
  reportFallback(p: { done: string; doing: string; blocked: string; costPeriod: string; costTotal: string; budget: string }): string
  taskStatsLine(p: { done: number; total: number; inprog: number; review: number; qa: number; challenge: number; final: number; assigned: number; blocked: number }): string
  toastReportTitle(id: number): string
  toastReportMsg(name: string, done: number, total: number, pending: number): string
  notifyApprovalTitle: string
  notifyDoneTitle: string
  notifyDoneMsg(name: string): string
  notifyPausedTitle: string
  notifyPausedMsg(count: number): string
  notifyFailedTitle: string
  // ---- 状态栏 ----
  stChairing: string
  stAttending(round: number): string
  stClosing: string
  stRevising: string
  stListening: string
  stRespondChallenge: string
  stJudging: string
  stAdjudicating: string
  stStandup: string
  stDesigning: string
  stChallengingDesign: string
  stRevisingDesign: string
  stDev(id: number): string
  stReview(id: number): string
  stQa(id: number): string
  stChallenge(id: number): string
  stFinal(id: number): string
  stReport: string
  stDelivery: string
  stChat: string
  chatUnavailable(err: string): string
  stAdvising: string
  stBaPrd: string
  stBaRevise: string
  stDistill: string
  stReplyDm(from: string): string
  stToolUse(tool: string): string
  stWaitApproval(label: string): string
}

const zh: Texts = {
  meetingTopic: (n) => `${n} · 需求评审`,
  meetingAnnouncement: (r) => `【会议开始】项目需求如下：\n\n${r}`,
  transcriptIntro: (id, delta) => `以下是会议（ID：${id}）中你还没看到的发言：\n\n${delta}\n\n====\n\n`,
  kickoffOpening: (n) =>
    [
      `现在开始项目「${n}」的 kickoff 会议。请你作为主持人发表开场发言（直接输出发言内容，不要调用工具）：`,
      `1. 用自己的话复述需求要点，指出关键疑问或风险`,
      `2. 提出任务拆分草案（3~7 个任务，标注建议负责人 frontend/backend）`,
      `3. 说明你希望架构师、开发和 QA 各自重点回应什么`,
    ].join('\n'),
  focusArchitect: '技术选型、模块划分与接口契约。若有重大选型需要用户拍板，先用 request_approval 征求用户意见再发言。',
  focusFrontend: '前端/交互相关任务的可行性、遗漏点、工作量评估',
  focusBackend: '后端/逻辑相关任务的可行性、遗漏点、工作量评估',
  focusQa: '每个任务的验收标准是否可测、还需要补充哪些测试要求',
  participantTurnFirst: (focus) => `轮到你发言。请针对以上讨论，从你的职责出发重点回应：${focus}。直接输出发言内容；如果确实没有要补充的，只回复「PASS」。`,
  participantTurnLater: (round) => `第 ${round} 轮讨论。针对新的发言，如有异议或补充请说明；没有则只回复「PASS」。`,
  participantTurnObjections: (round, objections) =>
    `第 ${round} 轮讨论。质疑者提出以下未解决异议，请从你的职责出发正面回应与你相关的条目（给出修正方案或说明不采纳的理由）；与你无关且无其他补充则只回复「PASS」。\n${objections}`,
  kickoffClosing: () =>
    [
      `讨论结束，请做总结发言。要求输出两部分：`,
      `第一部分：文字总结（结论、采纳了谁的哪些建议、对质疑的回应、风险应对）。`,
      `第二部分：一个 \`\`\`json 代码块，格式如下（这是最终任务清单，会直接建到任务板上）：`,
      '```json',
      `{`,
      `  "summary": "会议纪要（150 字以内）",`,
      `  "test_cmd": "在项目根目录验证代码的单条命令（如 node --test / npm test / python -m pytest）；项目性质不适合自动化验证就写 null",`,
      `  "tasks": [`,
      `    { "title": "动词开头的任务标题", "description": "做什么+边界+验收标准", "assignee": "frontend 或 backend",`,
      `      "depends_on": [1], "owns_files": ["src/xxx.js"] }`,
      `  ]`,
      `}`,
      '```',
      `拆分规则：`,
      `- test_cmd 是自测门：每个任务提交后系统会在其工作区自动执行这条命令，失败直接打回开发者——选一条零额外依赖、能真实验证的命令`,
      `- 不要创建纯验证/纯测试执行类任务（"集成验证""全链路测试"等）：平台的自测门 + QA + 终审环节已覆盖，且零提交的任务会被系统阻塞。每个任务必须产出代码或文档提交`,
      `- depends_on = 本清单里被依赖任务的序号（从 1 数）。写测试/联调的任务必须依赖其实现任务——依赖没完成前不会开工，开工时其产物已在 main 上，直接使用，绝不自己写副本。无依赖就省略`,
      `- owns_files = 该任务独占创建/修改的文件。两个任务不得声明同一文件；要用别人的文件就声明依赖而不是复制`,
      `- 能并行的不要串行（依赖链越短越好）；每个任务的 description 必须包含明确的验收标准`,
    ].join('\n'),
  kickoffClosingUnresolved: (objections) =>
    `\n注意：以下异议在讨论中未收敛。你的总结必须逐条明确回应——采纳的写进对应任务的描述/验收标准，不采纳的给出理由：\n${objections}`,
  kickoffRevision: () => `根据刚才的质疑交锋，输出修订后的最终总结（同样包含文字总结 + \`\`\`json 代码块的任务清单，格式与之前一致）。任务板将以这一版为准。`,
  meetingConvergenceCheck: (round) =>
    `第 ${round} 轮讨论结束。从整场会议看，判断需求共识是否已收敛：任务拆分方向、职责边界、验收标准是否还有你认为必须在开工前解决的异议。已在打断中解决的不要重提；纯口味问题不算异议。只输出 json 代码块：{"satisfied": true} 或 {"satisfied": false, "objections": ["具体异议，每条一句话、可执行"]}`,
  objectionsMsg: (objections) => `【尚未收敛】以下异议需要下一轮针对性回应：\n${objections}`,
  jsonRetry: () => `你的上一条回复没有包含可解析的 \`\`\`json 代码块。请重新输出：只要一个合法的 \`\`\`json 代码块，字段格式按之前的要求，代码块外不要有任何文字。`,
  passSentinel: /^(无补充|PASS)/i,
  challengeCheck: (s) =>
    `刚才${s}发言完毕。判断其发言是否存在实质问题（需求偏离/遗漏边界或失败场景/验收标准含糊/过度设计/不必要依赖）。判据：如果现在不指出、会后修复的代价会更高，就应该打断；纯风格或口味问题放行。只输出 json 代码块：{"pass": true} 或 {"pass": false, "challenge": "..."}`,
  challengeCheckRound: (speakers) =>
    `本轮发言结束（发言人：${speakers}）。判断以上发言中是否存在实质问题（需求偏离/遗漏边界或失败场景/验收标准含糊/过度设计/不必要依赖）。判据：现在不指出、会后修复代价更高才打断；一次只针对最重要的一个问题。只输出 json 代码块：{"pass": true} 或 {"pass": false, "to": "发言人id（如 backend）", "challenge": "..."}`,
  challengeAnswer: () => `质疑者打断了会议，向你提出质疑（见上）。请正面、具体地回答；如果质疑成立，明确接受并说明如何修正。直接输出回答。`,
  challengeEval: () => `对方已回答（见上）。按你的评判规范判断是否满意。只输出 json 代码块：{"satisfied": true, "comment": "..."} 或 {"satisfied": false, "followup": "..."}`,
  adjudicate: (s) => `质疑者与${s}就上述问题僵持不下。作为主持人请当场裁决：采纳哪一方的观点、对任务/方案做什么调整。裁决要明确可执行。直接输出裁决。`,
  interruptMsg: (s, c) => `【打断 → ${s}】${c}`,
  resolvedMsg: (c) => `【质疑解除】${c ?? '回答可以接受，会议继续。'}`,
  followupMsg: (f) => `【追问】${f ?? '请更具体地回答上面的问题。'}`,
  deadlockMsg: (f) => `【仍不满意】${f ?? ''}（已达追问上限，请主持人裁决）`,
  standupSystem: (c) => `【站会】${c}`,
  standupInstruction: () =>
    `出现了需要你裁决的情况（见上）。请给出明确的处理决定和理由。如果这属于重大决策（需求变更/放弃任务等），先用 request_approval 征求用户意见。直接输出你的裁决。`,
  baPrd: (r) =>
    [
      `用户提交了以下项目需求：`,
      ``,
      r,
      ``,
      `请按你的规范产出 PRD。只输出一个 json 代码块：`,
      '```json',
      `{`,
      `  "prd_markdown": "完整 PRD（markdown：目标/功能清单/非目标/逐条可测的验收标准/约束）",`,
      `  "open_questions": ["需要用户澄清的问题（没有就空数组，不要为问而问）"]`,
      `}`,
      '```',
    ].join('\n'),
  baRevise: (a) =>
    `用户对开放问题的回复如下：\n\n${a}\n\n请据此修订 PRD。只输出 json 代码块：{"prd_markdown": "修订后的完整 PRD", "open_questions": []}（除非用户回复又引出了必须澄清的新问题）。`,
  baQuestionsTitle: '需求有几个开放问题需要你澄清',
  baQuestionsContext: (q) => `需求分析师在展开 PRD 时发现以下不明确的点，请在意见栏逐条回复（批准即提交回复）：\n\n${q}`,
  baQuestionsSkipped: (q) =>
    `【需求开放问题】以下几点需求未明确，我已按合理假设写入 PRD 继续推进；如与你的预期不符，随时在对话里告诉我：\n\n${q}`,
  prdAnnouncement: (prd) => `【会议开始】以下是需求分析师确认过的 PRD（任务拆分与验收标准以此为准）：\n\n${prd}`,
  lessonsSection: (items) => `\n\n—— 团队记忆（以往踩过的坑，先看再动手）——\n${items}`,
  memoryRebuildNote: '（你的会话是新建的：以上团队记忆和任务简报就是你需要的全部上下文，设计契约见 repo/DESIGN.md）',
  scribeDistillTask: (p) =>
    [
      `任务 #${p.id}「${p.title}」刚结束，期间经历了返工。以下是它的返工/质疑记录：`,
      ``,
      p.history,
      ``,
      `请提炼出 1~3 条对以后任务有复用价值的教训。只输出 json 代码块：`,
      `{"lessons": [{"tags": "逗号分隔的关键词", "content": "一句话教训（具体、可执行，不写空话）"}]}`,
      `没有可复用价值就输出 {"lessons": []}。`,
    ].join('\n'),
  scribeDistillProject: (p) =>
    [
      `项目「${p.name}」已交付。需求：${p.requirement.slice(0, 300)}`,
      ``,
      `以下是项目期间的返工/质疑/裁决记录汇总：`,
      p.history,
      ``,
      `请提炼 1~3 条跨项目通用的教训（下个项目 kickoff 时会展示给全员）。只输出 json 代码块：`,
      `{"lessons": [{"tags": "关键词", "content": "一句话教训"}]}`,
    ].join('\n'),
  focusDevops: '运行环境、依赖取舍（能不装就不装）、构建与测试脚本、如何一键运行验证',
  designDoc: (p, s) =>
    [
      `kickoff 会议已结束（纪要：${s}）。任务清单已建好（可用 mcp__collab__list_tasks 查看）。`,
      `请把技术设计写入 ${p}（用 Write 工具，路径必须准确）。内容包括：`,
      `1. 技术选型与理由（依据会议结论）`,
      `2. 目录结构规划`,
      `3. 模块/接口契约（具体到函数签名、数据格式、错误处理约定）`,
      `4. 各任务之间的依赖与边界`,
      `写完后简短总结设计要点。`,
    ].join('\n'),
  designChallenge: (p) =>
    `架构师刚完成设计文档：${p}。请用 Read 读取并按你的设计质疑规范审视（重点：不必要的第三方依赖、过度设计、接口契约漏洞、遗漏的失败路径）。只输出 json 代码块：{"pass": true 或 false, "issues": [{"concern": "...", "suggestion": "..."}]}`,
  designIssuesMsg: (i) => `对 DESIGN.md 的质疑：\n${i}`,
  designRevision: (i, p) =>
    [`质疑者对你的 DESIGN.md 提出以下质疑：`, i, ``, `请逐条评估：成立的直接修订 DESIGN.md（用 Write 更新 ${p}），不成立的说明理由。最后简短总结你的处理结果。`].join('\n'),
  designRevisionMsg: (r) => `对设计质疑的处理：\n${r}`,
  designRechallenge: (p, cycle) =>
    `架构师已按你上一轮的质疑修订了 ${p}（第 ${cycle} 轮复审）。请重新 Read 全文，判断：你此前提出的问题是否已解决？修订是否引入了新问题？已解决就痛快放行，不要为挑而挑。只输出 json 代码块：{"pass": true} 或 {"pass": false, "issues": [{"concern": "...", "suggestion": "..."}]}`,
  designUnresolvedMsg: (i) => `【设计环达上限】以下质疑经多轮修订仍未收敛，设计按当前版本继续，开发时注意规避：\n${i}`,
  devBrief: (p) =>
    [
      `你被分派了任务 #${p.id}「${p.title}」。`,
      ``,
      `任务详情：\n${p.desc || '（无）'}`,
      ``,
      `你的专属工作区：${p.worktree}（分支 ${p.branch}）。只允许改动这个目录里的文件。`,
      `主仓库在 repo/ 目录（只读参考，里面可能有 DESIGN.md 设计文档）。`,
      p.ownsFiles.length > 0
        ? `\n文件所有权：本任务只应创建/修改以下文件——${p.ownsFiles.join('、')}。其他文件归别的任务所有，确需改动先私信协调者。`
        : ``,
      p.depsDone.length > 0
        ? [
            ``,
            `前置任务已完成并合并进 main，你的工作区基于最新 main 创建，里面已经有它们的产物——直接使用，绝不要自己重写副本：`,
            ...p.depsDone.map((d) => `- #${d.id}「${d.title}」${d.ownsFiles.length > 0 ? `（文件：${d.ownsFiles.join('、')}）` : ''}`),
          ].join('\n')
        : ``,
      p.reworkNote ? `\n注意：这是返工。上一轮的审查/测试意见如下，必须逐条解决：\n${p.reworkNote}\n` : ``,
      `完成标准：`,
      `1. 实现任务描述的功能，满足验收标准`,
      `2. 在工作区目录里运行自测通过`,
      `3. 执行 git add -A && git commit 提交（在 ${p.worktree} 目录下执行）`,
      `4. 最后输出一段总结：做了什么、改了哪些文件、自测结果`,
    ].join('\n'),
  devDoneDm: (id, s) => `任务 #${id} 开发完成，请审查。\n\n${s}`,
  noCommitsNote: (s) => `开发结束但分支没有任何提交。开发者总结：${s}`,
  reviewBrief: (p) =>
    [
      `请审查任务 #${p.id}「${p.title}」的代码变更。`,
      ``,
      `任务要求：\n${p.desc || '（无）'}`,
      ``,
      `变更 diff（分支 ${p.branch} 相对 main）：`,
      '```diff',
      p.diff,
      '```',
      ``,
      `完整代码在 ${p.worktree} 目录，需要上下文时用 Read 查看。`,
      `按你的输出格式要求给出 JSON 结论。`,
    ].join('\n'),
  reviewResultDm: (id, ok, s, f) => `任务 #${id} 审查${ok ? '通过 ✓' : '不通过 ✗'}：${s}\n${f}`,
  reviewReworkNote: (s, f) => `审查意见：\n${s}\n${f}`,
  qaBrief: (p) =>
    [
      `请验证任务 #${p.id}「${p.title}」。`,
      ``,
      `任务与验收标准：\n${p.desc || '（无）'}`,
      ``,
      `代码在工作区 ${p.worktree}（分支 ${p.branch}）。在该目录下实际运行程序和测试进行验证。`,
      `按你的输出格式要求给出 JSON 结论。`,
    ].join('\n'),
  qaResultDm: (id, ok, s, i) => `任务 #${id} QA ${ok ? '通过 ✓' : '不通过 ✗'}：${s}\n${i}`,
  qaReworkNote: (s, i) => `QA 意见：\n${s}\n${i}`,
  challengeBrief: (p) =>
    [
      `任务 #${p.id}「${p.title}」已过审查和 QA，合并前请你挑刺。`,
      ``,
      `任务与验收标准：\n${p.desc || '（无）'}`,
      ``,
      `变更 diff（分支 ${p.branch} 相对 main）：`,
      '```diff',
      p.diff,
      '```',
      ``,
      `完整代码在 ${p.worktree} 目录，需要上下文时用 Read 查看。`,
      `按你的任务挑刺规范只输出 json 结论（blocking 仅在 high 且影响正确性/需求达成时使用）。`,
    ].join('\n'),
  challengeResultDm: (id, b, s, c) => `任务 #${id} 挑刺${b ? '：拦截合并 ✗' : '：放行 ✓'}${s ? ` — ${s}` : ''}${c ? `\n${c}` : ''}`,
  challengeReworkNote: (s, c) => `质疑者拦截意见：\n${s}\n${c}`,
  finalBrief: (p) =>
    [
      `任务 #${p.id}「${p.title}」已通过全部质检环节（审查/QA/质疑），合并前请你做完成度终审。`,
      ``,
      `任务与验收标准：${p.desc || '（无描述）'}`,
      p.prdExcerpt ? `\nPRD 摘录：\n${p.prdExcerpt}` : '',
      ``,
      `QA 结论：${p.qaSummary}；质疑者结论：${p.challengeSummary}；返工次数：${p.reworkCycles}`,
      ``,
      `变更概览：`,
      p.diff || '（diff 不可用，可自行查看工作区）',
      ``,
      `对照任务验收标准与 PRD 判断该任务是否真正完成——只判完成度与需求达成（有没有漏做、做偏），不重复代码审查。只输出 json 代码块：{"complete": true} 或 {"complete": false, "gaps": [{"gap": "缺了什么", "suggestion": "怎么补"}]}`,
    ].join('\n'),
  finalResultDm: (id, complete, gapsText) => `任务 #${id} 终审${complete ? '通过 ✓，进入合并' : '未通过 ✗，打回补齐'}${gapsText ? `\n${gapsText}` : ''}`,
  finalReworkNote: (gapsText) => `协调者终审意见（完成度缺口，逐条补齐）：\n${gapsText}`,
  selftestFailNote: (cmd, output, timedOut) =>
    `【自测门失败】系统在你的工作区执行了项目自测命令 \`${cmd}\`${timedOut ? '（超时被终止——检查是否有挂死/等待输入的用例）' : '，未通过'}。请修复后确认本地跑通再重新提交。输出尾部：\n${output || '（无输出）'}`,
  mergeConflictNote: (e) => `合并冲突：${e}`,
  mergeAutoReworkNote: (id) =>
    `【合并冲突自动返工】你的分支与 main 冲突（其他任务先合并了重叠文件）。请在 wt-task-${id} 里执行 git merge main，逐个解决冲突（以 main 上已合并的实现为基准，只保留你任务新增的部分），确认测试通过后重新 git add -A && git commit。`,
  depBlockedNote: (id, title) => `【依赖阻塞】前置任务 #${id}「${title}」已被放弃/阻塞，本任务无法开工。处理好前置任务并重试它后，本任务会自动复位。`,
  taskErrorNote: (e) => `处理出错：${e}`,
  reworkTitle: (id, t, c) => `任务 #${id}「${t}」已被打回 ${c} 次，需要你决定怎么办`,
  reworkContext: (n) => `${n}\n\n团队多次修改仍未通过，可能是任务定义有问题或实现路线不对。`,
  reworkOptOneMore: '再给一轮机会',
  reworkOptForceMerge: '按当前状态强制通过（合并）',
  reworkOptAbandon: '放弃该任务',
  forcedPassNote: '用户决定强制通过',
  abandonedNote: (c) => `用户决定放弃。${c ?? ''}`,
  reworkUserNote: (n, c) => `${n}\n（用户批示：${c ?? '再修一轮'}）`,
  autoApprovedNote: '自动处理（审批策略：仅预算需人批）',
  autoExtraRoundMsg: (id, title, cycles) =>
    `任务 #${id}「${title}」已被打回 ${cycles} 次，按审批策略自动多给最后一轮机会；再失败将标记阻塞（可在看板重试或在对话里指示怎么改）。`,
  userChat: (ctx, msg, taskDetail) =>
    [
      taskDetail
        ? `【用户消息 · 任务级对话】负责人（用户）针对下面这个具体任务发来消息，请你作为协调者即时回应。`
        : `【用户消息】负责人（用户）直接发来一条消息，请你作为协调者即时回应。`,
      ``,
      `当前项目状态快照：`,
      ctx,
      ...(taskDetail ? [``, `本次对话聚焦的任务档案：`, taskDetail] : []),
      ``,
      `用户说：`,
      msg,
      ``,
      `处理规则：`,
      `1. 询问进度/情况 → 基于状态快照${taskDetail ? '与任务档案' : ''}如实简要回答（两三句话，别罗列全部细节），不要编造。`,
      ...(taskDetail
        ? [
            `2. 用户对这个任务提出修改要求时，按任务状态处理：`,
            `   - 任务未完成（assigned/in_progress/review/qa/challenge/final）→ 用 update_task 给它加备注（note 开头写「用户要求：」+ 原话要点），备注会出现在看板和下一轮返工简报里；回复里确认已记录。`,
            `   - 任务已完成（done）→ 用 create_task 建跟进任务（priority=1，depends_on=[${'该任务 id'}]，assignee 沿用原负责人），回复里确认建了什么。`,
            `   - 任务阻塞（blocked）→ 用 update_task 把用户的处理指引写进备注，并提醒用户在看板点「重试」即可带着指引重跑。`,
          ]
        : [
            `2. 提出修改要求/新需求 → 这是最高优先级：立刻用 create_task 工具创建任务（priority 设 1，标题动词开头、描述里写清验收标准，指派给合适的开发角色；要用到某个已完成任务的产物就在 depends_on 里写它的 id），然后在回复里确认建了什么任务。`,
          ]),
      `3. 简单问题 → 直接回答；答不了的说明原因。`,
      `回复直接写正文（这是发给用户的话），不要 JSON、不要开会格式。`,
    ].join('\n'),
  chatNoProject: '当前没有进行中的项目。在仪表盘创建项目后，就可以在这里跟团队对话了。',
  concurrencyLimitMsg: (name, cap) =>
    `项目「${name}」已转入等待：同时运行的项目已达上限（${cap} 个，可在设置页调整 max_concurrent_projects）。等某个项目结束后，在仪表盘点「继续」即可开跑。`,
  budgetTitle: (c, b) => `预算已用完（$${c.toFixed(2)} / $${b.toFixed(2)}），要继续吗？`,
  budgetContext: `继续运行会产生更多 API 费用。你可以追加预算，或暂停项目。`,
  budgetAdd5: '追加 $5 预算',
  budgetAdd20: '追加 $20 预算',
  budgetPause: '暂停项目',
  bashLabel: (l) => l,
  bashApprovalTitle: (l) => `${l}：需要你批准`,
  bashApprovalContext: (a, cmd, l) => `Agent「${a}」想执行命令：\n\n${cmd}\n\n类别：${l}`,
  denyOutsideWorkspace: (cwd) => `禁止修改工作区（${cwd}）以外的文件`,
  denyByUser: (l, c) => `用户驳回了「${l}」${c ? `：${c}` : ''}。请换一种不需要该操作的方案。`,
  workspaceRootNote: (cwd) =>
    `你的工作区根目录（绝对路径）：${cwd}\n提示词里的相对路径（如 repo/、wt-task-N/）都以该目录为基准。写文件时要么用相对路径，要么用以该目录开头的绝对路径，禁止自行推测其他绝对路径。`,
  skillsSectionHeader: '## 团队负责人配置的技能与规范（必须遵守）',
  dmAnswer: (f, c) => `队友 ${f} 私信问你：\n\n${c}\n\n请简短、明确地回复（直接输出回复内容，不要调用工具）。`,
  opinionSeparator: '———— 质疑者意见（供参考）————',
  adviser: (rb, t, c) =>
    [
      `有人发起了审批请求，用户（人类负责人）即将裁决。请按你的审批参谋规范给一段 ≤120 字的参考意见（真的需要吗？有无更简单/零依赖的替代？）。直接输出意见文本，不要调用工具。`,
      ``,
      `请求人：${rb}`,
      `标题：${t}`,
      `内容：\n${c || '（无）'}`,
    ].join('\n'),
  delivery: () => `所有任务已完成并合并到 main。请向用户做一段简短的项目交付总结（成果、如何运行、遗留事项）。直接输出内容。`,
  deliveryMsg: (t) => `【项目交付】${t}`,
  blockedPauseMsg: (l) => `项目暂停：以下任务无法推进，请在审批中心/看板处理后点击继续。\n${l}`,
  meetingSweptSummary: '服务中断，本会议作废重开',
  approvalExpiredComment: '服务重启，该审批已失效；相关任务如仍需要会重新发起',
  proxyFailedMsg: (detail) => `⚠ 本地模型代理（LiteLLM）启动失败：${detail}。使用该代理的角色任务会连接失败；官方与远程端点角色不受影响。处理后可在设置页「模型提供商」点检查，或重启项目。`,
  reportInstruction: (p) =>
    [
      `请写一份给用户（人类负责人）的进度报告，${p.since ? `覆盖 ${p.since} 之后的进展` : '这是第一份报告'}。`,
      `直接输出 markdown（不要代码块包裹，不要调用工具），使用你的报告格式。`,
      ``,
      `当前数据（如实引用，不要编造）：`,
      `- 项目：${p.projectName}（状态 ${p.status}）`,
      `- 任务统计：${p.taskStats}`,
      `- 任务明细：\n${p.taskLines || '（无）'}`,
      `- 待用户审批：\n${p.approvalLines || '（无）'}`,
      `- 本周期成本 $${p.costPeriod}，累计成本 $${p.costTotal}（预算 $${p.budget}）`,
    ].join('\n'),
  reportFallback: (p) =>
    [`## 本周期完成`, p.done || '（无）', `## 进行中`, p.doing || '（无）', `## 阻塞与需要你决策的事`, p.blocked || '（无）', `## 成本`, `- 本周期 $${p.costPeriod}，累计 $${p.costTotal} / 预算 $${p.budget}`].join('\n\n'),
  taskStatsLine: (p) =>
    `完成 ${p.done}/${p.total}，开发中 ${p.inprog}，审查中 ${p.review}，测试中 ${p.qa}，质疑中 ${p.challenge}，终审 ${p.final}，待开发 ${p.assigned}，阻塞 ${p.blocked}`,
  toastReportTitle: (id) => `Agent Team 进度报告 #${id}`,
  toastReportMsg: (n, d, t, p) => `${n}：完成 ${d}/${t}${p > 0 ? `，有 ${p} 件事等你审批` : ''}`,
  notifyApprovalTitle: 'Agent Team 需要你审批',
  notifyDoneTitle: '项目完成 🎉',
  notifyDoneMsg: (n) => `${n} 已交付，去看看成果吧`,
  notifyPausedTitle: '项目暂停',
  notifyPausedMsg: (c) => `有 ${c} 个任务需要你处理`,
  notifyFailedTitle: '项目失败',
  stChairing: '主持 kickoff 会议',
  stAttending: (r) => `参加 kickoff 会议（第 ${r} 轮）`,
  stClosing: '总结 kickoff 会议',
  stRevising: '修订会议总结',
  stListening: '旁听会议',
  stRespondChallenge: '回应质疑',
  stJudging: '评判回答',
  stAdjudicating: '裁决质疑分歧',
  stStandup: '主持站会',
  stDesigning: '编写设计文档',
  stChallengingDesign: '质疑设计文档',
  stRevisingDesign: '回应设计质疑',
  stDev: (id) => `开发任务 #${id}`,
  stReview: (id) => `审查任务 #${id}`,
  stQa: (id) => `测试任务 #${id}`,
  stChallenge: (id) => `挑刺任务 #${id}`,
  stFinal: (id) => `终审任务 #${id}`,
  stReport: '撰写进度报告',
  stDelivery: '撰写交付总结',
  stChat: '回复用户消息',
  chatUnavailable: (err) => `（协调者暂时无法回复，稍后会在频道里跟进。原因：${err}）`,
  stAdvising: '审批参谋',
  stBaPrd: '撰写 PRD',
  stBaRevise: '修订 PRD',
  stDistill: '提炼团队记忆',
  stReplyDm: (f) => `回复 ${f} 的私信`,
  stToolUse: (t) => `使用工具 ${t}`,
  stWaitApproval: (l) => l,
}

const BASH_LABELS_EN: Record<string, string> = {
  '递归/强制删除文件': 'Recursive/forced file deletion',
  '递归删除目录': 'Recursive directory deletion',
  '强制删除文件': 'Forced file deletion',
  'git push（推送到远程）': 'git push (to remote)',
  'git reset --hard（丢弃改动）': 'git reset --hard (discards changes)',
  'git clean（删除未跟踪文件）': 'git clean (deletes untracked files)',
  '访问外部网络': 'External network access',
  'npm 发布': 'npm publish',
  '系统级危险操作': 'System-level dangerous operation',
  安装新依赖: 'Installing a new dependency',
}

const en: Texts = {
  meetingTopic: (n) => `${n} · Requirements Review`,
  meetingAnnouncement: (r) => `[Meeting started] Project requirement:\n\n${r}`,
  transcriptIntro: (id, delta) => `Here are the statements you have not seen yet in meeting ${id}:\n\n${delta}\n\n====\n\n`,
  kickoffOpening: (n) =>
    [
      `The kickoff meeting for project "${n}" starts now. As the chair, deliver your opening statement (output the statement directly, no tools):`,
      `1. Restate the requirement in your own words; call out key open questions and risks`,
      `2. Propose a draft task breakdown (3–7 tasks, suggested assignee frontend/backend)`,
      `3. Say what you want the architect, developers and QA to each focus on`,
    ].join('\n'),
  focusArchitect: 'Technology choices, module boundaries and interface contracts. For major choices that need the user, use request_approval before speaking.',
  focusFrontend: 'Feasibility, gaps and effort for UI/interaction tasks',
  focusBackend: 'Feasibility, gaps and effort for logic/backend tasks',
  focusQa: 'Whether each task has testable acceptance criteria and what test requirements are missing',
  participantTurnFirst: (focus) => `Your turn. Respond to the discussion from your role's perspective, focusing on: ${focus}. Output your statement directly; if you truly have nothing to add, reply exactly "PASS".`,
  participantTurnLater: (round) => `Round ${round}. React to the new statements — objections or additions only; otherwise reply exactly "PASS".`,
  participantTurnObjections: (round, objections) =>
    `Round ${round}. The challenger raised the following unresolved objections. From your role's perspective, respond head-on to the items that concern you (propose a fix or justify rejecting them); if none concern you and you have nothing else, reply exactly "PASS".\n${objections}`,
  kickoffClosing: () =>
    [
      `Discussion is over — deliver the closing. Two parts required:`,
      `Part 1: prose summary (conclusions, whose suggestions were adopted, responses to challenges, risk handling).`,
      `Part 2: one \`\`\`json code block in this exact shape (this is the final task list, created on the board as-is):`,
      '```json',
      `{`,
      `  "summary": "meeting minutes (≤150 words)",`,
      `  "test_cmd": "a single command run at the project root to verify the code (e.g. node --test / npm test / python -m pytest); write null if the project doesn't suit automated verification",`,
      `  "tasks": [`,
      `    { "title": "verb-first task title", "description": "what + boundaries + acceptance criteria", "assignee": "frontend or backend",`,
      `      "depends_on": [1], "owns_files": ["src/xxx.js"] }`,
      `  ]`,
      `}`,
      '```',
      `Breakdown rules:`,
      `- test_cmd is the self-test gate: after each task's commit the system runs it in that task's worktree and bounces failures straight back to the developer — pick a zero-extra-dependency command that genuinely verifies`,
      `- Do NOT create verification-only / test-execution-only tasks ("integration verification", "end-to-end testing", etc.): the self-test gate + QA + final review already cover that, and a task with zero commits gets blocked by the system. Every task must produce code or document commits`,
      `- depends_on = 1-based ordinals of prerequisite tasks in THIS list. A task that writes tests / integrates MUST depend on the implementing task — it won't start until the dependency is done and merged; use the merged artifacts directly, never write your own copy. Omit when independent`,
      `- owns_files = files this task exclusively creates/modifies. Two tasks must never claim the same file; to use another task's file, declare a dependency instead of copying`,
      `- Parallelize whenever possible (shorter dependency chains are better); every description must contain explicit acceptance criteria`,
    ].join('\n'),
  kickoffClosingUnresolved: (objections) =>
    `\nNote: the following objections did not converge during discussion. Your closing MUST address each one explicitly — either adopt it (write it into the relevant task's description/acceptance criteria) or state why it is rejected:\n${objections}`,
  kickoffRevision: () =>
    `Based on the challenge exchange just now, output the revised final closing (same format: prose summary + \`\`\`json task list). The board will use this version.`,
  meetingConvergenceCheck: (round) =>
    `Round ${round} has ended. Looking at the whole meeting, judge whether the requirement consensus has converged: are there objections about task-split direction, ownership boundaries, or acceptance criteria that you believe MUST be resolved before work starts? Do not re-raise issues already settled in interrupts; pure taste is not an objection. Output only a json code block: {"satisfied": true} or {"satisfied": false, "objections": ["one actionable sentence each"]}`,
  objectionsMsg: (objections) => `[Not converged] The following objections need targeted responses next round:\n${objections}`,
  jsonRetry: () => `Your last reply contained no parseable \`\`\`json code block. Reply again with exactly one valid \`\`\`json code block in the previously required shape — no text outside the block.`,
  passSentinel: /^(无补充|PASS)/i,
  challengeCheck: (s) =>
    `${s} has just finished speaking. Decide whether the statement has a substantive problem (requirement drift / missed edge or failure cases / vague acceptance criteria / over-engineering / unnecessary dependencies). Criterion: interrupt if fixing it later would cost more than raising it now; let pure style/taste pass. Output exactly one json code block: {"pass": true} or {"pass": false, "challenge": "..."}`,
  challengeCheckRound: (speakers) =>
    `This round is over (speakers: ${speakers}). Decide whether any statement has a substantive problem (requirement drift / missed edge or failure cases / vague acceptance criteria / over-engineering / unnecessary dependencies). Interrupt only if fixing it later would cost more than raising it now; pick the single most important issue. Output exactly one json code block: {"pass": true} or {"pass": false, "to": "speaker id (e.g. backend)", "challenge": "..."}`,
  challengeAnswer: () => `The challenger interrupted the meeting with a challenge to you (above). Answer it head-on and concretely; if the challenge stands, accept it explicitly and state the fix. Output the answer directly.`,
  challengeEval: () => `They have answered (above). Judge per your rules. Output exactly one json code block: {"satisfied": true, "comment": "..."} or {"satisfied": false, "followup": "..."}`,
  adjudicate: (s) => `The challenger and ${s} are deadlocked on the issue above. As chair, adjudicate now: whose view is adopted and what changes to tasks/design follow. Be explicit and actionable. Output the ruling directly.`,
  interruptMsg: (s, c) => `[Interrupt → ${s}] ${c}`,
  resolvedMsg: (c) => `[Challenge resolved] ${c ?? 'Answer accepted; the meeting continues.'}`,
  followupMsg: (f) => `[Follow-up] ${f ?? 'Please answer the question above more concretely.'}`,
  deadlockMsg: (f) => `[Still unsatisfied] ${f ?? ''} (follow-up limit reached — chair, please adjudicate)`,
  standupSystem: (c) => `[Standup] ${c}`,
  standupInstruction: () =>
    `A situation needs your ruling (above). Give a clear decision with reasons. If it is a major decision (scope change / abandoning a task), use request_approval first. Output your ruling directly.`,
  baPrd: (r) =>
    [
      `The user submitted this project requirement:`,
      ``,
      r,
      ``,
      `Produce the PRD per your rules. Output exactly one json code block:`,
      '```json',
      `{`,
      `  "prd_markdown": "full PRD (markdown: goals / feature list / non-goals / testable acceptance criteria per item / constraints)",`,
      `  "open_questions": ["questions the user must clarify (empty array if none — never ask for asking's sake)"]`,
      `}`,
      '```',
    ].join('\n'),
  baRevise: (a) =>
    `The user answered the open questions:\n\n${a}\n\nRevise the PRD accordingly. Output exactly one json code block: {"prd_markdown": "revised full PRD", "open_questions": []} (unless the answers raise genuinely new must-clarify questions).`,
  baQuestionsSkipped: (q) =>
    `[Open requirement questions] The following points were unclear; I proceeded with reasonable assumptions in the PRD. If any don't match your expectations, just tell me in chat:\n\n${q}`,
  baQuestionsTitle: 'The requirement has open questions for you',
  baQuestionsContext: (q) => `While expanding the PRD, the analyst found these ambiguities. Please answer them in the comment box (approve to submit your answers):\n\n${q}`,
  prdAnnouncement: (prd) => `[Meeting started] Below is the PRD confirmed by the business analyst (task breakdown and acceptance criteria follow it):\n\n${prd}`,
  lessonsSection: (items) => `\n\n—— Team memory (pitfalls from before — read first) ——\n${items}`,
  memoryRebuildNote: '(Your session is fresh: the team memory above plus this brief is all the context you need; the design contract is repo/DESIGN.md)',
  scribeDistillTask: (p) =>
    [
      `Task #${p.id} "${p.title}" just finished after rework. Its rework/challenge history:`,
      ``,
      p.history,
      ``,
      `Distill 1–3 lessons reusable for future tasks. Output exactly one json code block:`,
      `{"lessons": [{"tags": "comma,separated,keywords", "content": "one actionable sentence — no platitudes"}]}`,
      `If nothing is reusable, output {"lessons": []}.`,
    ].join('\n'),
  scribeDistillProject: (p) =>
    [
      `Project "${p.name}" is delivered. Requirement: ${p.requirement.slice(0, 300)}`,
      ``,
      `Aggregated rework/challenge/adjudication records:`,
      p.history,
      ``,
      `Distill 1–3 cross-project lessons (shown to the whole team at the next kickoff). Output exactly one json code block:`,
      `{"lessons": [{"tags": "keywords", "content": "one sentence"}]}`,
    ].join('\n'),
  focusDevops: 'Runtime environment, dependency trade-offs (avoid installing when built-ins suffice), build & test scripts, one-command run/verify',
  designDoc: (p, s) =>
    [
      `The kickoff meeting has ended (minutes: ${s}). The task list is on the board (mcp__collab__list_tasks to view).`,
      `Write the technical design into ${p} (use the Write tool; the path must be exact). Include:`,
      `1. Technology choices and rationale (per the meeting conclusions)`,
      `2. Directory layout`,
      `3. Module/interface contracts (function signatures, data shapes, error conventions)`,
      `4. Dependencies and boundaries between tasks`,
      `Then summarize the key design points briefly.`,
    ].join('\n'),
  designChallenge: (p) =>
    `The architect just finished the design doc: ${p}. Read it and critique per your design-critique rules (focus: unnecessary third-party dependencies, over-engineering, contract gaps, missed failure paths). Output exactly one json code block: {"pass": true or false, "issues": [{"concern": "...", "suggestion": "..."}]}`,
  designIssuesMsg: (i) => `Challenges to DESIGN.md:\n${i}`,
  designRevision: (i, p) =>
    [`The challenger raised these issues with your DESIGN.md:`, i, ``, `Assess each: revise DESIGN.md directly (Write to ${p}) where valid; explain where not. Finish with a brief summary of what you did.`].join('\n'),
  designRevisionMsg: (r) => `Handling of the design challenges:\n${r}`,
  designRechallenge: (p, cycle) =>
    `The architect has revised ${p} per your previous challenges (re-review cycle ${cycle}). Read the full document again and judge: are your earlier issues resolved? Did the revision introduce new problems? If resolved, clear it decisively — do not nitpick for its own sake. Output only a json code block: {"pass": true} or {"pass": false, "issues": [{"concern": "...", "suggestion": "..."}]}`,
  designUnresolvedMsg: (i) => `[Design loop capped] The following challenges did not converge after multiple revisions. The design proceeds as-is; engineers should mitigate during development:\n${i}`,
  devBrief: (p) =>
    [
      `You are assigned task #${p.id} "${p.title}".`,
      ``,
      `Details:\n${p.desc || '(none)'}`,
      ``,
      `Your dedicated worktree: ${p.worktree} (branch ${p.branch}). Only modify files inside it.`,
      `The main repo is at repo/ (read-only reference; may contain DESIGN.md).`,
      p.ownsFiles.length > 0
        ? `\nFile ownership: this task should only create/modify — ${p.ownsFiles.join(', ')}. Other files belong to other tasks; DM the coordinator first if you must touch them.`
        : ``,
      p.depsDone.length > 0
        ? [
            ``,
            `Prerequisite tasks are done and merged into main; your worktree was created from the latest main and already contains their artifacts — use them directly, NEVER write your own copies:`,
            ...p.depsDone.map((d) => `- #${d.id} "${d.title}"${d.ownsFiles.length > 0 ? ` (files: ${d.ownsFiles.join(', ')})` : ''}`),
          ].join('\n')
        : ``,
      p.reworkNote ? `\nNote: this is rework. Address every point below from the last review/QA:\n${p.reworkNote}\n` : ``,
      `Definition of done:`,
      `1. Implement the described functionality and meet the acceptance criteria`,
      `2. Self-test passes when run inside the worktree`,
      `3. git add -A && git commit (run inside ${p.worktree})`,
      `4. Finish with a summary: what you did, files changed, self-test results`,
    ].join('\n'),
  devDoneDm: (id, s) => `Task #${id} development done, please review.\n\n${s}`,
  noCommitsNote: (s) => `Development ended but the branch has no commits. Developer summary: ${s}`,
  reviewBrief: (p) =>
    [
      `Review the changes for task #${p.id} "${p.title}".`,
      ``,
      `Task requirements:\n${p.desc || '(none)'}`,
      ``,
      `Diff (branch ${p.branch} vs main):`,
      '```diff',
      p.diff,
      '```',
      ``,
      `Full code is in ${p.worktree}; use Read for context.`,
      `Output your JSON verdict per your format.`,
    ].join('\n'),
  reviewResultDm: (id, ok, s, f) => `Task #${id} review ${ok ? 'passed ✓' : 'rejected ✗'}: ${s}\n${f}`,
  reviewReworkNote: (s, f) => `Review feedback:\n${s}\n${f}`,
  qaBrief: (p) =>
    [
      `Verify task #${p.id} "${p.title}".`,
      ``,
      `Task & acceptance criteria:\n${p.desc || '(none)'}`,
      ``,
      `Code is in worktree ${p.worktree} (branch ${p.branch}). Actually run the program and tests there.`,
      `Output your JSON verdict per your format.`,
    ].join('\n'),
  qaResultDm: (id, ok, s, i) => `Task #${id} QA ${ok ? 'passed ✓' : 'failed ✗'}: ${s}\n${i}`,
  qaReworkNote: (s, i) => `QA feedback:\n${s}\n${i}`,
  challengeBrief: (p) =>
    [
      `Task #${p.id} "${p.title}" passed review and QA. Nitpick it before merge.`,
      ``,
      `Task & acceptance criteria:\n${p.desc || '(none)'}`,
      ``,
      `Diff (branch ${p.branch} vs main):`,
      '```diff',
      p.diff,
      '```',
      ``,
      `Full code is in ${p.worktree}; use Read for context.`,
      `Output only the json verdict per your nitpicking rules (blocking only for high severity that truly affects correctness or the requirement).`,
    ].join('\n'),
  challengeResultDm: (id, b, s, c) => `Task #${id} nitpick${b ? ': merge blocked ✗' : ': cleared ✓'}${s ? ` — ${s}` : ''}${c ? `\n${c}` : ''}`,
  challengeReworkNote: (s, c) => `Challenger blocking feedback:\n${s}\n${c}`,
  finalBrief: (p) =>
    [
      `Task #${p.id} "${p.title}" has passed all quality gates (review/QA/challenge). Before merge, perform the final completeness review.`,
      ``,
      `Task & acceptance criteria: ${p.desc || '(no description)'}`,
      p.prdExcerpt ? `\nPRD excerpt:\n${p.prdExcerpt}` : '',
      ``,
      `QA verdict: ${p.qaSummary}; challenger verdict: ${p.challengeSummary}; rework cycles: ${p.reworkCycles}`,
      ``,
      `Change overview:`,
      p.diff || '(diff unavailable — inspect the worktree yourself if needed)',
      ``,
      `Judge whether the task is truly complete against its acceptance criteria and the PRD — completeness and requirement fit only (anything missed or off-target), do NOT redo code review. Output only a json code block: {"complete": true} or {"complete": false, "gaps": [{"gap": "what is missing", "suggestion": "how to fill it"}]}`,
    ].join('\n'),
  finalResultDm: (id, complete, gapsText) => `Task #${id} final review ${complete ? 'passed ✓ — proceeding to merge' : 'failed ✗ — sent back to fill the gaps'}${gapsText ? `\n${gapsText}` : ''}`,
  finalReworkNote: (gapsText) => `Coordinator final-review feedback (completeness gaps — address each):\n${gapsText}`,
  selftestFailNote: (cmd, output, timedOut) =>
    `[Self-test gate failed] The system ran the project's self-test command \`${cmd}\` in your worktree${timedOut ? ' (killed on timeout — check for hung/interactive test cases)' : ' and it failed'}. Fix it, confirm it passes locally, then commit again. Output tail:\n${output || '(no output)'}`,
  mergeConflictNote: (e) => `Merge conflict: ${e}`,
  mergeAutoReworkNote: (id) =>
    `[Auto rework: merge conflict] Your branch conflicts with main (other tasks merged overlapping files first). In wt-task-${id}, run git merge main and resolve each conflict (treat what is already merged on main as the baseline; keep only your task's additions), verify tests pass, then git add -A && git commit again.`,
  depBlockedNote: (id, title) => `[Dependency blocked] Prerequisite task #${id} "${title}" was abandoned/blocked, so this task cannot start. Fix and retry the prerequisite and this task resets automatically.`,
  taskErrorNote: (e) => `Processing error: ${e}`,
  reworkTitle: (id, t, c) => `Task #${id} "${t}" has been sent back ${c} times — your call`,
  reworkContext: (n) => `${n}\n\nRepeated fixes still fail. The task definition or the implementation approach may be wrong.`,
  reworkOptOneMore: 'One more round',
  reworkOptForceMerge: 'Force-merge as is',
  reworkOptAbandon: 'Abandon the task',
  forcedPassNote: 'User chose to force-merge',
  abandonedNote: (c) => `User chose to abandon. ${c ?? ''}`,
  reworkUserNote: (n, c) => `${n}\n(User note: ${c ?? 'one more round'})`,
  autoApprovedNote: 'Auto-handled (approval policy: budget only)',
  autoExtraRoundMsg: (id, title, cycles) =>
    `Task #${id} "${title}" has been sent back ${cycles} times. Per the approval policy it gets one final automatic round; another failure marks it blocked (retry from the board or give directions in chat).`,
  userChat: (ctx, msg, taskDetail) =>
    [
      taskDetail
        ? `[User message · task thread] The human owner sent a message about the specific task below. Respond immediately as the coordinator.`
        : `[User message] The human owner sent a direct message. Respond immediately as the coordinator.`,
      ``,
      `Current project snapshot:`,
      ctx,
      ...(taskDetail ? [``, `Task dossier for this thread:`, taskDetail] : []),
      ``,
      `The user says:`,
      msg,
      ``,
      `Rules:`,
      `1. Progress questions → answer briefly and truthfully from the snapshot${taskDetail ? ' and dossier' : ''} (2-3 sentences); never fabricate.`,
      ...(taskDetail
        ? [
            `2. Change requests about THIS task — handle by its status:`,
            `   - Not finished (assigned/in_progress/review/qa/challenge/final) → use update_task to add a note (start it with "User request:" + the gist); the note shows on the board and in the next rework brief. Confirm you recorded it.`,
            `   - Done → use create_task for a follow-up (priority=1, depends_on=[this task id], same assignee); confirm what you created.`,
            `   - Blocked → use update_task to record the user's guidance as the note, and remind them to hit Retry on the board.`,
          ]
        : [
            `2. Change requests / new requirements → HIGHEST priority: immediately use the create_task tool (priority 1, verb-first title, acceptance criteria in the description, assign a suitable dev role; declare depends_on with real task ids when it builds on a finished task), then confirm what you created in your reply.`,
          ]),
      `3. Simple questions → answer directly; if you can't, say why.`,
      `Write the reply as plain prose addressed to the user — no JSON, no meeting format.`,
    ].join('\n'),
  chatNoProject: 'No active project right now. Create one on the dashboard, then chat with the team here.',
  concurrencyLimitMsg: (name, cap) =>
    `Project "${name}" is now waiting: the concurrent-project limit (${cap}, adjustable via max_concurrent_projects in Settings) has been reached. Once another project finishes, hit "Resume" on the dashboard to start it.`,
  budgetTitle: (c, b) => `Budget exhausted ($${c.toFixed(2)} / $${b.toFixed(2)}) — continue?`,
  budgetContext: `Continuing will incur more API cost. You can add budget or pause the project.`,
  budgetAdd5: 'Add $5 budget',
  budgetAdd20: 'Add $20 budget',
  budgetPause: 'Pause the project',
  bashLabel: (l) => BASH_LABELS_EN[l] ?? l,
  bashApprovalTitle: (l) => `${l}: needs your approval`,
  bashApprovalContext: (a, cmd, l) => `Agent "${a}" wants to run:\n\n${cmd}\n\nCategory: ${l}`,
  denyOutsideWorkspace: (cwd) => `Modifying files outside the workspace (${cwd}) is forbidden`,
  denyByUser: (l, c) => `The user rejected "${l}"${c ? `: ${c}` : ''}. Find an approach that does not need this operation.`,
  workspaceRootNote: (cwd) =>
    `Your workspace root (absolute path): ${cwd}\nRelative paths in prompts (e.g. repo/, wt-task-N/) resolve against this directory. When writing files, use either relative paths or absolute paths under this root — never guess any other absolute base.`,
  skillsSectionHeader: '## Skills & conventions configured by the team owner (must follow)',
  dmAnswer: (f, c) => `Teammate ${f} DMs you:\n\n${c}\n\nReply briefly and decisively (output the reply directly, no tools).`,
  opinionSeparator: "———— Challenger's opinion (for reference) ————",
  adviser: (rb, t, c) =>
    [
      `An approval request was raised; the user (human owner) is about to decide. Per your second-opinion rules, give a reference opinion of ≤120 words (is it really needed? any simpler / zero-dependency alternative?). Output the opinion text directly, no tools.`,
      ``,
      `Requested by: ${rb}`,
      `Title: ${t}`,
      `Content:\n${c || '(none)'}`,
    ].join('\n'),
  delivery: () => `All tasks are done and merged to main. Give the user a short delivery summary (what was built, how to run it, leftovers). Output directly.`,
  deliveryMsg: (t) => `[Project delivered] ${t}`,
  blockedPauseMsg: (l) => `Project paused: these tasks cannot proceed. Handle them in Approvals/Board, then press Resume.\n${l}`,
  meetingSweptSummary: 'Service interrupted; this meeting was voided and will be re-run',
  approvalExpiredComment: 'Server restarted; this approval is stale — the task will re-request it if still needed',
  proxyFailedMsg: (detail) => `⚠ Local model proxy (LiteLLM) failed to start: ${detail}. Tasks for roles using this proxy will fail to connect; official and remote-endpoint roles are unaffected. After fixing, hit Check in Settings → Providers, or restart the project.`,
  reportInstruction: (p) =>
    [
      `Write a progress report for the user (human owner)${p.since ? `, covering progress since ${p.since}` : ' — this is the first report'}.`,
      `Output markdown directly (no code fences, no tools), using your report format.`,
      ``,
      `Current data (cite faithfully, do not invent):`,
      `- Project: ${p.projectName} (status ${p.status})`,
      `- Task stats: ${p.taskStats}`,
      `- Task detail:\n${p.taskLines || '(none)'}`,
      `- Pending user approvals:\n${p.approvalLines || '(none)'}`,
      `- Cost this period $${p.costPeriod}, total $${p.costTotal} (budget $${p.budget})`,
    ].join('\n'),
  reportFallback: (p) =>
    [`## Done this period`, p.done || '(none)', `## In progress`, p.doing || '(none)', `## Blockers & decisions needed`, p.blocked || '(none)', `## Cost`, `- This period $${p.costPeriod}, total $${p.costTotal} / budget $${p.budget}`].join('\n\n'),
  taskStatsLine: (p) =>
    `done ${p.done}/${p.total}, in progress ${p.inprog}, in review ${p.review}, in QA ${p.qa}, challenged ${p.challenge}, in final review ${p.final}, assigned ${p.assigned}, blocked ${p.blocked}`,
  toastReportTitle: (id) => `Agent Team progress report #${id}`,
  toastReportMsg: (n, d, t, p) => `${n}: ${d}/${t} done${p > 0 ? `, ${p} item(s) awaiting your approval` : ''}`,
  notifyApprovalTitle: 'Agent Team needs your approval',
  notifyDoneTitle: 'Project delivered 🎉',
  notifyDoneMsg: (n) => `${n} is done — check out the result`,
  notifyPausedTitle: 'Project paused',
  notifyPausedMsg: (c) => `${c} task(s) need your attention`,
  notifyFailedTitle: 'Project failed',
  stChairing: 'Chairing kickoff',
  stAttending: (r) => `In kickoff (round ${r})`,
  stClosing: 'Closing kickoff',
  stRevising: 'Revising closing',
  stListening: 'Listening in',
  stRespondChallenge: 'Answering a challenge',
  stJudging: 'Judging the answer',
  stAdjudicating: 'Adjudicating',
  stStandup: 'Chairing standup',
  stDesigning: 'Writing design doc',
  stChallengingDesign: 'Critiquing design',
  stRevisingDesign: 'Answering design critique',
  stDev: (id) => `Developing task #${id}`,
  stReview: (id) => `Reviewing task #${id}`,
  stQa: (id) => `Testing task #${id}`,
  stChallenge: (id) => `Nitpicking task #${id}`,
  stFinal: (id) => `Final-reviewing task #${id}`,
  stReport: 'Writing progress report',
  stDelivery: 'Writing delivery summary',
  stChat: 'Replying to the user',
  chatUnavailable: (err) => `(The coordinator can't reply right now and will follow up in the channel. Reason: ${err})`,
  stAdvising: 'Advising on approval',
  stBaPrd: 'Writing PRD',
  stBaRevise: 'Revising PRD',
  stDistill: 'Distilling team memory',
  stReplyDm: (f) => `Replying to ${f}`,
  stToolUse: (t) => `Using ${t}`,
  stWaitApproval: (l) => l,
}

export function tx(): Texts {
  return teamLang() === 'en' ? en : zh
}

export function isAgentId(id: string): id is AgentId {
  return ['coordinator', 'architect', 'frontend', 'backend', 'reviewer', 'qa', 'challenger'].includes(id)
}
