"""SMTP 发信（忘记密码验证码等）— 默认按 163 邮箱授权码方式

环境变量（163 推荐）：
  SMTP_HOST=smtp.163.com
  SMTP_PORT=465
  SMTP_USER=you@163.com          # 完整邮箱
  SMTP_PASSWORD=xxxxxxxx         # 授权码（非登录密码）；也可用 SMTP_AUTH_CODE
  SMTP_FROM=you@163.com          # 须与 USER 一致，否则 163 拒发
  SMTP_TLS=1                     # 端口非 465 时启用 STARTTLS

获取授权码：163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP → 生成授权码
未配置 SMTP_HOST / SMTP_USER 时 send_email 返回 False。
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

logger = logging.getLogger(__name__)

# 163 默认 SMTP
_DEFAULT_163_HOST = "smtp.163.com"
_DEFAULT_163_PORT = 465


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _auth_secret() -> str:
    """授权码：优先 SMTP_AUTH_CODE，其次 SMTP_PASSWORD。"""
    return os.getenv("SMTP_AUTH_CODE") or os.getenv("SMTP_PASSWORD") or ""


def smtp_configured() -> bool:
    """有发信账号即可（host 可缺省为 smtp.163.com）。"""
    user = _env("SMTP_USER")
    secret = _auth_secret().strip()
    host = _env("SMTP_HOST") or (_DEFAULT_163_HOST if user.endswith("@163.com") else "")
    return bool(host and user and secret)


def _resolve_smtp() -> tuple[str, int, str, str, str, bool] | None:
    """返回 (host, port, user, password, from_addr, use_tls)；未配置返回 None。"""
    user = _env("SMTP_USER")
    secret = _auth_secret().strip()
    if not user or not secret:
        return None

    # @163.com 未写 HOST 时自动用网易 SMTP
    host = _env("SMTP_HOST")
    if not host:
        if user.lower().endswith("@163.com"):
            host = _DEFAULT_163_HOST
        else:
            return None

    default_port = str(_DEFAULT_163_PORT) if "163.com" in host.lower() else "587"
    port = int(_env("SMTP_PORT", default_port) or default_port)
    from_addr = _env("SMTP_FROM") or user
    use_tls = _env("SMTP_TLS", "1") not in ("0", "false", "False", "no")
    return host, port, user, secret, from_addr, use_tls


def send_email(to: str, subject: str, body: str) -> bool:
    """发送纯文本邮件；成功 True，未配置或失败 False。"""
    cfg = _resolve_smtp()
    if not cfg:
        return False

    host, port, user, password, from_addr, use_tls = cfg

    # 163 要求 From 与登录账号一致（仅比较邮箱本体）
    if "163.com" in host.lower() and from_addr.lower() != user.lower():
        logger.warning(
            "[mail] 163 发件人须与 SMTP_USER 一致，已改用 %s（原 SMTP_FROM=%s）",
            user, from_addr,
        )
        from_addr = user

    msg = EmailMessage()
    msg["Subject"] = subject
    # 显示名 + 地址，兼容网易校验
    msg["From"] = formataddr(("Token Bank", from_addr))
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@")[-1])
    msg.set_content(body)

    try:
        if port == 465:
            # 163 推荐：SSL 直连
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, timeout=30, context=context) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                smtp.login(user, password)
                smtp.send_message(msg)
        logger.info("[mail] sent via %s:%s to=%s subject=%s", host, port, to, subject)
        return True
    except Exception:
        logger.exception("[mail] send failed host=%s to=%s", host, to)
        return False
