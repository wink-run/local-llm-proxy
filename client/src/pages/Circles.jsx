import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import {
  createCircle, listMyCircles, listJoinedCircles,
  dissolveCircle, leaveCircle, listCircleMembers,
  previewCircle, joinCircle,
} from '../api/client';
import { getServerUrl } from '../config';
import UserAvatar, { userDisplayName, avatarColor } from '../components/UserAvatar';

export default function Circles() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();
  const [owned, setOwned]           = useState([]);
  const [joined, setJoined]         = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName]             = useState('');
  const [desc, setDesc]             = useState('');
  const [creating, setCreating]     = useState(false);
  const [error, setError]           = useState('');
  const [copiedInModal, setCopiedInModal] = useState(false);
  const [inviteModal, setInviteModal]       = useState(null); // { circle, url }
  const [joinInput, setJoinInput]   = useState('');
  const [joinPreview, setJoinPreview] = useState(null);  // { circle, already_member, full }
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError]   = useState('');
  const [joinBanner, setJoinBanner] = useState(() => {
    const r = location.state?.circleResult;
    if (!r) return null;
    if (r.already_member) return { type: 'info',    key: 'circles.alreadyMember' };
    if (r.full)           return { type: 'warning', key: 'circles.fullAutoJoinFailed' };
    if (r.ok)             return { type: 'success', key: 'circles.joinSuccess' };
    return null;
  });

  async function load() {
    setListLoading(true);
    try {
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
    } catch (_) {
      setOwned([]);
      setJoined([]);
    } finally {
      setListLoading(false);
    }
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
      setError(err?.response?.data?.detail || err.message || t('circles.createFailed'));
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
      setJoinPreview({ ...r.data, code });  // opens modal
    } catch (err) {
      setJoinError(err?.response?.data?.detail || t('circles.inviteInvalid'));
      setTimeout(() => setJoinError(''), 3000);
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
        setJoinBanner({ type: 'info', key: 'circles.alreadyMember' });
      } else if (d.full) {
        setJoinBanner({ type: 'warning', key: 'circles.fullCannotJoin' });
      } else {
        setJoinBanner({ type: 'success', key: 'circles.joinSuccessNamed', params: { name: joinPreview.circle.name } });
      }
      setJoinInput(''); setJoinPreview(null);
      await load();
    } catch (err) {
      setJoinError(err?.response?.data?.detail || t('circles.joinFailed'));
    } finally {
      setJoinLoading(false);
    }
  }

  function buildInviteUrl(circle) {
    const base = getServerUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}/app?c=${circle.code}`;
  }

  function openInvite(circle) {
    setCopiedInModal(false);
    setInviteModal({ circle, url: buildInviteUrl(circle) });
  }

  function copyInviteFromModal() {
    if (!inviteModal?.url) return;
    navigator.clipboard.writeText(inviteModal.url).then(() => {
      setCopiedInModal(true);
      setTimeout(() => setCopiedInModal(false), 2000);
    });
  }

  return (
    <div className="px-4 py-4 space-y-4">
      {/* 页头：右侧与标题区垂直居中对齐，electron-no-drag 保证可点击 */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('circles.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('circles.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/circles/browse')}
          className="electron-no-drag relative z-50 shrink-0 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
        >
          {t('circles.browse.link')}
        </button>
      </div>

      {/* 入圈结果横幅 */}
      {joinBanner && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm
          ${joinBanner.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
            joinBanner.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
            'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'}`}>
          <span>{joinBanner.key ? t(joinBanner.key, joinBanner.params) : joinBanner.text}</span>
          <button onClick={() => setJoinBanner(null)} className="ml-3 opacity-60 hover:opacity-100 text-lg leading-none">×</button>
        </div>
      )}

      {/* 创建表单 */}
      {showCreate && (
        <div className="tb-soft-card rounded-xl px-4 py-4 space-y-3">
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
                {t('circles.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 我创建的圈子 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">{t('circles.myCircles')}</h2>
          <button
            onClick={() => setShowCreate(s => !s)}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            {t('circles.createBtn')}
          </button>
        </div>
        {listLoading
          ? (
            <div className="tb-soft-card rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
            </div>
          )
          : owned.length === 0
          ? (
            <div className="tb-soft-card rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('circles.noOwned')}</p>
            </div>
          )
          : owned.map(c => (
            <CircleCard key={c.id} circle={c} isOwner
              onOpen={() => navigate(`/circles/${c.id}`)}
              onInvite={() => openInvite(c)}
              onAction={() => handleDissolve(c)}
              actionLabel={t('circles.dissolve')}
              t={t}
            />
          ))
        }
      </section>

      {/* 我加入的圈子 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 shrink-0">{t('circles.joinedCircles')}</h2>
          <form onSubmit={handleJoinPreview} className="flex gap-2">
            <input
              className="w-48 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t('circles.joinInputPh')}
              value={joinInput}
              onChange={e => { setJoinInput(e.target.value); setJoinPreview(null); setJoinError(''); }}
            />
            <button type="submit" disabled={joinLoading || !joinInput.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0">
              {t('circles.joinBtn')}
            </button>
          </form>
        </div>
        {joinError && <p className="text-red-500 text-xs">{joinError}</p>}

        {listLoading
          ? (
            <div className="tb-soft-card rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
            </div>
          )
          : joined.length === 0
          ? (
            <div className="tb-soft-card rounded-xl px-4 py-6 text-center space-y-2">
              <p className="text-sm text-gray-400 dark:text-gray-500">{t('circles.noJoined')}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('circles.noJoinedHint')}
                {' '}
                <button
                  type="button"
                  onClick={() => navigate('/circles/browse')}
                  className="text-blue-500 hover:text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t('circles.browse.link')}
                </button>
                {' '}
                {t('circles.noJoinedHintAfter')}
              </p>
            </div>
          )
          : joined.map(c => (
            <CircleCard key={c.id} circle={c} isOwner={false}
              onOpen={() => navigate(`/circles/${c.id}`)}
              onInvite={() => openInvite(c)}
              onAction={() => handleLeave(c)}
              actionLabel={t('circles.leave')}
              t={t}
            />
          ))
        }
      </section>
      {/* 邀请同好弹框 */}
      {inviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setInviteModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-80 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('circles.inviteTitle')}</h3>
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full ${avatarColor(inviteModal.circle.name)} flex items-center justify-center text-xl font-bold text-white shrink-0`}>
                {inviteModal.circle.name[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{inviteModal.circle.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">{t('circles.inviteDesc')}</p>
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2.5 leading-relaxed">
              {t('circles.inviteHint')}
            </p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={copyInviteFromModal}
                className="flex-1 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                {copiedInModal ? t('circles.linkCopied') + ' ✓' : t('circles.copyInviteLink')}
              </button>
              <button type="button" onClick={() => setInviteModal(null)}
                className="flex-1 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {t('circles.inviteClose')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 加入圈子弹框 */}
      {joinPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setJoinPreview(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-80 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('circles.joinModalTitle')}</h3>
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full ${avatarColor(joinPreview.circle.name)} flex items-center justify-center text-xl font-bold text-white shrink-0`}>
                {joinPreview.circle.name[0].toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-gray-900 dark:text-gray-100">{joinPreview.circle.name}</p>
                {joinPreview.circle.description && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{joinPreview.circle.description}</p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {t('circles.memberSlots', { current: joinPreview.circle.member_count, max: joinPreview.circle.max_members })}
                </p>
              </div>
            </div>
            {joinError && <p className="text-red-500 text-xs">{joinError}</p>}
            <div className="flex gap-2 pt-1">
              {joinPreview.already_member ? (
                <p className="text-sm text-blue-600 dark:text-blue-400 flex-1">{t('circles.alreadyMember')}</p>
              ) : joinPreview.full ? (
                <p className="text-sm text-yellow-600 dark:text-yellow-400 flex-1">{t('circles.fullCannotJoin')}</p>
              ) : (
                <button onClick={handleJoinConfirm} disabled={joinLoading}
                  className="flex-1 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {joinLoading ? t('circles.joining') : t('circles.joinConfirm')}
                </button>
              )}
              <button onClick={() => setJoinPreview(null)}
                className="flex-1 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {t('circles.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MemberAvatar({ user }) {
  const name = userDisplayName(user);
  return (
    <div className="flex flex-col items-center gap-1 w-10">
      <UserAvatar user={user} />
      <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate w-full text-center leading-tight">
        {name}
      </span>
    </div>
  );
}

function CircleCard({ circle, isOwner, onOpen, onInvite, onAction, actionLabel, t }) {
  const initial  = (circle.name || '?')[0].toUpperCase();
  const color    = avatarColor(circle.name);
  const members  = circle.members || [];
  const SHOW_MAX = 5;
  const extra    = members.length > SHOW_MAX ? members.length - SHOW_MAX : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="tb-soft-tile rounded-xl px-4 py-4 space-y-3 cursor-pointer"
    >
      <div className="flex items-center gap-4">
        <div
          className={`w-11 h-11 rounded-full ${color} flex items-center justify-center text-lg font-bold text-white shrink-0`}
        >
          {initial}
        </div>

        <div className="flex-1 min-w-0 text-left">
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

        {/* 操作按钮：阻止冒泡，避免触发进入详情 */}
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={e => { e.stopPropagation(); onInvite(); }}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            {t('circles.inviteBtn')}
          </button>
          <button type="button" onClick={e => { e.stopPropagation(); onAction(); }}
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
            <div className="flex flex-col items-center gap-1 w-10 shrink-0 ml-1">
              <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-500 dark:text-gray-400">
                +{extra}
              </div>
              <span className="text-[10px] text-gray-400 dark:text-gray-500">…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
