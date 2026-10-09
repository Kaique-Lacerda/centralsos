; The stock Tauri NSIS template remains responsible for Client/shortcuts/ARP.
; Only these fixed, protected program paths are managed. No ProgramData/AppData cleanup.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
; Compiler-time only: Tauri patches/signs the Client AFTER beforeBundleCommand.
; Seal hashes from that final PE before NSIS embeds either copy. No install-time Node.
!include "${__FILEDIR__}\..\..\.installer-build\payload\package-build.nsh"
!system '"${SOS_BUILD_NODE}" "${SOS_BUILD_SCRIPT}" seal "${SOS_BUILD_ROOT}"' = 0
!include "${__FILEDIR__}\..\..\.installer-build\payload\package-files.nsh"
!define MUI_CUSTOMFUNCTION_ABORT SOSRollback

Var SOSPath
Var SOSDirectory
Var SOSMutation
Var SOSPinCount
Var SOSHandle
Var SOSDescriptor
Var SOSAcl
Var SOSOwner
Var SOSInfo
Var SOSAce
Var SOSIndex
Var SOSCount
Var SOSMask
Var SOSPtr
Var SOSTrusted
Var SOSMutex
Var SOSPrepared
Var SOSStage
Var SOSAgent
Var SOSResult
Var SOSAncestor

!macro SOS_FUNCTIONS P
Function ${P}SOSFail
  SetErrorLevel 1
  DetailPrint "CENTRAL SOS: INSTALL_PATH_UNSAFE_OR_OPERATION_FAILED"
  MessageBox MB_OK|MB_ICONSTOP "CENTRAL SOS: instalação/desinstalação não concluída. Verifique caminhos, permissões e o estado da transação. Dados persistentes foram preservados."
  Abort
FunctionEnd

Function ${P}SOSSid
  StrCpy $SOSTrusted 0
  System::Call 'advapi32::ConvertSidToStringSidW(p $SOSPtr, *p .r0) i .r1'
  ${If} $1 = 0
    Call ${P}SOSFail
  ${EndIf}
  System::Call '*$0(&w1024 .r1)'
  ${If} $1 == "S-1-5-18"
  ${OrIf} $1 == "S-1-5-32-544"
  ${OrIf} $1 == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    StrCpy $SOSTrusted 1
  ${EndIf}
  System::Call 'kernel32::LocalFree(p r0)'
FunctionEnd

; Validate the actual object, never a followed junction, before extraction/execution.
; Pin directories without FILE_SHARE_DELETE through the complete hook transaction.
; Conservative ACL bound: no reliance on inferred groups or deny ACE memberships.
Function ${P}SOSPin
  System::Call 'kernel32::CreateFileW(w "$SOSPath", i 0x20080, i 3, p 0, i 3, i 0x02200000, p 0) p .r0'
  StrCpy $SOSHandle $0
  ${If} $SOSHandle = -1
    Call ${P}SOSFail
  ${EndIf}
  System::Alloc 52
  Pop $SOSInfo
  System::Call 'kernel32::GetFileInformationByHandle(p $SOSHandle, p $SOSInfo) i .r0'
  ${If} $0 = 0
    Call ${P}SOSFail
  ${EndIf}
  System::Call '*$SOSInfo(i .r0)'
  IntOp $1 $0 & 0x400
  IntOp $2 $0 & 0x10
  ${If} $1 != 0
    Call ${P}SOSFail
  ${EndIf}
  ${If} $SOSDirectory = 1
    ${If} $2 = 0
      Call ${P}SOSFail
    ${EndIf}
  ${Else}
    ${If} $2 != 0
      Call ${P}SOSFail
    ${EndIf}
    IntOp $0 $SOSInfo + 40
    System::Call '*$0(i .r1)'
    ${If} $1 != 1
      Call ${P}SOSFail
    ${EndIf}
  ${EndIf}
  System::Free $SOSInfo
  System::Call 'advapi32::GetSecurityInfo(p $SOSHandle, i 1, i 5, *p .r0, p 0, *p .r1, p 0, *p .r2) i .r3'
  StrCpy $SOSOwner $0
  StrCpy $SOSAcl $1
  StrCpy $SOSDescriptor $2
  ${If} $3 != 0
  ${OrIf} $SOSDescriptor = 0
  ${OrIf} $SOSAcl = 0
    Call ${P}SOSFail
  ${EndIf}
  StrCpy $SOSPtr $SOSOwner
  Call ${P}SOSSid
  ${If} $SOSTrusted != 1
    Call ${P}SOSFail
  ${EndIf}
  System::Call 'advapi32::IsValidAcl(p $SOSAcl) i .r0'
  ${If} $0 = 0
    Call ${P}SOSFail
  ${EndIf}
  System::Alloc 12
  Pop $SOSInfo
  System::Call 'advapi32::GetAclInformation(p $SOSAcl, p $SOSInfo, i 12, i 2) i .r0'
  ${If} $0 = 0
    Call ${P}SOSFail
  ${EndIf}
  System::Call '*$SOSInfo(i .r0)'
  StrCpy $SOSCount $0
  System::Free $SOSInfo
  ${If} $SOSCount > 1024
    Call ${P}SOSFail
  ${EndIf}
  StrCpy $SOSIndex 0
  ${DoWhile} $SOSIndex < $SOSCount
    System::Call 'advapi32::GetAce(p $SOSAcl, i $SOSIndex, *p .r0) i .r1'
    StrCpy $SOSAce $0
    ${If} $1 = 0
      Call ${P}SOSFail
    ${EndIf}
    System::Call '*$SOSAce(&i1 .r0, &i1 .r1, &i2 .r2, i .r3)'
    IntOp $1 $1 & 8
    ${If} $1 = 0
      ${If} $0 > 1
      ${OrIf} $2 < 16
        Call ${P}SOSFail
      ${EndIf}
      ; Denies are never used to waive permissions; inspecting allows is stricter.
      ${If} $0 = 0
        StrCpy $SOSMask $3
        IntOp $SOSPtr $SOSAce + 8
        System::Call 'advapi32::IsValidSid(p $SOSPtr) i .r0'
        ${If} $0 = 0
          Call ${P}SOSFail
        ${EndIf}
        System::Call 'advapi32::GetLengthSid(p $SOSPtr) i .r0'
        IntOp $2 $2 - 8
        ${If} $0 > $2
          Call ${P}SOSFail
        ${EndIf}
        Call ${P}SOSSid
        ${If} $SOSTrusted = 0
          ; Map generic bits before applying the role-specific mutation bound.
          IntOp $0 $SOSMask & 0x10000000
          ${If} $0 != 0
            IntOp $SOSMask $SOSMask | 0x1f01ff
          ${EndIf}
          IntOp $0 $SOSMask & 0x40000000
          ${If} $0 != 0
            IntOp $SOSMask $SOSMask | 0x120116
          ${EndIf}
          IntOp $0 $SOSMask & 0x80000000
          ${If} $0 != 0
            IntOp $SOSMask $SOSMask | 0x120089
          ${EndIf}
          IntOp $0 $SOSMask & 0x20000000
          ${If} $0 != 0
            IntOp $SOSMask $SOSMask | 0x1200a0
          ${EndIf}
          IntOp $SOSMask $SOSMask & 0x0fffffff
          IntOp $0 $SOSMask & 0xffe0fe00
          IntOp $1 $SOSMask & $SOSMutation
          ${If} $0 != 0
          ${OrIf} $1 != 0
            Call ${P}SOSFail
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    IntOp $SOSIndex $SOSIndex + 1
  ${Loop}
  System::Call 'kernel32::LocalFree(p $SOSDescriptor)'
  ${If} $SOSDirectory = 1
    Push $SOSHandle
    IntOp $SOSPinCount $SOSPinCount + 1
  ${Else}
    System::Call 'kernel32::CloseHandle(p $SOSHandle)'
  ${EndIf}
FunctionEnd

Function ${P}SOSReleasePins
  ${DoWhile} $SOSPinCount > 0
    Pop $0
    System::Call 'kernel32::CloseHandle(p r0)'
    IntOp $SOSPinCount $SOSPinCount - 1
  ${Loop}
  ${If} $SOSMutex != 0
    System::Call 'kernel32::CloseHandle(p $SOSMutex)'
    StrCpy $SOSMutex 0
  ${EndIf}
FunctionEnd

; Create ONLY a missing managed directory with an explicit protected DACL.
; Existing objects are validated, never repaired or re-ACL'd.
Function ${P}SOSDirectory
  System::Call 'kernel32::GetFileAttributesW(w "$SOSPath") i .r0'
  ${If} $0 = -1
    System::Call 'kernel32::GetLastError() i .r0'
    ${If} $0 != 2
    ${AndIf} $0 != 3
      Call ${P}SOSFail
    ${EndIf}
    System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)", i 1, *p .r0, p 0) i .r1'
    StrCpy $SOSDescriptor $0
    ${If} $1 = 0
      Call ${P}SOSFail
    ${EndIf}
    System::Call '*(i 12, p $SOSDescriptor, i 0) p .r0'
    System::Call 'kernel32::CreateDirectoryW(w "$SOSPath", p r0) i .r1'
    System::Free $0
    System::Call 'kernel32::LocalFree(p $SOSDescriptor)'
    ${If} $1 = 0
      Call ${P}SOSFail
    ${EndIf}
  ${EndIf}
  StrCpy $SOSDirectory 1
  StrCpy $SOSMutation 0xd0156
  Call ${P}SOSPin
FunctionEnd

Function ${P}SOSBegin
  ${IfNot} ${RunningX64}
    Call ${P}SOSFail
  ${EndIf}
  SetShellVarContext all
  SetRegView 64
  StrCpy $0 $PROGRAMFILES64 2 1
  ${If} $0 != ":\"
    Call ${P}SOSFail
  ${EndIf}
  StrCpy $0 $PROGRAMFILES64 3
  System::Call 'kernel32::GetDriveTypeW(w r0) i .r1'
  ${If} $1 != 3
    Call ${P}SOSFail
  ${EndIf}
  ${If} $INSTDIR != "$PROGRAMFILES64\CENTRAL SOS"
    Call ${P}SOSFail
  ${EndIf}
  ; Refuse any preexisting mutex, including an untrusted squatter. No concurrent installers.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\CENTRALSOS.ClientInstaller") p .r0 ?e'
  Pop $1
  StrCpy $SOSMutex $0
  ${If} $0 = 0
  ${OrIf} $1 = 183
    Call ${P}SOSFail
  ${EndIf}
  StrCpy $SOSPinCount 0
  ; Pin and validate every external ancestor before creating managed child directories.
  StrCpy $SOSPath "$PROGRAMFILES64"
  StrCpy $SOSDirectory 1
  StrCpy $SOSMutation 0xd0150
  Call ${P}SOSPin
  ${GetParent} "$PROGRAMFILES64" $SOSAncestor
  ${DoWhile} $SOSAncestor != ""
    StrCpy $SOSPath $SOSAncestor
    ${GetParent} "$SOSPath" $SOSAncestor
    StrCpy $SOSMutation 0xd0150
    ${If} $SOSAncestor == ""
      StrCpy $SOSMutation 0xc0150
      ; GetParent returns C:, a drive-relative path. Open the absolute volume root C:\.
      StrCpy $SOSPath "$SOSPath\"
    ${EndIf}
    Call ${P}SOSPin
  ${Loop}
  StrCpy $SOSPath "$INSTDIR"
  Call ${P}SOSDirectory
  StrCpy $SOSStage "$INSTDIR\.central-sos-installer"
  StrCpy $SOSPath "$SOSStage"
  Call ${P}SOSDirectory
FunctionEnd

; Only a validated administrative Agent is executed, with one fixed allow-listed argument.
Function ${P}SOSRun
  StrCpy $SOSPath "$SOSAgent"
  StrCpy $SOSDirectory 0
  StrCpy $SOSMutation 0xd0116
  Call ${P}SOSPin
  nsExec::ExecToLog /TIMEOUT=600000 '"$SOSAgent" $SOSResult'
  Pop $SOSResult
FunctionEnd
!macroend
!insertmacro SOS_FUNCTIONS ""
!insertmacro SOS_FUNCTIONS "un."

!macro SOS_CHECK_FILE PATH
  IfFileExists "${PATH}" 0 +5
    StrCpy $SOSPath "${PATH}"
    StrCpy $SOSDirectory 0
    StrCpy $SOSMutation 0xd0116
    Call SOSPin
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $SOSPrepared 0
  Call SOSBegin
  ; Never overwrite the only recovery package of an interrupted transaction.
  IfFileExists "$SOSStage\transaction.json" 0 +2
    Call SOSFail
  StrCpy $SOSPath "$SOSStage\incoming"
  Call SOSDirectory
  StrCpy $SOSPath "$SOSStage\incoming\Agent"
  Call SOSDirectory
  !insertmacro SOS_CHECK_FILE "$SOSStage\incoming\central-sos.exe"
  !insertmacro SOS_CHECK_FILE "$SOSStage\incoming\Agent\central-sos-agent.exe"
  !insertmacro SOS_CHECK_FILE "$SOSStage\incoming\Agent\central-sos-session-helper.exe"
  !insertmacro SOS_CHECK_FILE "$SOSStage\incoming\package.json"
  ClearErrors
  SetOutPath "$SOSStage\incoming"
  File /oname=central-sos.exe "${SOS_SOURCE_0}"
  File /oname=package.json "${SOS_SOURCE_MANIFEST}"
  SetOutPath "$SOSStage\incoming\Agent"
  File /oname=central-sos-agent.exe "${SOS_SOURCE_1}"
  File /oname=central-sos-session-helper.exe "${SOS_SOURCE_2}"
  ${If} ${Errors}
    Call SOSFail
  ${EndIf}
  ; No download/install of WebView2: runtime must already be present.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_OK|MB_ICONSTOP "WebView2 Runtime por máquina é necessário. Instale-o pelo canal oficial antes de continuar."
    Call SOSFail
  ${EndIf}
  StrCpy $SOSAgent "$SOSStage\incoming\Agent\central-sos-agent.exe"
  StrCpy $SOSResult "--installer-prepare"
  Call SOSRun
  ${If} $SOSResult != 0
    Call SOSFail
  ${EndIf}
  StrCpy $SOSPrepared 1
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $SOSResult "--installer-commit"
  Call SOSRun
  ${If} $SOSResult != 0
    Call SOSFail
  ${EndIf}
  StrCpy $SOSPrepared 0
  DetailPrint "CENTRAL SOS: pacote validado e serviço em execução; enrollment/Backend não verificados."
  Call SOSReleasePins
!macroend

Function SOSRollback
  ${If} $SOSPrepared = 1
    StrCpy $SOSResult "--installer-rollback"
    Call SOSRun
    ${If} $SOSResult != 0
      DetailPrint "CENTRAL SOS: INSTALL_ROLLBACK_INCOMPLETE; recuperação administrativa necessária."
    ${EndIf}
    StrCpy $SOSPrepared 0
  ${EndIf}
  Call SOSReleasePins
FunctionEnd
Function .onInstFailed
  Call SOSRollback
FunctionEnd

!macro SOS_UN_DELETE PATH
  IfFileExists "${PATH}" 0 +6
    StrCpy $SOSPath "${PATH}"
    StrCpy $SOSDirectory 0
    StrCpy $SOSMutation 0xd0116
    Call un.SOSPin
    Delete "${PATH}"
  ${If} ${Errors}
    Call un.SOSFail
  ${EndIf}
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $DeleteAppDataCheckboxState 0
  Call un.SOSBegin
  IfFileExists "$SOSStage\transaction.json" 0 +2
    Call un.SOSFail
  ; The uninstaller carries its own fixed Agent too. Re-extract only into validated
  ; protected directories; never execute a missing/corrupt old Helper or arbitrary path.
  StrCpy $SOSPath "$SOSStage\incoming"
  Call un.SOSDirectory
  StrCpy $SOSPath "$SOSStage\incoming\Agent"
  Call un.SOSDirectory
  StrCpy $SOSAgent "$SOSStage\incoming\Agent\central-sos-agent.exe"
  IfFileExists "$SOSAgent" 0 +5
    StrCpy $SOSPath "$SOSAgent"
    StrCpy $SOSDirectory 0
    StrCpy $SOSMutation 0xd0116
    Call un.SOSPin
  ClearErrors
  SetOutPath "$SOSStage\incoming\Agent"
  File /oname=central-sos-agent.exe "${SOS_SOURCE_1}"
  ${If} ${Errors}
    Call un.SOSFail
  ${EndIf}
  StrCpy $SOSResult "--installer-uninstall"
  Call un.SOSRun
  ${If} $SOSResult != 0
    Call un.SOSFail
  ${EndIf}
  ClearErrors
  !insertmacro SOS_UN_DELETE "$INSTDIR\Agent\central-sos-session-helper.exe"
  !insertmacro SOS_UN_DELETE "$INSTDIR\Agent\central-sos-agent.exe"
  SetOutPath "$INSTDIR"
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  ; The stock template must really have removed the Client; never hide a locked file.
  IfFileExists "$INSTDIR\central-sos.exe" 0 +2
    Call un.SOSFail
  ClearErrors
  !insertmacro SOS_UN_DELETE "$INSTDIR\client-package.json"
  !insertmacro SOS_UN_DELETE "$SOSStage\incoming\Agent\central-sos-session-helper.exe"
  !insertmacro SOS_UN_DELETE "$SOSStage\incoming\Agent\central-sos-agent.exe"
  !insertmacro SOS_UN_DELETE "$SOSStage\incoming\central-sos.exe"
  !insertmacro SOS_UN_DELETE "$SOSStage\incoming\package.json"
  !insertmacro SOS_UN_DELETE "$SOSStage\operation.lock"
  !insertmacro SOS_UN_DELETE "$SOSStage\uninstall-receipt.json"
  ; Release pinned directories before removing only empty, known directories.
  Call un.SOSReleasePins
  RMDir "$INSTDIR\Agent"
  RMDir "$SOSStage\incoming\Agent"
  RMDir "$SOSStage\incoming"
  RMDir "$SOSStage"
  RMDir "$INSTDIR"
  DetailPrint "CENTRAL SOS: serviço removido. Dados retidos; revogação remota não solicitada."
!macroend
