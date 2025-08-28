import React, { createContext, useContext, useState, useEffect } from 'react';

const CoreHoursContext = createContext();

export function CoreHoursProvider({ children }) {
  const [coreStart, setCoreStart] = useState('08:00');
  const [coreEnd, setCoreEnd] = useState('17:00');

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('coreHours');
    if (saved) {
      const { coreStart: s, coreEnd: e } = JSON.parse(saved);
      if (s) setCoreStart(s);
      if (e) setCoreEnd(e);
    }
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    localStorage.setItem('coreHours', JSON.stringify({ coreStart, coreEnd }));
  }, [coreStart, coreEnd]);

  return (
    <CoreHoursContext.Provider value={{ coreStart, setCoreStart, coreEnd, setCoreEnd }}>
      {children}
    </CoreHoursContext.Provider>
  );
}

export function useCoreHours() {
  return useContext(CoreHoursContext);
}