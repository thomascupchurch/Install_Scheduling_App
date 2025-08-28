import React, { useEffect, useState } from 'react';

export default function SchedulesTable() {
  const [schedules, setSchedules] = useState([]);
  const [sortKey, setSortKey] = useState('job_number');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    fetch('/api/schedules')
      .then(res => res.json())
      .then(data => setSchedules(data));
  }, []);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sorted = [...schedules].sort((a, b) => {
    if (a[sortKey] === b[sortKey]) return 0;
    if (a[sortKey] == null) return 1;
    if (b[sortKey] == null) return -1;
    if (typeof a[sortKey] === 'number' && typeof b[sortKey] === 'number') {
      return sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey];
    }
    return sortAsc
      ? String(a[sortKey]).localeCompare(String(b[sortKey]))
      : String(b[sortKey]).localeCompare(String(a[sortKey]));
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
            <th onClick={() => handleSort('installer_id')}>Installer</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(sch => (
            <tr key={sch.id} title={JSON.stringify(sch, null, 2)}>
              <td>{sch.job_number}</td>
              <td>{sch.description}</td>
              <td>{sch.date}</td>
              <td>{sch.man_hours != null ? sch.man_hours : ''}</td>
              <td>{sch.installer_id != null ? sch.installer_id : ''}</td>
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
