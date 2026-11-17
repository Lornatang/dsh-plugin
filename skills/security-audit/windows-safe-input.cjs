'use strict'

const path = require('node:path')

class SafeWindowsInputError extends Error {
  constructor(message) {
    super(message)
    this.code = 'DSH_SAFE_INPUT'
  }
}

function fail(message) { throw new SafeWindowsInputError(message) }

function loadWindowsApi() {
  try {
    const native = require(`@koromix/koffi-win32-${process.arch}`)
    if (native.version !== '3.3.8' || typeof native.load !== 'function') throw new Error('incompatible native binding')
    const kernel = native.load('kernel32.dll')
    return {
      create: kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)'),
      close: kernel.func('int __stdcall CloseHandle(void *)'),
      type: kernel.func('uint32_t __stdcall GetFileType(void *)'),
      drive: kernel.func('uint32_t __stdcall GetDriveTypeW(const char16_t *)'),
      query: kernel.func('uint32_t __stdcall QueryDosDeviceW(const char16_t *, _Out_ void *, uint32_t)'),
      finalPath: kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *, _Out_ void *, uint32_t, uint32_t)'),
      info: kernel.func('int __stdcall GetFileInformationByHandleEx(void *, int, _Out_ void *, uint32_t)'),
      size: kernel.func('int __stdcall GetFileSizeEx(void *, _Out_ void *)'),
      read: kernel.func('int __stdcall ReadFile(void *, _Out_ void *, uint32_t, _Out_ uint32_t *, void *)'),
    }
  } catch {
    fail('native Windows input protection is unavailable')
  }
}

function localPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[\\/]{2}/u.test(value)) {
    fail('input path must be a local regular file')
  }
  const absolute = path.resolve(value)
  const parsed = path.parse(absolute)
  if (!/^[a-z]:\\$/iu.test(parsed.root)) fail('input path must be a local regular file')
  const parts = absolute.slice(parsed.root.length).split('\\').filter(Boolean)
  if (!parts.length || parts.some(part => part.includes(':') || /[. ]$/u.test(part) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    fail('input path contains a device name or unsupported component')
  }
  return { root: parsed.root, parts }
}

function invalidHandle(handle) {
  return !handle || handle === -1n || handle === 0xffffffffffffffffn || handle === 0xffffffffn
}

/** Read a local regular file through pinned Windows handles, without following reparse points. */
function readFileWithinLimit(file, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) fail('invalid input size limit')
  const parsed = localPath(file)
  const native = loadWindowsApi()
  const driveType = native.drive(parsed.root)
  if (![2, 3, 5, 6].includes(driveType)) fail('input path must be on a local drive')
  const targetBuffer = Buffer.alloc(65536)
  const targetLength = native.query(parsed.root.slice(0, 2), targetBuffer, targetBuffer.length / 2)
  if (!targetLength || targetLength > targetBuffer.length / 2) fail('input path must be on a direct local drive')
  const device = targetBuffer.toString('utf16le', 0, targetLength * 2).split('\0')[0]
  if (!/^\\Device\\[^\\]+$/iu.test(device)) fail('input path must be on a direct local drive')
  const handles = []

  function open(target, directory) {
    const access = directory ? 0x80 : 0x80000000
    const share = 1
    const flags = directory ? 0x02200000 : 0x00200080
    const handle = native.create(path.toNamespacedPath(target), access, share, null, 3, flags, null)
    if (invalidHandle(handle)) fail('input could not be opened safely')
    handles.push(handle)
    if (native.type(handle) !== 1) fail('input must be a regular disk file')
    const attributes = Buffer.alloc(8)
    if (!native.info(handle, 9, attributes, attributes.length)) fail('input attributes could not be read safely')
    const bits = attributes.readUInt32LE(0)
    if (bits & 0x400) fail('input path must not contain a symlink or reparse point')
    if (directory ? !(bits & 0x10) : !!(bits & 0x10)) fail('input must be a regular file')
    return handle
  }

  try {
    const root = open(parsed.root, true)
    const nameBuffer = Buffer.alloc(65536)
    const nameLength = native.finalPath(root, nameBuffer, nameBuffer.length / 2, 1)
    if (!nameLength || nameLength >= nameBuffer.length / 2) fail('input path must be on a direct local drive')
    let current = nameBuffer.toString('utf16le', 0, nameLength * 2)
    if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\?$/iu.test(current)) fail('input path must be on a direct local drive')
    if (!current.endsWith('\\')) current += '\\'
    for (const part of parsed.parts.slice(0, -1)) {
      current = path.join(current, part)
      open(current, true)
    }
    const handle = open(path.join(current, parsed.parts.at(-1)), false)
    const size = Buffer.alloc(8)
    if (!native.size(handle, size)) fail('input size could not be read safely')
    if (size.readBigInt64LE(0) < 0n) fail('input size could not be read safely')
    if (size.readBigInt64LE(0) > BigInt(limit)) fail(`input exceeds ${limit} byte limit`)

    const chunks = []
    let total = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit - total + 1))
      const count = [0]
      if (!native.read(handle, buffer, buffer.length, count, null)) fail('input could not be read safely')
      const bytes = count[0]
      if (!Number.isInteger(bytes) || bytes < 0 || bytes > buffer.length) fail('input could not be read safely')
      if (bytes === 0) break
      total += bytes
      if (total > limit) fail(`input exceeds ${limit} byte limit`)
      chunks.push(Buffer.from(buffer.subarray(0, bytes)))
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total))
    } catch {
      fail('input is not valid UTF-8')
    }
  } finally {
    for (const handle of handles.reverse()) native.close(handle)
  }
}

module.exports = { readFileWithinLimit }
