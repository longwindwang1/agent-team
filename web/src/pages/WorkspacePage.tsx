import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { marked } from 'marked'
import { api, useStore } from '../lib/store'
import type { Project, Task } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { Card, PageHeader, StatusBadge } from '../components/ui'

interface TreeEntry {
  path: string
  type: 'file' | 'dir'
  size: number
}

type Tab = 'files' | 'diff' | 'preview'

/** 置顶展示的关键文档 */
const PINNED = ['PRD.md', 'DESIGN.md', 'README.md']

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 无库 diff 着色：+ 绿 / - 红 / @@ 青 / diff --git 分隔 */
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => {
        let cls = 'text-zinc-400'
        if (l.startsWith('diff --git')) cls = 'mt-3 block font-bold text-zinc-100'
        else if (l.startsWith('+++') || l.startsWith('---')) cls = 'text-zinc-500'
        else if (l.startsWith('@@')) cls = 'text-cyan-400'
        else if (l.startsWith('+')) cls = 'text-emerald-400'
        else if (l.startsWith('-')) cls = 'text-rose-400'
        return (
          <span key={i} className={`block ${cls}`}>
            {l || ' '}
          </span>
        )
      })}
    </pre>
  )
}

export default function WorkspacePage() {
  const { state } = useStore()
  const { t } = useI18n()
  const params = useParams<{ projectId?: string }>()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(params.projectId ? Number(params.projectId) : null)
  const [tab, setTab] = useState<Tab>('files')
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [fileView, setFileView] = useState<{ kind: 'text' | 'binary' | 'too_large' | 'error'; content?: string; size?: number; msg?: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [diffTask, setDiffTask] = useState<number | null>(null)
  const [diffView, setDiffView] = useState<{ diff?: string; error?: string } | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)

  const pid = projectId ?? state?.project?.id ?? null

  useEffect(() => {
    void api<Project[]>('/api/projects').then((rows) => {
      setProjects(rows)
      if (pid == null && rows.length > 0) setProjectId(rows[0].id)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadTree = useCallback(async () => {
    if (pid == null) return
    setTreeError(null)
    try {
      const r = await api<{ entries: TreeEntry[]; truncated: boolean }>(`/api/workspace/${pid}/tree`)
      setTree(r.entries)
      setTruncated(r.truncated)
      // 默认选中 PRD/DESIGN/README
      if (!selected) {
        const pin = PINNED.find((p) => r.entries.some((e) => e.path === p))
        if (pin) void openFile(pin)
      }
    } catch (e) {
      setTree([])
      setTreeError((e as Error).message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  useEffect(() => {
    setSelected(null)
    setFileView(null)
    setDiffTask(null)
    setDiffView(null)
    void loadTree()
  }, [loadTree])

  const openFile = async (rel: string) => {
    setSelected(rel)
    setTab('files')
    setFileView(null)
    try {
      const r = await api<{ content?: string; binary?: boolean; size: number }>(`/api/workspace/${pid}/file?path=${encodeURIComponent(rel)}`)
      if (r.binary) setFileView({ kind: 'binary', size: r.size })
      else setFileView({ kind: 'text', content: r.content ?? '', size: r.size })
    } catch (e) {
      const msg = (e as Error).message
      setFileView(msg.includes('过大') || msg.includes('413') ? { kind: 'too_large', msg } : { kind: 'error', msg })
    }
  }

  const openDiff = async (taskId: number) => {
    setDiffTask(taskId)
    setDiffView(null)
    try {
      const r = await api<{ diff: string }>(`/api/workspace/${pid}/tasks/${taskId}/diff`)
      setDiffView({ diff: r.diff })
    } catch (e) {
      setDiffView({ error: (e as Error).message })
    }
  }

  const tasks: Task[] = useMemo(() => (state?.tasks ?? []).filter((k) => k.project_id === pid), [state?.tasks, pid])
  const htmlFiles = useMemo(() => tree.filter((e) => e.type === 'file' && e.path.toLowerCase().endsWith('.html')), [tree])
  const previewEntry = htmlFiles.find((e) => e.path === 'index.html') ?? htmlFiles[0]

  // 树渲染：置顶文件 + 目录结构（按路径前缀折叠）
  const visible = useMemo(() => {
    const isHidden = (p: string) => {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (collapsed.has(parts.slice(0, i).join('/'))) return true
      }
      return false
    }
    return tree.filter((e) => !isHidden(e.path))
  }, [tree, collapsed])

  const toggleDir = (p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm transition-colors ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`

  return (
    <div className="flex h-full flex-col p-8">
      <PageHeader title={t('nav.workspace')} desc={t('ws.desc')} />
      <div className="mb-3 flex items-center gap-2">
        <select
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          value={pid ?? ''}
          onChange={(e) => setProjectId(Number(e.target.value))}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              #{p.id} {p.name} [{p.status}]
            </option>
          ))}
        </select>
        <div className="ml-2 flex gap-1">
          <button className={tabCls(tab === 'files')} onClick={() => setTab('files')}>
            {t('ws.filesTab')}
          </button>
          <button className={tabCls(tab === 'diff')} onClick={() => setTab('diff')}>
            {t('ws.diffTab')}
          </button>
          <button className={`${tabCls(tab === 'preview')} disabled:opacity-40`} onClick={() => setTab('preview')} disabled={!previewEntry}>
            {t('ws.previewTab')}
          </button>
        </div>
        <a
          href={pid != null ? `/api/workspace/${pid}/archive.zip` : '#'}
          className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
        >
          ↓ {t('ws.downloadZip')}
        </a>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <Card className="w-72 shrink-0 overflow-y-auto p-2">
          {treeError && <div className="p-3 text-sm text-zinc-600">{t('ws.noRepo')}</div>}
          {truncated && <div className="px-3 py-1 text-[11px] text-amber-400">{t('ws.truncated')}</div>}
          {tree
            .filter((e) => e.type === 'file' && PINNED.includes(e.path))
            .sort((a, b) => PINNED.indexOf(a.path) - PINNED.indexOf(b.path))
            .map((e) => (
              <button
                key={`pin-${e.path}`}
                onClick={() => void openFile(e.path)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                  selected === e.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <span className="rounded bg-violet-400/15 px-1 text-[10px] text-violet-300">DOC</span>
                {e.path}
              </button>
            ))}
          <div className="my-1 border-t border-zinc-800" />
          {visible.map((e) => {
            const depth = e.path.split('/').length - 1
            if (e.type === 'dir') {
              return (
                <button
                  key={e.path}
                  onClick={() => toggleDir(e.path)}
                  className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm text-zinc-400 hover:bg-zinc-800/50"
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                >
                  <span className="text-[10px]">{collapsed.has(e.path) ? '▸' : '▾'}</span>
                  {e.path.split('/').pop()}/
                </button>
              )
            }
            return (
              <button
                key={e.path}
                onClick={() => void openFile(e.path)}
                className={`flex w-full items-center justify-between gap-1 rounded px-2 py-1 text-left text-sm ${
                  selected === e.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/50'
                }`}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                <span className="truncate">{e.path.split('/').pop()}</span>
                <span className="shrink-0 text-[10px] text-zinc-600">{fmtSize(e.size)}</span>
              </button>
            )
          })}
        </Card>

        <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {tab === 'files' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!selected && <div className="p-6 text-sm text-zinc-600">{t('ws.pickFile')}</div>}
              {selected && !fileView && <div className="p-6 text-sm text-zinc-600">…</div>}
              {fileView?.kind === 'binary' && (
                <div className="p-6 text-sm text-zinc-500">
                  {t('ws.binaryFile')}（{fmtSize(fileView.size ?? 0)}）
                </div>
              )}
              {fileView?.kind === 'too_large' && <div className="p-6 text-sm text-zinc-500">{t('ws.tooLarge')}</div>}
              {fileView?.kind === 'error' && <div className="p-6 text-sm text-rose-400">{fileView.msg}</div>}
              {fileView?.kind === 'text' &&
                (selected?.toLowerCase().endsWith('.md') ? (
                  <div
                    className="prose prose-invert prose-sm max-w-none p-6"
                    dangerouslySetInnerHTML={{ __html: marked.parse(fileView.content ?? '', { async: false }) }}
                  />
                ) : (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-zinc-300">
                    {fileView.content}
                  </pre>
                ))}
            </div>
          )}

          {tab === 'diff' && (
            <>
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
                <select
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                  value={diffTask ?? ''}
                  onChange={(e) => void openDiff(Number(e.target.value))}
                >
                  <option value="" disabled>
                    {t('ws.pickTask')}
                  </option>
                  {tasks.map((k) => (
                    <option key={k.id} value={k.id}>
                      #{k.id} [{k.status}] {k.title}
                    </option>
                  ))}
                </select>
                {diffTask != null && <StatusBadge status={tasks.find((k) => k.id === diffTask)?.status ?? ''} />}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {diffView?.error && <div className="p-6 text-sm text-zinc-500">{t('ws.diffUnavailable')}: {diffView.error}</div>}
                {diffView?.diff && <DiffView text={diffView.diff} />}
                {diffTask != null && !diffView && <div className="p-6 text-sm text-zinc-600">…</div>}
              </div>
            </>
          )}

          {tab === 'preview' && previewEntry && (
            <>
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-sm text-zinc-400">
                <span className="font-mono text-xs">{previewEntry.path}</span>
                <button
                  onClick={() => setPreviewNonce((n) => n + 1)}
                  className="ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
                >
                  ↻ {t('ws.refresh')}
                </button>
              </div>
              {/* 沙箱：无 allow-same-origin / top-navigation，产物脚本运行在 opaque origin，摸不到平台存储 */}
              <iframe
                key={previewNonce}
                src={`/api/workspace/${pid}/preview/${previewEntry.path}?v=${previewNonce}`}
                sandbox="allow-scripts allow-forms allow-modals"
                className="min-h-0 flex-1 bg-white"
                title="preview"
              />
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
