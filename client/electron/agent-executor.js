// client/electron/agent-executor.js
// Agent 聚合系统：统一的 Agent 执行器
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const localStats = require('./local-stats');

/**
 * Agent 执行器
 * 统一调用已纳管的 Agent（Claude Code, Codex, Cursor 等）
 */
class AgentExecutor extends EventEmitter {
  constructor() {
    super();
    this.runningTasks = new Map(); // taskId → { process, agent_id }
  }

  /**
   * 获取数据库实例
   */
  _getDb() {
    const db = localStats.getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  /**
   * 获取可用的 Agent 列表
   * 从 Gateway 读取已纳管的 Agent
   */
  async listAvailableAgents() {
    // TODO: 从 Gateway 配置读取
    // 目前返回硬编码的列表
    return [
      {
        id: 'claude-code',
        name: 'Claude Code',
        type: 'claude-code',
        executable: 'claude-code',  // CLI 命令
        capabilities: ['code', 'chat', 'edit', 'terminal'],
        version: '1.2.3',
        status: 'active',
      },
      {
        id: 'codex',
        name: 'Codex Desktop',
        type: 'codex',
        executable: 'codex',
        capabilities: ['code', 'chat', 'edit'],
        version: '2.1.0',
        status: 'active',
      },
    ];
  }

  /**
   * 执行 Agent 任务
   * @param {string} agentId - Agent ID
   * @param {string} prompt - 任务提示
   * @param {object} options - 选项
   * @returns {Promise<{taskId: string}>}
   */
  async execute(agentId, prompt, options = {}) {
    const db = this._getDb();
    const { workingDir = process.cwd(), assistantId, mcpProfile } = options;

    // 创建任务记录
    const taskId = `task_${Date.now()}_${nanoid(8)}`;
    
    db.prepare(`
      INSERT INTO agent_tasks (id, agent_id, prompt, context, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(taskId, agentId, prompt, JSON.stringify({ workingDir, assistantId, mcpProfile }), Date.now());

    // 异步执行
    this._executeAsync(taskId, agentId, prompt, options).catch(err => {
      console.error(`[AgentExecutor] Task ${taskId} failed:`, err);
      this._updateTaskStatus(taskId, 'failed', err.message);
    });

    return { taskId };
  }

  /**
   * 异步执行任务
   */
  async _executeAsync(taskId, agentId, prompt, options) {
    const db = this._getDb();
    
    // 更新状态为 running
    db.prepare(`
      UPDATE agent_tasks 
      SET status = 'running', started_at = ?
      WHERE id = ?
    `).run(Date.now(), taskId);

    try {
      // 根据 Agent 类型调用
      let result;
      if (agentId === 'claude-code') {
        result = await this._executeClaudeCode(taskId, prompt, options);
      } else if (agentId === 'codex') {
        result = await this._executeCodex(taskId, prompt, options);
      } else {
        throw new Error(`Unsupported agent: ${agentId}`);
      }

      // 更新任务结果
      db.prepare(`
        UPDATE agent_tasks 
        SET status = 'completed', result = ?, completed_at = ?
        WHERE id = ?
      `).run(JSON.stringify(result), Date.now(), taskId);

      // 发送完成事件
      this.emit('task:completed', { taskId, result });

      // 记录成本
      await this._recordCost(taskId, agentId, result);
    } catch (error) {
      this._updateTaskStatus(taskId, 'failed', error.message);
      this.emit('task:failed', { taskId, error: error.message });
      throw error;
    }
  }

  /**
   * 执行 Claude Code
   */
  async _executeClaudeCode(taskId, prompt, options) {
    const { workingDir = process.cwd() } = options;

    return new Promise((resolve, reject) => {
      // 构建命令参数
      const args = ['--prompt', prompt];
      if (workingDir) {
        args.push('--cwd', workingDir);
      }

      const proc = spawn('claude-code', args, {
        cwd: workingDir,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let stepCounter = 0;

      // 保存进程引用
      this.runningTasks.set(taskId, { process: proc, agent_id: 'claude-code' });

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // 解析并发送实时步骤
        this._parseAndEmitSteps(taskId, chunk, stepCounter++);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.runningTasks.delete(taskId);

        if (code === 0) {
          // 检测修改的文件
          const modifiedFiles = this._parseModifiedFiles(stdout);
          this._recordModifiedFiles(taskId, modifiedFiles);

          resolve({
            success: true,
            output: stdout,
            files: modifiedFiles,
            stepCount: stepCounter,
          });
        } else {
          reject(new Error(`Agent exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        this.runningTasks.delete(taskId);
        reject(new Error(`Failed to start agent: ${error.message}`));
      });
    });
  }

  /**
   * 执行 Codex
   */
  async _executeCodex(taskId, prompt, options) {
    const { workingDir = process.cwd() } = options;

    return new Promise((resolve, reject) => {
      const args = ['--prompt', prompt];
      if (workingDir) {
        args.push('--cwd', workingDir);
      }

      const proc = spawn('codex', args, {
        cwd: workingDir,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let stepCounter = 0;

      this.runningTasks.set(taskId, { process: proc, agent_id: 'codex' });

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        this._parseAndEmitSteps(taskId, chunk, stepCounter++);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.runningTasks.delete(taskId);

        if (code === 0) {
          const modifiedFiles = this._parseModifiedFiles(stdout);
          this._recordModifiedFiles(taskId, modifiedFiles);

          resolve({
            success: true,
            output: stdout,
            files: modifiedFiles,
            stepCount: stepCounter,
          });
        } else {
          reject(new Error(`Agent exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        this.runningTasks.delete(taskId);
        reject(new Error(`Failed to start agent: ${error.message}`));
      });
    });
  }

  /**
   * 解析并发送实时步骤
   */
  _parseAndEmitSteps(taskId, chunk, stepNumber) {
    const db = this._getDb();
    const lines = chunk.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // 检测步骤类型
      const stepType = this._detectStepType(line);
      
      // 记录步骤到数据库
      const stepId = `step_${Date.now()}_${nanoid(8)}`;
      db.prepare(`
        INSERT INTO agent_task_steps 
        (id, task_id, step_number, step_type, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?)
      `).run(stepId, taskId, stepNumber, stepType, line, Date.now());

      // 发送实时事件
      this.emit('task:step', {
        taskId,
        stepNumber,
        stepType,
        content: line,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 检测步骤类型
   */
  _detectStepType(line) {
    if (/thinking|analyzing/i.test(line)) return 'thinking';
    if (/tool:|calling/i.test(line)) return 'tool_call';
    if (/edit:|modif/i.test(line)) return 'code_edit';
    if (/run:|execut/i.test(line)) return 'terminal';
    return 'output';
  }

  /**
   * 解析修改的文件
   */
  _parseModifiedFiles(output) {
    // 简化实现：查找常见的文件修改模式
    const files = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      // 匹配: Created/Modified/Edited: path/to/file
      const match = line.match(/(Created|Modified|Edited):\s+(.+)/i);
      if (match) {
        files.push({
          path: match[2].trim(),
          operation: match[1].toLowerCase(),
        });
      }
    }

    return files;
  }

  /**
   * 记录修改的文件
   */
  _recordModifiedFiles(taskId, files) {
    const db = this._getDb();
    
    for (const file of files) {
      const fileId = `file_${Date.now()}_${nanoid(8)}`;
      db.prepare(`
        INSERT INTO agent_modified_files (id, task_id, file_path, operation, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fileId, taskId, file.path, file.operation, Date.now());
    }
  }

  /**
   * 取消任务
   */
  async cancel(taskId) {
    const task = this.runningTasks.get(taskId);
    if (task) {
      task.process.kill('SIGTERM');
      this.runningTasks.delete(taskId);

      const db = this._getDb();
      db.prepare(`
        UPDATE agent_tasks 
        SET status = 'cancelled', completed_at = ?
        WHERE id = ?
      `).run(Date.now(), taskId);

      this.emit('task:cancelled', { taskId });
      return { success: true };
    }

    return { success: false, error: 'Task not found or not running' };
  }

  /**
   * 获取任务状态
   */
  async getTaskStatus(taskId) {
    const db = this._getDb();
    const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);
    
    if (!task) {
      throw new Error('Task not found');
    }

    // 获取步骤
    const steps = db.prepare(`
      SELECT * FROM agent_task_steps 
      WHERE task_id = ? 
      ORDER BY step_number
    `).all(taskId);

    // 获取修改的文件
    const files = db.prepare(`
      SELECT * FROM agent_modified_files 
      WHERE task_id = ?
    `).all(taskId);

    return {
      ...task,
      context: task.context ? JSON.parse(task.context) : {},
      result: task.result ? JSON.parse(task.result) : null,
      steps,
      files,
    };
  }

  /**
   * 更新任务状态
   */
  _updateTaskStatus(taskId, status, error = null) {
    const db = this._getDb();
    db.prepare(`
      UPDATE agent_tasks 
      SET status = ?, error = ?, completed_at = ?
      WHERE id = ?
    `).run(status, error, Date.now(), taskId);
  }

  /**
   * 记录成本
   */
  async _recordCost(taskId, agentId, result) {
    // TODO: 从 result 中提取 token 和 cost 信息
    // 目前简化处理
    const db = this._getDb();
    
    if (result.tokens || result.cost) {
      try {
        localStats.record({
          timestamp: Date.now(),
          model: `agent:${agentId}`,
          inputTokens: result.tokens?.input || 0,
          outputTokens: result.tokens?.output || 0,
          cost: result.cost || 0,
          agentId: agentId,
        });
      } catch (error) {
        console.error('[AgentExecutor] Failed to record cost:', error);
      }
    }
  }
}

module.exports = new AgentExecutor();
