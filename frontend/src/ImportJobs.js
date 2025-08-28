import React, { useRef, useState } from 'react';

export default function ImportJobs() {
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

  return (
    <div>
      <h2>Import Jobs from .xlsx</h2>
      <form onSubmit={handleImport}>
        <input type="file" accept=".xlsx" ref={fileInput} required />
        <button type="submit">Import</button>
      </form>
      {imported !== null && <div>Imported {imported} jobs.</div>}
      {error && <div style={{ color: 'red' }}>{error}</div>}
    </div>
  );
}
