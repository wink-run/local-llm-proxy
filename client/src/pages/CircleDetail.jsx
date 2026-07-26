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
  listCircleJoinRequests,
  approveCircleJoinRequest,
  rejectCircleJoinRequest,
} from '../api/client';
import RichMediaInput from '../components/RichMediaInput';
import RichMediaContent from '../components/RichMediaContent';
import UserAvatar, { userDisplayName, avatarColor } from '../components/UserAvatar';

function authorName(a) {
  return userDisplayName(a);
}

import { formatServerTime } from '../lib/datetime';

function fmtTime(iso) {
  return formatServerTime(iso, { month: 'short' });
}

function AuthorAvatar({ author }) {
  return <UserAvatar user={author} />;
}

/** 圈子共享智能体卡片图标：首字着色 + 右下角智能体符号 */
function CircleAgentIcon({ name }) {
  const label = String(name || '?').trim() || '?';
  const initial = label[0].toUpperCase();
  return (
    <div
      className={`relative w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center text-white font-semibold text-base shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${avatarColor(label)}`}
      aria-hidden
    >
      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-md bg-white dark:bg-gray-900 flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300" fill="currentColor">
          <path d="M8 1.5a1 1 0 0 1 1 1V4h1.5a2 2 0 0 1 2 2v1H14a1 1 0 1 1 0 2h-1.5v1a2 2 0 0 1-2 2H9v1.5a1 1 0 1 1-2 0V12H5.5a2 2 0 0 1-2-2v-1H2a1 1 0 1 1 0-2h1.5V6a2 2 0 0 1 2-2H7V2.5a1 1 0 0 1 1-1zM5.5 6v4h5V6h-5z" />
        </svg>
      </span>
      {initial}
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
  const name = userDisplayName(user);
  return (
    <div className="flex flex-col items-center gap-1 w-10 shrink-0">
      <UserAvatar user={user} />
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

export default function CircleDetail({ routeParams }) {
  const params = useParams();
  const navigate = useNavigate();
  const { t } = useLang();
  const { user } = useAuth();
  // KeepAlive 下 useParams 会随当前 URL 漂移；优先用缓存 key 解析出的稳定 id
  const circleId = routeParams?.circleId ?? params.circleId;
  const id = Number(circleId);
  const myId = user?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [circle, setCircle] = useState(null);
  const [models, setModels] = useState([]);
  const [agents, setAgents] = useState([]);
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
  const [joinRequests, setJoinRequests] = useState([]);
  const [requestBusy, setRequestBusy] = useState(null); // request id

  const isAuthor = (item) => myId != null && item?.author_id === myId;

  const load = useCallback(async () => {
    // 无效 id：必须结束 loading，否则会永远停在「加载中…」
    if (!Number.isFinite(id) || id <= 0) {
      setLoading(false);
      setError(t('circles.detail.loadFailed'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [r, memRes] = await Promise.all([
        getCircleDetail(id),
        listCircleMembers(id).catch(() => ({ data: { members: [] } })),
      ]);
      setCircle(r.data?.circle || null);
      setModels(r.data?.models || []);
      setAgents(r.data?.agents || []);
      setPosts(r.data?.posts || []);
      setMembers(memRes.data?.members || []);
      if (r.data?.circle?.is_owner) {
        try {
          const jr = await listCircleJoinRequests(id);
          setJoinRequests(jr.data?.requests || []);
        } catch {
          setJoinRequests([]);
        }
      } else {
        setJoinRequests([]);
      }
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

  async function handleApproveRequest(req) {
    setRequestBusy(req.id);
    try {
      await approveCircleJoinRequest(id, req.id);
      setJoinRequests(prev => prev.filter(r => r.id !== req.id));
      const memRes = await listCircleMembers(id);
      setMembers(memRes.data?.members || []);
      if (circle) {
        setCircle(c => ({ ...c, member_count: (c.member_count || 0) + 1 }));
      }
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.browse.applyFailed'));
    } finally {
      setRequestBusy(null);
    }
  }

  async function handleRejectRequest(req) {
    setRequestBusy(req.id);
    try {
      await rejectCircleJoinRequest(id, req.id);
      setJoinRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (err) {
      setError(err?.response?.data?.detail || t('circles.browse.applyFailed'));
    } finally {
      setRequestBusy(null);
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

  const color = avatarColor(circle?.name);

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

      {/* 圈主：待审批入圈申请 */}
      {circle?.is_owner && (
        <section className="tb-soft-card rounded-xl px-4 py-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {t('circles.browse.requestsTitle')}
            {joinRequests.length > 0 && (
              <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                {joinRequests.length}
              </span>
            )}
          </h2>
          {joinRequests.length === 0 ? (
            <p className="text-xs text-gray-400">{t('circles.browse.noRequests')}</p>
          ) : (
            <div className="space-y-2">
              {joinRequests.map(req => {
                const name = req.nickname || req.email?.split('@')[0] || '?';
                return (
                  <div key={req.id} className="flex items-center gap-3 py-2 border-t border-gray-100 dark:border-gray-700 first:border-0 first:pt-0">
                    <AuthorAvatar author={req} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{name}</p>
                      {req.message && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{req.message}</p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={requestBusy === req.id}
                        onClick={() => handleApproveRequest(req)}
                        className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
                      >
                        {t('circles.browse.approve')}
                      </button>
                      <button
                        type="button"
                        disabled={requestBusy === req.id}
                        onClick={() => handleRejectRequest(req)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                      >
                        {t('circles.browse.reject')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 圈友 */}
      <section className="tb-soft-card rounded-xl px-4 py-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.detail.friends')}</h2>
        <CircleMembers
          members={members}
          expanded={membersExpanded}
          onToggle={() => setMembersExpanded(v => !v)}
        />
      </section>

      {/* 共享模型 */}
      <section className="tb-soft-card rounded-xl px-4 py-4 space-y-2">
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

      {/* 共享智能体：与贡献页社区智能体同款卡片（图标 + 标题 + runtime + 简介） */}
      <section className="tb-soft-card rounded-xl px-4 py-4 space-y-2.5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('circles.detail.agents')}</h2>
        {agents.length === 0
          ? <p className="text-xs text-gray-400">{t('circles.detail.noAgents')}</p>
          : (
            <div className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {agents.map((a) => {
                  const title = a.display_name || a.name || a.id;
                  const blurb = String(a.description || '').trim();
                  return (
                    <div
                      key={`${a.worker_id}:${a.id}`}
                      className="tb-soft-card flex gap-3 p-3 rounded-2xl"
                    >
                      <CircleAgentIcon name={title} />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100 truncate block">
                          {title}
                        </span>
                        {a.runtime && (
                          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">
                            {a.runtime}
                          </p>
                        )}
                        <p className={`text-[11px] mt-1.5 line-clamp-2 leading-relaxed ${
                          blurb ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 italic'
                        }`}>
                          {blurb || '—'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400">{t('circles.detail.agentsHint')}</p>
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
          <div className="tb-soft-card rounded-xl px-4 py-4 space-y-2">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('circles.detail.composePost')}</p>
            <form onSubmit={handlePost} className="space-y-2">
              <RichMediaInput
                circleId={id}
                value={draft}
                onChange={setDraft}
                maxLength={2000}
                rows={4}
                placeholder={t('circles.detail.announcePh')}
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
          <div className="tb-soft-card rounded-xl px-4 py-8 text-center">
            <p className="text-xs text-gray-400">{t('circles.detail.noAnnouncements')}</p>
          </div>
        )}

        {posts.map(post => (
          <article key={post.id}
            className="tb-soft-card rounded-xl px-4 py-3.5 space-y-2">
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
                <RichMediaInput
                  circleId={id}
                  value={editText}
                  onChange={setEditText}
                  maxLength={2000}
                  rows={4}
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
                <RichMediaContent content={post.content} />
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
                          <RichMediaInput
                            circleId={id}
                            value={editReply.text}
                            onChange={text => setEditReply(prev => ({ ...prev, text }))}
                            maxLength={1000}
                            rows={3}
                            className="rounded-xl bg-gray-50 dark:bg-gray-700/50"
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
                            <RichMediaContent
                              content={reply.content}
                              className="[&_p]:text-gray-700 [&_p]:dark:text-gray-300"
                            />
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
                    <RichMediaInput
                      circleId={id}
                      value={replyDraft}
                      onChange={setReplyDraft}
                      maxLength={1000}
                      rows={3}
                      placeholder={t('circles.detail.replyPh')}
                      autoFocus
                      className="rounded-xl bg-gray-50 dark:bg-gray-700/50"
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
