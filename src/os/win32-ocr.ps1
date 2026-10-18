# Claude Anywhere - one-shot Windows OCR through Windows.Media.Ocr (WinRT).
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win32-ocr.ps1 -ImagePath C:\path\shot.png [-Language en-US]
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win32-ocr.ps1 -Probe
#
# Prints one ASCII-only JSON line (everything else escaped as \uXXXX, so no console code page can garble it):
#   {"ok":true,"engine":"windows","language":"en-US","width":1920,"height":1080,"angle":null,
#    "lines":[{"text":"For you","words":[{"text":"For","x":10,"y":20,"w":30,"h":14},...]},...]}
#   {"ok":true,"engine":"windows","available":true,"language":"en-US","languages":["en-US"],"maxDimension":10000}   (-Probe)
#   {"ok":false,"code":"UNSUPPORTED"|"NO_LANGUAGE"|"BAD_ARGS"|"TOO_LARGE"|"OCR_FAILED","error":"...","hint":"..."}
# Word boxes are image pixels with the origin at the top-left. src/os/ocr.js (parseWindowsOutput) reads this.
#
# Needs Windows PowerShell 5.1 (powershell.exe): PowerShell 7 has no WinRT projection. src/os/ocr.js starts it
# with this file's path on Windows, and from WSL with a copy staged in the Windows temp folder (wslpath -w).
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
# Dot-sourcing the file (. .\win32-ocr.ps1) only defines its functions (used by the unit tests).

param(
  [string]$ImagePath = '',
  [string]$Language = '',
  [switch]$Probe,
  [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  # Restricted modes block .NET calls (AppLocker/WDAC): answer with plain cmdlets and respect the policy.
  Write-Output ('{"ok":false,"code":"UNSUPPORTED","error":"PowerShell runs in ' + $ExecutionContext.SessionState.LanguageMode +
    ' mode (AppLocker/WDAC policy); OCR needs FullLanguage mode."}')
  exit 3
}

$script:Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$script:LanguageHint = 'Windows has no OCR language installed. Add one in Settings > Time & language > Language & region ' +
  '(a language with the "Optical character recognition" feature), or from an administrator PowerShell: ' +
  'Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0"'

function ConvertTo-OcrJsonString([string]$Text) {
  if ($null -eq $Text) { return 'null' }
  $sb = New-Object System.Text.StringBuilder ($Text.Length + 2)
  [void]$sb.Append('"')
  foreach ($c in $Text.ToCharArray()) {
    $code = [int]$c
    if ($c -eq '"') { [void]$sb.Append('\"') }
    elseif ($c -eq '\') { [void]$sb.Append('\\') }
    elseif ($code -eq 10) { [void]$sb.Append('\n') }
    elseif ($code -eq 13) { [void]$sb.Append('\r') }
    elseif ($code -eq 9) { [void]$sb.Append('\t') }
    elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append('\u').Append($code.ToString('x4', $script:Invariant)) }
    else { [void]$sb.Append($c) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Format-OcrNumber($Value) {
  if ($null -eq $Value) { return 'null' }
  $d = [double]$Value
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }
  return $d.ToString('0.###', $script:Invariant)
}

function Write-OcrJson([string]$Json) {
  [Console]::Out.WriteLine($Json)
  [Console]::Out.Flush()
}

function New-OcrFailure([string]$Code, [string]$Message, [string]$Hint) {
  $json = '{"ok":false,"code":' + (ConvertTo-OcrJsonString $Code) + ',"error":' + (ConvertTo-OcrJsonString $Message)
  if ($Hint) { $json += ',"hint":' + (ConvertTo-OcrJsonString $Hint) }
  return $json + '}'
}

function New-OcrError([string]$Code, [string]$Message, [string]$Hint) {
  $err = New-Object System.Exception $Message
  $err.Data['OcrCode'] = $Code
  if ($Hint) { $err.Data['OcrHint'] = $Hint }
  return $err
}

# One recognized line as JSON: {"text":"...","words":[{"text","x","y","w","h"}]}. Lines and words may be
# WinRT objects (OcrLine/OcrWord with BoundingRect) or plain objects with the same members (tests).
function ConvertTo-OcrLineJson($Line) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"text":').Append((ConvertTo-OcrJsonString ([string]$Line.Text))).Append(',"words":[')
  $first = $true
  foreach ($w in $Line.Words) {
    $r = $w.BoundingRect
    if (-not $first) { [void]$sb.Append(',') }
    $first = $false
    [void]$sb.Append('{"text":').Append((ConvertTo-OcrJsonString ([string]$w.Text)))
    [void]$sb.Append(',"x":').Append((Format-OcrNumber $r.X)).Append(',"y":').Append((Format-OcrNumber $r.Y))
    [void]$sb.Append(',"w":').Append((Format-OcrNumber $r.Width)).Append(',"h":').Append((Format-OcrNumber $r.Height)).Append('}')
  }
  [void]$sb.Append(']}')
  return $sb.ToString()
}

function ConvertTo-OcrResultJson([string]$Language, [int]$Width, [int]$Height, $Angle, $Lines) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"ok":true,"engine":"windows","language":').Append((ConvertTo-OcrJsonString $Language))
  [void]$sb.Append(',"width":').Append($Width.ToString($script:Invariant)).Append(',"height":').Append($Height.ToString($script:Invariant))
  [void]$sb.Append(',"angle":').Append((Format-OcrNumber $Angle)).Append(',"lines":[')
  $first = $true
  foreach ($line in $Lines) {
    if (-not $first) { [void]$sb.Append(',') }
    $first = $false
    [void]$sb.Append((ConvertTo-OcrLineJson $line))
  }
  [void]$sb.Append(']}')
  return $sb.ToString()
}

function Initialize-OcrRuntime {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    throw (New-OcrError 'UNSUPPORTED' ('PowerShell ' + $PSVersionTable.PSVersion + ' cannot load WinRT types; run this script with Windows PowerShell 5.1 (powershell.exe).') '')
  }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw (New-OcrError 'UNSUPPORTED' 'Windows.Media.Ocr exists only on Windows 10 and 11.' '')
  }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    # The same type loads as the widely used Windows 10 OCR snippet (the WinRT binder finds each type by
    # its namespace); BitmapDecoder, OcrResult and the enums then resolve from the loaded metadata.
    $null = [Windows.Foundation.IAsyncOperation`1,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.RandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  } catch {
    throw (New-OcrError 'UNSUPPORTED' ('Windows.Media.Ocr is not available on this Windows (' + $_.Exception.Message + '); it needs Windows 10 or 11.') '')
  }
  # The well-known bridge from WinRT IAsyncOperation<T> to a .NET Task: WindowsRuntimeSystemExtensions.AsTask<T>.
  $script:AsTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if ($null -eq $script:AsTaskGeneric) {
    throw (New-OcrError 'UNSUPPORTED' 'System.Runtime.WindowsRuntime has no AsTask(IAsyncOperation) helper on this system.' '')
  }
}

function Wait-OcrOperation($Operation, [Type]$ResultType, [int]$Timeout) {
  $task = $script:AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait($Timeout)) {
    throw (New-OcrError 'OCR_FAILED' ('Windows OCR did not finish within ' + $Timeout + ' ms.') '')
  }
  return $task.Result
}

function Get-OcrLanguageTags {
  $tags = @()
  foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $tags += [string]$l.LanguageTag }
  return , $tags
}

function New-OcrEngine([string]$Tag) {
  if ($Tag) {
    $lang = New-Object Windows.Globalization.Language $Tag
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
      $have = (Get-OcrLanguageTags) -join ', '
      if (-not $have) { $have = 'none' }
      throw (New-OcrError 'NO_LANGUAGE' ('Windows OCR has no recognizer for ' + $Tag + ' (installed: ' + $have + ').') $script:LanguageHint)
    }
    return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    # None of the user's profile languages has OCR: fall back to any installed recognizer.
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
      if ($null -ne $engine) { break }
    }
  }
  if ($null -eq $engine) { throw (New-OcrError 'NO_LANGUAGE' 'Windows OCR has no recognizer language installed.' $script:LanguageHint) }
  return $engine
}

function Invoke-OcrProbe {
  Initialize-OcrRuntime
  $tags = Get-OcrLanguageTags
  $tagJson = @()
  foreach ($t in $tags) { $tagJson += (ConvertTo-OcrJsonString $t) }
  $engine = $null
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
  $current = $null
  if ($null -ne $engine) { $current = [string]$engine.RecognizerLanguage.LanguageTag }
  elseif ($tags.Count -gt 0) { $current = [string]$tags[0] }
  $json = '{"ok":true,"engine":"windows","available":' + $(if ($null -ne $current) { 'true' } else { 'false' })
  $json += ',"language":' + (ConvertTo-OcrJsonString $current) + ',"languages":[' + ($tagJson -join ',') + ']'
  $json += ',"maxDimension":' + ([int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension).ToString($script:Invariant)
  if ($null -eq $current) { $json += ',"hint":' + (ConvertTo-OcrJsonString $script:LanguageHint) }
  return $json + '}'
}

function Invoke-OcrImage([string]$Path, [string]$Tag, [int]$Timeout) {
  if (-not $Path) { throw (New-OcrError 'BAD_ARGS' 'usage: win32-ocr.ps1 -ImagePath <image file> [-Language <tag>] | -Probe' '') }
  if (-not [System.IO.File]::Exists($Path)) { throw (New-OcrError 'BAD_ARGS' ('The image file does not exist: ' + $Path) '') }
  Initialize-OcrRuntime
  $engine = New-OcrEngine $Tag
  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($file)
    $decoder = Wait-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) $Timeout
    # Bgra8/premultiplied is the layout every OCR recognizer accepts, whatever the PNG's own format.
    $bitmap = Wait-OcrOperation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap]) $Timeout
  } finally {
    $file.Dispose()
  }
  try {
    $max = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($bitmap.PixelWidth -gt $max -or $bitmap.PixelHeight -gt $max) {
      throw (New-OcrError 'TOO_LARGE' ('The image is ' + $bitmap.PixelWidth + 'x' + $bitmap.PixelHeight + ' px; Windows OCR reads at most ' + $max + ' px per side.') '')
    }
    $result = Wait-OcrOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) $Timeout
    return (ConvertTo-OcrResultJson ([string]$engine.RecognizerLanguage.LanguageTag) $bitmap.PixelWidth $bitmap.PixelHeight $result.TextAngle $result.Lines)
  } finally {
    if ($bitmap -is [System.IDisposable]) { $bitmap.Dispose() }
  }
}

function Invoke-OcrMain {
  try {
    if ($Probe) { return (Invoke-OcrProbe) }
    return (Invoke-OcrImage $ImagePath $Language $TimeoutMs)
  } catch {
    $ex = $_.Exception
    while ($null -ne $ex.InnerException -and -not $ex.Data.Contains('OcrCode')) { $ex = $ex.InnerException }
    $code = 'OCR_FAILED'
    $hint = ''
    if ($ex.Data.Contains('OcrCode')) { $code = [string]$ex.Data['OcrCode'] }
    if ($ex.Data.Contains('OcrHint')) { $hint = [string]$ex.Data['OcrHint'] }
    return (New-OcrFailure $code $ex.Message $hint)
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Write-OcrJson (Invoke-OcrMain)
}
