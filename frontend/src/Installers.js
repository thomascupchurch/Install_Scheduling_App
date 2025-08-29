import React, { useEffect, useState } from 'react';
import InstallersAvailability from './InstallersAvailability';

export default function Installers() {
  const [installers, setInstallers] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  useEffect(() => {
    fetch('/api/installers')
      .then(res => res.json())
      .then(setInstallers);
  }, []);

  const addInstaller = async e => {
    e.preventDefault();
    const res = await fetch('/api/installers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email })
    });
    const newInstaller = await res.json();
    setInstallers([...installers, newInstaller]);
    setName('');
    setEmail('');
  };

  return (
    <div>
      <h2>Installers</h2>
      <form onSubmit={addInstaller} style={{ marginBottom: 20, display: 'flex', gap: 8 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Installer Name" required />
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (optional)" />
        <button type="submit">Add Installer</button>
      </form>
      <ul>
        {installers.map(i => (
          <li key={i.id} style={{ marginBottom: 6 }}>
            {editingId === i.id ? (
              <>
                <input value={editName} onChange={e => setEditName(e.target.value)} style={{ marginRight: 4 }} />
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} style={{ marginRight: 4 }} />
                <button onClick={async () => {
                  const res = await fetch(`/api/installers/${i.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editName, email: editEmail }) });
                  if (res.ok) {
                    const updated = await res.json();
                    setInstallers(installers.map(x => x.id === i.id ? updated : x));
                    setEditingId(null);
                  }
                }}>Save</button>
                <button onClick={() => setEditingId(null)} style={{ marginLeft: 4 }}>Cancel</button>
              </>
            ) : (
              <>
                <span>{i.name}{i.email ? ` – ${i.email}` : ''}</span>
                <button style={{ marginLeft: 8 }} onClick={() => { setEditingId(i.id); setEditName(i.name); setEditEmail(i.email || ''); }}>Edit</button>
                <button style={{ marginLeft: 4 }} onClick={async () => {
                  if (!window.confirm('Delete installer?')) return;
                  const res = await fetch(`/api/installers/${i.id}`, { method: 'DELETE' });
                  if (res.ok) setInstallers(installers.filter(x => x.id !== i.id));
                }}>Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 32 }}>
        <InstallersAvailability />
      </div>
    </div>
  );
}
