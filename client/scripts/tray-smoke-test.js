/** 快速验证 macOS 菜单栏 Tray 是否可见 */
const { app, Tray, nativeImage, dialog, shell } = require('electron');

const MENU_BAR_SETTINGS_URL = 'x-apple.systempreferences:com.apple.MenuBarSettings';

app.whenReady().then(() => {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('\u2191461K \u219324K', { fontType: 'monospacedDigit' });
  tray.setToolTip('Token Bank tray test');

  setTimeout(() => {
    const bounds = tray.getBounds();
    const title = tray.getTitle?.() ?? '';
    console.log('Electron', process.versions.electron);
    console.log('title=', title);
    console.log('bounds=', bounds);
    const hidden = !bounds || bounds.y < 0 || bounds.width <= 0;
    console.log('likelyHidden=', hidden);

    if (hidden) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Tray 测试：可能被系统隐藏',
        message: '请到 系统设置 → 菜单栏 → 允许在菜单栏中显示 → 开启 Electron',
        detail: `bounds=${JSON.stringify(bounds)}\n\n若仍看不到，这是 macOS 26 Tahoe 系统限制。`,
        buttons: ['打开菜单栏设置', '退出'],
      }).then(({ response }) => {
        if (response === 0) shell.openExternal(MENU_BAR_SETTINGS_URL);
        app.quit();
      });
    } else {
      console.log('若屏幕右上角能看到 ↑461K ↓24K，说明 Tray 正常');
      setTimeout(() => app.quit(), 5000);
    }
  }, 2000);
});
