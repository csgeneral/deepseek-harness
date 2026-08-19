import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import * as geCaption from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadViaLoader(
  configLines: readonly string[],
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ge-caption-loader-'))
  const configFile = join(root, 'cordis.yml')
  await writeFile(configFile, [...configLines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', SettingsFile],
    ['@deepseek-ai/dsh-llm-ge-caption', geCaption],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configFile).href },
  })
  await context.loader.await()
  return context
}

describe('ge-caption via the real loader path', () => {
  it('loads as an entry row and registers the settings namespace', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-ge-caption-loader-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'ge-caption:\n  enabled: true\n  vision:\n    provider: bailian\n    model: qwen3-vl-flash\n')

    const ctx = await loadViaLoader([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: '${settingsPath.replace(/\\/g, '/')}'`,
      '- id: ge-caption',
      "  name: '@deepseek-ai/dsh-llm-ge-caption'",
      '  config:',
      '    enabled: true',
      '    vision:',
      '      provider: bailian',
      '      model: qwen3-vl-flash',
      '    text:',
      '      provider: deepseek-official',
      '      model: deepseek-v4-flash',
    ])
    const settings = ctx.get('settings')
    expect(settings).toBeDefined()
    const namespaces = settings!.describe().map(d => d.ns)
    expect(namespaces).toContain('ge-caption')
    const resolved = settings!.get('ge-caption' as never) as { enabled: boolean; vision: { provider: string } }
    expect(resolved.enabled).toBe(true)
    expect(resolved.vision.provider).toBe('bailian')
  })
})
