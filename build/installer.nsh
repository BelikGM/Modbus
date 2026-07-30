; Дополнение к инсталлятору NSIS.
;
; Зачем: данные пользователя (проекты, настройки, журнал, свои типы ПЧ) лежат
; в папке `data` ВНУТРИ каталога установки — так программу можно поставить куда
; угодно и унести целиком. Но штатный деинсталлятор electron-builder выполняет
; RMDir /r $INSTDIR, то есть сносит каталог целиком, а установка новой версии
; СНАЧАЛА ЗАПУСКАЕТ ДЕИНСТАЛЛЯТОР СТАРОЙ — без этого файла каждое обновление
; стирало бы все проекты.
;
; Макрос customRemoveFiles полностью заменяет стандартное удаление файлов
; (см. app-builder-lib/templates/nsis/uninstaller.nsh): перебираем содержимое
; каталога установки и удаляем всё, кроме `data`. Финальный RMDir без /r
; убирает сам каталог, только если он опустел, — то есть когда данных нет.

!macro customRemoveFiles
  SetOutPath $TEMP

  FindFirst $R8 $R9 "$INSTDIR\*.*"
  removeLoop:
    StrCmp $R9 "" removeDone
    StrCmp $R9 "." removeNext
    StrCmp $R9 ".." removeNext
    StrCmp $R9 "data" removeNext          ; данные пользователя — не трогаем
    IfFileExists "$INSTDIR\$R9\*.*" removeDir removeFile
    removeDir:
      RMDir /r "$INSTDIR\$R9"
      Goto removeNext
    removeFile:
      Delete "$INSTDIR\$R9"
    removeNext:
      FindNext $R8 $R9
      Goto removeLoop
  removeDone:
  FindClose $R8

  RMDir "$INSTDIR"
!macroend
