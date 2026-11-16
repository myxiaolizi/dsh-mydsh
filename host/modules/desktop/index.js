/**
 * Desktop automation: screen capture, mouse, keyboard, window inventory.
 *
 * The equivalent reference plugin drives a separate Python MCP server. That whole
 * stack exists because an MCP server has no other way to reach the desktop; a
 * DSH Host plugin does, so this module spends no dependency and instead calls
 * the one programming interface Windows has always had: user32/gdi32 through
 * PowerShell.
 *
 * Two design rules decide the shape of this file.
 *
 * **The model never writes a command.** Only eight structured instruction kinds
 * are accepted, every parameter is validated against a whitelist here, and the
 * PowerShell script that executes them is a *fixed artefact* committed inside
 * this module. Nothing is ever interpolated into a command line: arguments
 * travel as separate argv entries and, when a value is textually free (typed
 * text), it travels base64-encoded as opaque data.
 *
 * **Every switch is real.** A capability the user turned off is refused with a
 * reason before any process starts, and `confirmEach` turns every mutating
 * action into a two-step one: the caller must echo `confirm: true`, which is
 * what an interactive confirmation dialog sends after the user agrees. A
 * refusal is never silent or partial.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LIMITS,
  budget,
  describe,
  failure,
  flag,
  hasMethod,
  intIn,
  moduleSettings,
  record,
  safeSegment,
  serviceOf,
  text,
} from '../shared.js'

/** Every call is bounded; a stuck SendInput must never wedge a route. */
const ACTION_TIMEOUT_MS = 20000

/**
 * Virtual-key codes accepted by `kind: 'key'`.
 *
 * The whitelist is intentionally short. It covers editing, navigation and
 * modifiers — the keys a legitimate automation sequence needs — and excludes
 * everything whose effect is not visible in a screenshot (system keys, the
 * Windows key, media keys, IME switches).
 */
/** Named keys: editing, navigation, modifiers, digits and the function row. */
const NAMED_KEYS = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  '0': 0x30,
  '1': 0x31,
  '2': 0x32,
  '3': 0x33,
  '4': 0x34,
  '5': 0x35,
  '6': 0x36,
  '7': 0x37,
  '8': 0x38,
  '9': 0x39,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
}

/**
 * The complete key vocabulary: named keys plus `a`–`z`.
 * Letters are derived from their code points rather than typed out, so the table
 * cannot drift from the alphabet.
 */
const VIRTUAL_KEYS = { ...NAMED_KEYS }
for (let code = 0x41; code <= 0x5a; code++) VIRTUAL_KEYS[String.fromCharCode(code + 32)] = code
Object.freeze(VIRTUAL_KEYS)

/**
 * Modifier names accepted as the `+`-separated prefix of a key combo.
 *
 * The Windows key is deliberately absent. `Win+R`, `Win+X` and `Win+L` reach the
 * shell, the system menu and the lock screen — none of which a screenshot can
 * show and none of which a "confirm once" dialog protects against.
 */
const MODIFIERS = Object.freeze({ ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12 })

/** Instruction kinds this module accepts. Anything else is refused outright. */
const KINDS = Object.freeze(['capture', 'move', 'click', 'scroll', 'type', 'key', 'windows', 'focus'])

/** Kinds that change machine state, so `confirmEach` applies to them. */
const MUTATING = Object.freeze(new Set(['move', 'click', 'scroll', 'type', 'key', 'focus']))

/** Mouse buttons and their `mouse_event` flag pair (down, up). */
const BUTTONS = Object.freeze({
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
})

/**
 * The fixed PowerShell artefact.
 *
 * It is written once to `<DSH_HOME>/dsh-mydsh/scripts/desktop.ps1` and then
 * invoked by path. Keeping it a file rather than `-Command` is what makes
 * "no model text reaches a shell" structural: the process arguments are only
 * ever `-File <path>` plus scalars this module already validated.
 *
 * The C# body is used through `Add-Type`, so no compiler or NuGet package is
 * required; `System.Drawing` and `System.Windows.Forms` ship with Windows
 * PowerShell 5.1, which is why `powershell.exe` is preferred over `pwsh`.
 */
const SCRIPT_BODY = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Op,
  [string]$Path = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$ButtonDown = 0,
  [int]$ButtonUp = 0,
  [int]$Delta = 0,
  [string]$TextB64 = '',
  [string]$KeyCodes = '',
  [int]$Pid2 = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$source = @'
using System;
using System.Runtime.InteropServices;

namespace MyDsh {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
      public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
      public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    // One structured mouse event; the flag pair is resolved by the caller.
    public static void Mouse(uint down, uint up) {
      INPUT[] batch = new INPUT[2];
      batch[0].type = INPUT_MOUSE; batch[0].u.mi.dwFlags = down;
      batch[1].type = INPUT_MOUSE; batch[1].u.mi.dwFlags = up;
      SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Wheel(int delta) {
      INPUT[] batch = new INPUT[1];
      batch[0].type = INPUT_MOUSE; batch[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL; batch[0].u.mi.mouseData = (uint)delta;
      SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    // Virtual-key down or up, used for named keys and modifiers.
    public static void Key(ushort vk, bool up) {
      INPUT[] batch = new INPUT[1];
      batch[0].type = INPUT_KEYBOARD;
      batch[0].u.ki.wVk = vk;
      batch[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
      SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    // One UTF-16 code unit as text; no keyboard layout is involved, so a
    // non-Latin comment box receives the exact characters that were sent.
    public static void Unicode(char unit) {
      INPUT[] batch = new INPUT[2];
      batch[0].type = INPUT_KEYBOARD; batch[0].u.ki.wScan = unit; batch[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
      batch[1].type = INPUT_KEYBOARD; batch[1].u.ki.wScan = unit; batch[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null
[MyDsh.Native]::SetProcessDPIAware() | Out-Null

function Write-Result($value) {
  Write-Output ($value | ConvertTo-Json -Compress -Depth 4)
}

switch ($Op) {
  'screen' {
    $width = [MyDsh.Native]::GetSystemMetrics(0)
    $height = [MyDsh.Native]::GetSystemMetrics(1)
    Write-Result @{ ok = $true; width = $width; height = $height }
  }
  'capture' {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $width = [MyDsh.Native]::GetSystemMetrics(0)
    $height = [MyDsh.Native]::GetSystemMetrics(1)
    if ($width -le 0 -or $height -le 0) { Write-Result @{ ok = $false; message = 'the desktop reported no usable size' }; exit 0 }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
      $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
    Write-Result @{ ok = $true; path = $Path; width = $width; height = $height }
  }
  'move' {
    $moved = [MyDsh.Native]::SetCursorPos($X, $Y)
    Write-Result @{ ok = $moved; x = $X; y = $Y }
  }
  'click' {
    [MyDsh.Native]::SetCursorPos($X, $Y) | Out-Null
    [MyDsh.Native]::Mouse([uint32]$ButtonDown, [uint32]$ButtonUp)
    Write-Result @{ ok = $true; x = $X; y = $Y }
  }
  'scroll' {
    [MyDsh.Native]::Wheel($Delta)
    Write-Result @{ ok = $true; delta = $Delta }
  }
  'type' {
    $bytes = [Convert]::FromBase64String($TextB64)
    $value = [System.Text.Encoding]::UTF8.GetString($bytes)
    foreach ($unit in $value.ToCharArray()) { [MyDsh.Native]::Unicode($unit) }
    Write-Result @{ ok = $true; chars = $value.Length }
  }
  'key' {
    # KeyCodes is a validated comma-separated list: press in order, release in reverse.
    $codes = @()
    foreach ($part in $KeyCodes.Split(',')) {
      if ($part -match '^\d+$') { $codes += [uint16]$part }
    }
    if ($codes.Count -eq 0) { Write-Result @{ ok = $false; message = 'no key was supplied' }; exit 0 }
    foreach ($code in $codes) { [MyDsh.Native]::Key($code, $false) }
    for ($index = $codes.Count - 1; $index -ge 0; $index--) { [MyDsh.Native]::Key($codes[$index], $true) }
    Write-Result @{ ok = $true; keys = $codes.Count }
  }
  'windows' {
    $rows = @()
    foreach ($process in @(Get-Process | Where-Object { $_.MainWindowTitle -ne '' })) {
      $rows += @{ pid = $process.Id; title = $process.MainWindowTitle; process = $process.ProcessName }
      if ($rows.Count -ge 200) { break }
    }
    $foreground = [MyDsh.Native]::GetForegroundWindow().ToInt64()
    Write-Result @{ ok = $true; windows = $rows; foregroundHandle = $foreground }
  }
  'focus' {
    $target = Get-Process -Id $Pid2 -ErrorAction SilentlyContinue
    if ($null -eq $target) { Write-Result @{ ok = $false; message = 'no process with that id' }; exit 0 }
    if ($target.MainWindowHandle -eq 0) { Write-Result @{ ok = $false; message = 'that process has no window' }; exit 0 }
    [MyDsh.Native]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
    $focused = [MyDsh.Native]::SetForegroundWindow($target.MainWindowHandle)
    Write-Result @{ ok = $focused; pid = $Pid2; title = $target.MainWindowTitle }
  }
  default { Write-Result @{ ok = $false; message = 'unknown operation' } }
}
`

/**
 * Create the desktop module.
 * @param options.ctx - plugin context; `subprocess` is consulted but optional.
 * @param options.getSettings - synchronous settings reader.
 * @param options.dshHome - the plugin's private directory. The Host names this
 *   option `home` at its own call site; both spellings are accepted so the two
 *   halves cannot drift into a silently undefined base directory.
 * @param options.home - alias for `dshHome`.
 * @param options.onNotice - called with a short object on a refused action.
 * @returns the desktop surface used by the `/desktop/*` routes.
 */
export function createDesktop({ ctx, getSettings, dshHome, home, onNotice }) {
  const settingsOf = () => moduleSettings(getSettings, 'desktop')

  /** The base directory captures and the script live under. */
  const baseDir = dshHome ?? home ?? join(process.cwd(), 'dsh-mydsh')

  /** Where captures land. */
  const capturesDir = () => join(baseDir, 'screenshots')

  /** Where the fixed script is materialised. */
  const scriptPath = () => join(baseDir, 'scripts', 'desktop.ps1')

  /** The script is written at most once per process unless it was removed. */
  let scriptReady

  /**
   * Resolve the PowerShell executable to run.
   *
   * `powershell.exe` (5.1) is preferred because `System.Drawing` and
   * `System.Windows.Forms` are guaranteed present there; `pwsh` is the fallback
   * for a machine where the legacy host has been removed.
   * @returns the executable name.
   */
  const shellExe = () => (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')

  /** Write the script unless it already exists with the expected body. */
  async function ensureScript() {
    if (scriptReady !== undefined) return scriptReady
    scriptReady = (async () => {
      const path = scriptPath()
      await mkdir(join(baseDir, 'scripts'), { recursive: true })
      await mkdir(capturesDir(), { recursive: true })
      await writeFile(path, SCRIPT_BODY, 'utf8')
      return path
    })().catch((error) => {
      scriptReady = undefined
      throw error
    })
    return scriptReady
  }

  /**
   * Explain why the module cannot run, or why one capability is off.
   * @returns `{ available, reason, capabilities }`.
   */
  function capabilities() {
    const settings = settingsOf()
    const enabled = settings.enabled === true
    const allowScreen = flag(settings.allowScreen, true)
    const allowMouse = flag(settings.allowMouse, false)
    const allowKeyboard = flag(settings.allowKeyboard, false)
    const confirmEach = flag(settings.confirmEach, true)
    if (process.platform !== 'win32') {
      return {
        available: false,
        reason: `桌面自动化只支持 Windows（当前平台 ${process.platform}）`,
        capabilities: { capture: false, screenSize: false, mouse: false, keyboard: false, windows: false, focus: false, confirmEach },
      }
    }
    if (!enabled) {
      return {
        available: false,
        reason: '桌面自动化模块未启用',
        capabilities: { capture: false, screenSize: false, mouse: false, keyboard: false, windows: false, focus: false, confirmEach },
      }
    }
    return {
      available: allowScreen || allowMouse || allowKeyboard,
      reason: allowScreen || allowMouse || allowKeyboard ? '' : '读屏、鼠标与键盘三项能力均已关闭',
      capabilities: {
        capture: allowScreen,
        screenSize: allowScreen,
        mouse: allowMouse,
        keyboard: allowKeyboard,
        windows: allowScreen,
        focus: allowMouse,
        confirmEach,
      },
    }
  }

  /**
   * Run one script operation.
   *
   * Arguments are passed as separate argv entries to `-File`, so no shell ever
   * parses a value. The timeout kills the process tree: a hung `SendInput`
   * thread inside the child would otherwise outlive the request.
   * @param args - validated `-Name value` pairs.
   * @returns the parsed JSON result, or a failure.
   */
  async function runScript(args) {
    let script
    try {
      script = await ensureScript()
    } catch (error) {
      return failure(`无法准备桌面脚本：${describe(error)}`)
    }
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]
    const watch = budget(ACTION_TIMEOUT_MS, 'the desktop action exceeded its time budget')
    try {
      const result = await new Promise((resolvePromise) => {
        const subprocess = serviceOf(ctx, 'subprocess')
        // The service is preferred when a profile provides it because it owns
        // the process range and its guaranteed teardown. Either way the call is
        // argv-only.
        if (hasMethod(subprocess, 'spawn')) {
          const handle = subprocess.spawn({
            argv: [shellExe(), ...argv],
            cwd: baseDir,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
            graceMs: 2000,
            signal: watch.signal,
          })
          const finish = (value) => resolvePromise(value)
          handle.done.then(
            () => {
              const out = handle.collected.stdout?.readFrom(0)?.text ?? ''
              const err = handle.collected.stderr?.readFrom(0)?.text ?? ''
              finish({ error: undefined, stdout: out, stderr: err })
            },
            (error) => finish({ error, stdout: '', stderr: '' }),
          )
          return
        }
        const child = spawn(shellExe(), argv, { cwd: baseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8').slice(0, 256 * 1024)
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8').slice(0, 32 * 1024)
        })
        // The timeout must actually kill the child. The collected-stream path
        // gets this from `signal`; a bare `spawn` needs it wired by hand, or a
        // hung script would keep a PowerShell process alive after the request
        // returned.
        const onAbort = () => {
          try {
            child.kill()
          } catch {
            // Already gone.
          }
        }
        watch.signal.addEventListener('abort', onAbort, { once: true })
        child.on('error', (error) => {
          watch.signal.removeEventListener('abort', onAbort)
          resolvePromise({ error, stdout, stderr })
        })
        child.on('close', () => {
          watch.signal.removeEventListener('abort', onAbort)
          resolvePromise({ error: undefined, stdout, stderr })
        })
      })

      if (result.error !== undefined) {
        const message = watch.signal.aborted ? '桌面操作超时（20 秒），已终止' : describe(result.error)
        return failure(message)
      }
      const line = String(result.stdout ?? '')
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('{'))
        .pop()
      if (line === undefined) {
        const diagnostic = String(result.stderr ?? '').trim().slice(0, 300)
        return failure(diagnostic === '' ? '桌面脚本没有返回结果' : `桌面脚本失败：${diagnostic}`)
      }
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        return failure('桌面脚本返回了无法解析的结果')
      }
      const value = record(parsed)
      if (value === undefined) return failure('桌面脚本返回了非对象结果')
      if (value.ok !== true) return failure(text(value.message, LIMITS.message) || '桌面操作被系统拒绝')
      return { ok: true, value }
    } catch (error) {
      return failure(describe(error))
    } finally {
      watch.cancel()
    }
  }

  /** Reject one capability that is switched off, and report it. */
  function refuse(kind, reason) {
    const notice = { kind: 'desktop', title: '桌面操作被拒绝', message: `${kind}: ${reason}` }
    try {
      onNotice?.(notice)
    } catch {
      // A notice sink must never break the refusal path.
    }
    return failure(reason)
  }

  /**
   * Current state, including a live screen size when reading is allowed.
   * @returns `{ enabled, capabilities, screenSize }`.
   */
  async function state() {
    const settings = settingsOf()
    const view = capabilities()
    const enabled = settings.enabled === true
    if (!view.capabilities.screenSize) return { enabled, capabilities: view.capabilities, screenSize: null, reason: view.reason }
    const result = await runScript(['-Op', 'screen'])
    if (result.ok !== true) {
      return { enabled, capabilities: view.capabilities, screenSize: null, reason: result.message }
    }
    return {
      enabled,
      capabilities: view.capabilities,
      screenSize: {
        width: intIn(result.value.width, 0, 0, 100000),
        height: intIn(result.value.height, 0, 0, 100000),
      },
      reason: view.reason,
    }
  }

  /**
   * Capture the primary screen to a PNG under the plugin directory.
   * @returns `{ path, width, height }` or a structured failure.
   */
  async function capture() {
    const view = capabilities()
    if (!view.capabilities.capture) return refuse('capture', view.reason || '读屏能力已关闭')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${safeSegment(stamp, 'capture')}.png`
    try {
      await mkdir(capturesDir(), { recursive: true })
    } catch (error) {
      return failure(`无法创建截图目录：${describe(error)}`)
    }
    // `name` is derived from a timestamp and sanitised, so it cannot escape.
    const path = join(capturesDir(), name)
    const result = await runScript(['-Op', 'capture', '-Path', path])
    if (result.ok !== true) return result
    return {
      path,
      width: intIn(result.value.width, 0, 0, 100000),
      height: intIn(result.value.height, 0, 0, 100000),
    }
  }

  /**
   * Execute one structured instruction.
   *
   * The whole validation surface of this module is here: kind whitelist,
   * capability gate, `confirmEach` gate, then per-parameter bounds.
   * @param instruction - `{ kind, ... }` from the request body.
   * @returns `{ ok, detail }` or a structured failure.
   */
  async function action(instruction) {
    const input = record(instruction)
    if (input === undefined) return failure('需要一个结构化的桌面指令对象')
    const kind = text(input.kind, 32).toLowerCase()
    if (!KINDS.includes(kind)) {
      return failure(`不支持的指令类型：${kind === '' ? '(空)' : kind}`)
    }
    const view = capabilities()
    if (view.available === false) return refuse(kind, view.reason)

    if (kind === 'capture') {
      const shot = await capture()
      return shot.ok === false ? shot : { ok: true, detail: { path: shot.path, width: shot.width, height: shot.height } }
    }

    if (kind === 'windows') {
      if (!view.capabilities.windows) return refuse(kind, '读屏能力已关闭')
      const result = await runScript(['-Op', 'windows'])
      if (result.ok !== true) return result
      const rows = Array.isArray(result.value.windows) ? result.value.windows : []
      return {
        ok: true,
        detail: {
          foregroundHandle: intIn(result.value.foregroundHandle, 0, 0, Number.MAX_SAFE_INTEGER),
          windows: rows.slice(0, 200).map((row) => ({
            pid: intIn(record(row)?.pid, 0, 0, 2 ** 31),
            title: text(record(row)?.title, 200),
            process: text(record(row)?.process, 64),
          })),
        },
      }
    }

    // Everything past this line changes machine state.
    if (MUTATING.has(kind) && view.capabilities.confirmEach && input.confirm !== true) {
      return refuse(kind, '已开启“每次操作需确认”，请携带 confirm: true 再次发送')
    }

    if (kind === 'move') {
      if (!view.capabilities.mouse) return refuse(kind, '鼠标能力已关闭')
      const x = intIn(input.x, Number.NaN, -100000, 100000)
      const y = intIn(input.y, Number.NaN, -100000, 100000)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return failure('坐标必须是数字')
      const result = await runScript(['-Op', 'move', '-X', String(x), '-Y', String(y)])
      return result.ok !== true ? result : { ok: true, detail: { x, y } }
    }

    if (kind === 'click') {
      if (!view.capabilities.mouse) return refuse(kind, '鼠标能力已关闭')
      const x = intIn(input.x, Number.NaN, -100000, 100000)
      const y = intIn(input.y, Number.NaN, -100000, 100000)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return failure('坐标必须是数字')
      const button = text(input.button, 16).toLowerCase() || 'left'
      const flags = BUTTONS[button]
      if (flags === undefined) return failure(`不支持的鼠标键：${button}`)
      const count = intIn(input.count, 1, 1, 3)
      for (let index = 0; index < count; index++) {
        const result = await runScript([
          '-Op',
          'click',
          '-X',
          String(x),
          '-Y',
          String(y),
          '-ButtonDown',
          String(flags.down),
          '-ButtonUp',
          String(flags.up),
        ])
        if (result.ok !== true) return result
      }
      return { ok: true, detail: { x, y, button, count } }
    }

    if (kind === 'scroll') {
      if (!view.capabilities.mouse) return refuse(kind, '鼠标能力已关闭')
      // One notch is 120 units; the sign decides the direction.
      const notches = intIn(input.notches, 0, -20, 20)
      const delta = intIn(input.delta, notches * 120, -2400, 2400)
      if (delta === 0) return failure('滚动量不能为 0')
      const result = await runScript(['-Op', 'scroll', '-Delta', String(delta)])
      return result.ok !== true ? result : { ok: true, detail: { delta } }
    }

    if (kind === 'type') {
      if (!view.capabilities.keyboard) return refuse(kind, '键盘能力已关闭')
      const body = typeof input.text === 'string' ? input.text : ''
      if (body === '') return failure('要输入的文字为空')
      if (body.length > LIMITS.text) return failure(`单次输入不能超过 ${String(LIMITS.text)} 个字符`)
      // Base64 so the text never appears on a command line, where a quote or a
      // `$` would otherwise invite the shell to reinterpret it.
      const encoded = Buffer.from(body, 'utf8').toString('base64')
      const result = await runScript(['-Op', 'type', '-TextB64', encoded])
      return result.ok !== true ? result : { ok: true, detail: { chars: intIn(result.value.chars, body.length, 0, LIMITS.text * 2) } }
    }

    if (kind === 'key') {
      if (!view.capabilities.keyboard) return refuse(kind, '键盘能力已关闭')
      const combo = text(input.key, 64).toLowerCase()
      if (combo === '') return failure('缺少键名')
      const parts = combo.split('+').map((entry) => entry.trim()).filter((entry) => entry !== '')
      if (parts.length === 0 || parts.length > 4) return failure('快捷键组合不合法')
      const codes = []
      for (const part of parts.slice(0, -1)) {
        const modifier = MODIFIERS[part]
        if (modifier === undefined) return failure(`不支持的修饰键：${part}`)
        codes.push(modifier)
      }
      const base = parts[parts.length - 1]
      const virtualKey = VIRTUAL_KEYS[base]
      if (virtualKey === undefined) return failure(`不支持的键名：${base}`)
      codes.push(virtualKey)
      const result = await runScript(['-Op', 'key', '-KeyCodes', codes.join(',')])
      return result.ok !== true ? result : { ok: true, detail: { key: combo } }
    }

    if (kind === 'focus') {
      if (!view.capabilities.focus) return refuse(kind, '鼠标能力已关闭')
      const pid = intIn(input.pid, Number.NaN, 1, 2 ** 31)
      if (!Number.isFinite(pid)) return failure('缺少进程号 pid')
      const result = await runScript(['-Op', 'focus', '-Pid2', String(pid)])
      return result.ok !== true ? result : { ok: true, detail: { pid, title: text(result.value.title, 200) } }
    }

    // Unreachable: `KINDS` covers every branch above.
    return failure(`指令类型 ${kind} 没有实现`)
  }

  return { state, capture, action, capabilities }
}

/** Exported for the self-test: the accepted vocabulary of this module. */
export const DESKTOP_CONTRACT = Object.freeze({
  KINDS,
  MUTATING: [...MUTATING],
  VIRTUAL_KEYS: Object.keys(VIRTUAL_KEYS).slice(),
  BUTTONS: Object.keys(BUTTONS),
  MODIFIERS: Object.keys(MODIFIERS),
})
