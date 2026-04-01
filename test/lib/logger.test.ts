import { describe, it, expect } from 'bun:test'
import { _fmt, _route, _passes } from '../../src/lib/logger.js'

/**
 * E21: Test logger via exported pure functions instead of spying on console.
 * Bun test runner isolates modules per test file, making console spy unreliable.
 * Testing _fmt, _route, and _passes covers all logger logic without side effects.
 */
describe('logger', () => {
  it('formats with timestamp, level, and component', () => {
    const output = _fmt('INFO', 'test', 'hello world')
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(output).toContain('[INFO ]')
    expect(output).toContain('[test]')
    expect(output).toContain('hello world')
  })

  it('pads level to 5 characters', () => {
    expect(_fmt('WARN', 'x', 'y')).toContain('[WARN ]')
    expect(_fmt('ERROR', 'x', 'y')).toContain('[ERROR]')
    expect(_fmt('DEBUG', 'x', 'y')).toContain('[DEBUG]')
    expect(_fmt('INFO', 'x', 'y')).toContain('[INFO ]')
  })

  it('routes WARN to console.warn', () => {
    expect(_route('WARN')).toBe('warn')
  })

  it('routes ERROR to console.error', () => {
    expect(_route('ERROR')).toBe('error')
  })

  it('routes INFO and DEBUG to console.log', () => {
    expect(_route('INFO')).toBe('log')
    expect(_route('DEBUG')).toBe('log')
  })

  it('filters DEBUG at default MIN_LEVEL=INFO', () => {
    expect(_passes('DEBUG')).toBe(false)
    expect(_passes('INFO')).toBe(true)
    expect(_passes('WARN')).toBe(true)
    expect(_passes('ERROR')).toBe(true)
  })
})
