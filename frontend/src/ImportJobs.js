import React, { useRef, useState } from 'react';

export default function ImportJobs() {
  const paceInput = useRef();
  const installReqInput = useRef();
  const [paceResult, setPaceResult] = useState(null); // { enriched, unmatched }
  const [installResult, setInstallResult] = useState(null); // { imported, duplicates, errors }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function upload(endpoint, fileRef, setResult, mapFields) {
    setError(null); setResult(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const formData = new FormData(); formData.append('file', file);
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method:'POST', body: formData });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setResult(mapFields ? mapFields(data) : data);
    } catch(e){ setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth:600 }}>
      <h2>Imports</h2>
      <section style={{ marginBottom:32, padding:'12px 16px', border:'1px solid #ccc', borderRadius:8 }}>
        <h3 style={{ marginTop:0 }}>Install Request Forms (CSV)</h3>
        <p style={{ fontSize:12, marginTop:4 }}>Primary source. Creates new jobs or upgrades existing Pace-only jobs. CSV headers must match template.</p>
        <form onSubmit={e=>{ e.preventDefault(); upload('/api/import/install-requests', installReqInput, setInstallResult); }}>
          <input type="file" accept=".csv,text/csv" ref={installReqInput} required disabled={busy} />
          <button type="submit" disabled={busy} style={{ marginLeft:8 }}>{busy? 'Uploading...':'Upload'}</button>
        </form>
        {installResult && (
          <div style={{ fontSize:12, marginTop:8 }}>
            Imported: {installResult.imported || 0} | Upgraded: {installResult.duplicates || 0} | Errors: {installResult.errors || 0}
          </div>
        )}
      </section>
      <section style={{ padding:'12px 16px', border:'1px solid #ccc', borderRadius:8 }}>
        <h3 style={{ marginTop:0 }}>Pace Jobs (XLSX) – Enrichment Only</h3>
        <p style={{ fontSize:12, marginTop:4 }}>Updates existing Install Request jobs with matching Job # (WO#). Does not create new jobs.</p>
        <form onSubmit={e=>{ e.preventDefault(); upload('/api/import', paceInput, setPaceResult); }}>
          <input type="file" accept=".xlsx" ref={paceInput} required disabled={busy} />
          <button type="submit" disabled={busy} style={{ marginLeft:8 }}>{busy? 'Uploading...':'Upload'}</button>
        </form>
        {paceResult && (
          <div style={{ fontSize:12, marginTop:8 }}>
            Enriched: {paceResult.enriched || 0} | Unmatched: {paceResult.unmatched || 0}
          </div>
        )}
      </section>
      {error && <div style={{ color:'#b71c1c', marginTop:16 }}>{error}</div>}
    </div>
  );
}
