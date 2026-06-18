import React, { useEffect, useState } from 'react';
import { getSettlements, getPurchaseOrders, createPurchaseOrder } from '../api/client';
import { useLang } from '../store/lang';

/** 积分结算（P2P 贡献）与积分购买申领 */
export default function CreditsBillingSection({ txs = [] }) {
  const { t } = useLang();
  const [settlements, setSettlements] = useState([]);
  const [orders, setOrders] = useState([]);
  const [adminInfo, setAdminInfo] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [orderMsg, setOrderMsg] = useState('');
  const [orderMsgOk, setOrderMsgOk] = useState(false);

  useEffect(() => {
    getSettlements().then(r => setSettlements((r.data?.settlements || []).slice(0, 10))).catch(() => {});
    getPurchaseOrders().then(r => {
      setOrders(r.data?.orders || []);
      if (r.data?.contact_info) setAdminInfo(String(r.data.contact_info));
    }).catch(() => {});
  }, []);

  async function handleOrder(e) {
    e.preventDefault();
    if (submitting || !contact.trim()) return;
    setSubmitting(true);
    setOrderMsg('');
    try {
      const r = await createPurchaseOrder(0, `联系方式：${contact.trim()}${note.trim() ? `；${note.trim()}` : ''}`);
      setOrderMsgOk(true);
      setOrderMsg(t('profile.purchase.success'));
      if (r.data?.contact_info) setAdminInfo(String(r.data.contact_info));
      setOrders(prev => [r.data.order, ...prev]);
      setContact('');
      setNote('');
    } catch (err) {
      setOrderMsgOk(false);
      setOrderMsg(err.response?.data?.detail || t('profile.purchase.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  const ORDER_STATUS_KEYS = {
    pending: 'profile.order.pending',
    approved: 'profile.order.approved',
    rejected: 'profile.order.rejected',
  };

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-6">
      {/* P2P 积分结算 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
          {t('hub.credits.settlements')}
        </h3>
        <p className="text-xs text-gray-400 mb-3">{t('hub.credits.settlementsHint')}</p>
        {settlements.length === 0 ? (
          <p className="text-sm text-gray-400">{t('contribute.noSettlements')}</p>
        ) : (
          <div className="space-y-2">
            {settlements.map(s => (
              <div key={s.id ?? s.period_end}
                className="grid grid-cols-5 gap-2 text-sm items-center bg-gray-50 dark:bg-gray-900/50 rounded-xl px-4 py-3">
                <span className="text-gray-500 text-xs col-span-1">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium col-span-2">
                  +{(s.credits_awarded ?? 0).toFixed(1)} {t('credits.unit')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 积分流水摘要 */}
      <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
          {t('accounts.creditsLedger')}
        </h3>
        {txs.length === 0 ? (
          <p className="text-sm text-gray-400">{t('accounts.noRecords')}</p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {txs.slice(0, 15).map(tx => (
              <div key={tx.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-gray-700 dark:text-gray-300">
                    {t(`accounts.tx.${tx.type}`) !== `accounts.tx.${tx.type}` ? t(`accounts.tx.${tx.type}`) : tx.type}
                    {tx.model_name ? ` · ${tx.model_name}` : ''}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">{tx.created_at?.slice(0, 16)}</span>
                </div>
                <span className={`font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 积分购买申领 */}
      <div className="border-t border-gray-100 dark:border-gray-700 pt-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t('profile.purchase.title')}</h3>
        <form onSubmit={handleOrder} className="space-y-2">
          <input value={contact} onChange={e => setContact(e.target.value)} placeholder={t('profile.purchase.contact')} required
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('profile.purchase.note')}
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
          <button type="submit" disabled={submitting || !contact.trim()}
            className="w-full py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white">
            {submitting ? t('profile.purchase.submitting') : t('profile.purchase.submit')}
          </button>
        </form>
        {orderMsg && <p className={`text-sm ${orderMsgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{orderMsg}</p>}
        {adminInfo && (
          <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {adminInfo}
          </div>
        )}
        {orders.length > 0 && (
          <div className="space-y-1 pt-2">
            {orders.slice(0, 5).map(o => (
              <div key={o.id} className="flex justify-between text-xs text-gray-500">
                <span>{o.created_at?.slice(0, 16)}</span>
                <span>{t(ORDER_STATUS_KEYS[o.status] || o.status)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
