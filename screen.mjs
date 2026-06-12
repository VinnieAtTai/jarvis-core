import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';

const PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Native -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Native.Dpi]::SetProcessDPIAware() | Out-Null
$area = if ($env:JARVIS_SCREEN_ALL -eq '1') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
$bmp = New-Object System.Drawing.Bitmap $area.Width, $area.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($area.Left, $area.Top, 0, 0, $bmp.Size)
$bmp.Save($env:JARVIS_SCREEN_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;

export function captureScreen(dataDir, all) {
    const dir = join(dataDir, 'screen');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'screen-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
            env: { ...process.env, JARVIS_SCREEN_PATH: path, JARVIS_SCREEN_ALL: all ? '1' : '0' },
            windowsHide: true,
            timeout: 15000,
        }, (err) => {
            if (err) return reject(new Error('screen capture failed: ' + err.message));
            let size = 0;
            try { size = statSync(path).size; } catch { }
            if (!size) return reject(new Error('screen capture produced no image'));
            for (const f of readdirSync(dir).sort().slice(0, -20)) {
                try { unlinkSync(join(dir, f)); } catch { }
            }
            resolve({ path, size });
        });
    });
}
