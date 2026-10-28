<#
.SYNOPSIS
  05 INS clean-VM checks for Windows (validation/README.md). Runs INSIDE a disposable VM snapshot, never on a dev machine.

.DESCRIPTION
  Each -Mode is one scenario of plans/matrix.json. The script installs nothing from the network, writes
  <profile>-<mode>.result.json next to itself, and exits 0 when every assertion of the scenario holds.
  Steps that need the doctor (M1: `llull.exe --doctor --json`) report "skip: doctor not built" until it exists.

.EXAMPLE
  .\win-install-check.ps1 -VmProfile vm-win11-std -Mode PerUser -Installer D:\llull-Setup-0.2.0.exe
#>
param(
  [Parameter(Mandatory = $true)][string]$VmProfile,
  [Parameter(Mandatory = $true)]
  [ValidateSet('PerUser', 'Msi', 'NsisAllUsers', 'Closure', 'Signatures', 'CliHeadless', 'MissingDll', 'Offline',
               'ReadOnlyInstall', 'Update', 'Rollback', 'Uninstall', 'UninstallRemoveData', 'Measure')]
  [string]$Mode,
  [string]$Installer,          # NSIS .exe or .msi of version N
  [string]$UpdatePackage,      # offline update package of version N+1 (Update / Rollback)
  [string]$Fixtures = (Join-Path $PSScriptRoot '..\data')
)

$ErrorActionPreference = 'Stop'
$results = [ordered]@{ profile = $VmProfile; mode = $Mode; started = (Get-Date).ToString('o'); checks = @() }

function Add-Check([string]$Case, [string]$Name, [bool]$Ok, [string]$Detail) {
  $script:results.checks += [ordered]@{ case = $Case; name = $Name; ok = $Ok; detail = $Detail }
}

function Get-InstallDir {
  $perUser = Join-Path $env:LOCALAPPDATA 'Programs\llull'
  $perMachine = Join-Path $env:ProgramFiles 'llull'
  if (Test-Path (Join-Path $perUser 'llull.exe')) { return $perUser }
  if (Test-Path (Join-Path $perMachine 'llull.exe')) { return $perMachine }
  return $null
}

function Invoke-Doctor([string]$Case) {
  $dir = Get-InstallDir
  if ($null -eq $dir) { Add-Check $Case 'doctor' $false 'llull.exe not installed'; return $null }
  $out = & (Join-Path $dir 'llull.exe') --doctor --json 2>$null
  $code = $LASTEXITCODE
  if ($null -eq $out) { Add-Check $Case 'doctor' $false "skip: doctor not built (exit $code)"; return $null }
  $report = ($out -join "`n") | ConvertFrom-Json
  Add-Check $Case 'doctor exit 0' ($code -eq 0) "exit $code; must fail $($report.summary.must.fail)"
  Add-Check $Case 'kernel occt 7.9.2' (($report.kernel.status -eq 'occt') -and ($report.kernel.occtVersion -eq '7.9.2')) "$($report.kernel.status) $($report.kernel.occtVersion) $($report.kernel.code)"
  return $report
}

# File system + registry snapshot (VC-INS-16, 29): paths only, never contents.
function Get-Snapshot {
  $roots = @($env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'), $env:APPDATA, $env:LOCALAPPDATA,
             (Join-Path $env:USERPROFILE '.llull'), (Join-Path $env:USERPROFILE '.claude'),
             (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu'))
  $files = foreach ($root in $roots) { if (Test-Path $root) { Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object FullName } }
  $keys = foreach ($hive in @('HKCU:\Software', 'HKLM:\Software', 'HKCU:\Software\Classes', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ChildItem -Path $hive -ErrorAction SilentlyContinue | ForEach-Object Name
  }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  return [ordered]@{ files = @($files); keys = @($keys); userPath = $userPath }
}

function Save-Snapshot([string]$Name) { Get-Snapshot | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $PSScriptRoot "$VmProfile-$Name.snapshot.json") }

# Every PE file in the install must carry a valid, timestamped Authenticode signature (VC-INS-12).
function Test-Signatures([string]$Case) {
  $dir = Get-InstallDir
  $pe = Get-ChildItem -LiteralPath $dir -Recurse -File -Include *.exe, *.dll, *.pyd, *.node
  $bad = @($pe | Where-Object {
      $sig = Get-AuthenticodeSignature -LiteralPath $_.FullName
      ($sig.Status -ne 'Valid') -or ($null -eq $sig.TimeStamperCertificate)
    } | ForEach-Object FullName)
  Add-Check $Case 'unsigned or untimestamped PE = 0' ($bad.Count -eq 0) ("{0} of {1}: {2}" -f $bad.Count, $pe.Count, (($bad | Select-Object -First 5) -join '; '))
}

# Native binaries start with PATH = System32 only, and a planted TKernel.dll on PATH / cwd is ignored (VC-INS-06).
function Test-Closure([string]$Case) {
  $native = Join-Path (Join-Path (Get-InstallDir) 'resources') 'native'
  $system32 = Join-Path $env:SystemRoot 'System32'
  foreach ($exe in Get-ChildItem -LiteralPath $native -Filter *.exe) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $exe.FullName, '--version'
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true
    $psi.EnvironmentVariables['PATH'] = $system32
    $proc = [System.Diagnostics.Process]::Start($psi); $proc.WaitForExit(30000) | Out-Null
    Add-Check $Case "$($exe.Name) starts with System32 PATH" ($proc.ExitCode -eq 0) ("exit 0x{0:X8}" -f $proc.ExitCode)
  }
  $planted = Join-Path $env:TEMP 'llull-planted'
  New-Item -ItemType Directory -Force $planted | Out-Null
  Copy-Item (Join-Path $Fixtures 'fake-TKernel.dll') (Join-Path $planted 'TKernel.dll') -ErrorAction SilentlyContinue
  $env:PATH = "$planted;$env:PATH"
  Push-Location $planted
  try { $report = Invoke-Doctor $Case } finally { Pop-Location }
  if ($null -ne $report) {
    $kernel = $report.checks | Where-Object { $_.id -eq 'kernel' }
    Add-Check $Case 'bundled TKernel.dll loaded' (($kernel.status -eq 'pass') -and ($kernel.detail -notmatch [regex]::Escape($planted))) $kernel.detail
  }
}

switch ($Mode) {
  'PerUser' {
    Save-Snapshot 'before'
    $p = Start-Process -FilePath $Installer -ArgumentList '/S', '/currentuser' -Wait -PassThru
    Add-Check 'VC-INS-01' 'per-user install exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Add-Check 'VC-INS-01' 'installed under LOCALAPPDATA' ((Get-InstallDir) -like "$env:LOCALAPPDATA*") (Get-InstallDir)
    Invoke-Doctor 'VC-INS-01' | Out-Null
  }
  'Msi' {
    Save-Snapshot 'before'
    $log = Join-Path $PSScriptRoot "$VmProfile-msi-install.log"
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$Installer`"", '/quiet', '/l*v', "`"$log`"" -Wait -PassThru
    Add-Check 'VC-INS-19' 'msiexec /quiet exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Add-Check 'VC-INS-19' 'installed under ProgramFiles' ((Get-InstallDir) -like "$env:ProgramFiles*") (Get-InstallDir)
    $report = Invoke-Doctor 'VC-INS-19'
    if ($null -ne $report) { Add-Check 'VC-INS-19' 'policy from registry' ($report.policy.source -eq 'registry') $report.policy.source }
  }
  'NsisAllUsers' {
    $p = Start-Process -FilePath $Installer -ArgumentList '/S', '/allusers' -Wait -PassThru
    Add-Check 'VC-INS-19' 'NSIS /S /allusers exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Add-Check 'VC-INS-19' 'installed under ProgramFiles' ((Get-InstallDir) -like "$env:ProgramFiles*") (Get-InstallDir)
  }
  'Closure' { Test-Closure 'VC-INS-06' }
  'Signatures' { Test-Signatures 'VC-INS-12' }
  'CliHeadless' {
    $cli = Join-Path $env:USERPROFILE '.llull\bin\llull.cmd'
    $doc = Join-Path $env:TEMP 'ins07.llull'; $step = Join-Path $env:TEMP 'ins07.step'
    & $cli new --doc $doc | Out-Null
    & $cli add_box 'size=[10,10,10]' --doc $doc | Out-Null
    $info = (& $cli kernel_info --doc $doc --json) -join "`n" | ConvertFrom-Json
    Add-Check 'VC-INS-07' 'headless kernel occt' ($info.data.active -eq 'occt') "$($info.data.active) $($info.data.fallbackReason)"
    & $cli export_step --doc $doc --save $step | Out-Null
    Add-Check 'VC-INS-07' 'STEP written' ((Test-Path $step) -and ((Get-Item $step).Length -gt 0)) $step
  }
  'MissingDll' {
    Remove-Item (Join-Path (Get-InstallDir) 'resources\native\TKBO.dll') -Force
    $report = Invoke-Doctor 'VC-INS-09'
    if ($null -ne $report) {
      $kernel = $report.checks | Where-Object { $_.id -eq 'kernel' }
      Add-Check 'VC-INS-09' 'INS_NATIVE_DLL_MISSING names TKBO.dll' (($kernel.code -eq 'INS_NATIVE_DLL_MISSING') -and ($kernel.detail -match 'TKBO\.dll')) "$($kernel.code) $($kernel.detail)"
      Add-Check 'VC-INS-09' 'kernel unavailable, no Manifold' ($report.kernel.status -eq 'unavailable') $report.kernel.status
    }
  }
  'Offline' {
    # Firewall logging must be enabled in the image; count outbound attempts by llull processes during the session (VC-INS-23).
    $since = Get-Date
    Invoke-Doctor 'VC-INS-23' | Out-Null
    $events = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5156, 5157; StartTime = $since } -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -match 'llull' -and $_.Message -notmatch '127\.0\.0\.1' }
    Add-Check 'VC-INS-23' 'outbound attempts = 0' (@($events).Count -eq 0) "$(@($events).Count) events"
  }
  'ReadOnlyInstall' {
    $dir = Get-InstallDir
    $before = Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)" }
    Invoke-Doctor 'VC-INS-29' | Out-Null
    $after = Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)" }
    $diff = @(Compare-Object $before $after)
    Add-Check 'VC-INS-29' 'writes under install folder = 0' ($diff.Count -eq 0) "$($diff.Count) changed"
  }
  'Update' {
    $docs = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'Documents') -Filter *.llull -ErrorAction SilentlyContinue
    $hashBefore = $docs | ForEach-Object { (Get-FileHash $_.FullName).Hash }
    $cli = Join-Path $env:USERPROFILE '.llullbinlull.cmd'
    & $cli update --from $UpdatePackage
    Add-Check 'VC-INS-14' 'offline update exit 0' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
    $hashAfter = $docs | ForEach-Object { (Get-FileHash $_.FullName).Hash }
    Add-Check 'VC-INS-14' 'documents unchanged' ((@(Compare-Object $hashBefore $hashAfter)).Count -eq 0) ''
    Invoke-Doctor 'VC-INS-14' | Out-Null
  }
  'Rollback' {
    $p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
    Add-Check 'VC-INS-15' 'reinstall N exit 0' ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    Add-Check 'VC-INS-15' 'userData backup exists' (Test-Path (Join-Path $env:APPDATA 'llull\backups')) ''
    Invoke-Doctor 'VC-INS-15' | Out-Null
  }
  { $_ -in 'Uninstall', 'UninstallRemoveData' } {
    $dir = Get-InstallDir
    if ($dir -like "$env:ProgramFiles*" -and (Get-Command Get-Package -ErrorAction SilentlyContinue)) {
      $pkg = Get-Package -Name 'llull*' -ProviderName msi -ErrorAction SilentlyContinue
      if ($null -ne $pkg) { Start-Process msiexec.exe -ArgumentList '/x', $pkg.FastPackageReference, '/quiet' -Wait }
    } else {
      $uninstallArgs = @('/S'); if ($Mode -eq 'UninstallRemoveData') { $uninstallArgs += '/removedata' }
      Start-Process -FilePath (Join-Path $dir 'Uninstall llull.exe') -ArgumentList $uninstallArgs -Wait
    }
    Save-Snapshot 'after'
    $before = Get-Content (Join-Path $PSScriptRoot "$VmProfile-before.snapshot.json") -Raw | ConvertFrom-Json
    $after = Get-Snapshot
    $kept = '\\AppData\\Roaming\\llull\\|\\\.llull\\vault\\|\\AppData\\Local\\llull\\crash'
    if ($Mode -eq 'UninstallRemoveData') { $kept = '^$' }
    $left = @(Compare-Object $before.files $after.files | Where-Object { $_.SideIndicator -eq '=>' -and $_.InputObject -match 'llull' -and $_.InputObject -notmatch $kept })
    $keys = @(Compare-Object $before.keys $after.keys | Where-Object { $_.SideIndicator -eq '=>' -and $_.InputObject -match 'llull' })
    Add-Check 'VC-INS-16' 'leftover files = 0' ($left.Count -eq 0) (($left | Select-Object -First 5 | ForEach-Object InputObject) -join '; ')
    Add-Check 'VC-INS-16' 'leftover registry keys = 0' ($keys.Count -eq 0) (($keys | ForEach-Object InputObject) -join '; ')
    Add-Check 'VC-INS-16' 'PATH entry removed' ($after.userPath -notmatch '\\\.llull\\bin') $after.userPath
  }
  'Measure' {
    $dir = Get-InstallDir
    $bytes = (Get-ChildItem -LiteralPath $dir -Recurse -File | Measure-Object Length -Sum).Sum
    $gb = [math]::Round($bytes / 1GB, 3)
    Add-Check 'VC-INS-20' 'unpacked <= 1.5 GB' ($gb -le 1.5) "$gb GB"
    $watch = [System.Diagnostics.Stopwatch]::StartNew(); Invoke-Doctor 'VC-INS-20' | Out-Null; $watch.Stop()
    Add-Check 'VC-INS-20' 'doctor seconds (recorded)' $true ("{0:N1} s" -f $watch.Elapsed.TotalSeconds)
  }
}

$results.finished = (Get-Date).ToString('o')
$failed = @($results.checks | Where-Object { -not $_.ok -and $_.detail -notlike 'skip:*' })
$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $PSScriptRoot "$VmProfile-$Mode.result.json")
if ($failed.Count -gt 0) { exit 1 } else { exit 0 }
