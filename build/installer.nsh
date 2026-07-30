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

; После установки: заводим папки для данных и драйверов и прячем служебные
; файлы движка. Убрать их в подпапку нельзя — Chromium ищет свои .pak/.dll/.dat
; строго рядом с exe, эти пути не настраиваются. Скрытый атрибут — единственный
; способ оставить в корне только то, что нужно человеку: программу,
; деинсталлятор, data, drivers и README. Файлы при этом обычные: включение
; показа скрытых элементов в Проводнике возвращает их на вид.
!macro customInstall
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\drivers"

  FindFirst $R5 $R6 "$INSTDIR\*.*"
  hideLoop:
    StrCmp $R6 "" hideDone
    StrCmp $R6 "." hideNext
    StrCmp $R6 ".." hideNext
    StrCmp $R6 "data" hideNext
    StrCmp $R6 "drivers" hideNext
    StrCmp $R6 "README.txt" hideNext
    StrCpy $R7 $R6 "" -4              ; последние 4 символа имени
    StrCmp $R7 ".exe" hideNext        ; программу и деинсталлятор не прячем
    SetFileAttributes "$INSTDIR\$R6" HIDDEN
    hideNext:
      FindNext $R5 $R6
      Goto hideLoop
  hideDone:
  FindClose $R5
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP

  FindFirst $R8 $R9 "$INSTDIR\*.*"
  removeLoop:
    StrCmp $R9 "" removeDone
    StrCmp $R9 "." removeNext
    StrCmp $R9 ".." removeNext
    StrCmp $R9 "data" removeNext          ; данные пользователя — не трогаем
    StrCmp $R9 "drivers" removeNext       ; положенные туда установщики драйверов — тоже
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
