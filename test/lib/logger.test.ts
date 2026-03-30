import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test'

// Re-import fresh each time to test module behavior
describe('logger', () => {
  let logSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('formats with timestamp, level, and component', async () => {
    const { log } = await import('../../src/lib/logger.js')
    log.info('test', 'hello world')
    expect(logSpy).toHaveBeenCalledTimes(1)
    const output = logSpy.mock.calls[0][0] as string
    // ISO timestamp
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Level padded to 5
    expect(output).toContain('[INFO ]')
    // Component tag
    expect(output).toContain('[test]')
    // Message
    expect(output).toContain('hello world')
  })

  it('routes WARN to console.warn', async () => {
    const { log } = await import('../../src/lib/logger.js')
    log.warn('feed', 'stale data')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const output = warnSpy.mock.calls[0][0] as string
    expect(output).toContain('[WARN ]')
    expect(output).toContain('[feed]')
  })

  it('routes ERROR to console.error', async () => {
    const { log } = await import('../../src/lib/logger.js')
    log.error('db', 'connection failed')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const output = errorSpy.mock.calls[0][0] as string
    expect(output).toContain('[ERROR]')
    expect(output).toContain('[db]')
  })

  it('INFO and DEBUG route to console.log', async () => {
    const { log } = await import('../../src/lib/logger.js')
    log.info('scan', 'scanning')
    log.debug('scan', 'detail')
    // debug is filtered by default (MIN_LEVEL=INFO), so only info logged
    expect(logSpy).toHaveBeenCalledTimes(1)
  })
})
