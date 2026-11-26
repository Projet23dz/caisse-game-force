; CashPro Server — étapes ajoutées à l'installateur NSIS (electron-builder)
!include "WinVer.nsh"

; Le serveur (PostgreSQL 16, Node.js 22) exige Windows 10 / Server 2016 ou plus récent
!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Le serveur CashPro nécessite Windows 10 ou plus récent (PostgreSQL 16 et Node.js 22 ne fonctionnent pas sous Windows 7/8).$\r$\nSur ce poste, installez plutôt CashPro-Setup-Win7 (application client) et connectez-la à un serveur Windows 10/11.$\r$\n$\r$\nسيرفر CashPro يتطلّب Windows 10 أو أحدث.$\r$\nعلى هذا الجهاز ثبّت CashPro-Setup-Win7 (البرنامج فقط) واربطه بسيرفر Windows 10/11." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "CashPro : installation de PostgreSQL, de la base et du service (1 à 3 minutes)…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\server\setup\setup-server.ps1" -Root "$INSTDIR\resources\server"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "La configuration du serveur CashPro a échoué (code $0).$\r$\nJournal : C:\CashPro\logs$\r$\n$\r$\nفشل إعداد السيرفر — راجع السجل في C:\CashPro\logs" /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "CashPro est installé et démarré.$\r$\nPremière connexion : admin / CashPro@2026$\r$\nAdresses des autres postes : C:\CashPro\LISEZ-MOI.txt$\r$\n$\r$\nتمّ تثبيت CashPro وتشغيله.$\r$\nالدخول الأول: admin / CashPro@2026" /SD IDOK
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "CashPro : arrêt des services (les données de C:\CashPro sont conservées)…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\server\setup\uninstall-server.ps1" -Root "$INSTDIR\resources\server"'
  Pop $0
!macroend
