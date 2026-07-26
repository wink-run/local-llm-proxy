"""5 分钟积分结算后台任务"""

import asyncio
import logging
import time
from datetime import datetime

import database as db
from worker_pool import pool

logger = logging.getLogger("settler")
INTERVAL = 5 * 60  # 300 秒


def _quality_multiplier(online_mins: float, period_mins: float,
                        avg_ttft_ms: float, success_rate: float) -> float:
    # 在线因子：周期内在线比例，0.5 ~ 1.3
    ratio = min(online_mins / max(period_mins, 1), 1.0)
    online_f = 0.5 + 0.8 * ratio

    # 首 Token 延迟因子：500ms 为基准 1.0，越快越高，0.6 ~ 1.5（无样本时中性 1.0）
    if avg_ttft_ms <= 0:
        latency_f = 1.0
    else:
        latency_f = max(0.6, min(1.5, 500 / avg_ttft_ms))

    # 稳定性因子：成功率，0.5 ~ 1.2
    stability_f = 0.5 + 0.7 * max(0.0, min(1.0, success_rate))

    m = 0.4 * online_f + 0.4 * latency_f + 0.2 * stability_f
    return round(max(0.5, min(1.5, m)), 4)


async def settle_once() -> None:
    period_end = datetime.now().isoformat(timespec="seconds")

    for worker in pool.all_workers():
        online_mins = worker.period_online_mins()
        stats = worker.take_period()  # 取走并重置

        if not worker.user_id or not stats:
            continue

        total_req = sum(s["requests"] for s in stats.values())
        if total_req == 0:
            continue

        total_success = sum(s["success"] for s in stats.values())
        total_ttft = sum(s.get("ttft_sum", 0) for s in stats.values())
        total_ttft_count = sum(s.get("ttft_count", 0) for s in stats.values())
        total_tokens = sum(s["output_tokens"] for s in stats.values())

        # 本周期内「成功请求」的首 Token 平均延迟（ms）；无样本时 0，延迟因子取中性
        avg_ttft_ms = total_ttft / total_ttft_count if total_ttft_count > 0 else 0.0
        success_rate = total_success / total_req
        multiplier = _quality_multiplier(
            online_mins, INTERVAL / 60, avg_ttft_ms, success_rate
        )

        total_credits = 0.0
        resource_names: list[str] = []
        period_start = datetime.fromtimestamp(
            time.time() - online_mins * 60
        ).isoformat(timespec="seconds")

        for model_name, s in stats.items():
            image_count = s.get("image_count", 0)
            output_tokens = s["output_tokens"]

            if image_count > 0:
                rate = await db.get_contribute_rate(model_name)
                if rate is None:
                    continue
                credits = image_count * rate * multiplier
                total_credits += credits
                resource_names.append(model_name)
                await db.award_credits(
                    user_id=worker.user_id,
                    delta=credits,
                    type_="contribute",
                    model_name=model_name,
                    tokens=0,
                    base_credits=image_count * rate,
                    multiplier=multiplier,
                    note=f"worker={worker.worker_id} images={image_count}",
                )
            elif output_tokens > 0:
                rate = await db.get_contribute_rate(model_name)
                if rate is None:
                    continue
                credits = (output_tokens / 1000) * rate * multiplier
                total_credits += credits
                resource_names.append(model_name)
                await db.award_credits(
                    user_id=worker.user_id,
                    delta=credits,
                    type_="contribute",
                    model_name=model_name,
                    tokens=output_tokens,
                    base_credits=(output_tokens / 1000) * rate,
                    multiplier=multiplier,
                    note=f"worker={worker.worker_id}",
                )

        if total_credits > 0:
            # 去重保序
            seen = set()
            uniq_resources = []
            for name in resource_names:
                if name in seen:
                    continue
                seen.add(name)
                uniq_resources.append(name)
            await db.log_settlement(
                worker_id=worker.worker_id,
                user_id=worker.user_id,
                period_start=period_start,
                period_end=period_end,
                online_mins=online_mins,
                output_tokens=total_tokens,
                avg_latency=avg_ttft_ms,
                success_rate=success_rate,
                multiplier=multiplier,
                credits_awarded=total_credits,
                resources=uniq_resources,
            )
            logger.info(
                f"[settle] worker={worker.worker_id} user={worker.user_id} "
                f"tokens={total_tokens} multiplier={multiplier} credits=+{total_credits:.2f} "
                f"resources={uniq_resources}"
            )


_SWEEP_INTERVAL = 60  # 秒


async def run_settler() -> None:
    """在 lifespan 中作为后台 Task 启动"""
    _ticks = 0
    while True:
        await asyncio.sleep(_SWEEP_INTERVAL)
        _ticks += 1
        try:
            offline = await db.sweep_offline_devices()
            if offline:
                logger.info(f"[sweep] marked {offline} device(s) offline")
        except Exception as e:
            logger.error(f"[sweep] error: {e}")
        if _ticks >= INTERVAL // _SWEEP_INTERVAL:
            _ticks = 0
            try:
                await settle_once()
            except Exception as e:
                logger.error(f"[settle] error: {e}")
