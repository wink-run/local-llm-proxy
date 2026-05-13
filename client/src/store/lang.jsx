import React, { createContext, useContext, useState } from 'react';
import { makeT } from '../i18n';

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(
    () => localStorage.getItem('lang') || 'zh'
  );

  function setLang(l) {
    localStorage.setItem('lang', l);
    setLangState(l);
  }

  const t = makeT(lang);

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
