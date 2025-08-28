import React, { useEffect, useState } from 'react';
import InstallersAvailability from './InstallersAvailability';

export default function Installers() {
  const [installers, setInstallers] = useState([]);
  const [name, setName] = useState('');

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
      body: JSON.stringify({ name })
    });
    const newInstaller = await res.json();
    setInstallers([...installers, newInstaller]);
    setName('');
  };

  return (
    <div>
      <h2>Installers</h2>
      <form onSubmit={addInstaller} style={{ marginBottom: 20 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Installer Name" required />
        <button type="submit">Add Installer</button>
      </form>
      <ul>
        {installers.map(i => (
          <li key={i.id}>{i.name}</li>
        ))}
      </ul>
      <div style={{ marginTop: 32 }}>
        <InstallersAvailability />
      </div>
    </div>
  );
}
