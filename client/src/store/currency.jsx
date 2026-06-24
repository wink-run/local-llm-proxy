import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getConfig } from '../api/adapter';
import { useLang } from './lang';
import {
  DEFAULT_USD_CNY_RATE,
  defaultCurrencyForLang,
  fmtCostFromUsd,
  fmtCostOptionalFromUsd,
} from '../utils/currency';

const CURRENCY_KEY = 'currency';
const RATE_KEY = 'usd_cny_rate';

const CurrencyContext = createContext(null);

/** 读取本地偏好（与 theme/lang 一致，切换后立即生效） */
function readStoredCurrency(lang) {
  const stored = localStorage.getItem(CURRENCY_KEY);
  if (stored === 'USD' || stored === 'CNY') return stored;
  return defaultCurrencyForLang(lang);
}

function readStoredRate() {
  const r = Number(localStorage.getItem(RATE_KEY));
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_USD_CNY_RATE;
}

const defaultCurrency = {
  currency: 'CNY',
  usdCnyRate: DEFAULT_USD_CNY_RATE,
  loaded: false,
  setCurrency: () => {},
  setUsdCnyRate: () => {},
  applySettings: () => {},
  fmtCost: (usd) => fmtCostFromUsd(usd, 'CNY', DEFAULT_USD_CNY_RATE),
  fmtCostOptional: (usd) => fmtCostOptionalFromUsd(usd, 'CNY', DEFAULT_USD_CNY_RATE),
};

/** 从 localStorage + 网关配置加载货币偏好；内部金额始终为 USD */
export function CurrencyProvider({ children }) {
  const { lang } = useLang();
  const [currency, setCurrencyState] = useState(() => readStoredCurrency(lang));
  const [usdCnyRate, setUsdCnyRateState] = useState(readStoredRate);
  const [loaded, setLoaded] = useState(false);

  // 未手动选过货币时，随界面语言切换默认币种
  useEffect(() => {
    if (localStorage.getItem(CURRENCY_KEY)) return;
    setCurrencyState(defaultCurrencyForLang(lang));
  }, [lang]);

  // 启动时从 agent 配置同步（若曾点保存写入配置文件）
  useEffect(() => {
    let alive = true;
    getConfig().read().then(cfg => {
      if (!alive) return;
      if (cfg?.currency === 'USD' || cfg?.currency === 'CNY') {
        setCurrencyState(cfg.currency);
        localStorage.setItem(CURRENCY_KEY, cfg.currency);
      }
      const r = Number(cfg?.usd_cny_rate);
      if (Number.isFinite(r) && r > 0) {
        setUsdCnyRateState(r);
        localStorage.setItem(RATE_KEY, String(r));
      }
      setLoaded(true);
    }).catch(() => {
      if (!alive) return;
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const applySettings = useCallback(({ currency: c, usdCnyRate: r }) => {
    if (c) {
      const next = c === 'USD' ? 'USD' : 'CNY';
      setCurrencyState(next);
      localStorage.setItem(CURRENCY_KEY, next);
    }
    const rate = Number(r);
    if (Number.isFinite(rate) && rate > 0) {
      setUsdCnyRateState(rate);
      localStorage.setItem(RATE_KEY, String(rate));
    }
  }, []);

  const fmtCost = useCallback(
    (usd) => fmtCostFromUsd(usd, currency, usdCnyRate),
    [currency, usdCnyRate],
  );

  const fmtCostOptional = useCallback(
    (usd) => fmtCostOptionalFromUsd(usd, currency, usdCnyRate),
    [currency, usdCnyRate],
  );

  return (
    <CurrencyContext.Provider value={{
      currency,
      usdCnyRate,
      loaded,
      setCurrency: setCurrencyState,
      setUsdCnyRate: setUsdCnyRateState,
      applySettings,
      fmtCost,
      fmtCostOptional,
    }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext) ?? defaultCurrency;
}
