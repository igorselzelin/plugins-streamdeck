const { spawn } = require('child_process');

// Focuses another app's window, sends a hotkey to it and puts focus back where
// it was — a replacement for the AutoHotkey "activate, Send, reactivate"
// scripts. Spawning PowerShell and compiling the user32 P/Invoke shim takes
// ~1s, so one worker is started lazily and kept alive; each button press is
// then just one JSON line written to its stdin.
//
// Steps (run in order against the target process's main window):
//   { op: 'focus' }                 bring the target window to the foreground
//   { op: 'sleep', ms }             wait
//   { op: 'keys', keys: 'ctrl+shift+m' }   modifiers (ctrl/shift/alt) + one key (letter, enter)
//   { op: 'restore' }               re-focus the window that was active before
// If the target has no visible window (e.g. minimized to tray) nothing runs,
// same as the AHK `if WinExist(...)` guard.

const WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

function Focus-Window([IntPtr]$h) {
    if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
    $fg = [W]::GetForegroundWindow()
    $pid2 = [uint32]0
    $t1 = [W]::GetWindowThreadProcessId($fg, [ref]$pid2)
    $t2 = [W]::GetCurrentThreadId()
    # Attaching to the foreground thread's input queue is what lets a background
    # process call SetForegroundWindow without Windows ignoring the request.
    [void][W]::AttachThreadInput($t2, $t1, $true)
    [void][W]::SetForegroundWindow($h)
    [void][W]::AttachThreadInput($t2, $t1, $false)
}

function Get-Vk([string]$name) {
    switch ($name) {
        'ctrl'  { return 0x11 }
        'shift' { return 0x10 }
        'alt'   { return 0x12 }
        'enter' { return 0x0D }
        default {
            if ($name.Length -eq 1) { return [int][char]$name.ToUpper() }
            throw "unknown key '$name'"
        }
    }
}

function Send-Keys([string]$combo) {
    $vks = @($combo.ToLower().Split('+') | ForEach-Object { Get-Vk $_ })
    foreach ($vk in $vks) { [W]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
    [array]::Reverse($vks)
    foreach ($vk in $vks) { [W]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
}

Write-Output 'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $result = 'ok'
    try {
        $cmd = $line | ConvertFrom-Json
        $target = Get-Process -Name $cmd.proc -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1 -ExpandProperty MainWindowHandle
        if (-not $target) {
            $result = 'skip'
        } else {
            $target = [IntPtr]$target
            $prev = [W]::GetForegroundWindow()
            foreach ($s in $cmd.steps) {
                switch ($s.op) {
                    'focus'   { Focus-Window $target }
                    'sleep'   { Start-Sleep -Milliseconds $s.ms }
                    'keys'    { Send-Keys $s.keys }
                    'restore' { if ($prev -ne $target -and [W]::IsWindow($prev)) { Focus-Window $prev } }
                }
            }
        }
    } catch {
        $result = 'error ' + $_.Exception.Message
    }
    Write-Output ($cmd.id.ToString() + ' ' + $result)
}
`;

class WinKeys {
    constructor(log) {
        this.log = log;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.ready = null;
    }

    start() {
        if (this.ready) return this.ready;
        const encoded = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64');
        const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
        ], { windowsHide: true });
        this.child = child;

        this.ready = new Promise(resolve => { this.onReady = resolve; });
        child.stdout.on('data', d => this.onData(d.toString()));
        child.stderr.on('data', d => this.log.error('winKeys stderr:', d.toString().trim()));
        child.on('exit', () => {
            this.child = null;
            this.ready = null;
            for (const resolve of this.pending.values()) resolve('worker exited');
            this.pending.clear();
        });
        return this.ready;
    }

    onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line === 'ready') { this.onReady(); continue; }
            const sp = line.indexOf(' ');
            const id = parseInt(line.slice(0, sp), 10);
            const resolve = this.pending.get(id);
            if (resolve) { this.pending.delete(id); resolve(line.slice(sp + 1)); }
        }
    }

    // Resolves with 'ok', 'skip' (target has no visible window) or an error string.
    async run(proc, steps) {
        await this.start();
        const id = this.nextId++;
        const done = new Promise(resolve => this.pending.set(id, resolve));
        this.child.stdin.write(JSON.stringify({ id, proc, steps }) + '\n');
        return done;
    }

    stop() {
        if (this.child) this.child.kill();
    }
}

module.exports = { WinKeys };
