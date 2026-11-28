; Create Your World installer hooks (Tauri NSIS).
; The `cyw` command-line tool is installed next to the app. After installing, ask whether to put this folder on
; the *user* PATH (no administrator rights). Silent installs (self-update: /S) answer "no" and keep whatever the
; user chose before. PATH is edited by cyw itself (same code CYW uses for developer tools), not by string
; manipulation in NSIS.

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "要把 cyw 命令列工具加入使用者 PATH 嗎？$\r$\n$\r$\n加入後可以在任何終端機（包括 SSH）執行 cyw。不需要系統管理員權限，解除安裝時會自動移除。" /SD IDNO IDNO cyw_path_skip
    nsExec::ExecToLog '"$INSTDIR\cyw.exe" --pikara-path-self add'
  cyw_path_skip:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$INSTDIR\cyw.exe" --pikara-path-self remove'
!macroend
