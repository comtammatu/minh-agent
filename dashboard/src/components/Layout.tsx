import { Suspense, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { ThemeToggle } from './ThemeToggle'
import { StrategySelector } from './StrategySelector'
import { useSSE } from '../hooks/useSSE'
import { useSSEStore } from '../stores/sse-store'

const NAV_ITEMS = [
  { to: '/', label: 'Overview' },
  { to: '/positions', label: 'Positions' },
  { to: '/chart', label: 'Chart' },
  { to: '/journal', label: 'Journal' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/config', label: 'Config' },
] as const

export function Layout({ children }: { children: ReactNode }) {
  useSSE()
  const connected = useSSEStore((s) => s.connected)
  const lastUpdate = useSSEStore((s) => s.lastUpdate)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen bg-[var(--bg-base)]">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav
        className={`
          fixed inset-y-0 left-0 z-40 w-56 shrink-0
          border-r border-[var(--border-default)] bg-[var(--bg-surface)]
          flex flex-col transition-transform duration-200
          md:static md:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="px-4 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="text-amber-400">明</span>{' '}
              <span className="text-[var(--text-primary)]">Minh</span>
            </h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  connected ? 'bg-emerald-500' : 'bg-red-500'
                }`}
              />
              {connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <ThemeToggle />
        </div>

        <StrategySelector />

        <div className="flex-1 py-2">
          {NAV_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--bg-surface-hover)] text-[var(--text-primary)] border-l-2 border-amber-400'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border-l-2 border-transparent'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>

        {lastUpdate && (
          <div className="px-4 py-3 border-t border-[var(--border-default)] text-xs text-[var(--text-muted)]">
            Last: {new Date(lastUpdate).toLocaleTimeString()}
          </div>
        )}
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="flex items-center gap-3 border-b border-[var(--border-default)] px-4 py-3 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1 hover:bg-[var(--bg-surface-hover)]"
            aria-label="Open menu"
          >
            <svg className="h-5 w-5 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-sm font-bold tracking-tight">
            <span className="text-amber-400">明</span> Minh
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-red-500'
              }`}
            />
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 md:p-6">
          <ErrorBoundary>
            <Suspense fallback={<div className="text-[var(--text-tertiary)] text-sm">Loading...</div>}>
              {children}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
