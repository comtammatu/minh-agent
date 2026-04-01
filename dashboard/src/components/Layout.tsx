import { Suspense, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
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

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-56 shrink-0 border-r border-zinc-800 bg-zinc-900 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-800">
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-amber-400">明</span>{' '}
            <span className="text-zinc-300">Minh</span>
          </h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-red-500'
              }`}
            />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>

        <div className="flex-1 py-2">
          {NAV_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100 border-l-2 border-amber-400'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border-l-2 border-transparent'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>

        {lastUpdate && (
          <div className="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-600">
            Last: {new Date(lastUpdate).toLocaleTimeString()}
          </div>
        )}
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6">
        <ErrorBoundary>
          <Suspense fallback={<div className="text-zinc-500 text-sm">Loading...</div>}>
            {children}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}
