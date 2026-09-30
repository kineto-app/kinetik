# Run on the Windows CI desktop after building the native app.
param([string]$Executable = 'src-tauri/target/release/kinetik.exe')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$app = Start-Process -FilePath (Resolve-Path $Executable) -PassThru
try {
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
    if (-not $ready) { throw 'Kinetik did not render usable onboarding. Inspect windows-launch.txt.' }
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
    Write-Output 'Windows app rendered ChatGPT onboarding.'
} finally {
    if (-not $app.HasExited) { Stop-Process -Id $app.Id }
}
