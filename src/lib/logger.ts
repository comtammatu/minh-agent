/**
 * R6: Simple log helper — 20-line utility with levels + timestamps + component tags.
 * No external dependencies.
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'INFO'

function fmt(level: LogLevel, component: string, msg: string): string {
  const ts = new Date().toISOString()
  return `${ts} [${level.padEnd(5)}] [${component}] ${msg}`
}

function write(level: LogLevel, component: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return
  const line = fmt(level, component, msg)
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

export const log = {
  debug: (component: string, msg: string) => write('DEBUG', component, msg),
  info:  (component: string, msg: string) => write('INFO',  component, msg),
  warn:  (component: string, msg: string) => write('WARN',  component, msg),
  error: (component: string, msg: string) => write('ERROR', component, msg),
}
