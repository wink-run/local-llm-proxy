// client/electron/agent-executor.js
// Agent 聚合系统：统一的 Agent 执行器
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
const shim = require('./shim-installer');
const agentLinker = require('./agent-linker');
const { parseAgentOutputLine, summarizeAgentStdout, extractModifiedFiles, extractCliSessionId, normalizeCliSessionId, detectAgentExecutionFailure, formatAgentExitError, parseClaudeSyncStdout } = require('./agent-output-parser');
const mcpManager = require('./mcp-manager');
const { _internal: { runProbe } } = require('./detect-tools');
const {
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  resolveAssistantRuntimeAgent,
  buildAssistantLaunch,
  ASSISTANT_ID_PREFIX,
  ASSISTANT_RUNTIME_IDS,
} = require('./resource-assistant');

const AGENT_CLI = {
  'claude-code': {
    name: 'Claude Code',
    detectCommand: 'claude',
    syncOutput: true,
    buildArgs: (prompt, opts = {}) => buildClaudeCodeArgs(prompt, opts),
    capabilities: ['code', 'chat', 'edit', 'terminal'],
  },
  codex: {
    name: 'Codex',
    detectCommand: 'codex',
    // codex 可能仅通过 npx 安装
    npxPackage: '@openai/codex',
    // Debug 直调：JSONL 实时输出 + 默认信任所选工作目录
    buildArgs: (prompt, { workingDir, continueSession, cliSessionId } = {}) => {
      const base = ['exec'];
      // --cd 非 global 标志，必须放在 resume 子命令之前（否则 clap 报 code 2）
      if (workingDir) base.push('--cd', workingDir);
      if (continueSession) {
        base.push('resume');
        const sid = normalizeCliSessionId(cliSessionId);
        if (sid) base.push(sid);
        else base.push('--last');
      }
      base.push('--json', '--skip-git-repo-check');
      base.push(prompt);
      return base;
    },
    capabilities: ['code', 'chat', 'edit'],
  },
};

/** Agent 列表探测缓存（避免每次进 Debug 都 spawn CLI） */
const AGENT_LIST_CACHE = { at: 0, agents: null, ttlMs: 45_000 };

/** Claude Code 续接：须 continueSession；有 sessionId 用 --resume，否则 -c */
function buildClaudeContinueArgs({ continueSession, cliSessionId } = {}) {
  if (!continueSession) return [];
  const sid = normalizeCliSessionId(cliSessionId);
  if (sid) return ['--resume', sid];
  return ['-c'];
}

/** Codex 编排续接：resume 须放在全部 exec 全局参数（含 -p profile）之后，否则 -p 会被 resume 子命令误解析 */
function injectCodexResumeArgs(extraArgs, { continueSession, cliSessionId } = {}) {
  if (!continueSession) return extraArgs;
  const out = [...extraArgs];
  const sid = normalizeCliSessionId(cliSessionId);
  out.push('resume', sid || '--last');
  return out;
}

function buildClaudeCodeArgs(prompt, { continueSession, cliSessionId } = {}) {
  return [
    ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
    '-p', '--dangerously-skip-permissions',
    '--output-format', 'json',
    prompt,
  ];
}

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
    /** stream-json content_block index → type（thinking / text） */
    this._streamState = new Map(); // taskId → { blockTypes: Map }
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
      // 未投射到运行时的智能体不进 Debug（投射=在 Debug 启用；取消投射即从 Debug 移除）
      const hasRuntimeProjection = (resource.projections || [])
        .some(p => ASSISTANT_RUNTIME_IDS.has(p.agentId));
      if (!hasRuntimeProjection) continue;

      const config = parseAssistantConfig(resource.content);
      // 投射到 Codex/Claude Code 时，Debug 运行时跟投射走（避免仍显示默认 claude-code）
      const runtimeAgentId = resolveAssistantRuntimeAgent(
        config,
        resource.projections || [],
        availableCliIds,
      );
      if (!runtimeAgentId || !availableCliIds.has(runtimeAgentId)) continue;

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
      throw new Error('Assistant 资产不存在');
    }

    const config = parseAssistantConfig(resource.content);
    const runtimeAgentId = resolveAssistantRuntimeAgent(config, resource.projections || []);
    if (!runtimeAgentId || !AGENT_CLI[runtimeAgentId]) {
      throw new Error(`Assistant 运行时 Agent 不可用: ${runtimeAgentId || config.runtime_agent}`);
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
        sessionInstanceId: options.sessionInstanceId || null,
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
      sessionInstanceId: options.sessionInstanceId || null,
    });

    return { taskId };
  }

  /**
   * 派发子任务并阻塞等待完成（供 MCP tb_dispatch_agent 使用）
   */
  async dispatchAndWait(agentId, prompt, options = {}) {
    const parentTaskId = options.parentTaskId;
    const canonicalId = await this.resolveAgentId(agentId);

    // 派发子任务：归属父窗口 session，继承父会话实例 ID
    let sessionKey = options.sessionKey || canonicalId;
    let sessionInstanceId = options.sessionInstanceId || null;
    if (parentTaskId) {
      const parentMeta = this._taskEventMeta(parentTaskId);
      const parentKey = options.parentSessionKey || parentMeta.sessionKey || null;
      if (parentKey) sessionKey = parentKey;
      sessionInstanceId = options.parentSessionInstanceId
        || parentMeta.sessionInstanceId
        || sessionInstanceId;
    }

    const { taskId } = await this.execute(canonicalId, prompt, {
      ...options,
      mode: options.mode || 'worker',
      sessionKey,
      sessionInstanceId,
      parentTaskId,
    });

    // 通知前端：子任务已派发，便于当前窗口展示派发卡片
    this.emit('task:dispatched', {
      parentTaskId,
      childTaskId: taskId,
      agentId: canonicalId,
      prompt,
      parentSessionKey: sessionKey,
      parentSessionInstanceId: sessionInstanceId,
      timestamp: Date.now(),
    });

    if (parentTaskId) {
      this.emit('task:step', {
        taskId: parentTaskId,
        stepType: 'delegation',
        phase: 'start',
        agentId: canonicalId,
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
      const { mode = 'direct', workingDir = process.cwd(), mcpProfile, continueSession, cliSessionId } = options;

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
          sessionKey: options.sessionKey || null,
          sessionInstanceId: options.sessionInstanceId || null,
        });
        orchestratorCleanup = orch.cleanup;
        if (orch.promptPrefix) execPrompt = orch.promptPrefix + prompt;
        if (effectiveAgentId === 'claude-code') {
          args = [
            ...launch.argPrefix,
            ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
            ...orch.extraArgs,
            execPrompt,
          ];
        } else if (effectiveAgentId === 'codex') {
          args = [
            ...launch.argPrefix,
            ...injectCodexResumeArgs(orch.extraArgs, { continueSession, cliSessionId }),
            execPrompt,
          ];
        } else {
          args = [...launch.argPrefix, ...orch.extraArgs, execPrompt];
        }
      } else if (assistant) {
        const { launch: asstLaunch } = assistant;
        if (asstLaunch.claudeExtraArgs) {
          args = [
            ...launch.argPrefix,
            ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
            ...asstLaunch.claudeExtraArgs,
            prompt,
          ];
        } else {
          execPrompt = (asstLaunch.promptPrefix || '') + prompt;
          args = [...launch.argPrefix, ...cfg.buildArgs(execPrompt, { workingDir })];
        }
      } else {
        args = [...launch.argPrefix, ...cfg.buildArgs(prompt, { workingDir, continueSession, cliSessionId })];
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
        result: {
          success: result.success,
          summary: result.summary,
          stderr: result.stderr,
          files: result.files,
          stepCount: result.stepCount,
          cliSessionId: result.cliSessionId,
        },
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
        let sessionInstanceId = cached?.sessionInstanceId || running?.session_instance_id || null;
        try {
          const ctx = row?.context ? JSON.parse(row.context) : {};
          parentTaskId = parentTaskId || ctx.parentTaskId || null;
          sessionKey = sessionKey || ctx.sessionKey || null;
          sessionInstanceId = sessionInstanceId || ctx.sessionInstanceId || null;
        } catch {}
        return {
          agentId: row?.agent_id || cached?.agentId || running?.agent_id || null,
          parentTaskId,
          sessionKey,
          sessionInstanceId,
        };
      }
    } catch {}
    return {
      agentId: cached?.agentId || running?.agent_id || null,
      parentTaskId: cached?.parentTaskId || running?.parent_task_id || null,
      sessionKey: cached?.sessionKey || running?.session_key || null,
      sessionInstanceId: cached?.sessionInstanceId || running?.session_instance_id || null,
    };
  }

  /** 向前端广播任务终态（子 Agent 派发完成兜底） */
  _notifyTaskTerminal(taskId, status) {
    const meta = this._taskEventMeta(taskId);
    const payload = {
      taskId,
      agentId: status?.agent_id || meta.agentId,
      sessionKey: meta.sessionKey,
      sessionInstanceId: meta.sessionInstanceId,
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
      sessionInstanceId = null,
    } = options;

    const spawnEnv = agentLinker.buildSpawnEnv(gatewayAgentId, process.env);
    const spawnDiag = agentLinker.diagnoseGatewaySpawn(gatewayAgentId, process.env);
    try {
      require('./api-retry-trace').traceAgentSpawnEnv({
        taskId,
        agentId: gatewayAgentId,
        ...spawnDiag,
      });
    } catch { /* ignore */ }
    if (spawnDiag.will_use_official_api) {
      console.warn('[AgentExecutor] spawn 未注入网关 URL，Claude/Codex 将直连官方 API', spawnDiag.skip_reasons);
    }

    return new Promise((resolve, reject) => {
      const resolvedCwd = path.resolve(String(workingDir || process.cwd()));
      if (!fs.existsSync(resolvedCwd)) {
        reject(new Error(`工作目录不存在: ${resolvedCwd}`));
        return;
      }

      const proc = spawn(executable, args, {
        cwd: resolvedCwd,
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
        session_instance_id: sessionInstanceId,
        spawn_diag: spawnDiag,
      });
      this.taskMetaCache.set(taskId, {
        agentId: virtualAgentId || agentId,
        sessionKey,
        parentTaskId,
        sessionInstanceId,
      });

      const cleanup = () => {
        if (typeof onCleanup === 'function') {
          try { onCleanup(); } catch {}
        }
      };

      const syncOutput = !!(AGENT_CLI[gatewayAgentId]?.syncOutput);

      const flushLines = (buf, chunk) => {
        const combined = buf + chunk;
        const lines = combined.split('\n');
        const rest = lines.pop() ?? '';
        if (!syncOutput) {
          for (const line of lines) {
            if (!line.trim()) continue;
            this._parseAndEmitSteps(taskId, line, stepCounter++, gatewayAgentId);
            const running = this.runningTasks.get(taskId);
            if (running && !running.cli_session_id) {
              const sid = normalizeCliSessionId(extractCliSessionId(`${line}\n`, gatewayAgentId));
              if (sid) running.cli_session_id = sid;
            }
          }
        }
        return rest;
      };

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        outLineBuf = flushLines(outLineBuf, chunk);
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        errLineBuf = flushLines(errLineBuf, chunk);
      });

      proc.on('close', (code, signal) => {
        try {
          if (!syncOutput) {
            if (outLineBuf.trim()) {
              this._parseAndEmitSteps(taskId, outLineBuf, stepCounter++, gatewayAgentId);
            }
            if (errLineBuf.trim()) {
              this._parseAndEmitSteps(taskId, errLineBuf, stepCounter++, gatewayAgentId);
            }
          } else {
            const parsed = parseClaudeSyncStdout(stdout);
            if (parsed.sessionId) {
              const running = this.runningTasks.get(taskId);
              if (running) running.cli_session_id = parsed.sessionId;
            }
            stepCounter = this._emitParsedSteps(taskId, stepCounter, parsed.steps, gatewayAgentId);
          }

          const running = this.runningTasks.get(taskId);
          const cliSid = normalizeCliSessionId(
            running?.cli_session_id || extractCliSessionId(stdout, gatewayAgentId),
          );
          this.runningTasks.delete(taskId);
          this._clearTaskStreamState(taskId);
          cleanup();

          const execFail = detectAgentExecutionFailure(stdout);
          if (code === 0 && !execFail) {
            try {
              const modifiedFiles = this._parseModifiedFiles(stdout);
              this._recordModifiedFiles(taskId, modifiedFiles);
            } catch (e) {
              console.warn('[AgentExecutor] recordModifiedFiles failed:', e.message);
            }

            resolve({
              success: true,
              output: stdout,
              summary: summarizeAgentStdout(stdout, gatewayAgentId),
              stderr,
              files: [],
              stepCount: stepCounter,
              cliSessionId: cliSid,
            });
          } else {
            const errText = execFail || formatAgentExitError(stderr, stdout, code, gatewayAgentId, signal);
            reject(new Error(errText));
          }
        } catch (err) {
          this.runningTasks.delete(taskId);
          this._clearTaskStreamState(taskId);
          cleanup();
          reject(err);
        }
      });

      proc.on('error', (error) => {
        this.runningTasks.delete(taskId);
        this._clearTaskStreamState(taskId);
        cleanup();
        reject(new Error(`Failed to start agent: ${error.message}`));
      });
    });
  }

  /** 清理任务级 stream-json 块状态 */
  _clearTaskStreamState(taskId) {
    this._streamState.delete(taskId);
  }

  /** 将已解析步骤广播到 UI（同步 JSON 模式） */
  _emitParsedSteps(taskId, startNumber, steps, gatewayAgentId) {
    let n = startNumber;
    for (const step of steps || []) {
      this._emitSingleStep(taskId, n++, step, gatewayAgentId);
    }
    return n;
  }

  /**
   * 解析并发送实时步骤
   */
  _parseAndEmitSteps(taskId, line, stepNumber, agentIdForParse) {
    const running = this.runningTasks.get(taskId);
    const parseAgent = agentIdForParse || running?.gateway_agent_id || running?.agent_id;
    if (!this._streamState.has(taskId)) {
      this._streamState.set(taskId, {
        blockTypes: new Map(),
        blockTexts: new Map(),
        streaming: false,
        messageId: null,
        lastThinking: '',
      });
    }
    const steps = parseAgentOutputLine(line, parseAgent, this._streamState.get(taskId));
    return this._emitParsedSteps(taskId, stepNumber, steps, parseAgent);
  }

  _emitSingleStep(taskId, stepNumber, step, gatewayAgentId) {
    try {
      const running = this.runningTasks.get(taskId);
      const stepType = step.stepType || 'output';
      const content = step.content || '';
      if (!content.trim() && stepType !== 'system_event') return;

      if (stepType === 'system_event' && step.system_subtype === 'api_retry') {
        try {
          const localGateway = require('./local-gateway');
          require('./api-retry-trace').traceCliApiRetry({
            taskId,
            agentId: gatewayAgentId,
            rawLine: '',
            step,
            spawn_diag: running?.spawn_diag || null,
            getRouteLog: () => localGateway.getLog(),
          });
        } catch (e) {
          console.warn('[AgentExecutor] api_retry trace failed:', e.message);
        }
      }

      let db;
      try { db = this._getDb(); } catch { db = null; }

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
        is_delta: !!step.is_delta,
        is_snapshot: !!step.is_snapshot,
        attempt: step.attempt,
        max_retries: step.max_retries,
        retry_delay_ms: step.retry_delay_ms,
        error_status: step.error_status,
        timestamp: Date.now(),
        agentId: running?.agent_id || this.taskMetaCache.get(taskId)?.agentId || null,
        parentTaskId: running?.parent_task_id || this.taskMetaCache.get(taskId)?.parentTaskId || null,
        sessionKey: running?.session_key || this.taskMetaCache.get(taskId)?.sessionKey || null,
        sessionInstanceId: running?.session_instance_id || this.taskMetaCache.get(taskId)?.sessionInstanceId || null,
      });
    } catch (e) {
      console.warn('[AgentExecutor] emit step failed:', e.message);
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

  /** 解析修改的文件（stream-json tool_use + 纯文本 fallback） */
  _parseModifiedFiles(output) {
    return extractModifiedFiles(output);
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
      this._clearTaskStreamState(taskId);
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
module.exports.buildClaudeCodeArgs = buildClaudeCodeArgs;
module.exports.buildClaudeContinueArgs = buildClaudeContinueArgs;
