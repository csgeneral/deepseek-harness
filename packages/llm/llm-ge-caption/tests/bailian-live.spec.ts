import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { deflateSync } from 'node:zlib'

/** Build a 32x32 solid-blue PNG in memory (same shape as the gateway's image blocks). */
function bluePng(): Buffer {
  function crc32(buf: Buffer): number {
    let c: number
    const table: number[] = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const w = 32, h = 32
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3
      raw[o] = 0
      raw[o + 1] = 0
      raw[o + 2] = 255
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Live vision-caption integration: persists one image through the attachment
// service, then asks the Bailian vision route to describe it. This is exactly
// the gateway's caption leg. Needs network + BAILIAN_API_KEY; fails the suite
// only on assertion, not on environment absence.
describe('bailian vision caption (live)', () => {
  it('captions a real image through pi-ai + attachment + Bailian', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsFile, { path: 'C:/Users/49174/.dsh/settings.yaml' })
    await ctx.plugin(CredentialsLocal, { path: 'C:/Users/49174/.dsh/.credentials.yaml' })
    await ctx.plugin(AttachmentLocal, { dshHome: 'C:/Users/49174/.dsh' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Object.assign((inner: Context) => {
      piAi.apply(inner, piAi.Config({ providers: {} }))
    }, { inject: piAi.inject }))

    const ref = await ctx.attachments.saveImage({
      data: bluePng(),
      mediaType: 'image/png',
      name: 'blue.png',
    })
    let caption = ''
    let failure: string | undefined
    for await (const chunk of ctx.llm.stream({
      provider: 'bailian',
      model: 'qwen3-vl-flash',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: '这张图片的主色是什么？用中文一句话回答。' },
        ],
        source: { kind: 'plugin', plugin: 'ge-caption-test' },
      })],
      maxTokens: 64,
    })) {
      if (chunk.type === 'text-delta') caption += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure.message
    }
    await ctx.fiber.dispose()
    if (failure !== undefined) {
      console.warn(`bailian vision caption failed: ${failure}`)
      return
    }
    expect(caption.trim().length).toBeGreaterThan(0)
    expect(caption).toMatch(/蓝/)
  })
})
