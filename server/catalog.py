"""供给源目录 —— 通过 GET /api/catalog 下发给客户端。

数据源：static/defaults/providers.registry.yaml（可被 DB config.providers 覆盖）。
改 registry 即可让所有客户端拿到新源，无需发版客户端。
"""

from provider_registry import TIERS, catalog_providers, catalog_providers_sync

# 同步兜底（import 时可用；HTTP 接口请用 await catalog_providers()）
PROVIDER_CATALOG = catalog_providers_sync()

__all__ = ["TIERS", "PROVIDER_CATALOG", "catalog_providers", "catalog_providers_sync"]
