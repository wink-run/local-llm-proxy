"""积分与人民币折算，与 model_configs 默认消费率对齐。"""

# 与 database._OPEN_DEFAULT_CONSUME 保持一致
DEFAULT_CONSUME_RATE = 5.0
DEFAULT_CONTRIBUTE_RATE = 8.0
# 无模型刊例价时的兜底：每百万 token 5 元人民币
DEFAULT_CNY_PER_MILLION = 5.0


def cny_per_million_tokens(consume_rate: float | None) -> float:
    """按模型 consume_rate（积分/千 token）折算百万 token 人民币单价。"""
    rate = consume_rate if consume_rate and consume_rate > 0 else DEFAULT_CONSUME_RATE
    return (rate / DEFAULT_CONSUME_RATE) * DEFAULT_CNY_PER_MILLION


def credits_to_cny(credits: float, consume_rate: float | None = None) -> float:
    """积分折算人民币：与默认消费率对齐，1M token ≈ DEFAULT_CNY_PER_MILLION 元。"""
    rate = consume_rate if consume_rate and consume_rate > 0 else DEFAULT_CONSUME_RATE
    return credits * DEFAULT_CNY_PER_MILLION / (1000 * rate)
