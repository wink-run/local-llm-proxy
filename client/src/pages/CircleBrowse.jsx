import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { browseCircles, applyJoinCircle } from '../api/client';

const AVATAR_COLORS = [
  'bg-blue-600', 'bg-violet-600', 'bg-emerald-600',
  'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
];

function circleColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function CircleBrowse() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [query, setQuery]       = useState('');
  const [circles, setCircles]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [applying, setApplying] = useState(null); // circle id
  const [banner, setBanner]     = useState(null);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const r = await browseCircles(q);
      setCircles(r.data?.circles || []);
    } catch {
      setCircles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    load(query.trim());
  }

  async function handleApply(circle) {
    if (circle.join_status === 'member' || circle.join_status === 'pending' || circle.full) return;
    setApplying(circle.id);
    try {
      const r = await applyJoinCircle(circle.id);
      const d = r.data;
      if (d.already_member) {
        setBanner({ type: 'info', text: t('circles.browse.alreadyMember') });
        await load(query.trim());
      } else if (d.pending) {
        setBanner({ type: 'success', text: t('circles.browse.applySent').replace('{name}', circle.name) });
        setCircles(prev => prev.map(c => (
          c.id === circle.id ? { ...c, join_status: 'pending' } : c
        )));
      }
    } catch (err) {
      setBanner({
        type: 'warning',
        text: err?.response?.data?.detail || t('circles.browse.applyFailed'),
      });
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="px-5 py-5 space-y-5">
      {/* 页头 */}
      <div>
        <div className="mb-1">
          <button
            type="button"
            onClick={() => navigate('/circles')}
            className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors"
          >
            {t('circles.browse.back')}
          </button>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('circles.browse.title')}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('circles.browse.subtitle')}</p>
          </div>
        </div>
      </div>

      {banner && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm
          ${banner.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
            banner.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
            'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'}`}>
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="ml-3 opacity-60 hover:opacity-100 text-lg leading-none">×</button>
        </div>
      )}

      {/* 搜索 */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          className="flex-1 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={t('circles.browse.searchPh')}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button
          type="submit"
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0"
        >
          {t('circles.browse.search')}
        </button>
      </form>

      {/* 列表 */}
      {loading ? (
        <p className="text-sm text-gray-400">{t('circles.browse.loading')}</p>
      ) : circles.length === 0 ? (
        <div className="tb-soft-card rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-gray-400">{t('circles.browse.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {circles.map(c => (
            <BrowseCard
              key={c.id}
              circle={c}
              applying={applying === c.id}
              onApply={() => handleApply(c)}
              onOpen={() => {
                if (c.join_status === 'member') navigate(`/circles/${c.id}`);
              }}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BrowseCard({ circle, applying, onApply, onOpen, t }) {
  const initial = (circle.name || '?')[0].toUpperCase();
  const color   = circleColor(circle.name);
  const isMember  = circle.join_status === 'member';
  const isPending = circle.join_status === 'pending';
  const isFull    = circle.full && !isMember;

  let actionBtn;
  if (isMember) {
    actionBtn = (
      <button type="button" onClick={onOpen}
        className="text-xs px-3 py-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors shrink-0">
        {t('circles.browse.view')}
      </button>
    );
  } else if (isPending) {
    actionBtn = (
      <span className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 shrink-0">
        {t('circles.browse.pending')}
      </span>
    );
  } else if (isFull) {
    actionBtn = (
      <span className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-400 shrink-0">
        {t('circles.browse.full')}
      </span>
    );
  } else {
    actionBtn = (
      <button type="button" onClick={onApply} disabled={applying}
        className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0">
        {applying ? t('circles.browse.applying') : t('circles.browse.apply')}
      </button>
    );
  }

  return (
    <div className="tb-soft-card rounded-xl px-4 py-4">
      <div className="flex items-center gap-4">
        <div className={`w-11 h-11 rounded-full ${color} flex items-center justify-center text-lg font-bold text-white shrink-0`}>
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">{circle.name}</div>
          {circle.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">{circle.description}</p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {t('circles.members').replace('{n}', circle.member_count)}
            {circle.max_members ? ` / ${circle.max_members}` : ''}
          </p>
        </div>
        {actionBtn}
      </div>
    </div>
  );
}
