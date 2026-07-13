// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0.
//
// Public surface: the engine (`Apprise`), URL contract (`URLBase`), core enums,
// asset, attachment, conversion, registry, and the batch-1 meta-plugin classes.
// Importing this barrel pulls in all four meta-plugins; for tree-shaking, import
// a single plugin (or the `all` bucket) from the `./plugins/*` subpaths instead.

export { AppriseAsset } from './asset.js'
export { AppriseAttachment, AttachBase } from './attachment/base.js'
export { AttachFile } from './attachment/file.js'
export { AttachMemory } from './attachment/memory.js'
export {
  NOTIFY_FORMATS,
  NOTIFY_TYPES,
  NotifyFormat,
  NotifyImageSize,
  NotifyType,
  OVERFLOW_MODES,
  OverflowMode,
} from './common.js'
export { convertBetween } from './conversion.js'
export type { NotifyOptions } from './core/apprise.js'
export { Apprise } from './core/apprise.js'
export { NotifyBase } from './core/notify-base.js'
export { NotifyAppriseAPI } from './plugins/apprise-api.js'
export { NotifyForm } from './plugins/custom-form.js'
export { NotifyJSON } from './plugins/custom-json.js'
export { NotifyXML } from './plugins/custom-xml.js'
export type { PluginConstructor } from './registry.js'
export { registerPlugin, resolvePlugin } from './registry.js'
export type {
  ParsedUrl,
  ParsedUrlResults,
  QsdResult,
  UrlBaseArgs,
} from './url.js'
export {
  PrivacyMode,
  parseBool,
  parseUrl,
  quote,
  URLBase,
  unquote,
  urlencode,
} from './url.js'
