import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import {
  getCircleDetail,
  listCircleMembers,
  createCirclePost,
  updateCirclePost,
  deleteCirclePost,
  createCirclePostReply,
  updateCirclePostReply,
  deleteCirclePostReply,
} from '../api/client';

const AVATAR_COLORS = [
  'bg-blue-600', 'bg-violet-600', 'bg-emerald-600',
  'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
];

function circleColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function authorName(a) {
  return a?.nickname || a?.email?.split('@')[0] || '?';
}

import { formatServerTime } from '../lib/datetime';

function fmtTime(iso) {
  return formatServerTime(iso, { month: 'short' });
}

function AuthorAvatar({ author }) {
  const name = authorName(author);
  return (
    <div className={`w-8 h-8 rounded-full ${circleColor(name)} flex items-center justify-center text-xs font-bold text-white shrink-0`}>
      {name[0]?.toUpperCase() || '?'}
    </div>
  );
}

/** 操作按钮：回复 / 编辑 / 删除 */
function ActionBar({ onReply, onEdit, onDelete, replyCount, showReply = true }) {
  const { t } = useLang();
  return (
    <div className="flex items-center gap-2 pt-0.5">
      {showReply && (
        <button type="button" onClick={onReply}
          className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600">
          {t('circles.detail.reply')}
          {replyCount > 0 && ` · ${replyCount}`}
        </button>
      )}
      {onEdit && (
        <button type="button" onClick={onEdit}
          className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600">
          {t('circles.detail.edit')}
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete}
          className="text-xs px-2.5 py-1 rounded-lg text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
          {t('circles.detail.delete')}
        </button>
      )}
    </div>
  );
}

function MemberAvatar({ user }) {
  const name = user.nickname || user.email?.split('@')[0] || '?';
  const initial = name[0].toUpperCase();
  return (
    <div className="flex flex-col items-center gap-1 w-10 shrink-0">
      <div className={`w-8 h-8 rounded-full ${circleColor(name)} flex items-center justify-center text-xs font-bold text-white`}>
        {initial}
      </div>
      <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate w-full text-center leading-tight">
        {name}
      </span>
    </div>
  );
}

/** 圈友列表：默认单行，可展开 */
function CircleMembers({ members, expanded, onToggle }) {
  const { t } = useLang();
  // 单行约 8 个头像，超出则显示展开
  const ROW_CAP = 8;
  const hasMore = members.length > ROW_CAP;

  if (members.length === 0) {
    return <p className="text-xs text-gray-400">{t('circles.detail.noMembers')}</p>;
  }

  return (
    <div className="space-y-2">
      <div className={`flex gap-1 ${expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden'}`}>
        {members.map(m => (
          <MemberAvatar key={m.id} user={m} />
        ))}
      </div>
      {hasMore && (
        <button type="button" onClick={onToggle}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
          {expanded
            ? t('circles.detail.collapseMembers')
            : t('circles.detail.expandMembers').replace('{n}', String(members.length))}
        </button>
      )}
    </div>
  );
}

export default function CircleDetail() {
  const { circleId } = useParams();
  const navigate = useNavigate();
  const { t } = useLang();
  const { user } = useAuth();
  const id = Number(circleId);
  const myId = user?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [circle, setCircle] = useState(null);
  const [models, setModels] = useState([]);
  const [posts, setPosts] = useState([]);
  const [members, setMembers] = useState([]);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editReply, setEditReply] = useState(null); // { postId, replyId, text }
  const [replyingId, setReplyingId] = useState(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [replying, setReplying] = useState(false);
  const [showComposer, setShowComposer] = useState(false);

  const isAuthor = (item) => myId != null && item?.author_id === myId;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [r, memRes] = await Promise.all([
        getCircleDetail(id),
        listCircleMembers(id).catch(() => ({ data: { members: [] } })),
      ]);
      setCircle(r.data?.circle || null);
      setModels(r.data?.models || []);
      setPosts(r.data?.posts || []);
      setMembers(memRes.data?.members || []);
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  async function handlePost(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    try {
      const r = await createCirclePost(id, text);
      setPosts(prev => [r.data.post, ...prev]);
      setDraft('');
      setShowComposer(false);
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.postFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleSaveEdit(post) {
    const text = editText.trim();
    if (!text) return;
    setPosting(true);
    try {
      const r = await updateCirclePost(id, post.id, text);
      const updated = r.data.post;
      setPosts(prev => prev.map(p => (p.id === post.id ? { ...p, ...updated } : p)));
      setEditId(null);
      setEditText('');
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.editFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleDeletePost(post) {
    if (!window.confirm(t('circles.detail.deleteConfirm'))) return;
    setPosting(true);
    try {
      await deleteCirclePost(id, post.id);
      setPosts(prev => prev.filter(p => p.id !== post.id));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.deleteFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleReply(e, post) {
    e.preventDefault();
    const text = replyDraft.trim();
    if (!text) return;
    setReplying(true);
    try {
      const r = await createCirclePostReply(id, post.id, text);
      const reply = r.data.reply;
      setPosts(prev => prev.map(p =>
        p.id === post.id ? { ...p, replies: [...(p.replies || []), reply] } : p,
      ));
      setReplyDraft('');
      setReplyingId(null);
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.replyFailed'));
    } finally {
      setReplying(false);
    }
  }

  async function handleSaveEditReply(post) {
    if (!editReply) return;
    const text = editReply.text.trim();
    if (!text) return;
    setPosting(true);
    try {
      const r = await updateCirclePostReply(id, post.id, editReply.replyId, text);
      const updated = r.data.reply;
      setPosts(prev => prev.map(p =>
        p.id === post.id
          ? { ...p, replies: (p.replies || []).map(r => r.id === updated.id ? updated : r) }
          : p,
      ));
      setEditReply(null);
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.editFailed'));
    } finally {
      setPosting(false);
    }
  }

  async function handleDeleteReply(post, reply) {
    if (!window.confirm(t('circles.detail.deleteConfirm'))) return;
    setPosting(true);
    try {
      await deleteCirclePostReply(id, post.id, reply.id);
      setPosts(prev => prev.map(p =>
        p.id === post.id ? { ...p, replies: (p.replies || []).filter(r => r.id !== reply.id) } : p,
      ));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.detail.deleteFailed'));
    } finally {
      setPosting(false);
    }
  }

  if (loading) {
    return (
      <div className="px-5 py-10 text-center text-sm text-gray-400">{t('circles.detail.loading')}</div>
    );
  }

  if (error && !circle) {
    return (
      <div className="px-5 py-5 text-center space-y-3">
        <p className="text-sm text-red-500">{error}</p>
        <button type="button" onClick={() => navigate('/circles')}
          className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
          {t('circles.detail.back')}
        </button>
      </div>
    );
  }

  const color = circleColor(circle?.name);

  return (
    <div className="px-5 py-5 space-y-5">
      {/* 页头：与 Network「← 供给源」同位置 */}
      <div>
        <div className="mb-1">
          <button type="button" onClick={() => navigate('/circles')}
            className="electron-no-drag relative z-50 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
            {t('circles.detail.back')}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-full ${color} flex items-center justify-center text-xl font-bold text-white shrink-0`}>
            {(circle?.name || '?')[0].toUpperCase()}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{circle?.name}</h1>
            {circle?.description && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{circle.description}</p>
            )}
            <p className="text-xs text-gray-400 mt-0.5">
              {t('circles.members').replace('{n}', circle?.member_count ?? 0)}
              {circle?.is_owner && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                  {t('circles.isOwner')}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* 圈友 */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.detail.friends')}</h2>
        <CircleMembers
          members={members}
          expanded={membersExpanded}
          onToggle={() => setMembersExpanded(v => !v)}
        />
      </section>

      {/* 共享模型 */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.detail.models')}</h2>
        {models.length === 0
          ? <p className="text-xs text-gray-400">{t('circles.detail.noModels')}</p>
          : (
            <div className="flex flex-wrap gap-2">
              {models.map(m => (
                <span key={m.id}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-mono">
                  {m.id}
                  {m.model_type && m.model_type !== 'chat' && (
                    <span className="ml-1 text-gray-400">({m.model_type})</span>
                  )}
                </span>
              ))}
            </div>
          )}
      </section>

      {/* 消息：卡片列表，正文无气泡；回复有气泡 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.detail.announcements')}</h2>
          {!showComposer && (
            <button type="button" onClick={() => setShowComposer(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0">
              {t('circles.detail.composePost')}
            </button>
          )}
        </div>

        {showComposer && (
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-4 space-y-2">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('circles.detail.composePost')}</p>
            <form onSubmit={handlePost} className="space-y-2">
              <textarea
                className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                rows={3}
                placeholder={t('circles.detail.announcePh')}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                maxLength={2000}
                autoFocus
              />
              <div className="flex gap-2">
                <button type="submit" disabled={posting || !draft.trim()}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {posting ? t('circles.detail.posting') : t('circles.detail.post')}
                </button>
                <button type="button"
                  onClick={() => { setShowComposer(false); setDraft(''); }}
                  className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300">
                  {t('circles.detail.cancel')}
                </button>
              </div>
            </form>
          </div>
        )}

        {posts.length === 0 && !showComposer && (
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-8 text-center">
            <p className="text-xs text-gray-400">{t('circles.detail.noAnnouncements')}</p>
          </div>
        )}

        {posts.map(post => (
          <article key={post.id}
            className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3.5 space-y-2">
            <div className="flex items-center gap-2.5">
              <AuthorAvatar author={post} />
              <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {authorName(post)}
                </span>
                <span className="text-xs text-gray-400 shrink-0">
                  {fmtTime(post.updated_at || post.created_at)}
                </span>
              </div>
            </div>

            {editId === post.id ? (
              <div className="space-y-2">
                <textarea
                  className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  maxLength={2000}
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => handleSaveEdit(post)} disabled={posting}
                    className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg disabled:opacity-50">
                    {t('circles.detail.save')}
                  </button>
                  <button type="button" onClick={() => { setEditId(null); setEditText(''); }}
                    className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300">
                    {t('circles.detail.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
                  {post.content}
                </p>
                <ActionBar
                  replyCount={post.replies?.length || 0}
                  onReply={() => {
                    setReplyingId(replyingId === post.id ? null : post.id);
                    setReplyDraft('');
                  }}
                  onEdit={isAuthor(post) ? () => { setEditId(post.id); setEditText(post.content); } : null}
                  onDelete={isAuthor(post) ? () => handleDeletePost(post) : null}
                />
              </>
            )}

            {/* 回复区：气泡样式 */}
            {(post.replies?.length > 0 || replyingId === post.id) && (
              <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-2">
                {post.replies?.map(reply => (
                  <div key={reply.id} className="flex gap-2">
                    <AuthorAvatar author={reply} />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-baseline justify-between gap-2 px-0.5">
                        <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                          {authorName(reply)}
                        </span>
                        <span className="text-xs text-gray-400 shrink-0">{fmtTime(reply.created_at)}</span>
                      </div>

                      {editReply?.replyId === reply.id ? (
                        <div className="space-y-2">
                          <textarea
                            className="w-full border border-gray-200 dark:border-gray-600 rounded-xl px-3.5 py-2 text-sm bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                            rows={2}
                            value={editReply.text}
                            onChange={e => setEditReply(prev => ({ ...prev, text: e.target.value }))}
                            maxLength={1000}
                          />
                          <div className="flex gap-2">
                            <button type="button" onClick={() => handleSaveEditReply(post)} disabled={posting}
                              className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg disabled:opacity-50">
                              {t('circles.detail.save')}
                            </button>
                            <button type="button" onClick={() => setEditReply(null)}
                              className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300">
                              {t('circles.detail.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="rounded-xl bg-gray-50 dark:bg-gray-700/45 px-3.5 py-2.5">
                            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
                              {reply.content}
                            </p>
                          </div>
                          {isAuthor(reply) && (
                            <ActionBar
                              showReply={false}
                              onEdit={() => setEditReply({ postId: post.id, replyId: reply.id, text: reply.content })}
                              onDelete={() => handleDeleteReply(post, reply)}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}

                {replyingId === post.id && (
                  <form onSubmit={e => handleReply(e, post)} className="space-y-2 pl-10">
                    <textarea
                      className="w-full border border-gray-200 dark:border-gray-600 rounded-xl px-3.5 py-2.5 text-sm bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      rows={2}
                      placeholder={t('circles.detail.replyPh')}
                      value={replyDraft}
                      onChange={e => setReplyDraft(e.target.value)}
                      maxLength={1000}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button type="submit" disabled={replying || !replyDraft.trim()}
                        className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg disabled:opacity-50">
                        {replying ? t('circles.detail.replying') : t('circles.detail.reply')}
                      </button>
                      <button type="button"
                        onClick={() => { setReplyingId(null); setReplyDraft(''); }}
                        className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300">
                        {t('circles.detail.cancel')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
