/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Entry kind: directories are enterable, files are leaves. Breadcrumb crumbs are always directories. */
  kind: 'directory' | 'file'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct children, name-sorted; symlinks to directories and files included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser. When `root` is given it
   * must be a registered workspace and only paths at or under it are served
   * (the workspace-scoped file browser); without a root the level is served
   * exactly as before, from the host account's home directory (the directory
   * picker's full-disk browse — it must reach unregistered paths to create
   * workspaces). Only served under the `browse` capability; unreadable or
   * missing targets fail with `directory-unreadable`. The carrier's request
   * signal follows the caller, stopping the backend's scan on disconnect or
   * timeout.
   */
  listDirectory(
    request: RpcRequest<{ root?: string; path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Scoped like {@link listDirectory}: when `root` is given
   * the parent must be at or under the registered workspace root. An existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ root?: string; path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Read a text file with a bounded byte cap, for in-app file preview.
   * Scoped like {@link listDirectory}: when `root` is given the file must be
   * at or under the registered workspace root. Unreadable or missing targets
   * fail with `file-unreadable`; a file whose complete content exceeds
   * `maxBytes` returns the leading prefix with `truncated` set (never an
   * error — preview is best-effort). The carrier's request signal follows
   * the caller, stopping the read on disconnect.
   */
  readTextFile(
    request: RpcRequest<{ root?: string; path: string; maxBytes?: number }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{
    /** Absolute host path that was read (echoed for the caller's bookkeeping). */
    path: string
    /** Decoded text content; at most `maxBytes` bytes. */
    text: string
    /** True when the complete file exceeded the cap and `text` is a prefix. */
    truncated: boolean
  }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>
}
