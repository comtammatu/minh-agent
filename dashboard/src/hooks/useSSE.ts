/**
 * SSE connection hook — connects to all three SSE channels on mount.
 *
 * Usage: call useSSE() once in a top-level component (e.g., Layout).
 * Data flows into useSSEStore automatically.
 */

import { useEffect, useRef } from 'react'
import { useSSEStore } from '../stores/sse-store'

const SSE_CHANNELS = ['status', 'signals', 'trades'] as const

export function useSSE() {
  const { setConnected, setStatus, addSignal, addTrade } = useSSEStore()
  const sourcesRef = useRef<EventSource[]>([])

  useEffect(() => {
    const sources: EventSource[] = []

    for (const channel of SSE_CHANNELS) {
      const es = new EventSource(`/api/stream/${channel}`)

      es.onopen = () => {
        setConnected(true)
      }

      es.onerror = () => {
        setConnected(false)
      }

      if (channel === 'status') {
        es.addEventListener('status', (e) => {
          try {
            setStatus(JSON.parse(e.data))
          } catch { /* ignore malformed */ }
        })
      }

      if (channel === 'signals') {
        es.addEventListener('setup', (e) => {
          try {
            addSignal({ type: 'setup', data: JSON.parse(e.data), ts: Date.now() })
          } catch { /* ignore */ }
        })
        es.addEventListener('invalidation', (e) => {
          try {
            addSignal({ type: 'invalidation', data: JSON.parse(e.data), ts: Date.now() })
          } catch { /* ignore */ }
        })
      }

      if (channel === 'trades') {
        es.addEventListener('action', (e) => {
          try {
            addTrade({ type: 'action', data: JSON.parse(e.data), ts: Date.now() })
          } catch { /* ignore */ }
        })
      }

      sources.push(es)
    }

    sourcesRef.current = sources

    return () => {
      for (const es of sources) {
        es.close()
      }
      setConnected(false)
    }
  }, [setConnected, setStatus, addSignal, addTrade])
}
