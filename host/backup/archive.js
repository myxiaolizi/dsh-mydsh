/**
 * Archive writing, encryption, splitting and extraction.
 *
 * Everything in this module streams. A backup of a 4 GiB workspace must not
 * become a 4 GiB Buffer, so each entry is pumped from its source file through
 * the compressor straight into the archive, and a restore pumps an archive
 * member straight onto disk. The only payload kept in memory is one chunk plus
 * the buffer of a synthesised entry, which is measured in kilobytes.
 *
 * The zip writer is implemented here so the plugin needs no dependency: it
 * writes raw deflate streams and the central directory itself. 7z goes through
 * the bundled `7zr` binary because a 7z writer is not practical to hand-roll.
 *
 * Encryption is one AES-256-GCM envelope applied *after* the archive exists, so
 * zip and 7z behave identically and a wrong password fails authentication
 * instead of producing garbage. Splitting then cuts the sealed file, which is
 * why an encrypted backup's parts are whole-file chunks rather than volumes the
 * archive tool understands on its own. That is a deliberate trade: single-file
 * envelope encryption is the only scheme where a forged part cannot be spliced
 * in unnoticed.
 *
 * Two format details matter for interoperability:
 *
 * - Entries are written with a trailing data descriptor (general-purpose flag
 *   bit 3), which lets one pass over a file produce both the CRC and the
 *   compressed size. The central directory still carries the real values, so
 *   readers that trust the central directory — including this module and 7-Zip
 *   — see a fully formed archive.
 * - The sealed envelope keeps the V1 header layout byte for byte, so a backup
 *   written by an earlier version still opens.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { constants as fsConstants, existsSync } from 'node:fs'
import { copyFile, link, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createDeflateRaw, createInflateRaw } from 'node:zlib'
import { ensureDir } from '../core/store.js'
import { resolveMember } from './paths.js'

const scryptAsync = promisify(scrypt)

const ENC_MAGIC = Buffer.from('DSHMYENC')
const ENC_VERSION = 1
const SCRYPT_LOG_N = 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = ENC_MAGIC.length + 4 + SALT_BYTES + IV_BYTES
const ZIP_LOCAL_SIG = 0x04034b50
const ZIP_CENTRAL_SIG = 0x02014b50
const ZIP_EOCD_SIG = 0x06054b50
const ZIP_DESCRIPTOR_SIG = 0x08074b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP_DEFLATE = 8
const ZIP_STORE = 0
const ZIP_FLAG_UTF8 = 0x0800
const ZIP_FLAG_DESCRIPTOR = 0x0008
const ZIP_VERSION = 20
const U32_MAX = 0xffffffff
const COPY_CHUNK = 1024 * 1024

/** MS-DOS date/time pair for one epoch millisecond value. */
function dosDateTime(epochMs) {
  const date = new Date(Number.isFinite(epochMs) ? epochMs : Date.now())
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** CRC-32 as the zip format requires (IEEE 802.3, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** Incremental CRC-32 over successive buffers. */
function crc32Update(state, buffer) {
  let crc = state
  for (let index = 0; index < buffer.length; index++) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

/** Await a write on a stream, respecting backpressure. */
async function writeChunk(stream, chunk) {
  if (chunk === undefined || chunk === null || chunk.length === 0) return
  if (stream.write(chunk)) return
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

/** Read a manifest entry as an async byte stream, honouring either storage form. */
async function* entryChunks(entry) {
  if (entry.data !== undefined) {
    yield Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    return
  }
  if (typeof entry.source !== 'string' || entry.source === '') return
  const input = createReadStream(entry.source, { highWaterMark: COPY_CHUNK })
  try {
    for await (const chunk of input) yield chunk
  } finally {
    input.destroy()
  }
}

/**
 * Write a zip archive from collected entries, streaming every payload.
 *
 * @param entries - manifest entries with `source` or `data`, `relative`, `skip`.
 * @param destination - archive path to create.
 * @param options - `level` (0 = store) and an optional `readEntry` fallback.
 * @returns `{ files, bytes, skipped }` actually written.
 */
export async function writeZip(entries, destination, options = {}) {
  const level = Number.isFinite(options.level) ? options.level : 6
  const method = level === 0 ? ZIP_STORE : ZIP_DEFLATE
  await ensureDir(dirname(destination))

  // A plain path-backed write stream owns its own descriptor and closes it on
  // 'finish', so there is exactly one owner of the file on every exit path.
  const stream = createWriteStream(destination, { highWaterMark: COPY_CHUNK })
  const central = []
  let offset = 0
  let files = 0
  let skipped = 0

  try {
    for (const entry of entries) {
      if (entry.skip === true) {
        skipped++
        continue
      }
      const name = Buffer.from(entry.relative, 'utf8')
      if (name.length === 0) {
        skipped++
        continue
      }
      // Prove the payload is reachable *before* the local header is written: a
      // file that vanished after collection must not leave a header with no data,
      // because the archive would then be unreadable from that point on.
      if (entry.data === undefined) {
        const readable = await stat(entry.source).catch(() => undefined)
        if (readable === undefined || !readable.isFile()) {
          skipped++
          continue
        }
        entry.bytes = readable.size
      }
      const { time, date } = dosDateTime(entry.mtimeMs)
      const localOffset = offset
      const local = Buffer.alloc(30)
      local.writeUInt32LE(ZIP_LOCAL_SIG, 0)
      local.writeUInt16LE(ZIP_VERSION, 4)
      // Bit 3 declares that the CRC and the sizes follow the payload.
      local.writeUInt16LE(ZIP_FLAG_UTF8 | ZIP_FLAG_DESCRIPTOR, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(0, 14)
      local.writeUInt32LE(0, 18)
      local.writeUInt32LE(0, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      await writeChunk(stream, local)
      await writeChunk(stream, name)
      offset += local.length + name.length

      let crc = 0xffffffff
      let rawBytes = 0
      let packedBytes = 0

      if (method === ZIP_STORE) {
        for await (const chunk of entryChunks(entry)) {
          crc = crc32Update(crc, chunk)
          rawBytes += chunk.length
          packedBytes += chunk.length
          await writeChunk(stream, chunk)
          if (offset + packedBytes > U32_MAX) {
            throw new Error('The archive exceeds the 4 GiB zip limit; choose the 7z format for a backup this large.')
          }
        }
      } else {
        // One `pipeline` owns the deflater for the whole entry. Driving `write`/
        // `drain` by hand *and* piping the same stream deadlocks: the manual
        // `write` consumes the `drain` the pipe is also waiting for. The CRC is
        // taken from the uncompressed side by an inline pass-through, and the
        // byte count from the compressed side by a counter, so a single ordered
        // pipeline produces both numbers.
        const deflate = createDeflateRaw({ level })
        const inflateCounter = new Transform({
          transform(chunk, _encoding, callback) {
            crc = crc32Update(crc, chunk)
            rawBytes += chunk.length
            callback(null, chunk)
          },
        })
        const deflateCounter = new Transform({
          transform(chunk, _encoding, callback) {
            packedBytes += chunk.length
            callback(null, chunk)
          },
        })
        await pipeline(Readable.from(entryChunks(entry)), inflateCounter, deflate, deflateCounter, async (source) => {
          for await (const chunk of source) await writeChunk(stream, chunk)
        })
        if (offset + packedBytes > U32_MAX) {
          throw new Error('The archive exceeds the 4 GiB zip limit; choose the 7z format for a backup this large.')
        }
      }

      // A zero-length file is legitimate (an empty marker or config) and is
      // archived as an empty member; `stat` above already ruled out "vanished".
      // The payload is already on disk, so the running offset only needs the
      // byte count the compressor actually emitted.
      offset += packedBytes
      const checksum = (crc ^ 0xffffffff) >>> 0
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(ZIP_DESCRIPTOR_SIG, 0)
      descriptor.writeUInt32LE(checksum, 4)
      descriptor.writeUInt32LE(packedBytes, 8)
      descriptor.writeUInt32LE(rawBytes, 12)
      await writeChunk(stream, descriptor)
      offset += descriptor.length

      const header = Buffer.alloc(46)
      header.writeUInt32LE(ZIP_CENTRAL_SIG, 0)
      header.writeUInt16LE(ZIP_VERSION, 4)
      header.writeUInt16LE(ZIP_VERSION, 6)
      header.writeUInt16LE(ZIP_FLAG_UTF8 | ZIP_FLAG_DESCRIPTOR, 8)
      header.writeUInt16LE(method, 10)
      header.writeUInt16LE(time, 12)
      header.writeUInt16LE(date, 14)
      header.writeUInt32LE(checksum, 16)
      header.writeUInt32LE(packedBytes, 20)
      header.writeUInt32LE(rawBytes, 24)
      header.writeUInt16LE(name.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE(0, 38)
      header.writeUInt32LE(localOffset, 42)
      central.push({ header, name })
      files++
      if (offset > U32_MAX) {
        throw new Error('The archive exceeds the 4 GiB zip limit; choose the 7z format for a backup this large.')
      }
    }

    const centralStart = offset
    for (const record of central) {
      await writeChunk(stream, record.header)
      await writeChunk(stream, record.name)
      offset += record.header.length + record.name.length
    }
    const centralSize = offset - centralStart
    if (centralStart > U32_MAX || offset > U32_MAX) {
      throw new Error('The archive exceeds the 4 GiB zip limit; choose the 7z format for a backup this large.')
    }
    if (central.length > 0xffff) {
      throw new Error('The archive holds more than 65535 entries; split the selection or choose the 7z format.')
    }

    const end = Buffer.alloc(22)
    end.writeUInt32LE(ZIP_EOCD_SIG, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralStart, 16)
    end.writeUInt16LE(0, 20)
    await writeChunk(stream, end)
    offset += end.length
    await new Promise((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  } catch (error) {
    stream.destroy()
    await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }

  return { files, bytes: offset, skipped }
}

/**
 * Locate the `7zr` binary: the bundled copy first, then PATH.
 *
 * The repository ships it at `<packageRoot>/bin/7zr.exe`, so `bin/` is tried
 * before the bare root (a caller that already points at `bin/` still works).
 *
 * @param packageRoot - the plugin package root (holds `bin/`).
 * @returns an absolute path, or `undefined` when unavailable.
 */
export function sevenZipBinary(packageRoot) {
  const names = process.platform === 'win32' ? ['7zr.exe', '7z.exe'] : ['7zr', '7z']
  const roots = []
  if (typeof packageRoot === 'string' && packageRoot !== '') {
    roots.push(join(packageRoot, 'bin'), packageRoot)
  }
  for (const entry of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed !== '') roots.push(trimmed)
  }
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // An unreadable PATH entry is skipped rather than fatal.
      }
    }
  }
  return undefined
}

/** Run a child process to completion and capture a bounded amount of output. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 8192) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited with ${code}: ${(stderr || stdout).split('\n').slice(-3).join(' ').slice(0, 400)}`))
    })
  })
}

/**
 * Write a 7z archive from collected entries.
 *
 * 7zr keeps the paths it is given relative to its working directory, and one
 * backup mixes sources from many roots, so the entries are staged into a
 * temporary tree of hard links first. A hard link costs no extra disk; a copy is
 * the fallback when the link cannot be made (another volume, for example).
 * Synthesised entries (the model selection record) are written out in the same
 * staging pass so the archive is a single consistent tree.
 *
 * @param entries - manifest entries with `source` or `data` and `relative`.
 * @param destination - archive path to create.
 * @param options - `binary`, `password` and `tempRoot` for the staging tree.
 * @returns `{ files, bytes, skipped }`.
 */
export async function write7z(entries, destination, options = {}) {
  const binary = options.binary
  if (binary === undefined) throw new Error('The 7z binary is not available in this installation.')
  const staging = join(options.tempRoot ?? tmpdir(), `dsh-mydsh-7z-${process.pid}-${Date.now()}`)
  await ensureDir(staging)
  await ensureDir(dirname(destination))
  let files = 0
  let skipped = 0
  try {
    for (const entry of entries) {
      if (entry.skip === true) {
        skipped++
        continue
      }
      const target = join(staging, ...entry.relative.split('/'))
      await ensureDir(dirname(target))
      try {
        if (entry.data !== undefined) {
          await writeFile(target, entry.data)
        } else {
          try {
            await link(entry.source, target)
          } catch {
            await copyFile(entry.source, target)
          }
        }
      } catch {
        skipped++
        continue
      }
      files++
    }
    const args = ['a', '-t7z', '-mx=5', '-bso0', '-bsp0', '-y', destination, '.']
    if (typeof options.password === 'string' && options.password !== '') {
      args.splice(1, 0, `-p${options.password}`, '-mhe=on')
    }
    await run(binary, args, { cwd: staging })
    const info = await stat(destination)
    return { files, bytes: info.size, skipped }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Derive the 32-byte AES key from a password and salt. */
async function deriveKey(password, salt, logN, r, p) {
  const derived = await scryptAsync(password, salt, 32, { N: 1 << logN, r, p, maxmem: 256 * 1024 * 1024 })
  return Buffer.from(derived)
}

/**
 * Seal a file with AES-256-GCM, streaming.
 *
 * Layout: `DSHMYENC` magic, version byte, scrypt parameters, salt, IV, then the
 * ciphertext, then the 16-byte GCM tag. The parameters travel with the file so a
 * backup made with different work factors still opens.
 *
 * @param source - plaintext archive path.
 * @param destination - sealed output path.
 * @param password - user password.
 * @returns the sealed byte count.
 */
export async function encryptFile(source, destination, password) {
  if (typeof password !== 'string' || password === '') throw new Error('An encryption password is required.')
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(password, salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)
  const header = Buffer.alloc(HEADER_BYTES)
  ENC_MAGIC.copy(header, 0)
  header.writeUInt8(ENC_VERSION, ENC_MAGIC.length)
  header.writeUInt8(SCRYPT_LOG_N, ENC_MAGIC.length + 1)
  header.writeUInt8(SCRYPT_R, ENC_MAGIC.length + 2)
  header.writeUInt8(SCRYPT_P, ENC_MAGIC.length + 3)
  salt.copy(header, ENC_MAGIC.length + 4)
  iv.copy(header, ENC_MAGIC.length + 4 + SALT_BYTES)

  const cipher = createCipheriv('aes-256-gcm', key, iv)

  async function* sealed() {
    yield header
    const input = createReadStream(source, { highWaterMark: COPY_CHUNK })
    for await (const chunk of input) {
      const out = cipher.update(chunk)
      if (out.length > 0) yield out
    }
    const final = cipher.final()
    if (final.length > 0) yield final
    yield cipher.getAuthTag()
  }

  await pipeline(Readable.from(sealed()), createWriteStream(destination))
  const info = await stat(destination)
  return info.size
}
/**
 * Open a sealed file, streaming, and fail loudly on a wrong password.
 *
 * A GCM tag that does not verify means the password was wrong or the bytes were
 * altered; both are reported with the same message on purpose, because telling
 * them apart would confirm a guess to someone holding only the file. The partial
 * output is removed so a caller can never mistake it for a real archive.
 *
 * @param source - sealed path.
 * @param destination - plaintext output path.
 * @param password - user password.
 */
export async function decryptFile(source, destination, password) {
  if (typeof password !== 'string' || password === '') throw new Error('Enter the backup password before restoring.')
  const total = (await stat(source)).size
  const handle = await open(source, 'r')
  let header
  try {
    header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES) {
      await handle.close()
      throw new Error('This backup file is truncated; the sealed header is incomplete.')
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  if (!header.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
    throw new Error('This file is not an encrypted dsh-mydsh backup.')
  }
  const version = header.readUInt8(ENC_MAGIC.length)
  if (version !== ENC_VERSION) throw new Error(`Unsupported backup format version ${version}.`)
  const logN = header.readUInt8(ENC_MAGIC.length + 1)
  const r = header.readUInt8(ENC_MAGIC.length + 2)
  const p = header.readUInt8(ENC_MAGIC.length + 3)
  if (logN < 10 || logN > 20 || r < 1 || p < 1) throw new Error('This backup header is malformed.')
  const salt = header.subarray(ENC_MAGIC.length + 4, ENC_MAGIC.length + 4 + SALT_BYTES)
  const iv = header.subarray(ENC_MAGIC.length + 4 + SALT_BYTES, HEADER_BYTES)
  const key = await deriveKey(password, salt, logN, r, p)

  const bodyBytes = total - HEADER_BYTES - TAG_BYTES
  if (bodyBytes < 0) throw new Error('This backup file is truncated; no payload follows the header.')

  const tagHandle = await open(source, 'r')
  let tag
  try {
    tag = Buffer.alloc(TAG_BYTES)
    await tagHandle.read(tag, 0, TAG_BYTES, total - TAG_BYTES)
  } finally {
    await tagHandle.close()
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  async function* opened() {
    const input = createReadStream(source, { start: HEADER_BYTES, end: total - TAG_BYTES - 1, highWaterMark: COPY_CHUNK })
    for await (const chunk of input) {
      const plain = decipher.update(chunk)
      if (plain.length > 0) yield plain
    }
    const final = decipher.final()
    if (final.length > 0) yield final
  }

  try {
    await pipeline(Readable.from(opened()), createWriteStream(destination))
  } catch {
    await rm(destination, { force: true }).catch(() => undefined)
    throw new Error('The password is wrong, or this backup was altered. Nothing was written.')
  }
}

/**
 * Split a file into fixed-size parts named `<name>.part01`, `.part02`, ...
 *
 * The width is at least two digits and grows so that names sort correctly even
 * past ninety-nine parts; restore still orders by the parsed number, not by the
 * text, so a legacy `.001` style group joins in the same order.
 *
 * @param source - the file to split.
 * @param partBytes - maximum part size (0 or negative means "do not split").
 * @returns the part paths in order.
 */
export async function splitFile(source, partBytes) {
  const limit = Number(partBytes)
  if (!Number.isFinite(limit) || limit <= 0) return [source]
  const total = (await stat(source)).size
  if (total <= limit) return [source]
  const count = Math.ceil(total / limit)
  const width = Math.max(2, String(count).length)
  const parts = []
  const handle = await open(source, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.min(limit, 8 * 1024 * 1024))
    let position = 0
    for (let index = 1; position < total; index++) {
      const partPath = `${source}.part${String(index).padStart(width, '0')}`
      const out = await open(partPath, 'w')
      try {
        let written = 0
        while (written < limit && position < total) {
          const want = Math.min(buffer.length, limit - written, total - position)
          const { bytesRead } = await handle.read(buffer, 0, want, position)
          if (bytesRead === 0) break
          await out.write(buffer, 0, bytesRead, written)
          written += bytesRead
          position += bytesRead
        }
      } finally {
        await out.close()
      }
      parts.push(partPath)
    }
  } finally {
    await handle.close()
  }
  await rm(source, { force: true })
  return parts
}

/** The sequence number encoded in a part file name, or NaN. */
export function partIndexOf(name) {
  const match = /\.part(\d+)$/i.exec(name) ?? /\.(\d{3,})$/.exec(name)
  return match === null ? Number.NaN : Number(match[1])
}

/**
 * Order part names by their sequence number rather than by text.
 * @param names - part file names.
 * @returns a new, ordered array.
 */
export function sortParts(names) {
  return [...names].sort((left, right) => {
    const a = partIndexOf(left)
    const b = partIndexOf(right)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b
    return left.localeCompare(right)
  })
}

/**
 * Join `<name>.partNN`-style parts back into one file, streaming.
 * @param parts - part paths in order.
 * @param destination - joined output path.
 * @returns the joined byte count.
 */
export async function joinParts(parts, destination) {
  await ensureDir(dirname(destination))
  async function* concatenated() {
    for (const part of parts) {
      const input = createReadStream(part, { highWaterMark: COPY_CHUNK })
      try {
        for await (const chunk of input) yield chunk
      } finally {
        input.destroy()
      }
    }
  }
  await pipeline(Readable.from(concatenated()), createWriteStream(destination))
  const info = await stat(destination)
  return info.size
}

/**
 * Read the central directory of a zip file.
 *
 * Reading the central directory rather than scanning local headers is what makes
 * extraction correct for archives produced by other tools: they may use data
 * descriptors, extra fields or comments, all of which leave the local header's
 * sizes unreliable.
 *
 * @param archive - zip path.
 * @returns `{ entries, commentLength }` with names, offsets and sizes.
 */
export async function readZipDirectory(archive) {
  const info = await stat(archive)
  const tailLength = Math.min(info.size, 128 * 1024)
  const handle = await open(archive, 'r')
  let tail
  try {
    tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, info.size - tailLength)
  } finally {
    await handle.close()
  }

  let eocd = -1
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === ZIP_EOCD_SIG) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('This file is not a readable zip archive (no end-of-central-directory record).')

  let total = tail.readUInt16LE(eocd + 10)
  let centralSize = tail.readUInt32LE(eocd + 12)
  let centralOffset = tail.readUInt32LE(eocd + 16)

  // Zip64: a locator sits immediately before the classic end record.
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    const zip64Offset = Number(tail.readBigUInt64LE(eocd - 20 + 8))
    const zip64Handle = await open(archive, 'r')
    try {
      const header = Buffer.alloc(56)
      await zip64Handle.read(header, 0, 56, zip64Offset)
      if (header.readUInt32LE(0) === ZIP64_EOCD_SIG) {
        total = Number(header.readBigUInt64LE(32))
        centralSize = Number(header.readBigUInt64LE(40))
        centralOffset = Number(header.readBigUInt64LE(48))
      }
    } finally {
      await zip64Handle.close()
    }
  }

  if (!Number.isFinite(total) || total < 0 || centralOffset + centralSize > info.size) {
    throw new Error('This zip archive reports an impossible central directory; it is damaged.')
  }

  const readHandle = await open(archive, 'r')
  try {
    const directory = Buffer.alloc(centralSize)
    await readHandle.read(directory, 0, centralSize, centralOffset)
    const entries = []
    let cursor = 0
    for (let index = 0; index < total; index++) {
      if (cursor + 46 > directory.length) throw new Error('This zip archive has a truncated central directory.')
      if (directory.readUInt32LE(cursor) !== ZIP_CENTRAL_SIG) {
        throw new Error('This zip archive has a damaged central directory.')
      }
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const crc = directory.readUInt32LE(cursor + 16)
      const packedBytes = directory.readUInt32LE(cursor + 20)
      const rawBytes = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      const localOffset = directory.readUInt32LE(cursor + 42)
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      entries.push({ name, method, flags, crc, packedBytes, rawBytes, localOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    return { entries, count: total }
  } finally {
    await readHandle.close()
  }
}

/**
 * Extract one zip member to `destination`, streaming and verifying its CRC.
 *
 * The CRC check is what turns "the archive was truncated" into an error instead
 * of a silently short file.
 *
 * @param archive - zip path.
 * @param entry - one record from `readZipDirectory`.
 * @param destination - absolute file path to write (already proven inside a root).
 * @returns the written byte count.
 */
export async function extractZipEntry(archive, entry, destination) {
  const handle = await open(archive, 'r')
  let dataStart
  try {
    const local = Buffer.alloc(30)
    await handle.read(local, 0, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
      throw new Error(`The archive entry "${entry.name}" has no local header.`)
    }
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    dataStart = entry.localOffset + 30 + nameLength + extraLength
  } finally {
    await handle.close()
  }

  await ensureDir(dirname(destination))
  let crc = 0xffffffff
  let written = 0

  async function* plainChunks() {
    const input = createReadStream(archive, {
      start: dataStart,
      end: dataStart + entry.packedBytes - 1,
      highWaterMark: COPY_CHUNK,
    })
    if (entry.method === ZIP_STORE) {
      for await (const chunk of input) {
        crc = crc32Update(crc, chunk)
        written += chunk.length
        yield chunk
      }
      return
    }
    if (entry.method !== ZIP_DEFLATE) {
      input.destroy()
      throw new Error(`The archive entry "${entry.name}" uses unsupported compression method ${entry.method}.`)
    }
    const inflate = createInflateRaw()
    const source = input.pipe(inflate)
    try {
      for await (const chunk of source) {
        crc = crc32Update(crc, chunk)
        written += chunk.length
        yield chunk
      }
    } finally {
      input.destroy()
      inflate.destroy()
    }
  }

  await pipeline(Readable.from(plainChunks()), createWriteStream(destination))
  const actual = (crc ^ 0xffffffff) >>> 0
  if (entry.crc !== 0 && actual !== entry.crc) {
    await rm(destination, { force: true }).catch(() => undefined)
    throw new Error(`The archive entry "${entry.name}" failed its checksum; the backup is damaged.`)
  }
  if (entry.rawBytes !== 0 && written !== entry.rawBytes) {
    await rm(destination, { force: true }).catch(() => undefined)
    throw new Error(`The archive entry "${entry.name}" is truncated.`)
  }
  return written
}

/**
 * Extract an archive into a directory.
 *
 * Every member name goes through `resolveMember` first, so an archive whose
 * entries climb out with `..` or name an absolute path is refused before
 * anything is created. Extraction is intentionally limited to a directory the
 * caller has already prepared for this purpose: the engine never points it at a
 * live session or configuration directory.
 *
 * @param archive - zip or 7z path.
 * @param destination - target directory (created).
 * @param options - `binary` for 7z extraction, `password` for 7z.
 * @returns `{ extracted, bytes }`.
 */
export async function extractArchive(archive, destination, options = {}) {
  await mkdir(destination, { recursive: true })
  const lower = archive.toLowerCase()

  if (lower.endsWith('.7z')) {
    if (options.binary === undefined) throw new Error('The 7z binary is not available in this installation.')
    const args = ['x', '-y', '-bso0', '-bsp0', `-o${destination}`, archive]
    if (typeof options.password === 'string' && options.password !== '') args.splice(1, 0, `-p${options.password}`)
    try {
      await run(options.binary, args)
    } catch (error) {
      // 7zr reports a wrong password as a plain non-zero exit with a CRC message.
      const text = String(error?.message ?? '')
      if (/password|CRC|wrong/i.test(text)) throw new Error('The password is wrong, or this 7z backup was altered.')
      throw error
    }
    return { extracted: await countTree(destination), bytes: 0 }
  }

  const { entries } = await readZipDirectory(archive)
  let extracted = 0
  let bytes = 0
  for (const entry of entries) {
    // Directory members end with a slash and carry no payload.
    if (entry.name.endsWith('/')) {
      const target = resolveMember(destination, entry.name)
      await mkdir(target, { recursive: true })
      continue
    }
    const target = resolveMember(destination, entry.name)
    bytes += await extractZipEntry(archive, entry, target)
    extracted++
  }
  if (extracted === 0) throw new Error('This archive contains no readable entry.')
  return { extracted, bytes }
}

/** Count the regular files below a restored tree. */
export async function countTree(root) {
  const queue = [root]
  let total = 0
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) queue.push(join(dir, entry.name))
      else if (entry.isFile()) total++
    }
  }
  return total
}

/** List every member name in an archive without extracting it. */
export async function listArchive(archive) {
  if (archive.toLowerCase().endsWith('.7z')) return []
  const { entries } = await readZipDirectory(archive)
  return entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name)
}

/**
 * A short, stable fingerprint of a local file, used by the sync conflict check.
 * @param path - file to hash.
 * @returns `{ bytes, sha256 }`.
 */
export async function digestFile(path) {
  const hash = createHash('sha256')
  let bytes = 0
  const input = createReadStream(path, { highWaterMark: COPY_CHUNK })
  for await (const chunk of input) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** True when the current process can write into a directory. */
export async function writableDirectory(path) {
  await mkdir(path, { recursive: true })
  const probe = join(path, `.dsh-mydsh-probe-${process.pid}-${Date.now()}`)
  try {
    const handle = await open(probe, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    await handle.close()
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** Read a small file's text, used for remote manifests. */
export async function readTextFile(path) {
  return readFile(path, 'utf8')
}
