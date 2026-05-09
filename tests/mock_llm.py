"""模拟 OpenAI 兼容的 LLM 服务，用于本地测试"""

import asyncio
import json
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI(title="Mock LLM")

FAKE_REPLY = "你好！我是模拟的 LLM 服务。这是一条测试回复，用于验证代理链路是否正常工作。"


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    model = body.get("model", "mock-model")
    streaming = body.get("stream", False)
    req_id = f"chatcmpl-{uuid.uuid4().hex[:8]}"
    created = int(time.time())

    if streaming:
        async def gen():
            for i, ch in enumerate(FAKE_REPLY):
                chunk = {
                    "id": req_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": ch}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                await asyncio.sleep(0.02)
            # Final chunk
            done_chunk = {
                "id": req_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(done_chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return {
        "id": req_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": FAKE_REPLY},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": len(FAKE_REPLY), "total_tokens": 10 + len(FAKE_REPLY)},
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=11434)
