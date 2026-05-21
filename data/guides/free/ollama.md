# 本地 Ollama —— 零成本无限本地推理

如果你的电脑有足够内存（≥16G）和显卡（可选，CPU 也能跑小模型），Ollama 是最划算的方案。

## 步骤

1. 打开 https://ollama.com/download 下载并安装 Ollama
2. 安装后 Ollama 自动启动并监听 `127.0.0.1:11434`，无需配置 API key
3. 拉取一个模型，例如：
   ```
   ollama pull qwen3:8b
   ollama pull llama3.2:3b
   ```
4. 回到本应用，**直接点测试连接** —— 不需要填 key

## 推荐模型（按显存大小）

| 显存 | 模型 |
|---|---|
| 8 GB | `llama3.2:3b`, `qwen3:8b`（小量化） |
| 16 GB | `qwen3:8b`, `gemma2:9b` |
| 24 GB | `qwen3:14b`, `llama3.3:8b` |
| 48 GB+ | `qwen3:32b`, `llama3.3:70b-q4` |

## 注意

- 模型质量与显存高度相关，3B 模型只适合简单问答
- 速度依赖 GPU/CPU，无 GPU 的电脑生成速度可能慢
- 数据完全在本机，**最隐私的选项**
