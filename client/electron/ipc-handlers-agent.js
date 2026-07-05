// client/electron/ipc-handlers-agent.js
// Agent 聚合系统的 IPC 处理器
'use strict';

const { ipcMain } = require('electron');
const agentExecutor = require('./agent-executor');

/**
 * 注册 Agent 相关的 IPC handlers
 */
function registerAgentHandlers() {
  /**
   * 获取可用的 Agent 列表
   */
  ipcMain.handle('agent:list', async () => {
    try {
      const agents = await agentExecutor.listAvailableAgents();
      return { success: true, agents };
    } catch (error) {
      console.error('[IPC] agent:list error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 执行 Agent 任务
   */
  ipcMain.handle('agent:execute', async (event, { agentId, prompt, options = {} }) => {
    try {
      const result = await agentExecutor.execute(agentId, prompt, options);
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] agent:execute error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 取消 Agent 任务
   */
  ipcMain.handle('agent:cancel', async (event, taskId) => {
    try {
      const result = await agentExecutor.cancel(taskId);
      return result;
    } catch (error) {
      console.error('[IPC] agent:cancel error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取任务状态
   */
  ipcMain.handle('agent:getStatus', async (event, taskId) => {
    try {
      const status = await agentExecutor.getTaskStatus(taskId);
      return { success: true, status };
    } catch (error) {
      console.error('[IPC] agent:getStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 监听实时步骤事件
   */
  agentExecutor.on('task:step', (stepData) => {
    // 广播给所有窗口
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:step', stepData);
    });
  });

  /**
   * 监听任务完成事件
   */
  agentExecutor.on('task:completed', (data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:completed', data);
    });
  });

  /**
   * 监听任务失败事件
   */
  agentExecutor.on('task:failed', (data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:failed', data);
    });
  });

  /**
   * 监听任务取消事件
   */
  agentExecutor.on('task:cancelled', (data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:cancelled', data);
    });
  });

  console.log('[IPC] Agent handlers registered');
}

// 需要 BrowserWindow
const { BrowserWindow } = require('electron');

module.exports = { registerAgentHandlers };
