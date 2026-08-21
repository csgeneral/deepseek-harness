/**
 * File browser plugin, browser half. One registration fills the layout-owned
 * `files` column (the rightmost panel): an in-app browser scoped to the
 * current session's workspace directory (the host enforces the root on every
 * browse call), with breadcrumb navigation, directory/file rows, and text
 * preview. It owns no cross-plugin state; the column's open/close and drag
 * geometry are `ctx.layout`'s, and the workspace root follows the session
 * through the standard `useSessions` seat.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's SlotMap merge ('files' entry) so the register
// site and PropsRuntime<'files'> resolve.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FileBrowser } from './FileBrowser.tsx'
import { en, zh, type FilesKey } from './locales.ts'

export type { FileBrowserInjected, FilesComponentProps } from './FileBrowser.tsx'
export type { FilesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The in-app file browser column copy. */
    files: FilesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'files'

/**
 * Required services (cordis fiber inject). The `files` slot is declared by
 * the ui-layout apply, whose activation order relative to this one is NOT
 * constrained: dsh.client.inject edges are informational (loading/prefetch
 * metadata, never apply sequencing), and the owner provides no waitable
 * service. apply therefore depends on the slot declaration through
 * `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'workspaces', 'layout', 'locale']

/**
 * Register the file browser once the `files` slot declaration is on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * `ctx.workspaces` service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-files: dictionaries')

  ctx.slots.inject('files', () => ctx.slots.register({
    name: 'files',
    locale: NS,
    inject: () => ({
      listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
      readTextFile: (path, maxBytes, signal) => ctx.workspaces.readTextFile(path, maxBytes, signal),
      closeFiles: () => { ctx.layout.closeFiles() },
    }),
  }, FileBrowser))
}
