import { describe, it, expect, beforeEach } from 'bun:test'
import {
  registerCommand,
  getCommands,
  findCommand,
  resetCommands,
  registerBuiltinCommands,
} from './commands.js'

describe('command registry', () => {
  beforeEach(() => {
    resetCommands()
  })

  it('starts empty', () => {
    expect(getCommands()).toHaveLength(0)
  })

  it('registers a command', () => {
    registerCommand({ name: 'test', description: 'A test command', handler: () => 'ok' })
    expect(getCommands()).toHaveLength(1)
    expect(getCommands()[0].name).toBe('test')
  })

  it('finds a registered command', () => {
    registerCommand({ name: 'foo', description: 'Foo', handler: () => 'bar' })
    const cmd = findCommand('foo')
    expect(cmd).not.toBeNull()
    expect(cmd!.name).toBe('foo')
  })

  it('returns null for unknown command', () => {
    expect(findCommand('nonexistent')).toBeNull()
  })

  it('resetCommands clears all', () => {
    registerCommand({ name: 'a', description: 'A', handler: () => '' })
    registerCommand({ name: 'b', description: 'B', handler: () => '' })
    expect(getCommands()).toHaveLength(2)
    resetCommands()
    expect(getCommands()).toHaveLength(0)
  })
})

describe('registerBuiltinCommands', () => {
  beforeEach(() => {
    resetCommands()
  })

  it('registers /help command', () => {
    registerBuiltinCommands()
    const cmd = findCommand('help')
    expect(cmd).not.toBeNull()
    expect(cmd!.description).toBe('Show this help message')
  })

  it('/help handler lists all commands', () => {
    registerBuiltinCommands()
    registerCommand({ name: 'status', description: 'Show agent status', handler: () => '' })

    const helpCmd = findCommand('help')!
    const reply = helpCmd.handler('', 0) as string
    expect(reply).toContain('Minh')
    expect(reply).toContain('/help')
    expect(reply).toContain('/status')
    expect(reply).toContain('Show agent status')
  })
})
