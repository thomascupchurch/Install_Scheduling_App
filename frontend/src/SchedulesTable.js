import React, { useEffect, useState } from 'react';

export default function SchedulesTable() {
  const [schedules, setSchedules] = useState([]);
  const [sortKey, setSortKey] = useState('job_number');
  const [sortAsc, setSortAsc] = useState(true);
  const [installers, setInstallers] = useState([]); // [{id,name,email}]
  const installerMap = React.useMemo(()=>Object.fromEntries(installers.map(i=>[i.id,i])),[installers]);

  useEffect(() => {
    (async () => {
      const [schedRes, instRes] = await Promise.all([
        fetch('/api/schedules'),
        fetch('/api/installers')
      ]);
      const schedData = await schedRes.json();
      const instData = await instRes.json();
      setSchedules(schedData);
      setInstallers(instData);
    })();
  }, []);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sorted = [...schedules].sort((a, b) => {
    if (sortKey === 'installers') {
      const aNames = (a.installers||[]).map(id=>installerMap[id]?.name||`#${id}`).join(', ');
      const bNames = (b.installers||[]).map(id=>installerMap[id]?.name||`#${id}`).join(', ');
      return sortAsc ? aNames.localeCompare(bNames) : bNames.localeCompare(aNames);
    }
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av;
    return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  return (
    <div>
      <h2>Schedules Table</h2>
      <table border="1" cellPadding={6} style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th onClick={() => handleSort('job_number')}>Job Number</th>
            <th onClick={() => handleSort('description')}>Description</th>
            <th onClick={() => handleSort('date')}>Date</th>
            <th onClick={() => handleSort('man_hours')}>Man-Hours</th>
            <th onClick={() => handleSort('installers')}>Installer(s)</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(sch => (
            <tr key={sch.id} title={JSON.stringify(sch, null, 2)}>
              <td>{sch.job_number}</td>
              <td>{sch.description}</td>
              <td>{sch.date}</td>
              <td>{sch.man_hours != null ? sch.man_hours : ''}</td>
              <td>{(sch.installers||[]).map(id=>installerMap[id]?.name || `#${id}`).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12, marginTop: 8 }}>
        <b>Tip:</b> Click column headers to sort. Hover a row to see full JSON.
      </div>
    </div>
  );
}
