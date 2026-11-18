# Sourced by reset.sh and restart-server.sh.
# stop_matching PATTERN [SIGNAL]: stops every process whose command line
# matches PATTERN (an extended regex), with SIGNAL (default TERM). Uses pgrep
# where there is one (Linux, macOS); on Windows (Git Bash) asks PowerShell,
# since bash can't see those processes (there every stop is forced).
stop_matching() {
  if command -v pgrep >/dev/null 2>&1; then
    for pid in $(pgrep -f "$1"); do kill "-${2:-TERM}" "$pid" 2>/dev/null; done
  else
    STOP_PATTERN="$1" powershell.exe -NoProfile -Command '
      Get-CimInstance Win32_Process |
        Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne "powershell.exe" -and $_.CommandLine -match $env:STOP_PATTERN } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    ' >/dev/null 2>&1
  fi
}
