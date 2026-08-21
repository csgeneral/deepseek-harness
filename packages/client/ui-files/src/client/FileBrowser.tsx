/**
 * FileBrowser: the `files` column occupant. Renders one directory level from
 * the Host browse capability: a breadcrumb row (every crumb jumps) plus the
 * name-sorted child rows, directories enterable and files selectable. State
 * is component-local (current path + the in-flight listing); the column's
 * geometry and open/close are the layout owner's. The empty-path request
 * lists the Host home directory, whose crumb roots at the account home.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutline16, IconCodeOutline16, IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge ('files' entry) into this program
// so PropsRuntime<'files'> and the register-site slot name resolve.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FileBrowser.module.css'

/** Owner share (layout, via the runtime seat) + locale share + the injected data face. */
export type FilesComponentProps =
  & PropsRuntime<'files'>
  & PropsLocale<'files'>
  & FileBrowserInjected

/** Registrant-private injected share: the workspace-rooted browse face and the close control. */
export interface FileBrowserInjected {
  /** List one directory level under `root`; an absent path lists `root` itself. */
  listDirectory(root: string, path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /** Read a text file under `root` with a bounded byte cap (in-app preview). */
  readTextFile(root: string, path: string, maxBytes?: number, signal?: AbortSignal): Promise<{ path: string; text: string; truncated: boolean }>
  /** Close the files column (ctx.layout). */
  closeFiles(): void
}

/**
 * Render the file browser column.
 * @param props - composed slot props (owner share + locale + injected face).
 * @returns the browser element tree.
 */
export function FileBrowser({ collapsed, useSessions, listDirectory, readTextFile, closeFiles, t }: FilesComponentProps) {
  // The browse scope follows the current session: its workspace directory is
  // the only root the host will serve. No current session (or none carrying a
  // cwd) renders the empty state instead of a home-wide browse.
  const root = useSessions((s) => {
    const current = s.current
    if (current === undefined) return undefined
    const cwd = s.byId[current]?.cwd
    return cwd !== undefined && cwd !== '' ? cwd : undefined
  })
  const [path, setPath] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const requestRef = useRef(0)

  const load = useCallback((target: string | undefined) => {
    if (root === undefined) return
    const request = ++requestRef.current
    setError(false)
    setPreview(null)
    void listDirectory(root, target).then(
      (value) => {
        // A superseded request (a faster earlier navigation landing late)
        // must not overwrite the current row.
        if (request !== requestRef.current) return
        setListing(value)
      },
      () => {
        if (request !== requestRef.current) return
        setListing(null)
        setError(true)
      },
    )
  }, [listDirectory, root])

  // Root load on mount; the collapsed subtree stays mounted (zero width), so
  // the guard keeps a closed column from issuing a needless request on every
  // toggle — but a reopened column must still load when it never did. A new
  // session root reloads the root level (the previous path belongs to the old
  // workspace and would be rejected by the host's scope fence).
  const loadedOnce = useRef(false)
  const lastRoot = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (root === undefined) {
      setListing(null)
      return
    }
    if (collapsed && loadedOnce.current) return
    loadedOnce.current = true
    if (lastRoot.current !== root) {
      lastRoot.current = root
      setPath(undefined)
      load(undefined)
      return
    }
    load(path)
    // Only (re)load when the visibility flips or the root changes; navigation
    // is driven by the row/crumb handlers below, which call load() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, root])

  const enter = useCallback((target: string) => {
    setPath(target)
    load(target)
  }, [load])

  const openPreview = useCallback((target: string) => {
    if (root === undefined) return
    const request = ++requestRef.current
    setPreviewError(false)
    setPreview(null)
    void readTextFile(root, target).then(
      (value) => {
        if (request !== requestRef.current) return
        setPreview(value)
      },
      () => {
        if (request !== requestRef.current) return
        setPreviewError(true)
      },
    )
  }, [readTextFile, root])

  if (collapsed) return null
  if (root === undefined) {
    return (
      <div className={css.root} data-testid="file-browser">
        <div className={css.header}>
          <span className={css.title}>{t('browser.title')}</span>
          <button type="button" className={css.close} onClick={closeFiles} aria-label={t('browser.close')}>
            <IconCloseOutline16 aria-hidden="true" />
          </button>
        </div>
        <div className={css.placeholder}>{t('browser.noWorkspace')}</div>
      </div>
    )
  }
  return (
    <div className={css.root} data-testid="file-browser">
      <div className={css.header}>
        <span className={css.title}>{t('browser.title')}</span>
        <button type="button" className={css.close} onClick={closeFiles} aria-label={t('browser.close')}>
          <IconCloseOutline16 aria-hidden="true" />
        </button>
      </div>
      <div className={css.crumbs} role="navigation" aria-label={t('browser.title')}>
        {listing?.crumbs.map((crumb, index) => (
          <button
            key={crumb.path}
            type="button"
            className={css.crumb}
            // The last crumb is the current level; clicking it is a no-op
            // jump back to itself.
            aria-current={index === listing.crumbs.length - 1 ? 'page' : undefined}
            onClick={() => enter(crumb.path)}
          >
            {index === 0 ? t('browser.home') : crumb.name}
          </button>
        ))}
      </div>
      <div className={css.list}>
        {error ? (
          <div className={css.placeholder}>{t('browser.error')}</div>
        ) : listing === null ? (
          <div className={css.placeholder}>…</div>
        ) : listing.entries.length === 0 ? (
          <div className={css.placeholder}>{t('browser.empty')}</div>
        ) : (
          listing.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={clsx(css.row, entry.hidden && css.hiddenRow)}
              onClick={() => {
                if (entry.kind === 'directory') enter(entry.path)
                else openPreview(entry.path)
              }}
              aria-label={`${entry.name} (${entry.kind === 'directory' ? t('row.directory.label') : t('row.file.label')})`}
            >
              <span className={css.rowIcon} aria-hidden="true">
                {entry.kind === 'directory' ? <IconFolderOpenOutline16 /> : <IconCodeOutline16 />}
              </span>
              <span className={css.rowName}>{entry.name}</span>
            </button>
          ))
        )}
      </div>
      {preview !== null && (
        <div className={css.preview} data-testid="file-preview">
          <div className={css.previewHeader}>
            <span className={css.previewName}>{preview.path.split(/[\\/]/).at(-1)}</span>
          </div>
          <pre className={css.previewBody}>{preview.text}{preview.truncated ? `\n${t('browser.truncated')}` : ''}</pre>
        </div>
      )}
      {previewError && (
        <div className={css.preview} data-testid="file-preview-error">
          <div className={css.placeholder}>{t('browser.previewError')}</div>
        </div>
      )}
    </div>
  )
}
