// client/electron/ipc-handlers-resource.js
// 资源管理 IPC
'use strict';

const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const resourceManager = require('./resource-manager');

function registerResourceHandlers() {
  ipcMain.handle('resource:listCatalog', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, ...resourceManager.listCatalog(filters) };
    } catch (error) {
      console.error('[IPC] resource:listCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listResources', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, resources: resourceManager.listResources(filters) };
    } catch (error) {
      console.error('[IPC] resource:listResources error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:installCatalog', async (_event, { catalogId } = {}) => {
    try {
      resourceManager.init();
      return resourceManager.installFromCatalog(catalogId);
    } catch (error) {
      console.error('[IPC] resource:installCatalog error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:saveResource', async (_event, data = {}) => {
    try {
      resourceManager.init();
      return resourceManager.saveResource(data);
    } catch (error) {
      console.error('[IPC] resource:saveResource error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:deleteResource', async (_event, resourceId) => {
    try {
      resourceManager.init();
      return resourceManager.deleteResource(resourceId);
    } catch (error) {
      console.error('[IPC] resource:deleteResource error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:project', async (_event, { resourceId, agentIds, scope, force } = {}) => {
    try {
      resourceManager.init();
      const result = resourceManager.projectToAgents(resourceId, agentIds, scope || 'global', { force: !!force });
      return result;
    } catch (error) {
      console.error('[IPC] resource:project error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:verifyProjections', async (_event, { resourceId, repair } = {}) => {
    try {
      resourceManager.init();
      return resourceManager.verifyProjections(resourceId, { repair: !!repair });
    } catch (error) {
      console.error('[IPC] resource:verifyProjections error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:unproject', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.unproject(params);
    } catch (error) {
      console.error('[IPC] resource:unproject error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listAgentTargets', async () => {
    try {
      resourceManager.init();
      return {
        success: true,
        agents: resourceManager.listAgentTargets(),
        promptAgents: resourceManager.listPromptAgentTargets(),
      };
    } catch (error) {
      console.error('[IPC] resource:listAgentTargets error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:scanDiscovered', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, ...resourceManager.listDiscoveredSkills(filters) };
    } catch (error) {
      console.error('[IPC] resource:scanDiscovered error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importDiscovered', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importDiscoveredSkill(params);
    } catch (error) {
      console.error('[IPC] resource:importDiscovered error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:listAgentInstallations', async (_event, filters = {}) => {
    try {
      resourceManager.init();
      return { success: true, agents: resourceManager.listAgentInstallations(filters) };
    } catch (error) {
      console.error('[IPC] resource:listAgentInstallations error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importFromAgent', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] resource:importFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:removeFromAgent', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.removeFromAgent(params || {});
    } catch (error) {
      console.error('[IPC] resource:removeFromAgent error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:pickImportPath', async (_event, options = {}) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const properties = [];
      if (options.allowDirectory !== false) properties.push('openDirectory');
      if (options.allowFile !== false) properties.push('openFile');
      const result = await dialog.showOpenDialog(win, {
        title: options.title || '导入资产',
        properties: properties.length ? properties : ['openFile'],
        filters: options.allowFile !== false ? [
          { name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt'] },
        ] : undefined,
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      console.error('[IPC] resource:pickImportPath error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('resource:importFromPath', async (_event, params = {}) => {
    try {
      resourceManager.init();
      return resourceManager.importFromPath(params || {});
    } catch (error) {
      console.error('[IPC] resource:importFromPath error:', error);
      return { success: false, error: error.message };
    }
  });

  /** 在 Finder / 资源管理器中打开 Skill 目录或定位文件 */
  ipcMain.handle('resource:openPath', async (_event, { targetPath } = {}) => {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'missing_path' };
    }
    try {
      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) return { success: false, error: 'not_found' };
      if (fs.statSync(resolved).isFile()) {
        shell.showItemInFolder(resolved);
      } else {
        const errMsg = await shell.openPath(resolved);
        if (errMsg) return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] resource:openPath error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerResourceHandlers };
