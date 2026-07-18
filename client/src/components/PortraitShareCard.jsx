import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import logoUrl from '../assets/logo.svg';

const W = 1080;
const H = 1440;

function wrapLines(ctx, text, maxWidth, maxLines = 4) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const lines = [];
  let line = '';
  for (const ch of raw) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && raw.length > lines.join('').length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 取短标题:冒号前 / 截断 */
function headline(text, maxLen = 6) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const head = raw.split(/[:：,，。；;]/)[0].trim() || raw;
  return head.length > maxLen ? `${head.slice(0, maxLen - 1)}…` : head;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function stampGrain(ctx, alpha = 0.045) {
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const t = tile.getContext('2d');
  const data = t.createImageData(96, 96);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = (alpha * 255) | 0;
  }
  t.putImageData(data, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, W, H);
}

/** 极简线形图标 */
function drawIcon(ctx, kind, cx, cy, color, scale = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'eye') {
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 11, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'hex') {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const x = Math.cos(a) * 16;
      const y = Math.sin(a) * 16;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (kind === 'nodes') {
    const pts = [[-14, 10], [14, 10], [0, -14]];
    pts.forEach(([x, y], i) => {
      const [nx, ny] = pts[(i + 1) % 3];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    });
    pts.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (kind === 'bolt') {
    ctx.beginPath();
    ctx.moveTo(2, -16);
    ctx.lineTo(-6, 2);
    ctx.lineTo(2, 2);
    ctx.lineTo(-2, 16);
    ctx.lineTo(8, -2);
    ctx.lineTo(0, -2);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'compass') {
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(5, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-5, 8);
    ctx.closePath();
    ctx.fill();
  } else {
    // spark
    for (let i = 0; i < 4; i += 1) {
      const a = (Math.PI / 2) * i;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
      ctx.lineTo(Math.cos(a) * 16, Math.sin(a) * 16);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * 全幅主视觉:会话星座汇聚 →「懂你」核心
 * 底部渐变蒙版留给引语叠字
 */
function paintHero(ctx, sessions, accentTags) {
  const hx = 0;
  const hy = 0;
  const hw = W;
  const hh = 860;

  // 全bleed背景(石板 + 琥珀)
  const sky = ctx.createLinearGradient(0, 0, hw, hh);
  sky.addColorStop(0, '#0c0a09');
  sky.addColorStop(0.35, '#1a1520');
  sky.addColorStop(0.7, '#0f172a');
  sky.addColorStop(1, '#1c1917');
  ctx.fillStyle = sky;
  ctx.fillRect(hx, hy, hw, hh);

  // 大块几何色面(图感)
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(hw * 0.55, 0);
  ctx.lineTo(hw, 0);
  ctx.lineTo(hw, hh * 0.7);
  ctx.closePath();
  const wedge = ctx.createLinearGradient(hw * 0.55, 0, hw, hh * 0.5);
  wedge.addColorStop(0, 'rgba(245,158,11,0.0)');
  wedge.addColorStop(1, 'rgba(245,158,11,0.35)');
  ctx.fillStyle = wedge;
  ctx.fill();
  ctx.restore();

  // 点阵
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let i = 0; i < 90; i += 1) {
    const px = ((i * 97) % hw);
    const py = ((i * 53) % (hh * 0.75));
    ctx.beginPath();
    ctx.arc(px, py, (i % 3) + 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx = hw * 0.42;
  const cy = hh * 0.42;

  // 外环光
  const glow = ctx.createRadialGradient(cx, cy, 20, cx, cy, 280);
  glow.addColorStop(0, 'rgba(251,191,36,0.45)');
  glow.addColorStop(0.4, 'rgba(99,102,241,0.18)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 280, 0, Math.PI * 2);
  ctx.fill();

  // 轨道
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 90 + i * 48, 58 + i * 32, -0.55 + i * 0.12, 0, Math.PI * 2);
    ctx.strokeStyle = i === 2 ? 'rgba(251,191,36,0.65)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = i === 2 ? 3 : 1.5;
    ctx.stroke();
  }

  // 会话节点汇聚
  const n = Math.min(12, Math.max(6, Number(sessions) || 8));
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - 0.4;
    const r = 150 + (i % 5) * 28;
    const px = cx + Math.cos(a) * r * 0.95;
    const py = cy + Math.sin(a) * r * 0.62;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx, cy);
    ctx.strokeStyle = `rgba(253,230,138,${0.08 + (i % 4) * 0.04})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const blob = ctx.createRadialGradient(px, py, 0, px, py, 18);
    blob.addColorStop(0, i % 2 ? 'rgba(251,191,36,0.95)' : 'rgba(129,140,248,0.9)');
    blob.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = blob;
    ctx.beginPath();
    ctx.arc(px, py, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fffbeb';
    ctx.fill();
  }

  // 核心「透镜」
  const core = ctx.createRadialGradient(cx - 12, cy - 14, 6, cx, cy, 70);
  core.addColorStop(0, '#fffbeb');
  core.addColorStop(0.4, '#fbbf24');
  core.addColorStop(1, '#78350f');
  ctx.beginPath();
  ctx.arc(cx, cy, 64, 0, Math.PI * 2);
  ctx.fillStyle = core;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 3;
  ctx.stroke();
  drawIcon(ctx, 'eye', cx, cy, '#1c1917', 1.35);

  // 右侧竖排浮层贴纸(图+短词,非段落)
  const stickers = (accentTags || []).slice(0, 3);
  stickers.forEach((tag, i) => {
    const sx = hw - 320;
    const sy = 160 + i * 118;
    ctx.save();
    ctx.translate(sx + 140, sy + 40);
    ctx.rotate((i - 1) * 0.05);
    ctx.translate(-(sx + 140), -(sy + 40));
    // 阴影
    roundRect(ctx, sx + 6, sy + 8, 280, 78, 22);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();
    // 卡面
    roundRect(ctx, sx, sy, 280, 78, 22);
    const cardG = ctx.createLinearGradient(sx, sy, sx + 280, sy + 78);
    cardG.addColorStop(0, 'rgba(255,255,255,0.16)');
    cardG.addColorStop(1, 'rgba(255,255,255,0.06)');
    ctx.fillStyle = cardG;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 图标色块
    const tones = ['#fbbf24', '#38bdf8', '#a78bfa'];
    const icons = ['compass', 'hex', 'bolt'];
    roundRect(ctx, sx + 14, sy + 14, 50, 50, 14);
    ctx.fillStyle = tones[i];
    ctx.fill();
    drawIcon(ctx, icons[i], sx + 39, sy + 39, '#0c0a09', 0.85);
    ctx.fillStyle = '#fafaf9';
    ctx.font = '700 28px "PingFang SC","Hiragino Sans GB",system-ui,sans-serif';
    ctx.fillText(tag, sx + 80, sy + 50);
    ctx.restore();
  });

  // 左下会话徽章(数字可视化)
  roundRect(ctx, 48, hh - 200, 220, 100, 24);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(251,191,36,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#fde68a';
  ctx.font = '800 52px "DIN Alternate","Avenir Next",system-ui,sans-serif';
  ctx.fillText(String(sessions != null ? sessions : '—'), 72, hh - 140);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '600 18px "PingFang SC",system-ui,sans-serif';
  ctx.fillText('会话 · 自动汇聚', 72, hh - 112);

  // 底部渐变,承托引语
  const fade = ctx.createLinearGradient(0, hh - 280, 0, hh);
  fade.addColorStop(0, 'rgba(12,10,9,0)');
  fade.addColorStop(0.55, 'rgba(12,10,9,0.75)');
  fade.addColorStop(1, '#0c0a09');
  ctx.fillStyle = fade;
  ctx.fillRect(0, hh - 280, hw, 280);
}

/** Bento 瓷砖:大图标区 + 短标题(图文并置) */
function paintBento(ctx, x, y, w, h, { tone, icon, label, sub }) {
  roundRect(ctx, x, y, w, h, 28);
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 上半:纯图形色场
  roundRect(ctx, x + 14, y + 14, w - 28, h * 0.48, 20);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, tone);
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g;
  ctx.fill();
  drawIcon(ctx, icon, x + w / 2, y + 14 + (h * 0.48) / 2, '#0c0a09', 1.4);

  // 下半:短文
  ctx.fillStyle = '#fafaf9';
  ctx.font = '700 26px "PingFang SC",system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h * 0.68);
  if (sub) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 16px "PingFang SC",system-ui,sans-serif';
    ctx.fillText(sub, x + w / 2, y + h * 0.82);
  }
  ctx.textAlign = 'left';
}

/**
 * 图文海报:主视觉主导(~60%) + 引语叠图 + bento 瓷砖,杜绝清单堆字。
 */
export async function renderPortraitSharePng(portrait, labels) {
  const {
    brand = 'Token Bank',
    tagline = '越用越懂你 · 自动发现',
    title = '我的 AI 工作画像',
    footer = '用 Agent 越多，Token Bank 越懂你要什么',
  } = labels || {};

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const traits = (portrait?.traits || []).map((t) => headline(t, 7)).filter(Boolean);
  const goals = (portrait?.goals || []).map((g) => headline(g, 8)).filter(Boolean);
  const needs = (portrait?.needs || [])
    .map((n) => headline(typeof n === 'string' ? n : n?.text, 7))
    .filter(Boolean);
  const sessions = portrait?.digest?.sessions;
  const persona = String(portrait?.persona || '').trim();

  // 1) 全幅主视觉
  paintHero(ctx, sessions, [
    traits[0] || '风格透镜',
    goals[0] || '能力域',
    needs[0] || '自动发现',
  ]);

  let logo = null;
  try { logo = await loadImage(logoUrl); } catch { /* */ }

  // 顶栏叠在主视觉上
  if (logo) ctx.drawImage(logo, 48, 40, 48, 48);
  else {
    ctx.beginPath();
    ctx.arc(72, 64, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
  }
  ctx.fillStyle = '#fafaf9';
  ctx.font = '700 28px "PingFang SC",system-ui,sans-serif';
  ctx.fillText(brand, 112, 58);
  ctx.fillStyle = 'rgba(251,191,36,0.95)';
  ctx.font = '600 17px "PingFang SC",system-ui,sans-serif';
  ctx.fillText(tagline, 112, 86);

  // 标题条(咬在图上)
  roundRect(ctx, 48, 120, 420, 72, 18);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();
  ctx.fillStyle = '#fafaf9';
  ctx.font = '700 34px "PingFang SC",system-ui,sans-serif';
  ctx.fillText(title, 68, 166);

  // 2) 引语叠在主视觉底部(图文一体,不是独立字卡墙)
  ctx.fillStyle = 'rgba(251,191,36,0.55)';
  ctx.font = '700 72px Georgia,"Songti SC",serif';
  ctx.fillText('“', 40, 720);
  ctx.fillStyle = '#fafaf9';
  ctx.font = '500 30px "PingFang SC",system-ui,sans-serif';
  const quote = persona || '正在从你的 Agent 会话中形成画像…';
  wrapLines(ctx, quote, W - 120, 3).forEach((ln, i) => {
    ctx.fillText(ln, 88, 740 + i * 40);
  });

  // 3) 下半:深底 + 非对称 bento(图标主导)
  ctx.fillStyle = '#0c0a09';
  ctx.fillRect(0, 860, W, H - 860);

  // 细分割线装饰
  ctx.strokeStyle = 'rgba(251,191,36,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(48, 880);
  ctx.lineTo(200, 880);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '600 14px "PingFang SC",system-ui,sans-serif';
  ctx.fillText('FROM YOUR AGENTS', 216, 886);

  const gap = 16;
  const bw = Math.floor((W - 96 - gap * 2) / 3);
  const bh = 220;
  const by = 920;
  const tiles = [
    { tone: '#38bdf8', icon: 'compass', label: traits[0] || '风格', sub: traits[1] || '性格透镜' },
    { tone: '#fbbf24', icon: 'hex', label: goals[0] || '能力域', sub: goals[1] || '长期配备' },
    { tone: '#a78bfa', icon: 'bolt', label: needs[0] || '发现', sub: needs[1] || '自动匹配' },
  ];
  tiles.forEach((tile, i) => {
    paintBento(ctx, 48 + i * (bw + gap), by, bw, bh, tile);
  });

  // 宽幅宣言条(图标 + 一句 slogans,非段落)
  const barY = by + bh + 28;
  roundRect(ctx, 48, barY, W - 96, 100, 28);
  const bar = ctx.createLinearGradient(48, barY, W - 48, barY + 100);
  bar.addColorStop(0, 'rgba(180,83,9,0.75)');
  bar.addColorStop(0.55, 'rgba(79,70,229,0.45)');
  bar.addColorStop(1, 'rgba(15,23,42,0.8)');
  ctx.fillStyle = bar;
  ctx.fill();
  roundRect(ctx, 68, barY + 22, 56, 56, 16);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
  drawIcon(ctx, 'nodes', 96, barY + 50, '#0c0a09', 1);
  ctx.fillStyle = '#fffbeb';
  ctx.font = '700 28px "PingFang SC",system-ui,sans-serif';
  ctx.fillText(tagline, 144, barY + 48);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '500 18px "PingFang SC",system-ui,sans-serif';
  ctx.fillText(footer, 144, barY + 78);

  // 底角品牌
  if (logo) ctx.drawImage(logo, W - 100, H - 72, 40, 40);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '600 14px "PingFang SC",system-ui,sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(brand, W - 112, H - 46);
  ctx.textAlign = 'left';

  stampGrain(ctx, 0.04);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('png failed'));
      else resolve(blob);
    }, 'image/png');
  });
}

export function buildPortraitShareText(portrait, t, typeLabel) {
  const lines = [];
  lines.push('我在 Token Bank 被自动认出了工作画像');
  lines.push('越用越懂你 · 自动发现技能 / 提示词 / 智能体');
  lines.push('');
  if (portrait?.persona) lines.push(`「${portrait.persona}」`);
  lines.push('');
  if (portrait?.traits?.length) {
    lines.push(`风格 · ${portrait.traits.slice(0, 3).map((x) => headline(x, 8)).join(' / ')}`);
  }
  if (portrait?.goals?.length) {
    lines.push(`能力 · ${portrait.goals.slice(0, 3).map((x) => headline(x, 8)).join(' / ')}`);
  }
  const needs = (portrait?.needs || []).map((n) => (typeof n === 'string' ? n : n?.text)).filter(Boolean);
  if (needs.length) {
    lines.push(`配备 · ${needs.slice(0, 3).map((x) => headline(x, 8)).join(' / ')}`);
  }
  lines.push('');
  lines.push('#TokenBank #越用越懂你 #自动发现');
  return lines.join('\n');
}

/** 页内画像可视化:图文 bento,非纯文字列表 */
export function PortraitVisualBoard({
  persona,
  traits = [],
  goals = [],
  extensions = [],
  needs = [],
  digest,
  t,
  typeLabel,
  onShare,
  canShare,
}) {
  const traitHeads = traits.map((x) => headline(x, 10));
  const goalHeads = goals.map((x) => headline(x, 12));
  const needHeads = needs.map((n) => headline(typeof n === 'string' ? n : n?.text, 10));
  const extHeads = extensions.map((x) => headline(x, 10));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">{t('resources.reco.conclusionTitle')}</p>
        {canShare && onShare && (
          <button
            type="button"
            onClick={onShare}
            className="text-[11px] px-2.5 py-1 rounded-md border border-amber-300/80 dark:border-amber-700/60 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/30"
          >
            {t('resources.reco.share')}
          </button>
        )}
      </div>

      {/* 主视觉条:抽象图 + 引语 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/80 dark:border-zinc-700/70 min-h-[140px]">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 30% 40%, rgba(251,191,36,0.35), transparent 55%),'
              + 'radial-gradient(ellipse at 80% 20%, rgba(99,102,241,0.28), transparent 50%),'
              + 'linear-gradient(135deg, #0c0a09 0%, #1e1b4b 45%, #1c1917 100%)',
          }}
        />
        {/* 装饰环 */}
        <div className="absolute left-[18%] top-1/2 -translate-y-1/2 w-28 h-28 rounded-full border border-amber-400/40" />
        <div className="absolute left-[18%] top-1/2 -translate-y-1/2 w-16 h-16 rounded-full border-2 border-amber-300/70 bg-amber-400/20" />
        <div className="absolute left-[22%] top-[38%] w-2 h-2 rounded-full bg-amber-300 shadow-[0_0_12px_#fbbf24]" />
        <div className="absolute left-[12%] top-[55%] w-1.5 h-1.5 rounded-full bg-indigo-300" />
        <div className="absolute left-[30%] top-[62%] w-1.5 h-1.5 rounded-full bg-sky-300" />

        <div className="relative z-[1] p-4 pl-[42%] sm:pl-[38%] space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-amber-200/80">{t('resources.reco.analysis')}</span>
            {digest?.sessions != null && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-black/30 text-amber-100/80 border border-amber-500/30">
                {t('resources.reco.sessions', { n: digest.sessions })}
              </span>
            )}
          </div>
          {persona ? (
            <p className="text-sm leading-relaxed text-stone-50 font-medium">
              <span className="text-amber-300/80 text-lg leading-none mr-1">“</span>
              {persona}
            </p>
          ) : (
            <p className="text-[11px] text-stone-400">{t('resources.reco.noPersona')}</p>
          )}
        </div>
      </div>

      {/* 三列图文瓷砖 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {[
          {
            title: t('resources.reco.traitsTitle'),
            items: traitHeads,
            icon: '◎',
            tone: 'from-sky-500/20 to-sky-900/10 border-sky-300/40 text-sky-800 dark:text-sky-200',
            chip: 'bg-sky-100/80 dark:bg-sky-900/40 text-sky-700 dark:text-sky-200',
          },
          {
            title: t('resources.reco.goalsTitle'),
            items: goalHeads,
            icon: '⬡',
            tone: 'from-amber-500/20 to-amber-900/10 border-amber-300/40 text-amber-900 dark:text-amber-100',
            chip: 'bg-amber-100/80 dark:bg-amber-900/40 text-amber-800 dark:text-amber-100',
          },
          {
            title: t('resources.reco.needsTitle', { type: typeLabel }),
            items: needHeads.length ? needHeads : extHeads,
            icon: '⚡',
            tone: 'from-violet-500/20 to-violet-900/10 border-violet-300/40 text-violet-900 dark:text-violet-100',
            chip: 'bg-violet-100/80 dark:bg-violet-900/40 text-violet-800 dark:text-violet-100',
          },
        ].map((col) => (
          <div
            key={col.title}
            className={`rounded-xl border bg-gradient-to-b p-3 space-y-2 min-h-[108px] ${col.tone}`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/70 dark:bg-black/30 text-base shadow-sm">
                {col.icon}
              </span>
              <p className="text-[10px] font-semibold opacity-80 leading-tight">{col.title}</p>
            </div>
            {col.items.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {col.items.slice(0, 4).map((item, i) => (
                  <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-md ${col.chip}`}>
                    {item}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[10px] opacity-50">—</p>
            )}
          </div>
        ))}
      </div>

      {extHeads.length > 0 && needHeads.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-400 shrink-0">{t('resources.reco.extensionsTitle')}</span>
          {extHeads.slice(0, 4).map((e, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 border border-amber-200/50 dark:border-amber-800/40">
              {e}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PortraitShareModal({ open, onClose, portrait, typeLabel, t }) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const blobRef = useRef(null);

  const labels = useMemo(() => ({
    brand: 'Token Bank',
    tagline: t('resources.reco.shareTagline'),
    title: t('resources.reco.shareTitle'),
    footer: t('resources.reco.shareFooter'),
  }), [t]);

  const regenerate = useCallback(async () => {
    if (!portrait) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const blob = await renderPortraitSharePng(portrait, labels);
      blobRef.current = blob;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setMsg(t('resources.reco.shareReady'));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [portrait, labels, t]);

  useEffect(() => {
    if (!open) return undefined;
    regenerate();
    return undefined;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  if (!open) return null;

  const download = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = `tokenbank-portrait-${Date.now()}.png`;
    a.click();
    setMsg(t('resources.reco.shareSaved'));
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(buildPortraitShareText(portrait, t, typeLabel));
      setMsg(t('resources.reco.shareCopied'));
    } catch {
      setErr(t('resources.reco.shareCopyFailed'));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/55 backdrop-blur-[3px]" role="dialog" aria-modal>
      <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{t('resources.reco.shareModalTitle')}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t('resources.reco.shareModalHint')}</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            {t('resources.reco.cancel')}
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-zinc-950 aspect-[1080/1440] max-h-[56vh] flex items-center justify-center">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="w-full h-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-2 py-20 text-zinc-500">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
                </span>
                <p className="text-xs">{busy ? t('resources.reco.shareGenerating') : '—'}</p>
              </div>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">{t('resources.reco.shareVisualHint')}</p>
          {(msg || err) && (
            <p className={`text-[11px] ${err ? 'text-red-500' : 'text-emerald-600'}`}>{err || msg}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !previewUrl} onClick={download}
              className="px-3.5 py-2 rounded-xl bg-amber-600 text-white text-xs font-medium hover:bg-amber-500 disabled:opacity-45">
              {t('resources.reco.shareDownload')}
            </button>
            <button type="button" disabled={busy} onClick={copyText}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.reco.shareCopy')}
            </button>
            <button type="button" disabled={busy} onClick={regenerate}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.reco.shareRegen')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
