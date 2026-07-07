import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

/** fmtTime 等非组件代码读取的当前语言（由 Provider 同步） */
export let currentLang: Lang = 'zh'

const zh = {
  // 导航与框架
  'nav.dashboard': '仪表盘',
  'nav.meetings': '会议室',
  'nav.tasks': '任务看板',
  'nav.approvals': '审批中心',
  'nav.reports': '进度报告',
  'nav.memory': '团队记忆',
  'nav.settings': '设置',
  'app.subtitle': '多智能体协作开发',
  'app.connected': '已连接',
  'app.connecting': '连接中…',
  'app.totalCost': '累计成本',

  // 状态
  'status.idle': '空闲',
  'status.thinking': '思考中',
  'status.working': '工作中',
  'status.waiting_approval': '等待审批',
  'status.error': '出错',
  'status.backlog': '待办',
  'status.assigned': '已分派',
  'status.in_progress': '开发中',
  'status.review': '审查中',
  'status.qa': '测试中',
  'status.challenge': '质疑中',
  'status.done': '完成',
  'status.blocked': '阻塞',
  'status.running': '进行中',
  'status.paused': '已暂停',
  'status.failed': '失败',
  'status.pending': '待审批',
  'status.approved': '已批准',
  'status.rejected': '已驳回',
  'status.open': '进行中',
  'status.closed': '已结束',

  // 角色
  'agent.coordinator': '协调者',
  'agent.architect': '架构师',
  'agent.frontend': '前端工程师',
  'agent.backend': '后端工程师',
  'agent.reviewer': '审查员',
  'agent.qa': 'QA 工程师',
  'agent.challenger': '质疑者',
  'agent.ba': '需求分析师',
  'agent.devops': 'DevOps 工程师',
  'agent.scribe': '书记官',
  'agent.system': '系统',
  'agent.user': '用户',

  // 会议类型
  'mtype.kickoff': '启动会',
  'mtype.design_review': '方案评审',
  'mtype.standup': '站会',
  'mtype.retro': '复盘会',
  'mtype.adhoc': '临时会议',

  // 仪表盘
  'dash.loading': '加载中…',
  'dash.noProjectDesc': '还没有项目，先启动一个。',
  'dash.newProject': '启动一个新项目',
  'dash.newProjectDesc': '描述你的需求，Agent 团队会开 kickoff 会议、拆分任务并开始开发。重要决策会来找你审批。',
  'dash.projectName': '项目名称',
  'dash.projectNamePh': '例如：TODO 命令行工具',
  'dash.requirement': '需求描述（越具体越好）',
  'dash.requirementPh': '例如：用 Node.js 写一个 TODO 命令行工具，支持添加、列出、完成、删除任务，数据存本地 JSON 文件，要有单元测试……',
  'dash.budget': '预算上限（美元，超出自动暂停并请求审批）',
  'dash.starting': '启动中…',
  'dash.start': '启动项目',
  'dash.taskProgress': '任务进度',
  'dash.apiCalls': 'API 调用',
  'dash.outTokens': '输出 tokens',
  'dash.budgetLabel': '预算',
  'dash.team': '团队成员',
  'dash.activity': '最近活动',
  'dash.noActivity': '暂无活动',
  'dash.costByRole': '成本明细（按角色）',
  'dash.noCost': '暂无消耗',
  'dash.role': '角色',
  'dash.calls': '调用',
  'dash.cost': '成本',
  'dash.nextProject': '开始下一个项目',
  'dash.pause': '暂停',
  'dash.resume': '继续',

  // 会议室
  'meet.desc': 'Agent 团队的讨论实时显示在这里。',
  'meet.channel': '# 团队频道',
  'meet.channelDesc': '私信 · 阻塞报告 · 系统消息',
  'meet.empty': '还没有会议。启动项目后，kickoff 会议会出现在这里。',
  'meet.summary': '纪要',
  'meet.typing': '正在输入…',
  'meet.pick': '选择左侧会议查看讨论内容',

  // 任务看板
  'tasks.desc': 'Coordinator 拆分的任务在这里流转：开发 → 审查 → 测试 → 完成。',
  'tasks.blockedWarn': '⚠ 阻塞任务',
  'tasks.unassigned': '未分派',
  'tasks.rework': '打回 ×{n}',
  'tasks.retry': '重试',
  'tasks.empty': '还没有任务。启动项目后，kickoff 会议的行动项会自动生成任务。',

  // 审批中心
  'appr.desc': 'Agent 团队把最重要的决策交给你。任务会暂停等待你的决定。',
  'appr.none': '当前没有待审批事项 ✓',
  'appr.requestedBy': '由 {who} 于 {time} 发起',
  'appr.recommended': '团队推荐',
  'appr.commentPh': '给团队的意见（可选，驳回时建议说明原因）',
  'appr.approve': '批准',
  'appr.reject': '驳回',
  'appr.history': '历史记录',
  'appr.choice': '选择：{v}',
  'appr.comment': '意见：{v}',

  // 报告
  'rep.desc': 'Coordinator 每 2 小时汇总一次进展（可在设置中调整周期），也可以手动生成。',
  'rep.generate': '立即生成报告',
  'rep.generating': '生成中…',
  'rep.empty': '还没有报告。项目运行后会按周期自动生成。',
  'rep.reportN': '#{id} 进度报告',

  // 设置
  'set.desc': '调整汇报周期、预算、各角色使用的模型与协作参数。',
  'set.language': '语言',
  'set.uiLang': '界面语言',
  'set.teamLang': '团队工作语言',
  'set.teamLangHint': '决定 agent 的角色设定、会议发言与报告的语言；对新启动的 agent 会话生效',
  'set.reporting': '进度汇报',
  'set.cron': '汇报周期（cron 表达式）',
  'set.cronHint': '默认 0 */2 * * * 即每 2 小时整点汇报',
  'set.testMode': '测试模式',
  'set.testModeHint': '开启后改为每 2 分钟汇报一次，便于验证功能',
  'set.testOff': '关闭（按 cron 周期）',
  'set.testOn': '开启（每 2 分钟）',
  'set.budgetSec': '预算与协作',
  'set.budget': '预算上限（美元）',
  'set.budgetHint': '超出后暂停并请求审批',
  'set.rounds': '会议最大轮数',
  'set.roundsHint': '防止无限讨论',
  'set.cycles': '审查最大打回次数',
  'set.cyclesHint': '超过则升级给你',
  'set.models': '各角色模型',
  'set.modelsHint': '模型变更在 agent 下一次会话启动时生效。',
  'set.challengerSec': '质疑者',
  'set.chMeeting': '会议实时打断',
  'set.chMeetingHint': '每个人发言后质疑者可当场打断，回答让它满意后会议才继续',
  'set.chDesign': '设计文档质疑',
  'set.chDesignHint': 'DESIGN.md 完成后质疑一轮，架构师修订后再提交',
  'set.chTasks': '任务合并前挑刺',
  'set.chTasksHint': '过 QA 后由质疑者最后把关，严重问题会拦截返工',
  'set.chApprovals': '审批参谋意见',
  'set.chApprovalsHint': '装依赖/技术选型类审批会附上质疑者意见供你参考',
  'set.chFollowups': '单次质疑最大追问轮数',
  'set.chFollowupsHint': '仍不满意则协调者当场裁决，会议继续',
  'set.on': '开启',
  'set.off': '关闭',
  'set.rolesSec': '角色启用',
  'set.rolesHint': '关闭的角色不建会话、零成本（协调者与前后端开发常驻不可关）',
  'set.effort': 'effort',
  'set.save': '保存设置',
  'set.saving': '保存中…',
  'set.saved': '已保存 ✓',

  // 团队记忆
  'mem.desc': '踩过的坑与提炼的教训，会在任务简报和 kickoff 时自动喂给相关 agent。返工意见、质疑、你的审批批示都会自动归档。',
  'mem.searchPh': '搜索内容或标签…',
  'mem.addPh': '一句话写清楚坑/教训（手动添加的默认置顶）',
  'mem.tagsPh': '标签，逗号分隔（可选）',
  'mem.global': '跨项目通用',
  'mem.submit': '保存',
  'mem.empty': '还没有记忆。任务返工、质疑意见、审批批示会自动归档到这里。',
  'mem.pin': '置顶',
  'mem.unpin': '取消置顶',
  'mem.delete': '删除',
  'mem.globalTag': '全局',
} as const

export type I18nKey = keyof typeof zh

const en: Record<I18nKey, string> = {
  'nav.dashboard': 'Dashboard',
  'nav.meetings': 'Meeting Room',
  'nav.tasks': 'Task Board',
  'nav.approvals': 'Approvals',
  'nav.reports': 'Reports',
  'nav.memory': 'Team Memory',
  'nav.settings': 'Settings',
  'app.subtitle': 'Multi-agent dev team',
  'app.connected': 'Connected',
  'app.connecting': 'Connecting…',
  'app.totalCost': 'Total cost',

  'status.idle': 'Idle',
  'status.thinking': 'Thinking',
  'status.working': 'Working',
  'status.waiting_approval': 'Needs approval',
  'status.error': 'Error',
  'status.backlog': 'Backlog',
  'status.assigned': 'Assigned',
  'status.in_progress': 'In progress',
  'status.review': 'In review',
  'status.qa': 'In QA',
  'status.challenge': 'Challenged',
  'status.done': 'Done',
  'status.blocked': 'Blocked',
  'status.running': 'Running',
  'status.paused': 'Paused',
  'status.failed': 'Failed',
  'status.pending': 'Pending',
  'status.approved': 'Approved',
  'status.rejected': 'Rejected',
  'status.open': 'Open',
  'status.closed': 'Closed',

  'agent.coordinator': 'Coordinator',
  'agent.architect': 'Architect',
  'agent.frontend': 'Frontend Engineer',
  'agent.backend': 'Backend Engineer',
  'agent.reviewer': 'Code Reviewer',
  'agent.qa': 'QA Engineer',
  'agent.challenger': 'Challenger',
  'agent.ba': 'Business Analyst',
  'agent.devops': 'DevOps Engineer',
  'agent.scribe': 'Scribe',
  'agent.system': 'System',
  'agent.user': 'User',

  'mtype.kickoff': 'Kickoff',
  'mtype.design_review': 'Design Review',
  'mtype.standup': 'Standup',
  'mtype.retro': 'Retro',
  'mtype.adhoc': 'Ad-hoc',

  'dash.loading': 'Loading…',
  'dash.noProjectDesc': 'No project yet — start one below.',
  'dash.newProject': 'Start a new project',
  'dash.newProjectDesc':
    'Describe what you need. The agent team will hold a kickoff meeting, split tasks and start building. Important decisions come to you for approval.',
  'dash.projectName': 'Project name',
  'dash.projectNamePh': 'e.g. TODO CLI tool',
  'dash.requirement': 'Requirement (the more specific the better)',
  'dash.requirementPh':
    'e.g. Build a TODO CLI in Node.js supporting add/list/done/remove, storing data in a local JSON file, with unit tests…',
  'dash.budget': 'Budget cap (USD; auto-pauses for approval when exceeded)',
  'dash.starting': 'Starting…',
  'dash.start': 'Start project',
  'dash.taskProgress': 'Task progress',
  'dash.apiCalls': 'API calls',
  'dash.outTokens': 'Output tokens',
  'dash.budgetLabel': 'Budget',
  'dash.team': 'Team',
  'dash.activity': 'Recent activity',
  'dash.noActivity': 'No activity yet',
  'dash.costByRole': 'Cost by role',
  'dash.noCost': 'No usage yet',
  'dash.role': 'Role',
  'dash.calls': 'Calls',
  'dash.cost': 'Cost',
  'dash.nextProject': 'Start the next project',
  'dash.pause': 'Pause',
  'dash.resume': 'Resume',

  'meet.desc': 'Team discussions stream here in real time.',
  'meet.channel': '# Team Channel',
  'meet.channelDesc': 'DMs · blockers · system messages',
  'meet.empty': 'No meetings yet. The kickoff meeting appears here once a project starts.',
  'meet.summary': 'Minutes',
  'meet.typing': 'typing…',
  'meet.pick': 'Select a meeting on the left to view the discussion',

  'tasks.desc': 'Tasks split by the coordinator flow here: develop → review → QA → done.',
  'tasks.blockedWarn': '⚠ Blocked tasks',
  'tasks.unassigned': 'Unassigned',
  'tasks.rework': 'Rework ×{n}',
  'tasks.retry': 'Retry',
  'tasks.empty': 'No tasks yet. Action items from the kickoff meeting become tasks automatically.',

  'appr.desc': 'The team escalates its most important decisions to you. Work pauses until you decide.',
  'appr.none': 'Nothing pending ✓',
  'appr.requestedBy': 'Requested by {who} at {time}',
  'appr.recommended': 'Team pick',
  'appr.commentPh': 'Note to the team (optional; explain your reason when rejecting)',
  'appr.approve': 'Approve',
  'appr.reject': 'Reject',
  'appr.history': 'History',
  'appr.choice': 'Choice: {v}',
  'appr.comment': 'Note: {v}',

  'rep.desc': 'The coordinator reports every 2 hours (configurable in Settings). You can also generate one now.',
  'rep.generate': 'Generate now',
  'rep.generating': 'Generating…',
  'rep.empty': 'No reports yet. They are generated periodically while a project runs.',
  'rep.reportN': 'Progress report #{id}',

  'set.desc': 'Tune the report schedule, budget, per-role models and collaboration parameters.',
  'set.language': 'Language',
  'set.uiLang': 'Interface language',
  'set.teamLang': 'Team working language',
  'set.teamLangHint': "Controls the agents' role prompts, meeting speech and reports; applies to newly started agent sessions",
  'set.reporting': 'Progress reporting',
  'set.cron': 'Report schedule (cron expression)',
  'set.cronHint': 'Default 0 */2 * * * = every 2 hours on the hour',
  'set.testMode': 'Test mode',
  'set.testModeHint': 'Reports every 2 minutes instead — handy for verifying the feature',
  'set.testOff': 'Off (follow cron)',
  'set.testOn': 'On (every 2 minutes)',
  'set.budgetSec': 'Budget & collaboration',
  'set.budget': 'Budget cap (USD)',
  'set.budgetHint': 'Pauses for approval when exceeded',
  'set.rounds': 'Max meeting rounds',
  'set.roundsHint': 'Prevents endless discussion',
  'set.cycles': 'Max review cycles',
  'set.cyclesHint': 'Escalates to you beyond this',
  'set.models': 'Model per role',
  'set.modelsHint': "Model changes apply when the agent's next session starts.",
  'set.challengerSec': 'Challenger',
  'set.chMeeting': 'Live meeting interruptions',
  'set.chMeetingHint': 'The challenger may interrupt after any speech; the meeting only continues once satisfied',
  'set.chDesign': 'Design critique',
  'set.chDesignHint': 'One critique round on DESIGN.md; the architect revises before committing',
  'set.chTasks': 'Pre-merge nitpicking',
  'set.chTasksHint': 'Final gate after QA; serious issues block the merge and send work back',
  'set.chApprovals': 'Approval second opinions',
  'set.chApprovalsHint': "Dependency/tech-choice approvals include the challenger's opinion for you",
  'set.chFollowups': 'Max follow-ups per challenge',
  'set.chFollowupsHint': 'Beyond this the coordinator adjudicates and the meeting continues',
  'set.on': 'On',
  'set.off': 'Off',
  'set.rolesSec': 'Enabled roles',
  'set.rolesHint': 'Disabled roles get no session and cost nothing (coordinator and both devs are always on)',
  'set.effort': 'effort',
  'set.save': 'Save settings',
  'set.saving': 'Saving…',
  'set.saved': 'Saved ✓',

  'mem.desc': 'Pitfalls and distilled lessons, auto-fed to relevant agents in task briefs and at kickoff. Rework feedback, challenges and your approval notes are archived automatically.',
  'mem.searchPh': 'Search content or tags…',
  'mem.addPh': 'One clear sentence per pitfall/lesson (manual entries are pinned by default)',
  'mem.tagsPh': 'tags, comma separated (optional)',
  'mem.global': 'Cross-project',
  'mem.submit': 'Save',
  'mem.empty': 'No memory yet. Rework feedback, challenges and approval notes will be archived here automatically.',
  'mem.pin': 'Pin',
  'mem.unpin': 'Unpin',
  'mem.delete': 'Delete',
  'mem.globalTag': 'Global',
}

const DICTS: Record<Lang, Record<I18nKey, string>> = { zh, en }

export type TFunc = (key: I18nKey, vars?: Record<string, string | number>) => string

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  t: TFunc
}

const I18nCtx = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('agent-team.lang')
    return saved === 'en' ? 'en' : 'zh'
  })

  useEffect(() => {
    currentLang = lang
    localStorage.setItem('agent-team.lang', lang)
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((l: Lang) => setLangState(l), [])

  const t = useCallback<TFunc>(
    (key, vars) => {
      let s: string = DICTS[lang][key] ?? zh[key] ?? key
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      }
      return s
    },
    [lang],
  )

  return <I18nCtx.Provider value={{ lang, setLang, t }}>{children}</I18nCtx.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(I18nCtx)
  if (!v) throw new Error('useI18n must be used within I18nProvider')
  return v
}

/** 任意 from_agent 值 → 显示名（角色/system/user，未知原样返回） */
export function agentLabel(id: string, t: TFunc): string {
  const key = `agent.${id}` as I18nKey
  return key in zh ? t(key) : id
}
