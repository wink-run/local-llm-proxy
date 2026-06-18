import React, { createContext, useContext, useEffect, useState } from 'react';
import { makeT } from '../i18n';

const LangContext = createContext(null);

/** HMR 或 Provider 未就绪时的回退，避免 Layout 解构报错 */
const defaultLang = {
  lang: 'zh',
  setLang: () => {},
  t: makeT('zh'),
};

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(
    () => localStorage.getItem('lang') || 'zh'
  );

  function setLang(l) {
    localStorage.setItem('lang', l);
    setLangState(l);
  }

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }, [lang]);

  const t = makeT(lang);

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext) ?? defaultLang;
}
