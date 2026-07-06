// client/electron/agent-executor.js
// Agent 聚合系统：统一的 Agent 执行器
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
const shim = require('./shim-installer');
const agentLinker = require('./agent-linker');
const { parseAgentOutputLine, summarizeAgentStdout } = require('./agent-output-parser');
const mcpManager = require('./mcp-manager');
const { _internal: { runProbe } } = require('./detect-tools');
const {
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  buildAssistantLaunch,
  ASSISTANT_ID_PREFIX,
} = require('./resource-assistant');

const AGENT_CLI = {
  'claude-code': {
    name: 'Claude Code',
    detectCommand: 'claude',
    buildArgs: (prompt) => [
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'stream-json', '--verbose',
      prompt,
    ],
    capabilities: ['code', 'chat', 'edit', 'terminal'],
  },
  codex: {
    name: 'Codex',
    detectCommand: 'codex',
    // codex 可能仅通过 npx 安装
    npxPackage: '@openai/codex',
    // Debug 直调：JSONL 实时输出 + 默认信任所选工作目录
    buildArgs: (prompt, { workingDir } = {}) => {
      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (workingDir) args.push('--cd', workingDir);
      args.push(prompt);
      return args;
    },
    capabilities: ['code', 'chat', 'edit'],
  },
};

/** Agent 列表探测缓存（避免每次进 Debug 都 spawn CLI） */
const AGENT_LIST_CACHE = { at: 0, agents: null, ttlMs: 45_000 };

function invalidateAgentListCache() {
  AGENT_LIST_CACHE.at = 0;
  AGENT_LIST_CACHE.agents = null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Agent 执行器
 * 统一调用已纳管的 Agent（Claude Code, Codex, Cursor 等）
 */
class AgentExecutor extends EventEmitter {
  constructor() {
    super();
    this.runningTasks = new Map(); // taskId → { process, agent_id }
    // 任务元数据缓存：进程结束后仍可用于 IPC 事件路由
    this.taskMetaCache = new Map(); // taskId → { agentId, sessionKey, parentTaskId }
  }

  /**
   * 获取数据库实例
   */
  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  /**
   * 解析 Agent 启动命令（executable + args 前缀），兼容 npx 安装的 Codex
   */
  _resolveLaunchSpec(agentId) {
    const cfg = AGENT_CLI[agentId];
    if (!cfg) return null;

    const resolved = shim.resolveRealCommand(cfg.detectCommand);
    if (resolved) {
      return { executable: resolved, argPrefix: [] };
    }

    if (cfg.npxPackage) {
      const npx = shim.resolveRealCommand('npx') || 'npx';
      return { executable: npx, argPrefix: ['-y', cfg.npxPackage] };
    }

    return { executable: cfg.detectCommand, argPrefix: [] };
  }

  _resolveExecutable(agentId) {
    return this._resolveLaunchSpec(agentId)?.executable || null;
  }

  /**
   * 将 MCP / 用户传入的 agent_id 规范化为 listAvailableAgents 中的 id
   * 支持 assistant:res-xxx、资源 name（如 python-expert）、显示名
   */
  async resolveAgentId(agentId) {
    const raw = String(agentId || '').trim();
    if (!raw) throw new Error('缺少 agent_id');

    const agents = await this.listAvailableAgents();
    const exact = agents.find(a => a.id === raw);
    if (exact) return exact.id;

    const lower = raw.toLowerCase();
    const assistants = agents.filter(a => a.type === 'assistant');

    for (const a of assistants) {
      if (a.name?.toLowerCase() === lower) return a.id;
      if (a.resourceId === raw || a.resourceId === raw.replace(/^assistant:/, '')) return a.id;
      if (raw.startsWith(ASSISTANT_ID_PREFIX) && a.id.endsWith(raw.slice(ASSISTANT_ID_PREFIX.length))) {
        return a.id;
      }
    }

    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const byName = resourceManager._findByTypeName('assistant', raw);
    if (byName) return `${ASSISTANT_ID_PREFIX}${byName.id}`;

    const cli = agents.find(a => a.id === lower || a.name?.toLowerCase() === lower);
    if (cli) return cli.id;

    throw new Error(`未知 Agent: ${agentId}（请用 tb_list_agents 查看可用 id）`);
  }

  /**
   * 获取可用的 Agent 列表（仅返回本机已安装 CLI）
   * @param {{ force?: boolean }} options - force 跳过缓存
   */
  async listAvailableAgents(options = {}) {
    const now = Date.now();
    if (!options.force && AGENT_LIST_CACHE.agents
      && (now - AGENT_LIST_CACHE.at) < AGENT_LIST_CACHE.ttlMs) {
      return AGENT_LIST_CACHE.agents;
    }

    // 并行探测各 CLI：先 resolve 可执行路径，避免慢速 npx 包下载探测
    const cliAgents = (await Promise.all(
      Object.entries(AGENT_CLI).map(async ([id, cfg]) => {
        const launch = this._resolveLaunchSpec(id);
        if (!launch?.executable) return null;

        // 版本号仅作展示，短超时；探测失败不影响「已安装」判定
        let version = null;
        try {
          const probe = await runProbe(cfg.detectCommand, ['--version'], 1800);
          if (probe.ok) {
            version = probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout;
          }
        } catch {
          // 忽略版本探测失败
        }

        return {
          id,
          name: cfg.name,
          type: 'cli',
          executable: launch.executable,
          capabilities: cfg.capabilities,
          version,
          status: 'active',
        };
      }),
    )).filter(Boolean);

    const cliIds = new Set(cliAgents.map(a => a.id));
    const agents = [...cliAgents, ...this._listCustomAssistants(cliIds)];

    AGENT_LIST_CACHE.at = now;
    AGENT_LIST_CACHE.agents = agents;
    return agents;
  }

  /** 已纳管 Assistant → Debug 自定义 Agent */
  _listCustomAssistants(availableCliIds) {
    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const items = resourceManager.listResources({ type: 'assistant' });
    const list = [];

    for (const resource of items) {
      const config = parseAssistantConfig(resource.content);
      const runtimeAgentId = config.runtime_agent;
      if (!availableCliIds.has(runtimeAgentId)) continue;

      list.push({
        id: `${ASSISTANT_ID_PREFIX}${resource.id}`,
        name: resource.display_name || resource.name,
        type: 'assistant',
        resourceId: resource.id,
        runtimeAgentId,
        runtimeName: AGENT_CLI[runtimeAgentId]?.name || runtimeAgentId,
        description: resource.description || '',
        custom: true,
        capabilities: AGENT_CLI[runtimeAgentId]?.capabilities || ['chat'],
        status: 'active',
      });
    }

    return list;
  }

  _resolveAssistant(agentId) {
    if (!isAssistantAgentId(agentId)) {
      return { agentId, assistant: null };
    }

    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const resource = resourceManager.getResource(assistantResourceId(agentId));
    if (!resource || resource.type !== 'assistant') {
      throw new Error('Assistant 资源不存在');
    }

    const config = parseAssistantConfig(resource.content);
    const runtimeAgentId = config.runtime_agent;
    if (!AGENT_CLI[runtimeAgentId]) {
      throw new Error(`Assistant 运行时 Agent 不可用: ${runtimeAgentId}`);
    }

    const systemText = resolveAssistantContext(config, resourceManager);
    const launch = buildAssistantLaunch(runtimeAgentId, systemText);

    return {
      agentId: runtimeAgentId,
      assistant: { virtualId: agentId, resource, config, launch },
    };
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
    const canonicalId = await this.resolveAgentId(agentId);
    const { workingDir = process.cwd(), assistantId, mcpProfile, mode = 'direct', mainAgentId } = options;

    // 创建任务记录
    const taskId = `task_${Date.now()}_${nanoid(8)}`;
    const sessionKey = options.sessionKey || canonicalId;

    db.prepare(`
      INSERT INTO agent_tasks (id, agent_id, prompt, context, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      taskId,
      canonicalId,
      prompt,
      JSON.stringify({
        workingDir,
        assistantId,
        mcpProfile,
        mode,
        mainAgentId,
        parentTaskId: options.parentTaskId || null,
        sessionKey,
      }),
      Date.now(),
    );

    // 异步执行
    this._executeAsync(taskId, canonicalId, prompt, { ...options, sessionKey }).catch(err => {
      console.error(`[AgentExecutor] Task ${taskId} failed:`, err);
      this._updateTaskStatus(taskId, 'failed', err.message);
    });

    this.taskMetaCache.set(taskId, {
      agentId: canonicalId,
      sessionKey,
      parentTaskId: options.parentTaskId || null,
    });

    return { taskId };
  }

  /**
   * 派发子任务并阻塞等待完成（供 MCP tb_dispatch_agent 使用）
   */
  async dispatchAndWait(agentId, prompt, options = {}) {
    const parentTaskId = options.parentTaskId;
    const canonicalId = await this.resolveAgentId(agentId);
    const { taskId } = await this.execute(canonicalId, prompt, {
      ...options,
      mode: options.mode || 'worker',
      sessionKey: canonicalId,
    });

    // 通知前端：子任务已派发，便于各 Agent 标签页展示对应输出
    this.emit('task:dispatched', {
      parentTaskId,
      childTaskId: taskId,
      agentId: canonicalId,
      prompt,
      timestamp: Date.now(),
    });

    if (parentTaskId) {
      this.emit('task:step', {
        taskId: parentTaskId,
        stepType: 'delegation',
        phase: 'start',
        agentId,
        childTaskId: taskId,
        content: prompt,
        timestamp: Date.now(),
      });
    }

    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    const start = Date.now();

    try {
      while (Date.now() - start < timeoutMs) {
        const status = await this.getTaskStatus(taskId);
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          if (parentTaskId) {
            const summary = status.result?.summary
              || status.result?.output
              || status.error
              || (status.status === 'completed' ? '(完成)' : status.status);
            this.emit('task:step', {
              taskId: parentTaskId,
              stepType: 'delegation',
              phase: 'complete',
              agentId: canonicalId,
              childTaskId: taskId,
              content: summary,
              status: status.status,
              timestamp: Date.now(),
            });
          }
          // 兜底：确保子 Agent 标签页收到完成事件（避免 UI 卡在 executing）
          this._notifyTaskTerminal(taskId, status);
          return status;
        }
        await sleep(400);
      }
      await this.cancel(taskId);
      throw new Error(`子任务超时 (${agentId})`);
    } catch (err) {
      if (parentTaskId) {
        this.emit('task:step', {
          taskId: parentTaskId,
          stepType: 'delegation',
          phase: 'complete',
          agentId,
          childTaskId: taskId,
          content: err.message,
          status: 'failed',
          timestamp: Date.now(),
        });
      }
      throw err;
    }
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

    let orchestratorCleanup = null;

    try {
      const { agentId: effectiveAgentId, assistant } = this._resolveAssistant(agentId);
      const { mode = 'direct', workingDir = process.cwd(), mcpProfile } = options;

      if (assistant && mode === 'orchestrator') {
        throw new Error('自定义 Assistant 请在其标签页直调使用，聚合入口请选 CLI Agent');
      }

      const cfg = AGENT_CLI[effectiveAgentId];
      if (!cfg) throw new Error(`Unsupported agent: ${agentId}`);

      const launch = this._resolveLaunchSpec(effectiveAgentId);
      if (!launch?.executable) {
        throw new Error(`${cfg.name} CLI 未安装（命令: ${cfg.detectCommand}）`);
      }

      let execPrompt = prompt;
      let args;

      if (mode === 'orchestrator') {
        if (!mcpManager.supportsOrchestrator(effectiveAgentId)) {
          throw new Error(`编排模式暂不支持 ${cfg.name}，请选用 Claude Code 或 Codex 作为主 Agent`);
        }
        const orch = mcpManager.buildOrchestratorLaunch({
          agentId: effectiveAgentId,
          taskId,
          workingDir,
          mainAgentId: options.mainAgentId,
          profileId: mcpProfile || mcpManager.DEFAULT_PROFILE_ID,
        });
        orchestratorCleanup = orch.cleanup;
        if (orch.promptPrefix) execPrompt = orch.promptPrefix + prompt;
        args = [...launch.argPrefix, ...orch.extraArgs, execPrompt];
      } else if (assistant) {
        const { launch: asstLaunch } = assistant;
        if (asstLaunch.claudeExtraArgs) {
          args = [...launch.argPrefix, ...asstLaunch.claudeExtraArgs, prompt];
        } else {
          execPrompt = (asstLaunch.promptPrefix || '') + prompt;
          args = [...launch.argPrefix, ...cfg.buildArgs(execPrompt, { workingDir })];
        }
      } else {
        args = [...launch.argPrefix, ...cfg.buildArgs(prompt, { workingDir })];
      }

      const result = await this._runAgentProcess(taskId, effectiveAgentId, launch.executable, args, {
        ...options,
        workingDir,
        onCleanup: orchestratorCleanup,
        virtualAgentId: agentId,
        gatewayAgentId: effectiveAgentId,
        sessionKey: options.sessionKey || null,
      });

      // 更新任务结果（失败也不阻断完成事件，避免 UI 卡在 executing）
      try {
        db.prepare(`
          UPDATE agent_tasks 
          SET status = 'completed', result = ?, completed_at = ?
          WHERE id = ?
        `).run(JSON.stringify(result), Date.now(), taskId);
      } catch (e) {
        console.warn('[AgentExecutor] task complete persist failed:', e.message);
        try {
          db.prepare(`
            UPDATE agent_tasks SET status = 'completed', completed_at = ? WHERE id = ?
          `).run(Date.now(), taskId);
        } catch {}
      }

      this.emit('task:completed', {
        taskId,
        result,
        status: 'completed',
        ...this._taskEventMeta(taskId),
      });
      this.taskMetaCache.delete(taskId);

      // 记录成本
      await this._recordCost(taskId, effectiveAgentId, result);
    } catch (error) {
      this._updateTaskStatus(taskId, 'failed', error.message);
      this.emit('task:failed', { taskId, error: error.message, ...this._taskEventMeta(taskId) });
      this.taskMetaCache.delete(taskId);
      throw error;
    }
  }

  /**
   * 从 DB / 缓存读取任务路由元数据（进程结束后仍可用）
   */
  _taskEventMeta(taskId) {
    const cached = this.taskMetaCache.get(taskId);
    const running = this.runningTasks.get(taskId);
    try {
      const db = localStats.getDb();
      if (db) {
        const row = db.prepare('SELECT agent_id, context FROM agent_tasks WHERE id = ?').get(taskId);
        let parentTaskId = cached?.parentTaskId || running?.parent_task_id || null;
        let sessionKey = cached?.sessionKey || running?.session_key || null;
        try {
          const ctx = row?.context ? JSON.parse(row.context) : {};
          parentTaskId = parentTaskId || ctx.parentTaskId || null;
          sessionKey = sessionKey || ctx.sessionKey || null;
        } catch {}
        return {
          agentId: row?.agent_id || cached?.agentId || running?.agent_id || null,
          parentTaskId,
          sessionKey,
        };
      }
    } catch {}
    return {
      agentId: cached?.agentId || running?.agent_id || null,
      parentTaskId: cached?.parentTaskId || running?.parent_task_id || null,
      sessionKey: cached?.sessionKey || running?.session_key || null,
    };
  }

  /** 向前端广播任务终态（子 Agent 派发完成兜底） */
  _notifyTaskTerminal(taskId, status) {
    const meta = this._taskEventMeta(taskId);
    const payload = {
      taskId,
      agentId: status?.agent_id || meta.agentId,
      sessionKey: meta.sessionKey,
      parentTaskId: meta.parentTaskId,
      result: status?.result || null,
      error: status?.error || null,
    };
    if (status?.status === 'completed') {
      this.emit('task:completed', payload);
    } else if (status?.status === 'failed') {
      this.emit('task:failed', payload);
    } else if (status?.status === 'cancelled') {
      this.emit('task:cancelled', payload);
    }
    this.taskMetaCache.delete(taskId);
  }

  /**
   * 启动 Agent 子进程并收集输出
   */
  async _runAgentProcess(taskId, agentId, executable, args, options) {
    const {
      workingDir = process.cwd(),
      onCleanup,
      virtualAgentId,
      gatewayAgentId = agentId,
      parentTaskId = null,
      sessionKey = null,
    } = options;

    const spawnEnv = agentLinker.buildSpawnEnv(gatewayAgentId, process.env);

    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, {
        cwd: workingDir,
        env: spawnEnv,
        shell: process.platform === 'win32',
        // Unix：独立进程组，停止时可一并杀掉 MCP 子进程
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (process.platform !== 'win32' && proc.pid) {
        try { proc.unref(); } catch {}
      }

      let stdout = '';
      let stderr = '';
      let stepCounter = 0;
      let outLineBuf = '';
      let errLineBuf = '';

      this.runningTasks.set(taskId, {
        process: proc,
        agent_id: virtualAgentId || agentId,
        parent_task_id: parentTaskId,
        gateway_agent_id: gatewayAgentId,
        session_key: sessionKey,
      });
      this.taskMetaCache.set(taskId, {
        agentId: virtualAgentId || agentId,
        sessionKey,
        parentTaskId,
      });

      const cleanup = () => {
        if (typeof onCleanup === 'function') {
          try { onCleanup(); } catch {}
        }
      };

      const flushLines = (buf, chunk, isErr) => {
        const combined = buf + chunk;
        const lines = combined.split('\n');
        const rest = lines.pop() ?? '';
        for (const line of lines) {
          this._parseAndEmitSteps(taskId, line, stepCounter++, gatewayAgentId);
        }
        return rest;
      };

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        outLineBuf = flushLines(outLineBuf, chunk, false);
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        errLineBuf = flushLines(errLineBuf, chunk, true);
      });

      proc.on('close', (code) => {
        if (outLineBuf.trim()) {
          this._parseAndEmitSteps(taskId, outLineBuf, stepCounter++, gatewayAgentId);
        }
        if (errLineBuf.trim()) {
          this._parseAndEmitSteps(taskId, errLineBuf, stepCounter++, gatewayAgentId);
        }
        this.runningTasks.delete(taskId);
        cleanup();

        if (code === 0) {
          const modifiedFiles = this._parseModifiedFiles(stdout);
          this._recordModifiedFiles(taskId, modifiedFiles);

          resolve({
            success: true,
            output: stdout,
            summary: summarizeAgentStdout(stdout, gatewayAgentId),
            stderr,
            files: modifiedFiles,
            stepCount: stepCounter,
          });
        } else {
          reject(new Error(`Agent exited with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on('error', (error) => {
        this.runningTasks.delete(taskId);
        cleanup();
        reject(new Error(`Failed to start agent: ${error.message}`));
      });
    });
  }

  /**
   * 解析并发送实时步骤
   */
  _parseAndEmitSteps(taskId, line, stepNumber, agentIdForParse) {
    const running = this.runningTasks.get(taskId);
    const parseAgent = agentIdForParse || running?.gateway_agent_id || running?.agent_id;
    const steps = parseAgentOutputLine(line, parseAgent);
    let db;
    try { db = this._getDb(); } catch { db = null; }

    for (const step of steps) {
      const stepType = step.stepType || 'output';
      const content = step.content || '';
      // system_event 等结构化步骤允许无长文本 content
      if (!content.trim() && stepType !== 'system_event') continue;

      const stepId = `step_${Date.now()}_${nanoid(8)}`;
      if (db) {
        try {
          db.prepare(`
            INSERT INTO agent_task_steps
            (id, task_id, step_number, step_type, content, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'completed', ?)
          `).run(stepId, taskId, stepNumber, stepType, content, Date.now());
        } catch (e) {
          console.warn('[AgentExecutor] step persist failed:', e.message);
        }
      }

      this.emit('task:step', {
        taskId,
        stepNumber,
        stepType,
        content,
        tool_name: step.tool_name || null,
        system_subtype: step.system_subtype || null,
        attempt: step.attempt,
        max_retries: step.max_retries,
        retry_delay_ms: step.retry_delay_ms,
        error_status: step.error_status,
        timestamp: Date.now(),
        agentId: running?.agent_id || this.taskMetaCache.get(taskId)?.agentId || null,
        parentTaskId: running?.parent_task_id || this.taskMetaCache.get(taskId)?.parentTaskId || null,
        sessionKey: running?.session_key || this.taskMetaCache.get(taskId)?.sessionKey || null,
      });
    }
  }

  /**
   * 检测步骤类型（保留供测试 / 回退）
   */
  _detectStepType(line) {
    if (/thinking|analyzing|reasoning/i.test(line)) return 'thinking';
    if (/tool use|using tool|calling tool|tool:|^\s*⎿/i.test(line)) return 'tool_call';
    if (/edit:|modif|wrote|created|updated file/i.test(line)) return 'code_edit';
    if (/^\$\s|run:|execut|bash:|shell:/i.test(line)) return 'terminal';
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
   * 终止子进程（先 SIGTERM，超时后 SIGKILL）
   */
  _killProcess(proc) {
    if (!proc || proc.killed) return;
    try {
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }

  /**
   * 取消单个任务（进程已退出时也更新 DB 状态）
   */
  async cancel(taskId) {
    const task = this.runningTasks.get(taskId);
    if (task?.process) {
      this._killProcess(task.process);
      this.runningTasks.delete(taskId);
    }

    const db = this._getDb();
    const row = db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(taskId);
    if (row && ['pending', 'running'].includes(row.status)) {
      db.prepare(`
        UPDATE agent_tasks
        SET status = 'cancelled', completed_at = ?
        WHERE id = ?
      `).run(Date.now(), taskId);
      this.emit('task:cancelled', { taskId });
      return { success: true };
    }

    if (task) return { success: true };
    return { success: false, error: 'Task not found or already finished' };
  }

  /** 取消所有进行中的 Agent 任务（Debug 停止按钮） */
  async cancelAllActive() {
    for (const [taskId, task] of this.runningTasks.entries()) {
      if (task?.process) this._killProcess(task.process);
      this.runningTasks.delete(taskId);
    }

    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id FROM agent_tasks WHERE status IN ('pending', 'running')
    `).all();
    const now = Date.now();
    for (const row of rows) {
      db.prepare(`
        UPDATE agent_tasks
        SET status = 'cancelled', completed_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.emit('task:cancelled', { taskId: row.id });
    }
    return { success: true, count: rows.length };
  }

  /**
   * 列出某 Agent 最近任务（切换标签页恢复历史）
   */
  async listRecentTasksForAgent(agentId, limit = 3) {
    const canonicalId = await this.resolveAgentId(agentId);
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(canonicalId, limit);

    const tasks = [];
    for (const row of rows) {
      try {
        tasks.push(await this.getTaskStatus(row.id));
      } catch {
        // 忽略损坏记录
      }
    }
    return tasks;
  }

  /**
   * 列出进行中的任务（切换页面后恢复 UI 用）
   */
  async listActiveTasks() {
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    const tasks = [];
    for (const row of rows) {
      try {
        tasks.push(await this.getTaskStatus(row.id));
      } catch {
        // 忽略已删除或损坏记录
      }
    }
    return tasks;
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

    const steps = db.prepare(`
      SELECT * FROM agent_task_steps
      WHERE task_id = ?
      ORDER BY step_number
    `).all(taskId);

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
module.exports.invalidateAgentListCache = invalidateAgentListCache;
