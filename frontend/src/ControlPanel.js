import React, { useRef, useState, useEffect } from 'react';
import { useCoreHours } from './CoreHoursContext';


export default function ControlPanel() {
  const [setting, setSetting] = useState('');
  const { coreStart, setCoreStart, coreEnd, setCoreEnd } = useCoreHours();
  const fileInput = useRef();
  const [imported, setImported] = useState(null);
  const [error, setError] = useState(null);

  const handleImport = async e => {
    e.preventDefault();
    setError(null);
    setImported(null);
    const file = fileInput.current.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/import', {
      method: 'POST',
      body: formData
    });
    if (res.ok) {
      const data = await res.json();
      setImported(data.imported);
    } else {
      setError('Import failed');
    }
  };

  // Calculate non-core hours as all hours not in core range
  const allHours = Array.from({ length: 24 }, (_, i) => i);
  const coreStartNum = Number(coreStart.split(':')[0]);
  const coreEndNum = Number(coreEnd.split(':')[0]);
  const coreHours = allHours.filter(h => h >= coreStartNum && h < coreEndNum);
  const nonCoreHours = allHours.filter(h => h < coreStartNum || h >= coreEndNum);

  return (
    <div>
      <h2>Control Panel</h2>
      <div>
        <label>
          Example Setting:
          <input value={setting} onChange={e => setSetting(e.target.value)} />
        </label>
      </div>
      <div style={{ marginTop: 20 }}>
        <label>
          Core Hours:
          <input
            type="time"
            value={coreStart}
            onChange={e => setCoreStart(e.target.value)}
            style={{ marginLeft: 8, marginRight: 8 }}
          />
          to
          <input
            type="time"
            value={coreEnd}
            onChange={e => setCoreEnd(e.target.value)}
            style={{ marginLeft: 8 }}
          />
        </label>
        <div style={{ marginTop: 8, fontSize: 14 }}>
          <b>Core Hours:</b> {coreHours.map(h => h.toString().padStart(2, '0') + ':00').join(', ')}
        </div>
        <div style={{ fontSize: 14 }}>
          <b>Non-Core Hours:</b> {nonCoreHours.map(h => h.toString().padStart(2, '0') + ':00').join(', ')}
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        <form onSubmit={handleImport}>
          <label>
            Import Jobs from .xlsx:
            <input type="file" accept=".xlsx" ref={fileInput} required />
          </label>
          <button type="submit">Import</button>
        </form>
        {imported !== null && <div>Imported {imported} jobs.</div>}
        {error && <div style={{ color: 'red' }}>{error}</div>}
      </div>
    </div>
  );
}
