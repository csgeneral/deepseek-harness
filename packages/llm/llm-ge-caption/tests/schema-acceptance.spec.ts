import { describe, expect, it } from 'vitest'
import { Config, isGatewayImageCapable } from '../src/config.ts'

describe('ge-caption Config schema accepts the profile patch shape', () => {
  it('resolves the full entry config from the patch', () => {
    const resolved = Config({
      enabled: true,
      vision: { provider: 'bailian', model: 'qwen3-vl-flash' },
      text: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(resolved.enabled).toBe(true)
    expect(resolved.vision).toEqual({ provider: 'bailian', model: 'qwen3-vl-flash' })
    expect(resolved.text).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('rejects a config without vision (the original patch bug)', () => {
    expect(() => Config({ enabled: false })).toThrow()
  })
})

describe('isGatewayImageCapable', () => {
  it('is true only when enabled with a complete vision leg', () => {
    expect(isGatewayImageCapable(undefined)).toBe(false)
    expect(isGatewayImageCapable({ enabled: true })).toBe(false)
    expect(isGatewayImageCapable({ enabled: false, vision: { provider: 'p', model: 'm' } })).toBe(false)
    expect(isGatewayImageCapable({ enabled: true, vision: { provider: '', model: 'm' } })).toBe(false)
    expect(isGatewayImageCapable({ enabled: true, vision: { provider: 'p', model: '' } })).toBe(false)
    expect(isGatewayImageCapable({ enabled: true, vision: { provider: 'p', model: 'm' } })).toBe(true)
  })
})
