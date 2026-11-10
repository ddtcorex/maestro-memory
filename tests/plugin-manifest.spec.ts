/**
 * The Claude plugin and the npm package are two artifacts that must agree.
 *
 * `plugin.json` carries the version a marketplace shows, and `.mcp.json` pins the version
 * `npx` will fetch. If either drifts from `package.json`, the plugin quietly runs an older
 * server than the one this repo tested, and nothing fails. This test is that alarm.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const pkg = read('package.json')
const plugin = read('.claude-plugin/plugin.json')
const marketplace = read('.claude-plugin/marketplace.json')
const mcp = read('.mcp.json')
const server = mcp.mcpServers['maestro-memory']

describe('claude plugin manifest', () => {
  it('ships the same version as the package', () => {
    expect(plugin.version).toBe(pkg.version)
  })

  it('pins that same version in the mcp server launch', () => {
    const spec = server.args.find((a: string) => a.startsWith(`${pkg.name}@`))
    expect(spec).toBe(`${pkg.name}@${pkg.version}`)
  })

  it('declares a marketplace entry that points at this package', () => {
    const entry = marketplace.plugins.find((p: any) => p.name === plugin.name)
    expect(entry).toBeTruthy()
    expect(entry.source).toBe('./')
  })

  it('points the plugin at an mcp file that exists', () => {
    expect(plugin.mcpServers).toBe('./.mcp.json')
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
  })

  it('declares hooks that call the published hook bin at the same version', () => {
    const hooks = read('hooks/hooks.json')
    const commands = JSON.stringify(hooks)
    expect(commands).toContain(`@ddtcorex/maestro-memory@${pkg.version}`)
    expect(commands).toContain('maestro-memory-hook session-start')
    expect(commands).toContain('maestro-memory-hook session-end')
  })

  it('wires both hooks to a real event, through the matcher shape the harness parses', () => {
    const hooks = read('hooks/hooks.json').hooks
    for (const event of ['SessionStart', 'SessionEnd']) {
      const groups = hooks[event]
      expect(Array.isArray(groups)).toBe(true)
      const command = groups.flatMap((g: any) => g.hooks ?? []).find((h: any) => h.type === 'command')
      expect(command?.command).toContain('maestro-memory-hook')
    }
  })

  it('declares the hook bin in package.json', () => {
    expect(pkg.bin['maestro-memory-hook']).toBeTruthy()
  })

  it('ships the /remember command with an argument placeholder', () => {
    const file = join(root, 'commands', 'remember.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('$ARGUMENTS')
  })

  it('ships the skill that teaches the tools', () => {
    const skill = join(root, 'skills', 'memory', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    const head = readFileSync(skill, 'utf8').split('---')[1] ?? ''
    expect(head).toContain('name: memory')
  })
})
