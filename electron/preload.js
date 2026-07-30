const { contextBridge, ipcRenderer } = require('electron')

// Мост между страницей и главным процессом. Нужен ровно для одного: открывать
// РОДНОЙ диалог выбора файла с нужной начальной папкой.
//
// Обычный <input type="file"> начальную папку задать не позволяет — её выбирает
// Chromium, запоминая последнюю использованную в профиле. Профиль общий у
// запуска из исходников и у установленной программы, поэтому импорт проекта
// открывался в папке разработчика, а не в папке данных.
//
// contextIsolation остаётся включённым: наружу отдаются только две функции,
// доступа к Node у страницы по-прежнему нет.
contextBridge.exposeInMainWorld('modbusDesktop', {
  // { subdir, title, extensions } → { path, name, content } | null (отмена)
  pickFile: opts => ipcRenderer.invoke('dialog:open-file', opts ?? {}),
  // Путь к папке данных — чтобы показывать его в интерфейсе
  dataDir: () => ipcRenderer.invoke('app:data-dir'),
  // Окно идёт без рамки Windows, поэтому свернуть/развернуть/закрыть страница
  // делает сама. Наличие этого объекта заодно и есть признак «мы в программе,
  // а не в браузере» — по нему шапка решает, рисовать ли кнопки окна.
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    // Возвращает функцию отписки — её ждёт useEffect в WindowControls.
    onState: cb => {
      const handler = (_e, state) => cb(state)
      ipcRenderer.on('window:state', handler)
      return () => ipcRenderer.off('window:state', handler)
    },
  },
})
