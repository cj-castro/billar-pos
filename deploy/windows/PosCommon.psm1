function Import-PosEnv {
    param([Parameter(Mandatory)][string]$Path)
    foreach ($line in [IO.File]::ReadAllLines($Path, (New-Object Text.UTF8Encoding($false)))) {
        if ($line.Trim() -eq '' -or $line.TrimStart().StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { continue }
        # value verbatim after the first '=': no trimming, no unquoting
        [Environment]::SetEnvironmentVariable($line.Substring(0, $i), $line.Substring($i + 1), 'Process')
    }
}

function Write-PosLog {
    param([Parameter(Mandatory)][string]$Message)
    Write-Output ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
}

Export-ModuleMember -Function Import-PosEnv, Write-PosLog
