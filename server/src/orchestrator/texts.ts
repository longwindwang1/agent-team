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
  kickoffClosing(): string
  kickoffRevision(): string
  passSentinel: RegExp
  // ---- 质疑打断 ----
  challengeCheck(speaker: string): string
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
  // ---- 设计 ----
  designDoc(designPath: string, summary: string): string
  designChallenge(designPath: string): string
  designIssuesMsg(issues: string): string
  designRevision(issues: string, designPath: string): string
  designRevisionMsg(revision: string): string
  // ---- 任务流 ----
  devBrief(p: { id: number; title: string; desc: string; worktree: string; branch: string; reworkNote?: string | null }): string
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
  mergeConflictNote(err: string): string
  taskErrorNote(err: string): string
  reworkTitle(id: number, title: string, cycles: number): string
  reworkContext(note: string): string
  reworkOptOneMore: string
  reworkOptForceMerge: string
  reworkOptAbandon: string
  forcedPassNote: string
  abandonedNote(comment?: string): string
  reworkUserNote(note: string, comment?: string): string
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
  // ---- 私信/参谋 ----
  dmAnswer(from: string, content: string): string
  adviser(requestedBy: string, title: string, context: string): string
  opinionSeparator: string
  // ---- 交付/暂停 ----
  delivery(): string
  deliveryMsg(text: string): string
  blockedPauseMsg(lines: string): string
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
  taskStatsLine(p: { done: number; total: number; inprog: number; review: number; qa: number; challenge: number; assigned: number; blocked: number }): string
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
  stReport: string
  stDelivery: string
  stAdvising: string
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
  kickoffClosing: () =>
    [
      `讨论结束，请做总结发言。要求输出两部分：`,
      `第一部分：文字总结（结论、采纳了谁的哪些建议、对质疑的回应、风险应对）。`,
      `第二部分：一个 \`\`\`json 代码块，格式如下（这是最终任务清单，会直接建到任务板上）：`,
      '```json',
      `{`,
      `  "summary": "会议纪要（150 字以内）",`,
      `  "tasks": [`,
      `    { "title": "动词开头的任务标题", "description": "做什么+边界+验收标准", "assignee": "frontend 或 backend" }`,
      `  ]`,
      `}`,
      '```',
      `注意：任务之间尽量相互独立；每个任务的 description 必须包含明确的验收标准。`,
    ].join('\n'),
  kickoffRevision: () => `根据刚才的质疑交锋，输出修订后的最终总结（同样包含文字总结 + \`\`\`json 代码块的任务清单，格式与之前一致）。任务板将以这一版为准。`,
  passSentinel: /^(无补充|PASS)/i,
  challengeCheck: (s) =>
    `刚才${s}发言完毕。判断其发言是否存在实质问题（需求偏离/遗漏边界或失败场景/验收标准含糊/过度设计/不必要依赖）。判据：如果现在不指出、会后修复的代价会更高，就应该打断；纯风格或口味问题放行。只输出 json 代码块：{"pass": true} 或 {"pass": false, "challenge": "..."}`,
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
  devBrief: (p) =>
    [
      `你被分派了任务 #${p.id}「${p.title}」。`,
      ``,
      `任务详情：\n${p.desc || '（无）'}`,
      ``,
      `你的专属工作区：${p.worktree}（分支 ${p.branch}）。只允许改动这个目录里的文件。`,
      `主仓库在 repo/ 目录（只读参考，里面可能有 DESIGN.md 设计文档）。`,
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
  mergeConflictNote: (e) => `合并冲突：${e}`,
  taskErrorNote: (e) => `处理出错：${e}`,
  reworkTitle: (id, t, c) => `任务 #${id}「${t}」已被打回 ${c} 次，需要你决定怎么办`,
  reworkContext: (n) => `${n}\n\n团队多次修改仍未通过，可能是任务定义有问题或实现路线不对。`,
  reworkOptOneMore: '再给一轮机会',
  reworkOptForceMerge: '按当前状态强制通过（合并）',
  reworkOptAbandon: '放弃该任务',
  forcedPassNote: '用户决定强制通过',
  abandonedNote: (c) => `用户决定放弃。${c ?? ''}`,
  reworkUserNote: (n, c) => `${n}\n（用户批示：${c ?? '再修一轮'}）`,
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
    `完成 ${p.done}/${p.total}，开发中 ${p.inprog}，审查中 ${p.review}，测试中 ${p.qa}，质疑中 ${p.challenge}，待开发 ${p.assigned}，阻塞 ${p.blocked}`,
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
  stReport: '撰写进度报告',
  stDelivery: '撰写交付总结',
  stAdvising: '审批参谋',
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
  kickoffClosing: () =>
    [
      `Discussion is over — deliver the closing. Two parts required:`,
      `Part 1: prose summary (conclusions, whose suggestions were adopted, responses to challenges, risk handling).`,
      `Part 2: one \`\`\`json code block in this exact shape (this is the final task list, created on the board as-is):`,
      '```json',
      `{`,
      `  "summary": "meeting minutes (≤150 words)",`,
      `  "tasks": [`,
      `    { "title": "verb-first task title", "description": "what + boundaries + acceptance criteria", "assignee": "frontend or backend" }`,
      `  ]`,
      `}`,
      '```',
      `Tasks should be as independent as possible; every description must contain explicit acceptance criteria.`,
    ].join('\n'),
  kickoffRevision: () =>
    `Based on the challenge exchange just now, output the revised final closing (same format: prose summary + \`\`\`json task list). The board will use this version.`,
  passSentinel: /^(无补充|PASS)/i,
  challengeCheck: (s) =>
    `${s} has just finished speaking. Decide whether the statement has a substantive problem (requirement drift / missed edge or failure cases / vague acceptance criteria / over-engineering / unnecessary dependencies). Criterion: interrupt if fixing it later would cost more than raising it now; let pure style/taste pass. Output exactly one json code block: {"pass": true} or {"pass": false, "challenge": "..."}`,
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
  devBrief: (p) =>
    [
      `You are assigned task #${p.id} "${p.title}".`,
      ``,
      `Details:\n${p.desc || '(none)'}`,
      ``,
      `Your dedicated worktree: ${p.worktree} (branch ${p.branch}). Only modify files inside it.`,
      `The main repo is at repo/ (read-only reference; may contain DESIGN.md).`,
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
  mergeConflictNote: (e) => `Merge conflict: ${e}`,
  taskErrorNote: (e) => `Processing error: ${e}`,
  reworkTitle: (id, t, c) => `Task #${id} "${t}" has been sent back ${c} times — your call`,
  reworkContext: (n) => `${n}\n\nRepeated fixes still fail. The task definition or the implementation approach may be wrong.`,
  reworkOptOneMore: 'One more round',
  reworkOptForceMerge: 'Force-merge as is',
  reworkOptAbandon: 'Abandon the task',
  forcedPassNote: 'User chose to force-merge',
  abandonedNote: (c) => `User chose to abandon. ${c ?? ''}`,
  reworkUserNote: (n, c) => `${n}\n(User note: ${c ?? 'one more round'})`,
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
    `done ${p.done}/${p.total}, in progress ${p.inprog}, in review ${p.review}, in QA ${p.qa}, challenged ${p.challenge}, assigned ${p.assigned}, blocked ${p.blocked}`,
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
  stReport: 'Writing progress report',
  stDelivery: 'Writing delivery summary',
  stAdvising: 'Advising on approval',
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
