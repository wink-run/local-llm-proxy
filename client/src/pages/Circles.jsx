import React, { useEffect, useState } from 'react';
import { useLang } from '../store/lang';
import {
  createCircle, listMyCircles, listJoinedCircles,
  dissolveCircle, leaveCircle,
} from '../api/client';

function getBaseUrl() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

export default function Circles() {
  const { t } = useLang();
  const [owned, setOwned] = useState([]);
  const [joined, setJoined] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  async function load() {
    const [o, j] = await Promise.all([listMyCircles(), listJoinedCircles()]);
    setOwned(o.circles || []);
    // Exclude owned circles from joined list to avoid duplication
    const ownedIds = new Set((o.circles || []).map(c => c.id));
    setJoined((j.circles || []).filter(c => !ownedIds.has(c.id)));
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

  function copyInvite(circle) {
    const base = getBaseUrl();
    const url = `${base}/?c=${circle.code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(circle.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('circles.title')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t('circles.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowCreate(s => !s)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          {t('circles.createBtn')}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="border rounded-lg p-4 space-y-3 bg-gray-50 dark:bg-gray-800">
          <h2 className="font-medium">{t('circles.createTitle')}</h2>
          <input
            className="w-full border rounded px-3 py-1.5 text-sm"
            placeholder={t('circles.namePh')}
            value={name} onChange={e => setName(e.target.value)}
            maxLength={40} required
          />
          <input
            className="w-full border rounded px-3 py-1.5 text-sm"
            placeholder={t('circles.descPh')}
            value={desc} onChange={e => setDesc(e.target.value)}
            maxLength={120}
          />
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={creating}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {creating ? t('circles.creating') : t('circles.createSubmit')}
            </button>
            <button type="button" onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
              取消
            </button>
          </div>
        </form>
      )}

      <section>
        <h2 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">{t('circles.myCircles')}</h2>
        {owned.length === 0
          ? <p className="text-sm text-gray-400">{t('circles.noOwned')}</p>
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

      <section>
        <h2 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">{t('circles.joinedCircles')}</h2>
        {joined.length === 0
          ? <p className="text-sm text-gray-400">{t('circles.noJoined')}</p>
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

function CircleCard({ circle, isOwner, onCopy, copied, onAction, actionLabel, t }) {
  return (
    <div className="border rounded-lg p-4 mb-3 flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{circle.name}</span>
          {isOwner && (
            <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded dark:bg-blue-900 dark:text-blue-300">
              {t('circles.isOwner')}
            </span>
          )}
        </div>
        {circle.description && <p className="text-sm text-gray-500 mt-0.5 truncate">{circle.description}</p>}
        <p className="text-xs text-gray-400 mt-1">
          {t('circles.members').replace('{n}', circle.member_count)}
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={onCopy}
          className="text-xs px-2 py-1 border rounded hover:bg-gray-50 dark:hover:bg-gray-800">
          {copied ? t('circles.linkCopied') : t('circles.inviteLink')}
        </button>
        <button onClick={onAction}
          className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/20">
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
