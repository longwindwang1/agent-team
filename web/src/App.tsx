import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useStore } from './lib/store'
import { useI18n, type I18nKey, type Lang } from './lib/i18n'
import Dashboard from './pages/Dashboard'
import MeetingRoom from './pages/MeetingRoom'
import TaskBoardPage from './pages/TaskBoardPage'
import Approvals from './pages/Approvals'
import Reports from './pages/Reports'
import Settings from './pages/Settings'

const NAV: Array<{ to: string; key: I18nKey; icon: string }> = [
  { to: '/', key: 'nav.dashboard', icon: '◆' },
  { to: '/meetings', key: 'nav.meetings', icon: '◇' },
  { to: '/tasks', key: 'nav.tasks', icon: '▤' },
  { to: '/approvals', key: 'nav.approvals', icon: '✓' },
  { to: '/reports', key: 'nav.reports', icon: '≡' },
  { to: '/settings', key: 'nav.settings', icon: '⚙' },
]

export default function App() {
  const { state, connected } = useStore()
  const { t, lang, setLang } = useI18n()
  const pending = state?.approvals.filter((a) => a.status === 'pending').length ?? 0
  const cost = state?.usage.total.cost_usd ?? 0

  return (
    <div className="flex h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
        <div className="px-4 py-5">
          <div className="text-lg font-semibold tracking-wide text-zinc-100">Agent Team</div>
          <div className="mt-0.5 text-xs text-zinc-500">{t('app.subtitle')}</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }: { isActive: boolean }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }`
              }
            >
              <span className="w-4 text-center text-xs opacity-70">{n.icon}</span>
              {t(n.key)}
              {n.key === 'nav.approvals' && pending > 0 && (
                <span className="ml-auto rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white">{pending}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              {connected ? t('app.connected') : t('app.connecting')}
            </div>
            <div className="flex overflow-hidden rounded border border-zinc-700 text-[10px]">
              {(['zh', 'en'] as Lang[]).map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`px-1.5 py-0.5 uppercase transition-colors ${lang === l ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1.5">
            {t('app.totalCost')} ${cost.toFixed(2)}
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/meetings" element={<MeetingRoom />} />
          <Route path="/tasks" element={<TaskBoardPage />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
