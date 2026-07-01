// 社区 P2P 模型：与云端 /v1/models 一致（worker 可见性由服务端按圈子规则处理）
import { getModelsForCurrentUser } from '../api/client';

/** @returns {Promise<{ ids: string[], entries: Array<{id,tier:'p2p'}>, circleMap: Record<string,{circle_id,circle_name}> }>} */
export async function fetchServerCommunityModels() {
  const r = await getModelsForCurrentUser();
  const data = r.data?.data || [];
  const ids = [];
  const entries = [];
  const circleMap = {};
  for (const m of data) {
    const id = m?.id;
    if (!id) continue;
    ids.push(id);
    const mtype = m?.model_type;
    entries.push({
      id,
      tier: 'p2p',
      ...(mtype && mtype !== 'chat' ? { type: mtype } : {}),
    });
    if (m.circle_id) {
      circleMap[id] = { circle_id: m.circle_id, circle_name: m.circle_name || '' };
    }
  }
  return { ids, entries, circleMap };
}
