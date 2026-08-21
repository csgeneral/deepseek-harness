/** `files` namespace dictionaries: the in-app file browser column copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'browser.title': '文件',
  'browser.open': '打开文件浏览器',
  'browser.close': '收起文件浏览器',
  'browser.empty': '此目录为空',
  'browser.error': '无法读取此目录',
  'browser.home': 'Home',
  'browser.noWorkspace': '当前没有可浏览的工作区',
  'browser.truncated': '（内容已截断，仅显示开头部分）',
  'browser.previewError': '无法读取此文件',
  'row.directory.label': '目录',
  'row.file.label': '文件',
} satisfies Record<string, string>

/** The files namespace key union. */
export type FilesKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'browser.title': 'Files',
  'browser.open': 'Open file browser',
  'browser.close': 'Close file browser',
  'browser.empty': 'This directory is empty',
  'browser.error': 'Could not read this directory',
  'browser.home': 'Home',
  'browser.noWorkspace': 'No workspace to browse yet',
  'browser.truncated': '(truncated: showing the head of the file)',
  'browser.previewError': 'Could not read this file',
  'row.directory.label': 'directory',
  'row.file.label': 'file',
} satisfies Record<FilesKey, string>
