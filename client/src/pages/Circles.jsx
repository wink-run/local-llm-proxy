import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useLang } from '../store/lang';
import {
  createCircle, listMyCircles, listJoinedCircles,
  dissolveCircle, leaveCircle, listCircleMembers,
  previewCircle, joinCircle,
} from '../api/client';
import { getServerUrl } from '../config';

const AVATAR_COLORS = [
  'bg-blue-600', 'bg-violet-600', 'bg-emerald-600',
  'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
  'bg-indigo-600', 'bg-rose-600',
];

function circleColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function Circles() {
  const { t } = useLang();
  const location = useLocation();
  const [owned, setOwned]           = useState([]);
  const [joined, setJoined]         = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName]             = useState('');
  const [desc, setDesc]             = useState('');
  const [creating, setCreating]     = useState(false);
  const [error, setError]           = useState('');
  const [copiedId, setCopiedId]     = useState(null);
  const [joinInput, setJoinInput]   = useState('');
  const [joinPreview, setJoinPreview] = useState(null);  // { circle, already_member, full }
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError]   = useState('');
  const [joinBanner, setJoinBanner] = useState(() => {
    const r = location.state?.circleResult;
    if (!r) return null;
    if (r.already_member) return { type: 'info',    text: '你已经是该圈子的成员了' };
    if (r.full)           return { type: 'warning', text: '圈子已满，未能自动加入' };
    if (r.ok)             return { type: 'success', text: '已成功加入圈子 🎉' };
    return null;
  });

  async function load() {
    const [o, j] = await Promise.all([listMyCircles(), listJoinedCircles()]);
    const ownedList = o.data?.circles || [];
    const ownedIds  = new Set(ownedList.map(c => c.id));
    const joinedList = (j.data?.circles || []).filter(c => !ownedIds.has(c.id));
    const allCircles = [...ownedList, ...joinedList];

    // Fetch members for all circles in parallel
    const memberMap = {};
    await Promise.all(allCircles.map(async c => {
      try {
        const r = await listCircleMembers(c.id);
        memberMap[c.id] = r.data?.members || [];
      } catch (_) {
        memberMap[c.id] = [];
      }
    }));

    setOwned(ownedList.map(c => ({ ...c, members: memberMap[c.id] || [] })));
    setJoined(joinedList.map(c => ({ ...c, members: memberMap[c.id] || [] })));
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true); setError('');
    try {
      await createCircle(name.trim(), desc.trim());
      setName(''); setDesc(''); setShowCreate(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function handleDissolve(circle) {
    if (!confirm(t('circles.dissolveConfirm').replace('{name}', circle.name))) return;
    await dissolveCircle(circle.id);
    await load();
  }

  async function handleLeave(circle) {
    if (!confirm(t('circles.leaveConfirm').replace('{name}', circle.name))) return;
    await leaveCircle(circle.id);
    await load();
  }

  function extractCode(input) {
    const s = input.trim();
    // support full URL like http://host/app?c=XXXX or just the code
    try { return new URL(s).searchParams.get('c') || s; } catch { return s; }
  }

  async function handleJoinPreview(e) {
    e.preventDefault();
    const code = extractCode(joinInput);
    if (!code) return;
    setJoinLoading(true); setJoinError(''); setJoinPreview(null);
    try {
      const r = await previewCircle(code);
      setJoinPreview({ ...r.data, code });
    } catch (err) {
      setJoinError(err?.response?.data?.detail || '邀请链接无效');
    } finally {
      setJoinLoading(false);
    }
  }

  async function handleJoinConfirm() {
    if (!joinPreview) return;
    setJoinLoading(true); setJoinError('');
    try {
      const r = await joinCircle(joinPreview.code);
      const d = r.data;
      if (d.already_member) {
        setJoinBanner({ type: 'info', text: '你已经是该圈子的成员了' });
      } else if (d.full) {
        setJoinBanner({ type: 'warning', text: '圈子已满，无法加入' });
      } else {
        setJoinBanner({ type: 'success', text: `已成功加入「${joinPreview.circle.name}」🎉` });
      }
      setJoinInput(''); setJoinPreview(null);
      await load();
    } catch (err) {
      setJoinError(err?.response?.data?.detail || '加入失败');
    } finally {
      setJoinLoading(false);
    }
  }

  function copyInvite(circle) {
    const base = getServerUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    const url = `${base}/app?c=${circle.code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(circle.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  return (
    <div className="px-5 py-5 space-y-5">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('circles.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('circles.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowCreate(s => !s)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {t('circles.createBtn')}
        </button>
      </div>

      {/* 入圈结果横幅 */}
      {joinBanner && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm
          ${joinBanner.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
            joinBanner.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
            'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'}`}>
          <span>{joinBanner.text}</span>
          <button onClick={() => setJoinBanner(null)} className="ml-3 opacity-60 hover:opacity-100 text-lg leading-none">×</button>
        </div>
      )}

      {/* 加入圈子 */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">加入圈子</h2>
        <form onSubmit={handleJoinPreview} className="flex gap-2">
          <input
            className="flex-1 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="粘贴邀请链接或输入邀请码"
            value={joinInput}
            onChange={e => { setJoinInput(e.target.value); setJoinPreview(null); setJoinError(''); }}
          />
          <button type="submit" disabled={joinLoading || !joinInput.trim()}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0">
            查询
          </button>
        </form>

        {joinError && <p className="text-red-500 text-xs">{joinError}</p>}

        {joinPreview && (
          <div className="border border-gray-100 dark:border-gray-700 rounded-lg px-4 py-3 space-y-2">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full ${circleColor(joinPreview.circle.name)} flex items-center justify-center text-base font-bold text-white shrink-0`}>
                {joinPreview.circle.name[0].toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">{joinPreview.circle.name}</p>
                {joinPreview.circle.description && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">{joinPreview.circle.description}</p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {joinPreview.circle.member_count} / {joinPreview.circle.max_members} 人
                </p>
              </div>
            </div>
            {joinPreview.already_member ? (
              <p className="text-xs text-blue-600 dark:text-blue-400">你已经是该圈子的成员</p>
            ) : joinPreview.full ? (
              <p className="text-xs text-yellow-600 dark:text-yellow-400">圈子已满</p>
            ) : (
              <button onClick={handleJoinConfirm} disabled={joinLoading}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {joinLoading ? '加入中…' : '确认加入'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 创建表单 */}
      {showCreate && (
        <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.createTitle')}</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <input
              className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t('circles.namePh')}
              value={name} onChange={e => setName(e.target.value)}
              maxLength={40} required
            />
            <input
              className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t('circles.descPh')}
              value={desc} onChange={e => setDesc(e.target.value)}
              maxLength={120}
            />
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={creating}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {creating ? t('circles.creating') : t('circles.createSubmit')}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setError(''); }}
                className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 我创建的圈子 */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('circles.myCircles')}</h2>
        {owned.length === 0
          ? (
            <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('circles.noOwned')}</p>
            </div>
          )
          : owned.map(c => (
            <CircleCard key={c.id} circle={c} isOwner
              onCopy={() => copyInvite(c)}
              copied={copiedId === c.id}
              onAction={() => handleDissolve(c)}
              actionLabel={t('circles.dissolve')}
              t={t}
            />
          ))
        }
      </section>

      {/* 我加入的圈子 */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('circles.joinedCircles')}</h2>
        {joined.length === 0
          ? (
            <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('circles.noJoined')}</p>
            </div>
          )
          : joined.map(c => (
            <CircleCard key={c.id} circle={c} isOwner={false}
              onCopy={() => copyInvite(c)}
              copied={copiedId === c.id}
              onAction={() => handleLeave(c)}
              actionLabel={t('circles.leave')}
              t={t}
            />
          ))
        }
      </section>
    </div>
  );
}

function MemberAvatar({ user }) {
  const name    = user.nickname || user.email || '?';
  const initial = name[0].toUpperCase();
  const color   = circleColor(name);
  return (
    <div className="flex flex-col items-center gap-1 w-10">
      <div className={`w-8 h-8 rounded-full ${color} flex items-center justify-center text-xs font-bold text-white shrink-0`}>
        {initial}
      </div>
      <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate w-full text-center leading-tight">
        {name}
      </span>
    </div>
  );
}

function CircleCard({ circle, isOwner, onCopy, copied, onAction, actionLabel, t }) {
  const initial  = (circle.name || '?')[0].toUpperCase();
  const color    = circleColor(circle.name);
  const members  = circle.members || [];
  const SHOW_MAX = 8;
  const extra    = members.length > SHOW_MAX ? members.length - SHOW_MAX : 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-3">
      {/* 主行 */}
      <div className="flex items-center gap-4">
        {/* 圈子头像 */}
        <div className={`w-11 h-11 rounded-full ${color} flex items-center justify-center text-lg font-bold text-white shrink-0`}>
          {initial}
        </div>

        {/* 信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">{circle.name}</span>
            {isOwner && (
              <span className="shrink-0 text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-md">
                {t('circles.isOwner')}
              </span>
            )}
          </div>
          {circle.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">{circle.description}</p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {t('circles.members').replace('{n}', circle.member_count)}
          </p>
        </div>

        {/* 操作 */}
        <div className="flex gap-2 shrink-0">
          <button onClick={onCopy}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            {copied ? t('circles.linkCopied') + ' ✓' : t('circles.inviteLink')}
          </button>
          <button onClick={onAction}
            className="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            {actionLabel}
          </button>
        </div>
      </div>

      {/* 成员头像行 */}
      {members.length > 0 && (
        <div className="flex items-center gap-1 pl-0.5">
          <div className="flex gap-1 flex-wrap">
            {members.slice(0, SHOW_MAX).map(m => (
              <MemberAvatar key={m.id} user={m} />
            ))}
          </div>
          {extra > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">+{extra}</span>
          )}
        </div>
      )}
    </div>
  );
}
