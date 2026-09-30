# Run on the Windows CI desktop after building the native app.
param([string]$Executable = 'src-tauri/target/release/kinetik.exe')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$debugPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$previousDebugArgs = Get-ItemPropertyValue -Path $debugPolicy -Name 'kinetik.exe' -ErrorAction SilentlyContinue
# Hosted CI runs elevated. WebView2 ignores environment overrides there, but honors HKLM policy.
New-Item -Path $debugPolicy -Force | Out-Null
New-ItemProperty -Path $debugPolicy -Name 'kinetik.exe' -Value '--remote-debugging-port=9222' -PropertyType String -Force | Out-Null
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Resolve-Path $Executable).Path
$start.UseShellExecute = $false
$start.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--remote-debugging-port=9222'
try {
    $app = [System.Diagnostics.Process]::Start($start)
    $ready = $false
    $names = @()
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $app.Refresh()
        if ($app.HasExited) { throw "Kinetik exited during startup: $($app.ExitCode)" }
        if ($app.MainWindowHandle -eq 0) { continue }
        $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
        $elements = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        $names = @($elements | Where-Object { -not $_.Current.IsOffscreen } | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
        if ($names -contains 'Continue with ChatGPT') { $ready = $true; break }
    }
    $names | Set-Content windows-launch.txt
    $bounds = $window.Current.BoundingRectangle
    $bitmap = [System.Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path (Get-Location) 'windows-launch.png'))
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    if (-not $ready) { throw 'Kinetik did not render usable onboarding. Inspect windows-launch.txt.' }
    Write-Output 'Windows app rendered ChatGPT onboarding.'
} finally {
    try {
        Get-CimInstance Win32_Process |
            Where-Object { $_.ParentProcessId -eq $app.Id } |
            Select-Object Name, CommandLine |
            ConvertTo-Json | Set-Content windows-processes.json
        if (-not $ready) { node scripts/inspect-windows-webview.mjs }
    } finally {
        if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id }
        if ($null -eq $previousDebugArgs) {
            Remove-ItemProperty -Path $debugPolicy -Name 'kinetik.exe' -ErrorAction SilentlyContinue
        } else {
            Set-ItemProperty -Path $debugPolicy -Name 'kinetik.exe' -Value $previousDebugArgs
        }
    }
}
