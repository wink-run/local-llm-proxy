"""Mock image generation service for integration testing.

Run: uvicorn tests.mock_image_llm:app --port 11435
Then register a worker pointing at this server with model type 'image'.
"""
import base64
import time
import uuid

from fastapi import FastAPI, Request

app = FastAPI(title="Mock Image LLM")

# 1x1 red PNG, base64-encoded
_RED_1X1_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
)


@app.post("/v1/images/generations")
async def generate(request: Request):
    body = await request.json()
    n = int(body.get("n") or 1)
    prompt = body.get("prompt", "")
    return {
        "created": int(time.time()),
        "data": [
            {
                "b64_json": _RED_1X1_PNG,
                "revised_prompt": f"[mock] {prompt}",
            }
            for _ in range(n)
        ],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=11435)
