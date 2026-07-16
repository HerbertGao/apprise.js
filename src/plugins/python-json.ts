// SPDX-License-Identifier: BSD-2-Clause
// Internal Python json.dumps-compatible serializer for byte-exact fixtures.

function pythonJsonString(value: string): string {
  let output = '"'
  for (let index = 0; index < value.length; index++) {
    const character = value[index] as string
    const code = value.charCodeAt(index)
    if (character === '"') output += '\\"'
    else if (character === '\\') output += '\\\\'
    else if (code === 0x08) output += '\\b'
    else if (code === 0x09) output += '\\t'
    else if (code === 0x0a) output += '\\n'
    else if (code === 0x0c) output += '\\f'
    else if (code === 0x0d) output += '\\r'
    else if (code < 0x20 || code >= 0x80) {
      output += `\\u${code.toString(16).padStart(4, '0')}`
    } else output += character
  }
  return `${output}"`
}

/** Python json.dumps defaults: ensure_ascii and `, ` / `: ` separators. */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value)
  if (typeof value === 'string') return pythonJsonString(value)
  if (Array.isArray(value)) {
    return `[${value.map(pythonJsonDumps).join(', ')}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${pythonJsonString(key)}: ${pythonJsonDumps(item)}`)
    .join(', ')}}`
}
